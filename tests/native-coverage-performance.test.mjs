import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { nativeFactorySource } from './fixtures/native-factory-source.mjs';
import { createNativeSource } from './fixtures/native-source.mjs';

// Execute the checked-in current store itself as the oracle, not a second coverage implementation.
const source = createNativeSource(nativeFactorySource(59327));
const nativeCoverage = ['tF', 'tU', 'tW', 'tG', 'tK', 'tH', 'tV', 'tZ']
  .map(name => source.declaration(name)).join('\n');
const backendSource = nativeFactorySource(99407);
const NativeBackend = new Function(
  backendSource.slice(backendSource.indexOf('function r('), backendSource.indexOf('i.d(e,')) +
  backendSource.slice(backendSource.indexOf('class s {'), backendSource.indexOf('let n = { decode:')) +
  backendSource.slice(backendSource.indexOf('class C extends s {'), backendSource.indexOf('let S = { waveColor:')) +
  '; return C;'
)();
const bundle = await build({ entryPoints: ['src/content/native-coverage-performance.ts'], bundle: true,
  format: 'esm', platform: 'browser', write: false, logLevel: 'silent', plugins: [{ name: 'native-coverage-contract', setup(build) {
    build.onResolve({ filter: /^@nominy\/babel-babel-runtime$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export const findBabelEditorFiber = () => globalThis.coverageFixture?.editor || null;
      export const readBabelPlaybackBindings = () => globalThis.coverageFixture?.playback || null;
      export const subscribeBabelEditorCommits = listener => { globalThis.coverageFixture.commits.add(listener); return () => globalThis.coverageFixture.commits.delete(listener); };
    ` }));
  } }] });
const { attachNativeCoverage, readNativeCoverageBinding, installNativeCoveragePerformance } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

class NativeMedia {
  constructor(context, duration) {
    this.audioContext = context; this.bufferNode = null; this.playStartTime = 0; this.playedDuration = 0;
    this._muted = false; this._playbackRate = 1; this._volume = 1; this.buffer = { duration };
    this.currentSrc = 'native-original'; this.paused = true; this.events = new Map();
  }
  on(name, listener) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(listener); return () => this.un(name, listener); }
  un(name, listener) { this.events.get(name)?.delete(listener); }
  emit(name, ...args) { for (const listener of [...this.events.get(name) || []]) listener(...args); }
  get src() { return this.currentSrc; }
  set src(value) { this.currentSrc = value; this.buffer = null; }
  get currentTime() { return (this.paused ? this.playedDuration : this.playedDuration + this.audioContext.currentTime - this.playStartTime) * this._playbackRate; }
  set currentTime(value) { const playing = !this.paused; if (playing) this._pause(); this.playedDuration = value / this._playbackRate; if (playing) this._play(); this.emit('seeking'); this.emit('timeupdate'); }
  get playbackRate() { return this._playbackRate; }
  set playbackRate(value) { this._playbackRate = value; }
  get volume() { return this._volume; }
  set volume(value) { this._volume = value; this.emit('volumechange'); }
  get muted() { return this._muted; }
  set muted(value) { this._muted = value; }
  get duration() { return this.buffer?.duration || 0; }
  _play() {
    if (!this.paused) return;
    this.paused = false; this.bufferNode = { buffer: this.buffer };
    const offset = this.playedDuration * this._playbackRate;
    if (offset >= this.duration || offset < 0) this.playedDuration = 0;
    this.playStartTime = this.audioContext.currentTime;
  }
  _pause() { this.paused = true; this.playedDuration += this.audioContext.currentTime - this.playStartTime; }
  play() { if (this.paused) { this._play(); this.emit('play'); } }
  pause() { if (!this.paused) { this._pause(); this.emit('pause'); } }
  stopAt(time) { this.scheduledStopClock = this.audioContext.currentTime + time - this.currentTime; }
  finishScheduledStop() { this.bufferNode = null; this.pause(); }
}

function fixture(t, { duration = 30, ids = ['a'], segments = {}, nativeBackend = false } = {}) {
  const context = Object.assign(new EventTarget(), {
    currentTime: 0, state: 'running', destination: {},
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createBufferSource() {
      return Object.assign(new EventTarget(), {
        buffer: null, playbackRate: { value: 1 }, connect() {}, disconnect() {},
        start(clock, offset) { this.startedAt = clock; this.offset = offset; },
        stop(clock) { this.stoppedAt = clock; }
      });
    }
  });
  const timers = new Map(), writes = [], storage = new Map();
  let nextTimer = 0;
  const f = { context, timers, writes, storage, wall: 0, current: true, waves: new Map(), commits: new Set() };
  const environment = Object.assign(new EventTarget(), {
    performance: { now: () => f.wall },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, due: f.wall + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: { getItem: key => storage.get(key) || null, setItem(key, value) { storage.set(key, value); writes.push(JSON.parse(value)); } }
  });
  f.environment = environment;
  const Store = new Function('localStorage', 'performance', `${nativeCoverage}; return tZ;`)(environment.localStorage, environment.performance);
  const store = new Store();
  store.load('task-a'); store.setDuration(duration); store.setSpeakerSegments(segments);
  f.store = store;
  f.nativeSnapshot = store.buildSnapshot.bind(store);
  f.originalRecord = store.recordTime;
  for (const id of ids) {
    const media = nativeBackend ? new NativeBackend(context) : new NativeMedia(context, duration);
    if (nativeBackend) { media.buffer = { duration }; media.currentSrc = 'native-original'; }
    const wave = { getMediaElement: () => media, getDuration: () => media.duration, getCurrentTime: () => media.currentTime,
      on: media.on.bind(media), un: media.un.bind(media), media };
    media.on('timeupdate', () => store.recordTime(id, wave.getCurrentTime(), wave.getDuration(), !media.paused && media.volume > 0));
    store.setTrackDuration(id, duration);
    f.waves.set(id, wave);
  }
  const playback = { reviewActionId: 'task-a', waveTracks: [...f.waves].map(([trackId, wave]) => ({ trackId, wave })), isCurrent: () => f.current };
  f.playback = playback;
  const binding = { store, playback, taskId: 'task-a', isCurrent: () => f.current && store.reviewActionId === 'task-a' };
  f.attach = () => { f.lease = attachNativeCoverage(binding, environment); return f.lease; };
  f.advance = (seconds, tick = true) => {
    context.currentTime += seconds; f.wall += seconds * 1000;
    if (tick) for (const { media } of f.waves.values()) media.emit('timeupdate');
  };
  f.runTimers = () => { for (const [id, timer] of [...timers]) if (timer.due <= f.wall) { timers.delete(id); timer.callback(); } };
  f.media = f.waves.get(ids[0])?.media;
  t.after(() => f.lease?.dispose());
  return f;
}

function assertNativeSnapshot(f) { assert.deepEqual(f.store.getSnapshot(), f.nativeSnapshot()); }

test('audio-clock continuity credits a multi-second UI stall including the endpoint before pause', t => {
  const f = fixture(t); f.attach(); f.media.play();
  f.advance(6.2, false);
  f.media.pause();
  assert.ok(f.store.timeline.has(61));
  assert.equal(f.store.timeline.has(64), false);
  assertNativeSnapshot(f);
  assert.equal(f.writes.length, 1);
  assert.equal(f.timers.size, 0);
});

test('seeks, loop jumps, pause, mute, zero gain and source replacement never create connecting coverage', t => {
  const f = fixture(t, { duration: 60 }); f.attach(); f.media.play();
  f.advance(1, false); f.media.currentTime = 10;
  assert.equal(f.store.timeline.has(50), false);
  f.advance(1); f.media.muted = true;
  f.advance(5); f.media.muted = false;
  f.advance(1); f.media.volume = 0;
  f.advance(5); f.media.volume = 1;
  f.advance(1); f.media.pause();
  f.advance(5); f.media.play(); f.media.currentTime = 2;
  f.advance(1); f.media.src = 'native-enhanced';
  f.advance(8); f.media.buffer = { duration: 60 }; f.media.emit('ready');
  f.media.pause(); f.media.play();
  f.advance(1); f.lease.flush();
  for (const bin of [50, 125, 185, 245, 65, 85]) assert.equal(f.store.timeline.has(bin), false, `bin ${bin} was never audible`);
  for (const bin of [5, 105, 165, 225, 25, 115]) assert.ok(f.store.timeline.has(bin), `bin ${bin} was audible`);
  assertNativeSnapshot(f);
});

test('rate discontinuities preserve old endpoint and credit new 2x audio-clock span without a 1.25x wall gate', t => {
  const f = fixture(t); f.attach(); f.media.play(); f.advance(0.5, false);
  const time = f.media.currentTime;
  f.media.playbackRate = 2;
  // This is Helper native-speed-fix's actual corrective seek, not a coverage call.
  f.media.currentTime = time;
  f.advance(3, false); f.media.pause();
  assert.ok(f.store.timeline.has(64));
  assert.equal(f.store.timeline.has(70), false);
  assertNativeSnapshot(f);
});

test('a raw WebAudio rate change does not credit its incorrect reported-clock jump', t => {
  const f = fixture(t); f.attach(); f.media.play(); f.advance(3, false);
  f.media.playbackRate = 2;
  f.advance(1, false); f.media.pause();
  assert.ok(f.store.timeline.has(49));
  assert.equal(f.store.timeline.has(60), false, 'reported time jumps to 6, but the buffer was at 3');
  assertNativeSnapshot(f);
});

test('natural end clamps a delayed callback and preserves native last-half-second bin credit', t => {
  const f = fixture(t, { duration: 10.03 }); f.attach(); f.media.play();
  f.advance(12, false); f.media.pause(); f.media.emit('ended');
  assert.equal(f.store.getSnapshot().percent, 100);
  assert.equal(f.store.timeline.size, 101);
  assertNativeSnapshot(f);
});

test('the native inclusive bins and last-half-second tail are unchanged for fractional durations', t => {
  const f = fixture(t, { duration: 10.03 }); f.attach(); f.media.play();
  f.advance(9.6, false); f.media.pause();
  assert.equal(f.store.getSnapshot().percent, 100);
  assert.equal(f.store.timeline.size, 101);
  assertNativeSnapshot(f);
});

test('scheduled stopAt caps audible time even when its ended callback runs after a long UI stall', t => {
  const f = fixture(t); f.attach(); f.media.play(); f.media.stopAt(2);
  f.advance(7, false); f.media.finishScheduledStop();
  assert.ok(f.store.timeline.has(19));
  assert.equal(f.store.timeline.has(30), false);
  assertNativeSnapshot(f);
});

test('the actual current WebAudio backend keeps audible rate spans separate from its reported clock jump', t => {
  const f = fixture(t, { nativeBackend: true }); f.attach(); f.media.play();
  const firstNode = f.media.bufferNode;
  f.advance(3, false);
  f.media.playbackRate = 2;
  assert.equal(f.media.currentTime, 6, 'Native reported time changes slope retroactively');
  assert.equal(firstNode.playbackRate.value, 2, 'The same audible source changes speed, not offset');
  f.advance(1, false); f.media.pause();
  assert.ok(f.store.timeline.has(49));
  assert.equal(f.store.timeline.has(60), false);
  assertNativeSnapshot(f);
});

test('actual native stopAt uses its AudioContext deadline at non-unit speed and ignores an abandoned node end', t => {
  const f = fixture(t, { nativeBackend: true }); f.attach();
  f.media.playbackRate = 2; f.media.play(); f.media.stopAt(2);
  const stopped = f.media.bufferNode;
  assert.equal(stopped.stoppedAt, 2, '99407 schedules the raw audio-clock difference, not a rate-adjusted timer');
  f.advance(7, false); stopped.dispatchEvent(new Event('ended'));
  assert.equal(f.media.paused, true);
  assert.ok(f.store.timeline.has(39), 'Two real audio seconds at 2x were audible');
  assert.equal(f.store.timeline.has(45), false, 'Delayed delivery cannot earn credit beyond the scheduled stop');
  f.media.currentTime = 10; f.media.play(); f.media.stopAt(12);
  const abandoned = f.media.bufferNode;
  f.media.currentTime = 15;
  const replacement = f.media.bufferNode;
  abandoned.dispatchEvent(new Event('ended'));
  assert.equal(f.media.bufferNode, replacement);
  assert.equal(f.media.paused, false, 'The native identity guard does not pause a replacement source');
  f.advance(0.5, false); f.media.pause();
  assert.ok(f.store.timeline.has(159));
  assert.equal(f.store.timeline.has(120), false);
  assertNativeSnapshot(f);
});

test('suspended audio contexts and stale tasks cannot gain heard credit from wall time', t => {
  const f = fixture(t); f.attach(); f.media.play();
  f.advance(1, false); f.context.state = 'suspended'; f.context.dispatchEvent(new Event('statechange'));
  f.wall += 20000; f.media.emit('timeupdate');
  assert.equal(f.store.timeline.has(15), false);
  f.context.state = 'running'; f.context.dispatchEvent(new Event('statechange')); f.advance(1);
  f.current = false; f.advance(9); f.media.pause();
  assert.equal(f.store.timeline.has(30), false);
  assertNativeSnapshot(f);
});

test('speaker requirements stay independent of union timeline coverage and annotation edits rebuild only the index', t => {
  const f = fixture(t, { duration: 6.05, ids: ['a', 'b'], segments: { a: [{ start: 0, end: 2 }], b: [{ start: 2, end: 4 }] } });
  f.attach(); f.media.play(); f.advance(6.1); f.media.pause();
  assert.equal(f.store.getSnapshot().timelineGapCount, 0);
  assert.equal(f.store.getSnapshot().speakers.find(speaker => speaker.trackId === 'b').percent, 0);
  assertNativeSnapshot(f);
  const b = f.waves.get('b').media; b.currentTime = 2; b.play(); f.advance(2); b.pause();
  assert.equal(f.store.getSnapshot().percent, 100);
  assertNativeSnapshot(f);
  f.store.setSpeakerSegments({ a: [{ start: 0, end: 2 }], b: [{ start: 1, end: 4.5 }] });
  assert.ok(f.store.getSnapshot().speakers.find(speaker => speaker.trackId === 'b').gapCount > 0);
  assertNativeSnapshot(f);
});

test('incremental playback never scans old sets or required bins and snapshots stay stable without new bins', t => {
  const f = fixture(t, { duration: 300, segments: { a: [{ start: 0, end: 300 }] } }); f.attach();
  f.store.timeline[Symbol.iterator] = () => { throw new Error('timeline full scan'); };
  f.store.required.get('a')[Symbol.iterator] = () => { throw new Error('required full scan'); };
  f.media.play(); f.advance(1);
  const snapshot = f.store.getSnapshot();
  f.media.emit('timeupdate');
  assert.equal(f.store.getSnapshot(), snapshot);
  f.advance(1); f.lease.flush();
  assert.ok(f.store.timeline.has(19));
});

test('writes are bounded during playback, getter reads do not cancel notifications, and native load receives flushed task data', t => {
  const f = fixture(t); f.attach();
  let notifications = 0; f.store.subscribe(() => notifications++);
  f.media.play();
  for (let index = 0; index < 100; index++) { f.advance(0.02); f.store.getSnapshot(); f.runTimers(); }
  assert.ok(notifications > 0 && notifications <= 10);
  assert.ok(f.writes.length <= 1);
  f.advance(0.4); f.store.load('task-b');
  assert.equal(f.writes.at(-1).reviewActionId, 'task-a');
  assert.ok(f.writes.at(-1).timeline[0][1] >= 23);
  assert.equal(f.store.reviewActionId, 'task-b');
  assert.equal(f.store.timeline.size, 0);
  f.advance(5);
  assert.equal(f.store.timeline.size, 0);
});

test('teardown restores only owned native methods and releases timers and source listeners', t => {
  const f = fixture(t); const descriptor = Object.getOwnPropertyDescriptor(f.media, 'currentTime'); f.attach();
  f.media.play(); f.advance(1);
  const foreign = () => 'new owner'; f.store.recordTime = foreign;
  f.lease.dispose();
  assert.equal(f.store.recordTime, foreign);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.media, 'currentTime'), descriptor);
  assert.equal(f.timers.size, 0);
  assert.equal([...f.media.events.values()].reduce((sum, listeners) => sum + listeners.size, 0), 1);
});

test('an unownable backend fails before playback mutation and rolls back the store lease', t => {
  const f = fixture(t);
  const native = Object.getOwnPropertyDescriptor(NativeMedia.prototype, 'currentTime');
  Object.defineProperty(f.media, 'currentTime', { ...native, configurable: false });
  assert.throws(() => f.attach(), /cannot own WebAudio currentTime/);
  assert.equal(f.store.recordTime, f.originalRecord);
  assert.equal(f.store.timeline.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.media.paused, true);
});

test('Fiber discovery requires the same real store in editor state and coverage props; lifecycle flush is authoritative', t => {
  const f = fixture(t);
  const document = new EventTarget(); document.hidden = false;
  f.editor = { memoizedProps: { reviewActionId: 'task-a' }, memoizedState: { memoizedState: f.store },
    child: { memoizedProps: { coverage: f.store, onJumpToNextGap() {} } } };
  const saved = new Map(['window', 'document', 'coverageFixture'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: f.environment, document, coverageFixture: f });
  let release;
  t.after(() => {
    release?.();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  assert.equal(readNativeCoverageBinding(document).store, f.store);
  const originalProps = f.editor.child.memoizedProps;
  f.editor.child.memoizedProps = { ...originalProps, coverage: {} };
  assert.throws(() => readNativeCoverageBinding(document), /does not match/);
  f.editor.child.memoizedProps = originalProps;
  release = installNativeCoveragePerformance();
  f.media.play(); f.advance(4, false);
  document.dispatchEvent(new Event('submit'));
  assert.ok(f.store.snapshot.percent >= 13);
  assert.equal(f.writes.length, 1);
  f.advance(1, false); document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.writes.length, 2);
  release(); release = null;
  assert.equal(f.commits.size, 0);
  assert.equal(f.store.recordTime, f.originalRecord);
});
