import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRenderer, nextTick as vueNextTick } from 'vue';
import {
    buildCustomBackgroundCss,
    buildProbeThemeCss,
    createDefaultProbeThemes,
    DEFAULT_PROBE_THEMES,
    sanitizeCssUrl,
    THEME_COMPATIBILITY_CSS,
} from '../frontend/src/styles/probeThemes.js';
import { resetExternalDepsStateForTest } from '../frontend/src/utils/externalDeps.js';

const state = fs.readFileSync(new URL('../frontend/src/composables/useKuiState.js', import.meta.url), 'utf8');
globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
const { useKuiState } = await import('../frontend/src/composables/useKuiState.js');
const { pcStopProxy } = await import('../frontend/src/proxy/legacyProxy.js');

const nodeOps = {
    patchProp(element, key, previous, next) {
        element.props[key] = next;
    },
    insert(element, parent, anchor = null) {
        if (element.parent) {
            const currentIndex = element.parent.children.indexOf(element);
            if (currentIndex >= 0) element.parent.children.splice(currentIndex, 1);
        }
        element.parent = parent;
        const anchorIndex = anchor ? parent.children.indexOf(anchor) : -1;
        if (anchorIndex >= 0) parent.children.splice(anchorIndex, 0, element);
        else parent.children.push(element);
    },
    remove(element) {
        if (!element.parent) return;
        const index = element.parent.children.indexOf(element);
        if (index >= 0) element.parent.children.splice(index, 1);
        element.parent = null;
    },
    createElement(type) {
        return { type, props: {}, children: [], parent: null };
    },
    createText(text) {
        return { type: '#text', text, parent: null };
    },
    createComment(text) {
        return { type: '#comment', text, parent: null };
    },
    setText(node, text) {
        node.text = text;
    },
    setElementText(node, text) {
        node.text = text;
    },
    parentNode(node) {
        return node.parent || null;
    },
    nextSibling(node) {
        if (!node.parent) return null;
        const index = node.parent.children.indexOf(node);
        return node.parent.children[index + 1] || null;
    },
    querySelector() {
        return null;
    },
    setScopeId(element, id) {
        element.scopeId = id;
    },
    cloneNode(node) {
        return { ...node, props: { ...node.props }, children: [...(node.children || [])] };
    },
    insertStaticContent(content, parent, anchor = null) {
        const node = { type: '#static', text: content, parent: null };
        nodeOps.insert(node, parent, anchor);
        return [node, node];
    },
};

const renderer = createRenderer(nodeOps);

const flushMicrotasks = async (rounds = 8) => {
    for (let index = 0; index < rounds; index += 1) {
        await Promise.resolve();
        await vueNextTick();
    }
};

const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 0));
        await flushMicrotasks(1);
    }
    assert.fail(`Timed out waiting for ${label}`);
};

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

const jsonResponse = (payload, { ok = true, status = 200 } = {}) => ({
    ok,
    status,
    json: async () => payload,
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
});

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        FakeWebSocket.instances.push(this);
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
    }

    send() {}
}

const installRuntimeEnvironment = ({ local = {}, session = {}, fetch: fetchImpl } = {}) => {
    const previousGlobals = new Map();
    for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'location', 'fetch', 'WebSocket', 'alert', 'confirm']) {
        previousGlobals.set(key, globalThis[key]);
    }

    const storage = values => ({
        values: new Map(Object.entries(values)),
        getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
        setItem(key, value) { this.values.set(key, String(value)); },
        removeItem(key) { this.values.delete(key); },
        clear() { this.values.clear(); },
    });

    const appended = [];
    const byId = new Map();
    const documentListeners = new Map();

    const makeElement = tagName => {
        const listeners = new Map();
        const element = {
            tagName: String(tagName).toUpperCase(),
            id: '',
            parentNode: null,
            isConnected: false,
            dataset: {},
            attributes: {},
            style: {},
            className: '',
            textContent: '',
            innerHTML: '',
            children: [],
            value: '',
            setAttribute(name, value) {
                this.attributes[name] = String(value);
                if (name === 'id') this.id = String(value);
                if (name === 'data-kui-dep') this.dataset.kuiDep = String(value);
                if (name === 'data-kui-loaded') this.dataset.kuiLoaded = String(value);
            },
            getAttribute(name) {
                return this.attributes[name] ?? null;
            },
            addEventListener(type, callback) {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type).add(callback);
            },
            removeEventListener(type, callback) {
                listeners.get(type)?.delete(callback);
            },
            appendChild(child) {
                child.parentNode = this;
                child.isConnected = true;
                this.children.push(child);
                appended.push(child);
                if (child.id) byId.set(child.id, child);
                if (child.tagName === 'LINK') queueMicrotask(() => child.onload?.());
                return child;
            },
            remove() {
                if (this.parentNode) {
                    const index = this.parentNode.children.indexOf(this);
                    if (index >= 0) this.parentNode.children.splice(index, 1);
                }
                this.parentNode = null;
                this.isConnected = false;
            },
            getContext() {
                return { canvas: this };
            },
            closest() {
                return null;
            },
            focus() {},
            querySelectorAll() {
                return [];
            },
        };
        return element;
    };

    const head = makeElement('head');
    head.isConnected = true;
    const body = makeElement('body');
    body.isConnected = true;
    const documentElement = makeElement('html');
    documentElement.isConnected = true;

    const document = {
        head,
        body,
        documentElement,
        hidden: false,
        dispatchEvent(event) {
            const callbacks = documentListeners.get(event.type);
            if (!callbacks) return true;
            for (const callback of [...callbacks]) callback(event);
            return true;
        },
        hasEventListener(type) {
            return (documentListeners.get(type)?.size || 0) > 0;
        },
        listenerCount(type) {
            return documentListeners.get(type)?.size || 0;
        },
        getElementById(id) {
            return byId.get(id) || null;
        },
        createElement(tagName) {
            return makeElement(tagName);
        },
        createElementNS(_namespace, tagName) {
            return makeElement(tagName);
        },
        createTextNode(text) {
            return { textContent: text };
        },
        querySelectorAll() {
            return [];
        },
        addEventListener(type, callback) {
            if (!documentListeners.has(type)) documentListeners.set(type, new Set());
            documentListeners.get(type).add(callback);
        },
        removeEventListener(type, callback) {
            documentListeners.get(type)?.delete(callback);
        },
    };

    const window = {
        location: { origin: 'https://panel.example' },
        matchMedia: () => ({
            matches: false,
            addEventListener() {},
            removeEventListener() {},
        }),
        addEventListener() {},
        removeEventListener() {},
    };

    const alerts = [];
    const fetchCalls = [];
    const fetchMock = async (url, options = {}) => {
        fetchCalls.push({ url: String(url), options });
        if (fetchImpl) return fetchImpl(String(url), options);
        return jsonResponse({});
    };

    globalThis.window = window;
    globalThis.document = document;
    globalThis.location = window.location;
    globalThis.localStorage = storage(local);
    globalThis.sessionStorage = storage(session);
    globalThis.fetch = fetchMock;
    globalThis.WebSocket = FakeWebSocket;
    globalThis.alert = message => alerts.push(String(message));
    globalThis.confirm = () => true;

    FakeWebSocket.instances = [];
    resetExternalDepsStateForTest();

    return {
        window,
        document,
        alerts,
        fetchCalls,
        appended,
        addElement(id, tagName = 'div') {
            const element = makeElement(tagName);
            element.id = id;
            element.isConnected = true;
            byId.set(id, element);
            return element;
        },
        removeElement(id) {
            const element = byId.get(id);
            if (element) element.isConnected = false;
            byId.delete(id);
            return element;
        },
        scriptFor(dependency) {
            return appended
                .filter(element => element.tagName === 'SCRIPT' && element.getAttribute('data-kui-dep') === dependency)
                .at(-1) || null;
        },
        resolveScript(dependency, globalName, value) {
            window[globalName] = value;
            const script = this.scriptFor(dependency);
            assert.ok(script, `Expected a pending ${dependency} script`);
            script.onload?.();
        },
        resolveScriptElement(script, globalName, value) {
            assert.ok(script, 'Expected a pending script element');
            window[globalName] = value;
            script.onload?.();
        },
        cleanup() {
            resetExternalDepsStateForTest();
            for (const [key, value] of previousGlobals) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        },
    };
};

const mountKuiState = () => {
    let state;
    const root = nodeOps.createElement('root');
    const app = renderer.createApp({
        setup() {
            state = useKuiState();
            return () => null;
        },
    });
    app.mount(root);
    return {
        get state() {
            return state;
        },
        unmount() {
            app.unmount();
        },
    };
};

test('probe themes expose six independent defaults', () => {
    assert.equal(DEFAULT_PROBE_THEMES.length, 6);
    assert.deepEqual(DEFAULT_PROBE_THEMES.map(theme => theme.id), ['theme1', 'theme2', 'theme3', 'theme4', 'theme5', 'theme6']);

    const first = createDefaultProbeThemes();
    const second = createDefaultProbeThemes();
    assert.notStrictEqual(first, DEFAULT_PROBE_THEMES);
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first[0], second[0]);

    const originalName = DEFAULT_PROBE_THEMES[0].name;
    first[0].name = 'mutated';
    assert.equal(DEFAULT_PROBE_THEMES[0].name, originalName);
    assert.equal(second[0].name, originalName);
});

test('probe compatibility CSS keeps legacy theme and responsive rules', () => {
    for (const selector of [
        'body.theme2 .probe-body',
        '.theme2 .item-right-bag',
        '.theme4 .global-stats',
        '.theme5 .item-title',
        '.theme7 .probe-header-card',
        '.theme8 .ping-box',
        '.theme9 .vps-card',
        '.theme10 .vps-card',
        '.theme11 .item-ping',
        '.theme12 .item-status.is-online',
        '.theme13 .item-ping',
        '.theme14 .probe-header-card',
        '.theme15 .probe-info-label',
        '.theme16 .stat-group',
        '.theme17 .card-meta-list',
        '.theme18 .probe-card-meta',
    ]) {
        assert.ok(THEME_COMPATIBILITY_CSS.includes(selector), `${selector} should remain in the compatibility layer`);
    }
    assert.match(THEME_COMPATIBILITY_CSS, /@media \(max-width: 640px\) \{/);
    assert.match(THEME_COMPATIBILITY_CSS, /\.theme16 \.stat-group \{ flex-basis: 45% !important; \}/);
});

test('probe CSS composition preserves theme and custom background behavior', () => {
    const themes = [
        { id: 'theme1', name: 'Classic', is_dark: false, css: '.base-theme { color: #111; }' },
        { id: 'theme6', name: 'Custom', is_dark: true, has_custom_css: true, css: '' },
    ];

    const classic = buildProbeThemeCss({
        themeId: 'theme1',
        availableThemes: themes,
        customCss: '.custom-only { color: red; }',
        customBg: '',
    });
    assert.ok(classic.includes('.base-theme { color: #111; }'));
    assert.ok(classic.includes(THEME_COMPATIBILITY_CSS));
    assert.ok(!classic.includes('.custom-only { color: red; }'));

    const custom = buildProbeThemeCss({
        themeId: 'theme6',
        availableThemes: themes,
        customCss: '.custom-only { color: red; }',
        customBg: "https://safe.example/a.png'); }\nbody { background: red; }",
    });
    assert.ok(custom.includes('.custom-only { color: red; }'));
    assert.ok(!custom.includes('background: red'));
    assert.ok(!custom.includes('.probe-vps-card'));
    assert.ok(!custom.includes('.probe-view-controls'));

    const safeCustom = buildProbeThemeCss({
        themeId: 'theme6',
        availableThemes: themes,
        customCss: '.custom-only { color: red; }',
        customBg: 'https://safe.example/a.png',
    });
    assert.ok(safeCustom.includes('url(\'https://safe.example/a.png\')'));
    assert.ok(safeCustom.includes('.probe-vps-card'));

    assert.equal(buildCustomBackgroundCss(''), '');
    assert.equal(buildCustomBackgroundCss('   '), '');
});

test('custom background URLs preserve data image semantics and reject dangerous protocols', () => {
    const svg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3C/svg%3E";
    const css = buildCustomBackgroundCss(`  ${svg}  `);
    const embedded = css.match(/url\('((?:\\.|[^'])*)'\)/)?.[1];
    assert.ok(embedded);
    assert.ok(css.includes('data:image/svg+xml'));
    assert.ok(css.includes("xmlns=\\'http://www.w3.org/2000/svg\\'"), 'single quotes inside a data URL must be escaped without dropping double quotes');
    assert.ok(css.includes("viewBox=\\'0 0 10 10\\'"));
    assert.equal(embedded, svg.replace(/'/g, "\\'"));

    const escaped = buildCustomBackgroundCss("/images/a\\b'c.png");
    assert.ok(escaped.includes("url('/images/a\\\\b\\'c.png')"));

    for (const unsafe of [
        'javascript:alert(1)',
        'JAVASCRIPT:alert(1)',
        'vbscript:msgbox(1)',
        'data:text/html,<script>alert(1)</script>',
        '//evil.example/a.png',
        'ftp://example.com/a.png',
        'https://safe.example/a\nb.png',
        'https://safe.example/a\fb.png',
        'https://safe.example/a\rb.png',
        'https://safe.example/a\tb.png',
        'https://safe.example/a\0b.png',
        'https://safe.example/a\u0001b.png',
        'https://safe.example/a\u001fb.png',
        'https://safe.example/a\u007fb.png',
    ]) {
        assert.equal(buildCustomBackgroundCss(unsafe), '', `${unsafe} should be rejected`);
    }

    for (const control of ['\f', '\r', '\n', '\t', '\0', '\u0001', '\u001f', '\u007f']) {
        assert.equal(sanitizeCssUrl(`https://safe.example/a${control}b.png`), '', `U+${control.codePointAt(0).toString(16).padStart(4, '0')} must be rejected`);
    }

    for (const control of ['\f', '\r', '\n']) {
        const codePoint = `U+${control.codePointAt(0).toString(16).padStart(4, '0')}`;
        assert.equal(
            sanitizeCssUrl(`${control}https://safe.example/a.png`),
            '',
            `${codePoint} at the start must be rejected before trim()`,
        );
        assert.equal(
            sanitizeCssUrl(`https://safe.example/a.png${control}`),
            '',
            `${codePoint} at the end must be rejected before trim()`,
        );
    }

    assert.match(buildCustomBackgroundCss('HTTPS://safe.example/a.png'), /url\('HTTPS:\/\/safe\.example\/a\.png'\)/);
    assert.match(buildCustomBackgroundCss('http://safe.example/a.png'), /url\('http:\/\/safe\.example\/a\.png'\)/);
    assert.match(buildCustomBackgroundCss('DATA:IMAGE/PNG;base64,AAAA'), /url\('DATA:IMAGE\/PNG;base64,AAAA'\)/);
    assert.match(buildCustomBackgroundCss('/assets/bg.png'), /url\('\/assets\/bg\.png'\)/);
});

const mountWithPendingQrCode = async ({ session, tab = 'nodes', openModal = true } = {}) => {
    const env = installRuntimeEnvironment({
        session,
        local: { monitor_preferred_tab: tab },
        fetch: async url => {
            if (url === '/api/data') return jsonResponse({ servers: [], nodes: [], users: [], groups: [], siteTitle: 'Panel', securityWarnings: [] });
            if (url.startsWith('/api/probe/')) return jsonResponse({ settings: { is_public: 'false' }, servers: [], realtime_url: '' });
            return jsonResponse({});
        },
    });
    const mounted = mountKuiState();
    await flushMicrotasks();
    const { state } = mounted;
    await vueNextTick();
    if (openModal) {
        state.qrModalOpen.value = true;
        await vueNextTick();
    }
    state.showQrCode('https://panel.example/sub');
    await waitFor(() => env.scriptFor('qrious'), 'QRious request');
    return { env, mounted, state };
};

test('delayed QR generation is invalidated by logout', async () => {
    const { env, mounted, state } = await mountWithPendingQrCode({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        openModal: false,
    });
    try {
        state.logout();
        assert.equal(state.qrCodeImage.value, '');
        await flushMicrotasks();
        env.resolveScript('qrious', 'QRious', class { toDataURL() { return 'data:image/png;base64,fresh'; } });
        await flushMicrotasks();
        assert.equal(state.qrModalOpen.value, false);
        assert.equal(state.qrCodeImage.value, '');
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('delayed QR generation is invalidated when the modal closes', async () => {
    const { env, mounted, state } = await mountWithPendingQrCode({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
    });
    try {
        state.qrCodeImage.value = 'stale';
        const staleImage = state.qrCodeImage.value;
        state.qrModalOpen.value = false;
        await flushMicrotasks();
        env.resolveScript('qrious', 'QRious', class { toDataURL() { return 'data:image/png;base64,closed'; } });
        await flushMicrotasks();
        assert.equal(state.qrModalOpen.value, false);
        assert.equal(state.qrCodeImage.value, staleImage);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('delayed QR generation is invalidated when switching tabs', async () => {
    const { env, mounted, state } = await mountWithPendingQrCode({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
    });
    try {
        state.qrCodeImage.value = 'stale';
        const staleImage = state.qrCodeImage.value;
        state.activeTab.value = 'dashboard';
        await flushMicrotasks();
        env.resolveScript('qrious', 'QRious', class { toDataURL() { return 'data:image/png;base64,tab'; } });
        await flushMicrotasks();
        assert.equal(state.qrModalOpen.value, false);
        assert.equal(state.qrCodeImage.value, '');
        assert.notEqual(state.qrCodeImage.value, staleImage);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

const baseAdminFetch = () => async url => {
    if (url === '/api/data') {
        return jsonResponse({
            servers: [{ ip: '203.0.113.8', name: 'edge', last_report: Date.now() }],
            nodes: [],
            users: [],
            groups: [],
            securityWarnings: [],
            realtimeUrl: 'https://realtime.example',
        });
    }
    if (url === '/api/stats') return jsonResponse({ totals: {}, series: {} });
    if (url.startsWith('/api/probe/')) return jsonResponse({ settings: { is_public: 'false' }, servers: [], realtime_url: '' });
    return jsonResponse({});
};

const mountLoggedInAdmin = async ({ fetch: fetchImpl, local = {} } = {}) => {
    const env = installRuntimeEnvironment({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        local: { monitor_preferred_tab: 'nodes', ...local },
        fetch: fetchImpl,
    });
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        await waitFor(() => mounted.state.isLoggedIn.value, 'logged-in admin state');
        return { env, mounted, state: mounted.state };
    } catch (error) {
        mounted.unmount();
        env.cleanup();
        throw error;
    }
};

test('logout clears private probe data, node drafts, and admin probe settings', async () => {
    const { env, mounted, state } = await mountLoggedInAdmin({ fetch: baseAdminFetch() });
    try {
        state.publicProbeServers.value = [{ id: '203.0.113.8', server_group: 'private' }];
        state.newNodeParams['203.0.113.8'] = {
            protocol: 'XTLS-Reality',
            port: 443,
            username: 'admin',
            reality_private_key: 'private-key',
        };
        state.addingNode['203.0.113.9'] = true;
        state.nodeEditDrafts['node-1'] = {
            protocol: 'XTLS-Reality',
            reality_private_key: 'draft-private-key',
        };
        state.batchStartPort['203.0.113.8'] = '8881';
        state.batchUser['203.0.113.8'] = 'alice';
        state.probeSys.custom_css = 'body { color: red; }';
        state.probeSys.custom_bg = 'https://private.example/bg.png';
        state.probeSys.visits_today = '99';
        state.probeSys.cached_nodes_data = '{"private":true}';
        state.probeSys.tg_bot_token = 'private-token';
        state.pingNodes.ct = ['https://private.example/ct'];
        state.qrCodeImage.value = 'data:image/png;base64,private';
        state.qrModalOpen.value = true;
        state.probeSys.cached_nodes_data = JSON.stringify({
            themes: [{ id: 'private-theme', name: 'Private theme', css: '.private { color: red; }' }],
        });
        const parsedCachedNodes = JSON.parse(state.probeSys.cached_nodes_data);
        if (Array.isArray(parsedCachedNodes.themes)) state.availableThemes.value = parsedCachedNodes.themes;
        state.openProbeEditModal({
            id: '203.0.113.8',
            vps_ip: '203.0.113.8',
            private_key: 'private-key',
            tg_bot_token: 'private-token',
            is_hidden: true,
        });
        await vueNextTick();

        assert.equal(state.probeEditModalOpen.value, true);
        assert.deepEqual(state.availableThemes.value.map(theme => theme.id), ['private-theme']);

        state.logout();
        await flushMicrotasks();

        assert.deepEqual(state.publicProbeServers.value, []);
        assert.deepEqual(Object.keys(state.newNodeParams), []);
        assert.deepEqual(Object.keys(state.addingNode), []);
        assert.deepEqual(Object.keys(state.nodeEditDrafts), []);
        assert.deepEqual(Object.keys(state.batchStartPort), []);
        assert.deepEqual(Object.keys(state.batchUser), []);
        assert.equal(state.probeSys.custom_css, '');
        assert.equal(state.probeSys.custom_bg, '');
        assert.equal(state.probeSys.cached_nodes_data, undefined);
        assert.equal(state.probeSys.tg_bot_token, '');
        assert.deepEqual(state.pingNodes.ct, []);
        assert.equal(state.qrCodeImage.value, '');
        assert.equal(state.qrModalOpen.value, false);
        assert.equal(state.probeEditModalOpen.value, false);
        assert.deepEqual(state.editingProbeNode.value, {});
        assert.deepEqual(state.availableThemes.value.map(theme => theme.id), DEFAULT_PROBE_THEMES.map(theme => theme.id));
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('private probe settings reset to public-safe values while preserving reactive keys', async () => {
    const env = installRuntimeEnvironment({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        local: { monitor_preferred_tab: 'nodes' },
        fetch: baseAdminFetch(),
    });
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        const { state } = mounted;
        await waitFor(() => env.fetchCalls.some(call => call.url === '/api/probe/public'), 'initial public probe request');
        state.probeSys.theme = 'theme6';
        state.logout();
        assert.equal(state.probeSys.theme, 'theme1');
        assert.equal(state.probeSys.is_public, 'false');
        assert.equal(state.probeSys.site_title, 'Server Monitor Pro');
        assert.ok(Object.keys(state.probeSys).includes('custom_css'));
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('a subscription token response from a logged-out session cannot overwrite the new session token', async () => {
    const resetJson = deferred();
    let dataCalls = 0;
    let jsonReading = false;
    let subscriptionResetCalls = 0;
    const env = installRuntimeEnvironment({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        local: { monitor_preferred_tab: 'nodes' },
        fetch: async url => {
            if (url === '/api/data') {
                dataCalls += 1;
                return jsonResponse({
                    servers: [],
                    nodes: [],
                    users: [],
                    groups: [],
                    securityWarnings: [],
                    mySubToken: dataCalls === 1 ? 'current-token' : 'relogin-token',
                });
            }
            if (url === '/api/user/sub_token') {
                subscriptionResetCalls += 1;
                return {
                    ok: true,
                    status: 200,
                    json: async () => {
                        jsonReading = true;
                        return resetJson.promise;
                    },
                };
            }
            if (url === '/api/login') {
                return jsonResponse({ token: 'token-2', role: 'admin' });
            }
            if (url.startsWith('/api/probe/')) return jsonResponse({ settings: {}, servers: [] });
            return jsonResponse({});
        },
    });
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        const { state } = mounted;
        await waitFor(() => state.isLoggedIn.value && state.generateSubLink().includes('token=current-token'), 'logged-in admin state');

        const resetting = state.resetMySubLink();
        await waitFor(() => subscriptionResetCalls === 1 && jsonReading, 'subscription reset awaiting response.json()');
        state.logout();
        state.loginUser.value = 'admin';
        state.password.value = 'password';
        const loginPromise = state.login();
        await waitFor(() => env.fetchCalls.some(call => call.url === '/api/login'), 'relogin request');
        await loginPromise;
        await flushMicrotasks();
        await waitFor(() => state.isLoggedIn.value && state.generateSubLink().includes('token=relogin-token'), 'relogin session');

        resetJson.resolve({ token: 'legacy-sub-token' });
        await resetting;
        await flushMicrotasks();

        assert.match(state.generateSubLink(), /token=relogin-token/);
        assert.doesNotMatch(state.generateSubLink(), /legacy-sub-token/);
        assert.equal(env.alerts.some(message => message.includes('订阅令牌已刷新')), false);
        assert.equal(state.subTokenResetting.value, false);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('a public probe response from the previous auth generation cannot overwrite logout state', async () => {
    const probe = deferred();
    let probeCalls = 0;
    const fetchImpl = baseAdminFetch();
    const env = installRuntimeEnvironment({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        local: { monitor_preferred_tab: 'nodes' },
        fetch: async (url, options) => {
            if (url === '/api/probe/public') {
                probeCalls += 1;
                if (probeCalls === 1) return probe.promise;
                return jsonResponse({ settings: { is_public: 'false' }, servers: [], realtime_url: '' });
            }
            return fetchImpl(url, options);
        },
    });
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        await waitFor(() => env.fetchCalls.some(call => call.url === '/api/probe/public'), 'pending public probe request');
        const { state } = mounted;
        state.logout();
        probe.resolve(jsonResponse({
            settings: { is_public: 'true', theme: 'theme6', custom_css: 'stale css', custom_bg: 'https://private.example/bg.png' },
            servers: [{ id: '203.0.113.8', country: 'US' }],
            realtime_url: 'https://realtime.example',
        }));
        await flushMicrotasks();
        assert.deepEqual(state.publicProbeServers.value, []);
        assert.notEqual(state.probeSys.theme, 'theme6');
        assert.equal(state.probeSys.custom_css, '');
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('a 401 public probe response clears stale public servers and keeps the login modal', async () => {
    const probe = deferred();
    const env = installRuntimeEnvironment({
        fetch: async url => {
            if (url === '/api/probe/public') return probe.promise;
            return jsonResponse({});
        },
    });
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        const { state } = mounted;
        state.publicProbeServers.value = [{ id: 'stale-node', country: 'US' }];
        await waitFor(() => env.fetchCalls.some(call => call.url === '/api/probe/public'), 'public probe request');
        probe.resolve(jsonResponse({ error: 'Unauthorized' }, { ok: false, status: 401 }));
        await flushMicrotasks();
        assert.deepEqual(state.publicProbeServers.value, []);
        assert.equal(state.showLoginModal.value, true);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

const mountPendingRealityOperation = async ({ nodes = [], operation, fetch: fetchOverride }) => {
    const fetchImpl = baseAdminFetch();
    const env = installRuntimeEnvironment({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        local: { monitor_preferred_tab: 'nodes' },
        fetch: async (url, options) => {
            if (url === '/api/data') {
                return jsonResponse({
                    servers: [{ ip: '203.0.113.8', name: 'edge', last_report: Date.now() }],
                    nodes,
                    users: [],
                    groups: [],
                    securityWarnings: [],
                    realtimeUrl: 'https://realtime.example',
                });
            }
            if (fetchOverride) {
                const response = await fetchOverride(url, options);
                if (response) return response;
            }
            return fetchImpl(url, options);
        },
    });
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        await waitFor(() => mounted.state.nodes.value.length === nodes.length, 'initial nodes');
        const state = mounted.state;
        const pending = operation(state);
        await waitFor(() => env.scriptFor('tweetnacl'), 'TweetNaCl request');
        return { env, mounted, state, pending };
    } catch (error) {
        mounted.unmount();
        env.cleanup();
        throw error;
    }
};

const reloginThroughLogin = async (env, state) => {
    state.logout();
    state.loginUser.value = 'admin';
    state.password.value = 'password';
    const loginPromise = state.login();
    await waitFor(() => env.fetchCalls.some(call => call.url === '/api/login'), 'relogin request');
    await loginPromise;
    await flushMicrotasks();
};

const resolveRealityDependency = env => env.resolveScript('tweetnacl', 'nacl', {
    box: { keyPair: () => ({ secretKey: new Uint8Array(32), publicKey: new Uint8Array(32) }) },
});

test('a sign-out during addNode Reality key loading prevents the old operation from posting', async () => {
    const { env, mounted, state, pending } = await mountPendingRealityOperation({
        operation: state => state.addNode('203.0.113.8'),
    });
    try {
        await reloginThroughLogin(env, state);
        resolveRealityDependency(env);
        await pending;
        await flushMicrotasks();
        assert.equal(env.fetchCalls.filter(call => call.url === '/api/nodes').length, 0);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('an old addNode finally cannot resurrect locks or release a new session operation', async () => {
    const newNodePost = deferred();
    let newNodePostStarted = false;
    const { env, mounted, state, pending } = await mountPendingRealityOperation({
        operation: state => state.addNode('203.0.113.8'),
        fetch: async url => {
            if (url === '/api/nodes') {
                newNodePostStarted = true;
                return newNodePost.promise;
            }
            return null;
        },
    });
    try {
        await reloginThroughLogin(env, state);
        state.newNodeParams['203.0.113.8'] = {
            protocol: 'Trojan',
            port: 443,
            username: 'admin',
            sni: 'addons.mozilla.org',
            node_password: 'session-password',
        };
        const newPending = state.addNode('203.0.113.8');
        await waitFor(() => newNodePostStarted, 'new session addNode post');

        resolveRealityDependency(env);
        await pending;
        await flushMicrotasks();

        assert.equal(state.addingNode['203.0.113.8'], true);
        newNodePost.resolve(jsonResponse({}));
        await newPending;
        await flushMicrotasks();
        assert.equal(state.addingNode['203.0.113.8'], false);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('a sign-out during saveNodeEdit Reality key loading prevents the old operation from writing', async () => {
    const node = { id: 'node-edit', vps_ip: '203.0.113.8', protocol: 'XTLS-Reality', port: 443, username: 'admin', uuid: 'u', private_key: '', public_key: '', short_id: '', traffic_limit: 0, expire_time: 0 };
    const { env, mounted, state, pending } = await mountPendingRealityOperation({
        nodes: [node],
        operation: state => {
            state.startEditNode(state.nodes.value[0]);
            const draft = state.nodeEditDrafts[node.id];
            draft.reality_private_key = '';
            draft.reality_public_key = '';
            return state.saveNodeEdit(state.nodes.value[0]);
        },
    });
    try {
        await reloginThroughLogin(env, state);
        resolveRealityDependency(env);
        await pending;
        await flushMicrotasks();
        assert.equal(env.fetchCalls.filter(call => call.url === '/api/nodes').length, 0);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('a sign-out during deployAllProtocols key loading prevents old batch writes', async () => {
    const { env, mounted, state, pending } = await mountPendingRealityOperation({
        operation: state => {
            state.batchStartPort['203.0.113.8'] = '8881';
            return state.deployAllProtocols('203.0.113.8');
        },
    });
    try {
        await reloginThroughLogin(env, state);
        resolveRealityDependency(env);
        await pending;
        await flushMicrotasks();
        assert.equal(env.fetchCalls.filter(call => call.url === '/api/nodes' && call.options.method === 'POST').length, 0);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

const mountPendingRealtimeTicket = async () => {
    const ticket = deferred();
    const env = installRuntimeEnvironment({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        local: { monitor_preferred_tab: 'nodes' },
        fetch: async url => {
            if (url === '/api/data') {
                return jsonResponse({ servers: [], nodes: [], users: [], groups: [], securityWarnings: [], realtimeUrl: 'https://realtime.example' });
            }
            if (url === 'https://realtime.example/dashboard/ticket') return ticket.promise;
            if (url.startsWith('/api/probe/')) return jsonResponse({ settings: {}, servers: [] });
            return jsonResponse({});
        },
    });
    const mounted = mountKuiState();
    await flushMicrotasks();
    await waitFor(() => env.fetchCalls.some(call => call.url === 'https://realtime.example/dashboard/ticket'), 'realtime ticket request');
    await waitFor(() => env.document.hasEventListener?.('visibilitychange'), 'visibilitychange listener');
    return { env, mounted, state: mounted.state, ticket };
};

const realtimeTicketCalls = env => env.fetchCalls.filter(call => call.url === 'https://realtime.example/dashboard/ticket');

test('same-tick realtime connects share one abortable ticket request before auth resolves', async () => {
    const dataReady = deferred();
    const authHeaders = deferred();
    const ticket = deferred();
    let ticketCalls = 0;
    const env = installRuntimeEnvironment({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        local: { monitor_preferred_tab: 'nodes' },
        fetch: async url => {
            if (url === '/api/data') {
                await dataReady.promise;
                return jsonResponse({ servers: [], nodes: [], users: [], groups: [], securityWarnings: [], realtimeUrl: 'https://realtime.example' });
            }
            if (url === 'https://realtime.example/dashboard/ticket') {
                ticketCalls += 1;
                return ticket.promise;
            }
            if (url.startsWith('/api/probe/')) return jsonResponse({ settings: {}, servers: [] });
            return jsonResponse({});
        },
    });
    let authHeaderCalls = 0;
    const mounted = mountKuiState();
    try {
        const { state } = mounted;
        env.window.kuiAdminAuthHeader = async () => {
            authHeaderCalls += 1;
            await authHeaders.promise;
            return { Authorization: 'Bearer token' };
        };
        dataReady.resolve();
        await waitFor(() => authHeaderCalls === 1 && env.document.hasEventListener('visibilitychange'), 'first auth header wait');

        env.document.hidden = false;
        env.document.dispatchEvent({ type: 'visibilitychange' });
        env.document.dispatchEvent({ type: 'visibilitychange' });
        await flushMicrotasks();
        assert.equal(authHeaderCalls, 1);
        assert.equal(ticketCalls, 0);

        authHeaders.resolve();
        await waitFor(() => ticketCalls === 1, 'one shared realtime ticket request');
        await flushMicrotasks();
        assert.equal(authHeaderCalls, 1);
        assert.equal(ticketCalls, 1);

        const ticketCallsList = env.fetchCalls.filter(call => call.url === 'https://realtime.example/dashboard/ticket');
        assert.equal(ticketCallsList.length, 1);
        const [ticketCall] = ticketCallsList;
        assert.equal(ticketCall.options.signal.aborted, false);

        state.logout();
        assert.equal(ticketCall.options.signal.aborted, true);
        ticket.resolve(jsonResponse({ ticket: 'shared-ticket' }));
        await flushMicrotasks();
        assert.equal(FakeWebSocket.instances.length, 0);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('cold-start realtime retries share one in-flight ticket request', async () => {
    const { env, mounted, state, ticket } = await mountPendingRealtimeTicket();
    try {
        state.activeTab.value = 'probe';
        state.activeTab.value = 'nodes';
        state.activeTab.value = 'probe';
        state.activeTab.value = 'nodes';
        await flushMicrotasks();
        assert.equal(realtimeTicketCalls(env).length, 1);
        ticket.resolve(jsonResponse({ ticket: 'shared-ticket' }));
        await flushMicrotasks();
        assert.equal(FakeWebSocket.instances.length, 1);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('logout aborts a pending realtime ticket request', async () => {
    const { env, mounted, state } = await mountPendingRealtimeTicket();
    try {
        const signal = realtimeTicketCalls(env)[0].options.signal;
        assert.equal(signal.aborted, false);
        state.logout();
        assert.equal(signal.aborted, true);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('hiding the document aborts a pending realtime ticket request', async () => {
    const { env, mounted } = await mountPendingRealtimeTicket();
    try {
        const signal = realtimeTicketCalls(env)[0].options.signal;
        assert.equal(signal.aborted, false);
        env.document.hidden = true;
        env.document.dispatchEvent({ type: 'visibilitychange' });
        await flushMicrotasks();
        assert.equal(signal.aborted, true);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('unmount aborts a pending realtime ticket request', async () => {
    const { env, mounted } = await mountPendingRealtimeTicket();
    const signal = realtimeTicketCalls(env)[0].options.signal;
    try {
        assert.equal(signal.aborted, false);
        mounted.unmount();
        assert.equal(signal.aborted, true);
    } finally {
        env.cleanup();
    }
});

test('visibilitychange is registered before mounted probe requests settle', async () => {
    let resolveProbe;
    const probe = { promise: new Promise(resolve => { resolveProbe = resolve; }) };
    const env = installRuntimeEnvironment({
        fetch: async url => {
            if (url === '/api/probe/public') return probe.promise;
            return jsonResponse({});
        },
    });
    const mounted = mountKuiState();
    try {
        assert.equal(env.document.hasEventListener('visibilitychange'), true);
        await waitFor(() => env.fetchCalls.some(call => call.url === '/api/probe/public'), 'pending probe request');
        assert.equal(env.document.hasEventListener('visibilitychange'), true);
        env.document.hidden = true;
        env.document.dispatchEvent({ type: 'visibilitychange' });
        const { state } = mounted;
        assert.equal(state.probeSys.theme, 'theme1');
        resolveProbe(jsonResponse({
            settings: { theme: 'theme6', is_public: 'false' },
            servers: [],
            realtime_url: '',
        }));
        await flushMicrotasks();
        assert.equal(state.probeSys.theme, 'theme1');
        assert.equal(env.document.hasEventListener('visibilitychange'), true);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('probe requests settling after the page is hidden cannot write probe state', async () => {
    let resolveProbe;
    const probe = { promise: new Promise(resolve => { resolveProbe = resolve; }) };
    const env = installRuntimeEnvironment({
        fetch: async url => {
            if (url === '/api/probe/public') return probe.promise;
            return jsonResponse({});
        },
    });
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        await waitFor(() => env.fetchCalls.some(call => call.url === '/api/probe/public'), 'pending probe request');
        env.document.hidden = true;
        env.document.dispatchEvent({ type: 'visibilitychange' });
        resolveProbe(jsonResponse({
            settings: { theme: 'theme6', is_public: 'false' },
            servers: [{ id: 'stale-node', country: 'US' }],
            realtime_url: '',
        }));
        await flushMicrotasks();
        const { state } = mounted;
        assert.equal(state.probeSys.theme, 'theme1');
        assert.deepEqual(state.publicProbeServers.value, []);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});



test('Reality key loading cannot resurrect canceled edit drafts or generate for partial keys', async () => {
    const env = installRuntimeEnvironment({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        local: { monitor_preferred_tab: 'nodes' },
        fetch: async url => {
            if (url === '/api/data') {
                return jsonResponse({
                    servers: [{ ip: '203.0.113.8', name: 'edge', last_report: Date.now() }],
                    nodes: [{ id: 'node-1', vps_ip: '203.0.113.8', protocol: 'XTLS-Reality', port: 443, username: 'admin', uuid: 'u', private_key: '', public_key: '', short_id: '', traffic_limit: 0, expire_time: 0 }],
                    users: [],
                    groups: [],
                    securityWarnings: [],
                });
            }
            if (url === '/api/stats') return jsonResponse({ totals: {}, series: {} });
            if (url.startsWith('/api/probe/')) return jsonResponse({ settings: {}, servers: [] });
            return jsonResponse({});
        },
    });
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        const { state } = mounted;
        const node = state.nodes.value[0];
        state.startEditNode(node);
        const draft = state.nodeEditDrafts[node.id];
        draft.reality_private_key = '';
        draft.reality_public_key = '';
        const savePromise = state.saveNodeEdit(node);
        await waitFor(() => env.scriptFor('tweetnacl'), 'TweetNaCl request');
        state.cancelEditNode(node.id);
        env.resolveScript('tweetnacl', 'nacl', { box: { keyPair: () => ({ secretKey: new Uint8Array(32), publicKey: new Uint8Array(32) }) } });
        await savePromise;
        assert.equal(env.fetchCalls.filter(call => call.url === '/api/nodes' && call.options.method === 'PUT').length, 0);

        const partialNode = { ...node, id: 'node-partial' };
        state.nodeEditDrafts[partialNode.id] = { ...editDraftFromTestNode(partialNode), reality_private_key: '', reality_public_key: 'only-public' };
        env.appended.length = 0;
        await state.saveNodeEdit(partialNode);
        assert.equal(env.scriptFor('tweetnacl'), null);
        assert.ok(env.alerts.some(message => message.includes('同时填写')));
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

const editDraftFromTestNode = node => ({
    protocol: node.protocol,
    port: Number(node.port),
    username: node.username,
    sni: node.sni || '',
    node_uuid: node.uuid || '',
    node_username: '',
    node_password: '',
    reality_private_key: '',
    reality_public_key: '',
    reality_short_id: '',
    ss_method: '2022-blake3-aes-256-gcm',
    ss_password: '',
    ss_network: 'tcp,udp',
    mtproxy_secret: '',
    mtproxy_domain: '',
    relay_type: 'external',
    target_ip: '',
    target_port: '',
    target_id: '',
    traffic_limit_gb: '',
    expire_date: '',
});

const probeResponse = (settings = {}) => jsonResponse({
    settings: {
        is_public: 'true',
        theme: 'theme1',
        ...settings,
    },
    servers: [],
    realtime_url: '',
});

const makeLeafletMock = () => {
    const mapInstances = [];
    const L = {
        map(containerId) {
            const instance = {
                containerId,
                removed: false,
                invalidations: 0,
                setView() { return this; },
                remove() { this.removed = true; },
                invalidateSize() { this.invalidations += 1; },
                addLayer() {},
                removeLayer() {},
            };
            mapInstances.push(instance);
            return instance;
        },
        layerGroup() {
            return { addTo() { return this; }, clearLayers() {} };
        },
        geoJSON() {
            return { addTo() { return this; } };
        },
        divIcon(options) {
            return options;
        },
        marker() {
            return { addTo() { return this; } };
        },
    };
    return { L, mapInstances };
};

test('probe map rebuilds replaced containers, survives anonymous persisted tabs, and does not wait for GeoJSON', async () => {
    const geoJson = deferred();
    const env = installRuntimeEnvironment({
        local: { monitor_preferred_tab: 'nodes', monitor_preferred_view: 'map' },
        fetch: async url => {
            if (url === '/api/probe/public') {
                return jsonResponse({
                    settings: { is_public: 'true', theme: 'theme1' },
                    servers: [],
                    realtime_url: '',
                });
            }
            if (url.includes('countries.geo.json')) return geoJson.promise;
            return jsonResponse({});
        },
    });
    env.addElement('map-container');
    const firstContainer = env.document.getElementById('map-container');
    const { L, mapInstances } = makeLeafletMock();
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        const { state } = mounted;
        assert.equal(state.isLoggedIn.value, false);
        assert.equal(state.activeTab.value, 'nodes');
        assert.equal(state.probeView.value, 'map');
        await waitFor(() => env.scriptFor('leaflet-js'), 'Leaflet request');
        env.resolveScript('leaflet-js', 'L', L);
        await waitFor(() => mapInstances.length === 1, 'initial map creation');
        assert.equal(mapInstances[0].containerId, 'map-container');

        firstContainer.isConnected = false;
        const secondContainer = env.addElement('map-container');
        state.setProbeView('map');
        await waitFor(() => mapInstances.length === 2, 'map rebuild');
        assert.equal(mapInstances[0].removed, true);
        assert.equal(mapInstances[1].containerId, 'map-container');

        geoJson.resolve(jsonResponse({ type: 'FeatureCollection', features: [] }));
        await flushMicrotasks();
        await waitFor(() => mapInstances.length === 2 && env.document.getElementById('map-container') === secondContainer, 'GeoJSON completion');
        assert.equal(mapInstances[1].invalidations, 0);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('probe map retries GeoJSON after an initial load failure when switching back to map view', async () => {
    let geoJsonCalls = 0;
    let activeGeoJson = jsonResponse({ type: 'FeatureCollection', features: [] }, { ok: false, status: 503 });
    const env = installRuntimeEnvironment({
        local: { monitor_preferred_tab: 'nodes', monitor_preferred_view: 'map' },
        fetch: async url => {
            if (url === '/api/probe/public') {
                return jsonResponse({
                    settings: { is_public: 'true', theme: 'theme1' },
                    servers: [{ id: '203.0.113.8', country: 'US', last_updated: Date.now() }],
                    realtime_url: '',
                });
            }
            if (url.includes('countries.geo.json')) {
                geoJsonCalls += 1;
                return activeGeoJson;
            }
            return jsonResponse({});
        },
    });
    env.addElement('map-container');
    const { L, mapInstances } = makeLeafletMock();
    const geoJsonLayers = [];
    const layerGroupInstance = { addTo() { return this; }, clearLayers() {} };
    L.geoJSON = (data, options) => {
        const layer = { data, options, added: false, addTo() { this.added = true; return this; } };
        geoJsonLayers.push(layer);
        return layer;
    };
    L.layerGroup = () => layerGroupInstance;
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        const { state } = mounted;
        await waitFor(() => env.scriptFor('leaflet-js'), 'Leaflet request');
        env.resolveScript('leaflet-js', 'L', L);
        await waitFor(() => geoJsonCalls === 1, 'initial GeoJSON request');
        await waitFor(() => mapInstances.length === 1, 'initial map creation');
        await flushMicrotasks();

        state.setProbeView('card');
        activeGeoJson = jsonResponse({ type: 'FeatureCollection', features: [{ id: 'USA' }] });
        state.setProbeView('map');
        await waitFor(() => geoJsonCalls === 2, 'GeoJSON retry');
        await waitFor(() => geoJsonLayers.length === 1, 'GeoJSON layer render');
        assert.equal(geoJsonLayers[0].data.features[0].id, 'USA');
        assert.equal(mapInstances.length, 1);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('ECharts cold-load races re-render into current containers and dispose on tab leave or unmount', async () => {
    const env = installRuntimeEnvironment({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        local: { monitor_preferred_tab: 'nodes' },
        fetch: async url => {
            if (url === '/api/data') {
                return jsonResponse({
                    servers: [{ ip: '203.0.113.8', name: 'edge', last_report: Date.now() }],
                    nodes: [],
                    users: [],
                    groups: [],
                    securityWarnings: [],
                });
            }
            const stats = deferred();
            if (url === '/api/stats') {
                stats.resolve(jsonResponse({ totals: {}, series: { '203.0.113.8': [{ day: '11-22', total_bytes: 1048576 }] } }));
                return stats.promise;
            }
            if (url.startsWith('/api/probe/')) return jsonResponse({ settings: {}, servers: [] });
            return jsonResponse({});
        },
    });
    env.addElement('chart-203.0.113.8');
    const firstDom = env.document.getElementById('chart-203.0.113.8');
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        const { state } = mounted;
        await waitFor(() => env.scriptFor('echarts'), 'ECharts request');
        state.activeTab.value = 'probe';
        state.activeTab.value = 'nodes';
        const secondDom = env.addElement('chart-203.0.113.8');
        firstDom.isConnected = false;
        const instances = new Map();
        const disposed = [];
        const echarts = {
            init(dom) {
                const instance = {
                    dom,
                    options: [],
                    disposed: false,
                    setOption(option) { this.options.push(option); },
                    dispose() { this.disposed = true; disposed.push(this); },
                };
                instances.set(dom, instance);
                return instance;
            },
            getInstanceByDom(dom) {
                return instances.get(dom) || null;
            },
            graphic: { LinearGradient: class { constructor(...args) { this.args = args; } } },
        };
        env.resolveScript('echarts', 'echarts', echarts);
        await waitFor(() => instances.get(secondDom)?.options.length, 'render into new chart container');
        assert.equal(instances.has(firstDom), false);

        state.activeTab.value = 'probe';
        await flushMicrotasks();
        assert.equal(instances.get(secondDom)?.disposed, true);
        assert.equal(disposed.length, 1);
    } finally {
        mounted.unmount();
        env.cleanup();
    }
});

test('unmount invalidates pending realtime tickets, avoids new sockets, and stops proxy polling', async () => {
    const ticket = deferred();
    const env = installRuntimeEnvironment({
        session: { kui_user: 'admin', kui_auth_key: 'token', kui_role: 'admin' },
        local: { monitor_preferred_tab: 'nodes' },
        fetch: async url => {
            if (url === '/api/data') {
                return jsonResponse({ servers: [], nodes: [], users: [], groups: [], securityWarnings: [], realtimeUrl: 'https://realtime.example' });
            }
            if (url === 'https://realtime.example/dashboard/ticket') return ticket.promise;
            if (url.startsWith('/api/probe/')) return jsonResponse({ settings: {}, servers: [] });
            return jsonResponse({});
        },
    });
    const mounted = mountKuiState();
    try {
        await flushMicrotasks();
        await waitFor(() => env.fetchCalls.some(call => call.url === 'https://realtime.example/dashboard/ticket'), 'realtime ticket request');
        mounted.unmount();
        ticket.resolve(jsonResponse({ ticket: 'late-ticket' }));
        await flushMicrotasks();
        assert.equal(FakeWebSocket.instances.length, 0);
        assert.ok(pcStopProxy);
    } finally {
        env.cleanup();
    }
});

test('useKuiState lazy-loads every external dependency through externalDeps', () => {
    assert.match(state, /import \{ ensureChartJs, ensureEcharts, ensureLeaflet, ensureQrious, ensureTweetNacl \} from '\.\.\/utils\/externalDeps\.js';/);
    for (const loader of ['ensureChartJs', 'ensureEcharts', 'ensureLeaflet', 'ensureQrious', 'ensureTweetNacl']) {
        assert.match(state, new RegExp(`await ${loader}\\(\\)`));
    }
    assert.match(state, /let Chart;[\s\S]{0,120}Chart = await ensureChartJs\(\);/);
    assert.match(state, /echarts = await ensureEcharts\(\);/);
    assert.match(state, /const QRious = await ensureQrious\(\);/);
    assert.match(state, /leafletLib = await ensureLeaflet\(\);/);
    assert.doesNotMatch(state, /window\.(?:echarts|Chart|QRious|nacl)\b|globalThis\.(?:echarts|Chart|QRious|nacl)\b/);

    assert.match(state, /document\.getElementById\('chart-' \+ vps\.ip\)/);
    assert.match(state, /activeTab\.value !== 'nodes'/);
    for (const chartId of ['probeChartCPU', 'probeChartRAM', 'probeChartProc', 'probeChartNet', 'probeChartConn', 'probeChartPing']) {
        assert.match(state, new RegExp(`'${chartId}'`));
    }
    assert.match(state, /const reqId = \+\+qrRequestId;/);
    assert.match(state, /reqId !== qrRequestId/);
    assert.match(state, /const needsRealityKeyGen =/);
    assert.match(state, /needsRealityKeyGen\(newNodeParams\[ip\]\)/);
    assert.match(state, /needsRealityKeyGen\(nodeEditDrafts\[node\.id\]\)/);
    assert.match(state, /await ensureTweetNacl\(\);[\s\S]{0,700}buildNodePayload\(ip, newNodeParams\[ip\]/);
    assert.match(state, /await ensureTweetNacl\(\);[\s\S]{0,700}buildNodePayload\(node\.vps_ip, nodeEditDrafts\[node\.id\], node\.id\)/);
});

test('useKuiState keeps theme injection, map retries, and chart race handling', () => {
    assert.match(state, /styleTag\.textContent = css;/);
    assert.doesNotMatch(state, /mapInitialized/);
    assert.match(state, /let mapInitPromise = null;/);
    assert.match(state, /leafletLib = await ensureLeaflet\(\)/);
    assert.match(state, /const L = leafletLib \|\| window\.L;/);
    assert.match(state, /myMapContainer === container[\s\S]{0,80}myMap\.invalidateSize\(\)[\s\S]{0,80}drawMarkers\(\)/);
    assert.match(state, /const initProbeDetailCharts = async \(expectedId = probeDetailId\.value\)/);
    assert.match(state, /await initProbeDetailCharts\(id\)[\s\S]{0,250}probeDetail\.value\?\.id === id[\s\S]{0,100}updateProbeDetailCharts\(probeDetail\.value\)/);
    assert.match(state, /const destroyProbeDetailCharts = \(\) => \{/);
    assert.match(state, /watch\(probeDetailId, value => \{ if \(value === null\) destroyProbeDetailCharts\(\); \}\);/);
});

test('useKuiState cleans up listeners, timers, sockets, charts, and maps', () => {
    const returnBlock = state.slice(state.lastIndexOf('\n                  return {'));
    assert.equal((returnBlock.match(/\bcopyPurgeCommand\b/g) || []).length, 1);
    assert.equal((state.match(/onBeforeUnmount\(/g) || []).length, 1);
    assert.match(state, /let isUnmounted = false;/);
    assert.match(state, /const handleVisibilityChange = \(\) => \{/);
    assert.match(state, /onMounted\(async \(\) => \{\s*document\.addEventListener\('visibilitychange', handleVisibilityChange\);/);
    assert.match(
        state,
        /onBeforeUnmount\(\(\) => \{[\s\S]*?isUnmounted = true;[\s\S]*?abortRealtimeTicket\(\);[\s\S]*?document\.removeEventListener\('visibilitychange', handleVisibilityChange\);[\s\S]*?systemColorQuery\.removeEventListener\('change', syncSystemColor\);[\s\S]*?clearTimeout\(proxyInitTimer\);[\s\S]*?pcStopProxy\(\);[\s\S]*?stopPolling\(\);[\s\S]*?stopProbePolling\(\);[\s\S]*?disposeKuiCharts\(\);[\s\S]*?destroyProbeDetailCharts\(\);[\s\S]*?destroyMap\(\);/,
    );
});
