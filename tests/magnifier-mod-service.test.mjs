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
  ['waveform-scale-set', 'setWaveformScaleByTrackId'],
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
    const payload = operation === 'update'
      ? { instanceId: 'lens-a', regionId: 'region-a', side: 'right', width: 180, height: 80, scale: 3 }
      : {};
    const id = `request-${requestSequence++}`;
    pageWindow.dispatchEvent(
      new TestCustomEvent('babel-helper-magnifier-request', {
        detail: { id, operation, payload }
      })
    );
    await new Promise((resolve) => setImmediate(resolve));
    const finalResponse = responses.find((entry) => entry.id === id && 'result' in entry);
    assert.equal(finalResponse?.result?.method, method, `${operation} did not invoke ${method}`);
    if (operation === 'update') {
      assert.deepEqual(finalResponse.result.args, ['lens-a', 'region-a', 'right', 180, 80, 3]);
    }
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

test('zoom ready waits for the visible wave only and settles without Promise.withResolvers', async (t) => {
  const previous = ['window', 'document', 'CustomEvent', 'HTMLElement', 'ShadowRoot', 'MutationObserver'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]
  );
  const withResolvers = Promise.withResolvers;
  t.after(() => {
    Promise.withResolvers = withResolvers;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  // Chrome 114-118 (the esbuild target) has no Promise.withResolvers.
  Promise.withResolvers = undefined;

  class TestHTMLElement {
    constructor(visible = true) {
      this.isConnected = true;
      this.visible = visible;
      this.parentElement = null;
    }
    getRootNode() {
      return globalThis.document;
    }
    getBoundingClientRect() {
      return this.visible ? { width: 320, height: 48 } : { width: 0, height: 0 };
    }
  }
  const observers = [];
  const services = new TestServiceRegistry();
  const pageWindow = new EventTarget();
  const pageDocument = new EventTarget();
  const slider = new TestHTMLElement();
  const registry = {};
  const root = { stateNode: { current: null } };
  const editor = {
    return: root,
    memoizedProps: { reviewActionId: 'task-one', transcriptionChunkProcessedRecordings: [] },
    memoizedState: { memoizedState: { current: registry } }
  };
  root.stateNode.current = editor;
  slider.__reactFiber$test = editor;
  pageWindow.BabelMods = { unsafe: { services } };
  pageWindow.setTimeout = setTimeout;
  pageWindow.clearTimeout = clearTimeout;
  pageWindow.getComputedStyle = (element) => ({
    display: element.visible ? 'block' : 'none',
    visibility: 'visible'
  });
  pageDocument.documentElement = new TestHTMLElement();
  pageDocument.querySelector = (selector) => (selector.includes('[role="slider"]') ? slider : null);
  pageDocument.querySelectorAll = () => [slider];
  globalThis.window = pageWindow;
  globalThis.document = pageDocument;
  globalThis.CustomEvent = TestCustomEvent;
  globalThis.HTMLElement = TestHTMLElement;
  globalThis.ShadowRoot = class ShadowRoot {};
  globalThis.MutationObserver = class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };

  const makeWave = (container, decoded) => {
    const listeners = new Map();
    return {
      container,
      decoded,
      listeners,
      getDuration: () => 1,
      getCurrentTime: () => 0,
      getDecodedData() {
        return this.decoded ? { duration: 1 } : null;
      },
      on(event, callback) {
        listeners.set(event, callback);
        return () => listeners.delete(event);
      }
    };
  };
  const visible = makeWave(new TestHTMLElement(true), false);
  const collapsed = makeWave(new TestHTMLElement(false), false);
  registry.primary = { wavesurfer: visible };
  registry.collapsed = { wavesurfer: collapsed };

  const responses = [];
  pageWindow.addEventListener('babel-helper-magnifier-response', (event) => {
    responses.push(event.detail);
  });
  await loadBridge();
  t.after(() => pageWindow.__babelHelperMagnifierBridge?.dispose());

  const request = (id) => {
    pageWindow.dispatchEvent(
      new TestCustomEvent('babel-helper-magnifier-request', {
        detail: { id, operation: 'zoom-ready', payload: { timeoutMs: 5000 } }
      })
    );
    return new Promise((resolve) => setImmediate(resolve));
  };

  await request('pending');
  assert.equal(responses.find((entry) => entry.id === 'pending'), undefined);
  assert.equal(typeof visible.listeners.get('ready'), 'function');

  // The visible wave decoding is enough; the collapsed track never decodes.
  visible.decoded = true;
  visible.listeners.get('ready')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses.find((entry) => entry.id === 'pending')?.result, { ok: true });
  assert.equal(visible.listeners.size, 0);
  assert.equal(collapsed.listeners.size, 0);
  assert.equal(observers.at(-1).disconnected, true);

  // With every track hidden, any decoded wave is enough to zoom.
  visible.decoded = false;
  visible.container.visible = false;
  collapsed.decoded = true;
  await request('all-hidden');
  assert.deepEqual(responses.find((entry) => entry.id === 'all-hidden')?.result, { ok: true });

  // A visible wave that is not yet decoded still gates readiness.
  visible.container.visible = true;
  await request('gated');
  assert.equal(responses.find((entry) => entry.id === 'gated'), undefined);
  visible.decoded = true;
  visible.listeners.get('ready')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responses.find((entry) => entry.id === 'gated')?.result, { ok: true });
});

test('native minimap includes every committed turn and scale targets recording identity after lane reorder', async t => {
  class NativeElement extends EventTarget {
    constructor(attrs = {}) {
      super();
      this.attrs = new Map(Object.entries(attrs));
      this.style = {};
      this.isConnected = true;
      this.parentElement = null;
      this.children = [];
    }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    setAttribute(name, value) { this.attrs.set(name, value); }
    removeAttribute(name) { this.attrs.delete(name); }
    getRootNode() { return document; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 80 }; }
    querySelector() { return null; }
    closest(selector) { return selector.includes('[role="slider"]') ? this : null; }
    contains(element) { return element === this; }
  }
  class NativeShadowRoot {
    constructor(host, wrapper, scroll) { Object.assign(this, { host, wrapper, scroll }); }
    querySelector(selector) {
      return selector === '[part="wrapper"]' ? this.wrapper : selector === '[part="scroll"]' ? this.scroll : null;
    }
    contains(element) { return element === this.wrapper || element === this.scroll; }
  }
  const eventSource = () => {
    const listeners = new Map();
    return {
      listeners,
      on(event, listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
        return () => listeners.get(event)?.delete(listener);
      },
      un(event, listener) { listeners.get(event)?.delete(listener); },
      emit(event, ...args) { for (const listener of listeners.get(event) || []) listener(...args); }
    };
  };
  const observers = [];
  class NativeObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  let styleReads = 0;
  let annotationReads = 0;
  const channel = new Float32Array([0.1, 0.4, 0.2]);
  const audio = { duration: 1000, numberOfChannels: 1, getChannelData: () => channel };
  const lensRenders = [];
  const lensOptions = [];
  const mount = new NativeElement();
  const services = new TestServiceRegistry();
  const pageWindow = new EventTarget();
  Object.assign(pageWindow, {
    BabelMods: { unsafe: { services } },
    setTimeout, clearTimeout,
    getComputedStyle: () => { styleReads += 1; return { display: 'block', visibility: 'visible' }; }
  });
  const pageDocument = new EventTarget();
  const root = { stateNode: { current: null } };
  const editor = {
    return: root,
    memoizedProps: {
      reviewActionId: 'native-task',
      transcriptionChunkProcessedRecordings: [{ processedRecordingId: 'first' }, { processedRecordingId: 'second' }]
    }
  };
  root.stateNode.current = editor;
  const seed = new NativeElement();
  seed.__reactFiber$native = editor;
  const calls = [];
  const lanes = ['first', 'second'].map(id => {
    const slider = new NativeElement({ role: 'slider', 'data-orientation': 'vertical', 'aria-valuemin': '0.3', 'aria-valuemax': '20', 'aria-valuenow': '20' });
    const host = new NativeElement({ 'data-babel-helper-minimap-host': `${id}-host` });
    const wrapper = new NativeElement();
    wrapper.scrollWidth = 10000;
    const scroll = new NativeElement();
    scroll.clientWidth = 320;
    scroll.scrollLeft = 0;
    host.shadowRoot = new NativeShadowRoot(host, wrapper, scroll);
    const fiber = {
      return: editor,
      memoizedProps: {
        track: { id, processedRecordingId: id, label: id, colors: { region: 'blue' } },
        collapsed: false, isSolo: false, verticalZoom: 20,
        onToggleCollapse() {}, onToggleSolo() {},
        onAdjustVerticalZoom(value) {
          calls.push([id, value]);
          fiber.memoizedProps.verticalZoom = value;
          slider.setAttribute('aria-valuenow', String(value));
        }
      }
    };
    host.__reactFiber$native = fiber;
    slider.__reactFiber$native = { return: fiber, memoizedProps: { min: 0.3, max: 20, step: 0.001 } };
    const wave = {
      ...eventSource(),
      container: host, options: { minPxPerSec: 10, waveColor: 'blue' }, plugins: {},
      renderer: { wrapper },
      decodedData: audio,
      getDuration: () => 1000, getCurrentTime: () => 0,
      getDecodedData() { return this.decodedData; },
      setOptions() {}, exportPeaks: () => [[0.1, 0.4, 0.2]],
      constructor: {
        create(options) {
          const wrapper = new NativeElement();
          wrapper.scrollWidth = 1000 * options.minPxPerSec;
          const scroll = new NativeElement();
          scroll.clientWidth = 180;
          scroll.scrollLeft = 0;
          mount.shadowRoot = new NativeShadowRoot(mount, wrapper, scroll);
          const lens = {
            options, renderer: {
              wrapper,
              reRender() {
                wrapper.scrollWidth = 1000 * lens.options.minPxPerSec;
                lensRenders.push(this.audioData);
              }
            },
            setOptions(next) {
              lensOptions.push(next);
              this.options = { ...this.options, ...next };
              this.renderer.reRender();
            },
            getDuration: () => 1000,
            destroy() {}
          };
          return lens;
        }
      }
    };
    return { fiber, slider, host, wave };
  });
  const annotations = new Proxy(Array.from({ length: 650 }, (_, index) => ({
    id: `turn-${index}`, type: 'transcription', content: 'text',
    processedRecordingId: 'first', startTimeInSeconds: index, endTimeInSeconds: index + 0.5
  })), { get(target, key, receiver) {
    if (key === Symbol.iterator) annotationReads += 1;
    return Reflect.get(target, key, receiver);
  } });
  const nativeRegions = annotations.map(annotation => ({
    id: annotation.id, start: annotation.startTimeInSeconds, end: annotation.endTimeInSeconds,
    color: 'blue', element: new NativeElement({ part: `region ${annotation.id}` })
  }));
  const plugin = { ...eventSource(), getRegions: () => nativeRegions };
  lanes[0].wave.plugins = { regions: plugin };
  const panel = {
    return: editor,
    memoizedProps: {
      annotations, tracks: [], saveState: {}, renderTranscript() {}, onSave() {},
      onPlayPause() {}, onSeekToAnnotation() {}
    }
  };
  const transcript = { return: panel, memoizedProps: { turns: annotations.slice(0, 2), editingId: null, handlers: { onActivate() {}, onDeactivate() {}, onSelect() {}, onChangeText() {} } } };
  panel.child = transcript;
  editor.child = lanes[1].fiber;
  lanes[1].fiber.sibling = lanes[0].fiber;
  lanes[0].fiber.sibling = panel;
  editor.memoizedState = { memoizedState: { current: Object.fromEntries(lanes.map(lane => [lane.fiber.memoizedProps.track.id, { wavesurfer: lane.wave }])) } };
  pageDocument.documentElement = seed;
  pageDocument.querySelectorAll = selector => selector.includes('main,') ? [seed] : selector.includes('[role="slider"]') ? [lanes[1].slider, lanes[0].slider] : [];
  pageDocument.querySelector = selector => selector.includes('="first-host"') ? lanes[0].host
    : selector.includes('="lens-mount"') ? mount : null;
  for (const [name, value] of Object.entries({
    window: pageWindow, document: pageDocument, HTMLElement: NativeElement,
    HTMLCanvasElement: class {}, ShadowRoot: NativeShadowRoot, CustomEvent: TestCustomEvent,
    MutationObserver: NativeObserver, location: { href: 'https://dashboard.babel.audio/transcription?reviewActionId=native-task' }
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]);
  }
  await loadBridge();
  t.after(() => pageWindow.__babelHelperMagnifierBridge?.dispose());
  const native = services.providedService;
  const minimap = native.getMinimapData('first-host', { peakBins: 64 });
  assert.equal(minimap.ok, true);
  assert.equal(minimap.regions.length, 650, 'filtered/virtualized DOM does not truncate the full transcript');
  assert.equal(minimap.regions.at(-1).start, 649);
  const reads = { styles: styleReads, annotations: annotationReads };
  for (let index = 0; index < 20; index += 1) {
    const viewport = native.getMinimapData('first-host', { viewportOnly: true });
    assert.equal(viewport.ok, true);
    assert.equal('regions' in viewport, false);
    assert.equal('contentSignature' in viewport, false);
  }
  assert.deepEqual({ styles: styleReads, annotations: annotationReads }, reads,
    'viewport requests must not read annotation contents or computed styles');

  panel.memoizedProps.annotations = annotations.map(annotation => annotation.id === 'turn-10'
    ? { ...annotation, endTimeInSeconds: 10.75 } : annotation);
  root.stateNode.current = editor;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(native.getMinimapData('first-host', {}).regions[10].end, 10.75,
    'native annotation commits invalidate cached content independently of viewport requests');

  const ensured = native.ensureLens('first-host', 'lens-mount', 80, 3);
  assert.equal(ensured.ok, true);
  const firstLens = native.updateLens(ensured.id, 'turn-10', 'right', 180, 80, 3);
  assert.equal(firstLens.ok, true);
  const renderCount = lensRenders.length;
  const optionsCount = lensOptions.length;
  const dragReads = { styles: styleReads, annotations: annotationReads };
  nativeRegions[10].end = 12;
  const dragged = native.updateLens(ensured.id, 'turn-10', 'right', 180, 80, 3);
  assert.equal(dragged.time, 12);
  assert.equal(dragged.regions.find(region => region.id === 'turn-10').end, 12);
  assert.equal(native.getMinimapData('first-host', {}).regions[10].end, 10.75,
    'transient native bounds belong to the lens, not committed minimap content');
  assert.equal(lensRenders.length, renderCount);
  assert.equal(lensOptions.length, optionsCount);
  // Full minimap data reads the host style once; the lens drag reads none.
  assert.equal(styleReads, dragReads.styles + 1);
  assert.equal(annotationReads, dragReads.annotations);
  lanes[0].wave.options.waveColor = 'red';
  native.updateLens(ensured.id, 'turn-10', 'right', 180, 80, 3);
  assert.equal(lensRenders.length, renderCount + 1, 'theme update performs one renderer pass');
  assert.equal(lensOptions.length, optionsCount + 1);
  lanes[0].wave.decodedData = { ...audio };
  native.updateLens(ensured.id, 'turn-10', 'right', 180, 80, 3);
  assert.equal(lensRenders.length, renderCount + 2, 'new decoded source performs one renderer pass');
  assert.equal(lensOptions.length, optionsCount + 1, 'source-only change does not reset options');
  native.updateLens(ensured.id, 'turn-10', 'right', 180, 96, 3);
  native.updateLens(ensured.id, 'turn-10', 'right', 180, 96, 3);
  assert.equal(lensRenders.length, renderCount + 3, 'height changes render once, not on the next drag');
  lanes[0].wave.renderer.wrapper.scrollWidth = 20000;
  native.updateLens(ensured.id, 'turn-10', 'right', 180, 96, 3);
  assert.equal(lensRenders.length, renderCount + 4, 'native zoom changes render once');
  lanes[0].wave.emit('redraw');
  native.updateLens(ensured.id, 'turn-10', 'right', 180, 96, 3);
  native.updateLens(ensured.id, 'turn-10', 'right', 180, 96, 3);
  assert.equal(lensRenders.length, renderCount + 5,
    'a native redraw invalidates render-function/theme state even when option identities are unchanged');
  const scale = await native.setWaveformScaleByTrackId('first', 120, 1000, 'native-task');
  assert.equal(scale.ok, true);
  assert.equal(scale.current, 120);
  assert.deepEqual(calls, [['first', 120]], 'one native callback on the requested track, not visible index zero');
  editor.memoizedProps.reviewActionId = 'new-task';
  const rendersBeforeStale = lensRenders.length;
  assert.equal(native.updateLens(ensured.id, 'turn-10', 'right', 180, 80, 3).reason, 'stale-source');
  assert.equal(lensRenders.length, rendersBeforeStale);
  assert.equal(native.getMinimapData('first-host', { viewportOnly: true }).reason, 'stale-source');
  native.destroyLens(ensured.id);
  assert.ok(observers.every(observer => observer.disconnected), 'invalidated source observers are released');
  const stale = await native.setWaveformScaleByTrackId('first', 90, 1000, 'native-task');
  assert.equal(stale.reason, 'stale-task');
  assert.deepEqual(calls, [['first', 120]]);
});

test('magnifier keeps visible overlay nodes during drag and discards stale asynchronous updates', async t => {
  const frames = [];
  class LensElement {
    constructor(part = '') {
      this.attributes = new Map(part ? [['part', part]] : []);
      this.children = [];
      this.style = {};
      this.isConnected = true;
      this.parentElement = null;
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) || null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(node) { this.children.push(node); node.parentElement = this; }
    remove() {
      this.isConnected = false;
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    }
    querySelector() { return null; }
    getRootNode() { return scope; }
    getBoundingClientRect() { return { left: 0, right: 100, top: 0, width: 400, height: 100 }; }
  }
  class LensShadowRoot {
    querySelector(selector) {
      return selector === '[part="regions-container"]' ? container
        : ['[part="hover"]', '[part="wrapper"]', '[part="scroll"]'].includes(selector) ? host : null;
    }
  }
  const host = new LensElement();
  const container = new LensElement();
  const scope = new LensShadowRoot();
  scope.host = host;
  host.shadowRoot = scope;
  const region = new LensElement('region turn-one');
  const handle = new LensElement('region-handle-right');
  container.appendChild(region);
  region.appendChild(handle);
  const pageDocument = new EventTarget();
  pageDocument.createElement = () => new LensElement();
  const pageWindow = {
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {}
  };
  const pageLocation = { href: 'https://dashboard.babel.audio/transcription?reviewActionId=one' };
  let result = {
    ok: true, time: 2, windowStart: 0, windowEnd: 3,
    regions: [{ id: 'turn-one', start: 1, end: 2, backgroundColor: 'blue', borderRadius: '2px' }]
  };
  let pendingUpdate = null;
  let lensSequence = 0;
  const bridge = async operation => {
    if (operation === 'ensure') return { ok: true, id: `lens-${++lensSequence}` };
    if (operation === 'update') return pendingUpdate || result;
    return { ok: true };
  };
  const helper = { state: {}, config: { hotkeysHelpRows: [] } };
  t.after(() => helper.unbindMagnifier?.());
  for (const [name, value] of Object.entries({
    window: pageWindow, document: pageDocument, location: pageLocation,
    HTMLElement: LensElement, Element: LensElement, ShadowRoot: LensShadowRoot,
    __lensBridgeTest: bridge
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  const bundled = await build({
    entryPoints: [path.resolve('src/features/magnifier-feature.ts')],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020',
    plugins: [{
      name: 'lens-render-boundaries',
      setup(build) {
        build.onResolve({ filter: /^(?:@nominy\/babel-extension-frontend|\.\.\/services\/bridge-client-service)$/ },
          args => ({ path: args.path, namespace: 'lens-test' }));
        build.onLoad({ filter: /.*/, namespace: 'lens-test' }, args => ({
          contents: args.path.includes('bridge-client')
            ? 'export const createMagnifierBridgeClient = () => globalThis.__lensBridgeTest;'
            : 'export const themeRoot = () => {}; export const applyComponent = () => {};',
          loader: 'js'
        }));
      }
    }]
  });
  const feature = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
  feature.registerMagnifierService(helper);
  helper.bindMagnifier();
  const pointer = type => {
    const event = new Event(type);
    Object.assign(event, { button: 0, buttons: 1, pointerId: 1, composedPath: () => [handle, region] });
    pageDocument.dispatchEvent(event);
  };
  const draw = async () => {
    frames.shift()();
    await new Promise(resolve => setImmediate(resolve));
  };
  pointer('pointerdown');
  await draw();
  const magnifier = helper.state.magnifier;
  const firstNode = magnifier.regionNodes.get('turn-one').node;
  const firstWidth = firstNode.style.width;
  result = { ...result, time: 2.5, regions: [{ ...result.regions[0], end: 2.5 }] };
  pointer('pointermove');
  await draw();
  assert.equal(magnifier.regionNodes.get('turn-one').node, firstNode);
  assert.notEqual(firstNode.style.width, firstWidth);
  assert.equal(magnifier.regionsLayer.children.length, 1);
  const retiredInstance = magnifier.bridgeInstanceId;
  const resumedResult = { ...result, time: 2.75, regions: [{ ...result.regions[0], end: 2.75 }] };
  result = { ok: false, reason: 'stale-source' };
  pointer('pointermove');
  await draw();
  assert.equal(magnifier.bridgeInstanceId, null);
  result = resumedResult;
  pointer('pointermove');
  await draw();
  assert.notEqual(magnifier.bridgeInstanceId, retiredInstance);
  assert.equal(magnifier.regionNodes.get('turn-one').node, firstNode);
  assert.match(magnifier.badge.textContent, /2\.750s/);

  let resolveUpdate;
  pendingUpdate = new Promise(resolve => { resolveUpdate = resolve; });
  pointer('pointermove');
  await draw();
  const widthBeforeNavigation = firstNode.style.width;
  pageLocation.href = 'https://dashboard.babel.audio/transcription?reviewActionId=two';
  resolveUpdate({ ...result, regions: [{ ...result.regions[0], end: 3 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firstNode.style.width, widthBeforeNavigation, 'the previous task cannot repaint after navigation');
});
