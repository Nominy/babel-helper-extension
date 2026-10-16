import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { build } from 'esbuild';

const modules = new Map();
function importTs(entryPoint) {
  if (!modules.has(entryPoint)) {
    modules.set(entryPoint, build({ entryPoints: [entryPoint], bundle: true, write: false,
      platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent' })
      .then(result => import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)));
  }
  return modules.get(entryPoint);
}
const workerBundle = build({ entryPoints: ['src/background/editor-mode.ts'], bundle: true,
  write: false, format: 'iife', target: 'chrome114', logLevel: 'silent' });
const manifestPromise = readFile(new URL('../manifest.json', import.meta.url), 'utf8').then(JSON.parse);
const nativeEntryBundle = build({ entryPoints: ['src/content/native-performance-entry.ts'], bundle: true,
  write: false, format: 'iife', target: 'chrome114', logLevel: 'silent' });

async function workerFixture({ settings, manifest, initialScripts = [], beforeWrite } = {}) {
  const listeners = {};
  const calls = [];
  const failures = [];
  let stored = settings;
  let scripts = structuredClone(initialScripts);
  const api = {
    runtime: {
      id: 'test-extension',
      getManifest: () => manifest,
      onInstalled: { addListener: fn => { listeners.installed = fn; } },
      onStartup: { addListener: fn => { listeners.startup = fn; } },
      onMessage: { addListener: fn => { listeners.message = fn; } }
    },
    storage: {
      local: { get: async () => ({ settings: stored }) },
      onChanged: { addListener: fn => { listeners.changed = fn; } }
    },
    scripting: {
      async getRegisteredContentScripts({ ids }) {
        calls.push({ kind: 'read' });
        return scripts.filter(script => ids.includes(script.id));
      },
      async registerContentScripts(next) {
        calls.push({ kind: 'register', scripts: structuredClone(next) });
        await beforeWrite?.();
        assert.equal(scripts.length, 0, 'a second mode must never coexist with the first');
        scripts = structuredClone(next);
      },
      async updateContentScripts(next) {
        calls.push({ kind: 'update', scripts: structuredClone(next) });
        await beforeWrite?.();
        assert.equal(scripts.length, 1);
        scripts = structuredClone(next);
      },
      async unregisterContentScripts({ ids }) {
        calls.push({ kind: 'unregister' });
        await beforeWrite?.();
        scripts = scripts.filter(script => !ids.includes(script.id));
      }
    }
  };
  manifest ??= await manifestPromise;
  const bundle = await workerBundle;
  vm.runInNewContext(bundle.outputFiles[0].text, { chrome: api, console: { error: (...args) => failures.push(args) } });
  return {
    listeners, calls, failures, api,
    get scripts() { return scripts; },
    setSettings(next, area = 'local') {
      const oldValue = stored;
      stored = next;
      listeners.changed({ settings: { oldValue, newValue: next } }, area);
    },
    send(mode) {
      return new Promise(resolve => {
        assert.equal(listeners.message({ type: 'babel-helper:sync-editor-mode', mode },
          { id: api.runtime.id }, response => resolve(structuredClone(response))), true);
      });
    }
  };
}

test('first-install native bootstrap owns the page before any background event or storage read', async () => {
  const manifest = await manifestPromise;
  const nativeScript = manifest.content_scripts.find(script => script.world === 'MAIN' &&
    script.run_at === 'document_start' && script.js.includes('dist/content/native-performance-entry.js'));
  assert.ok(nativeScript, 'the initial page must not depend on async registration');
  const context = vm.createContext({ console });
  vm.runInContext('globalThis.window = globalThis', context);
  vm.runInContext((await nativeEntryBundle).outputFiles[0].text, context);
  assert.equal(vm.runInContext('typeof window[Symbol.for(\"babel-helper/native-render-performance\")]', context), 'function');
  vm.runInContext(`
    const payload = [[], { 1: function(module, exports, require) {
      exports.markers = ['data-turn-issues', 'data-annotation-id', 'onDraftTag'];
      exports.value = require('native-value');
    } }];
    webpackChunk_N_E.push(payload);
    const exported = {};
    payload[1][1]({}, exported, () => 'native value');
    globalThis.importResult = exported.value;
  `, context);
  assert.equal(context.importResult, 'native value');
  assert.equal(context.__babelHelperEditorMode, 'native');
});

test('Classic preparation works before or after static injection without acquiring a second bootstrap lease', async () => {
  const { registerClassicEditorAdapter } = await importTs('src/content/editor-mode-adapter.ts');
  for (const prepareFirst of [false, true]) {
    const context = vm.createContext({ console });
    vm.runInContext('globalThis.window = globalThis', context);
    const target = vm.runInContext('globalThis', context);
    let adapterCreations = 0;
    const prepare = () => registerClassicEditorAdapter(() => {
      adapterCreations++;
      return { adaptImport: namespace => `classic:${namespace}`, release() {} };
    }, target);
    if (prepareFirst) prepare();
    vm.runInContext((await nativeEntryBundle).outputFiles[0].text, context);
    const lease = vm.runInContext('window[Symbol.for(\"babel-helper/native-render-performance\")]', context);
    if (!prepareFirst) prepare();
    assert.equal(adapterCreations, 0);
    assert.equal(vm.runInContext('window[Symbol.for(\"babel-helper/native-render-performance\")]', context), lease);
    vm.runInContext(`
      const payload = [[], { 1: function(module, exports, require) {
        exports.markers = ['data-turn-issues', 'data-annotation-id', 'onDraftTag'];
        exports.value = require('native-value');
      } }];
      webpackChunk_N_E.push(payload);
      const exported = {};
      payload[1][1]({}, exported, () => 'native value');
      globalThis.importResult = exported.value;
    `, context);
    assert.equal(context.importResult, 'classic:native value');
    assert.equal(context.__babelHelperEditorMode, 'classic');
    assert.equal(adapterCreations, 1);
  }
});

test('native install, update and startup need no dynamic script registration', async () => {
  const worker = await workerFixture();
  worker.listeners.installed();
  assert.deepEqual(await worker.send('native'), { ok: true, mode: 'native' });
  assert.equal(worker.scripts.length, 0);
  worker.listeners.installed();
  worker.listeners.startup();
  await worker.send('native');
  assert.equal(worker.calls.filter(call => call.kind !== 'read').length, 0);
});

test('Classic registers preparation and CSS only; native removes both without injecting into the page', async () => {
  const worker = await workerFixture();
  await worker.send('native');
  worker.setSettings({ editorMode: 'classic' });
  assert.deepEqual(await worker.send('classic'), { ok: true, mode: 'classic' });
  assert.deepEqual(worker.scripts[0].js, ['dist/content/classic-performance-entry.js']);
  assert.deepEqual(worker.scripts[0].css, ['dist/classic/editor.css']);
  assert.equal(worker.scripts[0].world, 'MAIN');
  assert.equal(worker.scripts[0].runAt, 'document_start');
  assert.equal(worker.scripts[0].persistAcrossSessions, true);
  assert.deepEqual(worker.scripts[0].matches, ['https://dashboard.babel.audio/*']);
  worker.setSettings({ editorMode: 'native' });
  await worker.send('native');
  assert.deepEqual(worker.scripts, []);
  assert.deepEqual(worker.calls.filter(call => call.kind !== 'read').map(call => call.kind), ['register', 'unregister']);
});

test('persistent Classic registration survives a worker restart and unrelated settings writes', async () => {
  const first = await workerFixture({ settings: { editorMode: 'classic' } });
  await first.send('classic');
  const restarted = await workerFixture({ settings: { editorMode: 'classic' }, initialScripts: first.scripts });
  restarted.listeners.startup();
  await restarted.send('classic');
  assert.equal(restarted.calls.filter(call => call.kind !== 'read').length, 0);
  const reads = restarted.calls.length;
  restarted.setSettings({ editorMode: 'classic', features: { ghostCursor: false } });
  assert.equal(restarted.calls.length, reads);
  assert.deepEqual(restarted.scripts, first.scripts);
});

test('isolated staging uses rewritten manifest matches without production-host injection', async () => {
  const manifest = structuredClone(await manifestPromise);
  for (const script of manifest.content_scripts) script.matches = ['http://127.0.0.1/*'];
  const worker = await workerFixture({ manifest, settings: { editorMode: 'classic' } });
  await worker.send('classic');
  assert.deepEqual(worker.scripts[0].matches, ['http://127.0.0.1/*']);
});

test('mode acknowledgement waits for scripting registration, not just storage', async () => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const worker = await workerFixture({ settings: { editorMode: 'classic' }, beforeWrite: async () => { started(); await gate; } });
  let acknowledged = false;
  const request = worker.send('classic').then(response => { acknowledged = true; return response; });
  await entered;
  assert.equal(acknowledged, false);
  assert.equal(worker.scripts.length, 0);
  release();
  assert.deepEqual(await request, { ok: true, mode: 'classic' });
});

test('registration failure is explicit and never substitutes native or retries', async () => {
  const worker = await workerFixture({ settings: { editorMode: 'classic' }, beforeWrite: () => { throw new Error('Host permission denied'); } });
  const response = await worker.send('classic');
  assert.equal(response.ok, false);
  assert.match(response.error, /Host permission denied/);
  assert.equal(worker.scripts.length, 0);
  assert.equal(worker.calls.filter(call => call.kind !== 'read').length, 1);
});

test('stale mode requests fail without overwriting a newer preference', async () => {
  const worker = await workerFixture({ settings: { editorMode: 'classic' } });
  const response = await worker.send('native');
  assert.equal(response.ok, false);
  assert.match(response.error, /changed in another window/);
  assert.equal(worker.calls.length, 0);
  assert.deepEqual(await worker.send('classic'), { ok: true, mode: 'classic' });
});

test('a preference changed during registration cannot receive a stale success acknowledgement', async () => {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const worker = await workerFixture({ settings: { editorMode: 'classic' }, beforeWrite: async () => { started(); await gate; } });
  const request = worker.send('classic');
  await entered;
  worker.setSettings({ editorMode: 'native' });
  release();
  const response = await request;
  assert.equal(response.ok, false);
  assert.match(response.error, /changed while registration/);
  assert.deepEqual(await worker.send('native'), { ok: true, mode: 'native' });
  assert.deepEqual(worker.scripts, []);
});

test('native selection awaits removal of Classic preparation and surfaces removal failures', async () => {
  const classic = await workerFixture({ settings: { editorMode: 'classic' } });
  await classic.send('classic');
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const native = await workerFixture({ settings: { editorMode: 'native' }, initialScripts: classic.scripts,
    beforeWrite: async () => { started(); await gate; } });
  let acknowledged = false;
  const request = native.send('native').then(response => { acknowledged = true; return response; });
  await entered;
  assert.equal(acknowledged, false);
  assert.equal(native.scripts.length, 1);
  release();
  assert.deepEqual(await request, { ok: true, mode: 'native' });
  assert.deepEqual(native.scripts, []);
  const failed = await workerFixture({ settings: { editorMode: 'native' }, initialScripts: classic.scripts,
    beforeWrite: () => { throw new Error('Registration removal denied'); } });
  const response = await failed.send('native');
  assert.equal(response.ok, false);
  assert.match(response.error, /Registration removal denied/);
  assert.deepEqual(failed.scripts, classic.scripts);
});

test('Classic preparation selects once at module execution without installing another bootstrap', async () => {
  const { registerClassicEditorAdapter, selectEditorAdapterFactory } = await importTs('src/content/editor-mode-adapter.ts');
  const { getActiveEditorMode } = await importTs('src/core/editor-mode.ts');
  const calls = [];
  const nativeFactory = (...args) => calls.push(['native', ...args]);
  const classicFactory = (...args) => calls.push(['classic', ...args]);
  const currentDocument = {};
  registerClassicEditorAdapter(classicFactory, currentDocument);
  assert.equal(getActiveEditorMode(currentDocument), null, 'preparation does not prematurely start an editor');
  assert.deepEqual(calls, []);
  const selected = selectEditorAdapterFactory(nativeFactory, currentDocument);
  assert.equal(selected, classicFactory);
  selected('report', 'native-require');
  assert.deepEqual(calls, [['classic', 'report', 'native-require']]);
  assert.equal(getActiveEditorMode(currentDocument), 'classic');
  assert.equal(selectEditorAdapterFactory(nativeFactory, currentDocument), classicFactory);
  assert.throws(() => registerClassicEditorAdapter(nativeFactory, currentDocument), /already owns/);
  const nextDocument = {};
  assert.equal(selectEditorAdapterFactory(nativeFactory, nextDocument), nativeFactory);
  assert.equal(getActiveEditorMode(nextDocument), 'native');
  assert.throws(() => registerClassicEditorAdapter(classicFactory, nextDocument), /already started/);
});

test('settings normalization, JSON roundtrip and unrelated saves retain Classic preference', async (t) => {
  const { normalizeExtensionSettings, saveExtensionSettings, loadExtensionSettings } = await importTs('src/core/settings.ts');
  let record;
  const previousChrome = globalThis.chrome;
  t.after(() => { if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome; });
  globalThis.chrome = { storage: { local: {
    set(items, callback) { record = structuredClone(items); callback(); },
    get(_key, callback) { callback(record); }
  } } };
  assert.equal(normalizeExtensionSettings({}).editorMode, 'native');
  assert.equal(normalizeExtensionSettings({ editorMode: 'unknown' }).editorMode, 'native');
  const imported = normalizeExtensionSettings(JSON.parse(JSON.stringify({ editorMode: 'classic', features: {} })));
  await saveExtensionSettings(imported);
  const loaded = await loadExtensionSettings();
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.settings.editorMode, 'classic');
  await saveExtensionSettings({ ...loaded.settings, highlightedWordsEnabled: false });
  assert.equal(record.settings.editorMode, 'classic');
  assert.equal(record.settings.highlightedWordsEnabled, false);
});

test('options acknowledgement rejects messaging, background and stale-mode failures', async (t) => {
  const { confirmEditorModeRegistration } = await importTs('src/core/editor-mode.ts');
  const previousChrome = globalThis.chrome;
  t.after(() => { if (previousChrome === undefined) delete globalThis.chrome; else globalThis.chrome = previousChrome; });
  delete globalThis.chrome;
  await assert.rejects(confirmEditorModeRegistration('classic'), /messaging is unavailable/);
  const runtime = { sendMessage(_message, respond) { respond({ ok: false, error: 'Registration rejected' }); } };
  globalThis.chrome = { runtime };
  await assert.rejects(confirmEditorModeRegistration('classic'), /Registration rejected/);
  runtime.sendMessage = (_message, respond) => respond({ ok: true, mode: 'native' });
  await assert.rejects(confirmEditorModeRegistration('classic'), /changed in another window/);
  runtime.sendMessage = (_message, respond) => { runtime.lastError = { message: 'Worker disconnected' }; respond(); delete runtime.lastError; };
  await assert.rejects(confirmEditorModeRegistration('classic'), /Worker disconnected/);
  runtime.sendMessage = (_message, respond) => respond({ ok: true, mode: 'classic' });
  await confirmEditorModeRegistration('classic');
});
