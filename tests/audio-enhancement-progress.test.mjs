import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function loadEntry(entryPoint) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

const brokerModule = await loadEntry('src/services/gold-drafting-ai-broker.ts');
const streamModule = await loadEntry('src/services/audio-enhancement-stream.ts');
const featureModule = await loadEntry('src/features/audio-enhancement-feature.ts');
const progress = { phase: 'enhancing', trackId: 'track-1', trackIndex: 0, trackCount: 2, completedChunks: 1, totalChunks: 4 };
const event = overrides => ({ type: 'event', event: 'enhancement-progress', operation: 'enhanceAudio', progress, ...overrides });
const state = overrides => ({ version: 2, taskId: 'task-1', status: 'processing', strength: 0, desiredStrength: 90, revision: 1, variantKey: '', ...overrides });

function installGlobals(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
}

function clock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  const api = {
    timers,
    now: () => now,
    setTimeout(callback, delay) { const key = ++id; timers.set(key, { callback, due: now + delay, interval: 0 }); return key; },
    clearTimeout(key) { timers.delete(key); },
    setInterval(callback, delay) { const key = ++id; timers.set(key, { callback, due: now + delay, interval: delay }); return key; },
    clearInterval(key) { timers.delete(key); },
    advance(duration) {
      const end = now + duration;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [key, timer] = next;
        now = timer.due;
        if (timer.interval) timer.due += timer.interval; else timers.delete(key);
        timer.callback();
      }
      now = end;
    }
  };
  return api;
}

function brokerHarness(t) {
  const timer = clock();
  const ports = [];
  const chrome = { runtime: {
    getURL: path => `chrome-extension://helper/${path}`,
    connect() {
      const messages = new Set();
      const disconnects = new Set();
      const port = {
        onMessage: { addListener: listener => messages.add(listener) },
        onDisconnect: { addListener: listener => disconnects.add(listener) },
        postMessage() {},
        disconnect() { port.disconnected = true; for (const listener of disconnects) listener(); },
        deliver(message) { for (const listener of messages) listener(message); }
      };
      ports.push(port);
      return port;
    }
  } };
  const window = { ...timer, chrome, location: { origin: 'https://babel.test' } };
  const document = { documentElement: { getAttribute: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', setAttribute() {} } };
  installGlobals(t, { window, document, chrome, performance: { now: timer.now } });
  return { timer, ports, window, document };
}

test('enhancement broker events validate the shared counters and retain ordinary events', () => {
  const valid = brokerModule.isGoldDraftingAiBrokerEvent;
  assert.equal(valid(event()), true);
  for (const phase of ['queued', 'cache-lookup', 'cache-hit', 'loading-model', 'encoding', 'transferring']) {
    assert.equal(valid(event({ progress: { ...progress, phase, completedChunks: 0, totalChunks: 0 } })), true);
  }
  assert.equal(valid({ type: 'event', event: 'accepted' }), true);
  assert.equal(valid({ type: 'event', event: 'capturing-audio', operation: 'enhanceAudio', message: 'Capturing native tracks' }), true);
  assert.equal(valid({ type: 'event', event: 'accepted', progress }), true);
  for (const invalid of [undefined, null, {}, event({ operation: 'transcribeSegment' }), event({ progress: undefined }),
    event({ message: {} }), event({ elapsedMs: -1 }), event({ progress: { ...progress, trackIndex: 2 } }),
    event({ progress: { ...progress, completedChunks: 5 } }), event({ progress: { ...progress, totalChunks: 0 } }),
    event({ progress: { ...progress, trackId: '' } }), event({ progress: { ...progress, completedChunks: 0.5 } })]) {
    assert.equal(valid(invalid), false, JSON.stringify(invalid));
  }
});

test('enhancement progress distinguishes remote upload and rejects unsupported execution routes', () => {
  const valid = brokerModule.isGoldDraftingAiBrokerEvent;
  assert.equal(valid(event({ progress: { ...progress, backend: 'swarm', backendReason: 'WebGPU unavailable.' } })), true);
  assert.equal(valid(event({ progress: { ...progress, phase: 'uploading', completedChunks: 0, totalChunks: 0, backend: 'swarm' } })), true);
  assert.equal(valid(event({ progress: { ...progress, backend: 'webgpu' } })), true);
  for (const fields of [
    { backend: 'cuda' }, { backend: 'wasm' }, { backend: 'swarm', threads: 4 },
    { backend: 'swarm', backendReason: '' }, { backend: 'swarm', backendReason: 'x'.repeat(257) },
    { backend: 'webgpu', backendReason: 'unexpected fallback' },
  ]) assert.equal(valid(event({ progress: { ...progress, ...fields } })), false);
});

test('MAIN state publication rejects malformed optional enhancement progress', () => {
  assert.equal(streamModule.isAudioEnhancementState(state()), true);
  assert.equal(streamModule.isAudioEnhancementState(state({ progress })), true);
  assert.equal(streamModule.isAudioEnhancementState(state({ progress: { ...progress, trackCount: 0 } })), false);
  assert.equal(streamModule.isAudioEnhancementState(state({ progress: { ...progress, phase: 'finished' } })), false);
});

test('real enhancement events keep healthy inference alive beyond the five-minute idle deadline', async t => {
  const { timer, ports } = brokerHarness(t);
  const received = [];
  const request = brokerModule.requestGoldDraftingAiBroker({ operation: 'enhanceAudio', taskId: 'task-1' }, { onEvent: value => received.push(value) });
  const port = ports[0];
  for (let completedChunks = 1; completedChunks <= 4; completedChunks += 1) {
    timer.advance(240000);
    assert.notEqual(port.disconnected, true);
    port.deliver(event({ progress: { ...progress, completedChunks } }));
  }
  port.deliver({ type: 'result', response: { ok: true } });
  assert.equal((await request).ok, true);
  assert.equal(received.length, 4);
  assert.equal(timer.timers.size, 0);
});

test('invalid enhancement events fail visibly instead of reaching onEvent', async t => {
  const { ports, timer } = brokerHarness(t);
  let called = false;
  const request = brokerModule.requestGoldDraftingAiBroker({ operation: 'enhanceAudio', taskId: 'task-1' }, { onEvent: () => { called = true; } });
  ports[0].deliver(event({ progress: { ...progress, completedChunks: 100 } }));
  const result = await request;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-gold-drafting-broker-progress');
  assert.match(result.message, /invalid progress metadata/);
  assert.equal(result.fallbackAllowed, false);
  assert.equal(called, false);
  assert.equal(timer.timers.size, 0);
});

class TestElement {
  constructor(document, tagName = 'div') {
    this.ownerDocument = document;
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.classes = new Set();
    this.listeners = new Map();
    this.classList = { add: name => this.classes.add(name), toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    this.style = { removeProperty() {}, setProperty() {} };
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'value') delete this.value; }
  matches(selector) { return selector === ':popover-open' && this.popoverOpen === true; }
  addEventListener(type, listener) {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, details = {}) {
    const event = { type, target: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...details };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    if (child.onload) queueMicrotask(() => child.onload());
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
  contains(node) { return this.all().includes(node); }
  attachShadow() {
    const nodes = new Map();
    for (const selector of ['[data-status]', '[data-strength]', '[data-selection]', '[data-details]', '[data-details-button]', '[data-progress-panel]', '[data-progress-label]', '[data-elapsed]', 'progress', '.bui-root']) nodes.set(selector, new TestElement(this.ownerDocument));
    const shadow = { host: this, nodes, querySelector: selector => selector === '#babel-shared-components-style' ? {} : nodes.get(selector) ?? null, addEventListener() {} };
    nodes.get('.bui-root').getRootNode = () => shadow;
    nodes.get('[data-details]').getRootNode = () => shadow;
    this.shadowRoot = shadow;
    return shadow;
  }
}

async function featureHarness(t, { deferredInjection = false, deferredDisposal = false } = {}) {
  const harness = brokerHarness(t);
  const listeners = new Map();
  const posts = [];
  const toolbar = new TestElement(harness.document);
  const playbackButton = new TestElement(harness.document, 'button');
  playbackButton.setAttribute('aria-label', 'Play all tracks');
  toolbar.appendChild(playbackButton);
  const scripts = [];
  const tabStorage = new Map();
  harness.window.sessionStorage = {
    getItem: key => tabStorage.get(key) ?? null,
    setItem: (key, value) => tabStorage.set(key, String(value))
  };
  let panel;
  let minimapBinds = 0;
  let observerDisconnects = 0;
  harness.document.createElement = tag => {
    const element = new TestElement(harness.document, tag);
    if (tag === 'span') panel = element;
    return element;
  };
  harness.document.body = new TestElement(harness.document, 'body');
  harness.document.body.appendChild(toolbar);
  const documentEvents = new TestElement(harness.document);
  harness.document.addEventListener = documentEvents.addEventListener.bind(documentEvents);
  harness.document.removeEventListener = documentEvents.removeEventListener.bind(documentEvents);
  harness.document.querySelector = selector => selector === '#babel-shared-components-style' ? {}
    : selector === '[aria-label="Play all tracks"], [aria-label="Pause all tracks"]' ? playbackButton : null;
  harness.window.location.href = 'https://babel.test/transcription?reviewActionId=task-1';
  harness.document.documentElement.appendChild = child => {
    scripts.push(child);
    if (!deferredInjection && child.onload) queueMicrotask(() => child.onload());
  };
  harness.window.addEventListener = (type, listener) => { const group = listeners.get(type) ?? new Set(); group.add(listener); listeners.set(type, group); };
  harness.window.removeEventListener = (type, listener) => listeners.get(type)?.delete(listener);
  const deliver = data => { for (const listener of [...(listeners.get('message') ?? [])]) listener({ source: harness.window, origin: harness.window.location.origin, data }); };
  harness.window.postMessage = data => {
    posts.push(data);
    if (data.type === 'dispose' && !deferredDisposal) queueMicrotask(() => deliver({ source: streamModule.AUDIO_ENHANCEMENT_EVENT_SOURCE, type: 'disabled', requestId: data.requestId }));
  };
  installGlobals(t, { MutationObserver: class { observe() {} disconnect() { observerDisconnects += 1; } } });
  let feature = featureModule.createAudioEnhancementFeature();
  const context = { helper: { settings: { features: { minimap: true, audioEnhancement: true } } },
    services: { minimap: { bindMinimap: () => { minimapBinds += 1; } } } };
  feature.start(context);
  const activation = feature.activate();
  if (!deferredInjection) await activation;
  else await Promise.resolve();
  return {
    ...harness, posts, listeners, scripts, activation, context,
    get feature() { return feature; },
    async restartFeature() {
      await feature.stop();
      feature = featureModule.createAudioEnhancementFeature();
      feature.start(context);
      await feature.activate();
    },
    get panel() { return panel; },
    dialog: () => harness.document.body.children.find(child => child.tagName === 'dialog'),
    dispatchWindow: (type, details = {}) => {
      for (const listener of listeners.get(type) ?? []) listener({ type, ...details });
    },
    node: selector => panel.shadowRoot.querySelector(selector),
    deliver,
    publish: (value, sessionId = 'session-1') => deliver({ source: streamModule.AUDIO_ENHANCEMENT_EVENT_SOURCE, type: 'state', sessionId, state: value }),
    minimapBinds: () => minimapBinds,
    observerDisconnects: () => observerDisconnects
  };
}

test('enabled enhancement initializes its toolbar and bridge without another extension', async t => {
  const harness = await featureHarness(t);
  assert.equal(harness.panel.parentElement !== null, true);
  assert.equal(harness.panel.isConnected, true);
  assert.equal(harness.document.querySelector('#babel-gold-drafting-magic-button'), null);
  assert.equal(harness.node('[data-strength]').value, '10');
  assert.equal(harness.node('[data-strength]').getAttribute('aria-valuetext'), '90% Enhanced, 10% Original');
  assert.equal(harness.scripts.length, 1);
  assert.equal(harness.posts.some(post => post.type === 'enable'), true);
  await harness.feature.stop();
});

test('disable cancels broker and removes enhancement surfaces; enabling can activate again', async t => {
  const harness = await featureHarness(t);
  const firstPanel = harness.panel;
  harness.publish(state());
  harness.deliver({ source: streamModule.AUDIO_ENHANCEMENT_EVENT_SOURCE, type: 'sources-ready',
    sessionId: 'session-1', taskId: 'task-1', tracks: ['one', 'two'].map(trackId => ({
      trackId, speakerKey: trackId, trackLabel: trackId, sourceSha256: 'a'.repeat(64), sampleRate: 48000, frameCount: 2
    })) });
  assert.equal(harness.ports.length, 1);
  harness.context.helper.settings.features.audioEnhancement = false;
  await harness.feature.deactivate();
  assert.equal(firstPanel.parentElement, null);
  assert.equal(harness.ports[0].disconnected, true);
  assert.equal(harness.timer.timers.size, 0);
  assert.equal(harness.listeners.get('message')?.size, 0);
  assert.ok(harness.posts.some(post => post.type === 'dispose'));
  const count = harness.posts.length;
  harness.publish(state({ revision: 99 }));
  await harness.feature.activate();
  assert.equal(harness.posts.length, count);
  harness.context.helper.settings.features.audioEnhancement = true;
  await harness.feature.activate();
  assert.notEqual(harness.panel, firstPanel);
  assert.equal(harness.scripts.length, 2, 'Enabling injects a fresh bridge after disposal');
  harness.publish(state({ revision: 1, status: 'ready' }));
  assert.equal(harness.panel.parentElement !== null, true);
  await harness.feature.stop();
});

test('disable during injection removes the script and cannot enable a late bridge', async t => {
  const harness = await featureHarness(t, { deferredInjection: true });
  assert.equal(harness.scripts.length, 1);
  const disabling = harness.feature.deactivate();
  await harness.activation;
  await disabling;
  harness.scripts[0].onload();
  await Promise.resolve();
  assert.equal(harness.posts.some(post => post.type === 'enable'), false);
  assert.equal(harness.scripts[0].parentElement, null);
  assert.equal(harness.panel.parentElement, null);
  await harness.feature.stop();
});

test('rapid re-enable waits for correlated native disposal acknowledgement, not elapsed time', async t => {
  const harness = await featureHarness(t, { deferredDisposal: true });
  const disabling = harness.feature.deactivate();
  assert.equal(harness.feature.deactivate(), disabling, 'concurrent disables share one drain');
  const request = harness.posts.find(post => post.type === 'dispose');
  let drained = false;
  void disabling.then(() => { drained = true; });
  const enabling = harness.feature.activate();
  harness.timer.advance(300001);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(drained, false, 'the former five-minute timer cannot release a native writer');
  assert.equal(harness.scripts.length, 1);
  assert.equal(harness.posts.filter(post => post.type === 'enable').length, 1);
  harness.deliver({ source: streamModule.AUDIO_ENHANCEMENT_EVENT_SOURCE, type: 'disabled', requestId: 'stale-request' });
  await Promise.resolve();
  assert.equal(drained, false);
  harness.deliver({ source: streamModule.AUDIO_ENHANCEMENT_EVENT_SOURCE, type: 'disabled', requestId: request.requestId });
  await Promise.all([disabling, enabling]);
  assert.equal(drained, true);
  assert.equal(harness.scripts.length, 2);
  assert.equal(harness.posts.filter(post => post.type === 'enable').length, 2);
  assert.equal(harness.listeners.get('message')?.size, 1);
  const stopping = harness.feature.stop();
  const finalRequest = harness.posts.filter(post => post.type === 'dispose').at(-1);
  harness.deliver({ source: streamModule.AUDIO_ENHANCEMENT_EVENT_SOURCE, type: 'disabled', requestId: finalRequest.requestId });
  await stopping;
  assert.equal(harness.listeners.get('message')?.size, 0);
});

test('cancelled pending injection settles without inventing a native disposal acknowledgement', async t => {
  const harness = await featureHarness(t, { deferredInjection: true, deferredDisposal: true });
  const disabling = harness.feature.deactivate();
  await harness.activation;
  harness.timer.advance(3000);
  await disabling;
  harness.scripts[0].onload();
  await Promise.resolve();
  assert.equal(harness.posts.some(post => post.type === 'enable'), false);
  assert.equal(harness.listeners.get('message')?.size, 0);
  await harness.feature.stop();
});

test('toolbar progress follows completed windows and terminal states stop pending work', async t => {
  const harness = await featureHarness(t);
  const bar = harness.node('progress');
  harness.publish(state({ status: 'idle' }));
  assert.equal(harness.node('[data-progress-panel]').hidden, false);
  assert.equal(bar.value, undefined);
  harness.publish(state({ revision: 2, progress }));
  assert.equal(bar.value, 0.125);
  harness.timer.advance(2000);
  assert.equal(bar.value, 0.125, 'Elapsed timers must never synthesize percentage progress');
  assert.equal(harness.minimapBinds(), 1, 'Progress-only publications must retain variant deduplication');
  const completed = { ...progress, trackId: 'track-2', trackIndex: 1, completedChunks: 4 };
  harness.publish(state({ revision: 3, progress: completed }));
  assert.equal(bar.value, 1);
  harness.publish(state({ revision: 4, progress: { ...completed, phase: 'encoding' } }));
  assert.equal(bar.value, undefined);
  const transferring = { ...completed, phase: 'transferring', completedChunks: 0, totalChunks: 0 };
  harness.publish(state({ revision: 5, progress: transferring }));
  assert.equal(bar.value, undefined);
  harness.publish(state({ revision: 6, status: 'switching', progress: transferring }));
  const message = `Native GPU enhancement failed: ${'full diagnostic detail '.repeat(40)}`;
  harness.publish(state({ revision: 7, status: 'error', message }));
  assert.equal(harness.node('[data-progress-panel]').hidden, true);
  assert.equal(harness.panel.getAttribute('aria-busy'), 'false');
  assert.equal(harness.node('[data-status]').textContent, message, 'The complete native error remains visible');
  assert.equal(harness.timer.timers.size, 0);
  harness.publish(state({ revision: 6, progress }));
  assert.equal(harness.node('[data-progress-panel]').hidden, true, 'An old publication cannot resurrect a failed operation');
  harness.publish(state({ revision: 8, status: 'ready', strength: 100, variantKey: 'b'.repeat(64) }));
  assert.equal(harness.node('[data-progress-panel]').hidden, true);
  await harness.feature.stop();
});

test('cache stages remain indeterminate until the native paired commit and stale inference cannot replace them', async t => {
  const harness = await featureHarness(t);
  const bar = harness.node('progress');
  const cacheProgress = phase => ({ ...progress, phase, completedChunks: 0, totalChunks: 0 });
  harness.publish(state({ progress: cacheProgress('cache-lookup') }));
  const lookupStage = harness.node('[data-progress-label]').textContent;
  assert.ok(lookupStage);
  assert.equal(bar.value, undefined);
  assert.equal(harness.node('[data-progress-panel]').hidden, false);
  harness.publish(state({ revision: 2, progress: cacheProgress('cache-hit') }));
  assert.notEqual(harness.node('[data-progress-label]').textContent, lookupStage, 'Lookup and reuse are distinct visible stages');
  assert.equal(bar.value, undefined);
  assert.equal(harness.minimapBinds(), 1, 'A cache hit is not a native paired selection commit');
  harness.timer.advance(3000);
  assert.equal(bar.value, undefined, 'Elapsed time cannot turn a cache hit into percentage inference');
  harness.publish(state({ revision: 1, progress }));
  assert.equal(bar.value, undefined, 'A stale inference publication cannot replace current cache reuse');
  harness.publish(state({ revision: 3, status: 'switching', progress: cacheProgress('cache-hit') }));
  assert.equal(harness.node('[data-progress-panel]').hidden, false);
  assert.equal(bar.value, undefined);
  harness.publish(state({ revision: 4, status: 'ready', strength: 100, variantKey: 'b'.repeat(64), message: 'Committed cache selection notice' }));
  assert.equal(harness.node('[data-progress-panel]').hidden, true);
  assert.equal(harness.timer.timers.size, 0);
  assert.equal(harness.minimapBinds(), 2, 'The committed cached pair invalidates the native source once');
  await harness.feature.stop();
});

test('navigation cancels stale progress and resets elapsed work', async t => {
  const harness = await featureHarness(t);
  harness.publish(state());
  const tracks = ['track-1', 'track-2'].map(trackId => ({ trackId, speakerKey: trackId, trackLabel: trackId, sourceSha256: 'a'.repeat(64), sampleRate: 48000, frameCount: 48000 }));
  harness.deliver({ source: streamModule.AUDIO_ENHANCEMENT_EVENT_SOURCE, type: 'sources-ready', sessionId: 'session-1', taskId: 'task-1', tracks });
  harness.ports[0].deliver(event());
  harness.timer.advance(3000);
  harness.publish(state({ revision: 2, taskId: 'task-2', status: 'idle' }), 'session-2');
  assert.equal(harness.node('[data-elapsed]').textContent, 'Elapsed 0:00');
  assert.equal(harness.ports[0].disconnected, true);
  const before = harness.posts.filter(value => value.type === 'progress').length;
  harness.ports[0].deliver(event({ progress: { ...progress, completedChunks: 2 } }));
  assert.equal(harness.posts.filter(value => value.type === 'progress').length, before);
  await harness.feature.deactivate();
  assert.equal(harness.timer.timers.size, 0);
  assert.equal(harness.listeners.get('message').size, 0);
  assert.equal(harness.listeners.get('pagehide').size, 0);
  assert.equal(harness.listeners.get('pointerup').size, 0);
  assert.equal(harness.listeners.get('pointercancel').size, 0);
  assert.equal(harness.observerDisconnects(), 1);
  await harness.feature.stop();
});

test('pointer preview stays local through progress and commits only the latest Enhanced percentage on release', async t => {
  const harness = await featureHarness(t);
  const slider = harness.node('[data-strength]');
  const requests = () => harness.posts.filter(value => value.type === 'select-strength');
  const input = value => { slider.value = String(value); slider.dispatch('input'); };
  harness.publish(state({ status: 'ready', strength: 100, model: 'zipr1', variantKey: 'a'.repeat(64) }));
  const committedLabel = harness.node('[data-selection]').textContent;
  slider.dispatch('pointerdown', { button: 0, pointerId: 7 });
  input(20);
  input(64);
  slider.dispatch('change');
  harness.timer.advance(1000);
  assert.equal(requests().length, 0, 'Neither input nor change may select while the pointer is held');
  harness.publish(state({ revision: 2, strength: 100, model: 'zipr1', variantKey: 'a'.repeat(64), progress }));
  assert.equal(slider.value, '60', 'Held values snap to tens and progress cannot move the thumb');
  assert.equal(harness.node('[data-selection]').textContent, committedLabel, 'Preview is not a committed native selection');
  harness.dispatchWindow('pointerup', { pointerId: 7 });
  input(65);
  assert.equal(requests().length, 0, 'Release waits for the range final default action before committing');
  slider.dispatch('change');
  harness.timer.advance(1000);
  assert.deepEqual(requests(), [{
    source: streamModule.AUDIO_ENHANCEMENT_COMMAND_SOURCE, type: 'select-strength',
    sessionId: 'session-1', taskId: 'task-1', strength: 30
  }]);
  harness.publish(state({ revision: 3, status: 'switching', strength: 100, desiredStrength: 30, variantKey: 'a'.repeat(64), model: 'zipr1' }));
  assert.equal(harness.minimapBinds(), 1, 'A desired strength is not a committed source change');
  harness.publish(state({ revision: 4, status: 'ready', strength: 30, desiredStrength: 30, variantKey: 'b'.repeat(64), model: 'zipr1' }));
  assert.equal(harness.minimapBinds(), 2);
  harness.publish(state({ revision: 5, status: 'ready', strength: 30, desiredStrength: 30, variantKey: 'c'.repeat(64), model: 'zipr1' }));
  assert.equal(harness.minimapBinds(), 3, 'A new source at the same strength must still invalidate the minimap');
  harness.publish(state({ revision: 6, status: 'ready', strength: 30, desiredStrength: 30, variantKey: 'c'.repeat(64), model: 'zipr1', progress }));
  assert.equal(harness.minimapBinds(), 3, 'Progress-only publications retain source deduplication');
  await harness.feature.stop();
});

test('native keyboard defaults remain available while releases coalesce and blur commits without a late duplicate', async t => {
  const harness = await featureHarness(t);
  const slider = harness.node('[data-strength]');
  const requests = () => harness.posts.filter(value => value.type === 'select-strength');
  const input = value => { slider.value = String(value); slider.dispatch('input'); };
  harness.publish(state({ status: 'ready', strength: 70, desiredStrength: 70, variantKey: 'a'.repeat(64), model: 'zipr1' }));
  assert.equal(slider.dispatch('keydown', { key: 'ArrowRight' }).defaultPrevented, false);
  input(40);
  slider.dispatch('change');
  harness.timer.advance(1000);
  assert.equal(requests().length, 0);
  slider.dispatch('keydown', { key: 'ArrowRight', repeat: true });
  input(50);
  harness.publish(state({ revision: 2, strength: 70, desiredStrength: 70, variantKey: 'a'.repeat(64), model: 'zipr1', progress }));
  assert.equal(slider.value, '50');
  slider.dispatch('keyup', { key: 'ArrowRight' });
  harness.timer.advance(100);
  assert.equal(requests().length, 0, 'Release starts a debounce, not an immediate native decode');
  assert.equal(slider.dispatch('keydown', { key: 'End' }).defaultPrevented, false);
  input(100);
  slider.dispatch('change');
  harness.timer.advance(1000);
  assert.equal(requests().length, 0, 'The next held key cancels the previous release debounce');
  slider.dispatch('keyup', { key: 'End' });
  harness.timer.advance(199);
  assert.equal(requests().length, 0);
  harness.timer.advance(1);
  assert.deepEqual(requests().map(value => value.strength), [0]);
  assert.equal(slider.dispatch('keydown', { key: 'Home' }).defaultPrevented, false);
  input(0);
  slider.dispatch('keyup', { key: 'Home' });
  slider.dispatch('blur');
  assert.deepEqual(requests().map(value => value.strength), [0], 'Home requires confirmation before sending 100%');
  const dialog = harness.dialog();
  assert.ok(dialog);
  dialog.all().find(node => node.textContent === 'Use 100% enhanced').dispatch('click');
  await Promise.resolve();
  assert.deepEqual(requests().map(value => value.strength), [0, 100]);
  slider.dispatch('change');
  harness.timer.advance(500);
  assert.deepEqual(requests().map(value => value.strength), [0, 100], 'Blur drains the queued commit exactly once');
  await harness.feature.stop();
});

test('pointer cancellation, task or session replacement and disable cannot leak old slider requests', async t => {
  const harness = await featureHarness(t);
  const slider = harness.node('[data-strength]');
  const requests = () => harness.posts.filter(value => value.type === 'select-strength');
  const input = value => { slider.value = String(value); slider.dispatch('input'); };
  harness.publish(state({ status: 'ready', strength: 90, model: 'zipr1', variantKey: 'a'.repeat(64) }));
  slider.dispatch('pointerdown', { button: 0, pointerId: 7 });
  input(40);
  harness.dispatchWindow('pointercancel', { pointerId: 7 });
  assert.equal(slider.value, '10', 'Cancellation restores the published selection');
  slider.dispatch('change');
  harness.timer.advance(500);
  assert.equal(requests().length, 0);

  slider.dispatch('pointerdown', { button: 0, pointerId: 8 });
  input(65);
  harness.publish(state({ revision: 2, taskId: 'task-2', status: 'ready', desiredStrength: 20 }), 'session-2');
  input(90);
  assert.equal(slider.value, '80', 'The cancelled hold cannot preview for the replacement task');
  harness.dispatchWindow('pointerup', { pointerId: 8 });
  slider.dispatch('change');
  harness.timer.advance(500);
  assert.equal(requests().length, 0);

  slider.dispatch('keydown', { key: 'ArrowLeft' });
  input(74);
  slider.dispatch('keyup', { key: 'ArrowLeft' });
  harness.publish(state({ revision: 3, taskId: 'task-2', status: 'ready' }), 'session-3');
  harness.timer.advance(500);
  assert.equal(requests().length, 0, 'A session reset discards a released-key debounce');
  slider.dispatch('keydown', { key: 'ArrowRight' });
  input(50);
  harness.publish(state({ revision: 4, taskId: 'task-3', status: 'ready', desiredStrength: 20 }), 'session-3');
  slider.dispatch('keydown', { key: 'ArrowRight', repeat: true });
  input(60);
  assert.equal(slider.value, '80');
  slider.dispatch('keyup', { key: 'ArrowRight' });
  slider.dispatch('change');
  harness.timer.advance(500);
  assert.equal(requests().length, 0, 'A held key from the old task cannot acquire the new task');

  slider.dispatch('keydown', { key: 'End' });
  input(100);
  slider.dispatch('keyup', { key: 'End' });
  await harness.feature.deactivate();
  slider.dispatch('blur');
  slider.dispatch('change');
  harness.timer.advance(500);
  assert.equal(requests().length, 0, 'Disable cancels released-key work and detached events');
  assert.equal(harness.timer.timers.size, 0);
  await harness.feature.stop();
});

test('full enhancement remembers confirmed approval per task across selections and feature recreation, not cancellation', async t => {
  const harness = await featureHarness(t);
  const slider = harness.node('[data-strength]');
  const requests = () => harness.posts.filter(value => value.type === 'select-strength');
  const select = original => { slider.value = String(original); slider.dispatch('input'); slider.dispatch('change'); };
  harness.publish(state({ status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }));
  select(0);
  const first = harness.dialog();
  assert.ok(first?.open);
  assert.equal(harness.document.activeElement.textContent, 'Cancel');
  assert.equal(slider.value, '10');
  assert.equal(harness.node('[data-selection]').textContent, '90%');
  harness.timer.advance(1000);
  assert.equal(requests().length, 0, 'Opening the warning cannot request full enhancement');
  first.all().find(node => node.textContent === 'Cancel').dispatch('click');
  await Promise.resolve();
  assert.equal(harness.dialog(), undefined);
  assert.equal(requests().length, 0);
  assert.equal(slider.value, '10', 'Cancellation keeps the prior selection');

  select(0);
  const second = harness.dialog();
  assert.notEqual(second, first);
  harness.publish(state({ revision: 2, status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }));
  assert.equal(harness.dialog(), second, 'Progress/state refresh without a new choice retains the warning');
  second.all().find(node => node.textContent === 'Use 100% enhanced').dispatch('click');
  assert.equal(requests().length, 0, 'The async confirmation must finish before requesting full enhancement');
  await Promise.resolve();
  assert.deepEqual(requests().map(value => value.strength), [100]);
  harness.publish(state({ revision: 3, status: 'ready', strength: 100, desiredStrength: 100, variantKey: 'b'.repeat(64) }));
  select(0);
  assert.equal(harness.dialog(), undefined, 'An unchanged full-enhancement selection is not a new transition');
  select(10);
  assert.deepEqual(requests().map(value => value.strength), [100, 90]);
  harness.publish(state({ revision: 4, status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }));
  select(0);
  assert.equal(harness.dialog(), undefined, 'The approved task must not warn again');
  assert.deepEqual(requests().map(value => value.strength), [100, 90, 100]);

  harness.publish(state({ revision: 5, taskId: 'task-2', status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }), 'session-2');
  select(0);
  assert.ok(harness.dialog()?.open, 'A different task needs its own approval');
  harness.dialog().dispatch('cancel');
  await Promise.resolve();
  harness.publish(state({ revision: 6, status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }), 'session-3');
  select(0);
  assert.equal(harness.dialog(), undefined, 'Returning to an approved task retains its approval');
  assert.equal(requests().at(-1).taskId, 'task-1');

  await harness.restartFeature();
  harness.publish(state({ status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }), 'session-4');
  const reloadedSlider = harness.node('[data-strength]');
  reloadedSlider.value = '0';
  reloadedSlider.dispatch('input');
  reloadedSlider.dispatch('change');
  assert.equal(harness.dialog(), undefined, 'A new feature instance reads the task approval from tab storage');
  assert.equal(requests().at(-1).sessionId, 'session-4');
  assert.equal(requests().at(-1).strength, 100);
  await harness.feature.stop();
});

test('blocked tab storage retains current-page approval but never silently approves after recreation', async t => {
  const harness = await featureHarness(t);
  Object.defineProperty(harness.window, 'sessionStorage', { get() { throw new Error('Storage blocked'); } });
  const select = original => {
    const slider = harness.node('[data-strength]');
    slider.value = String(original);
    slider.dispatch('input');
    slider.dispatch('change');
  };
  harness.publish(state({ status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }));
  select(0);
  harness.dialog().all().find(node => node.textContent === 'Use 100% enhanced').dispatch('click');
  await Promise.resolve();
  harness.publish(state({ revision: 2, status: 'ready', strength: 100, desiredStrength: 100, variantKey: 'a'.repeat(64) }));
  select(10);
  harness.publish(state({ revision: 3, status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }));
  select(0);
  assert.equal(harness.dialog(), undefined);
  assert.deepEqual(harness.posts.filter(value => value.type === 'select-strength').map(value => value.strength), [100, 90, 100]);
  await harness.restartFeature();
  harness.publish(state({ status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }), 'session-2');
  select(0);
  assert.ok(harness.dialog()?.open, 'Unavailable storage cannot manufacture approval');
  await harness.feature.stop();
});

for (const previousStrength of [0, 40, 90]) {
  test(`cancelling full enhancement retains the previous ${previousStrength}% selection`, async t => {
    const harness = await featureHarness(t);
    harness.publish(state({ status: 'ready', strength: previousStrength, desiredStrength: previousStrength,
      variantKey: previousStrength ? 'a'.repeat(64) : '' }));
    const slider = harness.node('[data-strength]');
    slider.value = '0';
    slider.dispatch('input');
    slider.dispatch('change');
    harness.dialog().all().find(node => node.textContent === 'Cancel').dispatch('click');
    await Promise.resolve();
    assert.equal(slider.value, String(100 - previousStrength));
    assert.equal(harness.node('[data-selection]').textContent, `${previousStrength}%`);
    assert.equal(harness.posts.some(value => value.type === 'select-strength'), false);
    await harness.feature.stop();
  });
}

for (const scenario of ['task', 'session', 'published-choice', 'superseding-selection', 'confirmed-then-superseded',
  'confirmed-then-task', 'confirmed-then-disable', 'confirmed-then-setting-disabled',
  'navigation', 'navigation-before-await', 'disable', 'stop', 'pagehide', 'teardown']) {
  test(`pending full-enhancement confirmation cannot survive ${scenario}`, async t => {
    const harness = await featureHarness(t);
    const slider = harness.node('[data-strength]');
    const requests = () => harness.posts.filter(value => value.type === 'select-strength');
    const select = original => { slider.value = String(original); slider.dispatch('input'); slider.dispatch('change'); };
    const publishSelection = (overrides, sessionId) => {
      const next = state({ variantKey: 'b'.repeat(64), ...overrides });
      assert.equal(streamModule.isAudioEnhancementState(next), true, 'Replacement selections must satisfy the native state protocol');
      harness.publish(next, sessionId);
    };
    harness.publish(state({ status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }));
    select(0);
    const dialog = harness.dialog();
    const confirm = dialog.all().find(node => node.textContent === 'Use 100% enhanced');
    if (scenario.startsWith('confirmed-then-')) confirm.dispatch('click');
    if (scenario === 'task' || scenario === 'confirmed-then-task') publishSelection({ revision: 2, taskId: 'task-2', status: 'ready', strength: 90 });
    if (scenario === 'session') publishSelection({ revision: 2, status: 'ready', strength: 90 }, 'session-2');
    if (scenario === 'published-choice') publishSelection({ revision: 2, status: 'ready', strength: 70, desiredStrength: 70 });
    if (scenario === 'superseding-selection' || scenario === 'confirmed-then-superseded') select(30);
    if (scenario === 'navigation' || scenario === 'navigation-before-await') {
      harness.window.location.href = 'https://babel.test/transcription?reviewActionId=task-2';
      if (scenario === 'navigation') harness.dispatchWindow('popstate');
    }
    if (scenario === 'disable' || scenario === 'confirmed-then-disable') await harness.feature.deactivate();
    if (scenario === 'confirmed-then-setting-disabled') harness.context.helper.settings.features.audioEnhancement = false;
    if (scenario === 'stop') await harness.feature.stop();
    if (scenario === 'pagehide') harness.dispatchWindow('pagehide');
    if (scenario === 'teardown') harness.dispatchWindow('babel-helper-bridge-teardown');
    if (scenario !== 'navigation-before-await') assert.equal(harness.dialog(), undefined, 'Invalidation removes the warning immediately');
    confirm.dispatch('click');
    await Promise.resolve();
    assert.equal(requests().some(value => value.strength === 100), false, 'A stale confirmation must never select full enhancement');
    assert.deepEqual(requests().map(value => value.strength),
      scenario === 'superseding-selection' || scenario === 'confirmed-then-superseded' ? [70] : []);
    await harness.feature.stop();
    assert.equal(harness.dialog(), undefined);
    assert.equal(harness.timer.timers.size, 0);
    harness.context.helper.settings.features.audioEnhancement = true;
    await harness.restartFeature();
    harness.publish(state({ status: 'ready', strength: 90, variantKey: 'a'.repeat(64) }), 'fresh-session');
    const freshSlider = harness.node('[data-strength]');
    freshSlider.value = '0';
    freshSlider.dispatch('input');
    freshSlider.dispatch('change');
    assert.ok(harness.dialog()?.open, 'A stale confirmation must not persist approval for its old task');
    await harness.feature.stop();
  });
}

function tinyWav() {
  const bytes = new ArrayBuffer(48);
  const view = new DataView(bytes);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  }
  view.setUint32(4, 40, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 96000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, 4, true);
  view.setInt16(44, 200, true);
  view.setInt16(46, -200, true);
  return bytes;
}

test('stream completion rejects invalid cache metadata before consuming usable audio and cache status does not change source identity', async () => {
  const bytes = tinyWav();
  const wavSha256 = await streamModule.audioSha256(bytes);
  const sources = ['track-1', 'track-2'].map(trackId => ({
    trackId, speakerKey: trackId, trackLabel: trackId, sourceSha256: 'a'.repeat(64), sampleRate: 48000, frameCount: 2
  }));
  const result = { ok: true, provider: 'browser-local', taskId: 'task-1', model: 'zipr1', modelSha256: 'c'.repeat(64),
    tracks: sources.map(source => ({ ...source, mimeType: 'audio/wav', wavSha256, totalBytes: bytes.byteLength, chunkCount: 1 })) };
  const createStream = () => {
    const assembler = new streamModule.AudioEnhancementStreamAssembler(sources);
    for (const source of sources) assembler.accept({ type: 'audio-chunk', trackId: source.trackId, chunkIndex: 0,
      chunkCount: 1, totalBytes: bytes.byteLength, dataBase64: Buffer.from(bytes).toString('base64') });
    return assembler;
  };
  const identities = new Set();
  for (const cache of [{}, { cacheStatus: 'hit' }, { cacheStatus: 'stored' },
    { cacheStatus: 'unavailable', cacheMessage: 'Persistence denied' }]) {
    const completed = await createStream().finish({ ...result, ...cache }, 'task-1');
    identities.add(completed.variantKey);
    assert.equal(completed.tracks.length, 2);
    for (const track of completed.tracks) assert.deepEqual(new Uint8Array(track.bytes), new Uint8Array(bytes));
  }
  assert.equal(identities.size, 1, 'Cache outcomes cannot change the enhanced source/model identity');
  for (const cache of [{ cacheStatus: 'future-status' }, { cacheStatus: 1 }, { cacheStatus: null },
    { cacheMessage: {} }, { cacheMessage: 1 }, { cacheMessage: null }]) {
    const assembler = createStream();
    await assert.rejects(assembler.finish({ ...result, ...cache }, 'task-1'), /invalid audio enhancement result metadata/);
    const recovered = await assembler.finish(result, 'task-1');
    assert.equal(identities.has(recovered.variantKey), true, 'Invalid cache metadata cannot consume or contaminate valid audio');
  }
});
