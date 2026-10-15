import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { transform } from 'esbuild';

const nativeSource = await fs.readFile(new URL('../src/site/page-waveforms.ts', import.meta.url), 'utf8');
const isolatedSource = await fs.readFile(new URL('../src/features/selection-loop.ts', import.meta.url), 'utf8');
const speedSource = await fs.readFile(new URL('../src/features/playback-speed-hotkeys.ts', import.meta.url), 'utf8');
const speedImplementation = speedSource.slice(speedSource.indexOf('export function installNativeSpeedFix')).replace('export function', 'function');
const isolatedImplementation = (await transform(
  isolatedSource.slice(isolatedSource.indexOf('export function')).replace('export function', 'function'),
  { loader: 'ts' }
)).code;
const stopSource = nativeSource.slice(nativeSource.indexOf('  function stopLoop('), nativeSource.indexOf('  function getZoomSliderElement('));
const startSource = nativeSource.slice(nativeSource.indexOf('  async function startLoop('), nativeSource.indexOf('  const magnifierService ='));

class DetailEvent extends Event {
  constructor(type, options) { super(type); this.detail = options.detail; }
}

class Wave {
  constructor() {
    this.listeners = new Map();
    this.media = new EventTarget();
    this.media.seeking = false;
    this.time = 0;
    this.plays = [];
    this.pauses = 0;
    this.reject = null;
  }
  on(event, listener) {
    const listeners = this.listeners.get(event) || new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => this.un(event, listener);
  }
  un(event, listener) { this.listeners.get(event)?.delete(listener); }
  emit(event, ...args) { for (const listener of [...(this.listeners.get(event) || [])]) listener(...args); }
  getCurrentTime() { return this.time; }
  getDuration() { return 10; }
  getMediaElement() { return this.media; }
  play(start) {
    this.plays.push(start);
    this.time = start;
    this.emit('timeupdate', start);
    this.emit('seeking', start);
    return this.reject ? Promise.reject(new Error(this.reject)) : Promise.resolve();
  }
  pause() { this.pauses++; this.emit('pause'); }
  tick(time) { this.time = time; this.emit('timeupdate', time); }
  count() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

function harness(waves = [new Wave(), new Wave()]) {
  const host = { isConnected: true };
  const window = new EventTarget();
  const rejectPolling = () => { throw new Error('Native selection looping must not start a polling interval'); };
  window.setInterval = rejectPolling;
  const commits = new Set();
  const state = { task: 'one', variant: 'original', scans: 0, nativeUnavailable: false, waves };
  const states = [];
  window.addEventListener('babel-helper-selection-loop-state', event => states.push(event.detail));
  const loops = new Map();
  const { startLoop, stopLoop } = new Function(
    'loops', 'window', 'CustomEvent', 'readBabelPlaybackBindings', 'readAudioEnhancementState',
    'getLoopWaveSet', 'subscribeBabelEditorCommits', 'AUDIO_ENHANCEMENT_STATE_EVENT', 'setInterval',
    `${stopSource}\n${startSource}\nreturn { startLoop, stopLoop };`
  )(
    loops, window, DetailEvent, () => ({ reviewActionId: state.task }), () => ({ variantKey: state.variant }),
    () => { state.scans++; return { host, wave: state.waves[0], waves: state.waves }; },
    callback => {
      if (state.nativeUnavailable) throw new Error('Native editor commits unavailable');
      commits.add(callback);
      return () => commits.delete(callback);
    }, 'source-change', rejectPolling
  );
  return { waves, host, window, commits, state, states, loops, startLoop, stopLoop,
    commit: () => { for (const listener of [...commits]) listener(); } };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function assertReleased(h) {
  assert.equal(h.loops.size, 0);
  assert.equal(h.commits.size, 0);
  for (const wave of h.waves) assert.equal(wave.count(), 0);
}

test('captured WebAudio reactive seeking order stays owned through initial play and every wrap', async () => {
  // Captured 99407: media seeking first sets the reactive seeking signal
  // (whose time is stale), then forwards actual time. The ensuing media
  // timeupdate updates the signal and emits seeking again before play.
  class CapturedOrderWave extends Wave {
    play(start) {
      this.plays.push(start);
      const staleTime = this.time;
      this.time = start;
      this.emit('seeking', staleTime);
      this.emit('seeking', start);
      this.emit('timeupdate', start);
      this.emit('seeking', start);
      this.emit('timeupdate', start);
      this.emit('play');
      this.emit('timeupdate', start);
      return Promise.resolve();
    }
  }
  const h = harness([new CapturedOrderWave(), new CapturedOrderWave()]);
  assert.deepEqual(await h.startLoop('host', 0.8, 2.2), { ok: true });
  for (let pass = 0; pass < 3; pass++) {
    h.waves[0].tick(2.2);
    await settle();
    assert.equal(h.loops.size, 1);
    for (const wave of h.waves) assert.equal(wave.getCurrentTime(), 0.8);
  }
  for (const wave of h.waves) assert.deepEqual(wave.plays, [0.8, 0.8, 0.8, 0.8]);
  // The own seek token must not survive WebAudio's synchronous operation.
  h.waves[0].emit('seeking', 0.8);
  assertReleased(h);
});

test('HTML asynchronous stale and duplicate seek signals remain owned only until native seeked', async () => {
  class HtmlOrderWave extends Wave {
    play(start) {
      this.plays.push(start);
      this.time = start;
      this.media.seeking = true;
      this.emit('timeupdate', start);
      return Promise.resolve();
    }
  }
  const h = harness([new HtmlOrderWave(), new HtmlOrderWave()]);
  assert.deepEqual(await h.startLoop('host', 0.8, 2.2), { ok: true });
  for (const wave of h.waves) {
    wave.emit('seeking', 0);
    wave.emit('seeking', 0.8);
    wave.emit('seeking', 0.8);
    wave.media.seeking = false;
    wave.media.dispatchEvent(new Event('seeked'));
  }
  assert.equal(h.loops.size, 1);
  h.waves[0].emit('seeking', 0.8);
  assertReleased(h);
});

test('native timeupdate wraps exact range on both tracks without registry scans or timers', async () => {
  const h = harness();
  assert.deepEqual(await h.startLoop('host', 1.234567, 2.345678), { ok: true });
  const scans = h.state.scans;
  h.waves[0].tick(2.345677);
  assert.equal(h.waves[0].plays.length, 1);
  h.waves[0].tick(2.345678);
  await settle();
  for (const wave of h.waves) assert.deepEqual(wave.plays, [1.234567, 1.234567]);
  assert.equal(h.state.scans, scans);
  h.stopLoop('host');
  assertReleased(h);
});

test('native finish wraps physical audio end without treating its pause as user pause', async () => {
  const h = harness();
  await h.startLoop('host', 8, 10);
  h.waves[0].time = 10;
  h.waves[0].emit('pause');
  h.waves[0].emit('finish');
  await settle();
  assert.equal(h.loops.size, 1);
  assert.deepEqual(h.waves[1].plays, [8, 8]);
  h.stopLoop('host');
  assertReleased(h);
});

test('external seek crossing end cancels instead of wrapping; user pause stops both transports', async () => {
  for (const event of ['seeking', 'interaction', 'pause']) {
    const h = harness();
    await h.startLoop('host', 1, 2);
    if (event === 'seeking') {
      h.waves[0].media.seeking = true;
      h.waves[0].tick(5);
    }
    h.waves[0].emit(event, 5);
    await settle();
    assertReleased(h);
    assert.equal(h.waves[0].plays.length, 1);
    if (event === 'pause') for (const wave of h.waves) assert.equal(wave.pauses, 1);
  }
});

test('task, membership, source, destroy and native media replacement release ownership', async () => {
  for (const replacement of ['task', 'membership', 'variant', 'load', 'destroy', 'emptied', 'loadstart']) {
    const h = harness();
    await h.startLoop('host', 1, 2);
    if (replacement === 'task') { h.state.task = 'two'; h.commit(); }
    else if (replacement === 'membership') { h.state.waves = [new Wave()]; h.commit(); }
    else if (replacement === 'variant') { h.state.variant = 'enhanced'; h.window.dispatchEvent(new Event('source-change')); }
    else if (replacement === 'emptied' || replacement === 'loadstart') h.waves[0].media.dispatchEvent(new Event(replacement));
    else h.waves[0].emit(replacement);
    assertReleased(h);
  }
});

test('range replacement releases old listeners and uses the new exact start/end', async () => {
  const h = harness();
  await h.startLoop('host', 1, 2);
  const count = h.waves[0].count();
  await h.startLoop('host', 3, 4);
  assert.equal(h.waves[0].count(), count);
  assert.equal(h.commits.size, 1);
  h.waves[0].tick(4);
  await settle();
  assert.deepEqual(h.waves[0].plays, [1, 3, 3]);
  h.stopLoop('host');
  assertReleased(h);
});

test('missing subscriptions and rejected native plays fail visibly without fallback', async () => {
  for (const failure of ['commits', 'wave-events', 'initial-play', 'wrap-play']) {
    const h = harness();
    if (failure === 'commits') h.state.nativeUnavailable = true;
    if (failure === 'wave-events') h.waves[1].on = () => undefined;
    if (failure === 'initial-play') h.waves[1].reject = 'play denied';
    const result = await h.startLoop('host', 1, 2);
    if (failure === 'wrap-play') {
      assert.equal(result.ok, true);
      h.waves[1].reject = 'play denied';
      h.waves[0].tick(2);
      await settle();
    } else assert.equal(result.ok, false);
    assertReleased(h);
    assert.match(h.states.at(-1).reason, /failed/);
    assert.ok(h.states.at(-1).message);
  }
});

test('isolated bridge failure is shown on the preview and never selects a local playback fallback', async () => {
  class Element {
    constructor() { this.style = {}; this.isConnected = true; }
    setAttribute() {}
    getAttribute() { return 'host'; }
  }
  const host = new Element();
  const label = new Element();
  const preview = { hostMarker: 'host', container: host, element: { querySelector: () => label } };
  const helper = { state: { cutPreview: preview } };
  const window = new EventTarget();
  let bridgeResult = { ok: false, reason: 'native-events-unavailable' };
  const register = new Function('window', 'document', 'HTMLElement', 'captureL0TaskGuard',
    `${isolatedImplementation}\nreturn registerSelectionLoop;`
  )(window, { documentElement: {} }, Element, () => () => true);
  register(helper, {
    site: { getWaveformHostFromContainer: () => host,
      callSelectionBridge: async operation => operation === 'loop-stop' ? { ok: true } : bridgeResult },
    selection: { ensurePreviewTimeRange: async () => ({ startSeconds: 1, endSeconds: 2 }) }
  });
  assert.equal(await helper.startSelectionLoop(), false);
  assert.equal(helper.state.selectionLoop, null);
  assert.match(label.textContent, /Loop unavailable: native-events-unavailable/);
  bridgeResult = { ok: true };
  assert.equal(await helper.startSelectionLoop(), true);
  window.dispatchEvent(new DetailEvent('babel-helper-selection-loop-state', {
    detail: { hostMarker: 'host', reason: 'stopped' }
  }));
  assert.ok(helper.state.selectionLoop, 'a queued stop for the previous range cannot cancel the new range');
  window.dispatchEvent(new DetailEvent('babel-helper-selection-loop-state', {
    detail: { hostMarker: 'host', reason: 'loop-playback-failed', message: 'play denied' }
  }));
  assert.equal(helper.state.selectionLoop, null);
  assert.match(label.textContent, /Loop unavailable: play denied/);
});

test('actual native speed correction preserves looping without owning later external seeks', async () => {
  for (const asynchronousSeek of [false, true]) {
    class SpeedWave extends Wave {
      setPlaybackRate(rate) {
        // Native WebAudio changes its time base without emitting a seek.
        this.time *= rate;
      }
      seekTo(position) {
        const staleTime = this.time;
        this.time = position * this.getDuration();
        this.media.seeking = asynchronousSeek;
        this.emit('seeking', staleTime);
        this.emit('seeking', this.time);
        this.emit('timeupdate', this.time);
        this.emit('seeking', this.time);
      }
    }
    const h = harness([new SpeedWave(), new SpeedWave()]);
    const install = new Function('readBabelPlaybackBindings',
      `${speedImplementation}\nreturn installNativeSpeedFix;`
    )(() => ({ waves: h.waves }));
    const speedFix = install();
    await h.startLoop('host', 0.8, 2.2);
    const correctionIntent = Symbol.for('babel-helper-native-rate-correction');
    for (const wave of h.waves) {
      wave.tick(1.5);
      let nativeSeeks = 0;
      const off = wave.on('seeking', () => nativeSeeks++);
      wave.setPlaybackRate(2);
      assert.equal(wave.getCurrentTime(), 1.5);
      assert.ok(nativeSeeks, 'correction must preserve genuine events for other native consumers');
      off();
      assert.equal(Object.hasOwn(wave, correctionIntent), false, 'intent ends with the corrective command');
      if (asynchronousSeek) {
        wave.emit('seeking', 3);
        wave.emit('seeking', 1.5);
        wave.media.seeking = false;
        wave.media.dispatchEvent(new Event('seeked'));
      }
    }
    assert.equal(h.loops.size, 1);
    h.waves[0].tick(2.2);
    await settle();
    for (const wave of h.waves) assert.deepEqual(wave.plays, [0.8, 0.8]);
    h.waves[0].seekTo(0.4);
    assertReleased(h);
    speedFix.dispose();
  }
});

test('speed correction releases its scoped intent when the real corrective seek throws', () => {
  const wave = {
    getCurrentTime: () => 1,
    getDuration: () => 10,
    setPlaybackRate() {},
    seekTo() { throw new Error('native seek rejected'); }
  };
  const install = new Function('readBabelPlaybackBindings',
    `${speedImplementation}\nreturn installNativeSpeedFix;`
  )(() => ({ waves: [wave] }));
  const speedFix = install();
  assert.throws(() => wave.setPlaybackRate(2), /native seek rejected/);
  assert.equal(Object.hasOwn(wave, Symbol.for('babel-helper-native-rate-correction')), false);
  speedFix.dispose();
});
