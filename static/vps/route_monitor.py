#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""On-demand sing-box Clash API route log collector.

The collector is only active while the dashboard holds a route-log
subscription.  It never writes the Clash API secret to logs, URLs, errors or
reported frames.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict, deque
from datetime import datetime, timezone

DEFAULT_CLASH_URL = "http://127.0.0.1:39483"
DEFAULT_TEST_NETWORK = "tcp"
DEFAULT_TEST_PORT = 443
ROUTE_GROUPS = frozenset({
    "lan", "custom_direct", "custom_proxy", "ai", "youtube", "streaming",
    "google", "final", "stack_reject", "quic_reject", "unknown",
})
ROUTE_OUTBOUNDS = frozenset({"direct", "residential", "reject", "unknown"})
ROUTE_ACTIONS = frozenset({"route", "reject", "dns", "unknown"})

EVENT_LIMIT = 300
BATCH_LIMIT = 50
CONNECTION_LIMIT = 100
SEEN_LIMIT = 2000
PENDING_LIMIT = 500
_INVALID = object()

_MATCH_KEYS = (
    "inbound", "domain", "domain_suffix", "domain_keyword", "domain_regex",
    "ip_cidr", "ip_version", "network", "protocol", "port", "port_range",
    "rule_set",
)
_TARGET_UNSUPPORTED_KEYS = frozenset({
    "network", "protocol", "port", "port_range", "process_name",
    "process_path", "package_name", "source_ip_cidr", "source_port",
    "source_port_range",
})
_ALL_MATCH_KEYS = tuple(dict.fromkeys((*_MATCH_KEYS, *_TARGET_UNSUPPORTED_KEYS, "invert")))
_TEST_SUPPORTED_KEYS = frozenset({
    "inbound", "domain", "domain_suffix", "domain_keyword", "domain_regex",
    "ip_cidr", "ip_version", "rule_set", "network", "port", "port_range",
    "invert",
})
_CONDITION_RE = re.compile(r"([a-z_]+)=(\[[^\]]*\]|\S+)")
_LOG_PREFIX_RE = re.compile(r"^\[(\d+)\s+[^\]]*\]\s+(.*)$")
_INBOUND_TO_RE = re.compile(
    r"^(?:user(?:=|:\s*)\S+\s+)?inbound/([^[]+)\[([^\]]+)\]:\s+"
    r"(?:(?:\[[^\]\r\n]+\]|user(?:=|:\s*)\S+)\s+)?inbound (packet )?connection to (.+):(\d+)$"
)
_ROUTER_MATCH_RE = re.compile(
    r"^router:\s+match\[(\d+)\]\s+(.*?)\s+=>\s+(reject|route\(([^)]+)\))$"
)
_DNS_OK_RE = re.compile(r"^dns:\s+lookup succeed for (.+?):\s+(.+)$")
_DNS_A_RE = re.compile(r"^dns:\s+exchanged\s+(?:A|AAAA)\s+(.+?)\.?\s+\d+\s+IN\s+(?:A|AAAA)\s+(\S+)$")


def _clip(value, limit):
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\x00-\x1f\x7f]", "", value)[:limit]


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return list(value)
    return [value]


def _normalize_domain(value):
    return str(value or "").strip().lower().rstrip(".").lstrip(".")


def _strip_brackets(value):
    text = str(value or "").strip()
    if text.startswith("[") and text.endswith("]"):
        return text[1:-1]
    return text


def _normalize_cidr(value):
    text = str(value or "").strip().lower()
    if not text:
        return ""
    try:
        network = ipaddress.ip_network(text, strict=False)
        return str(network)
    except ValueError:
        try:
            address = ipaddress.ip_address(text)
        except ValueError:
            return text
        return f"{address}/{32 if address.version == 4 else 128}"


def _normalize_value(key, value):
    if key in {"ip_cidr", "source_ip_cidr"}:
        return _normalize_cidr(value)
    if key in {"domain", "domain_suffix", "domain_keyword", "domain_regex"}:
        return _normalize_domain(value)
    if key in {"ip_version", "port"}:
        try:
            return str(int(value))
        except (TypeError, ValueError):
            return str(value).strip().lower()
    return str(value or "").strip().lower()


def _path_map(value):
    if not isinstance(value, dict):
        return {}
    return {
        str(key): str(path)
        for key, path in value.items()
        if path
    }


def _target_list(value):
    if isinstance(value, str):
        return (value,)
    if isinstance(value, (list, tuple, set)):
        return tuple(str(item) for item in value if str(item))
    return ()


def _port_in_range(port, value):
    text = str(value or "").strip()
    if not text:
        return False
    matched = re.fullmatch(r"(\d+)\s*[:.-]\s*(\d+)", text)
    if not matched:
        try:
            return int(text) == port
        except ValueError as error:
            raise ValueError("invalid port range") from error
    start, end = int(matched.group(1)), int(matched.group(2))
    return start <= port <= end


def normalize_target(value):
    """Return ``(target, ip_version)`` for a domain or IP literal."""
    target = str(value or "").strip().lower()
    if target.startswith("[") and target.endswith("]"):
        target = target[1:-1]
    if not target or len(target) > 253:
        raise ValueError("invalid target")
    if re.search(r"[\x00-\x20\x7f/?#@]", target) or "://" in target:
        raise ValueError("invalid target")
    try:
        address = ipaddress.ip_address(target)
        return str(address), address.version
    except ValueError:
        pass
    try:
        target = target.rstrip(".").encode("idna").decode("ascii")
    except UnicodeError as error:
        raise ValueError("invalid target") from error
    if not re.fullmatch(
        r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
        r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",
        target,
    ):
        raise ValueError("invalid target")
    return target, 0


def parse_match_string(value):
    """Parse sing-box's ``rule`` text into conditions and action."""
    text = str(value or "").strip()
    if not text:
        return {}, "", ""
    match_part, separator, action_part = text.partition("=>")
    conditions = {}
    for key, raw in _CONDITION_RE.findall(match_part):
        if raw.startswith("[") and raw.endswith("]"):
            values = raw[1:-1].split()
        else:
            values = [raw]
        conditions.setdefault(key, []).extend(item for item in values if item)
    action = ""
    outbound = ""
    action_part = action_part.strip() if separator else ""
    if action_part == "reject":
        action = "reject"
    else:
        matched = re.fullmatch(r"route\(([^)]+)\)", action_part)
        if matched:
            action = "route"
            outbound = matched.group(1)
    return conditions, action, outbound


def _match_pairs(match):
    pairs = set()
    if not isinstance(match, dict):
        return pairs
    for key in _ALL_MATCH_KEYS:
        if key not in match:
            continue
        for value in _as_list(match.get(key)):
            pairs.add((key, _normalize_value(key, value)))
    return pairs


def _condition_pairs(conditions):
    pairs = set()
    for key, values in (conditions or {}).items():
        if key not in _ALL_MATCH_KEYS:
            continue
        for value in values:
            pairs.add((key, _normalize_value(key, value)))
    return pairs


def _domain_suffix_matches(domain, suffix):
    suffix = _normalize_domain(suffix)
    if not suffix:
        return False
    return domain == suffix or domain.endswith("." + suffix)


def _domain_condition_matches(key, domain, value):
    if key == "domain":
        return domain == _normalize_domain(value)
    if key == "domain_suffix":
        return _domain_suffix_matches(domain, value)
    if key == "domain_keyword":
        keyword = str(value or "").strip().lower()
        return bool(keyword) and keyword in domain
    if key == "domain_regex":
        try:
            return re.search(str(value), domain) is not None
        except re.error as error:
            raise RuleSetUnavailable("invalid rule-set regular expression") from error
    return False


class RouteTestUnavailable(RuntimeError):
    """Raised when a route test cannot be evaluated exactly."""


class RuleSetUnavailable(RouteTestUnavailable):
    """Raised when a rule-set file is missing or cannot be evaluated."""


class RuleSetMatcher:
    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.rules = []
        self.incomplete = False
        self._load()

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as rule_file:
                payload = json.load(rule_file)
        except (OSError, ValueError) as error:
            raise RuleSetUnavailable("rule-set file is unavailable") from error
        rules = payload.get("rules") if isinstance(payload, dict) else None
        if not isinstance(rules, list):
            raise RuleSetUnavailable("invalid rule-set file")
        compiled = []
        for rule in rules:
            if not isinstance(rule, dict):
                self.incomplete = True
                continue
            supported = {
                "domain", "domain_suffix", "domain_keyword", "domain_regex",
                "ip_cidr", "ip_version", "invert",
            }
            if any(key not in supported for key in rule):
                self.incomplete = True
                continue
            domains = {_normalize_domain(item) for item in _as_list(rule.get("domain")) if _normalize_domain(item)}
            suffixes = {_normalize_domain(item) for item in _as_list(rule.get("domain_suffix")) if _normalize_domain(item)}
            keywords = {str(item).strip().lower() for item in _as_list(rule.get("domain_keyword")) if str(item).strip()}
            regexes = []
            for item in _as_list(rule.get("domain_regex")):
                try:
                    regexes.append(re.compile(str(item)))
                except re.error as error:
                    raise RuleSetUnavailable("invalid rule-set regular expression") from error
            networks = []
            for item in _as_list(rule.get("ip_cidr")):
                try:
                    networks.append(ipaddress.ip_network(str(item), strict=False))
                except ValueError as error:
                    raise RuleSetUnavailable("invalid rule-set CIDR") from error
            versions = set()
            for item in _as_list(rule.get("ip_version")):
                try:
                    version = int(item)
                except (TypeError, ValueError) as error:
                    raise RuleSetUnavailable("invalid rule-set IP version") from error
                if version not in {4, 6}:
                    raise RuleSetUnavailable("invalid rule-set IP version")
                versions.add(version)
            has_domain = bool(domains or suffixes or keywords or regexes)
            has_ip = bool(networks or versions)
            if not has_domain and not has_ip:
                if rule.get("invert"):
                    self.incomplete = True
                continue
            compiled.append({
                "domain": domains,
                "domain_suffix": suffixes,
                "domain_keyword": keywords,
                "domain_regex": regexes,
                "ip_cidr": networks,
                "ip_version": versions,
                "invert": bool(rule.get("invert")),
            })
        self.rules = compiled

    def matches(self, target, version):
        for rule in self.rules:
            has_domain = bool(
                rule["domain"] or rule["domain_suffix"]
                or rule["domain_keyword"] or rule["domain_regex"]
            )
            matched = True
            if rule["ip_version"] and (
                version == 0 or version not in rule["ip_version"]
            ):
                matched = False
            address_required = has_domain or bool(rule["ip_cidr"])
            if matched and address_required:
                address_matched = False
                if version == 0:
                    checks = []
                    if rule["domain"]:
                        checks.append(target in rule["domain"])
                    if rule["domain_suffix"]:
                        checks.append(any(
                            _domain_suffix_matches(target, item)
                            for item in rule["domain_suffix"]
                        ))
                    if rule["domain_keyword"]:
                        checks.append(any(
                            item in target for item in rule["domain_keyword"]
                        ))
                    if rule["domain_regex"]:
                        checks.append(any(
                            pattern.search(target)
                            for pattern in rule["domain_regex"]
                        ))
                    address_matched = any(checks)
                elif rule["ip_cidr"]:
                    address = ipaddress.ip_address(target)
                    address_matched = any(
                        address in network for network in rule["ip_cidr"]
                    )
                matched = address_matched
            if rule["invert"]:
                matched = not matched
            if matched:
                return True
        if self.incomplete:
            raise RuleSetUnavailable("rule-set contains unsupported conditions")
        return False


class RuleSetCache:
    def __init__(self):
        self._cache = {}
        self._lock = threading.Lock()

    def matcher(self, path):
        absolute = os.path.abspath(str(path))
        try:
            mtime = os.stat(absolute).st_mtime_ns
        except OSError as error:
            raise RuleSetUnavailable("rule-set file is unavailable") from error
        with self._lock:
            cached = self._cache.get(absolute)
            if cached and cached[0] == mtime:
                return cached[1]
        matcher = RuleSetMatcher(absolute)
        with self._lock:
            self._cache[absolute] = (mtime, matcher)
        return matcher


class RouteIndex:
    """Maps the applied route rules to rule groups and evaluates route tests."""

    def __init__(self, items=None, proxy_inbounds=(), rule_set_paths=None, cache=None):
        self.raw = list(items) if isinstance(items, (list, tuple)) else []
        self.items = []
        for raw in self.raw:
            if raw is None:
                self.items.append(None)
                continue
            if not isinstance(raw, dict):
                self.items.append(_INVALID)
                continue
            group = str(raw.get("group") or "")
            outbound = str(raw.get("outbound") or "").strip().lower()
            action = str(raw.get("action") or "")
            match = raw.get("match") if isinstance(raw.get("match"), dict) else {}
            if outbound in {"direct-out"}:
                outbound = "direct"
            elif outbound in {"residential-out", "socks5-outbound"}:
                outbound = "residential"
            if action not in {"route", "reject"}:
                if action in {"sniff", "hijack-dns", "resolve", "dns", "skip"}:
                    self.items.append(None)
                else:
                    self.items.append(_INVALID)
                continue
            if action == "reject" and not outbound:
                outbound = "reject"
            if (action == "route" and outbound == "reject") or (action == "reject" and outbound != "reject"):
                self.items.append(_INVALID)
                continue
            if group not in ROUTE_GROUPS or group == "unknown" or outbound not in ROUTE_OUTBOUNDS or outbound == "unknown":
                self.items.append(_INVALID)
                continue
            self.items.append({
                "group": group,
                "outbound": outbound,
                "action": action,
                "match": match,
            })
        self.proxy_inbounds = {str(item) for item in _target_list(proxy_inbounds)}
        self.rule_set_paths = _path_map(rule_set_paths)
        self.rule_set_cache = cache or RuleSetCache()

    @staticmethod
    def _decision(item):
        if not item:
            return None
        return {
            "rule_group": item["group"],
            "outbound": item["outbound"],
            "action": item["action"],
        }

    def by_position(self, position):
        try:
            position = int(position)
        except (TypeError, ValueError):
            return None
        if 0 <= position < len(self.items):
            item = self.items[position]
            if item is _INVALID:
                return None
            return self._decision(item)
        return None

    def _inbound_applies(self, match):
        if "inbound" not in match:
            return True
        tags = {str(item) for item in _as_list(match.get("inbound"))}
        if self.proxy_inbounds:
            return bool(tags & self.proxy_inbounds)
        return any(tag.startswith("in-") for tag in tags)

    def _rule_set_matches(self, tags, target, version):
        missing = False
        incomplete = False
        for tag in tags:
            path = self.rule_set_paths.get(str(tag))
            if not path:
                missing = True
                continue
            matcher = self.rule_set_cache.matcher(path)
            if matcher.matches(target, version):
                return True
            incomplete = incomplete or matcher.incomplete
        if missing:
            raise RuleSetUnavailable("rule-set file is unavailable")
        if incomplete:
            raise RuleSetUnavailable("rule-set contains unsupported conditions")
        return False

    @staticmethod
    def _transport_matches(match, network, port):
        if "network" in match:
            values = {
                str(value).strip().lower()
                for value in _as_list(match.get("network"))
                if str(value).strip()
            }
            if network not in values:
                return False
        if "port" in match:
            try:
                ports = {int(value) for value in _as_list(match.get("port"))}
            except (TypeError, ValueError) as error:
                raise RouteTestUnavailable("invalid route index port") from error
            if port not in ports:
                return False
        if "port_range" in match:
            try:
                ranges = list(_as_list(match.get("port_range")))
                range_matches = any(_port_in_range(port, value) for value in ranges)
            except (TypeError, ValueError) as error:
                raise RouteTestUnavailable("invalid route index port range") from error
            if not range_matches:
                return False
        return True

    def _matches(self, item, target, version, network, port):
        match = item["match"]
        if network == "tcp" and not match.get("invert") and _as_list(match.get("protocol")) == ["quic"]:
            return False
        unsupported = set(match) - _TEST_SUPPORTED_KEYS - {"action", "outbound"}
        if unsupported:
            raise RouteTestUnavailable("route rule contains unsupported match fields")
        domain_keys = ("domain", "domain_suffix", "domain_keyword", "domain_regex")
        has_domain = any(key in match for key in domain_keys)
        has_ip_cidr = "ip_cidr" in match
        has_rule_set = "rule_set" in match
        if (has_domain or has_ip_cidr) and has_rule_set:
            raise RouteTestUnavailable(
                "route rule mixes address conditions with rule-set conditions"
            )
        matched = self._inbound_applies(match)
        if matched:
            matched = self._transport_matches(match, network, port)
        if "ip_version" in match:
            if matched:
                try:
                    versions = {int(value) for value in _as_list(match["ip_version"])}
                except (TypeError, ValueError) as error:
                    raise RouteTestUnavailable("invalid route index IP version") from error
                matched = version != 0 and version in versions
        if matched and (has_domain or has_ip_cidr):
            address_matched = False
            if has_domain and version == 0:
                address_matched = any(
                    _domain_condition_matches(key, target, value)
                    for key in domain_keys
                    for value in _as_list(match.get(key))
                )
            if not address_matched and has_ip_cidr and version != 0:
                address = ipaddress.ip_address(target)
                try:
                    networks = [
                        ipaddress.ip_network(str(value), strict=False)
                        for value in _as_list(match["ip_cidr"])
                    ]
                except ValueError as error:
                    raise RouteTestUnavailable("invalid route index CIDR") from error
                address_matched = any(
                    address in network for network in networks
                )
            matched = address_matched
        if matched and has_rule_set:
            matched = self._rule_set_matches(
                _as_list(match["rule_set"]), target, version
            )
        return not matched if match.get("invert") else matched

    def test(self, target, version, *, network=DEFAULT_TEST_NETWORK, port=DEFAULT_TEST_PORT):
        for item in self.items:
            if item is None:
                continue
            if item is _INVALID:
                raise RouteTestUnavailable("route index is unavailable")
            if self._matches(item, target, version, network, port):
                return self._decision(item)
        return None

    @staticmethod
    def _outbound_from_chains(chains):
        values = [str(tag or "").strip().lower() for tag in (chains or [])]
        for value in values:
            if value == "reject" or "reject" in value:
                return "reject"
        for value in values:
            if value in {"socks5-outbound", "residential-out"} or "residential" in value or "proxy" in value:
                return "residential"
        for value in values:
            if value == "direct-out" or value.startswith("direct"):
                return "direct"
        return "unknown"

    def _fallback(self, chains):
        """Return a known outbound without guessing an unknown rule group."""
        outbound = self._outbound_from_chains(chains)
        if outbound == "unknown":
            return {"rule_group": "unknown", "outbound": "unknown", "action": "unknown"}
        return {
            "rule_group": "unknown",
            "outbound": outbound,
            "action": "reject" if outbound == "reject" else "route",
        }

    def map_connection(self, rule_text, chains=None):
        text = str(rule_text or "").strip()
        if not text:
            return self._fallback(chains)
        if text == "final":
            finals = [
                item for item in self.items
                if item and item is not _INVALID and item["group"] == "final"
            ]
            if finals:
                return self._decision(finals[0])
            return self._fallback(chains)
        conditions, action, outbound_tag = parse_match_string(text)
        normalized = {
            key: {_normalize_value(key, value) for value in values}
            for key, values in (conditions or {}).items()
        }
        exact = []
        for item in self.items:
            if not item or item is _INVALID:
                continue
            if action and action != item["action"]:
                continue
            if outbound_tag:
                outbound = self._outbound_from_chains([outbound_tag])
                if outbound != "unknown" and outbound != item["outbound"]:
                    continue
            indexed = {}
            for key, value in (item["match"] or {}).items():
                if key in _ALL_MATCH_KEYS:
                    indexed[key] = {_normalize_value(key, entry) for entry in _as_list(value)}
            truncated = {}
            for key, values in (conditions or {}).items():
                if values and values[-1].endswith("..."):
                    truncated[key] = values[:-1] + [values[-1][:-3]]
            compatible = set(normalized) == set(indexed)
            if compatible:
                for key in indexed:
                    if key in truncated:
                        original = _as_list(item["match"].get(key))
                        prefix = [_normalize_value(key, value) for value in truncated[key]]
                        if len(original) <= len(prefix) or prefix != [
                            _normalize_value(key, value) for value in original[:len(prefix)]
                        ]:
                            compatible = False
                            break
                    elif normalized[key] != indexed[key]:
                        compatible = False
                        break
            if compatible and (indexed or (action and item["group"] == "final")):
                exact.append(item)
        if len(exact) == 1:
            return self._decision(exact[0])
        # The connection record often only carries a rule-set tag.  A tag
        # alone cannot distinguish a TCP route from a UDP/QUIC or stack-reject
        # rule that uses the same tag, so never infer a group from it.
        if action == "reject":
            return {"rule_group": "unknown", "outbound": "reject", "action": "reject"}
        if outbound_tag:
            outbound = self._outbound_from_chains([outbound_tag])
            if outbound != "unknown":
                return {
                    "rule_group": "unknown",
                    "outbound": outbound,
                    "action": "route",
                }
        return self._fallback(chains)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


class ClashApiClient:
    """Minimal loopback-only client for sing-box's Clash API."""

    def __init__(self, base_url=DEFAULT_CLASH_URL, secret=None, timeout=3.0):
        parsed = urllib.parse.urlsplit(str(base_url or ""))
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("invalid clash api url")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("invalid clash api url")
        if parsed.path not in {"", "/"}:
            raise ValueError("invalid clash api url")
        if parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
            raise ValueError("clash api must listen on loopback")
        try:
            port = parsed.port
        except ValueError as error:
            raise ValueError("invalid clash api port") from error
        if port is not None and not 1 <= port <= 65535:
            raise ValueError("invalid clash api port")
        self.base_url = f"{parsed.scheme}://{parsed.netloc}"
        self._secret = str(secret or "")
        self.timeout = max(0.5, float(timeout))
        self._opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            _NoRedirect(),
        )

    def __repr__(self):
        return f"ClashApiClient({self.base_url!r})"

    def _headers(self):
        headers = {"Accept": "application/json", "User-Agent": "KUI-RouteMonitor/1.0"}
        if self._secret:
            headers["Authorization"] = f"Bearer {self._secret}"
        return headers

    def _open(self, path, timeout=None):
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            headers=self._headers(),
        )
        return self._opener.open(request, timeout=timeout or self.timeout)

    def connections(self):
        with self._open("/connections") as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise RuntimeError("clash connections response is too large")
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("connections", []), list):
            raise RuntimeError("invalid clash connections response")
        return payload

    def logs(self, timeout=30.0):
        return self._open("/logs?level=debug", timeout=timeout)


class RouteMonitor:
    """Collects route decisions only while a dashboard subscription exists."""

    def __init__(
        self,
        send,
        *,
        clash_url=DEFAULT_CLASH_URL,
        secret=None,
        index=None,
        revision=0,
        proxy_inbounds=(),
        rule_set_paths=None,
        clock=time.monotonic,
        wall_clock=time.time,
        poll_interval=1.0,
        batch_interval=0.5,
        connections_interval=2.0,
        lease_seconds=90.0,
        ring_size=EVENT_LIMIT,
        autostart=True,
        client=None,
        logger=None,
        async_tests=True,
    ):
        if not callable(send):
            raise ValueError("send callback is required")
        self._send_callback = send
        self._clash_url = str(clash_url or DEFAULT_CLASH_URL)
        self._secret = str(secret or "")
        self._revision = int(revision or 0)
        self._index_raw = list(index) if isinstance(index, (list, tuple)) else []
        self._proxy_inbounds = _target_list(proxy_inbounds)
        self._rule_set_paths = _path_map(rule_set_paths)
        self._clock = clock
        self._wall_clock = wall_clock
        self._poll_interval = max(0.2, float(poll_interval))
        self._batch_interval = max(0.1, float(batch_interval))
        self._connections_interval = max(0.5, float(connections_interval))
        self._lease_seconds = max(1.0, float(lease_seconds))
        self._ring_size = max(BATCH_LIMIT, int(ring_size or EVENT_LIMIT))
        self._autostart = bool(autostart)
        self._async_tests = bool(async_tests)
        self._logger = logger
        self._injected_client = client
        self._client = None
        self._client_signature = None
        self._rule_set_cache = RuleSetCache()
        self._route_index = RouteIndex(index, self._proxy_inbounds, self._rule_set_paths, self._rule_set_cache)

        self._lock = threading.RLock()
        self._active = False
        self._lease_until = 0.0
        self._generation = 0
        self._next_poll = 0.0
        self._next_batch = 0.0
        self._next_connections = 0.0
        self._poll_failures = 0
        self._pending = deque(maxlen=self._ring_size)
        self._connections = []
        self._seen = OrderedDict()
        self._event_ids = OrderedDict()
        self._reject_seen = OrderedDict()
        self._pending_connections = OrderedDict()
        self._dns_cache = OrderedDict()
        self._log_response = None
        self._stop = threading.Event()
        self._thread = None
        self._log_thread = None
        self._log_thread_generation = None

    def _log(self, message):
        if not self._logger:
            return
        try:
            self._logger(f"[route-monitor] {message}")
        except Exception:
            pass

    @staticmethod
    def _remember(mapping, key, value, limit):
        mapping[key] = value
        mapping.move_to_end(key)
        while len(mapping) > limit:
            mapping.popitem(last=False)

    def update(
        self,
        *,
        index=None,
        revision=None,
        proxy_inbounds=None,
        rule_set_paths=None,
        secret=None,
        clash_url=None,
    ):
        with self._lock:
            previous = {"index": self._index_raw, "revision": self._revision, "proxy_inbounds": self._proxy_inbounds, "rule_set_paths": self._rule_set_paths, "secret": self._secret, "clash_url": self._clash_url}
            next_index = self._index_raw
            if index is not None:
                next_index = list(index) if isinstance(index, (list, tuple)) else []
            next_inbounds = self._proxy_inbounds if proxy_inbounds is None else _target_list(proxy_inbounds)
            next_paths = self._rule_set_paths if rule_set_paths is None else _path_map(rule_set_paths)
            route_index = RouteIndex(next_index, next_inbounds, next_paths, self._rule_set_cache)
            self._index_raw, self._route_index = next_index, route_index
            self._proxy_inbounds, self._rule_set_paths = next_inbounds, next_paths
            if revision is not None:
                try:
                    self._revision = int(revision)
                except (TypeError, ValueError):
                    self._revision = 0
            changed = False
            if secret is not None and str(secret) != self._secret:
                self._secret = str(secret)
                self._client = None
                changed = True
            if clash_url is not None and str(clash_url) != self._clash_url:
                self._clash_url = str(clash_url)
                self._client = None
                changed = True
            if changed:
                self._generation += 1
                response = self._log_response
                self._log_response = None
                if response is not None:
                    try:
                        response.close()
                    except Exception:
                        pass
            return previous

    def handle_command(self, message):
        if not isinstance(message, dict):
            return False
        message_type = message.get("type")
        if message_type == "route_log.subscribe":
            self._activate()
            return True
        if message_type == "route_log.ping":
            self._activate()
            return True
        if message_type == "route_log.unsubscribe":
            self._deactivate("unsubscribe")
            return True
        if message_type == "route_log.test":
            command = message
            if "target" not in command and isinstance(message.get("data"), dict):
                command = message["data"]
            self._submit_test(command)
            return True
        return False

    def stop(self):
        self._deactivate("stopped")

    def close(self):
        with self._lock:
            self._stop.set()
        self._deactivate("closed")
        for thread in (self._thread, self._log_thread):
            if thread and thread.is_alive() and thread is not threading.current_thread():
                try:
                    thread.join(timeout=2)
                except Exception:
                    pass

    def _activate(self):
        now = self._clock()
        with self._lock:
            was_active = self._active
            self._active = True
            self._lease_until = now + self._lease_seconds
            if not was_active:
                self._generation += 1
                self._next_poll = 0.0
                self._next_batch = 0.0
                self._next_connections = 0.0
                self._poll_failures = 0
            generation = self._generation
        self._ensure_worker()
        self._ensure_log_thread(generation)

    def _deactivate(self, reason):
        with self._lock:
            if not self._active:
                return
            self._active = False
            self._generation += 1
            self._lease_until = 0.0
            self._next_poll = 0.0
            self._next_batch = 0.0
            self._next_connections = 0.0
            self._pending.clear()
            self._connections = []
            self._seen.clear()
            self._event_ids.clear()
            self._reject_seen.clear()
            self._pending_connections.clear()
            response = self._log_response
            self._log_response = None
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
        self._log(f"collection stopped ({reason})")

    def _ensure_worker(self):
        if not self._autostart:
            return
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._run,
                name="kui-route-monitor",
                daemon=True,
            )
            thread = self._thread
        thread.start()

    def _ensure_log_thread(self, generation):
        if not self._autostart:
            return
        with self._lock:
            if not self._active or self._generation != generation:
                return
            if (
                self._log_thread
                and self._log_thread.is_alive()
                and self._log_thread_generation == generation
            ):
                return
            self._log_thread = threading.Thread(
                target=self._run_logs,
                args=(generation,),
                name="kui-route-logs",
                daemon=True,
            )
            self._log_thread_generation = generation
            thread = self._log_thread
        thread.start()

    def _is_generation(self, generation):
        with self._lock:
            return self._active and self._generation == generation

    def _run(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as error:
                self._log(f"collector tick failed ({type(error).__name__})")
            self._stop.wait(0.2)

    def _client_or_create(self):
        if self._injected_client is not None:
            return self._injected_client
        signature = (self._clash_url, self._secret)
        if self._client is None or self._client_signature != signature:
            self._client = ClashApiClient(self._clash_url, self._secret)
            self._client_signature = signature
        return self._client

    def tick(self, now=None):
        now = self._clock() if now is None else float(now)
        with self._lock:
            if not self._active:
                return
            if now >= self._lease_until:
                self._deactivate("lease expired")
                return
            due_poll = now >= self._next_poll
            due_batch = now >= self._next_batch
            due_connections = now >= self._next_connections
            generation = self._generation
            client = self._client_or_create()
        if due_poll:
            self._poll_connections(client, now, generation)
        if due_batch:
            self._flush_events(now, generation)
        if due_connections:
            self._flush_connections(now, generation)
        self._ensure_log_thread(generation)

    def _poll_connections(self, client, now, generation):
        try:
            payload = client.connections()
        except Exception as error:
            if not self._is_generation(generation):
                return
            with self._lock:
                self._poll_failures += 1
                delay = min(2 ** min(self._poll_failures, 4), 10)
                self._next_poll = now + delay
            self._log(f"clash connections unavailable ({type(error).__name__})")
            return
        if not self._is_generation(generation):
            return
        with self._lock:
            self._poll_failures = 0
            self._next_poll = now + self._poll_interval
        self._consume_connections(payload.get("connections") or [], now)

    @staticmethod
    def _parse_start(value):
        try:
            text = str(value or "")
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            moment = datetime.fromisoformat(text)
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone.utc)
            return int(moment.timestamp() * 1000)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _inbound_from_metadata(metadata):
        for key in ("inboundTag", "inbound"):
            value = metadata.get(key)
            if value:
                return _clip(str(value), 64)
        kind = str(metadata.get("type") or "")
        if "/" in kind:
            return kind.split("/", 1)[1][:64]
        return kind[:64]

    @staticmethod
    def _ip_version(value):
        try:
            return ipaddress.ip_address(_strip_brackets(value)).version
        except ValueError:
            return 0

    @staticmethod
    def _metric(value):
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError):
            return 0

    def _connection_row(self, raw, decision, now_ms):
        metadata = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
        host = _clip(_strip_brackets(metadata.get("host")), 253)
        target_ip = _clip(_strip_brackets(metadata.get("destinationIP")), 45)
        if not host and target_ip:
            host = target_ip
        if not target_ip and host:
            try:
                address = ipaddress.ip_address(host)
                target_ip = str(address)
            except ValueError:
                target_ip = _clip(self._dns_cache.get(_normalize_domain(host), ""), 45)
        port = 0
        try:
            port = max(0, min(65535, int(metadata.get("destinationPort") or 0)))
        except (TypeError, ValueError):
            pass
        started = self._parse_start(raw.get("start"))
        rule_text = str(raw.get("rule") or "")
        rule_payload = str(raw.get("rulePayload") or "")
        if rule_payload and "=" not in rule_text:
            rule_text = f"{rule_text}={rule_payload}"
        return {
            "id": _clip(str(raw.get("id") or ""), 64),
            "host": host,
            "target_ip": target_ip,
            "port": port,
            "ip_version": self._ip_version(target_ip or host),
            "network": _clip(str(metadata.get("network") or ""), 8).lower(),
            "inbound": self._inbound_from_metadata(metadata),
            "rule": _clip(rule_text, 128),
            "rule_group": decision.get("rule_group", "unknown"),
            "outbound": decision.get("outbound", "unknown"),
            "action": decision.get("action", "unknown"),
            "upload": self._metric(raw.get("upload")),
            "download": self._metric(raw.get("download")),
            "duration_ms": max(0, now_ms - started) if started else 0,
        }

    def _connection_event(self, raw, decision, now_ms):
        row = self._connection_row(raw, decision, now_ms)
        if not row["id"] or (not row["host"] and not row["target_ip"]):
            return None
        started = self._parse_start(raw.get("start"))
        return {
            "id": row["id"],
            "ts": started or now_ms,
            "inbound": row["inbound"],
            "network": row["network"],
            "host": row["host"],
            "target_ip": row["target_ip"],
            "port": row["port"],
            "ip_version": self._ip_version(row["target_ip"] or row["host"]),
            "rule": row["rule"],
            "rule_group": decision.get("rule_group", "unknown"),
            "outbound": decision.get("outbound", "unknown"),
            "action": decision.get("action", "unknown"),
        }

    def _consume_connections(self, connections, now):
        now_ms = int(self._wall_clock() * 1000)
        rows = []
        events = []
        with self._lock:
            route_index = self._route_index
            for raw in list(connections)[:1000]:
                if not isinstance(raw, dict):
                    continue
                connection_id = _clip(str(raw.get("id") or ""), 64)
                if not connection_id:
                    continue
                chains = raw.get("chains") if isinstance(raw.get("chains"), list) else []
                rule_text = str(raw.get("rule") or "")
                rule_payload = str(raw.get("rulePayload") or "")
                if rule_payload and "=" not in rule_text:
                    rule_text = f"{rule_text}={rule_payload}"
                decision = route_index.map_connection(rule_text, chains)
                row = self._connection_row(raw, decision, now_ms)
                if len(rows) < CONNECTION_LIMIT:
                    rows.append(row)
                if connection_id in self._seen:
                    continue
                self._remember(self._seen, connection_id, True, SEEN_LIMIT)
                event = self._connection_event(raw, decision, now_ms)
                if event:
                    events.append(event)
            self._connections = rows
            for event in events:
                self._append_event_locked(event)

    def _append_event_locked(self, event):
        event_id = event.get("id")
        if event_id and event_id in self._event_ids:
            return
        if event_id:
            self._remember(self._event_ids, event_id, True, SEEN_LIMIT)
        self._pending.append(event)

    def _flush_events(self, now, generation):
        with self._lock:
            if not self._active or self._generation != generation:
                return
            self._next_batch = now + self._batch_interval
            if not self._pending:
                return
            count = min(BATCH_LIMIT, len(self._pending))
            events = [self._pending.popleft() for _ in range(count)]
        self._emit({"events": events}, "route_log.batch")

    def _flush_connections(self, now, generation):
        with self._lock:
            if not self._active or self._generation != generation:
                return
            self._next_connections = now + self._connections_interval
            connections = [dict(row) for row in self._connections[:CONNECTION_LIMIT]]
        self._emit({"connections": connections}, "route_log.connections")

    def _emit(self, data, message_type):
        try:
            result = self._send_callback(data, message_type)
        except Exception as error:
            self._log(f"send {message_type} failed ({type(error).__name__})")
            result = False
        if result is False:
            self._deactivate("transport unavailable")

    def _submit_test(self, command):
        command = dict(command) if isinstance(command, dict) else {}
        if not self._async_tests:
            self._route_test_safe(command)
            return
        thread = threading.Thread(
            target=self._route_test_safe,
            args=(command,),
            name="kui-route-test",
            daemon=True,
        )
        thread.start()

    def _route_test_safe(self, command):
        command = command if isinstance(command, dict) else {}
        try:
            self._route_test(command)
        except Exception as error:
            request_id = _clip(str(command.get("request_id") or ""), 64)
            revision = command.get("revision")
            self._emit({
                "request_id": request_id,
                "revision": revision,
                "error": f"route test failed ({type(error).__name__})",
            }, "route_log.test.result")

    def _route_test(self, command):
        command = command if isinstance(command, dict) else {}
        request_id = _clip(str(command.get("request_id") or ""), 64)
        try:
            revision = int(command.get("revision"))
        except (TypeError, ValueError):
            revision = -1
        try:
            target, version = normalize_target(command.get("target"))
        except ValueError:
            self._emit({
                "request_id": request_id,
                "revision": revision,
                "error": "invalid route test target",
            }, "route_log.test.result")
            return
        with self._lock:
            route_index = self._route_index
            current_revision = self._revision
        if revision != current_revision:
            self._emit({
                "request_id": request_id,
                "revision": revision,
                "error": "applied revision is not ready",
            }, "route_log.test.result")
            return
        try:
            decision = route_index.test(target, version)
        except RouteTestUnavailable:
            self._emit({
                "request_id": request_id,
                "revision": revision,
                "error": "route index is unavailable",
            }, "route_log.test.result")
            return
        if not decision:
            self._emit({
                "request_id": request_id,
                "revision": revision,
                "error": "route index is unavailable",
            }, "route_log.test.result")
            return
        self._emit({
            "request_id": request_id,
            "revision": revision,
            "scope": "agent",
            **decision,
        }, "route_log.test.result")

    def _run_logs(self, generation):
        while self._is_generation(generation):
            response = None
            try:
                with self._lock:
                    if not self._is_generation(generation):
                        return
                    client = self._client_or_create()
                response = client.logs(timeout=30.0)
                with self._lock:
                    if self._generation == generation:
                        self._log_response = response
                for raw in response:
                    if not self._is_generation(generation):
                        break
                    line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
                    line = line.strip()
                    if line:
                        self._handle_log_line(line)
            except Exception as error:
                if not self._is_generation(generation):
                    break
                self._log(f"clash log stream interrupted ({type(error).__name__})")
            finally:
                if response is not None:
                    try:
                        response.close()
                    except Exception:
                        pass
                    with self._lock:
                        if self._log_response is response:
                            self._log_response = None
            if self._is_generation(generation):
                time.sleep(1.0)

    def _handle_log_line(self, line):
        with self._lock:
            if not self._active:
                return
        try:
            record = json.loads(line)
        except (TypeError, ValueError):
            return
        payload = record.get("payload") if isinstance(record, dict) else None
        if not isinstance(payload, str):
            return
        payload = re.sub(r"\x1b\[[0-9;]*m", "", payload)
        prefix = _LOG_PREFIX_RE.match(payload)
        if not prefix:
            return
        connection_id, body = prefix.group(1), prefix.group(2)
        inbound = _INBOUND_TO_RE.match(body)
        if inbound:
            _, tag, packet, host, port = inbound.groups()
            network = "udp" if packet else "tcp"
            with self._lock:
                self._remember(self._pending_connections, connection_id, {
                    "host": _clip(_strip_brackets(host), 253),
                    "port": max(0, min(65535, int(port))),
                    "inbound": _clip(tag, 64),
                    "network": network,
                }, PENDING_LIMIT)
            return
        router = _ROUTER_MATCH_RE.match(body)
        if router:
            position, conditions, action, outbound_tag = router.groups()
            with self._lock:
                decision = self._route_index.by_position(position)
                if decision is None:
                    decision = self._route_index.map_connection(
                        f"{conditions} => {'reject' if action == 'reject' else f'route({outbound_tag})'}",
                        [],
                    )
                if action == "reject":
                    if connection_id in self._reject_seen:
                        return
                    self._remember(self._reject_seen, connection_id, True, SEEN_LIMIT)
                    pending = self._pending_connections.get(connection_id) or {}
                    host = _clip(str(pending.get("host") or ""), 253)
                    target_ip = _clip(str(self._dns_cache.get(_normalize_domain(host), "")), 45)
                    if not host and not target_ip:
                        return
                    self._append_event_locked({
                        "id": connection_id,
                        "ts": int(self._wall_clock() * 1000),
                        "inbound": pending.get("inbound", ""),
                        "network": pending.get("network", ""),
                        "host": host,
                        "target_ip": target_ip,
                        "port": pending.get("port", 0),
                        "ip_version": self._ip_version(target_ip or host),
                        "rule": _clip(conditions, 128),
                        "rule_group": decision.get("rule_group", "unknown"),
                        "outbound": "reject",
                        "action": "reject",
                    })
            return
        dns_ok = _DNS_OK_RE.match(body)
        if dns_ok:
            host, address = dns_ok.groups()
            self._remember_dns(host, address)
            return
        dns_a = _DNS_A_RE.match(body)
        if dns_a:
            host, address = dns_a.groups()
            self._remember_dns(host, address)

    def _remember_dns(self, host, address):
        host = _normalize_domain(host)
        if not host:
            return
        addresses = []
        for item in str(address).split():
            try:
                normalized = str(ipaddress.ip_address(_strip_brackets(item)))
            except ValueError:
                continue
            addresses.append(normalized)
        if not addresses:
            return
        preferred = next(
            (item for item in addresses if ipaddress.ip_address(item).version == 4),
            addresses[0],
        )
        with self._lock:
            current = self._dns_cache.get(host, "")
            try:
                current_version = ipaddress.ip_address(current).version
            except ValueError:
                current_version = 0
            if current_version == 4 and ipaddress.ip_address(preferred).version == 6:
                return
            self._remember(self._dns_cache, host, preferred, PENDING_LIMIT)
