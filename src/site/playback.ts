// @ts-nocheck
import { showNativeAutomationFailure } from '../ui/native-automation-failure';
import { readNativeSessionState } from './editor-control';

export function createPlaybackSiteApi(helper: any) {
  const PLAYBACK_BRIDGE_REQUEST_EVENT = 'babel-helper-playback-request';

  const PLAYBACK_BRIDGE_RESPONSE_EVENT = 'babel-helper-playback-response';

  const PLAYBACK_BRIDGE_SCRIPT_PATH = 'dist/content/playback-bridge.js';

  const PLAYBACK_BRIDGE_TIMEOUT_MS = 750;

  const PLAYBACK_SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2];


  let playbackBridgeInjected = false;

  let playbackBridgeLoadPromise = null;

  let playbackBridgeRequestId = 0;
  let pendingStateRead = null;


  function injectPlaybackBridge() {
    if (window.__babelHelperPlaybackBridge) {
      playbackBridgeInjected = true;
      return Promise.resolve(true);
    }

    if (playbackBridgeInjected) {
      return Promise.resolve(true);
    }

    if (playbackBridgeLoadPromise) {
      return playbackBridgeLoadPromise;
    }

    playbackBridgeLoadPromise = new Promise((resolve) => {
      const parent = document.documentElement || document.head || document.body;
      if (
        !parent ||
        typeof chrome === 'undefined' ||
        !chrome.runtime ||
        typeof chrome.runtime.getURL !== 'function'
      ) {
        playbackBridgeLoadPromise = null;
        resolve(false);
        return;
      }

      const script = document.createElement('script');
      try {
        script.src = chrome.runtime.getURL(PLAYBACK_BRIDGE_SCRIPT_PATH);
      } catch (_error) {
        script.remove();
        playbackBridgeLoadPromise = null;
        resolve(false);
        return;
      }
      script.async = false;
      script.onload = () => {
        script.remove();
        playbackBridgeInjected = true;
        resolve(true);
      };
      script.onerror = () => {
        script.remove();
        playbackBridgeLoadPromise = null;
        resolve(false);
      };

      parent.appendChild(script);
    });

    return playbackBridgeLoadPromise;
  }


  async function callPlaybackBridge(operation, payload) {
    // Commands invalidate concurrent reads; command clocks are never cached.
    if (operation !== 'state') pendingStateRead = null;
    const href = window.location.href;
    const reviewActionId = readNativeSessionState()?.reviewActionId;
    if (!reviewActionId) return null;
    const lifecycleRevision = helper.state?.sessionLifecycleRevision;
    const ready = await injectPlaybackBridge();
    if (!ready || window.location.href !== href ||
        reviewActionId !== readNativeSessionState()?.reviewActionId ||
        lifecycleRevision !== helper.state?.sessionLifecycleRevision) {
      return null;
    }

    return new Promise((resolve) => {
      playbackBridgeRequestId += 1;
      const id = 'playback-request-' + playbackBridgeRequestId;
      let settled = false;

      const finish = (result) => {
        if (settled) {
          return;
        }

        settled = true;
        window.removeEventListener(PLAYBACK_BRIDGE_RESPONSE_EVENT, handleResponse, true);
        window.clearTimeout(timeoutId);
        if (operation !== 'state') pendingStateRead = null;
        const current = window.location.href === href &&
          reviewActionId === readNativeSessionState()?.reviewActionId &&
          lifecycleRevision === helper.state?.sessionLifecycleRevision;
        resolve(current ? result || null : null);
      };

      const handleResponse = (event) => {
        const detail = event.detail || {};
        if (detail.id !== id) {
          return;
        }

        finish(detail.result || null);
      };

      const timeoutId = window.setTimeout(() => finish(null), PLAYBACK_BRIDGE_TIMEOUT_MS);
      window.addEventListener(PLAYBACK_BRIDGE_RESPONSE_EVENT, handleResponse, true);
      window.dispatchEvent(
        new CustomEvent(PLAYBACK_BRIDGE_REQUEST_EVENT, {
          detail: {
            id,
            operation,
            payload: { ...(payload || {}), reviewActionId }
          }
        })
      );
    });
  }


  // Prefer native playback controls. Custom seeks use page-world Wavesurfer instances
  // held in React hook state; the isolated world cannot read those fibers.
  // The visible <audio> can be a dummy, so bridge failure must remain failure.
  function unavailablePlaybackState() {
    return { ok: false, reason: 'playback-unavailable', paused: null, waveCount: 0 };
  }

  helper.reportPlaybackFailure = function reportPlaybackFailure(result) {
    helper.analytics?.record?.('playback:subscription-failed', { reason: result?.reason, message: result?.message });
    showNativeAutomationFailure('Playback', result?.message || result?.reason || 'Native playback failed');
  };

  helper.subscribePlayback = function subscribePlayback(listener) {
    if (typeof listener !== 'function') throw new TypeError('Playback listener must be a function');
    const subscriptionId = 'playback-subscription-' + (++playbackBridgeRequestId);
    const href = window.location.href;
    const lifecycleRevision = helper.state?.sessionLifecycleRevision;
    const admission = helper.state?.nativeSessionAdmission;
    const session = readNativeSessionState();
    if (!admission || admission.href !== href || admission.lifecycleRevision !== lifecycleRevision ||
        admission.reviewActionId !== session?.reviewActionId || session.readOnly !== false) {
      throw new Error('Native playback subscription requires a current interactive session admission');
    }
    const reviewActionId = admission.reviewActionId;
    let disposed = false;
    let sourceRevision = -1;
    const current = () => {
      if (disposed || window.location.href !== href ||
          admission !== helper.state?.nativeSessionAdmission ||
          lifecycleRevision !== helper.state?.sessionLifecycleRevision) return false;
      const live = readNativeSessionState();
      return live?.reviewActionId === reviewActionId && live.readOnly === false;
    };
    const unsubscribeNative = () => window.dispatchEvent(new CustomEvent(PLAYBACK_BRIDGE_REQUEST_EVENT, {
      detail: { id: 'playback-release-' + (++playbackBridgeRequestId), operation: 'unsubscribe', payload: { subscriptionId } }
    }));
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('babel-helper-playback-sample', receive, true);
      window.removeEventListener('babel-helper-bridge-teardown', dispose, true);
      unsubscribeNative();
    };
    const fail = result => {
      if (!current()) { dispose(); return; }
      const failure = { ...result, ok: false, fatal: true, paused: null };
      dispose();
      helper.reportPlaybackFailure(failure);
      listener(failure);
    };
    const receive = event => {
      const detail = event.detail;
      if (detail?.subscriptionId !== subscriptionId) return;
      if (!current()) { dispose(); return; }
      if (detail.href !== href || detail.lifecycleRevision !== lifecycleRevision) return;
      const sample = detail.sample;
      if (sample?.reviewActionId !== reviewActionId || !Number.isFinite(sample?.sourceRevision) ||
          sample.sourceRevision < sourceRevision) return;
      sourceRevision = sample.sourceRevision;
      if (sample.fatal) { fail(sample); return; }
      if (sample.ok && (!Array.isArray(sample.recordingTracks) || !sample.recordingTracks.length ||
          sample.recordingTracks.some(track => typeof track?.id !== 'string' || !track.id ||
            typeof track.label !== 'string'))) {
        fail({ reason: 'native-playback-recording-metadata-unavailable' });
        return;
      }
      if (document.hidden) return;
      listener(sample);
    };
    window.addEventListener('babel-helper-playback-sample', receive, true);
    window.addEventListener('babel-helper-bridge-teardown', dispose, true);
    void callPlaybackBridge('subscribe', { subscriptionId, href, lifecycleRevision }).then(result => {
      if (disposed) { unsubscribeNative(); return; }
      if (!current()) { dispose(); return; }
      if (!result?.ok) fail(result || { reason: 'native-playback-subscription-unavailable' });
    }, error => fail({ reason: 'native-playback-subscription-failed', message: String(error) }));
    return dispose;
  };

  helper.setPlaybackPaused = function setPlaybackPaused(paused) {
    return callPlaybackBridge('set-paused', { paused: Boolean(paused) }).then(result => {
      const state = result || unavailablePlaybackState();
      if (!state.ok) helper.reportPlaybackFailure(state);
      return state;
    });
  };


  helper.adjustPlaybackSpeed = function adjustPlaybackSpeed(direction) {
    return callPlaybackBridge('adjust-speed', {
      direction: Number(direction) > 0 ? 1 : -1,
      steps: PLAYBACK_SPEED_STEPS
    }).then(result => result || unavailablePlaybackState());
  };


  helper.getPlaybackState = function getPlaybackState() {
    const href = window.location.href;
    const reviewActionId = readNativeSessionState()?.reviewActionId;
    const revision = helper.state?.sessionLifecycleRevision;
    if (pendingStateRead?.href === href && pendingStateRead.reviewActionId === reviewActionId &&
        pendingStateRead.revision === revision) return pendingStateRead.promise;
    // Share only concurrent reads, not cached clocks. The next sample after
    // settlement must observe native pause, seek and playback-rate changes.
    const flight = { href, reviewActionId, revision, promise: null };
    flight.promise = callPlaybackBridge('state')
      .then(result => result || unavailablePlaybackState())
      .finally(() => {
        if (pendingStateRead === flight) pendingStateRead = null;
      });
    pendingStateRead = flight;
    return flight.promise;
  };


  helper.seekPlaybackBySeconds = function seekPlaybackBySeconds(deltaSeconds) {
    const delta = Number(deltaSeconds);
    if (!Number.isFinite(delta) || delta === 0) {
      return false;
    }

    if (helper.analytics) {
      helper.analytics.record('playback:seek', { deltaSeconds: delta });
    }

    return callPlaybackBridge('seek', { deltaSeconds: delta }).then(result => Boolean(result?.ok));
  };

  return { unavailablePlaybackState, callPlaybackBridge };
}
