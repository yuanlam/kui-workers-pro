const DEFAULT_TIMEOUT_MS = 15000;
const inFlight = new Map();
const compositeInFlight = new Map();
const verifiedDependencies = new Set();

function scriptSpec(key, url, integrity, globalName) {
  return Object.freeze({
    key,
    type: 'script',
    url,
    integrity,
    crossOrigin: 'anonymous',
    global: globalName,
  });
}

function styleSpec(key, url, integrity) {
  return Object.freeze({
    key,
    type: 'stylesheet',
    url,
    ...(integrity ? { integrity, crossOrigin: 'anonymous' } : {}),
  });
}

export const EXTERNAL_DEPS = Object.freeze({
  tweetnacl: scriptSpec(
    'tweetnacl',
    'https://unpkg.com/tweetnacl@1.0.3/nacl-fast.min.js',
    'sha384-05+sicyRJQ56XpL4U9HJ8YbtSzFDvAg7apPKOGV6A0JsAJKFM68jp5oLnUjG5mEp',
    'nacl',
  ),
  echarts: scriptSpec(
    'echarts',
    'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js',
    'sha384-o5uz97et3bErHvpKfD4Jz4n0JfhJDWABFuF4NP+iEEDxE1VwMWJ19QGR0lqFZnr6',
    'echarts',
  ),
  qrious: scriptSpec(
    'qrious',
    'https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js',
    'sha384-Dr98ddmUw2QkdCarNQ+OL7xLty7cSxgR0T7v1tq4UErS/qLV0132sBYTolRAFuOV',
    'QRious',
  ),
  chartjs: scriptSpec(
    'chartjs',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js',
    'sha384-b0GXujLkk9eYYSmcSfoyZbfyElGAQnDyY0skCHSG6w3JgTMFnz11ggrTAr7seu9f',
    'Chart',
  ),
  leaflet: Object.freeze({
    js: scriptSpec(
      'leaflet-js',
      'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
      'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH',
      'L',
    ),
    css: styleSpec(
      'leaflet-css',
      'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
      'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H',
    ),
  }),
  googleFonts: Object.freeze({
    css: styleSpec(
      'google-fonts',
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap',
    ),
  }),
});

function normalizeSpec(spec, type) {
  if (typeof spec === 'string') {
    return { key: spec, dep: spec, type, url: spec };
  }
  const url = spec?.url || spec?.src || spec?.href;
  if (!spec || typeof url !== 'string' || !url) {
    throw new TypeError('External dependency spec must include a URL');
  }
  return {
    ...spec,
    type,
    key: spec.key || spec.name || url,
    url,
    dep: spec.dep || spec.key || spec.name || url,
  };
}

function resolveWindow(options) {
  return options.win ?? globalThis.window;
}

function resolveDocument(options) {
  return options.doc ?? globalThis.document;
}

function readGlobal(win, name) {
  if (!win || !name) return undefined;
  return name.split('.').reduce((value, key) => value?.[key], win);
}

function setAttribute(element, name, value) {
  if (typeof element.setAttribute === 'function') element.setAttribute(name, value);
  else element[name] = value;
}

function getAttribute(element, name) {
  if (typeof element.getAttribute === 'function') return element.getAttribute(name);
  return element[name] ?? null;
}

function collectElements(doc, tagName) {
  if (!doc) return [];
  if (typeof doc.querySelectorAll === 'function') {
    let matches = null;
    try {
      matches = Array.from(doc.querySelectorAll(tagName));
    } catch {
      matches = null;
    }
    if (matches?.length) return matches;
  }
  const roots = [doc.head, doc.body].filter(Boolean);
  for (const root of roots) {
    if (typeof root.querySelectorAll === 'function') {
      let matches = [];
      try {
        matches = Array.from(root.querySelectorAll(tagName));
      } catch {
        matches = [];
      }
      if (matches.length) return matches;
    }
  }
  return roots.flatMap(root => {
    const children = root.children?.length ? root.children : (root.childNodes || []);
    return Array.from(children);
  })
    .filter(element => String(element.tagName || element.localName || '').toLowerCase() === tagName);
}

function elementUrl(element, tagName) {
  const attribute = tagName === 'script' ? 'src' : 'href';
  return getAttribute(element, attribute) || element[attribute] || '';
}

function findExistingElement(doc, tagName, spec) {
  return collectElements(doc, tagName).find(element => {
    if (tagName === 'link') {
      const rel = getAttribute(element, 'rel') || element.rel || '';
      if (!String(rel).toLowerCase().split(/\s+/).includes('stylesheet')) return false;
    }
    if (elementUrl(element, tagName) !== spec.url) return false;
    if (!spec.integrity) return true;
    const integrity = element.integrity || getAttribute(element, 'integrity');
    const crossOrigin = element.crossOrigin || getAttribute(element, 'crossorigin');
    return integrity === spec.integrity && String(crossOrigin).toLowerCase() === 'anonymous';
  });
}

function isMarkedLoaded(element, tagName) {
  const marker = getAttribute(element, 'data-kui-loaded') ?? element.dataset?.kuiLoaded;
  return marker === true || marker === 'true' || marker === '' || (tagName === 'link' && Boolean(element.sheet));
}

function markLoaded(element) {
  setAttribute(element, 'data-kui-loaded', 'true');
  if (element.dataset) element.dataset.kuiLoaded = 'true';
}

function removeElement(element) {
  if (!element) return;
  const parent = element.parentNode || element.parentElement;
  if (parent?.removeChild) {
    parent.removeChild(element);
    return;
  }
  if (typeof element.remove === 'function') element.remove();
}

function applySecurityAttributes(element, spec) {
  if (spec.integrity) {
    element.integrity = spec.integrity;
    setAttribute(element, 'integrity', spec.integrity);
  }

  if (spec.integrity || spec.crossOrigin) {
    const crossOrigin = spec.crossOrigin || 'anonymous';
    element.crossOrigin = crossOrigin;
    setAttribute(element, 'crossorigin', crossOrigin);
  }

  const referrerPolicy = spec.referrerPolicy || 'no-referrer';
  element.referrerPolicy = referrerPolicy;
  setAttribute(element, 'referrerpolicy', referrerPolicy);
}

function applyAttributes(element, spec, tagName) {
  applySecurityAttributes(element, spec);

  if (tagName === 'script') {
    element.src = spec.url;
    setAttribute(element, 'src', spec.url);
    element.async = true;
  } else {
    element.rel = 'stylesheet';
    setAttribute(element, 'rel', 'stylesheet');
    element.href = spec.url;
    setAttribute(element, 'href', spec.url);
  }
  setAttribute(element, 'data-kui-dep', spec.dep || spec.key);
}

function timeoutFor(options) {
  const requested = Number(options.timeoutMs);
  return Number.isFinite(requested) && requested >= 0 ? requested : DEFAULT_TIMEOUT_MS;
}

function verificationKey(spec) {
  return `${spec.url}\n${spec.integrity || ''}`;
}

function inFlightKey(spec, type, key) {
  return `${type}\n${key}\n${verificationKey(spec)}`;
}

function loadExternalResource(specInput, options = {}, tagName) {
  const spec = normalizeSpec(specInput, tagName === 'script' ? 'script' : 'stylesheet');
  const win = resolveWindow(options);
  const globalName = tagName === 'script' ? (options.global || spec.global) : '';
  const key = options.key || spec.key || spec.url;
  const pendingKey = inFlightKey(spec, tagName, key);
  const verifiedKey = verificationKey(spec);
  const doc = resolveDocument(options);
  const currentGlobal = globalName ? readGlobal(win, globalName) : undefined;

  if (globalName && currentGlobal !== undefined && currentGlobal !== null) {
    if (verifiedDependencies.has(verifiedKey)) return Promise.resolve(currentGlobal);
    const existing = doc ? findExistingElement(doc, tagName, spec) : null;
    if (existing && isMarkedLoaded(existing, tagName)) {
      verifiedDependencies.add(verifiedKey);
      return Promise.resolve(currentGlobal);
    }
  }

  if (inFlight.has(pendingKey)) return inFlight.get(pendingKey);

  if (!doc || typeof doc.createElement !== 'function') {
    return Promise.reject(new Error(`Cannot load ${spec.url}: document is unavailable`));
  }

  const existing = findExistingElement(doc, tagName, spec);
  if (existing) {
    if (isMarkedLoaded(existing, tagName)) {
      if (tagName === 'link') {
        verifiedDependencies.add(verifiedKey);
        return Promise.resolve(existing);
      }
      const current = readGlobal(win, globalName);
      if (current !== undefined && current !== null) {
        verifiedDependencies.add(verifiedKey);
        return Promise.resolve(current);
      }
    }
  }

  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  inFlight.set(pendingKey, promise);

  let element = existing;
  let timer = null;
  let settled = false;

  const clearInFlight = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight.get(pendingKey) === promise) inFlight.delete(pendingKey);
  };

  const cleanupListeners = () => {
    element?.removeEventListener?.('load', onLoad);
    element?.removeEventListener?.('error', onError);
    if (element?.onload === onLoad) element.onload = null;
    if (element?.onerror === onError) element.onerror = null;
  };

  const fail = error => {
    if (settled) return;
    settled = true;
    try {
      cleanupListeners();
    } catch (error) {
      void error;
    }
    clearInFlight();
    try {
      removeElement(element);
    } catch (error) {
      void error;
    }
    rejectPromise(error);
  };

  const succeed = value => {
    if (settled) return;
    settled = true;
    try {
      cleanupListeners();
    } catch (error) {
      void error;
    }
    clearInFlight();
    verifiedDependencies.add(verifiedKey);
    try {
      if (element) markLoaded(element);
    } catch (error) {
      void error;
    }
    resolvePromise(value);
  };

  function onLoad() {
    if (tagName === 'script' && globalName) {
      const loadedGlobal = readGlobal(win, globalName);
      if (loadedGlobal === undefined || loadedGlobal === null) {
        fail(new Error(`Loaded ${spec.key || spec.url} but global "${globalName}" is not available`));
        return;
      }
      succeed(loadedGlobal);
      return;
    }
    succeed(element);
  }

  function onError() {
    fail(new Error(`Failed to load ${spec.key || spec.url} from ${spec.url}`));
  }

  try {
    if (!element) {
      element = doc.createElement(tagName);
      applyAttributes(element, spec, tagName);
    }
    element.addEventListener?.('load', onLoad);
    element.addEventListener?.('error', onError);
    element.onload = onLoad;
    element.onerror = onError;

    const timeoutMs = timeoutFor(options);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(new Error(`Timed out loading ${spec.key || spec.url} from ${spec.url}`));
      }, timeoutMs);
    }

    if (!existing) {
      const host = doc.head || doc.body;
      if (!host || typeof host.appendChild !== 'function') {
        throw new Error(`Cannot load ${spec.url}: document head or body is unavailable`);
      }
      host.appendChild(element);
    }
  } catch (error) {
    fail(error);
  }

  return promise;
}

export function loadExternalScript(spec, options = {}) {
  return loadExternalResource(spec, options, 'script');
}

export function loadExternalStylesheet(spec, options = {}) {
  return loadExternalResource(spec, options, 'link');
}

export function ensureTweetNacl(options = {}) {
  return loadExternalScript(EXTERNAL_DEPS.tweetnacl, options);
}

export function ensureEcharts(options = {}) {
  return loadExternalScript(EXTERNAL_DEPS.echarts, options);
}

export function ensureQrious(options = {}) {
  return loadExternalScript(EXTERNAL_DEPS.qrious, options);
}

export function ensureChartJs(options = {}) {
  return loadExternalScript(EXTERNAL_DEPS.chartjs, options);
}

export function ensureLeaflet(options = {}) {
  const win = resolveWindow(options);
  const key = 'ensure-leaflet';
  if (compositeInFlight.has(key)) return compositeInFlight.get(key);

  const promise = Promise.all([
    loadExternalStylesheet(EXTERNAL_DEPS.leaflet.css, options),
    loadExternalScript(EXTERNAL_DEPS.leaflet.js, options),
  ]).then(([, leaflet]) => leaflet);

  compositeInFlight.set(key, promise);
  const clear = () => {
    if (compositeInFlight.get(key) === promise) compositeInFlight.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

export function ensureGoogleFonts(options = {}) {
  const key = 'ensure-google-fonts';
  if (compositeInFlight.has(key)) return compositeInFlight.get(key);
  const promise = loadExternalStylesheet(EXTERNAL_DEPS.googleFonts.css, options).catch(() => null);
  compositeInFlight.set(key, promise);
  const clear = () => {
    if (compositeInFlight.get(key) === promise) compositeInFlight.delete(key);
  };
  promise.then(clear, clear);
  return promise;
}

export function resetExternalDepsStateForTest() {
  inFlight.clear();
  compositeInFlight.clear();
  verifiedDependencies.clear();
}
