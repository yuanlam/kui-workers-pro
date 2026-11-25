import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { __test as apiTest } from '../functions/api/[[path]].js';

const proxyModuleUrl = new URL('../frontend/src/proxy/legacyProxy.js', import.meta.url);
const stateSource = fs.readFileSync(new URL('../frontend/src/composables/useKuiState.js', import.meta.url), 'utf8');
const pageSource = fs.readFileSync(new URL('../frontend/src/pages/ResidentialProxyPage.vue', import.meta.url), 'utf8');

let proxyImportSequence = 0;

const jsonResponse = (payload, { ok = true, status = 200 } = {}) => ({
    ok,
    status,
    json: async () => payload,
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
});

const deferred = () => {
    let resolve;
    const promise = new Promise(resolver => { resolve = resolver; });
    return { promise, resolve };
};

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const classTokens = value => String(value || '').split(/\s+/).filter(Boolean);

const createClassList = element => ({
    add(...names) {
        const tokens = new Set(classTokens(element.className));
        names.forEach(name => tokens.add(name));
        element.className = [...tokens].join(' ');
    },
    remove(...names) {
        const removed = new Set(names);
        element.className = classTokens(element.className).filter(name => !removed.has(name)).join(' ');
    },
    contains(name) {
        return classTokens(element.className).includes(name);
    },
    toggle(name, force) {
        const active = force === undefined ? !this.contains(name) : Boolean(force);
        if (active) this.add(name);
        else this.remove(name);
        return active;
    },
});

const createElement = tagName => {
    const listeners = new Map();
    const element = {
        tagName: String(tagName || 'div').toUpperCase(),
        id: '',
        parentNode: null,
        isConnected: false,
        attributes: {},
        style: {},
        className: '',
        textContent: '',
        value: '',
        children: [],
        options: [],
        scrollHeight: 0,
        scrollTop: 0,
        clientHeight: 0,
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(callback);
        },
        dispatchEvent(event) {
            const payload = { ...event, target: event?.target || this };
            for (const callback of listeners.get(payload.type) || []) callback(payload);
            return true;
        },
        emit(type, properties = {}) {
            return this.dispatchEvent({ type, ...properties });
        },
        removeEventListener(type, callback) {
            listeners.get(type)?.delete(callback);
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
            if (name === 'id') this.id = String(value);
        },
        getAttribute(name) {
            return this.attributes[name] ?? null;
        },
        get dataset() {
            const element = this;
            return new Proxy({}, {
                get(_, key) {
                    if (typeof key !== 'string') return undefined;
                    return element.attributes[`data-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`];
                },
                set(_, key, value) {
                    if (typeof key !== 'string') return false;
                    element.attributes[`data-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`] = String(value);
                    return true;
                },
                has(_, key) {
                    return typeof key === 'string'
                        && Object.hasOwn(element.attributes, `data-${key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`);
                },
            });
        },
        removeAttribute(name) {
            delete this.attributes[name];
        },
        appendChild(child) {
            child.parentNode = this;
            child.isConnected = true;
            this.children.push(child);
            return child;
        },
        replaceChildren(...children) {
            this.children = children;
        },
        closest() {
            return null;
        },
        focus() {},
        querySelectorAll(selector) {
            if (selector === '[data-country-code]') return this._countryChips || [];
            return [];
        },
    };
    element.classList = createClassList(element);
    Object.defineProperty(element, 'innerHTML', {
        get() {
            return this._innerHTML || '';
        },
        set(value) {
            this._innerHTML = String(value);
            if (this.tagName === 'SELECT') {
                const optionValues = [...this._innerHTML.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]);
                this.options = optionValues.map(optionValue => ({ value: optionValue }));
                if (!optionValues.includes(this.value)) this.value = optionValues[0] || '';
            }
            if (this._innerHTML.includes('data-country-code=')) {
                this._countryChips = [];
                for (const match of this._innerHTML.matchAll(/<button\b([^>]*)>/g)) {
                    const attributes = match[1];
                    const code = attributes.match(/data-country-code="([^"]+)"/)?.[1];
                    if (!code) continue;
                    const chip = createElement('button');
                    chip.dataset.countryCode = code;
                    chip.className = attributes.match(/class="([^"]*)"/)?.[1] || '';
                    chip.setAttribute('data-country-code', code);
                    this._countryChips.push(chip);
                }
            }
        },
    });
    return element;
};

const installEnvironment = ({ fetchImpl, servers = [] } = {}) => {
    const previousGlobals = new Map();
    for (const key of ['window', 'document', 'sessionStorage', 'fetch', 'alert', 'confirm']) {
        previousGlobals.set(key, globalThis[key]);
    }

    const byId = new Map();
    const alerts = [];
    const fetchCalls = [];
    let managedServers = servers;
    let readyNodesSyncActive = false;
    let readyNodesSyncCount = 0;

    const storage = values => ({
        values: new Map(Object.entries(values)),
        getItem(key) {
            return this.values.has(key) ? this.values.get(key) : null;
        },
        setItem(key, value) {
            this.values.set(key, String(value));
        },
        removeItem(key) {
            this.values.delete(key);
        },
    });

    const document = {
        hidden: false,
        body: createElement('body'),
        documentElement: createElement('html'),
        head: createElement('head'),
        getElementById(id) {
            return byId.get(id) || null;
        },
        createElement(tagName) {
            return createElement(tagName);
        },
        querySelectorAll() {
            return [];
        },
        addEventListener() {},
        removeEventListener() {},
    };

    const window = {
        location: { origin: 'https://panel.example' },
        kuiManagedServers: () => managedServers,
        kuiManagedServerIps: () => managedServers.map(server => server.ip),
        kuiRealtimeProxySnapshots: {},
    };

    globalThis.window = window;
    globalThis.document = document;
    globalThis.sessionStorage = storage({ kui_user: 'admin', kui_auth_key: 'token' });
    globalThis.alert = message => alerts.push(String(message));
    globalThis.confirm = () => true;
    globalThis.fetch = async (url, options = {}) => {
        const requestUrl = String(url);
        if (readyNodesSyncActive && requestUrl.startsWith('/api/proxy/nodes')) {
            return jsonResponse(managedServers.map((server, index) => ({
                ip: server.ip,
                name: server.name || server.ip,
                details: JSON.stringify([
                    { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: `198.51.100.${10 + index * 2}` },
                    { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: `198.51.100.${11 + index * 2}` },
                ]),
                last_seen: Date.now(),
            })));
        }
        fetchCalls.push({ url: requestUrl, options });
        if (fetchImpl) return fetchImpl(requestUrl, options, fetchCalls);
        return jsonResponse({});
    };

    return {
        window,
        document,
        alerts,
        fetchCalls,
        addElement(id, tagName = 'div') {
            const element = createElement(tagName);
            element.id = id;
            element.isConnected = true;
            byId.set(id, element);
            return element;
        },
        setManagedServers(value) {
            managedServers = value;
        },
        async syncReadyNodes(proxy) {
            readyNodesSyncCount += 1;
            const realNow = Date.now;
            readyNodesSyncActive = true;
            Date.now = () => realNow() + readyNodesSyncCount * 20000;
            try {
                await proxy.pcFetchNodes();
            } finally {
                Date.now = realNow;
                readyNodesSyncActive = false;
            }
        },
        cleanup() {
            for (const [key, value] of previousGlobals) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        },
    };
};

const loadLegacyProxy = () => import(`${proxyModuleUrl.href}?test=${++proxyImportSequence}`);

const runPreSelectionEditReload = async switchSucceeds => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const refreshResponse = deferred();
    const refreshStarted = deferred();
    const reloadStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    const refreshedConfig = {
        '0': 'JP',
        port: 9300,
        proxy: { listen_host: '172.18.0.1', public_listener: false },
    };
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    refreshStarted.resolve();
                    return refreshResponse.promise;
                }
                if (configRound === 3) reloadStarted.resolve();
                return jsonResponse(refreshedConfig);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                if (switchBodies.length === 1) {
                    switchStarted.resolve();
                    return switchResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        port.value = '9901';
        port.emit('input');
        listenHost.value = '*';
        listenHost.emit('input');

        target.value = '*';
        proxy.pcInvalidateLoadedConfig();
        const pendingLoad = proxy.pcLoadConfig();
        target.emit('change');
        await refreshStarted.promise;
        country.value = 'CA';
        country.emit('input');

        refreshResponse.resolve(jsonResponse({
            '0': 'JP',
            port: 9901,
            proxy: { listen_host: '', public_listener: true },
        }));
        await pendingLoad.catch(() => {});

        switchResponse.resolve(switchSucceeds
            ? jsonResponse({ success: true })
            : jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 }));
        await pendingSwitch;
        await reloadStarted.promise;
        await delay(15);

        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9300');
        assert.equal(listenHost.value, '172.18.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');

        const bodyCountBeforeRetry = switchBodies.length;
        await proxy.pcSwitchIP('hot');

        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), false);
        const retryBodies = switchBodies.slice(bodyCountBeforeRetry);
        assert.deepEqual(retryBodies.map(body => body.ip), ['203.0.113.8', '203.0.113.9']);
        for (const body of retryBodies) {
            assert.equal(body['0'], 'CA');
            assert.equal(body.port, 9300);
            assert.equal(Object.hasOwn(body, 'public_listener'), false);
            assert.equal(Object.hasOwn(body, 'listen_host'), false);
        }
        assert.deepEqual(switchBodies[0], {
            ip: '203.0.113.8',
            '0': 'JP',
            port: 7920,
            switch_mode: 'hot',
        });
    } finally {
        env.cleanup();
    }
};

test('switching to all VPS after pre-selection edits reloads current fields after a successful switch', { timeout: 5000 }, async () => {
    await runPreSelectionEditReload(true);
});

test('switching to all VPS after pre-selection edits reloads current fields after a 503 switch', { timeout: 5000 }, async () => {
    await runPreSelectionEditReload(false);
});

test('a delayed batch reload keeps the full selection loaded for a failed-target retry', { timeout: 5000 }, async () => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const reloadStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 3) reloadStarted.resolve();
                return jsonResponse({
                    '0': 'FR',
                    port: 8400,
                    proxy: { listen_host: '172.19.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                if (body.ip === '203.0.113.9') {
                    switchStarted.resolve();
                    return switchResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();
        country.value = 'CA';
        country.emit('input');
        port.value = '9100';
        port.emit('input');

        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;
        const pendingLoad = proxy.pcLoadConfig().catch(error => configErrors.push(error));
        await pendingLoad;

        switchResponse.resolve(jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 }));
        await pendingSwitch;
        await reloadStarted.promise;
        await delay(15);

        const bodyCountBeforeRetry = switchBodies.length;
        await proxy.pcSwitchIP('hot');

        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), false);
        assert.deepEqual(switchBodies.slice(0, 2), [
            { ip: '203.0.113.8', '0': 'CA', port: 9100, switch_mode: 'hot' },
            { ip: '203.0.113.9', '0': 'CA', port: 9100, switch_mode: 'hot' },
        ]);
        assert.deepEqual(switchBodies.slice(bodyCountBeforeRetry), [
            { ip: '203.0.113.9', '0': 'CA', port: 9100, switch_mode: 'hot' },
        ]);
    } finally {
        env.cleanup();
    }
});

test('empty realtime details clear stale tunnel rows while omitted details preserve the snapshot', async () => {
    const sampledAt = Date.now();
    const staleDetails = [{ tunnel: 'tun_main', active: true, country: 'JP', port: 7920, node_ip: '' }];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge',
                    details: JSON.stringify(staleDetails),
                    last_seen: sampledAt,
                }]);
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        target.value = '203.0.113.8';
        const proxy = await loadLegacyProxy();
        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy: { details: [] },
                proxy_last_seen: sampledAt,
            },
        };

        await proxy.pcFetchNodes();

        assert.equal(ui.exit.textContent, '主通道未就绪');
        assert.equal(ui.activeDetails.hidden, true);
        assert.equal(ui.activeCopy.hidden, true);
        assert.equal(ui.activeStatus.textContent, '通道未上报');
        assert.equal(
            proxy.pcMergeRealtimeServer(
                { ip: '203.0.113.8', details: JSON.stringify(staleDetails) },
                { ip: '203.0.113.8', proxy: { details: [] } },
            ).details,
            '[]',
        );
        assert.equal(
            proxy.pcMergeRealtimeServer(
                { ip: '203.0.113.8', details: JSON.stringify(staleDetails) },
                { ip: '203.0.113.8', proxy: { logs: 'heartbeat' } },
            ).details,
            JSON.stringify(staleDetails),
        );

        window.kuiRealtimeProxySnapshots = {};
        await proxy.pcFetchNodes();
        assert.equal(ui.exit.textContent, '主通道未就绪');
        assert.equal(ui.activeStatus.textContent, '通道未上报');
        assert.equal(ui.activeDetails.hidden, true);
    } finally {
        env.cleanup();
    }
});

test('stale realtime snapshots cannot overwrite newer HTTP tunnel state', async () => {
    const activeDetails = [{ tunnel: 'tun_main', active: true, country: 'JP', port: 7920, node_ip: '198.51.100.8' }];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge',
                    details: JSON.stringify(activeDetails),
                    last_seen: 300,
                }]);
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        target.value = '203.0.113.8';
        const proxy = await loadLegacyProxy();

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': { ip: '203.0.113.8', proxy: { details: [] }, proxy_last_seen: 100 },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.exit.textContent, '198.51.100.8');
        assert.equal(ui.activeDetails.hidden, false);
        assert.match(ui.activeDetailRows.innerHTML, /tun_main/);
        assert.equal(ui.channels.textContent, '1 / 2 通道');

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': { ip: '203.0.113.8', proxy: { details: [] }, proxy_last_seen: 300 },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.exit.textContent, '主通道未就绪');
        assert.equal(ui.activeDetails.hidden, true);
        assert.doesNotMatch(ui.activeDetailRows.innerHTML, /tun_main/);
        assert.equal(ui.channels.textContent, '0 / 2 通道');

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': { ip: '203.0.113.8', proxy: { details: [] }, proxy_last_seen: 400 },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.exit.textContent, '主通道未就绪');
        assert.equal(ui.activeDetails.hidden, true);
        assert.equal(ui.channels.textContent, '0 / 2 通道');
    } finally {
        env.cleanup();
    }
});

test('newer HTTP snapshots replace stale cached realtime tunnel state', async () => {
    let nodeRound = 0;
    const staleDetails = [{ tunnel: 'tun_stale', active: true, country: 'JP', port: 7920 }];
    const activeDetails = [{ tunnel: 'tun_main', active: true, country: 'US', port: 7920, node_ip: '198.51.100.8' }];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) {
                nodeRound += 1;
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge',
                    details: JSON.stringify(nodeRound === 1 ? staleDetails : activeDetails),
                    last_seen: nodeRound === 1 ? 200 : 400,
                }]);
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        target.value = '203.0.113.8';
        const proxy = await loadLegacyProxy();

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy: { details: [] },
                proxy_last_seen: 300,
            },
        };
        await proxy.pcFetchNodes();
        assert.doesNotMatch(ui.activeDetailRows.innerHTML, /tun_stale/);
        assert.equal(ui.exit.textContent, '主通道未就绪');
        assert.equal(ui.channels.textContent, '0 / 2 通道');

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy: { details: [] },
                proxy_last_seen: 300,
            },
        };
        await proxy.pcFetchNodes();
        assert.doesNotMatch(ui.activeDetailRows.innerHTML, /tun_stale/);
        assert.equal(ui.exit.textContent, '主通道未就绪');
        assert.equal(ui.channels.textContent, '0 / 2 通道');

        window.kuiRealtimeProxySnapshots = {};
        proxy.pcStopProxy();
        await proxy.pcFetchNodes();
        assert.equal(ui.exit.textContent, '198.51.100.8');
        assert.match(ui.activeDetailRows.innerHTML, /tun_main/);
        assert.equal(ui.channels.textContent, '1 / 2 通道');
    } finally {
        env.cleanup();
    }
});

test('proxy sampling timestamps normalize seconds and milliseconds consistently', async () => {
    const env = installEnvironment();
    try {
        const proxy = await loadLegacyProxy();
        const activeDetails = [{ tunnel: 'tun_main', active: true, country: 'JP', port: 7920 }];
        const merged = proxy.pcMergeRealtimeServer(
            {
                ip: '203.0.113.8',
                details: JSON.stringify(activeDetails),
                _pc_http_sample_ts: 1700000003000,
            },
            {
                ip: '203.0.113.8',
                proxy_updated_at: 1700000001000,
                proxy: { details: [] },
            },
        );
        assert.equal(merged.details, JSON.stringify(activeDetails));
        assert.equal(
            proxy.pcMergeRealtimeServer(
                {
                    ip: '203.0.113.8',
                    details: JSON.stringify(activeDetails),
                    last_seen: 1700000003000,
                },
                {
                    ip: '203.0.113.8',
                    proxy_last_seen: 1700000001,
                    proxy: { details: [] },
                },
            ).details,
            JSON.stringify(activeDetails),
        );

        const newer = proxy.pcMergeRealtimeServer(
            {
                ip: '203.0.113.8',
                details: JSON.stringify(activeDetails),
                _pc_http_sample_ts: 1700000003000,
            },
            {
                ip: '203.0.113.8',
                proxy_last_seen: 1700000004,
                proxy: { details: [] },
            },
        );
        assert.equal(newer.details, '[]');
        assert.equal(newer._pc_realtime_sample_ts, 1700000004000);
    } finally {
        env.cleanup();
    }
});

test('ANY is a valid global country and the countries list exposes a selected shortcut', async () => {
    const env = installEnvironment({
        fetchImpl: async url => {
            if (url === '/api/proxy/countries') return jsonResponse([{ code: 'jp', nodes: 3 }, { code: 'us', nodes: 1 }]);
            return jsonResponse({});
        },
    });
    try {
        const container = env.addElement('countries-list');
        const input = env.addElement('slot-cfg-0', 'input');
        const proxy = await loadLegacyProxy();

        assert.equal(proxy.normalizePcCountry(' any '), 'ANY');
        assert.equal(proxy.normalizePcCountry(' jp '), 'JP');
        assert.equal(proxy.normalizePcCountry(' a n y '), 'ANY');
        assert.equal(proxy.isValidPcCountry('ANY'), true);
        assert.equal(proxy.isValidPcCountry('jp'), true);
        assert.equal(proxy.isValidPcCountry('JPN'), false);
        assert.equal(proxy.isValidPcCountry('A'), false);

        await proxy.pcFetchCountries();

        assert.match(container.innerHTML, /data-country-code="ANY"/);
        assert.match(container.innerHTML, /自动优选/);
        const anyChip = container.querySelectorAll('[data-country-code]').find(chip => chip.dataset.countryCode === 'ANY');
        assert.ok(anyChip);
        container.onclick({ target: { closest: () => anyChip } });
        assert.equal(input.value, 'ANY');
        assert.ok(anyChip.classList.contains('pc-country-chip-active'));
        assert.equal(anyChip.style.borderColor, '#818cf8');
        assert.equal(anyChip.getAttribute('aria-pressed'), 'true');
    } finally {
        env.cleanup();
    }
});

test('unavailable country counts show an explicit status instead of zero', async () => {
    const env = installEnvironment({ fetchImpl: async () => jsonResponse([{ code: 'JP', nodes: null }]) });
    try {
        const container = env.addElement('countries-list');
        const proxy = await loadLegacyProxy();
        await proxy.pcFetchCountries();
        assert.match(container.innerHTML, /节点数量读取失败/);
        assert.match(container.innerHTML, /候选节点 —/);
        assert.doesNotMatch(container.innerHTML, /候选节点 0/);
    } finally {
        env.cleanup();
    }
});

test('country shortcut clicks invalidate delayed config responses and preserve the selected shortcut', async () => {
    const staleLoad = deferred();
    const loadStarted = deferred();
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async url => {
            if (url === '/api/proxy/countries') return jsonResponse([{ code: 'JP', nodes: 3 }]);
            if (url.startsWith('/api/proxy/config?ip=')) {
                loadStarted.resolve();
                return staleLoad.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        const container = env.addElement('countries-list');
        env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();

        await proxy.pcFetchCountries();
        const anyChip = container.querySelectorAll('[data-country-code]').find(chip => chip.dataset.countryCode === 'ANY');
        const pendingLoad = proxy.pcLoadConfig();
        await loadStarted.promise;
        container.onclick({ target: { closest: () => anyChip } });
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        staleLoad.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await pendingLoad;

        assert.equal(country.value, 'ANY');
        assert.equal(String(port.value), '7920');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.ok(anyChip.classList.contains('pc-country-chip-active'));
    } finally {
        env.cleanup();
    }
});

test('config load and save preserve listener baselines and only submit explicit listener edits', async () => {
    const postBodies = [];
    const notified = [];
    const switchBodies = [];
    let loadedConfig = {
        '0': 'any',
        port: 8123,
        proxy: { listen_host: '', public_listener: true },
    };
    let serverListenHost = '172.17.0.1';
    let serverPublicListener = true;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse(loadedConfig);
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                postBodies.push(body);
                if (body.listen_host === '*') {
                    return jsonResponse({ success: false, error: 'listen_host must be an IPv4 address or empty' }, { ok: false, status: 400 });
                }
                if (body.public_listener !== undefined) serverPublicListener = body.public_listener;
                if (body.listen_host !== undefined) serverListenHost = body.listen_host;
                return jsonResponse({
                    success: true,
                    slot_map: { country: 'JP', port: 9000, listen_host: serverListenHost, public_listener: serverPublicListener },
                    proxy: { country: 'JP', port: 9000, listen_host: serverListenHost, public_listener: serverPublicListener },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                configBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        window.kuiNotifyRealtime = async ip => notified.push(ip);
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        await proxy.pcLoadConfig();
        assert.equal(document.getElementById('slot-target-ip').value, '203.0.113.8');
        assert.equal(country.value, 'ANY');
        assert.equal(port.value, 8123);
        assert.equal(listenHost.value, '*');

        await proxy.pcSwitchIP('hot');
        assert.equal(postBodies.length, 0);
        assert.equal(switchBodies.length, 1);
        assert.equal('public_listener' in switchBodies[0], false);
        assert.equal('listen_host' in switchBodies[0], false);
        assert.equal(listenHost.value, '*');

        loadedConfig = { '0': 'JP', port: 8123, proxy: { listen_host: '127.0.0.1', public_listener: false } };
        await proxy.pcLoadConfig();
        assert.equal(listenHost.value, '127.0.0.1');

        loadedConfig = { '0': 'JP', port: 8123, proxy: { listen_host: '', public_listener: true } };
        await proxy.pcLoadConfig();
        assert.equal(listenHost.value, '*');

        country.value = ' jp ';
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');
        await proxy.pcSaveConfig();
        assert.equal(postBodies[0].country, 'JP');
        assert.equal(postBodies[0].listen_host, '127.0.0.1');
        assert.equal(postBodies[0].public_listener, false);
        assert.equal(listenHost.value, '127.0.0.1');

        await proxy.pcSaveConfig();
        assert.equal('public_listener' in postBodies[1], false);
        assert.equal('listen_host' in postBodies[1], false);
        assert.equal(listenHost.value, '127.0.0.1');

        listenHost.value = '*';
        listenHost.emit('input');
        await proxy.pcSaveConfig();
        assert.equal('listen_host' in postBodies[2], false);
        assert.equal(postBodies[2].public_listener, true);
        assert.equal(listenHost.value, '*');
        assert.deepEqual(notified, ['203.0.113.8', '203.0.113.8', '203.0.113.8', '203.0.113.8']);
    } finally {
        env.cleanup();
    }
});

test('stopping the proxy invalidates the HTTP node cache and target options refresh in place', async () => {
    let nodeRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) {
                nodeRound += 1;
                return jsonResponse([{
                    ip: nodeRound === 1 ? '203.0.113.8' : '203.0.113.9',
                    name: nodeRound === 1 ? 'edge-a' : 'edge-b',
                    details: '[]',
                    last_seen: Date.now(),
                }]);
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const overviewTarget = env.addElement('pc-overview-target', 'div');
        const compatGrid = env.addElement('pc-nodes-table', 'div');
        compatGrid.innerHTML = '<span>compat grid untouched</span>';
        env.addElement('pc-terminal-output');
        const proxy = await loadLegacyProxy();

        await proxy.pcFetchNodes();
        assert.equal(overviewTarget.textContent, 'edge-a');
        assert.match(target.innerHTML, /203\.0\.113\.8/);

        target.value = '203.0.113.8';
        env.setManagedServers([
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ]);
        proxy.pcPopulateTargets();
        assert.equal(target.value, '203.0.113.8');
        assert.match(target.innerHTML, /203\.0\.113\.9/);

        proxy.pcStopProxy();
        await proxy.pcFetchNodes();
        assert.equal(nodeRound, 2);
        assert.equal(overviewTarget.textContent, 'edge-a');
        assert.match(target.innerHTML, /203\.0\.113\.9/);
        assert.equal(compatGrid.innerHTML, '<span>compat grid untouched</span>');
    } finally {
        env.cleanup();
    }
});

test('switch actions send country, port and mode in one request per target and default to hot', async () => {
    const switchBodies = [];
    const configBodies = [];
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true, switch_trigger: 123 });
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                configBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { country: 'JP', port: 7920, listen_host: '172.17.0.1', public_listener: false },
                });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        country.value = 'ANY';
        port.value = '9001';
        await proxy.pcSwitchIP();
        target.value = '203.0.113.8';
        await proxy.pcSwitchIP('FULL');
        target.value = '203.0.113.8';
        await proxy.pcSwitchProxy();

        assert.equal(switchBodies.length, 3);
        assert.deepEqual(switchBodies[0], { ip: '203.0.113.8', '0': 'ANY', port: 9001, switch_mode: 'hot' });
        assert.deepEqual(switchBodies[1], { ip: '203.0.113.8', '0': 'ANY', port: 9001, switch_mode: 'full' });
        assert.deepEqual(switchBodies[2], { ip: '203.0.113.8', '0': 'ANY', port: 9001, switch_mode: 'hot' });
        assert.equal(configBodies.length, 0);

        target.value = '*';
        await proxy.pcLoadConfig();
        country.value = 'ANY';
        port.value = '9001';
        await proxy.pcSwitchIP('full');
        assert.equal(switchBodies.length, 5);
        assert.deepEqual(switchBodies.slice(3).map(body => body.ip), ['203.0.113.8', '203.0.113.9']);
        assert.ok(switchBodies.slice(3).every(body => body['0'] === 'ANY' && body.port === 9001 && body.switch_mode === 'full'));
        assert.ok(switchBodies.every(body => body.public_listener === undefined && body.listen_host === undefined && body.switch_trigger === undefined));
        assert.equal(configBodies.length, 0);
        assert.equal(listenHost.value, '172.17.0.1');
        listenHost.value = '*';
        listenHost.emit('input');
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 7);
        assert.ok(switchBodies.slice(5).every(body => body.public_listener === true && body.listen_host === undefined));
    } finally {
        env.cleanup();
    }
});

test('single-target switch sends one atomic request with normalized form values', async () => {
    const calls = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({ '0': 'JP', port: 7920, proxy: { listen_host: '127.0.0.1', public_listener: false } });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                return jsonResponse({
                    success: true,
                    slot_map: { country: 'ANY', port: 8100, listen_host: '127.0.0.1', public_listener: false },
                    proxy: { country: 'ANY', port: 8100, listen_host: '127.0.0.1', public_listener: false },
                });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        document.getElementById('slot-target-ip').value = '203.0.113.8';
        await proxy.pcLoadConfig();
        country.value = ' any ';
        port.value = '8100';
        await proxy.pcSwitchIP('hot');

        assert.deepEqual(calls.map(call => call.url), ['/api/proxy/config?ip=203.0.113.8', '/api/proxy/switch']);
        const switchBody = JSON.parse(calls[1].options.body);
        assert.deepEqual(switchBody, { ip: '203.0.113.8', '0': 'ANY', port: 8100, switch_mode: 'hot' });
        assert.equal(country.value, 'ANY');
        assert.equal(port.value, '8100');
        assert.equal(listenHost.value, '127.0.0.1');
    } finally {
        env.cleanup();
    }
});

test('switch submits an edited wildcard as public_listener only and an IPv4 as an explicit listener', async () => {
    const switchBodies = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({ '0': 'JP', port: 7920, proxy: { listen_host: '172.17.0.1', public_listener: false } });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const publicListener = body.public_listener === true;
                return jsonResponse({
                    success: true,
                    slot_map: { country: body['0'], port: body.port, listen_host: body.listen_host ?? '172.17.0.1', public_listener: publicListener },
                    proxy: { country: body['0'], port: body.port, listen_host: body.listen_host ?? '172.17.0.1', public_listener: publicListener },
                });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        await proxy.pcLoadConfig();
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies[0].public_listener, false);
        assert.equal(switchBodies[0].listen_host, '127.0.0.1');

        listenHost.value = '*';
        listenHost.emit('input');
        await proxy.pcSwitchIP('full');
        assert.equal(switchBodies[1].public_listener, true);
        assert.equal('listen_host' in switchBodies[1], false);
        assert.equal(listenHost.value, '*');

        await proxy.pcSwitchIP('hot');
        assert.equal('public_listener' in switchBodies[2], false);
        assert.equal('listen_host' in switchBodies[2], false);
    } finally {
        env.cleanup();
    }
});

test('batch switch never copies the loaded first-node listener to other nodes', async () => {
    const switchBodies = [];
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({ '0': 'JP', port: 7920, proxy: { listen_host: '', public_listener: true } });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                configBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();
        assert.equal(listenHost.value, '*');
        await proxy.pcSwitchIP('hot');

        assert.equal(switchBodies.length, 2);
        assert.deepEqual(switchBodies.map(body => body.ip), ['203.0.113.8', '203.0.113.9']);
        assert.ok(switchBodies.every(body => body.public_listener === undefined && body.listen_host === undefined));
    } finally {
        env.cleanup();
    }
});

test('switch failure produces no configuration write and leaves the submitted form intact', async () => {
    const calls = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            calls.push(url);
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({ '0': 'JP', port: 7920, proxy: { listen_host: '172.17.0.1', public_listener: false } });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                return jsonResponse({ success: false, error: 'PROXY_CONFIG_CONFLICT' }, { ok: false, status: 409 });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        document.getElementById('slot-target-ip').value = '203.0.113.8';
        await proxy.pcLoadConfig();
        country.value = 'us';
        port.value = '8123';
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');
        await proxy.pcSwitchIP('hot');

        assert.deepEqual(calls, ['/api/proxy/config?ip=203.0.113.8', '/api/proxy/switch']);
        assert.equal(country.value, 'US');
        assert.equal(port.value, '8123');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(env.alerts.some(message => message.includes('下发失败')), true);
    } finally {
        env.cleanup();
    }
});

test('tunnel telemetry badges format quality fields and omit legacy or invalid values', async () => {
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge',
                    details: JSON.stringify([
                        { tunnel: 'tun_main', active: true, country: 'JP', port: 7920, ttfb_ms: 120, speed_kbps: 8400, connected_time: 125, ready: true },
                        { tunnel: 'tun_backup', active: false, country: 'US', port: 7920, ttfb_ms: 0, speed_kbps: 840, connected_time: 5, ready: true },
                    ]),
                    last_seen: Date.now(),
                }]);
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        target.value = '203.0.113.8';
        const proxy = await loadLegacyProxy();

        assert.equal(proxy.formatPcSpeed(10000), '10.0 Mbps');
        assert.equal(proxy.formatPcSpeed(640), '640 kbps');
        assert.equal(proxy.formatPcDuration(125), '2m 05s');
        assert.equal(proxy.formatPcDuration(45), '45s');
        assert.equal(proxy.pcTunnelTelemetryBadges({ tunnel: 'tun_main' }), '');
        assert.equal(proxy.pcTunnelTelemetryBadges({ tunnel: 'tun_main', ttfb_ms: null, speed_kbps: null, connected_time: 0, ready: false }), '');
        assert.equal(proxy.pcTunnelTelemetryBadges({ ttfb_ms: 'bad', speed_kbps: -1, connected_time: NaN, ready: 'yes' }), '');

        await proxy.pcFetchNodes();
        assert.match(ui.activeDetailRows.innerHTML, /首包<\/span><span class="pc-status-value">120ms/);
        assert.match(ui.activeDetailRows.innerHTML, /吞吐<\/span><span class="pc-status-value">8\.4 Mbps/);
        assert.match(ui.activeDetailRows.innerHTML, /已连<\/span><span class="pc-status-value">2m 05s/);
        assert.match(ui.standbyDetailRows.innerHTML, /首包<\/span><span class="pc-status-value">0ms/);
        assert.match(ui.standbyDetailRows.innerHTML, /吞吐<\/span><span class="pc-status-value">840 kbps/);
        assert.match(ui.standbyDetailRows.innerHTML, /已连<\/span><span class="pc-status-value">5s/);
        assert.doesNotMatch(ui.activeDetailRows.innerHTML, /MB\/s|KB\/s|NaN|undefined/);
    } finally {
        env.cleanup();
    }
});

test('realtime notification failures do not block proxy writes', async () => {
    const switchBodies = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({ '0': 'JP', port: 7920, proxy: { listen_host: '127.0.0.1', public_listener: false } });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        window.kuiNotifyRealtime = () => { throw new Error('realtime offline'); };
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcSwitchIP('full');

        assert.equal(switchBodies.length, 1);
        assert.equal(switchBodies[0].switch_mode, 'full');
        assert.equal(env.alerts.some(message => message.includes('下发失败')), false);
    } finally {
        env.cleanup();
    }
});

test('a delayed config load cannot overwrite a newer target selection or clear its listener state', async () => {
    const firstLoad = deferred();
    const firstLoadStarted = deferred();
    let configRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    firstLoadStarted.resolve();
                    return firstLoad.promise;
                }
                return jsonResponse({
                    '0': 'US',
                    port: 8200,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();

        const staleLoad = proxy.pcLoadConfig();
        await firstLoadStarted.promise;
        target.value = '203.0.113.9';
        await proxy.pcLoadConfig();
        assert.equal(target.value, '203.0.113.9');
        assert.equal(country.value, 'US');
        assert.equal(port.value, 8200);
        assert.equal(listenHost.value, '127.0.0.1');

        firstLoad.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await staleLoad;

        assert.equal(target.value, '203.0.113.9');
        assert.equal(country.value, 'US');
        assert.equal(port.value, 8200);
        assert.equal(listenHost.value, '127.0.0.1');
    } finally {
        env.cleanup();
    }
});

test('a delayed config load cannot overwrite or clear manually edited fields', async () => {
    const refreshLoad = deferred();
    const refreshStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({ '0': 'JP', port: 7920, proxy: { listen_host: '172.17.0.1', public_listener: false } });
                }
                refreshStarted.resolve();
                return refreshLoad.promise;
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        await proxy.pcLoadConfig();
        const pendingLoad = proxy.pcLoadConfig();
        await refreshStarted.promise;
        target.value = '203.0.113.8';
        country.value = 'us';
        country.emit('input');
        port.value = '9001';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        refreshLoad.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await pendingLoad;

        assert.equal(country.value.toUpperCase(), 'US');
        assert.equal(port.value, '9001');
        assert.equal(listenHost.value, '127.0.0.1');

        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies[0], {
            ip: '203.0.113.8',
            '0': 'US',
            port: 9001,
            public_listener: false,
            listen_host: '127.0.0.1',
            switch_mode: 'hot',
        });
    } finally {
        env.cleanup();
    }
});

test('switching targets blocks save and switch until the destination config loads', async () => {
    const destinationLoad = deferred();
    const destinationLoadStarted = deferred();
    const writes = [];
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                if (url.includes('203.0.113.9')) {
                    destinationLoadStarted.resolve();
                    return destinationLoad.promise;
                }
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if ((url === '/api/proxy/switch' || url === '/api/proxy/config') && options.method === 'POST') {
                writes.push({ url, body: JSON.parse(options.body) });
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        listenHost.value = '*';
        listenHost.emit('input');

        target.value = '203.0.113.9';
        target.emit('change');
        const pendingLoad = proxy.pcLoadConfig();
        await destinationLoadStarted.promise;

        await proxy.pcSaveConfig();
        await proxy.pcSwitchIP('hot');

        assert.equal(writes.length, 0);
        assert.equal(env.alerts.filter(message => message.includes('配置尚未加载')).length, 2);

        destinationLoad.resolve(jsonResponse({
            '0': 'DE',
            port: 8200,
            proxy: { listen_host: '172.17.0.1', public_listener: false },
        }));
        await pendingLoad;

        assert.equal(country.value, 'DE');
        assert.equal(port.value, 8200);
        assert.equal(listenHost.value, '172.17.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');

        await proxy.pcSwitchIP('hot');
        assert.equal(writes.length, 1);
        assert.equal(writes[0].url, '/api/proxy/switch');
        assert.deepEqual(writes[0].body, {
            ip: '203.0.113.9',
            '0': 'DE',
            port: 8200,
            switch_mode: 'hot',
        });
    } finally {
        env.cleanup();
    }
});

test('starting a write invalidates an in-flight config load so the stale GET cannot discard its response', async () => {
    const refreshLoad = deferred();
    const refreshStarted = deferred();
    const switchResponse = deferred();
    const switchStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                refreshStarted.resolve();
                return refreshLoad.promise;
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                switchStarted.resolve();
                return switchResponse.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        await proxy.pcLoadConfig();
        country.value = 'us';
        country.emit('input');
        port.value = '9001';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        const pendingRefresh = proxy.pcLoadConfig();
        await refreshStarted.promise;
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        refreshLoad.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(country.value, 'US');
        assert.equal(port.value, '9001');
        assert.equal(listenHost.value, '127.0.0.1');

        switchResponse.resolve(jsonResponse({
            success: true,
            slot_map: { country: 'US', port: 9100, listen_host: '127.0.0.1', public_listener: false },
            proxy: { country: 'US', port: 9100, listen_host: '127.0.0.1', public_listener: false },
        }));
        await pendingSwitch;
        await pendingRefresh;

        assert.deepEqual(switchBodies, [{
            ip: '203.0.113.8',
            '0': 'US',
            port: 9001,
            public_listener: false,
            listen_host: '127.0.0.1',
            switch_mode: 'hot',
        }]);
        assert.equal(country.value, 'US');
        assert.equal(port.value, '9100');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');
        assert.equal(env.alerts.some(message => message.includes('实时下发到 1 台')), true);
    } finally {
        env.cleanup();
    }
});

test('a config load started during a write cannot overwrite the write response', async () => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const lateLoad = deferred();
    const lateLoadStarted = deferred();
    let configRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                lateLoadStarted.resolve();
                return lateLoad.promise;
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchStarted.resolve();
                return switchResponse.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        await proxy.pcLoadConfig();
        country.value = 'US';
        country.emit('input');
        port.value = '9001';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;
        const pendingLoad = proxy.pcLoadConfig();
        await lateLoadStarted.promise;

        lateLoad.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(country.value, 'US');
        assert.equal(port.value, '9001');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '1');

        switchResponse.resolve(jsonResponse({
            success: true,
            slot_map: { country: 'US', port: 9100, listen_host: '127.0.0.1', public_listener: false },
            proxy: { country: 'US', port: 9100, listen_host: '127.0.0.1', public_listener: false },
        }));
        await pendingSwitch;
        await pendingLoad;

        assert.equal(country.value, 'US');
        assert.equal(port.value, '9100');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');
        assert.equal(env.alerts.some(message => message.includes('实时下发到 1 台')), true);
    } finally {
        env.cleanup();
    }
});

test('a write finishing after a target change reloads the current selection automatically', async () => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const switchBodies = [];
    let configCalls = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configCalls += 1;
                return jsonResponse({
                    '0': configCalls === 1 ? 'JP' : 'DE',
                    port: configCalls === 1 ? 7920 : 8200,
                    proxy: {
                        listen_host: configCalls === 1 ? '127.0.0.1' : '172.17.0.1',
                        public_listener: false,
                    },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                if (switchBodies.length === 1) {
                    switchStarted.resolve();
                    return switchResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        target.value = '*';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        await proxy.pcLoadConfig();

        assert.equal(country.value, 'JP');
        assert.equal(port.value, 7920);
        assert.equal(listenHost.value, '127.0.0.1');

        switchResponse.resolve(jsonResponse({ success: true }));
        await pendingSwitch;

        assert.equal(country.value, 'DE');
        assert.equal(port.value, 8200);
        assert.equal(listenHost.value, '172.17.0.1');

        await proxy.pcSwitchIP('hot');
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), false);
        assert.deepEqual(switchBodies.slice(1).map(body => body.ip), [
            '203.0.113.8',
            '203.0.113.9',
        ]);
    } finally {
        env.cleanup();
    }
});

test('a delayed switch response cannot overwrite a newer target, edits or dirty listener state', async () => {
    const firstSwitch = deferred();
    const firstSwitchStarted = deferred();
    const switchBodies = [];
    let switchRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                if (url.includes('203.0.113.9')) {
                    return jsonResponse({
                        '0': 'DE',
                        port: 8200,
                        proxy: { listen_host: '172.17.0.1', public_listener: false },
                    });
                }
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchRound += 1;
                switchBodies.push(JSON.parse(options.body));
                if (switchRound === 1) {
                    firstSwitchStarted.resolve();
                    return firstSwitch.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const staleSwitch = proxy.pcSwitchIP('hot');
        await firstSwitchStarted.promise;

        target.value = '203.0.113.9';
        await proxy.pcLoadConfig();
        country.value = 'ca';
        country.emit('input');
        port.value = '9001';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        firstSwitch.resolve(jsonResponse({
            success: true,
            slot_map: { country: 'JP', port: 7777, listen_host: '', public_listener: true },
            proxy: { country: 'JP', port: 7777, listen_host: '', public_listener: true },
        }));
        await staleSwitch;

        assert.equal(target.value, '203.0.113.9');
        assert.equal(country.value.toUpperCase(), 'CA');
        assert.equal(port.value, '9001');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '1');

        await proxy.pcSwitchIP('full');
        assert.deepEqual(switchBodies[1], {
            ip: '203.0.113.9',
            '0': 'CA',
            port: 9001,
            public_listener: false,
            listen_host: '127.0.0.1',
            switch_mode: 'full',
        });
    } finally {
        env.cleanup();
    }
});

test('returning to A before its old switch settles reloads A port after the switch succeeds', { timeout: 5000 }, async () => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const firstAResponse = deferred();
    const firstAReloadStarted = deferred();
    const secondAReloadStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (url.includes('203.0.113.9')) {
                    return jsonResponse({
                        '0': 'DE',
                        port: 9301,
                        proxy: { listen_host: '172.17.0.1', public_listener: false },
                    });
                }
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 9300,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 3) {
                    firstAReloadStarted.resolve();
                    return firstAResponse.promise;
                }
                if (configRound === 4) secondAReloadStarted.resolve();
                return jsonResponse({
                    '0': 'JP',
                    port: 9300,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                if (switchBodies.length === 1) {
                    switchStarted.resolve();
                    return switchResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        target.value = '203.0.113.9';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        await proxy.pcLoadConfig();

        target.value = '203.0.113.8';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        const pendingAReload = proxy.pcLoadConfig();
        await firstAReloadStarted.promise;
        country.value = 'CA';
        country.emit('input');

        firstAResponse.resolve(jsonResponse({
            '0': 'JP',
            port: 9300,
            proxy: { listen_host: '127.0.0.1', public_listener: false },
        }));
        await pendingAReload;
        assert.equal(String(port.value), '9301');

        switchResponse.resolve(jsonResponse({ success: true }));
        await pendingSwitch;
        await secondAReloadStarted.promise;
        await delay(15);

        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9300');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');
        assert.equal(configRound, 4);

        await proxy.pcSwitchIP('hot');
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), false);
        assert.deepEqual(switchBodies[1], {
            ip: '203.0.113.8',
            '0': 'CA',
            port: 9300,
            switch_mode: 'hot',
        });
    } finally {
        env.cleanup();
    }
});

const runPostSwitchReloadFailure = async reloadFailure => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const firstAResponse = deferred();
    const firstAReloadStarted = deferred();
    const failedReloadStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (url.includes('203.0.113.9')) {
                    return jsonResponse({
                        '0': 'DE',
                        port: 9301,
                        proxy: { listen_host: '172.17.0.1', public_listener: false },
                    });
                }
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 9300,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 3) {
                    firstAReloadStarted.resolve();
                    return firstAResponse.promise;
                }
                if (configRound === 4) {
                    failedReloadStarted.resolve();
                    return reloadFailure === 'network'
                        ? Promise.reject(new TypeError('Failed to fetch'))
                        : jsonResponse({ error: 'temporary read failure' }, { ok: false, status: 503 });
                }
                return jsonResponse({
                    '0': 'JP',
                    port: 9300,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                if (switchBodies.length === 1) {
                    switchStarted.resolve();
                    return switchResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        target.value = '203.0.113.9';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        await proxy.pcLoadConfig();

        target.value = '203.0.113.8';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        const pendingAReload = proxy.pcLoadConfig();
        await firstAReloadStarted.promise;
        country.value = 'CA';
        country.emit('input');
        firstAResponse.resolve(jsonResponse({
            '0': 'JP',
            port: 9300,
            proxy: { listen_host: '127.0.0.1', public_listener: false },
        }));
        await pendingAReload;

        switchResponse.resolve(jsonResponse({ success: true }));
        await pendingSwitch;
        await failedReloadStarted.promise;
        await delay(15);

        assert.equal(env.alerts.some(message => message.includes('下发失败')), false);
        assert.equal(env.alerts.some(message => message.includes('实时下发到 1 台')), true);
        assert.match(env.alerts.join('\n'), new RegExp(reloadFailure === 'network' ? '读取.*失败|配置读取失败' : '读取.*失败|配置读取失败'));
        assert.equal(env.alerts.filter(message => message.includes('配置读取失败')).length, 1);
        assert.equal(country.value, 'CA');
        assert.equal(configRound, 4);
    } finally {
        env.cleanup();
    }
};

test('a post-switch config reload 503 keeps the switch success and reports a read failure', { timeout: 5000 }, async () => {
    await runPostSwitchReloadFailure('http');
});

test('a post-switch config reload network error keeps the switch success and reports a read failure', { timeout: 5000 }, async () => {
    await runPostSwitchReloadFailure('network');
});

test('the same failed deferred reload reports once across overlap recovery paths', { timeout: 5000 }, async () => {
    await runPostSwitchReloadFailure('http');
});

test('a post-save config reload failure keeps the save success and reports a read failure', { timeout: 5000 }, async () => {
    const saveResponse = deferred();
    const saveStarted = deferred();
    const reloadStarted = deferred();
    const saveBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 9300,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                reloadStarted.resolve();
                return jsonResponse({ error: 'temporary read failure' }, { ok: false, status: 503 });
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                saveBodies.push(JSON.parse(options.body));
                saveStarted.resolve();
                return saveResponse.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSave = proxy.pcSaveConfig();
        await saveStarted.promise;

        target.value = '*';
        target.emit('change');
        assert.equal(saveBodies.length, 1);

        saveResponse.resolve(jsonResponse({ success: true }));
        await pendingSave;
        await reloadStarted.promise;
        await delay(15);

        assert.equal(env.alerts.some(message => message.includes('下发失败')), false);
        assert.equal(env.alerts.some(message => message.includes('实时下发到 1 台')), true);
        assert.match(env.alerts.join('\n'), /配置读取失败/);
    } finally {
        env.cleanup();
    }
});

const runDeferredSaveReloadFailure = async reloadFailure => {
    const saveResponse = deferred();
    const saveStarted = deferred();
    const returnToAReload = deferred();
    const returnToAReloadStarted = deferred();
    const failedReloadStarted = deferred();
    const saveBodies = [];
    let configRound = 0;
    const failedReloadResponse = () => reloadFailure === 'network'
        ? Promise.reject(new TypeError('Failed to fetch'))
        : jsonResponse({ error: 'temporary read failure' }, { ok: false, status: 503 });
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 9300,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (url.includes('203.0.113.9')) {
                    return jsonResponse({
                        '0': 'DE',
                        port: 9301,
                        proxy: { listen_host: '172.17.0.1', public_listener: false },
                    });
                }
                if (configRound === 3) {
                    returnToAReloadStarted.resolve();
                    return returnToAReload.promise;
                }
                if (configRound === 4) {
                    failedReloadStarted.resolve();
                    return failedReloadResponse();
                }
                return jsonResponse({
                    '0': 'JP',
                    port: 9400,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                saveBodies.push(JSON.parse(options.body));
                saveStarted.resolve();
                return saveResponse.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSave = proxy.pcSaveConfig();
        await saveStarted.promise;

        target.value = '203.0.113.9';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        await proxy.pcLoadConfig();

        target.value = '203.0.113.8';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        const pendingAReload = proxy.pcLoadConfig();
        await returnToAReloadStarted.promise;
        country.value = 'CA';
        country.emit('input');

        saveResponse.resolve(jsonResponse({ success: true }));
        await pendingSave;
        assert.equal(env.alerts.some(message => message.includes('实时下发到 1 台')), true);
        assert.equal(env.alerts.some(message => message.includes('配置读取失败')), false);

        returnToAReload.resolve(failedReloadResponse());
        await pendingAReload;
        await failedReloadStarted.promise;
        await delay(15);

        assert.equal(env.alerts.some(message => message.includes('下发失败')), false);
        assert.match(env.alerts.join('\n'), /配置读取失败/);
        assert.equal(country.value, 'CA');
        assert.equal(saveBodies.length, 1);

        const bodyCountBeforeRetry = saveBodies.length;
        await proxy.pcLoadConfig();
        await proxy.pcSaveConfig();
        assert.equal(saveBodies.length, bodyCountBeforeRetry + 1);
        assert.equal(saveBodies[bodyCountBeforeRetry].ip, '203.0.113.8');
        assert.equal(saveBodies[bodyCountBeforeRetry].country, 'CA');
        assert.equal(saveBodies[bodyCountBeforeRetry]['0'], 'CA');
    } finally {
        env.cleanup();
    }
};

test('a deferred post-save config reload 503 reports the read failure', { timeout: 5000 }, async () => {
    await runDeferredSaveReloadFailure('http');
});

test('a deferred post-save config reload network error reports the read failure', { timeout: 5000 }, async () => {
    await runDeferredSaveReloadFailure('network');
});

const runFailedReloadAfterReturningToTarget = async reloadFailure => {
    const saveResponse = deferred();
    const saveStarted = deferred();
    const failedReload = deferred();
    const failedReloadStarted = deferred();
    const saveBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (url.includes('203.0.113.9')) {
                    return jsonResponse({
                        '0': 'DE',
                        port: 9301,
                        proxy: { listen_host: '172.17.0.1', public_listener: false },
                    });
                }
                if (configRound === 3) {
                    failedReloadStarted.resolve();
                    return failedReload.promise;
                }
                return jsonResponse({
                    '0': 'JP',
                    port: 9400,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                saveBodies.push(JSON.parse(options.body));
                saveStarted.resolve();
                return saveResponse.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        port.value = '9400';
        port.emit('input');
        const staleSave = proxy.pcSaveConfig();
        await saveStarted.promise;

        target.value = '203.0.113.9';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        await proxy.pcLoadConfig();

        target.value = '203.0.113.8';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        const pendingReturn = proxy.pcLoadConfig(true);
        await failedReloadStarted.promise;
        country.value = 'CA';
        country.emit('input');

        const writesBeforeRetry = saveBodies.length;
        await proxy.pcSaveConfig();
        assert.equal(saveBodies.length, writesBeforeRetry);
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), true);

        saveResponse.resolve(jsonResponse({ success: true }));
        await staleSave;
        failedReload.resolve(reloadFailure === 'network'
            ? Promise.reject(new TypeError('Failed to fetch'))
            : jsonResponse({ error: 'temporary read failure' }, { ok: false, status: 503 }));
        await pendingReturn.catch(error => error);
        await delay(20);

        assert.equal(saveBodies.length, writesBeforeRetry);
        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9400');

        await proxy.pcLoadConfig();
        await proxy.pcSaveConfig();
        assert.equal(saveBodies.length, writesBeforeRetry + 1);
        assert.equal(saveBodies.at(-1).ip, '203.0.113.8');
        assert.equal(saveBodies.at(-1).country, 'CA');
        assert.equal(saveBodies.at(-1).port, 9400);
    } finally {
        env.cleanup();
    }
};

test('a failed deferred reload after returning to A cannot submit the destination port', { timeout: 5000 }, async () => {
    const saveResponse = deferred();
    const saveStarted = deferred();
    const failedReload = deferred();
    const failedReloadStarted = deferred();
    const saveBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (url.includes('203.0.113.9')) {
                    return jsonResponse({
                        '0': 'DE',
                        port: 9301,
                        proxy: { listen_host: '172.17.0.1', public_listener: false },
                    });
                }
                if (configRound === 3) {
                    failedReloadStarted.resolve();
                    return failedReload.promise;
                }
                if (configRound === 4) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 9400,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                return jsonResponse({
                    '0': 'JP',
                    port: 9400,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                saveBodies.push(JSON.parse(options.body));
                saveStarted.resolve();
                return saveResponse.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        port.value = '9400';
        port.emit('input');
        const staleSave = proxy.pcSaveConfig();
        await saveStarted.promise;

        target.value = '203.0.113.9';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        await proxy.pcLoadConfig();

        target.value = '203.0.113.8';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        const pendingReturn = proxy.pcLoadConfig(true);
        await failedReloadStarted.promise;
        country.value = 'CA';
        country.emit('input');

        const writesBeforeRetry = saveBodies.length;
        assert.equal(writesBeforeRetry, 1);
        await proxy.pcSaveConfig();
        assert.equal(saveBodies.length, writesBeforeRetry);
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), true);
        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9301');

        saveResponse.resolve(jsonResponse({ success: true }));
        await staleSave;
        failedReload.resolve(jsonResponse({ error: 'temporary read failure' }, { ok: false, status: 503 }));
        await pendingReturn.catch(error => error);
        await delay(20);

        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), true);
        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9400');

        await proxy.pcLoadConfig();
        await proxy.pcSaveConfig();
        assert.equal(saveBodies.length, writesBeforeRetry + 1);
        assert.equal(saveBodies.at(-1).ip, '203.0.113.8');
        assert.equal(saveBodies.at(-1).country, 'CA');
        assert.equal(saveBodies.at(-1).port, 9400);
        assert.equal(String(port.value), '9400');
    } finally {
        env.cleanup();
    }
});

test('a failed 503 reload after returning to A preserves the edited country and reports once', { timeout: 5000 }, async () => {
    await runFailedReloadAfterReturningToTarget('http');
});

test('a failed network reload after returning to A preserves the edited country and reports once', { timeout: 5000 }, async () => {
    await runFailedReloadAfterReturningToTarget('network');
});

test('a save rejected with 400 during an overlapping switch cannot report success or keep loading forever', { timeout: 5000 }, async () => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const saveResponse = deferred();
    const saveStarted = deferred();
    const saveBodies = [];
    const configErrors = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    return jsonResponse({
                        '0': 'DE',
                        port: 7921,
                        proxy: { listen_host: '172.17.0.1', public_listener: false },
                    });
                }
                return jsonResponse({
                    '0': 'JP',
                    port: 9400,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchStarted.resolve();
                return switchResponse.promise;
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                saveBodies.push(JSON.parse(options.body));
                saveStarted.resolve();
                return saveResponse.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.9';
        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;
        target.value = '203.0.113.8';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        await proxy.pcLoadConfig();
        const pendingSave = proxy.pcSaveConfig();
        await saveStarted.promise;

        target.value = '*';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        country.value = 'CA';
        country.emit('input');
        port.value = '9400';
        port.emit('input');
        const pendingLoad = proxy.pcLoadConfig().catch(error => configErrors.push(error));
        await new Promise(resolve => setImmediate(resolve));

        saveResponse.resolve(jsonResponse({ error: 'invalid listen host' }, { ok: false, status: 400 }));
        await pendingSave;
        switchResponse.resolve(jsonResponse({ success: true }));
        await pendingSwitch;
        await pendingLoad;
        await delay(20);

        assert.equal(env.alerts.some(message => message.includes('策略及端口已实时下发到')), false);
        assert.equal(env.alerts.some(message => message.includes('下发失败')), true);
        assert.equal(country.value, 'CA');
        assert.equal(configErrors.length, 0);
    } finally {
        env.cleanup();
    }
});

test('a delayed saved-config response cannot overwrite a later form edit or clear dirty state', async () => {
    const firstSave = deferred();
    const saveStarted = deferred();
    const configBodies = [];
    let saveRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                saveRound += 1;
                configBodies.push(JSON.parse(options.body));
                if (saveRound === 1) {
                    saveStarted.resolve();
                    return firstSave.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        country.value = 'de';
        country.emit('input');
        port.value = '9001';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        const staleSave = proxy.pcSaveConfig();
        await saveStarted.promise;
        country.value = 'ca';
        country.emit('input');
        port.value = '9100';
        port.emit('input');

        firstSave.resolve(jsonResponse({
            success: true,
            slot_map: { country: 'DE', port: 9001, listen_host: '', public_listener: true },
            proxy: { country: 'DE', port: 9001, listen_host: '', public_listener: true },
        }));
        await staleSave;

        assert.equal(country.value.toUpperCase(), 'CA');
        assert.equal(port.value, '9100');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '1');
        assert.equal(env.alerts.filter(message => message.includes('实时下发')).length, 0);

        await proxy.pcSaveConfig();
        assert.equal(configBodies.length, 2);
        assert.equal(configBodies[1].country, 'CA');
        assert.equal(configBodies[1].port, 9100);
        assert.equal(configBodies[1].public_listener, false);
        assert.equal(configBodies[1].listen_host, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');
    } finally {
        env.cleanup();
    }
});

test('a Vue target change before its internal listener does not trigger a second load that overwrites edits', { timeout: 5000 }, async () => {
    const destinationResponse = deferred();
    const destinationStarted = deferred();
    let configRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    destinationStarted.resolve();
                    return destinationResponse.promise;
                }
                return jsonResponse({
                    '0': 'DE',
                    port: 8200,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();

        target.value = '203.0.113.9';
        proxy.pcInvalidateLoadedConfig();
        const pendingLoad = proxy.pcLoadConfig();
        await destinationStarted.promise;
        target.emit('change');

        country.value = 'CA';
        country.emit('input');
        listenHost.value = '*';
        listenHost.emit('input');

        destinationResponse.resolve(jsonResponse({
            '0': 'DE',
            port: 8200,
            proxy: { listen_host: '172.17.0.1', public_listener: false },
        }));
        await pendingLoad;
        await delay(30);

        assert.equal(configRound, 2);
        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '8200');
        assert.equal(listenHost.value, '*');
        assert.equal(listenHost.dataset.pcListenDirty, '1');
    } finally {
        env.cleanup();
    }
});

test('a late save response for the previous target cannot reload or overwrite the new target edits', { timeout: 5000 }, async () => {
    const saveResponse = deferred();
    const saveStarted = deferred();
    let configRound = 0;
    let saveRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                return jsonResponse({
                    '0': configRound === 1 ? 'JP' : 'DE',
                    port: configRound === 1 ? 7920 : 8200,
                    proxy: {
                        listen_host: configRound === 1 ? '127.0.0.1' : '172.17.0.1',
                        public_listener: false,
                    },
                });
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                saveRound += 1;
                if (saveRound === 1) {
                    saveStarted.resolve();
                    return saveResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSave = proxy.pcSaveConfig();
        await saveStarted.promise;

        target.value = '203.0.113.9';
        proxy.pcInvalidateLoadedConfig();
        const pendingLoad = proxy.pcLoadConfig();
        target.emit('change');
        await pendingLoad;
        country.value = 'CA';
        country.emit('input');
        port.value = '9300';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');
        const configsAfterDestinationLoad = configRound;

        saveResponse.resolve(jsonResponse({
            success: true,
            slot_map: { country: 'JP', port: 7920, listen_host: '', public_listener: true },
            proxy: { country: 'JP', port: 7920, listen_host: '', public_listener: true },
        }));
        await pendingSave;
        await delay(30);

        assert.equal(configRound, configsAfterDestinationLoad);
        assert.equal(target.value, '203.0.113.9');
        assert.equal(country.value, 'CA');
        assert.equal(port.value, '9300');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '1');
    } finally {
        env.cleanup();
    }
});

test('returning to a target before its old GET settles neither reloads nor overwrites later edits', { timeout: 5000 }, async () => {
    const firstLoad = deferred();
    const firstLoadStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    firstLoadStarted.resolve();
                    return firstLoad.promise;
                }
                if (url.includes('203.0.113.9')) {
                    return jsonResponse({
                        '0': 'DE',
                        port: 8200,
                        proxy: { listen_host: '172.17.0.1', public_listener: false },
                    });
                }
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        const staleLoad = proxy.pcLoadConfig();
        await firstLoadStarted.promise;
        target.value = '203.0.113.9';
        target.emit('change');
        await proxy.pcLoadConfig();
        const configsAfterB = configRound;
        target.value = '203.0.113.8';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        await proxy.pcLoadConfig();
        const configsAfterReturning = configRound;
        country.value = 'CA';
        country.emit('input');
        port.value = '9300';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        firstLoad.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await staleLoad;
        await delay(30);

        assert.equal(configsAfterB, 2);
        assert.equal(configsAfterReturning, 3);
        assert.equal(configRound, configsAfterReturning);
        assert.equal(country.value, 'CA');
        assert.equal(port.value, '9300');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '1');

        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies, [{
            ip: '203.0.113.8',
            '0': 'CA',
            port: 9300,
            public_listener: false,
            listen_host: '127.0.0.1',
            switch_mode: 'hot',
        }]);
    } finally {
        env.cleanup();
    }
});

test('an older target GET cannot overwrite a newer successful load', { timeout: 5000 }, async () => {
    const firstLoad = deferred();
    const firstLoadStarted = deferred();
    const secondLoad = deferred();
    const secondLoadStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    firstLoadStarted.resolve();
                    return firstLoad.promise;
                }
                if (configRound === 2) {
                    secondLoadStarted.resolve();
                    return secondLoad.promise;
                }
                return jsonResponse({
                    '0': 'CA',
                    port: 9911,
                    proxy: { listen_host: '172.20.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        const staleLoad = proxy.pcLoadConfig();
        await firstLoadStarted.promise;
        const newerLoad = proxy.pcLoadConfig(true);
        await secondLoadStarted.promise;
        secondLoad.resolve(jsonResponse({
            '0': 'CA',
            port: 9911,
            proxy: { listen_host: '172.20.0.1', public_listener: false },
        }));
        await newerLoad;
        assert.equal(String(port.value), '9911');
        assert.equal(listenHost.value, '172.20.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');

        firstLoad.resolve(jsonResponse({
            '0': 'JP',
            port: 8020,
            proxy: { listen_host: '127.0.0.1', public_listener: false },
        }));
        await staleLoad;
        await delay(30);

        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9911');
        assert.equal(listenHost.value, '172.20.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');
        assert.equal(configRound, 2);
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), false);

        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies, [{
            ip: '203.0.113.8',
            '0': 'CA',
            port: 9911,
            switch_mode: 'hot',
        }]);
    } finally {
        env.cleanup();
    }
});

test('batch switch retries only the failed target after a partial failure', async () => {
    const switchBodies = [];
    const attempts = new Map();
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                if (body.ip === '203.0.113.9' && attempt === 1) {
                    return jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
                }
                if (switchBodies.length <= 2) {
                    return jsonResponse({
                        success: true,
                        slot_map: { country: 'JP', port: 7777, listen_host: '', public_listener: true },
                        proxy: { country: 'JP', port: 7777, listen_host: '', public_listener: true },
                    });
                }
                return jsonResponse({
                    success: true,
                    slot_map: {
                        country: body['0'],
                        port: body.port,
                        listen_host: body.listen_host || '',
                        public_listener: body.public_listener === true,
                    },
                });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();
        country.value = 'us';
        country.emit('input');
        port.value = '9001';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        await proxy.pcSwitchIP('hot');

        assert.equal(country.value, 'US');
        assert.equal(port.value, '9001');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '1');
        assert.equal(env.alerts.some(message => message.includes('成功 1 台，失败 1 台')), true);

        await proxy.pcSwitchIP('hot');

        assert.equal(switchBodies.length, 3);
        assert.deepEqual(switchBodies.map(body => body.ip), [
            '203.0.113.8',
            '203.0.113.9',
            '203.0.113.9',
        ]);
        assert.ok(switchBodies.every(body =>
            body['0'] === 'US'
            && body.port === 9001
            && body.public_listener === false
            && body.listen_host === '127.0.0.1'));
        assert.equal(listenHost.dataset.pcListenDirty, '0');
    } finally {
        env.cleanup();
    }
});

test('repeated partial batch retries keep the original all-target signature', { timeout: 5000 }, async () => {
    const switchBodies = [];
    const attempts = new Map();
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
            { ip: '203.0.113.10', name: 'edge-c' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                const shouldFail = (body.ip === '203.0.113.9' && attempt === 1)
                    || (body.ip === '203.0.113.10' && attempt <= 2);
                if (shouldFail) {
                    return jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
                }
                return jsonResponse({
                    success: true,
                    slot_map: { country: body['0'], port: body.port, listen_host: '127.0.0.1', public_listener: false },
                    proxy: { country: body['0'], port: body.port, listen_host: '127.0.0.1', public_listener: false },
                });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();

        await proxy.pcSwitchIP('hot');
        await proxy.pcSwitchIP('hot');
        await proxy.pcSwitchIP('hot');

        await new Promise(resolve => setTimeout(resolve, 0));
        assert.deepEqual(switchBodies.map(body => body.ip), [
            '203.0.113.8',
            '203.0.113.9',
            '203.0.113.10',
            '203.0.113.9',
            '203.0.113.10',
            '203.0.113.10',
        ]);
    } finally {
        env.cleanup();
    }
});

test('target cards clear old exits and policy while switching after a cache reset', async () => {
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }, { ip: '203.0.113.9', name: 'edge-b' }],
        fetchImpl: async url => jsonResponse(url.includes('203.0.113.9')
            ? { '0': 'US', port: 9124, proxy: { listen_host: '172.18.0.1' } }
            : { '0': 'JP', port: 9123, proxy: { listen_host: '127.0.0.1' } }),
    });
    try {
        const ui = mountOverviewElements(env);
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);
        await proxy.pcLoadConfig();

        assert.equal(ui.policy.textContent, 'JP · :9123');
        assert.equal(ui.policySub.textContent, '监听 127.0.0.1');
        assert.equal(ui.exit.dataset.copyIp, '198.51.100.10');
        assert.equal(ui.standby.dataset.copyIp, '198.51.100.11');

        proxy.pcStopProxy();
        target.value = '203.0.113.9';
        target.emit('change');
        assert.equal(ui.target.textContent, 'edge-b');
        assert.equal(ui.policy.textContent, '等待配置同步');
        assert.equal(ui.policySub.textContent, '');
        assert.equal(ui.activeCopy.hidden, true);
        assert.equal(ui.standbyCopy.hidden, true);
        assert.equal(ui.activeDetails.hidden, true);
        assert.equal(ui.standbyDetails.hidden, true);
        assert.equal(proxy.pcCopyOverviewExit('active'), false);
        assert.equal(proxy.pcCopyOverviewExit('standby'), false);

        await proxy.pcLoadConfig();
        assert.equal(ui.policy.textContent, 'US · :9124');
        assert.equal(ui.policySub.textContent, '监听 172.18.0.1');
    } finally {
        env.cleanup();
    }
});

test('switching targets updates diagnostics and ignores the previous exit report', async () => {
    const firstResponse = deferred();
    const managed = [{ ip: '203.0.113.8', name: 'edge-a' }, { ip: '203.0.113.9', name: 'edge-b' }];
    const reports = managed.map((server, index) => ({
        ...server,
        logs: server.name,
        details: [{ active: true, ready: true, node_ip: '192.0.2.1', exit_ip: `198.51.100.${20 + index}` }],
    }));
    const result = jsonResponse({ geo: {}, isp: {} });
    const env = installEnvironment({
        servers: managed,
        fetchImpl: async url => {
            if (url.includes('/proxy/nodes')) return jsonResponse(reports);
            if (url.endsWith('198.51.100.20')) return firstResponse.promise;
            return result;
        },
    });
    try {
        const ui = mountOverviewElements(env);
        const target = env.addElement('slot-target-ip', 'select');
        const score = env.addElement('pc-native-score-container');
        const logs = env.addElement('pc-terminal-output');
        const proxy = await loadLegacyProxy();
        await proxy.pcFetchNodes();
        target.value = managed[1].ip;
        target.emit('change');
        await delay(0);
        assert.match(logs.innerHTML, /edge-b/);
        assert.match(score.innerHTML, /198\.51\.100\.21/);
        firstResponse.resolve(result);
        await delay(0);
        assert.doesNotMatch(score.innerHTML, /198\.51\.100\.20/);
        target.value = '*';
        target.emit('change');
        assert.equal(ui.scoreSection.style.display, 'none');
        assert.equal(await proxy.pcCopyLogs(), false);
    } finally {
        env.cleanup();
    }
});

test('returning to the same exit keeps its newest diagnostic report and clears it in batch mode', async () => {
    const firstReport = deferred();
    const managed = [{ ip: '203.0.113.8' }, { ip: '203.0.113.9' }];
    const exits = ['198.51.100.20', '198.51.100.21'];
    let firstExitRequests = 0;
    const env = installEnvironment({
        servers: managed,
        fetchImpl: async url => {
            if (url.includes('/proxy/nodes')) return jsonResponse(managed.map((server, index) => ({
                ...server, details: [{ active: true, ready: true, node_ip: '192.0.2.1', exit_ip: exits[index] }],
            })));
            if (url.endsWith(exits[0]) && ++firstExitRequests === 1) return firstReport.promise;
            return jsonResponse({ geo: {}, isp: { org: 'latest-report' } });
        },
    });
    try {
        const ui = mountOverviewElements(env);
        const target = env.addElement('slot-target-ip', 'select');
        const score = env.addElement('pc-native-score-container');
        const link = env.addElement('pc-ip-score-link', 'a');
        const proxy = await loadLegacyProxy();
        await proxy.pcFetchNodes();
        for (const server of [managed[1], managed[0]]) {
            target.value = server.ip;
            target.emit('change');
            await delay(0);
        }
        assert.equal(firstExitRequests, 2);
        firstReport.resolve(jsonResponse({ geo: {}, isp: { org: 'outdated-report' } }));
        await delay(0);
        assert.match(score.innerHTML, /latest-report/);
        assert.equal(link.href, `https://testisp.info/?ip=${exits[0]}`);
        target.value = '*';
        target.emit('change');
        assert.equal(ui.scoreSection.style.display, 'none');
        assert.equal(link.href, '#');
        assert.equal(link.onclick, null);
        assert.equal(score.innerHTML, '');
    } finally {
        env.cleanup();
    }
});

test('managed targets remain visible when all tunnel reports are missing', async () => {
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }, { ip: '203.0.113.9', name: 'edge-b' }],
        fetchImpl: async () => jsonResponse([]),
    });
    try {
        const ui = mountOverviewElements(env);
        const target = env.addElement('slot-target-ip', 'select');
        const proxy = await loadLegacyProxy();
        await proxy.pcFetchNodes();

        assert.equal(ui.target.textContent, 'edge-a');
        assert.match(ui.targetSub.innerHTML, /203\.0\.113\.8/);
        assert.match(ui.targetSub.innerHTML, /等待通道上报/);
        assert.equal(ui.activeStatus.textContent, '通道未上报');

        target.value = '*';
        target.emit('change');
        assert.equal(ui.target.textContent, '全部 VPS (2 台)');
        assert.equal(ui.channels.textContent, '0 / 2 双通道就绪');
        assert.equal(ui.activeStatus.textContent, '0 / 2 主通道就绪');
        assert.equal(ui.standbyStatus.textContent, '0 / 2 备用通道就绪');
        assert.equal(ui.hotBtn.disabled, true);
    } finally {
        env.cleanup();
    }
});

test('batch retry keeps hot switch button enabled for ready failed subset and shows retry count', async () => {
    const switchBodies = [];
    const attempts = new Map();
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([
                    {
                        ip: '203.0.113.8',
                        name: 'edge-a',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                            { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                        ]),
                        last_seen: Date.now(),
                    },
                    {
                        ip: '203.0.113.9',
                        name: 'edge-b',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.31' },
                            { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.32' },
                        ]),
                        last_seen: Date.now(),
                    },
                ]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                if (body.ip === '203.0.113.9' && attempt === 1) {
                    return jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        target.value = '*';
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);
        assert.equal(ui.hotBtn.textContent, '切换至备用');

        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies.map(body => body.ip), ['203.0.113.8', '203.0.113.9']);
        assert.equal(ui.hotBtn.disabled, false);
        assert.equal(ui.hotBtn.textContent, '重试失败目标 (1 台)');
        assert.match(ui.hotBtn.title, /重试 1 台失败目标/);

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_last_seen: Date.now() + 1000,
                proxy: {
                    details: [
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                    ],
                },
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);
        assert.equal(ui.hotBtn.textContent, '重试失败目标 (1 台)');
        assert.match(ui.hotBtn.title, /重试 1 台失败目标 · 切换至备用出口/);

        window.kuiRealtimeProxySnapshots['203.0.113.9'] = {
            ip: '203.0.113.9',
            proxy_last_seen: Date.now() + 2000,
            proxy: {
                details: [
                    { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.31' },
                    { tunnel: 'tun_backup', active: false, ready: false, country: 'US', port: 7920, node_ip: '' },
                ],
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);
        assert.equal(ui.hotBtn.textContent, '重试失败目标 (1 台)');
        assert.match(ui.hotBtn.title, /重试 1 台失败目标 · 备用通道未就绪/);

        window.kuiRealtimeProxySnapshots['203.0.113.9'] = {
            ip: '203.0.113.9',
            proxy_last_seen: Date.now() + 3000,
            proxy: {
                details: [
                    { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.31' },
                    { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.32' },
                ],
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);

        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies.map(body => body.ip), ['203.0.113.8', '203.0.113.9', '203.0.113.9']);
        assert.equal(ui.hotBtn.textContent, '切换至备用');
        assert.equal(ui.hotBtn.disabled, true);
    } finally {
        env.cleanup();
    }
});

test('backend normalized legacy report keeps interruption confirm and ready false without ip stays distinct from unreported', async () => {
    let round = 0;
    const switchBodies = [];
    const confirmations = [];
    const normalizedLegacy = apiTest.validateProxyReport({
        ip: '203.0.113.8',
        details: [
            { tunnel: 'tun_main', active: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
            { tunnel: 'tun_backup', active: false, country: 'US', port: 7920, node_ip: '198.51.100.22' },
        ],
    });
    const normalizedUnreadyEmptyIp = apiTest.validateProxyReport({
        ip: '203.0.113.8',
        details: [
            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
            { tunnel: 'tun_backup', active: false, ready: false, country: 'US', port: 7920, node_ip: '' },
        ],
    });
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                round += 1;
                const report = round === 1 ? normalizedUnreadyEmptyIp : normalizedLegacy;
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge-a',
                    details: JSON.stringify(report.details),
                    last_seen: Date.now() + round * 1000,
                }]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    const originalConfirm = globalThis.confirm;
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        target.value = '203.0.113.8';
        globalThis.confirm = message => {
            confirmations.push(message);
            return false;
        };
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcFetchNodes();
        assert.equal(ui.activeStatus.textContent, '主通道就绪');
        assert.equal(ui.standbyStatus.textContent, '备用通道未就绪');
        assert.equal(ui.channelsSub.textContent, '主通道就绪 · 备用通道未就绪');
        assert.equal(ui.hotBtn.disabled, true);

        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);
        assert.equal(confirmations.length, 0);

        const realNow = Date.now;
        Date.now = () => realNow() + 20000;
        try {
            await proxy.pcFetchNodes();
        } finally {
            Date.now = realNow;
        }
        assert.equal(ui.activeStatus.textContent, '主通道就绪（旧版）');
        assert.equal(ui.standbyStatus.textContent, '备用通道就绪（旧版）');
        assert.equal(ui.hotBtn.disabled, false);

        await proxy.pcSwitchIP('hot');
        assert.equal(confirmations.length, 1);
        assert.match(confirmations[0], /旧版/);
        assert.match(confirmations[0], /中断/);
        assert.equal(switchBodies.length, 0);

        globalThis.confirm = message => {
            confirmations.push(message);
            return true;
        };
        await proxy.pcSwitchIP('hot');
        assert.equal(confirmations.length, 2);
        assert.equal(switchBodies.length, 1);
        assert.equal(switchBodies[0].switch_mode, 'hot');
    } finally {
        globalThis.confirm = originalConfirm;
        env.cleanup();
    }
});

test('pcStopProxy disables hot switch button and blocks unsynced switches across stale fetches until resynced', async () => {
    const switchBodies = [];
    const confirmations = [];
    const toasts = [];
    let nodeFetchCount = 0;
    let releaseDeferredNodes = null;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                nodeFetchCount += 1;
                const payload = [{
                    ip: '203.0.113.8',
                    name: 'edge-a',
                    details: JSON.stringify([
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ]),
                    last_seen: Date.now() + nodeFetchCount * 1000,
                }];
                if (nodeFetchCount === 2) {
                    await new Promise(resolve => { releaseDeferredNodes = resolve; });
                }
                return jsonResponse(payload);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    const originalConfirm = globalThis.confirm;
    const realNow = Date.now;
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        target.value = '203.0.113.8';
        window.kuiShowToast = (text, tone) => toasts.push({ text, tone });
        globalThis.confirm = message => {
            confirmations.push(message);
            return true;
        };
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);

        Date.now = () => realNow() + 20000;
        const staleFetch = proxy.pcFetchNodes();
        await new Promise(resolve => setTimeout(resolve, 0));
        proxy.pcStopProxy();
        assert.equal(ui.hotBtn.disabled, true);
        assert.match(ui.hotBtn.title, /未同步/);

        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);
        assert.equal(confirmations.length, 0);
        assert.ok(toasts.some(item => item.text.includes('尚未同步')));

        releaseDeferredNodes?.();
        await staleFetch;
        assert.equal(ui.hotBtn.disabled, true);

        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);

        Date.now = () => realNow() + 40000;
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);

        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 1);
        assert.equal(switchBodies[0].switch_mode, 'hot');
    } finally {
        Date.now = realNow;
        globalThis.confirm = originalConfirm;
        env.cleanup();
    }
});

test('window.pcSwitchIP hot is blocked before first node sync even after pcLoadConfig', async () => {
    const switchBodies = [];
    const nodeCalls = [];
    const toasts = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                nodeCalls.push(url);
                return jsonResponse([]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        target.value = '203.0.113.8';
        window.kuiShowToast = (text, tone) => toasts.push({ text, tone });
        await loadLegacyProxy();

        await window.pcLoadConfig();
        await window.pcSwitchIP('hot');

        assert.equal(nodeCalls.length, 0);
        assert.equal(switchBodies.length, 0);
        assert.ok(toasts.some(item => item.text.includes('尚未同步')));
    } finally {
        env.cleanup();
    }
});

test('pcStopProxy clears pre-reconnect snapshots and pcFetchNodes ignores offline or stale realtime snapshots', async () => {
    let httpEmpty = false;
    const switchBodies = [];
    const toasts = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                if (httpEmpty) return jsonResponse([]);
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge-a',
                    details: JSON.stringify([
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ]),
                    last_seen: Date.now(),
                }]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        target.value = '203.0.113.8';
        window.kuiShowToast = (text, tone) => toasts.push({ text, tone });
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);

        const preReconnectSnapshot = {
            ip: '203.0.113.8',
            proxy_state: 'online',
            proxy_last_seen: Date.now(),
            proxy: {
                details: [
                    { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                    { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                ],
            },
        };
        window.kuiRealtimeProxySnapshots = { '203.0.113.8': preReconnectSnapshot };
        httpEmpty = true;

        proxy.pcStopProxy();
        assert.equal(ui.hotBtn.disabled, true);
        assert.equal(Object.keys(window.kuiRealtimeProxySnapshots).length, 0);

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'offline',
                proxy_last_seen: Date.now() - 31 * 60 * 1000,
                proxy: {
                    details: [
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ],
                },
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'online',
                proxy_last_seen: Date.now() - 31 * 60 * 1000,
                proxy: {
                    details: [
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ],
                },
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);

        window.kuiRealtimeProxySnapshots = { '203.0.113.8': preReconnectSnapshot };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'online',
                proxy_last_seen: Date.now(),
                proxy: {
                    details: [
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ],
                },
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 1);
        assert.ok(toasts.some(item => item.text.includes('备用通道未就绪')));
    } finally {
        env.cleanup();
    }
});

test('unready standby with ready false and empty ip is reported without becoming an exit', async () => {
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge-a',
                    details: JSON.stringify([
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: false, country: 'US', port: 7920, node_ip: '' },
                    ]),
                    last_seen: Date.now(),
                }]);
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'div');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        target.value = '203.0.113.8';
        const proxy = await loadLegacyProxy();

        await proxy.pcFetchNodes();

        assert.equal(ui.standbyStatus.textContent, '备用通道未就绪');
        assert.equal(ui.hotBtn.disabled, true);
        assert.equal(ui.exit.textContent, '198.51.100.21');
        assert.equal(ui.standby.textContent, '备用通道未就绪');
        assert.equal(ui.standby.dataset.copyIp, undefined);
        assert.equal(ui.standbyCopy.hidden, true);
        assert.equal(ui.standbyDetails.hidden, false);
        assert.match(ui.standbySub.innerHTML, /地区<\/span><span class="pc-status-value">US/);
        assert.match(ui.standbyDetailRows.innerHTML, /隧道<\/span><span class="pc-status-value">tun_backup/);
    } finally {
        env.cleanup();
    }
});

test('realtime online node turning offline revokes hot switch without leaking into HTTP cache', async () => {
    const switchBodies = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        target.value = '203.0.113.8';
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        proxy.pcStopProxy();

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'online',
                proxy_last_seen: Date.now(),
                proxy: {
                    details: [
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ],
                },
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'offline',
                proxy_disconnected_at: Date.now() + 1000,
                proxy_last_seen: Date.now(),
                proxy: {
                    details: [
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ],
                },
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);

        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);
    } finally {
        env.cleanup();
    }
});

test('newer realtime disconnect revokes older HTTP ready record while HTTP-only fallback still works', async () => {
    const now = Date.now();
    let httpLastSeen = now - 10_000;
    const switchBodies = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge-a',
                    details: JSON.stringify([
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ]),
                    last_seen: httpLastSeen,
                }]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    const realNow = Date.now;
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        target.value = '203.0.113.8';
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        proxy.pcStopProxy();

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'offline',
                updated_at: now,
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'offline',
                proxy_disconnected_at: now,
                updated_at: now,
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);

        proxy.pcStopProxy();
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'offline',
                proxy_disconnected_at: now,
            },
        };
        httpLastSeen = now + 20_000;
        Date.now = () => now + 25_000;
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 1);
    } finally {
        Date.now = realNow;
        env.cleanup();
    }
});

test('stale realtime event ignores older historical disconnect time and survives tab switch until newer sample or session reset', async () => {
    const now = Date.now();
    let httpLastSeen = now - 10_000;
    const switchBodies = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge-a',
                    details: JSON.stringify([
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ]),
                    last_seen: httpLastSeen,
                }]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    const realNow = Date.now;
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        target.value = '203.0.113.8';
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        proxy.pcStopProxy();

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'stale',
                proxy_disconnected_at: now - 60_000,
                updated_at: now,
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);

        proxy.pcStopProxy();
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);

        proxy.pcStopProxy({ resetSession: true });
        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'stale',
                proxy_disconnected_at: now - 60_000,
                updated_at: now - 60_000,
                proxy_heartbeat_at: now - 60_000,
                proxy_age: 60_000,
            },
        };
        proxy.pcStopProxy();
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);

        proxy.pcStopProxy({ resetSession: true });
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, false);
        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 1);
    } finally {
        Date.now = realNow;
        env.cleanup();
    }
});

test('pcFetchNodes consumes realtime offline and clears exits when the HTTP 15s refresh returns 503', async () => {
    const now = Date.now();
    let httpMode = 'ready';
    const switchBodies = [];
    const toasts = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                if (httpMode === '503') return jsonResponse({ error: 'temporary' }, { ok: false, status: 503 });
                if (httpMode === 'bad-json') return {
                    ok: true,
                    status: 200,
                    json: async () => { throw new SyntaxError('Unexpected token <'); },
                };
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge-a',
                    details: JSON.stringify([
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ]),
                    last_seen: now,
                }]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        target.value = '203.0.113.8';
        window.kuiShowToast = (text, tone) => toasts.push({ text, tone });
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcFetchNodes();
        assert.equal(ui.exit.textContent, '198.51.100.21');
        assert.equal(ui.activeCopy.hidden, false);
        assert.equal(ui.activeDetails.hidden, false);
        assert.equal(ui.hotBtn.disabled, false);

        httpMode = '503';
        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_state: 'offline',
                proxy_disconnected_at: now + 1000,
                proxy_last_seen: now,
                proxy: {
                    details: [
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ],
                },
            },
        };
        const realNow = Date.now;
        Date.now = () => now + 20_000;
        try {
            await proxy.pcFetchNodes();
        } finally {
            Date.now = realNow;
        }

        assert.equal(ui.exit.textContent, '主通道未就绪');
        assert.equal(ui.activeStatus.textContent, '通道未上报');
        assert.equal(ui.exit.dataset.copyIp, undefined);
        assert.equal(ui.standby.dataset.copyIp, undefined);
        assert.equal(ui.activeCopy.hidden, true);
        assert.equal(ui.standbyCopy.hidden, true);
        assert.equal(ui.activeDetails.hidden, true);
        assert.equal(ui.standbyDetails.hidden, true);
        assert.equal(ui.activeDetailRows.innerHTML, '');
        assert.equal(ui.standbyDetailRows.innerHTML, '');
        assert.equal(await proxy.pcCopyOverviewExit('active'), false);
        assert.equal(await proxy.pcCopyOverviewExit('standby'), false);
        assert.equal(ui.hotBtn.disabled, true);

        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);
        assert.ok(toasts.some(item => item.text.includes('备用通道未就绪') || item.text.includes('尚未同步')));
    } finally {
        env.cleanup();
    }
});

test('pcPopulateTargets consumes pcPreferredTargetIp when switching from servers page', async () => {
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.21', name: 'tokyo-1', egress_applied_mode: 'residential' },
            { ip: '203.0.113.22', name: 'osaka-2', egress_applied_mode: 'native' },
        ],
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        globalThis.window.pcPreferredTargetIp = '203.0.113.22';
        const proxy = await loadLegacyProxy();

        proxy.pcPopulateTargets();

        assert.equal(target.value, '203.0.113.22');
        assert.equal(globalThis.window.pcPreferredTargetIp, '');
    } finally {
        env.cleanup();
    }
});

test('country pool supports search filtering and collapsible toggle beyond 16 items', async () => {
    const countries = Array.from({ length: 20 }, (_, idx) => ({
        code: `C${String.fromCharCode(65 + idx)}`,
        nodes: idx + 1,
    }));
    const env = installEnvironment({
        fetchImpl: async (url) => {
            if (url.startsWith('/api/proxy/countries')) return jsonResponse(countries);
            return jsonResponse({});
        },
    });
    try {
        const list = env.addElement('countries-list', 'div');
        const toggle = env.addElement('pc-country-toggle', 'button');
        const count = env.addElement('pc-country-count', 'span');
        env.addElement('slot-cfg-0', 'input');
        const proxy = await loadLegacyProxy();

        await proxy.pcFetchCountries(false);
        assert.equal(toggle.style.display, 'inline-flex');
        assert.match(toggle.textContent, /展开全部 \(20\)/);
        assert.equal(count.textContent, '20 个地区');
        assert.equal((list.innerHTML.match(/data-country-code="/g) || []).length, 17);

        proxy.pcToggleCountriesExpanded();
        assert.equal(toggle.textContent, '收起地区');
        assert.equal((list.innerHTML.match(/data-country-code="/g) || []).length, 21);

        proxy.pcSetCountryFilter('CS');
        assert.equal(toggle.style.display, 'none');
        assert.equal(count.textContent, '匹配 1 / 20');
        assert.match(list.innerHTML, /data-country-code="CS"/);
    } finally {
        env.cleanup();
    }
});

test('log terminal supports warning filtering, scroll pause toggle, and clipboard copy', async () => {
    let copiedText = '';
    const toasts = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.31', name: 'node-log', egress_applied_mode: 'residential' }],
        fetchImpl: async (url) => {
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([{
                    ip: '203.0.113.31',
                    name: 'node-log',
                    last_seen: Date.now(),
                    details: JSON.stringify([{ slot: 0, active: true, country: 'JP', node_ip: '198.51.100.77', speed_mbps: 120 }]),
                    logs: 'INFO boot ok\nWARN standby warming\nERROR dial timeout',
                }]);
            }
            return jsonResponse({});
        },
    });
    const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            clipboard: {
                writeText: async (text) => { copiedText = text; },
            },
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        target.value = '203.0.113.31';
        env.addElement('pc-nodes-table', 'tbody');
        const terminal = env.addElement('pc-terminal-output', 'pre');
        const overviewTarget = env.addElement('pc-overview-target', 'div');
        env.addElement('pc-overview-target-sub', 'div');
        const overviewChannels = env.addElement('pc-overview-channels', 'div');
        env.addElement('pc-overview-channels-sub', 'div');
        const overviewExit = env.addElement('pc-overview-exit', 'div');
        env.addElement('pc-overview-exit-sub', 'div');
        const hotBtn = env.addElement('pc-hot-switch-btn', 'button');
        globalThis.window.kuiShowToast = (text, tone) => toasts.push({ text, tone });

        const proxy = await loadLegacyProxy();
        await proxy.pcFetchNodes();

        assert.equal(overviewTarget.textContent, 'node-log');
        assert.equal(overviewChannels.textContent, '1 / 2 通道');
        assert.equal(overviewExit.textContent, '198.51.100.77');
        assert.equal(hotBtn.classList.contains('is-standby-missing'), true);
        assert.match(terminal.innerHTML, /INFO boot ok/);

        proxy.pcSetLogFilter('warn');
        assert.doesNotMatch(terminal.innerHTML, /INFO boot ok/);
        assert.match(terminal.innerHTML, /WARN standby warming/);
        assert.match(terminal.innerHTML, /ERROR dial timeout/);

        assert.equal(proxy.pcToggleLogPause(), true);
        assert.equal(proxy.pcToggleLogPause(), false);

        const copied = await proxy.pcCopyLogs();
        assert.equal(copied, true);
        assert.equal(copiedText, 'INFO boot ok\nWARN standby warming\nERROR dial timeout');
        assert.ok(toasts.some(item => item.tone === 'success'));
    } finally {
        if (prevNavigator) Object.defineProperty(globalThis, 'navigator', prevNavigator);
        else delete globalThis.navigator;
        env.cleanup();
    }
});

test('pcTunnelTelemetryBadges renders residential/native labels and risk scores while keeping legacy details compatible', async () => {
    let currentServers = [{
        ip: '203.0.113.20',
        name: 'tokyo',
        last_seen: Date.now(),
        details: JSON.stringify([
            {
                tunnel: 'tun_main',
                country: 'JP',
                node_ip: '198.51.100.21',
                port: 7920,
                active: true,
                is_residential: true,
                is_native: true,
                fraud_score: 12,
                ipok_risk: 8,
                purity_source: 'ippure+ipok',
                asn_org: 'NTT "Corp" & Co',
                ttfb_ms: 110,
            },
            {
                tunnel: 'tun_backup',
                country: 'JP',
                node_ip: '198.51.100.22',
                port: 7920,
                active: false,
                is_residential: true,
                is_native: false,
                fraud_score: 38,
                purity_source: 'ippure',
            },
        ]),
    }];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.20', name: 'tokyo' }],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) return jsonResponse(currentServers);
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        target.value = '203.0.113.20';
        const attribution = env.addElement('pc-purity-attribution', 'div');
        attribution.style.display = 'none';
        window.kuiManagedServers = () => [{ ip: '203.0.113.20', name: 'tokyo' }];
        const proxy = await loadLegacyProxy();

        const datacenterBadges = proxy.pcTunnelTelemetryBadges({ is_residential: false, fraud_score: 70 });
        assert.match(datacenterBadges, /pc-tunnel-badge-purity/);
        assert.match(datacenterBadges, /机房 IP/);
        assert.match(datacenterBadges, /pc-tunnel-badge-risk/);
        assert.match(datacenterBadges, /IPPure 70/);
        assert.doesNotMatch(datacenterBadges, /IPOK/);
        assert.equal(proxy.pcTunnelTelemetryBadges({ tunnel: 'tun_legacy' }), '');

        await proxy.pcFetchNodes();
        assert.match(ui.exitSub.innerHTML, /IP 类型<\/span><span class="pc-status-value" title="NTT &quot;Corp&quot; &amp; Co">原生住宅/);
        assert.match(ui.standbySub.innerHTML, /IP 类型<\/span><span class="pc-status-value">广播住宅/);
        assert.match(ui.exitSub.innerHTML, /IPPure<\/span><span class="pc-status-value">12/);
        assert.match(ui.exitSub.innerHTML, /<a href="https:\/\/ipok\.io"[^>]*>IPOK<\/a><\/span><span class="pc-status-value">8/);
        assert.doesNotMatch(ui.exitSub.innerHTML, /IPOK \/ IPOK 5/);
        assert.match(ui.standbySub.innerHTML, /IPPure<\/span><span class="pc-status-value">38/);
        assert.match(ui.activeDetailRows.innerHTML, /端口<\/span><span class="pc-status-value">7920/);
        assert.doesNotMatch(ui.activeDetailRows.innerHTML, /198\.51\.100\.21/);
        assert.match(ui.standbyDetailRows.innerHTML, /隧道<\/span><span class="pc-status-value">tun_backup/);
        assert.equal(ui.activeCopy.hidden, false);
        assert.equal(ui.standbyCopy.hidden, false);
        assert.equal(attribution.style.display, '');

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.20': {
                ip: '203.0.113.20',
                proxy_last_seen: Date.now() + 1000,
                proxy: {
                    details: [
                        { tunnel: 'tun_main', country: 'JP', node_ip: '198.51.100.21', port: 7920, active: true },
                    ],
                },
            },
        };
        await proxy.pcFetchNodes();
        assert.equal(attribution.style.display, 'none');

        window.kuiRealtimeProxySnapshots = {};
        currentServers = [];
        const emptyProxy = await loadLegacyProxy();
        await emptyProxy.pcFetchNodes();
        assert.equal(attribution.style.display, 'none');
    } finally {
        env.cleanup();
    }
});

test('a refresh returning after the last overlapping write schedules a safe reload', { timeout: 5000 }, async () => {
    const refreshResponse = deferred();
    const refreshStarted = deferred();
    const switchResponse = deferred();
    const switchStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    let switchRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    refreshStarted.resolve();
                    return refreshResponse.promise;
                }
                return jsonResponse({
                    '0': 'CA',
                    port: 9300,
                    proxy: { listen_host: '172.18.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                switchRound += 1;
                if (switchRound === 1) {
                    switchStarted.resolve();
                    return switchResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();

        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;
        const pendingLoad = proxy.pcLoadConfig();
        await refreshStarted.promise;

        switchResponse.resolve(jsonResponse({ success: true }));
        await pendingSwitch;
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(configRound, 2);

        refreshResponse.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await pendingLoad;

        assert.equal(configRound, 3);
        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9300');
        assert.equal(listenHost.value, '172.18.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');

        await proxy.pcSwitchIP('full');
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), false);
        assert.deepEqual(switchBodies.slice(2).map(body => body.ip), [
            '203.0.113.8',
            '203.0.113.9',
        ]);
    } finally {
        env.cleanup();
    }
});

test('a deferred refresh reloads after the last overlapping switch fails', { timeout: 5000 }, async () => {
    const switchFailure = deferred();
    const switchStarted = deferred();
    let configRound = 0;
    let switchRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                return jsonResponse({
                    '0': 'FR',
                    port: 8400,
                    proxy: { listen_host: '172.19.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchRound += 1;
                if (switchRound === 1) {
                    switchStarted.resolve();
                    return switchFailure.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();

        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;
        await proxy.pcLoadConfig();
        assert.equal(configRound, 2);

        switchFailure.resolve(jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 }));
        await pendingSwitch;
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.equal(configRound, 3);
        assert.equal(country.value, 'FR');
        assert.equal(String(port.value), '8400');
        assert.equal(listenHost.value, '172.19.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');
    } finally {
        env.cleanup();
    }
});

test('the last overlapping switch and save reports a deferred config read failure', { timeout: 5000 }, async () => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const saveResponse = deferred();
    const saveStarted = deferred();
    const allReloadResponse = deferred();
    const allReloadStarted = deferred();
    const failedReloadStarted = deferred();
    const switchBodies = [];
    const saveBodies = [];
    let configRound = 0;
    const failedReloadResponse = () => jsonResponse(
        { error: 'temporary read failure' },
        { ok: false, status: 503 },
    );
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    return jsonResponse({
                        '0': 'DE',
                        port: 7921,
                        proxy: { listen_host: '172.17.0.1', public_listener: false },
                    });
                }
                if (configRound === 3) {
                    allReloadStarted.resolve();
                    return allReloadResponse.promise;
                }
                if (configRound === 4) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                failedReloadStarted.resolve();
                return failedReloadResponse();
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                switchStarted.resolve();
                return switchResponse.promise;
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                saveBodies.push(JSON.parse(options.body));
                saveStarted.resolve();
                return saveResponse.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        target.value = '203.0.113.9';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        await proxy.pcLoadConfig();

        const pendingSave = proxy.pcSaveConfig();
        await saveStarted.promise;

        target.value = '*';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        const pendingLoad = proxy.pcLoadConfig();
        await allReloadStarted.promise;
        country.value = 'CA';
        country.emit('input');
        port.value = '9400';
        port.emit('input');
        listenHost.value = '172.17.0.1';
        listenHost.emit('input');

        switchResponse.resolve(jsonResponse({ success: true }));
        await pendingSwitch;
        saveResponse.resolve(jsonResponse({ success: true }));
        await pendingSave;
        assert.equal(env.alerts.some(message => message.includes('热切换指令已实时下发到 1 台')), true);
        assert.equal(env.alerts.some(message => message.includes('实时下发到 1 台')), true);
        assert.equal(env.alerts.some(message => message.includes('配置读取失败')), false);

        allReloadResponse.resolve(failedReloadResponse());
        await pendingLoad;
        await failedReloadStarted.promise;
        await delay(20);

        assert.equal(env.alerts.some(message => message.includes('下发失败')), false);
        assert.equal(env.alerts.some(message => message.includes('配置读取失败')), true);
        assert.equal(country.value, 'CA');
        assert.equal(port.value, '9400');
        assert.equal(listenHost.value, '172.17.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '1');
        assert.equal(switchBodies.length, 1);
        assert.equal(saveBodies.length, 1);
    } finally {
        env.cleanup();
    }
});

test('a write finishing after selecting all VPS keeps the edited country and merges refreshed fields', { timeout: 5000 }, async () => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const refreshResponse = deferred();
    const refreshStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    let switchRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    refreshStarted.resolve();
                    return refreshResponse.promise;
                }
                return jsonResponse({
                    '0': 'JP',
                    port: 9300,
                    proxy: { listen_host: '172.18.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                switchRound += 1;
                if (switchRound === 1) {
                    switchStarted.resolve();
                    return switchResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        target.value = '*';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        country.value = 'CA';
        country.emit('input');
        const pendingLoad = proxy.pcLoadConfig();
        await refreshStarted.promise;
        const configsDuringWrite = configRound;
        assert.equal(configsDuringWrite, 2);

        refreshResponse.resolve(jsonResponse({
            '0': 'JP',
            port: 9300,
            proxy: { listen_host: '172.18.0.1', public_listener: false },
        }));
        await pendingLoad;
        await delay(20);
        assert.equal(String(port.value), '7920');

        switchResponse.resolve(jsonResponse({ success: true }));
        await pendingSwitch;
        await delay(20);

        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9300');
        assert.equal(listenHost.value, '172.18.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');
        assert.equal(configRound, 3);

        await proxy.pcSwitchIP('hot');
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), false);
        assert.deepEqual(switchBodies[1], {
            ip: '203.0.113.8',
            '0': 'CA',
            port: 9300,
            switch_mode: 'hot',
        });
    } finally {
        env.cleanup();
    }
});

test('a failed write followed by a config GET parse error still schedules one safe reload', { timeout: 5000 }, async () => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    let configRound = 0;
    let switchRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => { throw new SyntaxError('Unexpected token <'); },
                        text: async () => '<html>bad gateway</html>',
                    };
                }
                return jsonResponse({
                    '0': 'FR',
                    port: 8400,
                    proxy: { listen_host: '172.19.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchRound += 1;
                if (switchRound === 1) {
                    switchStarted.resolve();
                    return switchResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        target.value = '*';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        const pendingLoad = proxy.pcLoadConfig();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(env.fetchCalls.filter(call => call.url.startsWith('/api/proxy/config')).length, 2);

        switchResponse.resolve(jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 }));
        await pendingSwitch;
        await pendingLoad;
        await delay(20);

        assert.equal(configRound, 3);
        assert.equal(country.value, 'FR');
        assert.equal(String(port.value), '8400');
        assert.equal(listenHost.value, '172.19.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');

        await proxy.pcSwitchIP('hot');
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), false);
    } finally {
        env.cleanup();
    }
});

test('a failed write followed by a config GET network error still schedules one safe reload', { timeout: 5000 }, async () => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const reloadStarted = deferred();
    let configRound = 0;
    let switchRound = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    throw new TypeError('Failed to fetch');
                }
                if (configRound === 3) {
                    reloadStarted.resolve();
                    return jsonResponse({
                        '0': 'FR',
                        port: 8400,
                        proxy: { listen_host: '172.19.0.1', public_listener: false },
                    });
                }
                throw new Error('unexpected config reload');
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchRound += 1;
                if (switchRound === 1) {
                    switchStarted.resolve();
                    return switchResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        target.value = '*';
        target.emit('change');
        proxy.pcInvalidateLoadedConfig();
        const pendingLoad = proxy.pcLoadConfig();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(configRound, 2);

        switchResponse.resolve(jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 }));
        await pendingSwitch;
        await pendingLoad;
        await reloadStarted.promise;
        await delay(20);

        assert.equal(configRound, 3);
        assert.equal(country.value, 'FR');
        assert.equal(String(port.value), '8400');
        assert.equal(listenHost.value, '172.19.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');

        await proxy.pcSwitchIP('hot');
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), false);
    } finally {
        env.cleanup();
    }
});

test('a stale GET failing after its write finishes still reloads the current target', { timeout: 5000 }, async () => {
    const staleResponse = deferred();
    const staleStarted = deferred();
    const switchResponse = deferred();
    const switchStarted = deferred();
    let configRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    staleStarted.resolve();
                    return staleResponse.promise;
                }
                return jsonResponse({
                    '0': 'CA',
                    port: 9300,
                    proxy: { listen_host: '172.18.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchStarted.resolve();
                return switchResponse.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();

        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;
        const pendingRefresh = proxy.pcLoadConfig();
        await staleStarted.promise;

        switchResponse.resolve(jsonResponse({ success: true }));
        await pendingSwitch;

        staleResponse.resolve(jsonResponse({ error: 'stale response failed' }, { ok: false, status: 503 }));
        await pendingRefresh;

        assert.equal(configRound, 3);
        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9300');
        assert.equal(listenHost.value, '172.18.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');
    } finally {
        env.cleanup();
    }
});

test('overlapping refreshes coalesce into one reload after the last write settles', { timeout: 5000 }, async () => {
    const firstRefresh = deferred();
    const secondRefresh = deferred();
    const firstRefreshStarted = deferred();
    const secondRefreshStarted = deferred();
    const switchResponse = deferred();
    const switchStarted = deferred();
    let configRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    firstRefreshStarted.resolve();
                    return firstRefresh.promise;
                }
                if (configRound === 3) {
                    secondRefreshStarted.resolve();
                    return secondRefresh.promise;
                }
                return jsonResponse({
                    '0': 'CA',
                    port: 9300,
                    proxy: { listen_host: '172.18.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchStarted.resolve();
                return switchResponse.promise;
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();

        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;
        const firstPending = proxy.pcLoadConfig();
        await firstRefreshStarted.promise;
        const secondPending = proxy.pcLoadConfig();
        await secondRefreshStarted.promise;

        switchResponse.resolve(jsonResponse({ success: true }));
        await pendingSwitch;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(configRound, 3);

        firstRefresh.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await firstPending;
        assert.equal(configRound, 3);

        secondRefresh.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await secondPending;

        assert.equal(configRound, 4);
        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9300');
        assert.equal(listenHost.value, '172.18.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');
    } finally {
        env.cleanup();
    }
});

test('a deferred same-target refresh preserves later edits and dirty listener state', { timeout: 5000 }, async () => {
    const refreshResponse = deferred();
    const refreshStarted = deferred();
    const switchResponse = deferred();
    const switchStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (configRound === 2) {
                    refreshStarted.resolve();
                    return refreshResponse.promise;
                }
                return jsonResponse({
                    '0': 'DE',
                    port: 8200,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                if (switchBodies.length === 1) {
                    switchStarted.resolve();
                    return switchResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        const pendingLoad = proxy.pcLoadConfig();
        await refreshStarted.promise;
        refreshResponse.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await pendingLoad;

        country.value = 'CA';
        country.emit('input');
        port.value = '9100';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        switchResponse.resolve(jsonResponse({
            success: true,
            slot_map: { country: 'DE', port: 8200, listen_host: '172.17.0.1', public_listener: false },
            proxy: { country: 'DE', port: 8200, listen_host: '172.17.0.1', public_listener: false },
        }));
        await pendingSwitch;
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.equal(configRound, 2);
        assert.equal(country.value, 'CA');
        assert.equal(port.value, '9100');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '1');

        await proxy.pcSwitchIP('full');
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), false);
        assert.deepEqual(switchBodies[1], {
            ip: '203.0.113.8',
            '0': 'CA',
            port: 9100,
            public_listener: false,
            listen_host: '127.0.0.1',
            switch_mode: 'full',
        });
    } finally {
        env.cleanup();
    }
});

test('targets with an in-flight write reject duplicate submissions', async () => {
    const switchResponse = deferred();
    const switchStarted = deferred();
    const switchBodies = [];
    const configBodies = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                switchStarted.resolve();
                return switchResponse.promise;
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                configBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        await proxy.pcLoadConfig();
        const pendingSwitch = proxy.pcSwitchIP('hot');
        await switchStarted.promise;

        await proxy.pcSwitchIP('full');
        await proxy.pcSaveConfig();

        assert.equal(switchBodies.length, 1);
        assert.equal(configBodies.length, 0);
        assert.equal(env.alerts.filter(message => message.includes('正在执行写入')).length, 2);

        switchResponse.resolve(jsonResponse({ success: true }));
        await pendingSwitch;
    } finally {
        env.cleanup();
    }
});

test('an older batch response cannot clear a failed-target retry from a newer batch', async () => {
    const newerFailure = deferred();
    const newerFailureStarted = deferred();
    const switchBodies = [];
    const attempts = new Map();
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                if (attempt === 1) {
                    return jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
                }
                if (attempt === 2) {
                    newerFailureStarted.resolve();
                    return newerFailure.promise;
                }
                if (attempt === 3) {
                    return jsonResponse({ success: false, error: 'still failing' }, { ok: false, status: 503 });
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        country.value = 'US';
        country.emit('input');
        port.value = '9001';
        port.emit('input');

        await proxy.pcSwitchIP('hot');
        assert.equal(env.alerts.some(message => message.includes('成功 0 台')), false);

        country.value = 'CA';
        country.emit('input');
        port.value = '9100';
        port.emit('input');
        const pendingNewerBatch = proxy.pcSwitchIP('hot');
        await newerFailureStarted.promise;

        country.value = 'DE';
        country.emit('input');
        newerFailure.resolve(jsonResponse({ success: false, error: 'newer failure' }, { ok: false, status: 503 }));
        await pendingNewerBatch;

        country.value = 'CA';
        country.emit('input');
        port.value = '9100';
        port.emit('input');
        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies.map(body => body.ip), [
            '203.0.113.8',
            '203.0.113.8',
            '203.0.113.8',
        ]);
        assert.equal(switchBodies[1]['0'], 'CA');
        assert.equal(switchBodies[2]['0'], 'CA');
        assert.equal(switchBodies[2].port, 9100);
    } finally {
        env.cleanup();
    }
});

test('editing the form invalidates a failed-target retry and re-runs the current selection', async () => {
    const switchBodies = [];
    const attempts = new Map();
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                if (body.ip === '203.0.113.9' && attempt === 1) {
                    return jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();
        country.value = 'US';
        port.value = 9001;
        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies.map(body => body.ip), ['203.0.113.8', '203.0.113.9']);

        country.value = 'CA';
        country.emit('input');
        port.value = 9100;
        port.emit('input');
        await proxy.pcSwitchIP('hot');

        assert.deepEqual(switchBodies.map(body => body.ip), [
            '203.0.113.8',
            '203.0.113.9',
            '203.0.113.8',
            '203.0.113.9',
        ]);
        assert.ok(switchBodies.slice(2).every(body => body['0'] === 'CA' && body.port === 9100));
    } finally {
        env.cleanup();
    }
});

test('editing while a batch switch is in flight prevents a stale failed-target retry', async () => {
    const failedResponse = deferred();
    const failedStarted = deferred();
    const switchBodies = [];
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                if (body.ip === '203.0.113.9' && switchBodies.length === 2) {
                    failedStarted.resolve();
                    return failedResponse.promise;
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();
        country.value = 'US';
        country.emit('input');

        const pendingSwitch = proxy.pcSwitchIP('hot');
        await failedStarted.promise;
        country.value = 'CA';
        country.emit('input');
        failedResponse.resolve(jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 }));
        await pendingSwitch;

        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies.map(body => body.ip), [
            '203.0.113.8',
            '203.0.113.9',
            '203.0.113.8',
            '203.0.113.9',
        ]);
        assert.ok(switchBodies.slice(2).every(body => body['0'] === 'CA'));
    } finally {
        env.cleanup();
    }
});

test('switching targets away and back invalidates a failed-target retry', async () => {
    const switchBodies = [];
    const attempts = new Map();
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                if (body.ip === '203.0.113.9' && attempt === 1) {
                    return jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();
        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies.map(body => body.ip), ['203.0.113.8', '203.0.113.9']);

        target.value = '203.0.113.8';
        target.emit('change');
        await proxy.pcLoadConfig();
        target.value = '*';
        target.emit('change');
        await proxy.pcLoadConfig();
        await proxy.pcSwitchIP('hot');

        assert.deepEqual(switchBodies.map(body => body.ip), [
            '203.0.113.8',
            '203.0.113.9',
            '203.0.113.8',
            '203.0.113.9',
        ]);
    } finally {
        env.cleanup();
    }
});

test('changing the target set requires a fresh config load before writing', async () => {
    const switchBodies = [];
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();
        await env.syncReadyNodes(proxy);
        env.setManagedServers([
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
            { ip: '203.0.113.10', name: 'edge-c' },
        ]);

        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 0);
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), true);

        await proxy.pcLoadConfig();
        await env.syncReadyNodes(proxy);
        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies.map(body => body.ip), [
            '203.0.113.8',
            '203.0.113.9',
            '203.0.113.10',
        ]);
    } finally {
        env.cleanup();
    }
});

test('batch config save only clears dirty listener state after every target succeeds', async () => {
    const configBodies = [];
    const attempts = new Map();
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '172.17.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/config' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                configBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                if (body.ip === '203.0.113.9' && attempt === 1) {
                    return jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
                }
                if (configBodies.length <= 2) {
                    return jsonResponse({
                        success: true,
                        slot_map: { country: 'JP', port: 7777, listen_host: '', public_listener: true },
                        proxy: { country: 'JP', port: 7777, listen_host: '', public_listener: true },
                    });
                }
                return jsonResponse({
                    success: true,
                    slot_map: {
                        country: body.country,
                        port: body.port,
                        listen_host: body.listen_host || '',
                        public_listener: body.public_listener === true,
                    },
                });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();

        target.value = '*';
        await proxy.pcLoadConfig();
        country.value = 'us';
        country.emit('input');
        port.value = '9001';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        await proxy.pcSaveConfig();

        assert.equal(country.value, 'US');
        assert.equal(port.value, '9001');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '1');
        assert.equal(env.alerts.some(message => message.includes('成功 1 台，失败 1 台')), true);

        await proxy.pcSaveConfig();

        assert.equal(configBodies.length, 4);
        assert.ok(configBodies.every(body =>
            body.country === 'US'
            && body.port === 9001
            && body.public_listener === false
            && body.listen_host === '127.0.0.1'));
        assert.equal(listenHost.dataset.pcListenDirty, '0');
    } finally {
        env.cleanup();
    }
});

test('residential page preserves fixed DOM contracts and exposes hot and full switch actions', () => {
    for (const id of [
        'countries-list',
        'slot-target-ip',
        'slot-cfg-0',
        'slot-port',
        'slot-listen-host',
        'pc-nodes-table',
        'pc-ip-score-section',
        'pc-ip-score-link',
        'pc-native-score-container',
        'pc-terminal-output',
    ]) {
        assert.match(pageSource, new RegExp(`id="${id}"`));
    }
    assert.match(pageSource, /id="slot-cfg-0"[^>]*maxlength="3"/);
    assert.match(pageSource, /id="slot-listen-host"[^>]*maxlength="15"/);
    assert.match(pageSource, /id="slot-target-ip"[^>]*@change="pcInvalidateLoadedConfig\(\); pcLoadConfig\(\); pcFetchNodes\(\)"/);
    assert.match(pageSource, /@click="pcSwitchIP\('hot'\)"/);
    assert.match(pageSource, /@click="pcSwitchIP\('full'\)"/);
    assert.match(pageSource, /全量重拨/);
    for (const className of [
        'pc-body',
        'pc-page-intro',
        'pc-section-stack',
        'pc-country-panel',
        'pc-overview-grid',
        'pc-overview-card',
        'pc-status-list',
        'pc-score-panel',
        'pc-log-panel',
        'pc-country-list',
    ]) {
        assert.match(pageSource, new RegExp(className));
    }
    assert.match(pageSource, /id="pc-active-details"[^>]*hidden/);
    assert.match(pageSource, /id="pc-standby-details"[^>]*hidden/);
    assert.match(pageSource, /@click="pcCopyOverviewExit\('active'\)"/);
    assert.match(pageSource, /@click="pcCopyOverviewExit\('standby'\)"/);
});

const mountOverviewElements = env => ({
    target: env.addElement('pc-overview-target', 'div'),
    targetSub: env.addElement('pc-overview-target-sub', 'div'),
    policy: env.addElement('pc-overview-policy', 'strong'),
    policySub: env.addElement('pc-overview-policy-sub', 'div'),
    channels: env.addElement('pc-overview-channels', 'div'),
    channelsSub: env.addElement('pc-overview-channels-sub', 'div'),
    exit: env.addElement('pc-overview-exit', 'div'),
    exitSub: env.addElement('pc-overview-exit-sub', 'div'),
    activeStatus: env.addElement('pc-overview-active-status', 'span'),
    activeDetails: env.addElement('pc-active-details', 'details'),
    activeDetailRows: env.addElement('pc-active-detail-rows', 'div'),
    activeCopy: env.addElement('pc-active-copy', 'button'),
    standby: env.addElement('pc-overview-standby', 'div'),
    standbySub: env.addElement('pc-overview-standby-sub', 'div'),
    standbyStatus: env.addElement('pc-overview-standby-status', 'span'),
    standbyDetails: env.addElement('pc-standby-details', 'details'),
    standbyDetailRows: env.addElement('pc-standby-detail-rows', 'div'),
    standbyCopy: env.addElement('pc-standby-copy', 'button'),
    scoreSection: env.addElement('pc-ip-score-section', 'div'),
    hotBtn: env.addElement('pc-hot-switch-btn', 'button'),
});

test('overview renders distinct active and standby exits with quality and status tones', async () => {
    const activeDetails = [
        {
            tunnel: 'tun_main',
            active: true,
            ready: true,
            country: 'JP',
            port: 7920,
            node_ip: '198.51.100.21',
            is_residential: true,
            is_native: true,
            fraud_score: 12,
            ipok_risk: 8,
            purity_source: 'ippure+ipok',
        },
        {
            tunnel: 'tun_backup',
            active: false,
            ready: true,
            country: 'US',
            port: 7920,
            node_ip: '198.51.100.22',
            is_residential: true,
            is_native: false,
            fraud_score: 38,
            ipok_risk: 24,
            purity_source: 'ippure+ipok',
        },
    ];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge-a',
                    details: JSON.stringify(activeDetails),
                    last_seen: Date.now(),
                }]);
            }
            return jsonResponse({});
        },
    });
    const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const copied = [];
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
            clipboard: {
                writeText: async text => { copied.push(text); },
            },
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        env.addElement('slot-target-ip', 'select');
        window.kuiManagedServers = () => [{ ip: '203.0.113.8', name: 'edge-a' }];
        const proxy = await loadLegacyProxy();

        await proxy.pcFetchNodes();

        assert.equal(ui.exit.textContent, '198.51.100.21');
        assert.match(ui.exitSub.innerHTML, /地区<\/span><span class="pc-status-value">JP/);
        assert.match(ui.exitSub.innerHTML, /IP 类型<\/span><span class="pc-status-value">原生住宅/);
        assert.match(ui.exitSub.innerHTML, /IPPure<\/span><span class="pc-status-value">12/);
        assert.match(ui.exitSub.innerHTML, /<a href="https:\/\/ipok\.io"[^>]*>IPOK<\/a><\/span><span class="pc-status-value">8</);
        assert.equal(ui.activeStatus.dataset.tone, 'ready');
        assert.match(ui.activeStatus.textContent, /就绪/);
        assert.equal(ui.standby.textContent, '198.51.100.22');
        assert.match(ui.standbySub.innerHTML, /地区<\/span><span class="pc-status-value">US/);
        assert.match(ui.standbySub.innerHTML, /IP 类型<\/span><span class="pc-status-value">广播住宅/);
        assert.match(ui.standbySub.innerHTML, /IPPure<\/span><span class="pc-status-value">38/);
        assert.match(ui.standbySub.innerHTML, /<a href="https:\/\/ipok\.io"[^>]*>IPOK<\/a><\/span><span class="pc-status-value">24/);
        assert.equal(ui.standbyStatus.dataset.tone, 'ready');
        assert.match(ui.standbyStatus.textContent, /就绪/);
        assert.equal(ui.exit.dataset.copyIp, '198.51.100.21');
        assert.equal(ui.standby.dataset.copyIp, '198.51.100.22');
        assert.equal(ui.activeCopy.hidden, false);
        assert.equal(ui.standbyCopy.hidden, false);
        assert.equal(await proxy.pcCopyOverviewExit('active'), true);
        assert.equal(await proxy.pcCopyOverviewExit('standby'), true);
        assert.deepEqual(copied, ['198.51.100.21', '198.51.100.22']);
        assert.equal(ui.activeDetails.hidden, false);
        assert.equal(ui.standbyDetails.hidden, false);
        assert.match(ui.activeDetailRows.innerHTML, /隧道<\/span><span class="pc-status-value">tun_main/);
        assert.match(ui.activeDetailRows.innerHTML, /端口<\/span><span class="pc-status-value">7920/);
        assert.doesNotMatch(ui.activeDetailRows.innerHTML, /198\.51\.100\.21/);
        assert.match(ui.standbyDetailRows.innerHTML, /隧道<\/span><span class="pc-status-value">tun_backup/);
        assert.equal(ui.hotBtn.disabled, false);
    } finally {
        if (prevNavigator) Object.defineProperty(globalThis, 'navigator', prevNavigator);
        else delete globalThis.navigator;
        env.cleanup();
    }
});

test('overview never promotes a standby or another node into the active exit', async () => {
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([
                    {
                        ip: '203.0.113.8',
                        name: 'edge-a',
                        details: JSON.stringify([{
                            tunnel: 'tun_backup',
                            active: false,
                            ready: true,
                            country: 'US',
                            port: 7920,
                            node_ip: '198.51.100.22',
                            is_residential: true,
                        }]),
                        last_seen: Date.now(),
                    },
                    {
                        ip: '203.0.113.9',
                        name: 'edge-b',
                        details: JSON.stringify([{
                            tunnel: 'tun_main',
                            active: true,
                            ready: true,
                            country: 'JP',
                            port: 7920,
                            node_ip: '198.51.100.99',
                        }]),
                        last_seen: Date.now(),
                    },
                ]);
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        target.value = '203.0.113.8';
        window.kuiManagedServers = () => [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ];
        const proxy = await loadLegacyProxy();

        await proxy.pcFetchNodes();

        assert.equal(ui.target.textContent, 'edge-a');
        assert.equal(ui.exit.textContent, '主通道未就绪');
        assert.doesNotMatch(ui.exit.textContent, /198\.51\.100/);
        assert.equal(ui.activeStatus.dataset.tone, 'wait');
        assert.match(ui.activeStatus.textContent, /未就绪/);
        assert.equal(ui.exit.dataset.copyIp, undefined);
        assert.equal(ui.activeCopy.hidden, true);
        assert.equal(ui.activeDetails.hidden, true);
        assert.equal(ui.standby.textContent, '198.51.100.22');
        assert.equal(ui.standbyStatus.dataset.tone, 'ready');
        assert.equal(ui.standby.dataset.copyIp, '198.51.100.22');
        assert.equal(ui.standbyCopy.hidden, false);
        assert.equal(ui.hotBtn.disabled, false);

        target.value = '*';
        target.emit('change');
        await proxy.pcFetchNodes();

        assert.equal(ui.exit.textContent, '批量目标');
        assert.match(ui.exitSub.innerHTML, /共 2 台 · 1 台主通道就绪/);
        assert.doesNotMatch(ui.exit.textContent, /198\.51\.100/);
        assert.equal(ui.activeStatus.dataset.tone, 'neutral');
        assert.equal(ui.standby.textContent, '批量目标');
        assert.match(ui.standbySub.innerHTML, /共 2 台 · 1 台备用就绪/);
        assert.equal(ui.standbyStatus.dataset.tone, 'neutral');
        assert.equal(ui.exit.dataset.copyIp, undefined);
        assert.equal(ui.standby.dataset.copyIp, undefined);
        assert.equal(ui.activeCopy.hidden, true);
        assert.equal(ui.standbyCopy.hidden, true);
        assert.equal(ui.activeDetails.hidden, true);
        assert.equal(ui.standbyDetails.hidden, true);
        assert.equal(ui.activeDetailRows.innerHTML, '');
        assert.equal(ui.standbyDetailRows.innerHTML, '');
        assert.equal(ui.hotBtn.disabled, true);
    } finally {
        env.cleanup();
    }
});

test('overview distinguishes missing targets, missing payloads and legacy agents without inventing exits', async () => {
    let nodeRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) {
                nodeRound += 1;
                return jsonResponse(nodeRound === 1
                    ? [{
                        ip: '203.0.113.8',
                        name: 'edge-a',
                        details: '[]',
                        last_seen: Date.now(),
                    }]
                    : []);
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        target.value = '203.0.113.8';
        window.kuiManagedServers = () => [{ ip: '203.0.113.8', name: 'edge-a' }];
        const proxy = await loadLegacyProxy();

        await proxy.pcFetchNodes();

        assert.equal(ui.exit.textContent, '主通道未就绪');
        assert.equal(ui.activeStatus.dataset.tone, 'wait');
        assert.match(ui.activeStatus.textContent, /旧版 Agent|未上报/);
        assert.equal(ui.standby.textContent, '备用通道未就绪');
        assert.equal(ui.standbyStatus.dataset.tone, 'wait');
        assert.match(ui.activeStatus.textContent, /通道未上报/);
        assert.equal(ui.exit.dataset.copyIp, undefined);
        assert.equal(ui.standby.dataset.copyIp, undefined);
        assert.equal(ui.activeCopy.hidden, true);
        assert.equal(ui.standbyCopy.hidden, true);
        assert.equal(ui.hotBtn.disabled, true);
        assert.match(ui.hotBtn.title, /备用通道未就绪/);

        proxy.pcStopProxy();
        await proxy.pcFetchNodes();

        assert.equal(ui.target.textContent, 'edge-a');
        assert.equal(ui.exit.textContent, '主通道未就绪');
        assert.equal(ui.standby.textContent, '备用通道未就绪');
        assert.equal(ui.activeStatus.dataset.tone, 'wait');
        assert.equal(ui.standbyStatus.dataset.tone, 'wait');
        assert.equal(ui.activeCopy.hidden, true);
        assert.equal(ui.standbyCopy.hidden, true);
        assert.equal(ui.hotBtn.disabled, true);
    } finally {
        env.cleanup();
    }
});

test('hot switch is blocked when the selected target lacks a ready standby', async () => {
    const switchBodies = [];
    const toasts = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge-a',
                    details: JSON.stringify([{
                        tunnel: 'tun_main',
                        active: true,
                        ready: true,
                        country: 'JP',
                        port: 7920,
                        node_ip: '198.51.100.21',
                    }]),
                    last_seen: Date.now(),
                }]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        window.kuiManagedServers = () => [{ ip: '203.0.113.8', name: 'edge-a' }];
        window.kuiShowToast = (text, tone) => toasts.push({ text, tone });
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcFetchNodes();
        assert.equal(ui.hotBtn.disabled, true);

        await proxy.pcSwitchIP('hot');

        assert.equal(switchBodies.length, 0);
        assert.ok(toasts.some(item => item.text.includes('备用通道未就绪')));
    } finally {
        env.cleanup();
    }
});

test('full redial confirmation states that existing connections may be interrupted', async () => {
    const confirmations = [];
    const switchBodies = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        globalThis.confirm = message => {
            confirmations.push(String(message));
            return true;
        };
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcSwitchIP('full');

        assert.equal(switchBodies.length, 1);
        assert.match(confirmations[0], /全量重拨/);
        assert.match(confirmations[0], /中断/);
        assert.match(confirmations[0], /新连接/);
    } finally {
        env.cleanup();
    }
});

test('batch overview and hot guard use only managed targets with reported standby readiness', async () => {
    const switchBodies = [];
    const toasts = [];
    const managed = [
        { ip: '203.0.113.8', name: 'edge-a' },
        { ip: '203.0.113.9', name: 'edge-b' },
        { ip: '203.0.113.10', name: 'edge-unreported' },
    ];
    const env = installEnvironment({
        servers: [
            ...managed,
            { ip: '203.0.113.99', name: 'edge-outside-target' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([
                    {
                        ip: '203.0.113.8',
                        name: 'edge-a',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                            { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                        ]),
                        last_seen: Date.now(),
                    },
                    {
                        ip: '203.0.113.9',
                        name: 'edge-b',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.31' },
                        ]),
                        last_seen: Date.now(),
                    },
                    {
                        ip: '203.0.113.99',
                        name: 'edge-outside-target',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.99' },
                            { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.98' },
                        ]),
                        last_seen: Date.now(),
                    },
                ]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        env.setManagedServers(managed);
        window.kuiShowToast = (text, tone) => toasts.push({ text, tone });
        target.value = '*';
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcFetchNodes();

        assert.equal(ui.target.textContent, '全部 VPS (3 台)');
        assert.equal(ui.exit.textContent, '批量目标');
        assert.match(ui.exitSub.innerHTML, /共 3 台 · 2 台主通道就绪/);
        assert.equal(ui.activeStatus.dataset.tone, 'neutral');
        assert.equal(ui.standby.textContent, '批量目标');
        assert.match(ui.standbySub.innerHTML, /共 3 台 · 1 台备用就绪/);
        assert.equal(ui.standbyStatus.dataset.tone, 'neutral');
        assert.match(ui.targetSub.innerHTML, /范围<\/span><span class="pc-status-value">全部纳管 VPS/);
        assert.match(ui.targetSub.innerHTML, /目标<\/span><span class="pc-status-value">3 台/);
        assert.match(ui.targetSub.innerHTML, /节点策略<\/span><span class="pc-status-value">批量按各节点上报统计/);
        assert.equal(ui.exit.dataset.copyIp, undefined);
        assert.equal(ui.standby.dataset.copyIp, undefined);
        assert.equal(ui.activeCopy.hidden, true);
        assert.equal(ui.standbyCopy.hidden, true);
        assert.equal(ui.activeDetails.hidden, true);
        assert.equal(ui.standbyDetails.hidden, true);
        assert.equal(ui.channels.textContent, '1 / 3 双通道就绪');
        assert.equal(ui.channelsSub.textContent, '主通道 2/3 · 备用通道 1/3');
        assert.equal(ui.hotBtn.disabled, true);
        assert.match(ui.hotBtn.title, /备用通道未就绪/);

        await proxy.pcSwitchIP('hot');

        assert.equal(switchBodies.length, 0);
        assert.ok(toasts.some(item => item.text.includes('备用通道未就绪')));
    } finally {
        env.cleanup();
    }
});

test('batch retry hot guard checks only the failed target subset', async () => {
    const switchBodies = [];
    const attempts = new Map();
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([
                    {
                        ip: '203.0.113.8',
                        name: 'edge-a',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                            { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                        ]),
                        last_seen: Date.now(),
                    },
                    {
                        ip: '203.0.113.9',
                        name: 'edge-b',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.31' },
                            { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.32' },
                        ]),
                        last_seen: Date.now(),
                    },
                ]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                if (body.ip === '203.0.113.9' && attempt === 1) {
                    return jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const target = document.getElementById('slot-target-ip');
        target.value = '*';
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcFetchNodes();
        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies.map(body => body.ip), ['203.0.113.8', '203.0.113.9']);

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.8': {
                ip: '203.0.113.8',
                proxy_last_seen: Date.now() + 1000,
                proxy: {
                    details: [
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                    ],
                },
            },
        };
        await proxy.pcFetchNodes();

        await proxy.pcSwitchIP('hot');

        assert.deepEqual(switchBodies.map(body => body.ip), ['203.0.113.8', '203.0.113.9', '203.0.113.9']);
    } finally {
        env.cleanup();
    }
});

test('batch retry hot guard blocks a retry target without a ready standby', async () => {
    const switchBodies = [];
    const toasts = [];
    const attempts = new Map();
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([
                    {
                        ip: '203.0.113.8',
                        name: 'edge-a',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                            { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                        ]),
                        last_seen: Date.now(),
                    },
                    {
                        ip: '203.0.113.9',
                        name: 'edge-b',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.31' },
                            { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.32' },
                        ]),
                        last_seen: Date.now(),
                    },
                ]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                if (body.ip === '203.0.113.9' && attempt === 1) {
                    return jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const target = document.getElementById('slot-target-ip');
        target.value = '*';
        window.kuiShowToast = (text, tone) => toasts.push({ text, tone });
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcFetchNodes();
        await proxy.pcSwitchIP('hot');
        assert.deepEqual(switchBodies.map(body => body.ip), ['203.0.113.8', '203.0.113.9']);

        window.kuiRealtimeProxySnapshots = {
            '203.0.113.9': {
                ip: '203.0.113.9',
                proxy_last_seen: Date.now() + 1000,
                proxy: {
                    details: [
                        { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.31' },
                    ],
                },
            },
        };
        await proxy.pcFetchNodes();

        await proxy.pcSwitchIP('hot');

        assert.deepEqual(switchBodies.map(body => body.ip), ['203.0.113.8', '203.0.113.9']);
        assert.ok(toasts.some(item => item.text.includes('备用通道未就绪')));
    } finally {
        env.cleanup();
    }
});

test('explicit ready false differs from legacy agents and legacy hot switch asks before interrupting connections', async () => {
    let nodeRound = 0;
    const switchBodies = [];
    const confirmations = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url.startsWith('/api/proxy/nodes')) {
                nodeRound += 1;
                const details = nodeRound === 1
                    ? [
                        { tunnel: 'tun_main', active: true, ready: false, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, ready: false, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ]
                    : [
                        { tunnel: 'tun_main', active: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                        { tunnel: 'tun_backup', active: false, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                    ];
                return jsonResponse([{
                    ip: '203.0.113.8',
                    name: 'edge-a',
                    details: JSON.stringify(details),
                    last_seen: Date.now(),
                }]);
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        target.value = '203.0.113.8';
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcFetchNodes();

        assert.equal(ui.activeStatus.dataset.tone, 'wait');
        assert.equal(ui.standbyStatus.dataset.tone, 'wait');
        assert.equal(ui.hotBtn.disabled, true);
        assert.doesNotMatch(ui.activeStatus.textContent, /旧版/);
        assert.doesNotMatch(ui.standbyStatus.textContent, /旧版/);

        proxy.pcStopProxy();
        await proxy.pcFetchNodes();

        assert.equal(ui.exit.textContent, '198.51.100.21');
        assert.equal(ui.standby.textContent, '198.51.100.22');
        assert.equal(ui.activeStatus.dataset.tone, 'ready');
        assert.equal(ui.standbyStatus.dataset.tone, 'ready');
        assert.match(ui.activeStatus.textContent, /主通道就绪（旧版）/);
        assert.match(ui.standbyStatus.textContent, /备用通道就绪（旧版）/);
        assert.equal(ui.hotBtn.disabled, false);

        globalThis.confirm = message => {
            confirmations.push(String(message));
            return false;
        };
        await proxy.pcSwitchIP('hot');

        assert.equal(switchBodies.length, 0);
        assert.match(confirmations[0], /旧版 Agent/);
        assert.match(confirmations[0], /回退重拨/);
        assert.match(confirmations[0], /中断/);
    } finally {
        env.cleanup();
    }
});

test('cancelling full redial confirmation sends no switch request', async () => {
    const switchBodies = [];
    const confirmations = [];
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge-a' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        globalThis.confirm = message => {
            confirmations.push(String(message));
            return false;
        };
        const proxy = await loadLegacyProxy();

        await proxy.pcLoadConfig();
        await proxy.pcSwitchIP('full');

        assert.equal(switchBodies.length, 0);
        assert.match(confirmations[0], /全量重拨/);
        assert.match(confirmations[0], /中断/);
        assert.match(confirmations[0], /新连接/);
    } finally {
        env.cleanup();
    }
});

test('switching the target reuses cached node snapshots for the overview and hot button', async () => {
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async url => {
            if (url.startsWith('/api/proxy/nodes')) {
                return jsonResponse([
                    {
                        ip: '203.0.113.8',
                        name: 'edge-a',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.21' },
                            { tunnel: 'tun_backup', active: false, ready: true, country: 'US', port: 7920, node_ip: '198.51.100.22' },
                        ]),
                        last_seen: Date.now(),
                    },
                    {
                        ip: '203.0.113.9',
                        name: 'edge-b',
                        details: JSON.stringify([
                            { tunnel: 'tun_main', active: true, ready: true, country: 'JP', port: 7920, node_ip: '198.51.100.31' },
                        ]),
                        last_seen: Date.now(),
                    },
                ]);
            }
            return jsonResponse({});
        },
    });
    try {
        const ui = mountOverviewElements(env);
        env.addElement('pc-nodes-table', 'tbody');
        env.addElement('pc-terminal-output');
        const target = env.addElement('slot-target-ip', 'select');
        target.value = '203.0.113.8';
        const proxy = await loadLegacyProxy();

        await proxy.pcFetchNodes();
        assert.equal(ui.target.textContent, 'edge-a');
        assert.equal(ui.hotBtn.disabled, false);

        target.value = '203.0.113.9';
        target.emit('change');

        assert.equal(ui.target.textContent, 'edge-b');
        assert.equal(ui.exit.textContent, '198.51.100.31');
        assert.equal(ui.standby.textContent, '备用通道未就绪');
        assert.equal(ui.standbyStatus.dataset.tone, 'wait');
        assert.equal(ui.hotBtn.disabled, true);
    } finally {
        env.cleanup();
    }
});

test('state-layer proxy writes notify realtime and keep switch mode backward compatible', () => {
    assert.match(stateSource, /onMutation: targetIp => notifyRealtime\(targetIp\)/);
    assert.match(stateSource, /const switchProxyIP = async \(switchMode = 'hot'\) =>/);
    assert.match(stateSource, /switch_mode: mode/);

    const toggleBlock = stateSource.slice(
        stateSource.indexOf('const toggleNodeProxy'),
        stateSource.indexOf('const saveProxyConfig'),
    );
    const saveBlock = stateSource.slice(
        stateSource.indexOf('const saveProxyConfig'),
        stateSource.indexOf('const setProxyPublicListener'),
    );
    const listenerBlock = stateSource.slice(
        stateSource.indexOf('const setProxyPublicListener'),
        stateSource.indexOf('const switchProxyIP'),
    );
    const switchBlock = stateSource.slice(
        stateSource.indexOf('const switchProxyIP'),
        stateSource.indexOf('const sendWarpOptimizerCommand'),
    );
    assert.match(toggleBlock, /await fetchApi\('\/api\/proxy\/config'[\s\S]*notifyRealtime\(ip\)/);
    assert.match(saveBlock, /Promise\.allSettled\(targets\.map\(ip =>[\s\S]*fetchApi\('\/api\/proxy\/config'/);
    assert.match(saveBlock, /Promise\.allSettled\(succeeded\.map\(ip => notifyRealtime\(ip\)\)\)/);
    assert.match(saveBlock, /if \(failed\.length\)[\s\S]*return;[\s\S]*loadProxyPool\(\)/);
    assert.match(listenerBlock, /const result = await response\.json\(\);[\s\S]*notifyRealtime\(vps\.ip\)/);
    assert.match(switchBlock, /await fetchApi\('\/api\/proxy\/switch'[\s\S]*notifyRealtime\(proxyConfig\.ip\)/);
    assert.doesNotMatch(switchBlock, /\/api\/proxy\/config/);
    assert.match(switchBlock, /'0': country/);
    assert.match(switchBlock, /port/);
    assert.match(switchBlock, /switch_mode: mode/);
    assert.doesNotMatch(switchBlock, /mesh/);

    const switchBodyBlock = switchBlock.slice(
        switchBlock.indexOf("await fetchApi('/api/proxy/switch'"),
        switchBlock.indexOf('loadProxyPool()'),
    );
    assert.doesNotMatch(switchBodyBlock, /public_listener|listen_host/);
});

test('state-layer batch config saves notify all successes but keep failures visible', () => {
    const saveBlock = stateSource.slice(
        stateSource.indexOf('const saveProxyConfig'),
        stateSource.indexOf('const setProxyPublicListener'),
    );
    assert.match(saveBlock, /const succeeded = \[\];/);
    assert.match(saveBlock, /const failed = \[\];/);
    assert.match(saveBlock, /if \(succeeded\.length === 0\)/);
    assert.match(saveBlock, /await Promise\.allSettled\(succeeded\.map\(ip => notifyRealtime\(ip\)\)\)/);
    assert.match(saveBlock, /成功 \$\{succeeded\.length\} 台，失败 \$\{failed\.length\} 台/);
});

test('notifyRealtime reports non-2xx responses as failures', () => {
    const notifyBlock = stateSource.slice(
        stateSource.indexOf('const realtimeNotifyScheduled'),
        stateSource.indexOf('window.kuiNotifyRealtime = notifyRealtime'),
    );
    assert.match(notifyBlock, /const response = await fetch\(/);
    assert.match(notifyBlock, /return response\.ok;/);
});

test('a GET started before a completed write never rolls back the saved configuration', { timeout: 5000 }, async () => {
    const refreshResponse = deferred();
    const refreshStarted = deferred();
    const switchBodies = [];
    let configRound = 0;
    const env = installEnvironment({
        servers: [{ ip: '203.0.113.8', name: 'edge' }],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                configRound += 1;
                if (configRound === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                refreshStarted.resolve();
                return refreshResponse.promise;
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({
                    success: true,
                    slot_map: { country: 'CA', port: 9300, listen_host: '127.0.0.1', public_listener: false },
                    proxy: { country: 'CA', port: 9300, listen_host: '127.0.0.1', public_listener: false },
                });
            }
            return jsonResponse({});
        },
    });
    try {
        env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        await proxy.pcLoadConfig();
        country.value = 'CA';
        country.emit('input');
        port.value = '9300';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        const pendingLoad = proxy.pcLoadConfig();
        await refreshStarted.promise;
        await new Promise(resolve => setImmediate(resolve));

        await proxy.pcSwitchIP('hot');
        assert.equal(switchBodies.length, 1);
        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9300');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');

        refreshResponse.resolve(jsonResponse({
            '0': 'JP',
            port: 7920,
            proxy: { listen_host: '', public_listener: true },
        }));
        await pendingLoad;
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '9300');
        assert.equal(listenHost.value, '127.0.0.1');
        assert.equal(listenHost.dataset.pcListenDirty, '0');
        assert.deepEqual(switchBodies, [{
            ip: '203.0.113.8',
            '0': 'CA',
            port: 9300,
            public_listener: false,
            listen_host: '127.0.0.1',
            switch_mode: 'hot',
        }]);
    } finally {
        env.cleanup();
    }
});

test('a new target cannot submit country edits with the previous target port before loading', { timeout: 5000 }, async () => {
    const destinationLoad = deferred();
    const destinationStarted = deferred();
    const switchBodies = [];
    const configBodies = [];
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                if (url.includes('203.0.113.9')) {
                    destinationStarted.resolve();
                    return destinationLoad.promise;
                }
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                switchBodies.push(JSON.parse(options.body));
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '203.0.113.8';
        await proxy.pcLoadConfig();
        target.value = '203.0.113.9';
        target.emit('change');
        const pendingLoad = proxy.pcLoadConfig();
        await destinationStarted.promise;

        country.value = 'CA';
        country.emit('input');
        await proxy.pcSwitchIP('hot');
        await proxy.pcSaveConfig();

        assert.equal(switchBodies.length, 0);
        assert.equal(configBodies.length, 0);
        assert.equal(env.alerts.some(message => message.includes('配置尚未加载')), true);

        destinationLoad.resolve(jsonResponse({
            '0': 'DE',
            port: 8300,
            proxy: { listen_host: '172.20.0.1', public_listener: false },
        }));
        await pendingLoad;

        assert.equal(country.value, 'CA');
        assert.equal(String(port.value), '8300');
        assert.equal(env.document.getElementById('slot-listen-host').value, '172.20.0.1');
    } finally {
        env.cleanup();
    }
});

test('failed-target retries replay their original payload and keep only the failing subset', { timeout: 5000 }, async () => {
    const switchBodies = [];
    const attempts = new Map();
    let allowReload;
    let round = 0;
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
            { ip: '203.0.113.10', name: 'edge-c' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                round += 1;
                if (round === 1) {
                    return jsonResponse({
                        '0': 'JP',
                        port: 7920,
                        proxy: { listen_host: '127.0.0.1', public_listener: false },
                    });
                }
                if (allowReload) allowReload();
                return jsonResponse({
                    '0': 'FR',
                    port: 8400,
                    proxy: { listen_host: '', public_listener: true },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                const failing = body.ip !== '203.0.113.8';
                if (failing && ((body.ip === '203.0.113.9' && attempt === 1) || (body.ip === '203.0.113.10' && attempt <= 2))) {
                    return jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
                }
                return jsonResponse({ success: true });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        const country = env.addElement('slot-cfg-0', 'input');
        const port = env.addElement('slot-port', 'input');
        const listenHost = env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();
        country.value = 'CA';
        country.emit('input');
        port.value = '9100';
        port.emit('input');
        listenHost.value = '127.0.0.1';
        listenHost.emit('input');

        await proxy.pcSwitchIP('hot');
        await new Promise(resolve => setTimeout(resolve, 0));
        await proxy.pcSwitchIP('hot');
        await proxy.pcSwitchIP('hot');

        assert.deepEqual(switchBodies.map(body => [body.ip, body['0'], body.port, body.public_listener, body.listen_host]), [
            ['203.0.113.8', 'CA', 9100, false, '127.0.0.1'],
            ['203.0.113.9', 'CA', 9100, false, '127.0.0.1'],
            ['203.0.113.10', 'CA', 9100, false, '127.0.0.1'],
            ['203.0.113.9', 'CA', 9100, false, '127.0.0.1'],
            ['203.0.113.10', 'CA', 9100, false, '127.0.0.1'],
            ['203.0.113.10', 'CA', 9100, false, '127.0.0.1'],
        ]);
    } finally {
        env.cleanup();
    }
});

test('a batch retry failing completely does not resurrect an earlier successful target', { timeout: 5000 }, async () => {
    const switchBodies = [];
    const attempts = new Map();
    const env = installEnvironment({
        servers: [
            { ip: '203.0.113.8', name: 'edge-a' },
            { ip: '203.0.113.9', name: 'edge-b' },
            { ip: '203.0.113.10', name: 'edge-c' },
        ],
        fetchImpl: async (url, options) => {
            if (url.startsWith('/api/proxy/config?ip=')) {
                return jsonResponse({
                    '0': 'JP',
                    port: 7920,
                    proxy: { listen_host: '127.0.0.1', public_listener: false },
                });
            }
            if (url === '/api/proxy/switch' && options.method === 'POST') {
                const body = JSON.parse(options.body);
                switchBodies.push(body);
                const attempt = (attempts.get(body.ip) || 0) + 1;
                attempts.set(body.ip, attempt);
                const succeeds = body.ip === '203.0.113.8' || (body.ip === '203.0.113.9' && attempt >= 2);
                return succeeds
                    ? jsonResponse({ success: true })
                    : jsonResponse({ success: false, error: 'temporary failure' }, { ok: false, status: 503 });
            }
            return jsonResponse({});
        },
    });
    try {
        const target = env.addElement('slot-target-ip', 'select');
        env.addElement('slot-cfg-0', 'input');
        env.addElement('slot-port', 'input');
        env.addElement('slot-listen-host', 'input');
        const proxy = await loadLegacyProxy();
        await env.syncReadyNodes(proxy);

        target.value = '*';
        await proxy.pcLoadConfig();
        await proxy.pcSwitchIP('hot');
        await proxy.pcSwitchIP('hot');
        await proxy.pcSwitchIP('hot');

        assert.deepEqual(switchBodies.map(body => body.ip), [
            '203.0.113.8',
            '203.0.113.9',
            '203.0.113.10',
            '203.0.113.9',
            '203.0.113.10',
            '203.0.113.10',
        ]);
    } finally {
        env.cleanup();
    }
});
