import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createNativeRenderFactories } from '../src/content/native-render-factories.generated.js';
import { createNativeSource } from './fixtures/native-source.mjs';

async function load(entry) {
  const result = await build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
    plugins: [{ name: 'native-fixture', setup(build) {
      build.onResolve({ filter: /^@nominy\/babel-babel-runtime$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const AUDIO_ENHANCEMENT_STATE_EVENT = 'babel-audio-enhancement-state';
        export const readAudioEnhancementState = () => globalThis.nativePlaybackFixture.source || null;
        export const readBabelPlaybackBindings = () => globalThis.nativePlaybackFixture.read();
        export const subscribeBabelEditorCommits = listener => globalThis.nativePlaybackFixture.subscribe(listener);
      ` }));
      build.onResolve({ filter: /features\/speaker-workflow$/ }, () => ({ path: 'speaker', namespace: 'speaker-fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'speaker-fixture' }, () => ({ contents: 'export const setSpeakerWorkflow = () => { throw new Error("not part of playback test"); };' }));
    } }]
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const { subscribeNativePlayback } = await load('src/content/native-playback-events.ts');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function wave() {
  const events = new Map();
  const rateListeners = new Set();
  const media = {
    addEventListener(name, listener) { assert.equal(name, 'ratechange'); rateListeners.add(listener); },
    removeEventListener(name, listener) { rateListeners.delete(listener); }
  };
  return {
    events, rateListeners, time: 1, paused: true, rate: 1,
    on(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); return () => this.un(name, callback); },
    un(name, callback) { events.get(name)?.delete(callback); },
    emit(name, ...args) { for (const callback of [...events.get(name) || []]) callback(...args); },
    getCurrentTime() { return this.time; }, getDuration() { return 30; },
    getPlaybackRate() { return this.rate; }, isPlaying() { return !this.paused; },
    getMediaElement() { return media; },
    setPlaybackRate(rate) { this.rate = rate; },
    seekTo(ratio) { this.time = 30 * ratio; this.emit('seeking'); this.emit('timeupdate'); },
    listenerCount() { return [...events.values()].reduce((sum, set) => sum + set.size, 0) + rateListeners.size; }
  };
}

function fixture(t) {
  const saved = new Map(['window', 'document', 'CustomEvent', 'nativePlaybackFixture'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const window = new EventTarget();
  const document = new EventTarget();
  const commits = new Set();
  const timers = new Map();
  let timerId = 0;
  const native = wave();
  const f = {
    window, document, commits, timers, wave: native, now: 0,
    bindings: { reviewActionId: 'task-one', waves: [native], recordingTracks: [{ id: 'recording-one', label: 'Speaker 1' }] }, reads: 0,
    read() { this.reads++; return this.bindings; },
    subscribe(listener) { if (this.unsupported) throw new Error('unsupported FiberRoot descriptor'); commits.add(listener); return () => commits.delete(listener); },
    commit() { for (const listener of [...commits]) listener(); }
  };
  f.bindings.isCurrent = function() {
    return this.reviewActionId === f.bindings.reviewActionId &&
      this.waves === f.bindings.waves && this.recordingTracks === f.bindings.recordingTracks;
  };
  f.bindings.togglePlayPause = () => { native.paused = !native.paused; native.emit(native.paused ? 'pause' : 'play'); };
  Object.assign(window, {
    performance: { now: () => f.now },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  Object.assign(globalThis, { window, document, nativePlaybackFixture: f, CustomEvent: class extends Event { constructor(name, init) { super(name); this.detail = init.detail; } } });
  t.after(() => {
    window.__babelHelperPlaybackBridge?.dispose();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return f;
}

async function bridge(f) {
  let provider;
  f.window.BabelMods = { unsafe: { services: {
    provide(_id, value) { provider = value; return { dispose() { provider = null; } }; },
    invoke(_id, method, ...args) { return provider[method](...args); }
  } } };
  const module = await load('src/content/playback-bridge.ts');
  module.initPlaybackBridge();
  return f.window.__babelHelperPlaybackBridge;
}

test('native play, seek, pause, rate, loading and ready push clocks without timers', async t => {
  const f = fixture(t);
  const samples = [];
  const release = subscribeNativePlayback(sample => samples.push(sample));
  await flush();
  assert.equal(samples.at(-1).paused, true);
  f.wave.paused = false;
  f.wave.time = 8;
  f.wave.emit('play'); f.wave.emit('timeupdate'); f.wave.emit('seeking');
  await flush();
  assert.equal(samples.length, 2, 'synchronous native signals coalesce');
  assert.equal(samples.at(-1).currentTime, 8);
  f.wave.rate = 2;
  for (const listener of f.wave.rateListeners) listener();
  await flush();
  assert.equal(samples.at(-1).playbackRate, 2);
  f.wave.emit('load'); f.wave.emit('loading');
  await flush();
  assert.equal(samples.at(-1).reason, 'playback-loading');
  assert.equal(samples.at(-1).paused, null);
  f.wave.time = 0; f.wave.emit('ready');
  await flush();
  assert.equal(samples.at(-1).currentTime, 0);
  f.wave.paused = true; f.wave.emit('pause');
  await flush();
  assert.equal(samples.at(-1).paused, true);
  assert.equal(f.timers.size, 0);
  release();
  assert.equal(f.wave.listenerCount(), 0);
  assert.equal(f.commits.size, 0);
});

test('commits replace native membership and stale source callbacks cannot publish', async t => {
  const f = fixture(t);
  const samples = [];
  const release = subscribeNativePlayback(sample => samples.push(sample));
  await flush();
  const old = f.wave;
  const stale = [...old.events.get('pause')];
  const replacement = wave(); replacement.time = 12;
  f.bindings = { ...f.bindings, reviewActionId: 'task-two', waves: [replacement] };
  f.commit();
  await flush();
  assert.equal(old.listenerCount(), 0);
  assert.equal(samples.at(-1).reviewActionId, 'task-two');
  assert.equal(samples.at(-1).currentTime, 12);
  const count = samples.length;
  for (const callback of stale) callback();
  await flush();
  assert.equal(samples.length, count);
  replacement.emit('destroy');
  await flush();
  assert.equal(samples.at(-1).reason, 'playback-loading');
  assert.equal(replacement.listenerCount(), 0);
  release();
  assert.equal(f.commits.size, 0);
});

test('unsupported hook and partially attached native listeners fail and release ownership', async t => {
  const f = fixture(t);
  f.unsupported = true;
  assert.throws(() => subscribeNativePlayback(() => {}), /unsupported FiberRoot/);
  assert.equal(f.wave.listenerCount(), 0);
  f.unsupported = false;
  const on = f.wave.on;
  f.wave.on = function(name, callback) { on.call(this, name, callback); if (name === 'pause') throw new Error('broken subscription'); return () => this.un(name, callback); };
  assert.throws(() => subscribeNativePlayback(() => {}), /broken subscription/);
  assert.equal(f.wave.listenerCount(), 0);
  assert.equal(f.commits.size, 0);
});

test('replacement subscription failure is terminal, not a paused sample or retry loop', async t => {
  const f = fixture(t);
  const samples = [];
  subscribeNativePlayback(sample => samples.push(sample));
  await flush();
  const unsupported = wave(); unsupported.on = undefined;
  f.bindings = { ...f.bindings, waves: [unsupported] };
  f.commit();
  await flush();
  assert.equal(samples.at(-1).fatal, true);
  assert.equal(samples.at(-1).paused, null);
  assert.equal(f.wave.listenerCount(), 0);
  assert.equal(f.commits.size, 0);
  assert.equal(f.timers.size, 0);
});

test('pause commands settle from native events and retain only an explicit failure deadline', async t => {
  const f = fixture(t);
  const page = await bridge(f);
  const playing = page.setPlaybackPaused(false);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 500);
  await flush();
  assert.equal((await playing).via, 'native-event');
  assert.equal(f.timers.size, 0);
  assert.equal(f.wave.listenerCount(), 0);
  assert.equal(f.commits.size, 0);
  f.bindings.togglePlayPause = () => {};
  const paused = page.setPlaybackPaused(true);
  await flush();
  const deadline = [...f.timers.values()][0];
  deadline.callback();
  assert.equal((await paused).reason, 'native-playback-timeout');
  assert.equal(f.timers.size, 0);
  assert.equal(f.wave.listenerCount(), 0);
});

test('native speed correction supplies real timeupdate after WebAudio silent rate changes', async t => {
  const f = fixture(t);
  await bridge(f);
  const samples = [];
  const release = subscribeNativePlayback(sample => samples.push(sample));
  await flush();
  f.wave.setPlaybackRate(2);
  await flush();
  assert.equal(samples.at(-1).playbackRate, 2);
  assert.equal(samples.at(-1).currentTime, 1);
  release();
});

test('hidden transport signals defer sampling until visibility and owned source ready', async t => {
  const f = fixture(t);
  const samples = [];
  const release = subscribeNativePlayback(sample => samples.push(sample));
  await flush();
  let clockReads = 0;
  f.wave.getCurrentTime = function() { clockReads++; return this.time; };
  f.document.hidden = true;
  f.wave.time = 8; f.wave.emit('timeupdate');
  await flush();
  assert.equal(clockReads, 0);
  assert.equal(samples.at(-1).currentTime, 1);
  f.document.hidden = false;
  f.document.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.equal(samples.at(-1).currentTime, 8);
  f.source = { taskId: 'task-one', status: 'switching' };
  f.window.dispatchEvent(new Event('babel-audio-enhancement-state'));
  await flush();
  assert.equal(samples.at(-1).reason, 'playback-loading');
  assert.equal(clockReads, 1);
  f.source.status = 'ready'; f.wave.time = 3;
  f.window.dispatchEvent(new Event('babel-audio-enhancement-state'));
  await flush();
  assert.equal(samples.at(-1).currentTime, 3);
  release();
});

test('bridge teardown cancels pending commands and releases their native leases', async t => {
  const f = fixture(t);
  const page = await bridge(f);
  f.bindings.togglePlayPause = () => {};
  const command = page.setPlaybackPaused(false);
  page.dispose();
  assert.equal((await command).reason, 'playback-disposed');
  assert.equal(f.commits.size, 0);
  assert.equal(f.wave.listenerCount(), 0);
  assert.equal(f.timers.size, 0);
});

test('queued samples and repeated cleanup retain their original document owner', async t => {
  const f = fixture(t);
  let removedDocumentListeners = 0;
  const remove = f.document.removeEventListener.bind(f.document);
  f.document.removeEventListener = (...args) => { removedDocumentListeners++; remove(...args); };
  const samples = [];
  const release = subscribeNativePlayback(sample => samples.push(sample));
  // Retire the environment before its initial queued notification completes.
  // The replacement deliberately has no event methods: it owns none of this
  // subscription's listeners and must never be consulted for cleanup.
  globalThis.document = {};
  await flush();
  assert.equal(samples.length, 0);
  assert.equal(removedDocumentListeners, 1);
  assert.equal(f.wave.listenerCount(), 0);
  assert.equal(f.commits.size, 0);
  release();
  assert.equal(removedDocumentListeners, 1, 'cleanup is idempotent before touching the owner');
});

test('clock event bursts have a 66ms event-only cadence and ordinary commits publish nothing', async t => {
  const f = fixture(t);
  const samples = [];
  const release = subscribeNativePlayback(sample => samples.push(sample));
  await flush();
  const initialReads = f.reads;
  let clockReads = 0;
  f.wave.getCurrentTime = function() { clockReads++; return this.time; };
  for (let time = 1; time <= 1000; time++) {
    f.now = time;
    f.wave.time = time / 1000;
    f.wave.emit('timeupdate');
    f.commit();
    await flush();
  }
  assert.equal(samples.length, 16, 'initial notification plus 15 native clock samples, not 1000');
  assert.equal(clockReads, 15);
  assert.equal(f.reads, initialReads, 'ordinary commits and native timeupdates never rediscover bindings');
  assert.equal(f.timers.size, 0, 'no trailing timer, watchdog or render loop');
  f.now = 1001;
  f.wave.time = 0.2;
  f.wave.emit('seeking');
  await flush();
  assert.equal(samples.at(-1).currentTime, 0.2, 'seek bypasses clock coalescing');
  f.wave.paused = true;
  f.wave.emit('pause');
  await flush();
  assert.equal(samples.at(-1).paused, true);
  const listenerCount = f.wave.listenerCount();
  f.bindings = { ...f.bindings, recordingTracks: [{ id: 'recording-one', label: 'Updated lane' }] };
  f.commit();
  await flush();
  assert.equal(samples.at(-1).recordingTracks[0].label, 'Updated lane');
  assert.equal(f.reads, initialReads + 1, 'only relevant metadata replacement reconciles');
  assert.equal(f.wave.listenerCount(), listenerCount, 'metadata-only commit does not churn wave listeners');
  release();
});

const editorContract = createNativeRenderFactories({}).find(entry => entry.id === 59327);
const nativeEditorSource = editorContract.originals[1];

function boundedPlaybackFixture(f, source) {
  const native = createNativeSource(source);
  const waves = [f.wave, wave()];
  for (const player of waves) {
    player.play = () => { player.paused = false; player.emit('play'); };
    player.pause = () => { player.paused = true; player.emit('pause'); };
    player.rate = 2;
  }
  const scope = {
    p3: Object.fromEntries(waves.map((player, index) => [index, { wavesurfer: player }])),
    k3: { current: null }, g2: { current: false }, h2: { current: false },
    window: f.window, performance: { now: () => f.now }
  };
  // Execute the actual native callback bodies in their transport closure, both
  // before and after Helper's factory transformation.
  for (const name of ['S3', 'j3', 'N2', 'T3', 'I2', 'A2', 'E2', 'D2', 'M2', 'L2', 'P3']) {
    scope[name] = native.callback(name, scope, 'seekAllTracksToTime');
  }
  return { waves, scope, playRegion: scope.M2, seek: scope.N2, toggle: scope.E2, cancel: scope.S3 };
}

for (const [variant, source] of [['native', nativeEditorSource], ['optimized', editorContract.factory.toString()]]) {
  test(`${variant} current bounded playback uses rate-aware deadline and removes its listener at end crossing`, t => {
    const f = fixture(t), playback = boundedPlaybackFixture(f, source);
    playback.playRegion(1, 3);
    assert.equal([...f.timers.values()][0].delay, 2000, '2 audio seconds at 2x plus the native one-second grace');
    assert.ok(playback.waves.every(player => !player.paused));
    f.now = 500; f.wave.time = 2; f.wave.emit('timeupdate', 2);
    assert.equal(f.timers.size, 1);
    f.now = 1000; f.wave.time = 3; f.wave.emit('timeupdate', 3);
    assert.ok(playback.waves.every(player => player.paused && player.time === 3));
    assert.equal(f.timers.size, 0);
    assert.equal(f.wave.listenerCount(), 0);
    assert.equal(playback.scope.k3.current, null);
  });

  test(`${variant} current bounded playback cancels on external seek, explicit seek and toggle without stale stops`, t => {
    const f = fixture(t), playback = boundedPlaybackFixture(f, source);
    playback.playRegion(1, 3);
    f.wave.time = 20; f.wave.emit('timeupdate', 20);
    assert.equal(f.timers.size, 0);
    assert.equal(f.wave.listenerCount(), 0);
    assert.equal(f.wave.time, 20, 'A discontinuity cancels, rather than seeking back to the old bound');
    assert.equal(f.wave.paused, false);
    playback.playRegion(1, 3);
    playback.seek(10);
    assert.equal(f.timers.size, 0);
    assert.ok(playback.waves.every(player => player.time === 10));
    playback.playRegion(1, 3);
    playback.toggle();
    assert.equal(f.timers.size, 0);
    assert.equal(f.wave.listenerCount(), 0);
    assert.ok(playback.waves.every(player => player.paused));
    playback.playRegion(1, 3);
    f.wave.time = 0; f.wave.emit('timeupdate', 0);
    assert.equal(f.timers.size, 0, 'Backward loop jumps cancel the old range as well');
    playback.playRegion(1, 3);
    playback.cancel();
    playback.cancel();
    assert.equal(f.timers.size, 0);
    assert.equal(f.wave.listenerCount(), 0, 'The native unmount cleanup is idempotent');
  });

  test(`${variant} current bounded playback deadline detects a seek even without a timeupdate`, t => {
    const f = fixture(t), playback = boundedPlaybackFixture(f, source);
    playback.playRegion(1, 3);
    const deadline = [...f.timers.values()][0];
    f.now = 2000; f.wave.time = 20;
    deadline.callback();
    assert.equal(f.wave.time, 20);
    assert.equal(f.wave.paused, false);
    assert.equal(f.timers.size, 0);
    assert.equal(f.wave.listenerCount(), 0);
  });
}
