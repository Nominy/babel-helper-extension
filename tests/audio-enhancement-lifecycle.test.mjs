import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { isAbsolute } from 'node:path';

async function load(contents, modules = new Map()) {
  const result = await build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'ts' }, bundle: true,
    format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
    plugins: [{ name: 'lifecycle-test-dependencies', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (modules.has(args.path)) return { path: args.path, namespace: 'lifecycle-test' };
        if (args.namespace === 'lifecycle-test' && isAbsolute(args.path)) {
          return { path: args.path, namespace: 'file' };
        }
        return null;
      });
      builder.onLoad({ filter: /.*/, namespace: 'lifecycle-test' }, args => ({ contents: modules.get(args.path), loader: 'js' }));
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
  ['../services/builtin-service-adapters', `${adapters.map(name => `export const ${name} = ctx => { ctx.helper.installedServices?.push('${name}'); };`).join('\n')}
    export const disposeSessionServiceScopes = async scopes => { scopes.length = 0; };`]
]));

test('session initializes enhancement without another extension and settings reconcile without restarting ordinary features', async t => {
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
  const features = { audioEnhancement: true, hotkeysHelp: true };
  const ctx = { helper: { settings: { features }, isFeatureEnabled: key => !!features[key] } };
  await sessionModule.activateSessionFeatures(ctx);
  assert.ok(calls.includes('audio-enhancement:factory'));
  assert.ok(calls.includes('audio-enhancement:activate'));
  assert.ok(calls.includes('hotkeys-help:activate'));
  features.audioEnhancement = false;
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  assert.ok(calls.includes('audio-enhancement:deactivate'));
  assert.ok(calls.includes('audio-enhancement:stop'));
  assert.equal(calls.includes('hotkeys-help:deactivate'), false);
  features.audioEnhancement = true;
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  assert.equal(calls.filter(call => call === 'audio-enhancement:factory').length, 2);
  await sessionModule.deactivateSessionFeatures(ctx);
  features.audioEnhancement = false;
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  const activations = calls.filter(call => call === 'audio-enhancement:activate').length;
  features.audioEnhancement = true;
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  assert.equal(calls.filter(call => call === 'audio-enhancement:activate').length, activations, 'Enabling on an inactive route cannot start capture');
  await sessionModule.stopSessionRuntime(ctx);
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  assert.equal(calls.filter(call => call === 'hotkeys-help:factory').length, 1);
});

test('all visual registry features enable from disabled boot and remove surfaces live without restarting peers', async t => {
  const registrations = sessionModule.FEATURE_REGISTRATIONS.filter(row =>
    ['hotkeys-help', 'magnifier', 'minimap'].includes(row.id));
  const calls = [];
  const active = new Set();
  for (const registration of registrations) {
    const original = registration.createModule;
    t.after(() => { registration.createModule = original; });
    registration.createModule = () => {
      calls.push(`${registration.id}:factory`);
      return {
        id: registration.id,
        activate() { active.add(registration.id); },
        deactivate() { active.delete(registration.id); calls.push(`${registration.id}:deactivate`); },
        stop() { calls.push(`${registration.id}:stop`); }
      };
    };
  }
  const features = { hotkeysHelp: false, magnifier: false, minimap: false };
  const installedServices = [];
  const ctx = { helper: { settings: { features }, installedServices, isFeatureEnabled: key => !!features[key] } };
  await sessionModule.activateSessionFeatures(ctx);
  assert.equal(active.size, 0);
  assert.equal(installedServices.includes('installMinimapServiceProvider'), false);
  for (const registration of registrations) {
    features[registration.setting.key] = true;
    await sessionModule.reconcileSessionFeatureAccess(ctx);
    assert.equal(active.has(registration.id), true);
  }
  for (const registration of registrations) {
    features[registration.setting.key] = false;
    await sessionModule.reconcileSessionFeatureAccess(ctx);
    assert.equal(active.has(registration.id), false);
    assert.equal(calls.filter(call => call === `${registration.id}:stop`).length, 1);
  }
  Object.assign(features, { hotkeysHelp: true, magnifier: true, minimap: true });
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  await sessionModule.reconcileSessionFeatureAccess(ctx, 'unrelated-settings');
  assert.equal(active.size, 3);
  for (const registration of registrations) {
    assert.equal(calls.filter(call => call === `${registration.id}:factory`).length, 2);
  }
  for (const name of ['installHotkeysHelpServiceProvider', 'installMagnifierServiceProvider', 'installMinimapServiceProvider']) {
    assert.equal(installedServices.filter(value => value === name).length, 1);
  }
  await sessionModule.deactivateSessionFeatures(ctx);
  await sessionModule.reconcileSessionFeatureAccess(ctx);
  assert.equal(active.size, 0, 'settings cannot activate surfaces on an inactive route');
  await sessionModule.stopSessionRuntime(ctx);
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

test('options render enhancement immediately and persist changes and reset without another extension', async t => {
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
  globals(t, { window, document, HTMLElement: Element, HTMLInputElement: Element,
    chrome: { runtime: {}, storage: { local: {
      get(key, callback) { callback({ [key]: stored }); },
      set(values, callback) { stored = Object.values(values)[0]; writes.push(stored); callback(); }
    } } }
  });
  await load("import './src/options/options.ts';", new Map([
    ['@nominy/babel-extension-frontend', 'export const ensureUiStyles = () => {}; export const themeRoot = () => {}; export const applyComponent = () => {}; export const UI_STYLES = ""; export const confirmDialog = async () => false;']
  ]));
  await settle();
  const enhancement = () => document.querySelector('input[name="audioEnhancement"]');
  assert.equal(enhancement().checked, false);
  assert.equal(root.all().some(element => /Automatic Audio Enhancement/.test(element.textContent)), true);
  const minimap = document.querySelector('input[name="minimap"]');
  minimap.checked = false; minimap.emit('change');
  await settle();
  assert.equal(stored.features.minimap, false);
  assert.equal(stored.features.audioEnhancement, false);
  role('reset').emit('click');
  await settle();
  assert.equal(stored.features.minimap, true);
  assert.equal(stored.features.audioEnhancement, true, 'Reset restores the normal enabled default');
  assert.equal(enhancement().checked, true);
  enhancement().checked = false; enhancement().emit('change');
  await settle();
  assert.equal(stored.features.audioEnhancement, false);
  enhancement().checked = true; enhancement().emit('change');
  await settle();
  assert.equal(stored.features.audioEnhancement, true);
  assert.equal(document.querySelector('input[name="minimap"]'), minimap, 'Saving preserves unrelated settings DOM and listeners');
  minimap.checked = false; minimap.emit('change');
  await settle();
  assert.equal(stored.features.audioEnhancement, true);
  assert.equal(enhancement().checked, true);
  window.emit('pagehide');
  assert.equal(enhancement().checked, true);
  assert.ok(writes.length >= 4);
});
