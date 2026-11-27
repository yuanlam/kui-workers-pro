import ipaddress
import hashlib
import json
import os
import re
import secrets
import subprocess
import tempfile
import time
import urllib.request


LAN_CIDRS = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8"]
SELECTIVE_PROXY_RULE_SETS = []
AI_EXACT_DOMAINS = ["geminiweb-pa.clients6.google.com", "gemini.gstatic.com"]
for _group, _name in (("lan", "lan"), ("ai", "ai"), ("streaming", "stream")):
    for _kind in ("non_ip", "ip"):
        SELECTIVE_PROXY_RULE_SETS.append({"tag": "kui-" + _group + ("-domain" if _kind == "non_ip" else "-ip"), "format": "source", "url": "https://ruleset.skk.moe/sing-box/" + _kind + "/" + _name + ".json", "use": "both" if _kind == "non_ip" else "route", "group": _group})
for _group, _names in (("youtube", ("YouTube", "YouTubeMusic")), ("google", ("Google", "GoogleDrive", "GoogleFCM", "GoogleSearch", "GoogleVoice"))):
    for _name in _names:
        SELECTIVE_PROXY_RULE_SETS.append({"tag": "kui-" + _name, "format": "binary", "url": "https://raw.githubusercontent.com/senshinya/singbox_ruleset/main/rule/" + _name + "/" + _name + ".srs", "use": "both", "group": _group})


def _mirror_url(url, prefix):
    if not prefix:
        return url
    if not prefix.startswith("https://"):
        raise ValueError("ruleset mirror must use HTTPS")
    return prefix.rstrip("/") + "/" + url.removeprefix("https://")


def _valid_source(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        return data.get("version") == 2 and isinstance(data.get("rules"), list)
    except (OSError, ValueError, AttributeError):
        return False


def _download_rule_set(request, timeout):
    return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout)


def prepare_rule_sets(ruleset_dir, *, mirror_prefix="", timeout=30, sing_box_bin=None, tags=None):
    os.makedirs(ruleset_dir, exist_ok=True)
    paths = {}
    for item in SELECTIVE_PROXY_RULE_SETS:
        tag = item["tag"]
        if tags is not None and tag not in tags:
            continue
        pointer = os.path.join(ruleset_dir, tag + ".current")
        url = _mirror_url(item["url"], mirror_prefix)
        cached_url = ""
        try:
            with open(pointer, encoding="utf-8") as handle:
                name = handle.readline().strip()
                cached_url = handle.readline().strip()
            source = os.path.abspath(os.path.join(ruleset_dir, name)) if re.fullmatch(re.escape(tag) + r"-[0-9a-f]{64}\.json", name) else ""
        except OSError:
            source = ""
        if not os.path.isfile(source) or cached_url != url or time.time() - os.path.getmtime(pointer) >= 86400:
            temporary = []
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "KUI-Unified-Agent/2.0"})
                with _download_rule_set(request, timeout) as response:
                    content = response.read(32 * 1024 * 1024 + 1)
                if not content or len(content) > 32 * 1024 * 1024:
                    raise ValueError("invalid rule set size")
                fd, downloaded = tempfile.mkstemp(dir=ruleset_dir, suffix=".srs" if item["format"] == "binary" else ".json")
                temporary.append(downloaded)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(content)
                if item["format"] == "binary":
                    decoded = downloaded + ".json"
                    temporary.append(decoded)
                    subprocess.run(
                        [sing_box_bin or "sing-box", "rule-set", "decompile", "--output", decoded, downloaded],
                        check=True,
                        capture_output=True,
                        timeout=timeout,
                    )
                else:
                    decoded = downloaded
                if not _valid_source(decoded):
                    raise ValueError("invalid rule set source")
                if item["format"] == "source":
                    compiled = downloaded + ".srs"
                    temporary.append(compiled)
                    subprocess.run([sing_box_bin or "sing-box", "rule-set", "compile", "--output", compiled, decoded], check=True, capture_output=True, timeout=timeout)
                with open(decoded, "rb") as handle:
                    digest = hashlib.sha256(handle.read()).hexdigest()
                new_source = os.path.abspath(os.path.join(ruleset_dir, tag + "-" + digest + ".json"))
                os.replace(decoded, new_source)
                fd, marker = tempfile.mkstemp(dir=ruleset_dir)
                temporary.append(marker)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(os.path.basename(new_source) + "\n" + url + "\n")
                os.replace(marker, pointer)
                source = new_source
            except Exception:
                if not _valid_source(source):
                    raise
            finally:
                for path in temporary:
                    if os.path.exists(path):
                        os.remove(path)
        paths[tag] = source
    return paths


def _parse_rules(value, residential=False):
    if value is None:
        value = []
    if isinstance(value, str):
        value = value.splitlines()
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError("invalid routing list")
    if len(value) > 200 or len("\n".join(value).encode()) > 32768:
        raise ValueError("routing list too large")
    result = {}
    canonical = set()
    for raw in value:
        text = raw.strip().lower()
        if not text or text.startswith("#"):
            continue
        try:
            network = ipaddress.ip_network(text, strict=False)
        except ValueError:
            network = None
        if network is not None:
            if residential and any(network.version == ipaddress.ip_network(cidr).version and network.overlaps(ipaddress.ip_network(cidr)) for cidr in LAN_CIDRS):
                raise ValueError("reserved address in residential list")
            key, text = "ip_cidr", str(network)
        elif text.startswith("keyword:"):
            key, text = "domain_keyword", text[8:]
            if not re.fullmatch(r"[a-z0-9-]{3,64}", text):
                raise ValueError("invalid domain keyword")
        else:
            key = "domain" if text.startswith("full:") else "domain_suffix"
            text = text[5:] if key == "domain" else text.removeprefix("*.")
            text = text.rstrip(".")
            labels = text.split(".")
            if len(text) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels):
                raise ValueError("invalid domain")
            local = text == "localhost" or text.endswith(".localhost") or text == "local" or text.endswith(".local")
            if residential and local:
                raise ValueError("invalid residential domain")
            if len(labels) < 2 and not local:
                raise ValueError("invalid domain")
        canonical.add((key, text))
        result.setdefault(key, [])
        if text not in result[key]:
            result[key].append(text)
    return result, canonical


def normalize_egress_config(config, mode="native", fallback=None):
    source = dict(fallback or {})
    source.update(config if isinstance(config, dict) else {})
    selected_mode = source.get("mode", mode)
    source["mode"] = selected_mode if selected_mode in ("native", "residential") else "native"
    source["proxy_mode"] = source.get("proxy_mode") if source.get("proxy_mode") in ("global", "selective") else "global"
    source["ip_stack"] = source.get("ip_stack") if source.get("ip_stack") in ("dual", "ipv4_only", "ipv6_only") else "dual"
    source.setdefault("proxy_categories", "")
    source.setdefault("block_residential_quic", True)
    return source


def build_routing_policy(config, *, proxy_inbounds=(), sniff_inbounds=None, rule_set_paths=None, mirror_prefix="", leading_route_rules=None):
    config = normalize_egress_config(config)
    mode, stack = config["mode"], config["ip_stack"]
    selective = mode == "residential" and config["proxy_mode"] == "selective"
    global_residential = mode == "residential" and not selective
    if global_residential and stack == "ipv6_only":
        raise ValueError("global residential does not support ipv6_only")
    categories = config.get("proxy_categories") or []
    if isinstance(categories, str):
        categories = re.split(r"[,\s]+", categories)
    categories = set(categories)
    direct, direct_set = _parse_rules(config.get("proxy_direct_rules"))
    custom, custom_set = _parse_rules(config.get("proxy_custom_rules") or config.get("proxy_custom_domains"), True)
    if direct_set & custom_set:
        raise ValueError("conflicting routing rules")
    route_rules, index, dns_rules, groups = [], [], [], []
    for rule in leading_route_rules or []:
        route_rules.append(rule)
        index.append(None)
    sniff = list(proxy_inbounds if sniff_inbounds is None else sniff_inbounds)
    if sniff:
        route_rules.append({"inbound": sniff, "action": "sniff", "timeout": "1s"}); index.append(None)
    if proxy_inbounds:
        route_rules.append({"inbound": list(proxy_inbounds), "protocol": "dns", "action": "hijack-dns"}); index.append(None)
    used = set()
    strategy = {"dual": "prefer_ipv4", "ipv4_only": "ipv4_only", "ipv6_only": "ipv6_only"}[stack]

    def emit(match, group, outbound, action="route"):
        rule = dict(match)
        rule["action"] = action
        if action == "route":
            rule["outbound"] = "socks5-outbound" if outbound == "residential" else "direct-out"
        route_rules.append(rule)
        index.append({"group": group, "outbound": outbound, "action": action, "match": dict(match)})

    def group_rule(group, match, dns_match, outbound):
        if not match:
            return
        groups.append(group)
        if outbound == "residential":
            if config["block_residential_quic"]:
                emit({**match, "network": ["udp"], "port": [443]}, "quic_reject", "reject", "reject")
                emit({**match, "protocol": ["quic"]}, "quic_reject", "reject", "reject")
            emit({**match, "ip_version": 6}, "stack_reject", "reject", "reject")
            if dns_match:
                route_rules.append({**dns_match, "action": "resolve", "server": "proxy-dns", "strategy": "ipv4_only"})
                index.append(None)
        elif stack in ("ipv4_only", "ipv6_only"):
            emit({**match, "ip_version": 6 if stack == "ipv4_only" else 4}, "stack_reject", "reject", "reject")
        emit(match, group, outbound)
        if dns_match:
            dns_rules.append({**dns_match, "action": "route", "server": "proxy-dns" if outbound == "residential" else "local-dns", "strategy": "ipv4_only" if outbound == "residential" else strategy})

    def builtin(group, outbound):
        entries = [item for item in SELECTIVE_PROXY_RULE_SETS if item["group"] == group]
        tags = [item["tag"] for item in entries]
        domain_tags = [item["tag"] for item in entries if item["use"] == "both"]
        used.update(tags)
        if group == "ai":
            group_rule(group, {"domain": AI_EXACT_DOMAINS}, {"domain": AI_EXACT_DOMAINS}, outbound)
        group_rule(group, {"rule_set": tags}, {"rule_set": domain_tags}, outbound)

    groups.append("lan")
    builtin("lan", "direct")
    group_rule("lan", {"ip_cidr": LAN_CIDRS, "domain": ["localhost"], "domain_suffix": ["local", "localhost"]}, {"domain": ["localhost"], "domain_suffix": ["local", "localhost"]}, "direct")
    if selective:
        group_rule("custom_direct", direct, {key: value for key, value in direct.items() if key != "ip_cidr"}, "direct")
        if "custom" in categories:
            group_rule("custom_proxy", custom, {key: value for key, value in custom.items() if key != "ip_cidr"}, "residential")
        for group in ("ai", "youtube", "streaming", "google"):
            if group in categories:
                builtin(group, "residential")
            elif group == "ai" and "google" in categories or group == "youtube" and categories.intersection({"streaming", "google"}):
                builtin(group, "direct")
    final_outbound = "residential" if global_residential else "direct"
    if global_residential and config["block_residential_quic"]:
        emit({"network": ["udp"], "port": [443]}, "quic_reject", "reject", "reject")
        emit({"protocol": ["quic"]}, "quic_reject", "reject", "reject")
    rejected_version = 6 if global_residential or stack == "ipv4_only" else 4 if stack == "ipv6_only" else None
    if rejected_version:
        emit({"ip_version": rejected_version}, "stack_reject", "reject", "reject")
    if global_residential:
        route_rules.append({"action": "resolve", "server": "proxy-dns", "strategy": "ipv4_only"})
        index.append(None)
    emit({}, "final", final_outbound)
    rulesets = [{"tag": tag, "type": "local", "format": "source", "path": (rule_set_paths or {}).get(tag, "")} for tag in sorted(used)]
    servers = [{"type": "local", "tag": "local-dns"}]
    if mode == "residential":
        servers.extend({"type": "https", "tag": tag, "server": address, "server_port": 443, "path": "/dns-query", "tls": {"enabled": True, "server_name": name}, "detour": "socks5-outbound"} for tag, address, name in (("proxy-dns", "1.1.1.1", "cloudflare-dns.com"), ("proxy-dns-backup", "8.8.8.8", "dns.google")))
    route = {"rules": route_rules, "rule_set": rulesets, "final": "socks5-outbound" if global_residential else "direct-out", "default_domain_resolver": "local-dns"}
    dns = {"servers": servers, "rules": dns_rules, "final": "proxy-dns" if global_residential else "local-dns", "strategy": "ipv4_only" if global_residential else strategy, "independent_cache": True, "reverse_mapping": True, "cache_capacity": 4096}
    return {"route": route, "dns": dns, "route_rules": route_rules, "dns_rules": dns_rules, "rulesets": rulesets, "index": index, "rule_set_paths": {tag: path for tag, path in (rule_set_paths or {}).items() if tag in used}, "clash_api_secret": secrets.token_urlsafe(24), "groups": list(dict.fromkeys(groups))}
