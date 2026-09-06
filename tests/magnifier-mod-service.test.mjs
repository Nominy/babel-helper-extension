import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

class TestCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

class TestServiceRegistry {
  constructor() {
    this.base = new Map();
    this.replacements = new Map();
    this.decorators = new Map();
    this.providedId = null;
    this.providedService = null;
    this.providerDisposed = false;
  }

  provide(id, service) {
    this.providedId = id;
    this.providedService = service;
    this.base.set(id, service);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.providerDisposed = true;
        this.base.delete(id);
      }
    };
  }

  replace(id, service) {
    const layers = this.replacements.get(id) || [];
    const layer = { service };
    layers.push(layer);
    this.replacements.set(id, layers);
    return {
      dispose: () => {
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
      }
    };
  }

  decorate(id, decorate) {
    const layers = this.decorators.get(id) || [];
    const layer = { decorate };
    layers.push(layer);
    this.decorators.set(id, layers);
    return {
      dispose: () => {
        const index = layers.indexOf(layer);
        if (index >= 0) layers.splice(index, 1);
      }
    };
  }

  current(id) {
    const replacements = this.replacements.get(id) || [];
    let service = replacements.length
      ? replacements[replacements.length - 1].service
      : this.base.get(id);
    for (const { decorate } of this.decorators.get(id) || []) {
      service = decorate(service);
    }
    if (!service) throw new Error(`Missing service ${id}`);
    return service;
  }

  invoke(id, method, ...args) {
    const service = this.current(id);
    return Reflect.apply(service[method], service, args);
  }
}

const operationMethods = new Map([
  ['ensure', 'ensureLens'],
  ['update', 'updateLens'],
  ['destroy', 'destroyLens'],
  ['loop-start', 'startLoop'],
  ['selection-time-range', 'measureSelectionTimeRange'],
  ['trim-segment-audio', 'findTrimTargets'],
  ['find-segment-silence-runs', 'findSegmentSilenceRuns'],
  ['find-nearest-speech-island', 'findNearestSpeechIsland'],
  ['resolve-visible-lane-targets', 'resolveVisibleLaneTargets'],
  ['prepare-auto-segment-text-redistribution', 'prepareAutoSegmentTextRedistributionSession'],
  ['auto-segment-redistribute-text', 'redistributeAutoSegmentText'],
  ['transcribe-segment-audio', 'transcribeSegmentAudio'],
  ['destroy-auto-segment-text-redistribution-session', 'destroyAutoSegmentTextRedistributionSession'],
  ['trim-segment-audio-for-speaker', 'findTrimTargetsForSpeaker'],
  ['extend-segment-audio-to-silence', 'findExtendTargets'],
  ['extend-segment-audio-to-silence-for-speaker', 'findExtendTargetsForSpeaker'],
  ['zoom-set', 'setZoomValue'],
  ['waveform-scale-unlock-enable', 'enableWaveformScaleUnlock'],
  ['waveform-scale-unlock-disable', 'disableWaveformScaleUnlock'],
  ['waveform-scale-set', 'setWaveformScaleByIndex'],
  ['loop-stop', 'stopLoop'],
  ['seek-source', 'seekSource'],
  ['navigate-source', 'navigateSource'],
  ['minimap-data', 'getMinimapData']
]);

async function loadBridge() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-helper-magnifier-mod-'));
  const outfile = path.join(tempDir, 'magnifier-bridge.mjs');
  await build({
    entryPoints: [path.resolve('src/content/magnifier-bridge.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent'
  });
  await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`);
}

test('page.magnifier keeps every legacy operation late-bound, preserves progress, and disposes ownership', async () => {
  const services = new TestServiceRegistry();
  const pageWindow = new EventTarget();
  const pageDocument = new EventTarget();
  pageWindow.BabelMods = { unsafe: { services } };

  globalThis.window = pageWindow;
  globalThis.document = pageDocument;
  globalThis.CustomEvent = TestCustomEvent;
  globalThis.HTMLElement = class HTMLElement {};

  const responses = [];
  pageWindow.addEventListener('babel-helper-magnifier-response', (event) => {
    responses.push(event.detail);
  });

  await loadBridge();

  assert.equal(services.providedId, 'page.magnifier');
  assert.deepEqual(
    [...operationMethods.values()].filter((method) => typeof services.providedService[method] !== 'function'),
    []
  );
  assert.equal(typeof services.providedService.findNearestSpeechIslandForResolvedWave, 'function');

  const replacementService = new Proxy(
    {},
    {
      get(_target, method) {
        if (method === 'transcribeSegmentAudio') {
          return async (_payload, onProgress) => {
            onProgress({ phase: 'streaming', completed: 2, total: 3 });
            return { ok: true, method };
          };
        }
        return (...args) => ({ ok: true, method, args });
      }
    }
  );
  const replacement = services.replace('page.magnifier', replacementService);
  const decorator = services.decorate('page.magnifier', (next) =>
    new Proxy(next, {
      get(target, method) {
        const member = Reflect.get(target, method);
        if (method !== 'findTrimTargetsForSpeaker') return member;
        return (...args) => ({ ...Reflect.apply(member, target, args), decorated: true });
      }
    })
  );

  const direct = pageWindow.__babelHelperMagnifierBridge.findTrimTargetsForSpeaker(
    'speaker-a',
    1,
    2,
    0.1,
    0.05
  );
  assert.equal(direct.method, 'findTrimTargetsForSpeaker');
  assert.equal(direct.decorated, true);
  const directNearest =
    pageWindow.__babelHelperMagnifierBridge.findNearestSpeechIsland({}, {}, 4, 1, 0.2, 0.05);
  assert.equal(directNearest.method, 'findNearestSpeechIslandForResolvedWave');

  let requestSequence = 0;
  for (const [operation, method] of operationMethods) {
    const id = `request-${requestSequence++}`;
    pageWindow.dispatchEvent(
      new TestCustomEvent('babel-helper-magnifier-request', {
        detail: { id, operation, payload: {} }
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
    const finalResponse = responses.find((entry) => entry.id === id && 'result' in entry);
    assert.equal(finalResponse?.result?.method, method, `${operation} did not invoke ${method}`);
  }

  const transcriptionResponses = responses.filter((entry) => entry.id === 'request-11');
  assert.deepEqual(transcriptionResponses[0].progress, {
    phase: 'streaming',
    completed: 2,
    total: 3
  });
  assert.equal(transcriptionResponses[1].result.method, 'transcribeSegmentAudio');

  decorator.dispose();
  const undecorated = pageWindow.__babelHelperMagnifierBridge.findTrimTargetsForSpeaker('speaker-a');
  assert.equal(undecorated.decorated, undefined);
  assert.equal(undecorated.method, 'findTrimTargetsForSpeaker');

  replacement.dispose();
  pageWindow.dispatchEvent(
    new TestCustomEvent('babel-helper-magnifier-request', {
      detail: { id: 'restored-native', operation: 'destroy', payload: { instanceId: 'missing' } }
    })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    responses.find((entry) => entry.id === 'restored-native')?.result,
    { ok: true }
  );
  const responseCountBeforeDispose = responses.length;
  pageWindow.__babelHelperMagnifierBridge.dispose();
  assert.equal(services.providerDisposed, true);
  assert.equal(pageWindow.__babelHelperMagnifierBridge, undefined);

  pageWindow.dispatchEvent(
    new TestCustomEvent('babel-helper-magnifier-request', {
      detail: { id: 'after-dispose', operation: 'destroy', payload: {} }
    })
  );
  assert.equal(responses.length, responseCountBeforeDispose);
});

async function loadClient() {
  const result = await build({
    entryPoints: [path.resolve('src/services/bridge-client-service.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2020'
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

function clientFixture(t, { loaded = false, invalidContext = false } = {}) {
  const listeners = new Map();
  const timers = new Map();
  const scripts = [];
  const requests = [];
  let time = 0;
  let nextTimer = 0;
  const pageWindow = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
      return true;
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, deadline: time + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  if (loaded) pageWindow.__babelHelperMagnifierBridge = {};
  const globals = {
    window: pageWindow,
    document: {
      documentElement: { appendChild(script) { scripts.push(script); } },
      createElement() {
        return { removed: false, remove() { this.removed = true; } };
      }
    },
    chrome: { runtime: { getURL(resource) {
      if (invalidContext) throw new Error('Extension context invalidated.');
      return `chrome-extension://helper/${resource}`;
    } } },
    CustomEvent: TestCustomEvent
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  pageWindow.addEventListener('babel-helper-magnifier-request', (event) => {
    requests.push(event.detail);
  });
  return {
    scripts,
    requests,
    timers,
    responseListeners: () => listeners.get('babel-helper-magnifier-response')?.size || 0,
    respond(id, result) {
      pageWindow.dispatchEvent(new TestCustomEvent('babel-helper-magnifier-response', {
        detail: { id, result }
      }));
    },
    advance(milliseconds) {
      time += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.deadline <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
    }
  };
}

test('magnifier clients load independently and correlate concurrent out-of-order responses', async (t) => {
  const { createMagnifierBridgeClient } = await loadClient();
  const fixture = clientFixture(t);
  const magnifier = createMagnifierBridgeClient('request-');
  const minimap = createMagnifierBridgeClient('minimap-request-');
  const scale = createMagnifierBridgeClient('waveform-scale-');
  const settled = [];
  const track = (name, request) => request.then((result) => {
    settled.push(name);
    return result;
  });
  const first = track('first', magnifier('ensure', { instanceId: 'lens-a' }));
  const second = track('second', magnifier('update', { instanceId: 'lens-b' }));
  const map = track('map', minimap('minimap-data'));
  const zoom = track('zoom', scale('waveform-scale-set', { scale: 2 }));
  assert.equal(fixture.scripts.length, 3, 'one pending load per client, not per call');
  assert.deepEqual(fixture.requests, []);

  fixture.scripts[1].onload();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.requests.map((request) => request.operation), ['minimap-data']);
  fixture.respond(fixture.requests[0].id, { lanes: ['speaker-a'] });
  assert.deepEqual(await map, { lanes: ['speaker-a'] });
  assert.deepEqual(settled, ['map'], 'one loaded client must not release another client');

  fixture.scripts[0].onload();
  fixture.scripts[2].onload();
  await new Promise((resolve) => setImmediate(resolve));
  const ids = fixture.requests.map((request) => request.id);
  assert.equal(new Set(ids).size, 4, 'independent counters must not collide on the shared channel');
  fixture.respond('unrelated-request', { ok: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(settled, ['map']);
  const requestFor = (operation) => fixture.requests.find((request) => request.operation === operation);
  fixture.respond(requestFor('waveform-scale-set').id, { scale: 2 });
  fixture.respond(requestFor('update').id, { lens: 'lens-b' });
  fixture.respond(requestFor('ensure').id, { lens: 'lens-a' });
  assert.deepEqual(await Promise.all([first, second, zoom]), [
    { lens: 'lens-a' }, { lens: 'lens-b' }, { scale: 2 }
  ]);
  assert.equal(fixture.responseListeners(), 0);
  assert.equal(fixture.timers.size, 0);
  assert.ok(fixture.scripts.every((script) => script.removed));
});

test('magnifier timeout releases its listener and late replies cannot settle a subsequent call', async (t) => {
  const { createMagnifierBridgeClient } = await loadClient();
  const fixture = clientFixture(t, { loaded: true });
  const call = createMagnifierBridgeClient('request-');
  let settled = false;
  const lost = call('ensure').then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  const expiredId = fixture.requests[0].id;
  fixture.respond('wrong-id', { ok: true });
  fixture.advance(699);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  fixture.advance(1);
  assert.equal(await lost, null);
  assert.equal(fixture.responseListeners(), 0);
  assert.equal(fixture.timers.size, 0);

  let nextSettled = false;
  const next = call('ensure').then((result) => { nextSettled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  fixture.respond(expiredId, { stale: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextSettled, false);
  fixture.respond(fixture.requests[1].id, { lens: 'recovered' });
  assert.deepEqual(await next, { lens: 'recovered' });
  assert.equal(fixture.responseListeners(), 0);
  assert.equal(fixture.timers.size, 0);
  assert.deepEqual(fixture.scripts, []);
});

test('magnifier script errors settle every load waiter and allow a later injection retry', async (t) => {
  const { createMagnifierBridgeClient } = await loadClient();
  const fixture = clientFixture(t);
  const call = createMagnifierBridgeClient('request-');
  const first = call('ensure');
  const second = call('update');
  fixture.scripts[0].onerror();
  assert.deepEqual(await Promise.all([first, second]), [null, null]);
  assert.equal(fixture.scripts[0].removed, true);
  assert.deepEqual(fixture.requests, []);
  assert.equal(fixture.responseListeners(), 0);
  assert.equal(fixture.timers.size, 0);

  const retried = call('ensure');
  assert.equal(fixture.scripts.length, 2);
  fixture.scripts[1].onload();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.respond(fixture.requests[0].id, { lens: 'available' });
  assert.deepEqual(await retried, { lens: 'available' });
  assert.equal(fixture.scripts[1].removed, true);
  assert.equal(fixture.responseListeners(), 0);
  assert.equal(fixture.timers.size, 0);
});

test('invalidated extension context settles magnifier requests without leaking listeners or timers', async (t) => {
  const { createMagnifierBridgeClient } = await loadClient();
  const fixture = clientFixture(t, { invalidContext: true });
  const call = createMagnifierBridgeClient('request-');
  assert.equal(await call('ensure'), null);
  assert.deepEqual(fixture.scripts, []);
  assert.deepEqual(fixture.requests, []);
  assert.equal(fixture.responseListeners(), 0);
  assert.equal(fixture.timers.size, 0);
});
