// @ts-nocheck
export function initPlaybackBridge() {
  if (window.__babelHelperPlaybackBridge) {
    return;
  }

  const REQUEST_EVENT = 'babel-helper-playback-request';
  const RESPONSE_EVENT = 'babel-helper-playback-response';
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
  const DEFAULT_PLAYBACK_SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2];

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

  function getReactProps(element) {
    return getReactInternalValue(element, '__reactProps$');
  }

  function getElementText(element) {
    if (!element) {
      return '';
    }

    return [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element.innerText,
      element.textContent
    ]
      .filter((value) => typeof value === 'string' && value.trim())
      .join(' ')
      .trim();
  }

  function normalizePlaybackSpeed(value) {
    const speed = Number(String(value ?? '').replace(',', '.').replace(/x$/i, ''));
    return Number.isFinite(speed) && speed > 0 && speed <= 4 ? speed : null;
  }

  function getPlaybackSpeedValueFromText(text) {
    const normalized = String(text || '').replace(',', '.');
    const match = normalized.match(/(^|[^\d])(\d+(?:\.\d+)?)\s*x\b/i);
    if (!match) {
      return null;
    }

    return normalizePlaybackSpeed(match[2]);
  }

  function getPlaybackSpeedValueFromElement(element) {
    if (!element) {
      return null;
    }

    const textValue = getPlaybackSpeedValueFromText(getElementText(element));
    if (textValue != null) {
      return textValue;
    }

    const props = getReactProps(element);
    const propValue = props && typeof props === 'object'
      ? props.value ?? props.defaultValue ?? props['aria-valuenow']
      : null;
    const normalizedPropValue = normalizePlaybackSpeed(propValue);
    if (normalizedPropValue != null) {
      return normalizedPropValue;
    }

    const rawValue =
      element.getAttribute?.('data-value') ||
      element.getAttribute?.('value') ||
      (typeof element.value === 'string' ? element.value : '');
    return normalizePlaybackSpeed(rawValue);
  }

  function formatPlaybackSpeed(speed) {
    return String(Number(speed.toFixed(3))).replace(/\.0+$/, '');
  }

  function formatReactSpeedValue(referenceValue, speed) {
    if (typeof referenceValue === 'number') {
      return speed;
    }

    if (typeof referenceValue === 'string') {
      return /x/i.test(referenceValue)
        ? `${formatPlaybackSpeed(speed)}x`
        : formatPlaybackSpeed(speed);
    }

    return formatPlaybackSpeed(speed);
  }

  function isUsableSpeedControl(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.getAttribute('aria-disabled') === 'true') {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getPlaybackSpeedControls() {
    return Array.from(
      document.querySelectorAll(
        'button, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"], select'
      )
    ).filter((element) => (
      isUsableSpeedControl(element) &&
      getPlaybackSpeedValueFromElement(element) != null
    ));
  }

  function getReactSpeedControlHandler() {
    for (const control of getPlaybackSpeedControls()) {
      let owner = getReactFiber(control);
      let ownerDepth = 0;
      while (owner && typeof owner === 'object' && ownerDepth < 16) {
        const propSources = [owner.memoizedProps, owner.pendingProps].filter(
          (props) => props && typeof props === 'object'
        );

        for (const props of propSources) {
          if (typeof props.onValueChange !== 'function') {
            continue;
          }

          const referenceValue = props.value ?? props.defaultValue ?? getPlaybackSpeedValueFromElement(control);
          if (normalizePlaybackSpeed(referenceValue) == null) {
            continue;
          }

          return {
            onValueChange: props.onValueChange,
            referenceValue
          };
        }

        owner = owner.return;
        ownerDepth += 1;
      }
    }

    return null;
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

  function getWavePlaybackSpeed(wave) {
    if (!wave || typeof wave !== 'object') {
      return null;
    }

    if (typeof wave.getPlaybackRate === 'function') {
      const speed = normalizePlaybackSpeed(safe(() => wave.getPlaybackRate(), null));
      if (speed != null) {
        return speed;
      }
    }

    if (wave.media && 'playbackRate' in wave.media) {
      return normalizePlaybackSpeed(wave.media.playbackRate);
    }

    return null;
  }

  function getPlaybackSpeed() {
    const waves = getPlaybackWaveInstances();
    if (waves.length) {
      const waveSpeed = getWavePlaybackSpeed(waves[0]);
      if (waveSpeed != null) {
        return waveSpeed;
      }
    }

    const audio = document.querySelector('audio');
    if (audio instanceof HTMLMediaElement) {
      const audioSpeed = normalizePlaybackSpeed(audio.playbackRate);
      if (audioSpeed != null) {
        return audioSpeed;
      }
    }

    for (const control of getPlaybackSpeedControls()) {
      const controlSpeed = getPlaybackSpeedValueFromElement(control);
      if (controlSpeed != null) {
        return controlSpeed;
      }
    }

    return null;
  }

  function normalizeSpeedSteps(steps) {
    const normalized = Array.isArray(steps)
      ? steps.map(normalizePlaybackSpeed).filter((speed) => speed != null)
      : [];
    const values = normalized.length ? normalized : DEFAULT_PLAYBACK_SPEED_STEPS;
    return Array.from(new Set(values)).sort((a, b) => a - b);
  }

  function getAdjacentPlaybackSpeed(currentSpeed, direction, steps) {
    const normalizedDirection = direction > 0 ? 1 : -1;
    const current = normalizePlaybackSpeed(currentSpeed) ?? 1;
    const values = normalizeSpeedSteps(steps);
    if (normalizedDirection > 0) {
      return values.find((speed) => speed > current + 0.001) || values[values.length - 1];
    }

    return values.slice().reverse().find((speed) => speed < current - 0.001) || values[0];
  }

  function applyReactPlaybackSpeed(speed) {
    const handler = getReactSpeedControlHandler();
    if (!handler) {
      return false;
    }

    try {
      handler.onValueChange(formatReactSpeedValue(handler.referenceValue, speed));
      return true;
    } catch (_error) {
      return false;
    }
  }

  function setWavePlaybackSpeed(speed) {
    const waves = getPlaybackWaveInstances();
    if (!waves.length) {
      return null;
    }

    let applied = 0;
    for (const wave of waves) {
      try {
        if (typeof wave.setPlaybackRate === 'function') {
          wave.setPlaybackRate(speed);
          applied += 1;
          continue;
        }
        if (wave.media && 'playbackRate' in wave.media) {
          wave.media.playbackRate = speed;
          applied += 1;
        }
      } catch (_error) {
        // Ignore one-off instance failures; sibling waveforms can still update.
      }
    }

    return applied ? { source: 'wavesurfer', waveCount: applied } : null;
  }

  function setAudioPlaybackSpeed(speed) {
    const audio = document.querySelector('audio');
    if (!(audio instanceof HTMLMediaElement)) {
      return null;
    }

    try {
      audio.playbackRate = speed;
      return { source: 'audio', waveCount: 0 };
    } catch (_error) {
      return null;
    }
  }

  function restorePlaybackPositionAfterSpeedChange(previousState) {
    const targetTime =
      previousState && typeof previousState.currentTime === 'number'
        ? previousState.currentTime
        : null;
    if (targetTime == null || !Number.isFinite(targetTime)) {
      return { restored: false, reason: 'previous-time-unavailable' };
    }

    const waves = getPlaybackWaveInstances();
    let applied = 0;
    for (const wave of waves) {
      try {
        wave.setTime(targetTime);
        applied += 1;
      } catch (_error) {
        // Ignore one-off instance failures; sibling waveforms can still restore.
      }
    }

    if (!applied) {
      const audio = document.querySelector('audio');
      if (audio instanceof HTMLMediaElement) {
        try {
          audio.currentTime = targetTime;
          applied += 1;
        } catch (_error) {
          // Fall through to the unavailable response below.
        }
      }
    }

    if (!applied) {
      return { restored: false, reason: 'playback-unavailable', previousTime: targetTime };
    }

    const after = getPlaybackState();
    const restoredTime = typeof after?.currentTime === 'number' ? after.currentTime : null;
    return {
      restored: true,
      previousTime: targetTime,
      restoredTime,
      delta:
        restoredTime == null || !Number.isFinite(restoredTime)
          ? null
          : restoredTime - targetTime,
      waveCount: applied
    };
  }

  function setPlaybackSpeed(speed) {
    const targetSpeed = normalizePlaybackSpeed(speed);
    if (targetSpeed == null) {
      return { ok: false, reason: 'invalid-speed' };
    }

    const previousState = getPlaybackState();
    const previousSpeed = previousState?.playbackRate ?? getPlaybackSpeed();
    const reactUpdated = applyReactPlaybackSpeed(targetSpeed);
    const direct = setWavePlaybackSpeed(targetSpeed) || setAudioPlaybackSpeed(targetSpeed);

    if (!direct && !reactUpdated) {
      return { ok: false, reason: 'playback-unavailable', previousSpeed };
    }

    const positionRestore = restorePlaybackPositionAfterSpeedChange(previousState);

    return {
      ok: true,
      source: direct?.source || 'react-control',
      previousSpeed,
      nextSpeed: targetSpeed,
      playbackRate: targetSpeed,
      changed: previousSpeed == null || Math.abs(previousSpeed - targetSpeed) >= 0.001,
      reactUpdated,
      waveCount: direct?.waveCount ?? 0,
      positionRestore
    };
  }

  function adjustPlaybackSpeed(direction, steps) {
    const previousSpeed = getPlaybackSpeed();
    const nextSpeed = getAdjacentPlaybackSpeed(previousSpeed, Number(direction), steps);
    return {
      ...setPlaybackSpeed(nextSpeed),
      direction: Number(direction) > 0 ? 1 : -1
    };
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
        playbackRate: getWavePlaybackSpeed(waves[0]),
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
      playbackRate: normalizePlaybackSpeed(audio.playbackRate),
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
      return;
    }

    if (operation === 'adjust-speed') {
      respond(id, adjustPlaybackSpeed(payload.direction, payload.steps));
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
    adjustPlaybackSpeed,
    setPlaybackSpeed,
    dispose
  };
}

initPlaybackBridge();
