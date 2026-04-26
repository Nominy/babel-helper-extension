// @ts-nocheck
export function initPlaybackBridge() {
  if (window.__babelHelperPlaybackBridge) {
    return;
  }

  const REQUEST_EVENT = 'babel-helper-playback-request';
  const RESPONSE_EVENT = 'babel-helper-playback-response';
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';

  function safe(callback, fallbackValue) {
    try {
      const value = callback();
      return value == null ? fallbackValue : value;
    } catch (_error) {
      return fallbackValue;
    }
  }

  function respond(id, result) {
    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          id,
          result
        }
      })
    );
  }

  function getReactInternalValue(element, prefix) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    for (const name of Object.getOwnPropertyNames(element)) {
      if (typeof name === 'string' && name.indexOf(prefix) === 0) {
        return element[name];
      }
    }

    return null;
  }

  function getReactFiber(element) {
    return getReactInternalValue(element, '__reactFiber$');
  }

  function getWaveRegistryFromValue(value) {
    const registry =
      value && typeof value === 'object' && !Array.isArray(value) && value.current
        ? value.current
        : value;
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      return null;
    }

    const keys = Object.keys(registry);
    const hasWaveEntry = keys.some((key) => {
      const entry = registry[key];
      return entry && typeof entry === 'object' && entry.wavesurfer;
    });
    return hasWaveEntry ? registry : null;
  }

  function getWaveRegistryFromFiber(fiber) {
    let owner = fiber;
    let ownerDepth = 0;
    while (owner && typeof owner === 'object' && ownerDepth < 16) {
      let hook = owner.memoizedState;
      let hookIndex = 0;
      while (hook && typeof hook === 'object' && hookIndex < 24) {
        const registry = getWaveRegistryFromValue(hook.memoizedState);
        if (registry) {
          return registry;
        }

        hook = hook.next;
        hookIndex += 1;
      }

      owner = owner.return;
      ownerDepth += 1;
    }

    return null;
  }

  function getWaveRegistryFromPlaybackControls() {
    const controls = document.querySelectorAll(
      'button[aria-label="Jump back 5 seconds"], button[aria-label="Play all tracks"], button[aria-label="Pause all tracks"], button[aria-label="Jump forward 5 seconds"]'
    );
    for (const control of controls) {
      const registry = getWaveRegistryFromFiber(getReactFiber(control));
      if (registry) {
        return registry;
      }
    }

    return null;
  }

  function getWaveformHosts() {
    return Array.from(document.querySelectorAll('div')).filter((node) => {
      if (!(node instanceof HTMLDivElement) || !(node.shadowRoot instanceof ShadowRoot)) {
        return false;
      }

      return Boolean(node.shadowRoot.querySelector('[part="scroll"], [part="wrapper"]'));
    });
  }

  function getWaveformRegistryFromHost(host) {
    let fiber = getReactFiber(host);
    if (!fiber && host instanceof HTMLElement) {
      fiber = getReactFiber(host.parentElement);
    }
    return getWaveRegistryFromFiber(fiber);
  }

  function getPlaybackWaveInstances() {
    const unique = [];
    const seen = new Set();
    const registries = [];
    const playbackRegistry = getWaveRegistryFromPlaybackControls();
    if (playbackRegistry) {
      registries.push(playbackRegistry);
    }

    for (const host of getWaveformHosts()) {
      const registry = getWaveformRegistryFromHost(host);
      if (!registry || typeof registry !== 'object') {
        continue;
      }
      registries.push(registry);
    }

    for (const registry of registries) {
      for (const key of Object.keys(registry)) {
        const entry = registry[key];
        const wave =
          entry && typeof entry === 'object' && entry.wavesurfer ? entry.wavesurfer : null;
        if (
          !wave ||
          typeof wave !== 'object' ||
          seen.has(wave) ||
          typeof wave.getCurrentTime !== 'function' ||
          typeof wave.setTime !== 'function'
        ) {
          continue;
        }

        seen.add(wave);
        unique.push(wave);
      }
    }

    return unique;
  }

  function getPlaybackIndicator() {
    const host = getWaveformHosts()[0];
    if (!(host instanceof HTMLElement) || !(host.shadowRoot instanceof ShadowRoot)) {
      return null;
    }

    const cursor = host.shadowRoot.querySelector('[part="cursor"]');
    const progress = host.shadowRoot.querySelector('[part="progress"]');
    const scroll = host.shadowRoot.querySelector('[part="scroll"]');
    return {
      cursorStyle: cursor ? cursor.getAttribute('style') : null,
      progressStyle: progress ? progress.getAttribute('style') : null,
      scrollLeft: scroll instanceof HTMLElement ? scroll.scrollLeft : null
    };
  }

  function getWavePausedState(wave) {
    if (!wave || typeof wave !== 'object') {
      return null;
    }

    if (typeof wave.isPlaying === 'function') {
      return !Boolean(safe(() => wave.isPlaying(), false));
    }

    if (wave.media && 'paused' in wave.media) {
      return Boolean(wave.media.paused);
    }

    return null;
  }

  function clickControl(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    try {
      element.click();
      return true;
    } catch (_error) {
      return false;
    }
  }

  function getPlaybackControl(paused) {
    const selector = paused
      ? 'button[aria-label="Pause all tracks"]'
      : 'button[aria-label="Play all tracks"]';
    const button = document.querySelector(selector);
    return button instanceof HTMLElement ? button : null;
  }

  function seekWithWaveInstances(deltaSeconds) {
    const waves = getPlaybackWaveInstances();
    if (!waves.length) {
      return null;
    }

    const currentTime = Number(safe(() => waves[0].getCurrentTime(), NaN));
    if (!Number.isFinite(currentTime)) {
      return { ok: false, reason: 'wave-current-time-invalid' };
    }

    const duration = Number(
      typeof waves[0].getDuration === 'function' ? safe(() => waves[0].getDuration(), NaN) : NaN
    );
    const maxTime =
      Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
    const nextTime = Math.max(0, Math.min(maxTime, currentTime + deltaSeconds));
    if (!Number.isFinite(nextTime)) {
      return { ok: false, reason: 'wave-next-time-invalid' };
    }

    let applied = 0;
    for (const wave of waves) {
      try {
        wave.setTime(nextTime);
        applied += 1;
      } catch (_error) {
        // Ignore one-off instance failures; sibling waveforms can still stay in sync.
      }
    }

    if (!applied) {
      return { ok: false, reason: 'wave-set-failed' };
    }

    return {
      ok: true,
      source: 'wavesurfer',
      currentTime: nextTime,
      indicator: getPlaybackIndicator(),
      waveCount: applied
    };
  }

  function seekWithMediaElement(deltaSeconds) {
    const audio = document.querySelector('audio');
    if (!(audio instanceof HTMLMediaElement)) {
      return { ok: false, reason: 'playback-unavailable' };
    }

    const currentTime = Number(audio.currentTime);
    if (!Number.isFinite(currentTime)) {
      return { ok: false, reason: 'audio-current-time-invalid' };
    }

    const duration = Number(audio.duration);
    const maxTime =
      Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY;
    const nextTime = Math.max(0, Math.min(maxTime, currentTime + deltaSeconds));
    if (!Number.isFinite(nextTime)) {
      return { ok: false, reason: 'audio-next-time-invalid' };
    }

    audio.currentTime = nextTime;
    return {
      ok: true,
      source: 'audio',
      currentTime: nextTime,
      indicator: getPlaybackIndicator(),
      waveCount: 0
    };
  }

  function seekPlaybackBySeconds(deltaSeconds) {
    const delta = Number(deltaSeconds);
    if (!Number.isFinite(delta) || delta === 0) {
      return { ok: false, reason: 'invalid-delta' };
    }

    return seekWithWaveInstances(delta) || seekWithMediaElement(delta);
  }

  function getPlaybackState() {
    const waves = getPlaybackWaveInstances();
    if (waves.length) {
      const currentTime = Number(safe(() => waves[0].getCurrentTime(), NaN));
      const paused = getWavePausedState(waves[0]);
      const duration = Number(
        typeof waves[0].getDuration === 'function' ? safe(() => waves[0].getDuration(), NaN) : NaN
      );
      return {
        ok: Number.isFinite(currentTime) || typeof paused === 'boolean',
        source: 'wavesurfer',
        currentTime: Number.isFinite(currentTime) ? currentTime : null,
        duration: Number.isFinite(duration) ? duration : null,
        paused: typeof paused === 'boolean' ? paused : null,
        indicator: getPlaybackIndicator(),
        waveCount: waves.length
      };
    }

    const audio = document.querySelector('audio');
    if (!(audio instanceof HTMLMediaElement)) {
      return { ok: false, reason: 'playback-unavailable', indicator: getPlaybackIndicator() };
    }

    return {
      ok: true,
      source: 'audio',
      currentTime: Number.isFinite(Number(audio.currentTime)) ? Number(audio.currentTime) : null,
      duration: Number.isFinite(Number(audio.duration)) ? Number(audio.duration) : null,
      paused: Boolean(audio.paused),
      indicator: getPlaybackIndicator(),
      waveCount: 0
    };
  }

  function setWavePausedState(paused) {
    const waves = getPlaybackWaveInstances();
    if (!waves.length) {
      return null;
    }

    let applied = 0;
    for (const wave of waves) {
      try {
        if (paused) {
          if (typeof wave.pause === 'function') {
            wave.pause();
            applied += 1;
            continue;
          }
          if (wave.media && typeof wave.media.pause === 'function') {
            wave.media.pause();
            applied += 1;
            continue;
          }
        } else {
          if (typeof wave.play === 'function') {
            const result = wave.play();
            if (result && typeof result.catch === 'function') {
              result.catch(() => {});
            }
            applied += 1;
            continue;
          }
          if (wave.media && typeof wave.media.play === 'function') {
            const result = wave.media.play();
            if (result && typeof result.catch === 'function') {
              result.catch(() => {});
            }
            applied += 1;
            continue;
          }
        }
      } catch (_error) {
        // Ignore one-off instance failures; sibling waveforms can still stay in sync.
      }
    }

    if (!applied) {
      return null;
    }

    const state = getPlaybackState();
    return {
      ...state,
      ok: Boolean(state && state.ok && state.paused === paused),
      via: 'wavesurfer-direct'
    };
  }

  function setAudioPausedState(paused) {
    const audio = document.querySelector('audio');
    if (!(audio instanceof HTMLMediaElement)) {
      return null;
    }

    try {
      if (paused) {
        audio.pause();
      } else if (typeof audio.play === 'function') {
        const result = audio.play();
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      }
    } catch (_error) {
      return null;
    }

    const state = getPlaybackState();
    return {
      ...state,
      ok: Boolean(state && state.ok && state.paused === paused),
      via: 'audio-direct'
    };
  }

  function setPlaybackPaused(paused) {
    const desired = Boolean(paused);
    const previous = getPlaybackState();
    if (previous && previous.ok && previous.paused === desired) {
      return {
        ...previous,
        ok: true,
        previousPaused: previous.paused,
        changed: false,
        via: 'noop'
      };
    }

    const control = getPlaybackControl(desired);
    if (control && clickControl(control)) {
      const afterControl = getPlaybackState();
      if (afterControl && afterControl.ok && afterControl.paused === desired) {
        return {
          ...afterControl,
          previousPaused: previous && typeof previous.paused === 'boolean' ? previous.paused : null,
          changed:
            previous && typeof previous.paused === 'boolean'
              ? previous.paused !== afterControl.paused
              : null,
          via: 'control'
        };
      }
    }

    const direct =
      setWavePausedState(desired) ||
      setAudioPausedState(desired) || {
        ok: false,
        reason: 'playback-unavailable',
        indicator: getPlaybackIndicator()
      };

    return {
      ...direct,
      previousPaused: previous && typeof previous.paused === 'boolean' ? previous.paused : null,
      changed:
        previous &&
        typeof previous.paused === 'boolean' &&
        typeof direct.paused === 'boolean'
          ? previous.paused !== direct.paused
          : null
    };
  }

  function handleRequest(event) {
    const detail = event.detail || {};
    const id = detail.id;
    const operation = detail.operation;
    const payload = detail.payload || {};
    if (!id) {
      return;
    }

    if (operation === 'seek') {
      respond(id, seekPlaybackBySeconds(payload.deltaSeconds));
      return;
    }

    if (operation === 'state') {
      respond(id, getPlaybackState());
      return;
    }

    if (operation === 'set-paused') {
      respond(id, setPlaybackPaused(payload.paused));
    }
  }

  function dispose() {
    window.removeEventListener(REQUEST_EVENT, handleRequest, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    delete window.__babelHelperPlaybackBridge;
  }

  window.addEventListener(REQUEST_EVENT, handleRequest, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);

  window.__babelHelperPlaybackBridge = {
    seekPlaybackBySeconds,
    getPlaybackState,
    setPlaybackPaused,
    dispose
  };
}

initPlaybackBridge();
