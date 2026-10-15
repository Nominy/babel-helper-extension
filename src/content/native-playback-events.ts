// @ts-nocheck
import { AUDIO_ENHANCEMENT_STATE_EVENT, readAudioEnhancementState, readBabelPlaybackBindings, subscribeBabelEditorCommits } from '@nominy/babel-babel-runtime';
import { acquireNativeZoomReadiness } from './native-waveform-readiness';

export function readNativePlaybackState(bindings) {
  const waves = bindings?.waves || [];
  if (!waves.length) return { ok: false, reason: 'playback-unavailable', paused: null, waveCount: 0, reviewActionId: bindings?.reviewActionId || '' };
  const currentTime = waves[0].getCurrentTime();
  const duration = waves[0].getDuration();
  const playbackRate = waves[0].getPlaybackRate();
  return {
    ok: Number.isFinite(currentTime), source: 'wavesurfer', currentTime,
    duration: Number.isFinite(duration) ? duration : null,
    playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : null,
    paused: !waves.some(wave => wave.isPlaying()), waveCount: waves.length,
    reviewActionId: bindings.reviewActionId, recordingTracks: bindings.recordingTracks
  };
}

export function samePlaybackBindings(left, right) {
  return left?.reviewActionId === right?.reviewActionId && left?.waves.length === right?.waves.length &&
    Boolean(left?.waves.every((wave, index) => wave === right.waves[index]));
}

/** Own only real WaveSurfer subscriptions and a shared current-FiberRoot lease. */
export function subscribeNativePlayback(listener, onBindingsChanged = () => {}, { includeHidden = false } = {}) {
  const documentRef = document;
  const windowRef = window;
  let disposed = false;
  let queued = false;
  let queuedClockOnly = false;
  let queuedReason = 'initial';
  let lastSampleAt = -Infinity;
  let bindings = null;
  let revision = 0;
  let releaseCommit = null;
  const leases = new Map();
  const destroyed = new WeakSet();
  const loading = new Set();

  function releaseWaves() {
    for (const release of leases.values()) release();
    leases.clear();
    loading.clear();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    windowRef.removeEventListener(AUDIO_ENHANCEMENT_STATE_EVENT, onExternalSignal);
    documentRef.removeEventListener('visibilitychange', onExternalSignal);
    releaseWaves();
    releaseCommit?.();
    releaseCommit = null;
  }
  function fail(error) {
    if (disposed) return;
    const task = bindings?.reviewActionId || '';
    dispose();
    listener({ ok: false, fatal: true, reason: 'native-playback-subscription-failed', message: String(error), paused: null, reviewActionId: task, sourceRevision: revision });
  }
  function queueSample(reason = 'initial', clockOnly = false) {
    if (disposed) return;
    if (clockOnly && windowRef.performance.now() - lastSampleAt < 66) return;
    if (!clockOnly || !queued) queuedReason = reason;
    queuedClockOnly = queued ? queuedClockOnly && clockOnly : clockOnly;
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      if (document !== documentRef || window !== windowRef) { dispose(); return; }
      if (documentRef.hidden && !includeHidden) return;
      try {
        const now = windowRef.performance.now();
        if (queuedClockOnly && now - lastSampleAt < 66) return;
        // This predicate resolves the current committed task and native refs;
        // it does not traverse transcript rows or transport descendants.
        if (bindings && !bindings.isCurrent()) return;
        const source = readAudioEnhancementState(documentRef);
        const pending = loading.size > 0 || bindings?.waves.some(wave => destroyed.has(wave)) ||
          (source?.taskId === bindings?.reviewActionId && source?.status === 'switching');
        const state = pending ? { ok: false, reason: 'playback-loading', paused: null, reviewActionId: bindings.reviewActionId } : readNativePlaybackState(bindings);
        if (!pending && bindings?.waves.length && !state.ok) throw new Error('Native playback clock is unavailable');
        lastSampleAt = now;
        listener({ ...state, recordingTracks: bindings?.recordingTracks || [],
          sourceRevision: revision, event: queuedReason });
      } catch (error) { fail(error); }
    });
  }
  function onExternalSignal(event) {
    queueSample(event.type);
  }
  function onCommit() {
    if (disposed) return;
    if (document !== documentRef || window !== windowRef) { dispose(); return; }
    try {
      if (bindings?.isCurrent()) return;
      if (reconcile()) queueSample('bindings');
    } catch (error) { fail(error); }
  }
  function bindWave(wave) {
    if (typeof wave.on !== 'function' || typeof wave.un !== 'function') throw new Error('WaveSurfer .on/.un subscription API is unavailable');
    const cleanups = [];
    let active = true;
    const release = () => {
      active = false;
      for (const cleanup of cleanups.splice(0)) cleanup();
    };
    const on = (name, callback) => {
      const guarded = (...args) => { if (active && !disposed) callback(...args); };
      // Register cleanup first: even a broken .on that attaches then throws is owned.
      cleanups.push(() => wave.un(name, guarded));
      const cleanup = wave.on(name, guarded);
      if (typeof cleanup !== 'function') throw new Error(`WaveSurfer ${name} did not return an unsubscribe function`);
    };
    try {
      const releaseZoom = acquireNativeZoomReadiness(wave);
      if (releaseZoom) cleanups.push(releaseZoom);
      for (const name of ['play', 'pause', 'seeking', 'finish']) on(name, () => queueSample(name));
      on('timeupdate', () => queueSample('timeupdate', true));
      on('load', () => { revision++; loading.add(wave); queueSample('load'); });
      on('loading', () => { loading.add(wave); queueSample('loading'); });
      on('ready', () => { loading.delete(wave); queueSample('ready'); });
      on('destroy', () => {
        revision++;
        destroyed.add(wave);
        loading.delete(wave);
        release();
        leases.delete(wave);
        queueSample('destroy');
      });
      on('error', error => fail(error));
      // The native WaveSurfer does not forward media ratechange. WebAudio's
      // silent rate setter is already corrected by installNativeSpeedFix,
      // whose same-time seek emits real seeking/timeupdate notifications.
      const media = wave.getMediaElement?.();
      if (typeof media?.addEventListener !== 'function' || typeof media.removeEventListener !== 'function') {
        throw new Error('WaveSurfer media ratechange subscription is unavailable');
      }
      const onRate = () => { if (active && !disposed) queueSample('ratechange'); };
      cleanups.push(() => media.removeEventListener('ratechange', onRate));
      media.addEventListener('ratechange', onRate);
      return release;
    } catch (error) { release(); throw error; }
  }
  function reconcile() {
    const current = readBabelPlaybackBindings(documentRef);
    const membershipChanged = !samePlaybackBindings(bindings, current);
    if (!membershipChanged && bindings?.recordingTracks === current?.recordingTracks) return false;
    if (membershipChanged) releaseWaves();
    bindings = current;
    revision++;
    if (membershipChanged) {
      onBindingsChanged();
      for (const wave of bindings?.waves || []) {
        if (!destroyed.has(wave)) leases.set(wave, bindWave(wave));
      }
    }
    return true;
  }
  try {
    windowRef.addEventListener(AUDIO_ENHANCEMENT_STATE_EVENT, onExternalSignal);
    documentRef.addEventListener('visibilitychange', onExternalSignal);
    releaseCommit = subscribeBabelEditorCommits(onCommit, documentRef);
    reconcile();
    queueSample();
  } catch (error) { dispose(); throw error; }
  return dispose;
}
