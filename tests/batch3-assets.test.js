import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { beforeEach } from 'node:test';
import viteConfig from '../vite.config.js';
import {
  EXTERNAL_DEPS,
  ensureChartJs,
  ensureEcharts,
  ensureGoogleFonts,
  ensureLeaflet,
  ensureQrious,
  ensureTweetNacl,
  loadExternalScript,
  loadExternalStylesheet,
  resetExternalDepsStateForTest,
} from '../frontend/src/utils/externalDeps.js';
import {
  ensureRealityKeysReady,
  generateRealityKeys,
  generateRealityKeysAsync,
} from '../frontend/src/composables/useAuth.js';

const cloudflareHook = module.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
      return {
        url: 'data:text/javascript,export class DurableObject%20{%20constructor(ctx,state)%20{%20this.ctx=ctx;this.env=state;%20}%20}',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const workerModule = await import('../src/worker.js');
const worker = workerModule.default;
const { normalizeStaticPathname } = workerModule;
cloudflareHook.deregister();

class MockElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.dataset = {};
  }

  setAttribute(name, value) {
    const normalized = String(name).toLowerCase();
    this.attributes.set(normalized, String(value));
    if (normalized === 'data-kui-dep') this.dataset.kuiDep = String(value);
    if (normalized === 'data-kui-loaded') this.dataset.kuiLoaded = String(value);
  }

  getAttribute(name) {
    const normalized = String(name).toLowerCase();
    return this.attributes.has(normalized) ? this.attributes.get(normalized) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase());
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener({ type, target: this, currentTarget: this });
    }
  }

  querySelectorAll(selector) {
    const tags = new Set(selector.split(',').map(value => value.trim().toLowerCase()));
    const matches = [];
    const visit = node => {
      for (const child of node.children) {
        if (tags.has(child.localName)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

class MockDocument {
  constructor() {
    this.head = new MockElement('head');
    this.body = new MockElement('body');
  }

  createElement(tagName) {
    return new MockElement(tagName);
  }

  querySelectorAll(selector) {
    return [...this.head.querySelectorAll(selector), ...this.body.querySelectorAll(selector)];
  }
}

function makeDom() {
  return { doc: new MockDocument(), win: {} };
}

function makeImmutableHeaders(headers) {
  const immutable = new Headers(headers);
  for (const method of ['append', 'delete', 'set']) {
    Object.defineProperty(immutable, method, {
      configurable: true,
      value() {
        throw new TypeError("Can't modify immutable headers");
      },
    });
  }
  return immutable;
}

function makeNacl() {
  return {
    box: {
      keyPair: () => ({
        secretKey: new Uint8Array(32).fill(7),
        publicKey: new Uint8Array(32).fill(9),
      }),
    },
  };
}

function scripts(doc) {
  return doc.querySelectorAll('script');
}

function stylesheets(doc) {
  return doc.querySelectorAll('link');
}

function createScript(doc, spec, {
  dep,
  url = spec.url,
  integrity = spec.integrity,
  crossOrigin = spec.crossOrigin,
  loaded = false,
} = {}) {
  const script = doc.createElement('script');
  if (dep) script.setAttribute('data-kui-dep', dep);
  if (url) script.setAttribute('src', url);
  if (integrity) script.setAttribute('integrity', integrity);
  if (crossOrigin) script.setAttribute('crossorigin', crossOrigin);
  if (loaded) script.setAttribute('data-kui-loaded', 'true');
  doc.head.appendChild(script);
  return script;
}

function createStylesheet(doc, spec, {
  dep,
  href = spec.url,
  integrity = spec.integrity,
  crossOrigin = spec.crossOrigin,
  loaded = false,
} = {}) {
  const link = doc.createElement('link');
  link.setAttribute('rel', 'stylesheet');
  if (dep) link.setAttribute('data-kui-dep', dep);
  if (href) link.setAttribute('href', href);
  if (integrity) link.setAttribute('integrity', integrity);
  if (crossOrigin) link.setAttribute('crossorigin', crossOrigin);
  if (loaded) link.setAttribute('data-kui-loaded', 'true');
  doc.head.appendChild(link);
  return link;
}

beforeEach(() => {
  resetExternalDepsStateForTest();
});

test('external dependency definitions preserve CDN URLs, SRI, and anonymous CORS', () => {
  const scriptSpecs = [
    EXTERNAL_DEPS.tweetnacl,
    EXTERNAL_DEPS.echarts,
    EXTERNAL_DEPS.qrious,
    EXTERNAL_DEPS.chartjs,
    EXTERNAL_DEPS.leaflet.js,
  ];
  assert.equal(scriptSpecs.length, 5);
  for (const spec of scriptSpecs) {
    assert.match(spec.url, /^https:\/\//);
    assert.match(spec.integrity, /^sha384-/);
    assert.equal(spec.crossOrigin, 'anonymous');
  }

  assert.equal(EXTERNAL_DEPS.tweetnacl.url, 'https://unpkg.com/tweetnacl@1.0.3/nacl-fast.min.js');
  assert.equal(EXTERNAL_DEPS.tweetnacl.integrity, 'sha384-05+sicyRJQ56XpL4U9HJ8YbtSzFDvAg7apPKOGV6A0JsAJKFM68jp5oLnUjG5mEp');
  assert.equal(EXTERNAL_DEPS.echarts.global, 'echarts');
  assert.equal(EXTERNAL_DEPS.qrious.global, 'QRious');
  assert.equal(EXTERNAL_DEPS.chartjs.global, 'Chart');
  assert.equal(EXTERNAL_DEPS.leaflet.js.global, 'L');
  assert.match(EXTERNAL_DEPS.leaflet.css.integrity, /^sha384-/);
  assert.equal(EXTERNAL_DEPS.leaflet.css.crossOrigin, 'anonymous');
  assert.equal(
    EXTERNAL_DEPS.googleFonts.css.url,
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap',
  );
});

test('loadExternalScript applies SRI and CORS attributes to inserted scripts', async () => {
  const { doc, win } = makeDom();
  const promise = loadExternalScript(EXTERNAL_DEPS.tweetnacl, { doc, win, timeoutMs: 1000 });
  const [script] = scripts(doc);
  assert.equal(script.getAttribute('src'), EXTERNAL_DEPS.tweetnacl.url);
  assert.equal(script.getAttribute('integrity'), EXTERNAL_DEPS.tweetnacl.integrity);
  assert.equal(script.integrity, EXTERNAL_DEPS.tweetnacl.integrity);
  assert.equal(script.getAttribute('crossorigin'), 'anonymous');
  assert.equal(script.crossOrigin, 'anonymous');
  assert.equal(script.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(script.referrerPolicy, 'no-referrer');

  win.nacl = makeNacl();
  script.dispatch('load');
  assert.equal(await promise, win.nacl);
});

test('loadExternalStylesheet applies integrity and CORS attributes', async () => {
  const { doc, win } = makeDom();
  const promise = loadExternalStylesheet(EXTERNAL_DEPS.leaflet.css, { doc, win, timeoutMs: 1000 });
  const [link] = stylesheets(doc);
  assert.equal(link.getAttribute('href'), EXTERNAL_DEPS.leaflet.css.url);
  assert.equal(link.getAttribute('integrity'), EXTERNAL_DEPS.leaflet.css.integrity);
  assert.equal(link.getAttribute('crossorigin'), 'anonymous');
  link.dispatch('load');
  assert.equal(await promise, link);
});

test('concurrent calls share one in-flight promise and one DOM element', async () => {
  const { doc, win } = makeDom();
  const first = loadExternalScript(EXTERNAL_DEPS.echarts, { doc, win, timeoutMs: 1000 });
  const second = loadExternalScript(EXTERNAL_DEPS.echarts, { doc, win, timeoutMs: 1000 });
  assert.equal(first, second);
  assert.equal(scripts(doc).length, 1);

  win.echarts = { init() {} };
  scripts(doc)[0].dispatch('load');
  assert.equal(await first, win.echarts);
});

test('an unverified global is ignored until the loader verifies a matching SRI script', async () => {
  const { doc, win } = makeDom();
  win.Chart = function Chart() {};
  const promise = ensureChartJs({ doc, win, timeoutMs: 1000 });
  const [script] = scripts(doc);
  assert.equal(scripts(doc).length, 1);
  assert.equal(script.getAttribute('src'), EXTERNAL_DEPS.chartjs.url);
  assert.equal(script.getAttribute('integrity'), EXTERNAL_DEPS.chartjs.integrity);
  assert.equal(script.getAttribute('crossorigin'), 'anonymous');
  script.dispatch('load');
  assert.equal(await promise, win.Chart);

  const count = scripts(doc).length;
  assert.equal(await ensureChartJs({ doc, win, timeoutMs: 1000 }), win.Chart);
  assert.equal(scripts(doc).length, count);
});

test('a global backed by an exact URL, SRI, and anonymous DOM tag is accepted', async () => {
  const { doc, win } = makeDom();
  win.Chart = function Chart() {};
  createScript(doc, EXTERNAL_DEPS.chartjs, { dep: 'chartjs', loaded: true });
  assert.equal(await ensureChartJs({ doc, win, timeoutMs: 1000 }), win.Chart);
  assert.equal(scripts(doc).length, 1);
});

test('an existing unloaded script does not make its same-named global trusted', async () => {
  const { doc, win } = makeDom();
  win.Chart = function Chart() {};
  const existing = createScript(doc, EXTERNAL_DEPS.chartjs, { dep: 'chartjs' });
  let settled = false;
  const promise = ensureChartJs({ doc, win, timeoutMs: 1000 }).then(value => {
    settled = true;
    return value;
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(scripts(doc).length, 1);
  existing.dispatch('load');
  assert.equal(await promise, win.Chart);
});

test('existing scripts with wrong URL or incomplete SRI are not reused or mutated', async () => {
  const { doc, win } = makeDom();
  const wrongUrl = createScript(doc, EXTERNAL_DEPS.qrious, {
    dep: 'qrious',
    url: 'https://evil.example/qrious.js',
    integrity: null,
    crossOrigin: null,
  });
  const missingSri = createScript(doc, EXTERNAL_DEPS.qrious, {
    dep: 'qrious',
    integrity: null,
    crossOrigin: null,
  });
  const wrongCors = createScript(doc, EXTERNAL_DEPS.qrious, {
    dep: 'qrious',
    crossOrigin: 'use-credentials',
  });

  const promise = loadExternalScript(EXTERNAL_DEPS.qrious, { doc, win, timeoutMs: 1000 });
  assert.equal(scripts(doc).length, 4);
  const added = scripts(doc).find(script => ![wrongUrl, missingSri, wrongCors].includes(script));
  assert.equal(added.getAttribute('src'), EXTERNAL_DEPS.qrious.url);
  assert.equal(added.getAttribute('integrity'), EXTERNAL_DEPS.qrious.integrity);
  assert.equal(added.getAttribute('crossorigin'), 'anonymous');
  assert.equal(wrongUrl.getAttribute('integrity'), null);
  assert.equal(missingSri.getAttribute('integrity'), null);
  assert.equal(wrongCors.getAttribute('crossorigin'), 'use-credentials');

  win.QRious = function QRious() {};
  added.dispatch('load');
  assert.equal(await promise, win.QRious);
});

test('existing scripts with exact URL, SRI, and anonymous CORS are reused', async () => {
  const { doc, win } = makeDom();
  const existing = createScript(doc, EXTERNAL_DEPS.qrious, { dep: 'qrious' });
  const promise = loadExternalScript(EXTERNAL_DEPS.qrious, { doc, win, timeoutMs: 1000 });
  assert.equal(scripts(doc).length, 1);
  win.QRious = function QRious() {};
  existing.dispatch('load');
  assert.equal(await promise, win.QRious);
});

test('existing stylesheets require exact href and SRI before reuse', async () => {
  const { doc, win } = makeDom();
  const wrongHref = createStylesheet(doc, EXTERNAL_DEPS.leaflet.css, {
    dep: 'leaflet-css',
    href: 'https://evil.example/leaflet.css',
    integrity: null,
    crossOrigin: null,
  });
  const missingSri = createStylesheet(doc, EXTERNAL_DEPS.leaflet.css, {
    dep: 'leaflet-css',
    integrity: null,
    crossOrigin: null,
  });

  const promise = loadExternalStylesheet(EXTERNAL_DEPS.leaflet.css, { doc, win, timeoutMs: 1000 });
  assert.equal(stylesheets(doc).length, 3);
  const added = stylesheets(doc).find(link => ![wrongHref, missingSri].includes(link));
  assert.equal(added.getAttribute('href'), EXTERNAL_DEPS.leaflet.css.url);
  assert.equal(added.getAttribute('integrity'), EXTERNAL_DEPS.leaflet.css.integrity);
  assert.equal(added.getAttribute('crossorigin'), 'anonymous');
  assert.equal(wrongHref.getAttribute('integrity'), null);
  assert.equal(missingSri.getAttribute('integrity'), null);

  added.dispatch('load');
  assert.equal(await promise, added);
});

test('existing stylesheets with exact href, SRI, and anonymous CORS are reused', async () => {
  const { doc, win } = makeDom();
  const existing = createStylesheet(doc, EXTERNAL_DEPS.leaflet.css, { dep: 'leaflet-css' });
  const promise = loadExternalStylesheet(EXTERNAL_DEPS.leaflet.css, { doc, win, timeoutMs: 1000 });
  assert.equal(stylesheets(doc).length, 1);
  await new Promise(resolve => setImmediate(resolve));
  existing.dispatch('load');
  assert.equal(await promise, existing);
});

test('an unloaded existing stylesheet resolves only after its load event', async () => {
  const { doc, win } = makeDom();
  const existing = createStylesheet(doc, EXTERNAL_DEPS.leaflet.css, { dep: 'leaflet-css' });
  let settled = false;
  const promise = loadExternalStylesheet(EXTERNAL_DEPS.leaflet.css, { doc, win, timeoutMs: 1000 })
    .then(value => {
      settled = true;
      return value;
    });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  existing.dispatch('load');
  assert.equal(await promise, existing);
});

test('a preload link with matching URL and SRI is not reused as a stylesheet', async () => {
  const { doc, win } = makeDom();
  const preload = doc.createElement('link');
  preload.setAttribute('rel', 'preload');
  preload.setAttribute('as', 'style');
  preload.setAttribute('href', EXTERNAL_DEPS.leaflet.css.url);
  preload.setAttribute('integrity', EXTERNAL_DEPS.leaflet.css.integrity);
  preload.setAttribute('crossorigin', 'anonymous');
  doc.head.appendChild(preload);

  const promise = loadExternalStylesheet(EXTERNAL_DEPS.leaflet.css, { doc, win, timeoutMs: 1000 });
  assert.equal(stylesheets(doc).length, 2);
  const stylesheet = stylesheets(doc).find(link => link !== preload);
  assert.equal(stylesheet.getAttribute('rel'), 'stylesheet');
  assert.equal(stylesheet.getAttribute('href'), EXTERNAL_DEPS.leaflet.css.url);
  stylesheet.dispatch('load');
  assert.equal(await promise, stylesheet);
});

test('verified dependency trust is bound to the exact URL and SRI spec', async () => {
  const { doc, win } = makeDom();
  const promise = loadExternalScript(EXTERNAL_DEPS.chartjs, { doc, win, timeoutMs: 1000 });
  win.Chart = function Chart() {};
  scripts(doc)[0].dispatch('load');
  assert.equal(await promise, win.Chart);

  const changed = { ...EXTERNAL_DEPS.chartjs, url: 'https://evil.example/chart.js' };
  const changedPromise = loadExternalScript(changed, { doc, win, timeoutMs: 1000 });
  assert.equal(scripts(doc).length, 2);
  assert.equal(scripts(doc)[1].getAttribute('src'), changed.url);
  scripts(doc)[1].dispatch('error');
  await assert.rejects(changedPromise, /failed to load/i);
});

test('concurrent loads with conflicting URLs do not share an in-flight promise', async () => {
  const { doc, win } = makeDom();
  const changed = { ...EXTERNAL_DEPS.chartjs, url: 'https://evil.example/chart.js' };
  const trusted = loadExternalScript(EXTERNAL_DEPS.chartjs, { doc, win, timeoutMs: 1000 });
  const untrusted = loadExternalScript(changed, { doc, win, timeoutMs: 1000 });
  assert.notEqual(trusted, untrusted);
  assert.equal(scripts(doc).length, 2);
  const inserted = scripts(doc);
  assert.deepEqual(
    inserted.map(script => script.getAttribute('src')).sort(),
    [EXTERNAL_DEPS.chartjs.url, changed.url].sort(),
  );

  win.Chart = function Chart() {};
  for (const script of inserted) script.dispatch('load');
  assert.equal(await trusted, win.Chart);
  assert.equal(await untrusted, win.Chart);
});

test('a failed script load removes its element and allows a clean retry', async () => {
  const { doc, win } = makeDom();
  const first = loadExternalScript(EXTERNAL_DEPS.chartjs, { doc, win, timeoutMs: 1000 });
  const [failed] = scripts(doc);
  failed.dispatch('error');
  await assert.rejects(first, /failed to load/i);
  assert.equal(failed.parentNode, null);
  assert.equal(scripts(doc).length, 0);

  const second = loadExternalScript(EXTERNAL_DEPS.chartjs, { doc, win, timeoutMs: 1000 });
  assert.notEqual(second, first);
  const [retried] = scripts(doc);
  assert.notEqual(retried, failed);
  win.Chart = function Chart() {};
  retried.dispatch('load');
  assert.equal(await second, win.Chart);
});

test('a loaded script without its global symbol is removed and can be retried', async () => {
  const { doc, win } = makeDom();
  const first = loadExternalScript(EXTERNAL_DEPS.tweetnacl, { doc, win, timeoutMs: 1000 });
  const [failed] = scripts(doc);
  failed.dispatch('load');
  await assert.rejects(first, /global.*nacl|nacl.*global/i);
  assert.equal(failed.parentNode, null);

  const second = loadExternalScript(EXTERNAL_DEPS.tweetnacl, { doc, win, timeoutMs: 1000 });
  const [retried] = scripts(doc);
  win.nacl = makeNacl();
  retried.dispatch('load');
  assert.equal(await second, win.nacl);
});

test('a timed out script load removes its element and clears in-flight state', async () => {
  const { doc, win } = makeDom();
  const first = loadExternalScript(EXTERNAL_DEPS.echarts, { doc, win, timeoutMs: 10 });
  const [timedOut] = scripts(doc);
  await assert.rejects(first, /timed out/i);
  assert.equal(timedOut.parentNode, null);

  const second = loadExternalScript(EXTERNAL_DEPS.echarts, { doc, win, timeoutMs: 1000 });
  assert.notEqual(second, first);
  const [retried] = scripts(doc);
  win.echarts = { init() {} };
  retried.dispatch('load');
  assert.equal(await second, win.echarts);
});

test('ensureLeaflet waits for both stylesheet and script, even when L already exists', async () => {
  const firstDom = makeDom();
  const first = ensureLeaflet({ ...firstDom, timeoutMs: 1000 });
  const [leafletScript] = scripts(firstDom.doc);
  const [leafletStyle] = stylesheets(firstDom.doc);
  assert.equal(leafletScript.getAttribute('src'), EXTERNAL_DEPS.leaflet.js.url);
  assert.equal(leafletStyle.getAttribute('href'), EXTERNAL_DEPS.leaflet.css.url);
  firstDom.win.L = { map() {} };
  leafletStyle.dispatch('load');
  leafletScript.dispatch('load');
  assert.equal(await first, firstDom.win.L);

  const secondDom = makeDom();
  secondDom.win.L = { map() {} };
  const second = ensureLeaflet({ ...secondDom, timeoutMs: 1000 });
  assert.equal(scripts(secondDom.doc).length, 0);
  assert.equal(stylesheets(secondDom.doc).length, 1);
  stylesheets(secondDom.doc)[0].dispatch('load');
  assert.equal(await second, secondDom.win.L);

  const thirdDom = makeDom();
  thirdDom.win.L = { map() {} };
  createStylesheet(thirdDom.doc, EXTERNAL_DEPS.leaflet.css, { dep: 'leaflet-css', loaded: true });
  createScript(thirdDom.doc, EXTERNAL_DEPS.leaflet.js, { dep: 'leaflet-js', loaded: true });
  const third = ensureLeaflet({ ...thirdDom, timeoutMs: 1000 });
  assert.equal(scripts(thirdDom.doc).length, 1);
  assert.equal(stylesheets(thirdDom.doc).length, 1);
  scripts(thirdDom.doc)[0].dispatch('load');
  stylesheets(thirdDom.doc)[0].dispatch('load');
  assert.equal(await third, thirdDom.win.L);
});

test('ensureGoogleFonts silently degrades on failure and permits retry', async () => {
  const { doc, win } = makeDom();
  const first = ensureGoogleFonts({ doc, win, timeoutMs: 1000 });
  const [failed] = stylesheets(doc);
  failed.dispatch('error');
  await assert.doesNotReject(first);
  assert.equal(failed.parentNode, null);

  const second = ensureGoogleFonts({ doc, win, timeoutMs: 1000 });
  const [retried] = stylesheets(doc);
  assert.notEqual(retried, failed);
  retried.dispatch('load');
  assert.equal(await second, retried);
});

test('Reality key helpers load TweetNaCl on demand and preserve synchronous errors', async () => {
  const originalWindow = globalThis.window;
  try {
    globalThis.window = {};
    assert.throws(() => generateRealityKeys(), /TweetNaCl is not loaded/);

    const { doc, win } = makeDom();
    const ready = ensureRealityKeysReady({ doc, win, timeoutMs: 1000 });
    const [script] = scripts(doc);
    win.nacl = makeNacl();
    script.dispatch('load');
    assert.equal(await ready, win.nacl);

    resetExternalDepsStateForTest();
    const asyncKeys = generateRealityKeysAsync({ doc, win, timeoutMs: 1000 });
    const [asyncScript] = scripts(doc);
    asyncScript.dispatch('load');
    const keys = await asyncKeys;
    assert.match(keys.privateKey, /^[A-Za-z0-9_-]{43}$/);
    assert.match(keys.publicKey, /^[A-Za-z0-9_-]{43}$/);
    assert.match(keys.shortId, /^[A-Za-z0-9_-]{16}$/);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('frontend HTML no longer blocks on CDN libraries or inline event handlers', () => {
  const html = fs.readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=["']https?:/i);
  assert.doesNotMatch(html, /<link\b[^>]*\bhref=["'][^"']*leaflet[^"']*["'][^>]*>/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.match(html, /href="\/tailwind\.css"/);
  assert.match(html, /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/);
  assert.match(html, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/);

  for (const link of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/href=["']https?:/i.test(link[0])) continue;
    assert.doesNotMatch(link[0], /\brel=["']stylesheet["']/i);
  }

  assert.match(main, /createApp\(App\)\.mount\('#app'\)[\s\S]*ensureGoogleFonts\(\)\.catch\(\(\)\s*=>\s*\{\}\)/);
  assert.match(main, /requestIdleCallback/);
});

test('Vite emits hashed assets and incrementally cleans only stale ui-assets files', () => {
  const output = viteConfig.build.rollupOptions.output;
  assert.equal(output.entryFileNames, 'ui-assets/[name]-[hash].js');
  assert.equal(output.chunkFileNames, 'ui-assets/[name]-[hash].js');
  assert.equal(output.assetFileNames, 'ui-assets/[name]-[hash][extname]');

  const cleanPlugin = viteConfig.plugins.find(plugin => plugin.name === 'clean-ui-assets');
  assert.ok(cleanPlugin);
  assert.equal(cleanPlugin.apply, 'build');
  assert.equal(typeof cleanPlugin.configResolved, 'function');
  assert.equal(typeof cleanPlugin.buildStart, 'function');
  assert.equal(typeof cleanPlugin.writeBundle, 'function');

  const source = fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(source, /buildStart/);
  assert.match(source, /writeBundle/);
  assert.doesNotMatch(source, /rmSync\([^)]*(?:static|vps|tailwind|index\.html)/s);

  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['clean:ui-assets'], undefined);
  assert.equal(pkg.scripts.build, 'npm run build:css && vite build');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kui-ui-clean-'));
  try {
    const uiAssets = path.join(tempRoot, 'ui-assets');
    fs.mkdirSync(uiAssets, { recursive: true });
    fs.writeFileSync(path.join(uiAssets, 'index-new-AbCd1234.js'), 'new');
    fs.writeFileSync(path.join(uiAssets, 'index-old-AbCd1234.js'), 'old');
    fs.writeFileSync(path.join(tempRoot, 'tailwind.css'), 'tailwind');
    cleanPlugin.configResolved({ build: { outDir: tempRoot } });
    cleanPlugin.writeBundle({ dir: tempRoot }, {
      'ui-assets/index-new-AbCd1234.js': {},
    });
    assert.equal(fs.existsSync(path.join(uiAssets, 'index-new-AbCd1234.js')), true);
    assert.equal(fs.existsSync(path.join(uiAssets, 'index-old-AbCd1234.js')), false);
    assert.equal(fs.existsSync(path.join(tempRoot, 'tailwind.css')), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kui-ui-outside-'));
  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kui-ui-symlink-'));
  try {
    fs.writeFileSync(path.join(outsideRoot, 'keep.js'), 'outside');
    fs.symlinkSync(outsideRoot, path.join(symlinkRoot, 'ui-assets'), 'dir');
    cleanPlugin.configResolved({ build: { outDir: symlinkRoot } });
    assert.throws(
      () => cleanPlugin.buildStart(),
      /symbolic link|symlink|symbolic/i,
    );
    assert.throws(
      () => cleanPlugin.writeBundle({ dir: symlinkRoot }, {}),
      /symbolic link|symlink|symbolic/i,
    );
    assert.equal(fs.existsSync(path.join(outsideRoot, 'keep.js')), true);
  } finally {
    fs.rmSync(symlinkRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test('Vite refuses a ui-assets symlink into static/vps before writing or cleaning', () => {
  const cleanPlugin = viteConfig.plugins.find(plugin => plugin.name === 'clean-ui-assets');
  assert.ok(cleanPlugin);
  assert.equal(typeof cleanPlugin.buildStart, 'function');

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kui-ui-vps-link-'));
  try {
    const vpsDir = path.join(tempRoot, 'vps');
    fs.mkdirSync(vpsDir, { recursive: true });
    fs.writeFileSync(path.join(vpsDir, 'install.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(vpsDir, 'agent.py'), 'print("agent")\n');
    fs.symlinkSync(vpsDir, path.join(tempRoot, 'ui-assets'), 'dir');
    cleanPlugin.configResolved({ build: { outDir: tempRoot } });

    assert.throws(
      () => cleanPlugin.buildStart(),
      /symbolic link|symlink|symbolic/i,
    );
    assert.throws(
      () => cleanPlugin.writeBundle({ dir: tempRoot }, {}),
      /symbolic link|symlink|symbolic/i,
    );
    assert.equal(fs.readFileSync(path.join(vpsDir, 'install.sh'), 'utf8'), '#!/bin/sh\n');
    assert.equal(fs.readFileSync(path.join(vpsDir, 'agent.py'), 'utf8'), 'print("agent")\n');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function assetResponse(status, contentType, cacheControl) {
  const noBody = status === 204 || status === 205 || status === 304;
  return new Response(noBody ? null : 'asset', {
    status,
    headers: {
      'Content-Type': contentType,
      ...(cacheControl ? { 'Cache-Control': cacheControl } : {}),
    },
  });
}

async function fetchAsset(pathname, {
  method = 'GET',
  status = 200,
  contentType = 'application/javascript',
  cacheControl,
} = {}) {
  const env = {
    ASSETS: {
      fetch: async request => {
        assert.equal(new URL(request.url).pathname, pathname);
        return assetResponse(status, contentType, cacheControl);
      },
    },
  };
  return worker.fetch(new Request(`https://example.com${pathname}`, { method }), env, { waitUntil() {} });
}

async function fetchWithoutAssets(pathname, { method = 'GET' } = {}) {
  let assetsCalls = 0;
  const env = {
    ASSETS: {
      fetch: async () => {
        assetsCalls += 1;
        return assetResponse(200, 'text/plain');
      },
    },
  };
  const response = await worker.fetch(
    new Request(`https://example.com${pathname}`, { method }),
    env,
    { waitUntil() {} },
  );
  return { response, assetsCalls };
}

function assertSecurityHeaders(response) {
  assert.match(response.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Referrer-Policy'), 'same-origin');
  assert.match(response.headers.get('Permissions-Policy'), /camera=\(\)/);
}

test('Worker hardened HEAD error and fallback responses never expose a body', async () => {
  const makeRequest = pathname => new Request(`https://example.com${pathname}`, { method: 'HEAD' });
  const scenarios = [
    {
      label: 'private vps route',
      request: makeRequest('/vps'),
      env: {},
      expectedStatus: 404,
      expectedContentType: 'text/plain; charset=utf-8',
      expectedCacheControl: 'no-store',
    },
    {
      label: 'missing assets binding',
      request: makeRequest('/'),
      env: {},
      expectedStatus: 200,
      expectedContentType: 'text/html; charset=utf-8',
      expectedCacheControl: null,
    },
    {
      label: 'assets fetch failure',
      request: makeRequest('/'),
      env: {
        ASSETS: {
          fetch: async () => {
            throw new Error('assets unavailable');
          },
        },
      },
      expectedStatus: 503,
      expectedContentType: 'text/html; charset=utf-8',
      expectedCacheControl: null,
    },
  ];

  for (const scenario of scenarios) {
    const response = await worker.fetch(scenario.request, scenario.env, { waitUntil() {} });
    assert.equal(response.status, scenario.expectedStatus, scenario.label);
    assert.equal(response.body, null, scenario.label);
    assert.equal(response.headers.get('Content-Type'), scenario.expectedContentType, scenario.label);
    assert.equal(response.headers.get('Cache-Control'), scenario.expectedCacheControl, scenario.label);
    assertSecurityHeaders(response);
  }
});

test('Worker caches hashed ui-assets immutably and preserves security headers', async () => {
  for (const pathname of ['/ui-assets/index-AbCd1234.js', '/ui-assets/index-AbCd1234.css']) {
    const response = await fetchAsset(pathname);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    assertSecurityHeaders(response);
  }
});

test('Worker static responses are constructed only once after cache and security headers', () => {
  const source = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  const route = source.slice(source.indexOf('await env.ASSETS.fetch(request)'), source.indexOf('} catch (e)'));
  assert.equal((route.match(/new Response\(/g) || []).length, 1);
});

test('Worker revalidates HTML entries and does not cache other static files immutably', async () => {
  for (const pathname of ['/', '/index.html']) {
    const response = await fetchAsset(pathname, { contentType: 'text/html; charset=utf-8' });
    assert.equal(response.headers.get('Cache-Control'), 'no-cache, must-revalidate');
  }

  const tailwind = await fetchAsset('/tailwind.css', { contentType: 'text/css' });
  assert.doesNotMatch(tailwind.headers.get('Cache-Control') || '', /immutable/i);
});

test('Worker never marks missing ui-assets as immutable', async () => {
  const response = await fetchAsset('/ui-assets/missing-AbCd1234.js', {
    status: 404,
    contentType: 'text/plain',
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.doesNotMatch(response.headers.get('Cache-Control'), /immutable/i);
});

test('Worker applies static cache policy only to GET and HEAD', async () => {
  const post = await fetchAsset('/ui-assets/index-AbCd1234.js', { method: 'POST' });
  assert.equal(post.headers.get('Cache-Control'), null);

  const head = await fetchAsset('/ui-assets/index-AbCd1234.js', { method: 'HEAD' });
  assert.equal(head.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(head.body, null);
});

test('Worker handles 304, 204, and 205 responses without body construction errors', async () => {
  const env = {
    ASSETS: {
      fetch: async () => {
        return new Response(null, {
          status: 304,
          headers: { 'Content-Type': 'application/javascript', ETag: '"abc"' },
        });
      },
    },
  };
  const notModified = await worker.fetch(
    new Request('https://example.com/ui-assets/index-AbCd1234.js'),
    env,
    { waitUntil() {} },
  );
  assert.equal(notModified.status, 304);
  assert.equal(notModified.body, null);
  assert.equal(notModified.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(notModified.headers.get('ETag'), '"abc"');
  assertSecurityHeaders(notModified);

  for (const status of [204, 205]) {
    const response = await fetchAsset('/ui-assets/index-AbCd1234.js', { status });
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.doesNotMatch(response.headers.get('Cache-Control') || '', /immutable/i);
  }
});

test('Worker rebuilds immutable 304, 204, 205, and HEAD asset responses without mutating upstream', async () => {
  const scenarios = [
    { method: 'GET', pathname: '/ui-assets/index-AbCd1234.js', status: 304, contentType: 'application/javascript', expectedCache: 'public, max-age=31536000, immutable' },
    { method: 'GET', pathname: '/ui-assets/index-AbCd1234.js', status: 204, contentType: 'application/javascript' },
    { method: 'GET', pathname: '/ui-assets/index-AbCd1234.js', status: 205, contentType: 'application/javascript' },
    { method: 'HEAD', pathname: '/ui-assets/index-AbCd1234.js', status: 200, contentType: 'application/javascript', expectedCache: 'public, max-age=31536000, immutable' },
    { method: 'HEAD', pathname: '/', status: 200, contentType: 'text/html; charset=utf-8', expectedCache: 'no-cache, must-revalidate' },
  ];

  for (const scenario of scenarios) {
    let cancelCalled = false;
    const upstream = {
      status: scenario.status,
      statusText: 'Upstream',
      headers: makeImmutableHeaders({
        'Content-Type': scenario.contentType,
        ETag: '"immutable-etag"',
        'X-Upstream': 'preserved',
      }),
      body: {
        cancel() {
          cancelCalled = true;
          return Promise.resolve();
        },
      },
    };
    const env = {
      ASSETS: {
        fetch: async () => upstream,
      },
    };
    const response = await worker.fetch(
      new Request(`https://example.com${scenario.pathname}`, { method: scenario.method }),
      env,
      { waitUntil() {} },
    );

    assert.equal(response.status, scenario.status, scenario.method);
    assert.equal(response.statusText, 'Upstream', scenario.method);
    assert.equal(response.body, null, scenario.method);
    assert.equal(cancelCalled, true, scenario.method);
    assert.equal(response.headers.get('ETag'), '"immutable-etag"', scenario.method);
    assert.equal(response.headers.get('X-Upstream'), 'preserved', scenario.method);
    if (scenario.expectedCache) {
      assert.equal(response.headers.get('Cache-Control'), scenario.expectedCache, scenario.method);
    }
    assertSecurityHeaders(response);
  }
});

test('Worker preserves restrictive and error HTML cache policies', async () => {
  const htmlScenarios = [
    { pathname: '/', status: 200, cacheControl: 'private', expected: 'private' },
    { pathname: '/', status: 200, cacheControl: 'no-store', expected: 'no-store' },
    { pathname: '/', status: 200, cacheControl: 'private="x"', expected: 'private="x"' },
    { pathname: '/missing', status: 404, contentType: 'text/html; charset=utf-8' },
    { pathname: '/broken', status: 500, contentType: 'text/html; charset=utf-8' },
  ];

  for (const scenario of htmlScenarios) {
    const response = await fetchAsset(scenario.pathname, {
      status: scenario.status,
      contentType: scenario.contentType || 'text/html; charset=utf-8',
      cacheControl: scenario.cacheControl,
    });
    assert.equal(response.status, scenario.status, scenario.pathname);
    if (scenario.expected) {
      assert.equal(response.headers.get('Cache-Control'), scenario.expected, scenario.pathname);
    } else {
      assert.equal(response.headers.get('Cache-Control'), null, scenario.pathname);
    }
    assert.notEqual(response.headers.get('Cache-Control'), 'no-cache, must-revalidate', scenario.pathname);
  }
});

test('Worker respects parameterized private and no-cache directives on hashed assets', async () => {
  for (const cacheControl of ['private="foo"', 'no-cache="Set-Cookie"', 'no-store="anything"']) {
    const response = await fetchAsset('/ui-assets/index-AbCd1234.js', { cacheControl });
    assert.equal(response.headers.get('Cache-Control'), cacheControl);
    assert.doesNotMatch(response.headers.get('Cache-Control'), /immutable/i);
  }
});

test('Worker does not downgrade upstream no-store on broken ui-assets', async () => {
  for (const status of [404, 500]) {
    const response = await fetchAsset('/ui-assets/broken-AbCd1234.js', {
      status,
      contentType: 'text/plain',
      cacheControl: 'private, no-store',
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
});

test('SPA HTML fallback for a hashed asset path is revalidated, never immutable', async () => {
  for (const status of [200, 304]) {
    const response = await fetchAsset('/ui-assets/missing-AbCd1234.js', {
      status,
      contentType: 'text/html; charset=utf-8',
    });
    assert.equal(response.headers.get('Cache-Control'), 'no-cache, must-revalidate');
    assert.doesNotMatch(response.headers.get('Cache-Control'), /immutable/i);
  }
});

test('upstream private or no-store cache policies are preserved', async () => {
  for (const cacheControl of ['private, max-age=60', 'no-store', 'no-cache']) {
    const response = await fetchAsset('/ui-assets/index-AbCd1234.js', { cacheControl });
    assert.equal(response.headers.get('Cache-Control'), cacheControl);
    assert.doesNotMatch(response.headers.get('Cache-Control'), /immutable/i);
  }
});

test('static path normalization blocks encoded and collapsed VPS paths', async () => {
  assert.equal(normalizeStaticPathname('//vps/agent.py'), '/vps/agent.py');
  assert.equal(normalizeStaticPathname('/%76ps/agent.py'), '/vps/agent.py');
  assert.equal(normalizeStaticPathname('/%2e/vps/agent.py'), '/vps/agent.py');
  assert.equal(normalizeStaticPathname('/a/%2e%2e/vps/agent.py'), '/vps/agent.py');
  assert.equal(normalizeStaticPathname('/%ZZ'), null);

  for (const pathname of [
    '/vps/agent.py',
    '//vps/agent.py',
    '/%76ps/agent.py',
    '/./vps/agent.py',
    '/a/../vps/agent.py',
    '/%2e/vps/agent.py',
    '/a/%2e%2e/vps/agent.py',
    '/VPS/agent.py',
    '/VpS/agent.py',
  ]) {
    const { response, assetsCalls } = await fetchWithoutAssets(pathname);
    assert.equal(response.status, 404, pathname);
    assert.equal(response.headers.get('Cache-Control'), 'no-store', pathname);
    assert.equal(assetsCalls, 0, pathname);
    assertSecurityHeaders(response);
  }
});

test('malformed percent encoding returns 400 without touching assets', async () => {
  for (const pathname of ['/%E0%A4%A', '/%ZZ', '/ui-assets/%E0%A4%A.js']) {
    const { response, assetsCalls } = await fetchWithoutAssets(pathname);
    assert.equal(response.status, 400, pathname);
    assert.equal(response.headers.get('Cache-Control'), 'no-store', pathname);
    assert.equal(assetsCalls, 0, pathname);
    assertSecurityHeaders(response);
  }
});
