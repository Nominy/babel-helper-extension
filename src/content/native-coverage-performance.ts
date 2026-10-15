// @ts-nocheck
import { findBabelEditorFiber, readBabelPlaybackBindings, subscribeBabelEditorCommits } from '@nominy/babel-babel-runtime';
import { NativeCoverageIndex } from './native-coverage-index';

const STORAGE_KEY = 'tx-listen-coverage';
const PUBLISH_DELAY = 200;
const SAVE_DELAY = 2000;
const storeOwners = new WeakMap();
const STORE_METHODS = ['recordTime', 'buildSnapshot', 'publish', 'save', 'load', 'getSnapshot', 'nextGapStart', 'rebuildRequired', 'trackFor', 'playableDuration', 'setTrackDuration'];

function coverageStore(value) {
  return value && STORE_METHODS.every(key => typeof value[key] === 'function') &&
    value.timeline instanceof Set && value.tracks instanceof Map && value.required instanceof Map &&
    value.trackDurations instanceof Map && value.listeners instanceof Set;
}

/** The coverage store is both editor state and a coverage prop, never an arbitrary descendant store. */
export function readNativeCoverageBinding(documentRef = document) {
  const editor = findBabelEditorFiber(documentRef);
  if (!editor) return null;
  let store = null;
  for (let hook = editor.memoizedState; hook; hook = hook.next) {
    if (!coverageStore(hook.memoizedState)) continue;
    if (store && store !== hook.memoizedState) throw new Error('Native listening store hook is ambiguous');
    store = hook.memoizedState;
  }
  let propStore = null;
  const stack = [];
  if (editor.child) stack.push(editor.child);
  while (stack.length) {
    const fiber = stack.pop(), props = fiber.memoizedProps;
    if (props?.coverage && (typeof props.onJumpToNextGap === 'function' ||
        typeof props.onJumpToUnheard === 'function' || typeof props.trackId === 'string' || typeof props.isBlocked === 'boolean')) {
      if (propStore && propStore !== props.coverage) throw new Error('Native listening coverage prop ownership is ambiguous');
      propStore = props.coverage;
    }
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  // Read-only/admin/annotation views deliberately do not expose the listening gate.
  if (!propStore) return null;
  if (!store || propStore !== store) throw new Error('Native listening coverage prop does not match the editor state hook');
  const playback = readBabelPlaybackBindings(documentRef);
  if (!playback || playback.reviewActionId !== editor.memoizedProps.reviewActionId) throw new Error('Native listening playback task ownership is unavailable');
  // Native load is a passive effect; the next native store publication commits its loaded task.
  if (store.reviewActionId !== playback.reviewActionId) return null;
  if (!Array.isArray(playback.waveTracks)) throw new Error('Native listening requires verified waveform/recording-ID bindings');
  const taskId = playback.reviewActionId;
  return { store, playback, taskId, editor, isCurrent() {
    const current = findBabelEditorFiber(documentRef);
    return store.reviewActionId === taskId && current?.memoizedProps.reviewActionId === taskId &&
      (current === editor || current?.alternate === editor) && playback.isCurrent();
  } };
}

function descriptorFor(object, key) {
  for (let owner = object; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return descriptor;
  }
  return null;
}

/** Patch one verified native instance, never the WebAudio prototype or WaveSurfer's UI callbacks. */
function bindAudioTrack(wave, trackId, owner) {
  const media = wave.getMediaElement?.();
  const context = media?.audioContext;
  if (!media || !context || !Number.isFinite(context.currentTime) || !('bufferNode' in media) ||
      !('playedDuration' in media) || !('playStartTime' in media) || !('buffer' in media) ||
      typeof wave.on !== 'function' || typeof wave.un !== 'function') {
    throw new Error(`Native listening requires the verified WebAudio backend for ${trackId}`);
  }
  const setters = ['currentTime', 'playbackRate', 'volume', 'muted', 'src'];
  const descriptors = new Map();
  for (const key of setters) {
    const descriptor = descriptorFor(media, key);
    if (!descriptor?.get || !descriptor?.set || Object.getOwnPropertyDescriptor(media, key)?.configurable === false) {
      throw new Error(`Native listening cannot own WebAudio ${key} for ${trackId}`);
    }
    descriptors.set(key, descriptor);
  }
  for (const key of ['_play', '_pause', 'stopAt']) {
    if (typeof media[key] !== 'function') throw new Error(`Native listening requires WebAudio ${key} for ${trackId}`);
  }
  if (typeof context.addEventListener !== 'function' || typeof context.removeEventListener !== 'function') {
    throw new Error(`Native listening AudioContext state events are unavailable for ${trackId}`);
  }
  let active = true, depth = 0, loading = !media.buffer, stoppedAt = Infinity, baseline = null;
  let spare = {}, positionNode = null, positionClock = 0, positionTime = 0, positionRate = 1;
  const cleanups = [];
  const valid = () => active && owner.isCurrent() && wave.getMediaElement() === media;
  function readEndpoint(target) {
    const clock = context.currentTime, rate = media.playbackRate, node = media.bufferNode;
    if (node && node !== positionNode) {
      positionNode = node;
      positionClock = clock;
      positionTime = media.currentTime;
      positionRate = rate;
    } else if (rate !== positionRate) {
      // WebAudio's native rate setter changes its reported time base, not the
      // buffer's audible offset. Close the old-rate span before changing slope.
      positionTime += (clock - positionClock) * positionRate;
      positionClock = clock;
      positionRate = rate;
    }
    target.clock = clock;
    target.time = media.paused ? media.currentTime : positionTime + (clock - positionClock) * positionRate;
    target.rate = rate;
    target.node = node;
    target.buffer = media.buffer;
    target.src = media.currentSrc;
    target.audible = !loading && !media.paused && !media.muted && media.volume > 0 &&
      context.state === 'running' && Boolean(node && media.buffer && node.buffer === media.buffer);
    return target;
  }
  function reset() { baseline = valid() ? readEndpoint(baseline || {}) : null; }
  function sample(boundary = false) {
    if (depth || !valid()) { if (!depth) baseline = null; return; }
    const next = readEndpoint(spare), previous = baseline;
    baseline = next;
    spare = previous || {};
    const track = owner.store.trackFor(trackId);
    track.lastTime = next.time;
    track.lastWallTime = owner.now();
    // stopAt's native ended listener clears bufferNode before calling pause.
    const scheduledEnd = boundary && previous?.node && next.node === null && next.clock >= stoppedAt;
    if (!previous?.audible || (!next.audible && !boundary) || (previous.node !== next.node && !scheduledEnd) ||
        previous.buffer !== next.buffer || previous.src !== next.src || previous.rate !== next.rate ||
        !Number.isFinite(next.time) || !Number.isFinite(next.rate) || next.rate <= 0) return;
    const elapsed = next.clock - previous.clock;
    const expected = elapsed * previous.rate;
    // AudioContext time, not rAF/wall time, proves that the source actually advanced.
    if (elapsed <= 0 || Math.abs(next.time - previous.time - expected) > 0.05) return;
    const audibleClock = Math.min(next.clock, stoppedAt);
    const duration = wave.getDuration();
    const end = Math.min(duration, previous.time + Math.max(0, audibleClock - previous.clock) * previous.rate);
    if (!(duration > 0) || previous.time < 0 || end <= previous.time) return;
    if (owner.store.trackDurations.get(trackId) !== duration) {
      owner.store.setTrackDuration(trackId, duration);
      if (!valid() || media.buffer !== next.buffer || media.currentSrc !== next.src) return;
    }
    if (owner.index.credit(trackId, previous.time, end, duration)) owner.changed();
  }
  function boundary(action, sourceChange = false, restart = false) {
    if (!valid()) return action();
    if (!depth) sample(true);
    depth++;
    try { return action(); }
    finally {
      depth--;
      if (sourceChange) { loading = true; owner.flush(false); }
      if (restart) stoppedAt = Infinity;
      if (!depth) reset();
    }
  }
  function ownMethod(key, make) {
    const descriptor = Object.getOwnPropertyDescriptor(media, key), original = media[key];
    const wrapped = make(original);
    Object.defineProperty(media, key, { configurable: true, writable: true, value: wrapped });
    cleanups.push(() => {
      if (media[key] !== wrapped) return;
      if (descriptor) Object.defineProperty(media, key, descriptor);
      else delete media[key];
    });
  }
  const release = () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups.reverse()) cleanup();
    baseline = null;
  };
  try {
    for (const key of setters) {
      const original = descriptors.get(key), own = Object.getOwnPropertyDescriptor(media, key);
      const set = function(value) {
        return boundary(() => original.set.call(this, value), key === 'src', key === 'currentTime');
      };
      Object.defineProperty(media, key, { configurable: true, enumerable: original.enumerable, get: original.get, set });
      cleanups.push(() => {
        if (Object.getOwnPropertyDescriptor(media, key)?.set !== set) return;
        if (own) Object.defineProperty(media, key, own);
        else delete media[key];
      });
    }
    ownMethod('_play', original => function(...args) {
      const restarting = this.paused;
      return boundary(() => original.apply(this, args), false, restarting);
    });
    ownMethod('_pause', original => function(...args) { return boundary(() => original.apply(this, args)); });
    ownMethod('stopAt', original => function(time, ...args) {
      sample();
      const stopClock = context.currentTime + time - media.currentTime;
      const result = original.call(this, time, ...args);
      stoppedAt = stopClock;
      return result;
    });
    function on(name, callback) {
      const guarded = (...args) => { if (valid()) callback(...args); };
      cleanups.push(() => wave.un(name, guarded));
      if (typeof wave.on(name, guarded) !== 'function') throw new Error(`Native listening ${name} subscription is not owned`);
    }
    on('load', () => { sample(true); loading = true; reset(); owner.flush(false); });
    on('ready', () => { loading = false; reset(); });
    on('destroy', () => { sample(true); owner.flush(false); release(); });
    on('seeking', reset);
    on('play', reset);
    on('pause', () => { if (!depth) { sample(true); reset(); owner.flush(false); } });
    on('finish', () => { sample(true); reset(); owner.flush(false); });
    const onContextState = () => { if (valid()) { sample(true); reset(); } };
    context.addEventListener('statechange', onContextState);
    cleanups.push(() => context.removeEventListener('statechange', onContextState));
    reset();
    return { trackId, wave, sample, reset, release };
  } catch (error) { release(); throw error; }
}

/** Kept separate from discovery so regressions exercise the actual patched store/backend boundary. */
export function attachNativeCoverage(binding, environment = window) {
  const { store, taskId } = binding;
  if (!coverageStore(store) || store.reviewActionId !== taskId) throw new Error('Native listening store/task contract is unavailable');
  if (storeOwners.has(store)) throw new Error('Native listening store is already owned');
  let active = true, publishTimer = null, saveTimer = null, persistenceDirty = false, published = store.snapshot;
  let recordTimePatch = null;
  const patches = [], tracks = new Map();
  const index = new NativeCoverageIndex(store);
  const owner = { store, index, now: () => environment.performance.now(),
    isCurrent: () => active && store.recordTime === recordTimePatch && binding.isCurrent(), changed, flush };
  storeOwners.set(store, owner);
  const originalGetSnapshot = store.getSnapshot;
  function cancelPublish() { if (publishTimer !== null) environment.clearTimeout(publishTimer); publishTimer = null; }
  function cancelSave() { if (saveTimer !== null) environment.clearTimeout(saveTimer); saveTimer = null; }
  function publishNow(notify = true) {
    if (notify) cancelPublish();
    store.snapshot = index.snapshot();
    if (notify && store.snapshot !== published) {
      published = store.snapshot;
      for (const listener of store.listeners) listener();
    }
    return store.snapshot;
  }
  function persistNow() {
    cancelSave();
    if (!persistenceDirty || store.reviewActionId !== taskId) return;
    // Retain native persistence format/key so native load and teardown need no migration or alternate authority.
    try {
      environment.localStorage.setItem(STORAGE_KEY, JSON.stringify(index.persisted(taskId)));
      persistenceDirty = false;
    } catch (error) {
      // Storage failure must be visible, but cannot interrupt native pause/seek.
      console.error('[Babel Helper] Native listening persistence failed:', error);
    }
  }
  function changed() {
    persistenceDirty = true;
    if (publishTimer === null) publishTimer = environment.setTimeout(() => {
      publishTimer = null;
      if (owner.isCurrent()) publishNow();
    }, PUBLISH_DELAY);
    if (saveTimer === null) saveTimer = environment.setTimeout(() => {
      saveTimer = null;
      if (active) persistNow();
    }, SAVE_DELAY);
  }
  function flush(sample = true, persist = true) {
    if (!active) return;
    if (sample && owner.isCurrent()) for (const track of tracks.values()) track.sample();
    publishNow();
    if (persist) persistNow();
  }
  function patch(key, value) {
    const descriptor = Object.getOwnPropertyDescriptor(store, key);
    Object.defineProperty(store, key, { configurable: true, writable: true, value });
    patches.push(() => {
      if (store[key] !== value) return;
      if (descriptor) Object.defineProperty(store, key, descriptor);
      else delete store[key];
    });
  }
  function dispose() {
    if (!active) return;
    try { flush(); }
    finally {
      active = false;
      cancelPublish(); cancelSave();
      for (const track of tracks.values()) track.release();
      for (const restore of patches.reverse()) restore();
      if (storeOwners.get(store) === owner) storeOwners.delete(store);
    }
  }
  try {
    patch('buildSnapshot', () => index.snapshot());
    patch('publish', () => publishNow());
    patch('getSnapshot', () => {
      // No audio sampling during React's snapshot consistency checks: reads must stay referentially stable.
      if (active) publishNow(false);
      return originalGetSnapshot();
    });
    patch('save', changed);
    const originalLoad = store.load;
    patch('load', function(...args) {
      flush();
      for (const track of tracks.values()) track.reset();
      const result = originalLoad.apply(this, args);
      index.ensure();
      return result;
    });
    const originalNextGap = store.nextGapStart;
    patch('nextGapStart', function(...args) { flush(true, false); return originalNextGap.apply(this, args); });
    recordTimePatch = function(trackId, time, duration, audible) {
      if (!owner.isCurrent() || !Number.isFinite(time) || !(duration > 0)) return;
      const track = tracks.get(trackId);
      if (!track) return; // A callback from a replaced native source cannot authorize this source.
      track.sample();
    };
    patch('recordTime', recordTimePatch);
    for (const { wave, trackId } of binding.playback.waveTracks) {
      if (typeof trackId !== 'string' || !trackId || tracks.has(trackId)) throw new Error('Native listening recording identity is ambiguous');
      tracks.set(trackId, bindAudioTrack(wave, trackId, owner));
    }
    publishNow();
    return { dispose, flush, store, binding };
  } catch (error) { dispose(); throw error; }
}

/** Install once on a mounted editor. Root commits are the only rediscovery signal. */
export function installNativeCoveragePerformance() {
  const documentRef = document, windowRef = window;
  let disposed = false, current = null, releaseCommit = null;
  function reconcile() {
    if (disposed) return;
    if (current?.binding.isCurrent()) return;
    current?.dispose(); current = null;
    const binding = readNativeCoverageBinding(documentRef);
    if (binding) current = attachNativeCoverage(binding, windowRef);
  }
  function flush() { current?.flush(); }
  function snapshotBeforeAction() { current?.flush(true, false); }
  function hidden() { if (documentRef.hidden) flush(); }
  function dispose() {
    if (disposed) return;
    disposed = true;
    releaseCommit?.();
    releaseCommit = null;
    documentRef.removeEventListener('visibilitychange', hidden);
    documentRef.removeEventListener('click', snapshotBeforeAction, true);
    documentRef.removeEventListener('submit', flush, true);
    documentRef.removeEventListener('keydown', onKey, true);
    windowRef.removeEventListener('pagehide', flush);
    current?.dispose(); current = null;
  }
  function onKey(event) { if (event.key === 'Enter') snapshotBeforeAction(); }
  function onCommit() {
    try { reconcile(); }
    catch (error) { dispose(); console.error('[Babel Helper] Native listening coverage stopped:', error); }
  }
  try {
    releaseCommit = subscribeBabelEditorCommits(onCommit, documentRef);
    reconcile();
    documentRef.addEventListener('visibilitychange', hidden);
    documentRef.addEventListener('click', snapshotBeforeAction, true);
    documentRef.addEventListener('submit', flush, true);
    documentRef.addEventListener('keydown', onKey, true);
    windowRef.addEventListener('pagehide', flush);
    return dispose;
  } catch (error) { dispose(); throw error; }
}
