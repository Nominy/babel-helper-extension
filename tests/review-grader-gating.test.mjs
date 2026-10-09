import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

async function load(contents, modules = new Map()) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' }, bundle: true,
    format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
    plugins: [{ name: 'access-test-dependencies', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (modules.has(args.path)) return { path: args.path, namespace: 'access-test' };
        if (args.namespace === 'access-test' && isAbsolute(args.path)) {
          return { path: args.path, namespace: 'file' };
        }
        return null;
      });
      builder.onLoad({ filter: /.*/, namespace: 'access-test' }, args => ({ contents: modules.get(args.path), loader: 'js' }));
    } }]
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => prior ? Object.defineProperty(globalThis, key, prior) : delete globalThis[key]);
  }
}

function accessFixture() {
  let available = false;
  let lease = new AbortController();
  const listeners = new Set();
  return {
    start: async () => available,
    isAvailable: () => available,
    acquire: async () => available ? lease.signal : null,
    subscribe(listener) { listeners.add(listener); listener(available); return () => listeners.delete(listener); },
    set(value) {
      if (value === available) return;
      available = value;
      if (!value) lease.abort(); else lease = new AbortController();
      for (const listener of listeners) listener(value);
    },
    dispose() { this.set(false); listeners.clear(); }
  };
}

const adapters = [
  'installHotkeysHelpServiceProvider', 'installMagnifierServiceProvider', 'installMinimapServiceProvider',
  'installRowServiceProviders', 'installTimelineSelectionServiceProviders', 'installTimestampEditServiceProvider',
  'installWaveformScaleServiceProvider'
];
const sessionModule = await load(`
  export * from './src/content/lazy-session.ts';
  export { FEATURE_REGISTRATIONS, getRegisteredFeatureModules } from './src/features/registry.ts';
`, new Map([
  ['../services/recovered-editor-snapshot-service', 'export const registerRecoveredEditorSnapshotService = () => {};'],
  ['../services/builtin-service-adapters', `${adapters.map(name => `export const ${name} = () => {};`).join('\n')}
    export const disposeSessionServiceScopes = async scopes => { scopes.length = 0; };`]
]));

test('session excludes the enhancement factory before grant and reconciles grant/revoke without restarting ordinary features', async t => {
  const calls = [];
  const records = sessionModule.FEATURE_REGISTRATIONS.filter(row => ['audio-enhancement', 'hotkeys-help'].includes(row.id));
  for (const record of records) {
    const original = record.createModule;
    t.after(() => { record.createModule = original; });
    record.createModule = () => {
      calls.push(`${record.id}:factory`);
      return Object.fromEntries([['id', record.id], ...['load', 'register', 'start', 'onLoaded', 'activate', 'deactivate', 'stop']
        .map(hook => [hook, () => { calls.push(`${record.id}:${hook}`); }])]);
    };
  }
  const access = accessFixture();
  const features = { audioEnhancement: true, hotkeysHelp: true };
  const ctx = { helper: { settings: { features }, reviewGraderAccess: access, isFeatureEnabled: key => !!features[key] } };
  assert.deepEqual(sessionModule.getRegisteredFeatureModules({ audioEnhancement: true }), []);
  await sessionModule.activateSessionFeatures(ctx);
  assert.equal(calls.some(call => call.startsWith('audio-enhancement:')), false);
  assert.ok(calls.includes('hotkeys-help:activate'));
  access.set(true);
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  assert.deepEqual(calls.filter(call => call.startsWith('audio-enhancement:')), [
    'audio-enhancement:factory', 'audio-enhancement:load', 'audio-enhancement:register', 'audio-enhancement:start', 'audio-enhancement:activate'
  ]);
  access.set(false);
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  assert.ok(calls.includes('audio-enhancement:deactivate'));
  assert.ok(calls.includes('audio-enhancement:stop'));
  assert.equal(calls.includes('hotkeys-help:deactivate'), false);
  assert.equal(features.audioEnhancement, true, 'Stored preference is not rewritten by absence');
  access.set(true);
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  assert.equal(calls.filter(call => call === 'audio-enhancement:factory').length, 2);
  await sessionModule.deactivateSessionFeatures(ctx);
  access.set(false);
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  const activations = calls.filter(call => call === 'audio-enhancement:activate').length;
  access.set(true);
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  assert.equal(calls.filter(call => call === 'audio-enhancement:activate').length, activations, 'Grant on an inactive route cannot start capture');
  await sessionModule.stopSessionRuntime(ctx);
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  assert.equal(calls.filter(call => call === 'hotkeys-help:factory').length, 1);
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.listeners = new Map();
    this.checked = false; this.value = ''; this.textContent = ''; this.hidden = false;
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  appendChild(node) {
    if (node.tagName === 'fragment') { for (const child of [...node.children]) this.appendChild(child); return node; }
    node.remove(); node.parentElement = this; this.children.push(node); return node;
  }
  prepend(node) {
    const children = node.tagName === 'fragment' ? [...node.children] : [node];
    for (const child of children.reverse()) { child.remove(); child.parentElement = this; this.children.unshift(child); }
  }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  closest(tag) { return this.tagName === tag ? this : this.parentElement?.closest(tag) ?? null; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(type, listener) { const group = this.listeners.get(type) ?? new Set(); group.add(listener); this.listeners.set(type, group); }
  emit(type) { for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {}, stopPropagation() {} }); }
  focus() {}
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}

const settle = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

test('options never render the gated row before grant and preserve its saved preference through unrelated saves and reset', async t => {
  const gate = accessFixture();
  const roles = new Map();
  const root = new Element();
  const role = key => {
    const existing = root.all().find(element => element.dataset.role === key);
    if (existing) return existing;
    if (!roles.has(key)) { const element = new Element(); roles.set(key, element); root.appendChild(element); }
    return roles.get(key);
  };
  const document = {
    createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'), addEventListener() {},
    querySelector(selector) {
      const input = /^input\[name="([^"]+)"\]$/.exec(selector);
      if (input) return root.all().find(element => element.tagName === 'input' && element.name === input[1]) ?? null;
      const match = /^\[data-role="([^"]+)"\]$/.exec(selector);
      return match ? role(match[1]) : null;
    }
  };
  let stored = { features: { audioEnhancement: false, minimap: true } };
  const writes = [];
  const window = new Element('window');
  globals(t, { window, document, HTMLElement: Element, HTMLInputElement: Element, __helperGateFixture: gate,
    chrome: { runtime: {}, storage: { local: {
      get(key, callback) { callback({ [key]: stored }); },
      set(values, callback) { stored = Object.values(values)[0]; writes.push(stored); callback(); }
    } } }
  });
  const runtime = fileURLToPath(import.meta.resolve('@nominy/babel-babel-runtime'));
  await load("import './src/options/options.ts';", new Map([
    ['@nominy/babel-babel-runtime', `export * from ${JSON.stringify(runtime)}; export const createReviewGraderAccess = () => globalThis.__helperGateFixture;`],
    ['@nominy/babel-extension-frontend', 'export const ensureUiStyles = () => {}; export const themeRoot = () => {}; export const applyComponent = () => {}; export const UI_STYLES = "";']
  ]));
  await settle();
  const enhancement = () => document.querySelector('input[name="audioEnhancement"]');
  assert.equal(enhancement(), null);
  assert.equal(root.all().some(element => /ZipEnhancer|Automatic Audio Enhancement/.test(element.textContent)), false);
  const minimap = document.querySelector('input[name="minimap"]');
  minimap.checked = false; minimap.emit('change');
  await settle();
  assert.equal(stored.features.minimap, false);
  assert.equal(stored.features.audioEnhancement, false);
  role('reset').emit('click');
  await settle();
  assert.equal(stored.features.minimap, true);
  assert.equal(stored.features.audioEnhancement, false, 'Reset cannot overwrite the absent preference');
  gate.set(true);
  assert.equal(enhancement().checked, false);
  enhancement().checked = true; enhancement().emit('change');
  await settle();
  assert.equal(stored.features.audioEnhancement, true);
  gate.set(false);
  assert.equal(enhancement(), null);
  assert.equal(root.all().some(element => /ZipEnhancer|Automatic Audio Enhancement/.test(element.textContent)), false);
  assert.equal(document.querySelector('input[name="minimap"]'), minimap, 'Reconciliation preserves unrelated settings DOM and listeners');
  minimap.checked = false; minimap.emit('change');
  await settle();
  assert.equal(stored.features.audioEnhancement, true);
  gate.set(true);
  assert.equal(enhancement().checked, true);
  window.emit('pagehide');
  assert.equal(enhancement(), null);
  assert.ok(writes.length >= 4);
});
