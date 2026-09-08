// @ts-nocheck

export function createPlaybackSiteApi(helper: any) {
  const PLAYBACK_BRIDGE_REQUEST_EVENT = 'babel-helper-playback-request';

  const PLAYBACK_BRIDGE_RESPONSE_EVENT = 'babel-helper-playback-response';

  const PLAYBACK_BRIDGE_SCRIPT_PATH = 'dist/content/playback-bridge.js';

  const PLAYBACK_BRIDGE_TIMEOUT_MS = 500;

  const PLAYBACK_SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2];


  let playbackBridgeInjected = false;

  let playbackBridgeLoadPromise = null;

  let playbackBridgeRequestId = 0;


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
    const ready = await injectPlaybackBridge();
    if (!ready) {
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
        resolve(result || null);
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
            payload: payload || {}
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


  helper.setPlaybackPaused = function setPlaybackPaused(paused) {
    return callPlaybackBridge('set-paused', { paused: Boolean(paused) })
      .then(result => result || unavailablePlaybackState());
  };


  helper.adjustPlaybackSpeed = function adjustPlaybackSpeed(direction) {
    return callPlaybackBridge('adjust-speed', {
      direction: Number(direction) > 0 ? 1 : -1,
      steps: PLAYBACK_SPEED_STEPS
    }).then(result => result || unavailablePlaybackState());
  };


  helper.getPlaybackState = function getPlaybackState() {
    return callPlaybackBridge('state').then(result => result || unavailablePlaybackState());
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
