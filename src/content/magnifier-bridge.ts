// @ts-nocheck
export function initMagnifierBridge() {
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
  const existingBridge = window.__babelHelperMagnifierBridge;
  if (existingBridge) {
    if (typeof existingBridge.findNearestSpeechIsland === 'function') {
      return;
    }

    if (typeof existingBridge.dispose === 'function') {
      existingBridge.dispose();
    } else {
      delete window.__babelHelperMagnifierBridge;
    }
  }

  const REQUEST_EVENT = 'babel-helper-magnifier-request';
  const RESPONSE_EVENT = 'babel-helper-magnifier-response';
  const HOST_ATTR = 'data-babel-helper-magnifier-host';
  const MINIMAP_HOST_ATTR = 'data-babel-helper-minimap-host';
  const MOUNT_ATTR = 'data-babel-helper-magnifier-mount';
  const LOOP_HOST_ATTR = 'data-babel-helper-selection-loop-host';
  const instances = new Map();
  const loops = new Map();
  const MAX_CANDIDATES = 12;
  const WAVEFORM_SCALE_SELECTOR = '[role="slider"][data-orientation="vertical"]';
  const WAVEFORM_SCALE_PATCH_ATTR = 'data-babel-helper-waveform-scale-max';
  const WAVEFORM_SCALE_DEFAULT_MIN = 0.3;
  const WAVEFORM_SCALE_DEFAULT_MAX = 20;
  const WAVEFORM_SCALE_DEFAULT_STEP = 0.001;
  const AUTO_SEGMENT_PROMPT_SESSION_OPTIONS = {
    expectedInputs: [{ type: 'text' }, { type: 'audio' }],
    expectedOutputs: [{ type: 'text' }],
    initialPrompts: [
      {
        role: 'system',
        content:
          'You review a deterministic same-speaker transcript alignment. Do not rewrite, translate, invent, copy, or return transcript text. Return only valid JSON that either accepts the draft or requests adjacent whole-sentence moves.'
      }
    ]
  };
  const AUTO_SEGMENT_TRANSCRIBE_SESSION_OPTIONS = {
    expectedInputs: [{ type: 'text' }, { type: 'audio' }],
    expectedOutputs: [{ type: 'text' }],
    initialPrompts: [
      {
        role: 'system',
        content:
          'Ты расшифровываешь русскую речь. Верни только точный текст из аудио без пояснений, переводов, исправлений и markdown.'
      }
    ]
  };
  const AUTO_SEGMENT_PROMPT_MAX_AUDIO_SAMPLES = 4;
  const AUTO_SEGMENT_PROMPT_MAX_AUDIO_SECONDS = 12;
  const waveformScaleState = {
    enabled: false,
    max: 1000,
    drag: null,
    observer: null
  };
  const promptSessions = new Map();
  let promptSessionCounter = 0;

  function safe(callback, fallbackValue) {
    try {
      const value = callback();
      return value == null ? fallbackValue : value;
    } catch (error) {
      return fallbackValue;
    }
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function parsePixels(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const match = value.match(/(-?\d+(?:\.\d+)?)px/i);
    if (!match) {
      return null;
    }

    const numeric = Number(match[1]);
    return Number.isFinite(numeric) ? numeric : null;
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

  function respondProgress(id, progress) {
    window.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          id,
          progress
        }
      })
    );
  }

  function getCtorName(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return null;
    }

    const ctor = safe(() => value.constructor, null);
    const name = ctor && typeof ctor.name === 'string' ? ctor.name : '';
    return name || null;
  }

  function getMethodNames(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return [];
    }

    const methods = [];
    for (const name of safe(() => Object.getOwnPropertyNames(value), [])) {
      if (!name || name === 'constructor') {
        continue;
      }

      if (typeof safe(() => value[name], null) === 'function') {
        methods.push(name);
      }
    }

    return methods.slice(0, 10);
  }

  function getPreviewKeys(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return [];
    }

    return safe(() => Object.getOwnPropertyNames(value), [])
      .filter(Boolean)
      .slice(0, 14);
  }

  function scoreCandidate(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return 0;
    }

    let score = 0;
    if (typeof value.zoom === 'function') score += 4;
    if (typeof value.getDuration === 'function') score += 4;
    if (typeof value.exportPeaks === 'function') score += 3;
    if (typeof value.setOptions === 'function') score += 2;
    if (typeof value.setTime === 'function') score += 2;
    if (typeof value.getCurrentTime === 'function') score += 2;
    if (typeof value.registerPlugin === 'function') score += 2;
    if (typeof value.play === 'function') score += 1;
    if (typeof value.pause === 'function') score += 1;
    if (value.options && typeof value.options === 'object') score += 3;
    if (value.renderer && typeof value.renderer === 'object') score += 1;
    if (value.plugins && typeof value.plugins === 'object') score += 1;
    if (value.regions && typeof value.regions === 'object') score += 1;
    if (value.container instanceof HTMLElement) score += 1;
    if (value.constructor && typeof value.constructor.create === 'function') score += 2;
    return score;
  }

  function getOwnValues(target) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
      return [];
    }

    const values = [];
    for (const name of safe(() => Object.getOwnPropertyNames(target), [])) {
      if (!name || name === 'window' || name === 'self' || name === 'frames') {
        continue;
      }
      values.push(safe(() => target[name], null));
    }

    for (const symbol of safe(() => Object.getOwnPropertySymbols(target), [])) {
      values.push(safe(() => target[symbol], null));
    }

    return values;
  }

  function queryMarker(root, attr, marker) {
    if (!marker || !root || typeof root.querySelector !== 'function') {
      return null;
    }

    return safe(() => root.querySelector('[' + attr + '="' + marker + '"]'), null);
  }

  function findHostElement(hostMarker) {
    // The minimap reuses this bridge but tags waveform hosts with its own marker attribute.
    const host =
      queryMarker(document, HOST_ATTR, hostMarker) ||
      queryMarker(document, MINIMAP_HOST_ATTR, hostMarker);
    return host instanceof HTMLElement ? host : null;
  }

  function findLoopHostElement(hostMarker) {
    const host = queryMarker(document, LOOP_HOST_ATTR, hostMarker);
    return host instanceof HTMLElement ? host : null;
  }

  function findMountElement(host, mountMarker) {
    let mount = queryMarker(document, MOUNT_ATTR, mountMarker);
    if (mount instanceof HTMLElement) {
      return mount;
    }

    if (host instanceof HTMLElement && host.shadowRoot) {
      mount = queryMarker(host.shadowRoot, MOUNT_ATTR, mountMarker);
      if (mount instanceof HTMLElement) {
        return mount;
      }
    }

    const root = host && typeof host.getRootNode === 'function' ? host.getRootNode() : null;
    if (root instanceof ShadowRoot) {
      mount = queryMarker(root, MOUNT_ATTR, mountMarker);
      if (mount instanceof HTMLElement) {
        return mount;
      }
    }

    return null;
  }

  function getElementSearchSeeds(host) {
    if (!(host instanceof HTMLElement)) {
      return [];
    }

    const seeds = [];
    let current = host;
    let depth = 0;

    while (current instanceof HTMLElement && depth < 8) {
      seeds.push({
        value: current,
        path: depth === 0 ? 'host' : 'host^' + depth
      });

      if (current.parentElement instanceof HTMLElement) {
        current = current.parentElement;
        depth += 1;
        continue;
      }

      const root = current.getRootNode();
      if (root instanceof ShadowRoot && root.host instanceof HTMLElement && root.host !== current) {
        current = root.host;
        depth += 1;
        continue;
      }

      break;
    }

    return seeds;
  }

  function getReactInternalValue(element, prefix) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    for (const name of safe(() => Object.getOwnPropertyNames(element), [])) {
      if (typeof name === 'string' && name.indexOf(prefix) === 0) {
        return safe(() => element[name], null);
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

  function pushSearchSeed(seeds, seenValues, value, path) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return;
    }

    if (seenValues.has(value)) {
      return;
    }

    seenValues.add(value);
    seeds.push({
      value,
      path
    });
  }

  function getReactHookValues(fiber, fiberPath) {
    if (!fiber || typeof fiber !== 'object') {
      return [];
    }

    const seeds = [];
    const seenHooks = new Set();
    let hook = safe(() => fiber.memoizedState, null);
    let index = 0;

    while (hook && typeof hook === 'object' && !seenHooks.has(hook) && index < 12) {
      seenHooks.add(hook);

      const hookPath = fiberPath + '.memoizedState[' + index + ']';
      const memoizedState = safe(() => hook.memoizedState, null);
      if (memoizedState && (typeof memoizedState === 'object' || typeof memoizedState === 'function')) {
        seeds.push({
          value: memoizedState,
          path: hookPath
        });

        const current = safe(() => memoizedState.current, null);
        if (current && (typeof current === 'object' || typeof current === 'function')) {
          seeds.push({
            value: current,
            path: hookPath + '.current'
          });
        }

        const value = safe(() => memoizedState.value, null);
        if (value && (typeof value === 'object' || typeof value === 'function')) {
          seeds.push({
            value,
            path: hookPath + '.value'
          });
        }
      }

      hook = safe(() => hook.next, null);
      index += 1;
    }

    return seeds;
  }

  function getReactOwnerFibers(fiber, fiberPath) {
    if (!fiber || typeof fiber !== 'object') {
      return [];
    }

    const owners = [];
    const seen = new Set();
    let current = safe(() => fiber.return, null);
    let depth = 0;

    while (current && typeof current === 'object' && !seen.has(current) && depth < 10) {
      seen.add(current);
      owners.push({
        fiber: current,
        path: fiberPath + '.return^' + (depth + 1)
      });
      current = safe(() => current.return, null);
      depth += 1;
    }

    return owners;
  }

  function getSearchSeeds(host) {
    const elementSeeds = getElementSearchSeeds(host);
    const seeds = [];
    const seenValues = new Set();

    for (const seed of elementSeeds) {
      pushSearchSeed(seeds, seenValues, seed.value, seed.path);

      const reactProps = getReactProps(seed.value);
      pushSearchSeed(seeds, seenValues, reactProps, seed.path + '.__reactProps$');

      const fiber = getReactFiber(seed.value);
      const fiberPath = seed.path + '.__reactFiber$';
      pushSearchSeed(seeds, seenValues, fiber, fiberPath);
      const relatedFibers = [{ fiber, path: fiberPath }].concat(getReactOwnerFibers(fiber, fiberPath));

      for (const related of relatedFibers) {
        const relatedFiber = related.fiber;
        const relatedPath = related.path;
        pushSearchSeed(
          seeds,
          seenValues,
          safe(() => relatedFiber.stateNode, null),
          relatedPath + '.stateNode'
        );
        pushSearchSeed(seeds, seenValues, safe(() => relatedFiber.ref, null), relatedPath + '.ref');
        pushSearchSeed(
          seeds,
          seenValues,
          safe(() => relatedFiber.ref.current, null),
          relatedPath + '.ref.current'
        );
        pushSearchSeed(
          seeds,
          seenValues,
          safe(() => relatedFiber.memoizedProps, null),
          relatedPath + '.memoizedProps'
        );
        pushSearchSeed(
          seeds,
          seenValues,
          safe(() => relatedFiber.memoizedProps.ref, null),
          relatedPath + '.memoizedProps.ref'
        );
        pushSearchSeed(
          seeds,
          seenValues,
          safe(() => relatedFiber.memoizedProps.ref.current, null),
          relatedPath + '.memoizedProps.ref.current'
        );

        for (const hookSeed of getReactHookValues(relatedFiber, relatedPath)) {
          pushSearchSeed(seeds, seenValues, hookSeed.value, hookSeed.path);
        }
      }
    }

    return seeds;
  }

  function collectRegistryCandidates(host) {
    if (!(host instanceof HTMLElement)) {
      return [];
    }

    const matches = [];
    const seenMaps = new Set();

    for (const seed of getSearchSeeds(host)) {
      const value = seed && seed.value;
      if (!value || typeof value !== 'object' || seenMaps.has(value)) {
        continue;
      }

      seenMaps.add(value);
      const keys = safe(() => Object.keys(value), []);
      if (!keys.length || keys.length > 64) {
        continue;
      }

      for (const key of keys) {
        const entry = safe(() => value[key], null);
        if (!entry || typeof entry !== 'object') {
          continue;
        }

        const wave = safe(() => entry.wavesurfer, null);
        if (!wave || (typeof wave !== 'object' && typeof wave !== 'function')) {
          continue;
        }

        const entryKeys = getPreviewKeys(entry);
        if (!entryKeys.includes('wavesurfer')) {
          continue;
        }

        matches.push({
          value: wave,
          path: seed.path + '.' + key + '.wavesurfer',
          depth: 2,
          score: scoreCandidate(wave) + 10
        });
      }
    }

    matches.sort((left, right) => right.score - left.score);
    return matches;
  }

  function getCandidateContainer(value) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return null;
    }

    const direct = safe(() => value.container, null);
    if (direct instanceof HTMLElement) {
      return direct;
    }

    const rendererContainer = safe(() => value.renderer.container, null);
    if (rendererContainer instanceof HTMLElement) {
      return rendererContainer;
    }

    const optionContainer = safe(() => value.options.container, null);
    if (optionContainer instanceof HTMLElement) {
      return optionContainer;
    }

    return null;
  }

  function elementsOverlapContext(host, element) {
    if (!(host instanceof HTMLElement) || !(element instanceof HTMLElement)) {
      return false;
    }

    if (host === element || host.contains(element) || element.contains(host)) {
      return true;
    }

    if (host.shadowRoot && host.shadowRoot.contains(element)) {
      return true;
    }

    if (element.shadowRoot && element.shadowRoot.contains(host)) {
      return true;
    }

    const hostRoot = typeof host.getRootNode === 'function' ? host.getRootNode() : null;
    const elementRoot = typeof element.getRootNode === 'function' ? element.getRootNode() : null;
    if (hostRoot instanceof ShadowRoot && hostRoot.host === element) {
      return true;
    }
    if (elementRoot instanceof ShadowRoot && elementRoot.host === host) {
      return true;
    }

    return false;
  }

  function isUsableWaveCandidate(value, host) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
      return false;
    }

    if (typeof value.getDuration !== 'function') {
      return false;
    }

    if (
      !(
        typeof value.setOptions === 'function' ||
        typeof value.zoom === 'function' ||
        typeof value.constructor?.create === 'function'
      )
    ) {
      return false;
    }

    const container = getCandidateContainer(value);
    if (container && !elementsOverlapContext(host, container)) {
      return false;
    }

    const duration = getDuration(value);
    if (!(duration > 0)) {
      return false;
    }

    const pixelsPerSecond = getSourcePixelsPerSecond(value);
    if (!(pixelsPerSecond > 0)) {
      return false;
    }

    return true;
  }

  function summarizeCandidateRecord(record, host) {
    if (!record || !record.value) {
      return null;
    }

    const value = record.value;
    const container = getCandidateContainer(value);
    return {
      path: record.path || null,
      depth: Number.isFinite(record.depth) ? record.depth : null,
      score: record.score,
      valid: isUsableWaveCandidate(value, host),
      ctor: getCtorName(value),
      methods: getMethodNames(value),
      keys: getPreviewKeys(value),
      duration: getDuration(value) || 0,
      pixelsPerSecond: getSourcePixelsPerSecond(value) || 0,
      containerCtor: getCtorName(container),
      containerMatchesHost: container ? elementsOverlapContext(host, container) : null
    };
  }

  function findWaveCandidate(host) {
    if (!(host instanceof HTMLElement)) {
      return {
        candidate: null,
        fallback: null
      };
    }

    const registryMatches = collectRegistryCandidates(host);
    const registryValid = registryMatches.find((record) => isUsableWaveCandidate(record.value, host)) || null;
    if (registryValid) {
      return {
        candidate: registryValid,
        fallback: registryMatches.find((record) => record !== registryValid) || null
      };
    }

    const queue = getSearchSeeds(host).map((seed) => ({
      value: seed.value,
      path: seed.path,
      depth: 0
    }));
    const seen = new Set();
    let bestValid = null;
    let bestValidScore = 0;
    let bestAny = null;
    let bestAnyScore = 0;

    while (queue.length && seen.size < 320) {
      const current = queue.shift();
      const value = current && current.value;
      if (!value || seen.has(value)) {
        continue;
      }

      seen.add(value);
      const score = scoreCandidate(value);
      const record = {
        value,
        path: current.path,
        depth: current.depth,
        score
      };

      if (score > bestAnyScore) {
        bestAny = record;
        bestAnyScore = score;
      }

      if (score >= 6 && isUsableWaveCandidate(value, host) && score > bestValidScore) {
        bestValid = record;
        bestValidScore = score;
      }

      for (const name of safe(() => Object.getOwnPropertyNames(value), [])) {
        if (!name || name === 'window' || name === 'self' || name === 'frames') {
          continue;
        }

        const next = safe(() => value[name], null);
        if (!next || seen.has(next)) {
          continue;
        }

        const nestedScore = scoreCandidate(next);
        if (nestedScore >= 2) {
          queue.push({
            value: next,
            path: current.path + '.' + name,
            depth: current.depth + 1
          });
        }
      }

      for (const symbol of safe(() => Object.getOwnPropertySymbols(value), [])) {
        const next = safe(() => value[symbol], null);
        if (!next || seen.has(next)) {
          continue;
        }

        const nestedScore = scoreCandidate(next);
        if (nestedScore >= 2) {
          queue.push({
            value: next,
            path: current.path + '[' + String(symbol) + ']',
            depth: current.depth + 1
          });
        }
      }
    }

    return {
      candidate: bestValid,
      fallback: bestAny
    };
  }

  function describeHost(host) {
    if (!(host instanceof HTMLElement)) {
      return {
        present: false
      };
    }

    return {
      present: true,
      tagName: host.tagName,
      id: host.id || null,
      className: typeof host.className === 'string' ? host.className || null : null,
      ownPropertyCount: safe(() => Object.getOwnPropertyNames(host).length, 0),
      ownPropertySample: getPreviewKeys(host),
      hasShadowRoot: Boolean(host.shadowRoot)
    };
  }

  function insertCandidate(list, candidate) {
    if (!candidate || !(candidate.score > 0)) {
      return;
    }

    list.push(candidate);
    list.sort((left, right) => right.score - left.score);
    if (list.length > MAX_CANDIDATES) {
      list.length = MAX_CANDIDATES;
    }
  }

  function collectWaveCandidates(host) {
    if (!(host instanceof HTMLElement)) {
      return [];
    }

    const queue = getSearchSeeds(host).map((seed) => ({
      value: seed.value,
      path: seed.path,
      depth: 0
    }));
    const seen = new Set();
    const candidates = [];

    while (queue.length && seen.size < 260) {
      const current = queue.shift();
      const value = current && current.value;
      if (!value || seen.has(value)) {
        continue;
      }

      seen.add(value);
      const score = scoreCandidate(value);
      insertCandidate(candidates, {
        path: current.path,
        depth: current.depth,
        score,
        ctor: getCtorName(value),
        methods: getMethodNames(value),
        keys: getPreviewKeys(value)
      });

      if (current.depth >= 2) {
        continue;
      }

      for (const name of safe(() => Object.getOwnPropertyNames(value), [])) {
        if (!name || name === 'window' || name === 'self' || name === 'frames') {
          continue;
        }

        const next = safe(() => value[name], null);
        if (!next || seen.has(next)) {
          continue;
        }

        queue.push({
          value: next,
          path: current.path + '.' + name,
          depth: current.depth + 1
        });
      }

      for (const symbol of safe(() => Object.getOwnPropertySymbols(value), [])) {
        const next = safe(() => value[symbol], null);
        if (!next || seen.has(next)) {
          continue;
        }

        queue.push({
          value: next,
          path: current.path + '[' + String(symbol) + ']',
          depth: current.depth + 1
        });
      }
    }

    return candidates;
  }

  function describeReactPath(path, element) {
    const fiber = getReactFiber(element);
    const baseFiberPath = path + '.__reactFiber$';
    const relatedFibers = fiber
      ? [{ fiber, path: baseFiberPath }].concat(getReactOwnerFibers(fiber, baseFiberPath))
      : [];
    const describedFibers = relatedFibers.slice(0, 6).map((entry) => {
      const hooks = getReactHookValues(entry.fiber, entry.path)
        .slice(0, 6)
        .map((hookEntry) => ({
          path: hookEntry.path,
          score: scoreCandidate(hookEntry.value),
          ctor: getCtorName(hookEntry.value),
          keys: getPreviewKeys(hookEntry.value)
        }));

      return {
        path: entry.path,
        tag: Number.isFinite(Number(safe(() => entry.fiber.tag, null))) ? Number(entry.fiber.tag) : null,
        typeName:
          safe(() => entry.fiber.type.displayName, null) ||
          safe(() => entry.fiber.type.name, null) ||
          safe(() => entry.fiber.elementType.displayName, null) ||
          safe(() => entry.fiber.elementType.name, null) ||
          null,
        stateNodeCtor: getCtorName(safe(() => entry.fiber.stateNode, null)),
        refCurrentCtor: getCtorName(safe(() => entry.fiber.ref.current, null)),
        memoizedPropsKeys: getPreviewKeys(safe(() => entry.fiber.memoizedProps, null)),
        hookCount: hooks.length,
        hooks
      };
    });

    return {
      path,
      reactPropsKeys: getPreviewKeys(getReactProps(element)),
      fiber: describedFibers.length ? describedFibers[0] : null,
      owners: describedFibers.slice(1)
    };
  }

  function getDuration(wave) {
    return safe(() => wave.getDuration(), 0) || safe(() => wave.options.duration, 0) || 0;
  }

  function getWaveRenderWidth(wave, wrapper, pixelsPerSecondOverride) {
    const duration = getDuration(wave);
    const fallbackPixelsPerSecond = Number(pixelsPerSecondOverride);
    const candidateWidths = [];

    if (wrapper instanceof HTMLElement) {
      candidateWidths.push(Number(wrapper.scrollWidth) || 0);
      candidateWidths.push(parsePixels(wrapper.style.width || '') || 0);
      candidateWidths.push(safe(() => wrapper.getBoundingClientRect().width, 0) || 0);
    }

    if (duration > 0 && Number.isFinite(fallbackPixelsPerSecond) && fallbackPixelsPerSecond > 0) {
      candidateWidths.push(fallbackPixelsPerSecond * duration);
    }

    for (const width of candidateWidths) {
      if (Number.isFinite(width) && width > 0) {
        return width;
      }
    }

    return 0;
  }

  function getSourcePixelsPerSecond(wave) {
    const duration = getDuration(wave);
    if (!(duration > 0)) {
      return 0;
    }

    const rendererWrapper =
      safe(() => (wave && wave.renderer ? wave.renderer.wrapper : null), null);
    const rendererWidth = getWaveRenderWidth(wave, rendererWrapper, null);

    if (rendererWidth > 0) {
      return rendererWidth / duration;
    }

    const container = wave.container instanceof HTMLElement ? wave.container : null;
    const scope = container && container.shadowRoot ? container.shadowRoot : null;
    const wrapper = scope && scope.querySelector ? scope.querySelector('[part="wrapper"]') : null;
    const width = getWaveRenderWidth(wave, wrapper, null);

    if (width > 0) {
      return width / duration;
    }

    const optionValue = Number(wave.options && wave.options.minPxPerSec);
    return Number.isFinite(optionValue) && optionValue > 0 ? optionValue : 0;
  }

  function measureSelectionTimeRange(hostMarker, leftPx, rightPx) {
    const host = findLoopHostElement(hostMarker) || findHostElement(hostMarker);
    if (!(host instanceof HTMLElement)) {
      return {
        ok: false,
        reason: 'missing-host'
      };
    }

    const selection = findWaveCandidate(host);
    const candidate = selection.candidate || selection.fallback || null;
    const wave = candidate && candidate.value ? candidate.value : null;
    if (!wave || !isUsableWaveCandidate(wave, host)) {
      return {
        ok: false,
        reason: 'missing-wave'
      };
    }

    const startPx = Number(leftPx);
    const endPx = Number(rightPx);
    if (!Number.isFinite(startPx) || !Number.isFinite(endPx) || endPx <= startPx) {
      return {
        ok: false,
        reason: 'invalid-range'
      };
    }

    const pixelsPerSecond = getSourcePixelsPerSecond(wave);
    if (!(pixelsPerSecond > 0)) {
      return {
        ok: false,
        reason: 'missing-scale'
      };
    }

    const duration = getDuration(wave);
    const startSeconds = startPx / pixelsPerSecond;
    const endSeconds = endPx / pixelsPerSecond;
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      !(endSeconds > startSeconds)
    ) {
      return {
        ok: false,
        reason: 'invalid-time'
      };
    }

    return {
      ok: true,
      startSeconds: clamp(startSeconds, 0, duration > 0 ? duration : startSeconds),
      endSeconds: clamp(endSeconds, 0, duration > 0 ? duration : endSeconds),
      pixelsPerSecond
    };
  }

  function findTrackFiber(startFiber) {
    let current = startFiber;
    let depth = 0;

    while (current && typeof current === 'object' && depth < 20) {
      const props = safe(() => current.memoizedProps, null);
      if (props && typeof props === 'object' && props.track) {
        return current;
      }

      current = safe(() => current.return, null);
      depth += 1;
    }

    return null;
  }

  function getTrackPropsForHost(host) {
    if (!(host instanceof HTMLElement)) {
      return null;
    }

    for (const seed of getElementSearchSeeds(host)) {
      const fiber = getReactFiber(seed.value);
      const trackFiber = findTrackFiber(fiber);
      const props = safe(() => trackFiber.memoizedProps, null);
      if (props && typeof props === 'object') {
        return props;
      }
    }

    return null;
  }

  function getTrackIdFromTrack(track) {
    if (!track || typeof track !== 'object') {
      return null;
    }

    if (track.processedRecordingId != null) {
      return String(track.processedRecordingId);
    }

    return track.id != null ? String(track.id) : null;
  }

  function getTrackLabelFromTrack(track) {
    if (!track || typeof track !== 'object') {
      return '';
    }

    for (const key of ['label', 'trackLabel', 'name', 'speakerName', 'title']) {
      const value = track[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    return '';
  }

  function getSourceCanvasMetrics(wave) {
    const container = getCandidateContainer(wave);
    const scope = container && container.shadowRoot ? container.shadowRoot : null;
    const canvas =
      scope && typeof scope.querySelector === 'function'
        ? scope.querySelector('[part="canvases"] canvas')
        : null;

    const cssHeight =
      canvas instanceof HTMLCanvasElement
        ? parsePixels(canvas.style.height || '') || safe(() => canvas.getBoundingClientRect().height, 0)
        : 0;
    const intrinsicHeight =
      canvas instanceof HTMLCanvasElement && Number.isFinite(canvas.height) ? canvas.height : 0;

    return {
      cssHeight: cssHeight > 0 ? cssHeight : 0,
      intrinsicHeight: intrinsicHeight > 0 ? intrinsicHeight : 0,
      pixelRatio:
        cssHeight > 0 && intrinsicHeight > 0 ? intrinsicHeight / cssHeight : window.devicePixelRatio || 1
    };
  }

  function getSourceRenderMetrics(sourceWave, host) {
    const optionHeight = Number(safe(() => sourceWave.options.height, 0));
    const rendererHeight = Number(
      safe(() => {
        const renderer = sourceWave && sourceWave.renderer;
        if (!renderer || typeof renderer.getHeight !== 'function') {
          return 0;
        }

        return renderer.getHeight();
      }, 0)
    );
    const canvasMetrics = getSourceCanvasMetrics(sourceWave);
    const trackProps = getTrackPropsForHost(host);
    const trackHeight = Number(trackProps && trackProps.defaultTrackHeight);
    const hostHeight = safe(() => host.getBoundingClientRect().height, 0);

    const renderHeight =
      (rendererHeight > 0 && rendererHeight) ||
      (canvasMetrics.cssHeight > 0 && canvasMetrics.cssHeight) ||
      (optionHeight > 0 && optionHeight) ||
      (trackHeight > 0 && trackHeight) ||
      (hostHeight > 0 && hostHeight) ||
      1;

    return {
      renderHeight,
      rendererHeight: rendererHeight > 0 ? rendererHeight : null,
      optionHeight: optionHeight > 0 ? optionHeight : null,
      canvasCssHeight: canvasMetrics.cssHeight > 0 ? canvasMetrics.cssHeight : null,
      canvasIntrinsicHeight: canvasMetrics.intrinsicHeight > 0 ? canvasMetrics.intrinsicHeight : null,
      pixelRatio:
        Number.isFinite(canvasMetrics.pixelRatio) && canvasMetrics.pixelRatio > 0
          ? canvasMetrics.pixelRatio
          : 1,
      verticalZoom: Number(trackProps && trackProps.verticalZoom) || null,
      defaultTrackHeight: trackHeight > 0 ? trackHeight : null
    };
  }

  function buildLensOptions(sourceWave, mount, scale, sourceMetrics) {
    const options =
      sourceWave && sourceWave.options && typeof sourceWave.options === 'object'
        ? Object.assign({}, sourceWave.options)
        : {};

    delete options.container;
    delete options.plugins;
    delete options.media;
    delete options.url;

    options.container = mount;
    options.interact = false;
    options.dragToSeek = false;
    options.autoScroll = false;
    options.autoCenter = false;
    options.hideScrollbar = true;
    options.height =
      Number(sourceMetrics && sourceMetrics.renderHeight) > 0
        ? Number(sourceMetrics.renderHeight)
        : Math.max(1, Number(safe(() => sourceWave.options.height, 0)) || 1);
    options.minPxPerSec = Math.max(1, (getSourcePixelsPerSecond(sourceWave) || 1) * scale);
    options.duration = getDuration(sourceWave);

    delete options.peaks;

    return options;
  }

  function syncLensDecodedAudio(record) {
    if (!record || !record.wave || !record.sourceWave) {
      return false;
    }

    const decodedData =
      safe(() => record.sourceWave.getDecodedData(), null) ||
      safe(() => record.sourceWave.decodedData, null) ||
      safe(() => record.sourceWave.renderer.audioData, null);

    if (!decodedData) {
      return false;
    }

    safe(() => {
      record.wave.decodedData = decodedData;
    }, null);
    safe(() => {
      record.wave.renderer.audioData = decodedData;
    }, null);
    safe(() => {
      record.wave._duration = getDuration(record.sourceWave);
    }, null);
    safe(() => {
      record.wave.options.duration = getDuration(record.sourceWave);
    }, null);

    const rendered = safe(() => {
      if (record.wave.renderer && typeof record.wave.renderer.render === 'function') {
        record.wave.renderer.render(decodedData);
        return true;
      }

      return false;
    }, false);

    safe(() => {
      if (rendered && record.wave.renderer && typeof record.wave.renderer.reRender === 'function') {
        record.wave.renderer.reRender();
      }
    }, null);

    return rendered;
  }

  const minimapPeakCache = new WeakMap();
  const minimapNavigationTokens = new WeakMap();

  function resamplePeaksLinear(source, binCount) {
    if (!source || !source.length || !(binCount > 0)) {
      return [];
    }

    if (source.length === binCount) {
      return Array.from(source);
    }

    const out = [];
    const last = source.length - 1;
    for (let i = 0; i < binCount; i += 1) {
      const t = binCount === 1 ? 0 : (i / (binCount - 1)) * last;
      const i0 = Math.floor(t);
      const i1 = Math.min(last, i0 + 1);
      const f = t - i0;
      const v0 = Number(source[i0]) || 0;
      const v1 = Number(source[i1]) || 0;
      out.push(v0 * (1 - f) + v1 * f);
    }

    return out;
  }

  function normalizeExportPeaksChannels(exported) {
    if (!exported) {
      return [];
    }

    if (Array.isArray(exported) && exported.length) {
      const first = exported[0];
      if (ArrayBuffer.isView(first) || Array.isArray(first)) {
        return exported;
      }
    }

    if (ArrayBuffer.isView(exported) || Array.isArray(exported)) {
      return [exported];
    }

    return [];
  }

  function peaksFromExportPeaks(wave, binCount) {
    if (!wave || typeof wave.exportPeaks !== 'function') {
      return null;
    }

    const exported = safe(() => wave.exportPeaks(), null);
    const channels = normalizeExportPeaksChannels(exported);
    if (!channels.length) {
      return null;
    }

    const lengths = channels.map((ch) => (ch && ch.length ? ch.length : 0));
    const maxLen = Math.max(0, ...lengths);
    if (!(maxLen > 0)) {
      return null;
    }

    const merged = new Array(maxLen);
    for (let i = 0; i < maxLen; i += 1) {
      let m = 0;
      for (const ch of channels) {
        if (!ch || !ch.length) {
          continue;
        }
        const v = Math.abs(Number(ch[i]) || 0);
        if (v > m) {
          m = v;
        }
      }
      merged[i] = m;
    }

    return resamplePeaksLinear(merged, binCount);
  }

  function getRawExportPeaks(wave) {
    if (!wave || typeof wave.exportPeaks !== 'function') {
      return null;
    }

    const exported = safe(() => wave.exportPeaks(), null);
    const channels = normalizeExportPeaksChannels(exported);
    if (!channels.length) {
      return null;
    }

    const lengths = channels.map((ch) => (ch && ch.length ? ch.length : 0));
    const maxLen = Math.max(0, ...lengths);
    if (!(maxLen > 0)) {
      return null;
    }

    const merged = new Array(maxLen);
    for (let i = 0; i < maxLen; i += 1) {
      let max = 0;
      for (const ch of channels) {
        if (!ch || !ch.length) {
          continue;
        }
        const v = Math.abs(Number(ch[i]) || 0);
        if (v > max) {
          max = v;
        }
      }
      merged[i] = max;
    }

    return merged;
  }

  function getDecodedAudioForPeaks(wave) {
    return (
      safe(() => wave.getDecodedData(), null) ||
      safe(() => wave.decodedData, null) ||
      safe(() => wave.renderer && wave.renderer.audioData, null)
    );
  }

  function getAudioBufferSignature(audio) {
    if (!audio || typeof audio.getChannelData !== 'function') {
      return 'no-audio';
    }

    const channel = safe(() => audio.getChannelData(0), null);
    const length = channel && channel.length ? channel.length : Number(audio.length) || 0;
    const duration = Number(audio.duration) || 0;
    const channelCount = Math.max(1, Number(audio.numberOfChannels) || 1);
    const samples = [];
    if (channel && channel.length) {
      const last = channel.length - 1;
      for (const index of [0, Math.floor(last / 3), Math.floor((last * 2) / 3), last]) {
        samples.push((Number(channel[index]) || 0).toFixed(5));
      }
    }

    return [
      duration.toFixed(3),
      String(channelCount),
      String(length),
      samples.join(',')
    ].join(':');
  }

  function getRegionSignatureForMinimap(wave) {
    const regions = getSourceRegionEntries(wave);
    if (!regions.length) {
      return 'regions:0';
    }

    return (
      'regions:' +
      regions
        .map((region) =>
          [
            Number(region.start).toFixed(3),
            Number(region.end).toFixed(3),
            region.backgroundColor || '',
            region.borderLeft || '',
            region.borderRight || ''
          ].join(',')
        )
        .join(';')
    );
  }

  function getMinimapPeakSignature(wave) {
    return [
      'duration:' + (Number(getDuration(wave)) || 0).toFixed(3),
      'audio:' + getAudioBufferSignature(getDecodedAudioForPeaks(wave))
    ].join('|');
  }

  function getMinimapContentSignature(wave) {
    return [
      getMinimapPeakSignature(wave),
      getRegionSignatureForMinimap(wave)
    ].join('|');
  }

  function downsampleAbsPeaksBounded(channelData, binCount) {
    if (!channelData || !channelData.length || !(binCount > 0)) {
      return [];
    }

    const len = channelData.length;
    const samplesPerBin = len / binCount;
    const MAX_INNER = 640;

    const out = [];
    for (let i = 0; i < binCount; i += 1) {
      const start = Math.floor(i * samplesPerBin);
      const end = Math.min(len, Math.floor((i + 1) * samplesPerBin));
      const span = end - start;
      const step = Math.max(1, Math.ceil(span / MAX_INNER));
      let max = 0;
      for (let s = start; s < end; s += step) {
        const v = Math.abs(Number(channelData[s]) || 0);
        if (v > max) {
          max = v;
        }
      }
      out.push(max);
    }

    return out;
  }

  function peaksFromDecodedAudio(wave, binCount) {
    const audio = getDecodedAudioForPeaks(wave);
    if (!audio || typeof audio.getChannelData !== 'function') {
      return null;
    }

    const channelData = safe(() => audio.getChannelData(0), null);
    if (!channelData || !channelData.length) {
      return null;
    }

    return downsampleAbsPeaksBounded(channelData, binCount);
  }

  function getDecodedAudioChannelsForTrim(wave) {
    const audio = getDecodedAudioForPeaks(wave);
    if (!audio || typeof audio.getChannelData !== 'function') {
      return null;
    }

    const channelCount = Math.max(1, Number(audio.numberOfChannels) || 1);
    const channels = [];
    for (let index = 0; index < channelCount; index += 1) {
      const channel = safe(() => audio.getChannelData(index), null);
      if (channel && channel.length) {
        channels.push(channel);
      }
    }

    return channels.length ? { audio, channels } : null;
  }

  async function getPromptApiLanguageModel(options) {
    const sessionOptions = options || AUTO_SEGMENT_PROMPT_SESSION_OPTIONS;
    const LanguageModel = safe(() => globalThis.LanguageModel, null);
    if (
      typeof LanguageModel !== 'function' ||
      typeof LanguageModel.availability !== 'function' ||
      typeof LanguageModel.create !== 'function'
    ) {
      return {
        ok: false,
        reason: 'prompt-api-missing'
      };
    }

    let availability = 'unavailable';
    try {
      availability = await LanguageModel.availability(sessionOptions);
    } catch (error) {
      return {
        ok: false,
        reason: 'prompt-api-availability-failed',
        errorName: error && error.name ? error.name : '',
        errorMessage: error && error.message ? error.message : ''
      };
    }

    if (availability !== 'available') {
      return {
        ok: false,
        reason: 'prompt-api-' + availability,
        availability
      };
    }

    try {
      const session = await LanguageModel.create(sessionOptions);
      return {
        ok: true,
        availability,
        session
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'prompt-api-create-failed',
        availability,
        errorName: error && error.name ? error.name : '',
        errorMessage: error && error.message ? error.message : ''
      };
    }
  }

  function destroyPromptSessionRecord(record) {
    const session = record && record.session ? record.session : null;
    if (session && typeof session.destroy === 'function') {
      try {
        session.destroy();
      } catch (_error) {
        // Ignore session disposal errors; a later prepare call can create a fresh session.
      }
    }
  }

  async function prepareAutoSegmentTextRedistributionSession() {
    const model = await getPromptApiLanguageModel();
    if (!model || !model.ok || !model.session) {
      return model || { ok: false, reason: 'prompt-api-unavailable' };
    }

    promptSessionCounter += 1;
    const sessionId = 'auto-segment-prompt-' + Date.now() + '-' + promptSessionCounter;
    promptSessions.set(sessionId, {
      session: model.session,
      createdAt: Date.now()
    });

    return {
      ok: true,
      sessionId,
      availability: model.availability
    };
  }

  function destroyAutoSegmentTextRedistributionSession(payload) {
    const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId) {
      return {
        ok: false,
        reason: 'missing-session-id'
      };
    }

    const record = promptSessions.get(sessionId);
    if (record) {
      destroyPromptSessionRecord(record);
      promptSessions.delete(sessionId);
    }

    return {
      ok: true,
      destroyed: Boolean(record)
    };
  }

  function normalizeAutoSegmentPromptText(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  }

  function normalizeAutoSegmentPromptSegment(segment, index) {
    const id = segment && typeof segment.id === 'string' ? segment.id.trim() : '';
    const speakerKey = segment && typeof segment.speakerKey === 'string' ? segment.speakerKey.trim() : '';
    const startSeconds = Number(segment && segment.startSeconds);
    const endSeconds = Number(segment && segment.endSeconds);
    if (!id || !speakerKey || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return {
      id,
      index,
      speakerKey,
      startSeconds,
      endSeconds,
      text: normalizeAutoSegmentPromptText(segment.text)
    };
  }

  function normalizeAutoSegmentPromptAllocation(allocation) {
    const id = allocation && typeof allocation.id === 'string' ? allocation.id.trim() : '';
    if (!id || typeof allocation.text !== 'string') {
      return null;
    }
    return {
      id,
      text: normalizeAutoSegmentPromptText(allocation.text)
    };
  }

  function normalizeAutoSegmentPromptGroup(payload) {
    const speakerKey = payload && typeof payload.speakerKey === 'string' ? payload.speakerKey.trim() : '';
    const rawSegments = payload && Array.isArray(payload.segments) ? payload.segments : [];
    const fullText = normalizeAutoSegmentPromptText(payload && payload.fullText);
    const rawDraftAllocations = payload && Array.isArray(payload.draftAllocations) ? payload.draftAllocations : [];
    if (!speakerKey || rawSegments.length < 2) {
      return null;
    }

    const segments = rawSegments
      .map((segment, index) => normalizeAutoSegmentPromptSegment(segment, index))
      .filter(Boolean)
      .filter((segment) => segment.speakerKey === speakerKey);
    if (segments.length !== rawSegments.length || segments.length < 2) {
      return null;
    }

    const draftAllocations = rawDraftAllocations
      .map((allocation) => normalizeAutoSegmentPromptAllocation(allocation))
      .filter(Boolean);
    if (draftAllocations.length !== segments.length) {
      return null;
    }

    for (let index = 0; index < segments.length; index += 1) {
      if (draftAllocations[index].id !== segments[index].id) {
        return null;
      }
    }

    return {
      speakerKey,
      fullText,
      draftAllocations,
      segments
    };
  }

  function getAutoSegmentPromptReviewSchema() {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['acceptDraft', 'moves', 'notes'],
      properties: {
        acceptDraft: { type: 'boolean' },
        notes: { type: 'string' },
        moves: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['fromIndex', 'toIndex', 'sentenceCount'],
            properties: {
              fromIndex: { type: 'number' },
              toIndex: { type: 'number' },
              sentenceCount: { type: 'number' }
            }
          }
        }
      }
    };
  }

  function selectAutoSegmentPromptAudioSampleIndexes(segments) {
    const limit = Math.min(AUTO_SEGMENT_PROMPT_MAX_AUDIO_SAMPLES, segments.length);
    const indexes = new Set();
    if (!limit) {
      return [];
    }

    indexes.add(0);
    indexes.add(segments.length - 1);

    let seed = segments.reduce((value, segment) => {
      const text = segment.id + ':' + segment.startSeconds + ':' + segment.endSeconds;
      for (let index = 0; index < text.length; index += 1) {
        value = ((value << 5) - value + text.charCodeAt(index)) >>> 0;
      }
      return value >>> 0;
    }, 2166136261);

    while (indexes.size < limit) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      indexes.add(seed % segments.length);
    }

    return Array.from(indexes).sort((left, right) => left - right);
  }

  function createAutoSegmentPromptAudioBuffer(decoded, segment, maxAudioSeconds = AUTO_SEGMENT_PROMPT_MAX_AUDIO_SECONDS) {
    if (!decoded || !decoded.audio || !Array.isArray(decoded.channels) || !decoded.channels.length) {
      return null;
    }

    const AudioContextCtor = safe(() => window.AudioContext || window.webkitAudioContext, null);
    if (typeof AudioContextCtor !== 'function') {
      return null;
    }

    const sourceDuration = Number(decoded.audio.duration) || 0;
    const sourceLength = Number(decoded.audio.length) || decoded.channels[0].length || 0;
    const sourceSampleRate = Math.max(1, Number(decoded.audio.sampleRate) || 44100);
    if (!(sourceDuration > 0) || !(sourceLength > 1)) {
      return null;
    }

    let startSeconds = clamp(Number(segment.startSeconds) || 0, 0, sourceDuration);
    let endSeconds = clamp(Number(segment.endSeconds) || 0, 0, sourceDuration);
    if (!(endSeconds > startSeconds)) {
      return null;
    }

    const safeMaxAudioSeconds =
      maxAudioSeconds === null
        ? Infinity
        : Number.isFinite(Number(maxAudioSeconds)) && Number(maxAudioSeconds) > 0
          ? Number(maxAudioSeconds)
          : AUTO_SEGMENT_PROMPT_MAX_AUDIO_SECONDS;
    if (Number.isFinite(safeMaxAudioSeconds) && endSeconds - startSeconds > safeMaxAudioSeconds) {
      const centerSeconds = (startSeconds + endSeconds) / 2;
      startSeconds = clamp(centerSeconds - safeMaxAudioSeconds / 2, 0, sourceDuration);
      endSeconds = clamp(startSeconds + safeMaxAudioSeconds, 0, sourceDuration);
      startSeconds = clamp(endSeconds - safeMaxAudioSeconds, 0, sourceDuration);
    }

    const startIndex = clamp(Math.floor((startSeconds / sourceDuration) * sourceLength), 0, sourceLength - 1);
    const endIndex = clamp(Math.ceil((endSeconds / sourceDuration) * sourceLength), startIndex + 1, sourceLength);
    const frameCount = endIndex - startIndex;
    if (!(frameCount > 0)) {
      return null;
    }

    const context = new AudioContextCtor();
    const channelCount = Math.min(2, decoded.channels.length);
    const buffer = context.createBuffer(channelCount, frameCount, sourceSampleRate);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const source = decoded.channels[channelIndex] || decoded.channels[0];
      const target = buffer.getChannelData(channelIndex);
      for (let index = 0; index < frameCount; index += 1) {
        target[index] = Number(source[startIndex + index]) || 0;
      }
    }
    safe(() => context.close(), null);

    return buffer;
  }

  function collectAutoSegmentPromptAudioSamples(group) {
    const resolved = resolveWaveForVisibleSpeaker(group.speakerKey);
    if (!resolved.wave || !isUsableWaveCandidate(resolved.wave, resolved.host)) {
      return [];
    }

    const wave = resolved.wave;
    const decoded = getDecodedAudioChannelsForTrim(wave);
    if (!decoded) {
      return [];
    }

    const samples = [];
    for (const index of selectAutoSegmentPromptAudioSampleIndexes(group.segments)) {
      const segment = group.segments[index];
      const audioBuffer = createAutoSegmentPromptAudioBuffer(decoded, segment);
      if (audioBuffer) {
        samples.push({
          id: segment.id,
          index,
          audioBuffer
        });
      }
    }

    return samples;
  }

  function buildAutoSegmentPromptMessages(group, audioSamples) {
    const rowLines = group.segments
      .map((segment, index) =>
        [
          'index=' + (index + 1),
          'id=' + segment.id,
          'start=' + segment.startSeconds.toFixed(3),
          'end=' + segment.endSeconds.toFixed(3),
          'draftText=' + JSON.stringify(group.draftAllocations[index].text)
        ].join(' | ')
      )
      .join('\n');
    const sampledIds = audioSamples.map((sample) => sample.id).join(', ') || 'none';
    const content = [
      {
        type: 'text',
        value:
          'Speaker key: ' + group.speakerKey + '\n' +
          'Rows are same-speaker transcript segments after automatic audio cuts. The draft split was produced deterministically from the exact baseline transcript and segment durations.\n\n' +
          'Rules:\n' +
          '- If the draft is plausible, return acceptDraft true and moves [].\n' +
          '- Do not return transcript text.\n' +
          '- Do not rewrite, correct, translate, deduplicate, invent, or remove words.\n' +
          '- If a sampled boundary is clearly wrong, move only whole sentences between adjacent one-based row indexes.\n' +
          '- If unsure, accept the draft.\n\n' +
          'Exact baseline transcript, for reference only:\n' + group.fullText + '\n\n' +
          'Draft rows:\n' + rowLines + '\n\n' +
          'Audio samples are attached for these row ids: ' + sampledIds + '.'
      }
    ];

    for (const sample of audioSamples) {
      content.push({
        type: 'text',
        value: 'Audio sample for row id ' + sample.id + '.'
      });
      content.push({
        type: 'audio',
        value: sample.audioBuffer
      });
    }

    return [
      {
        role: 'user',
        content
      }
    ];
  }

  function parseAutoSegmentPromptResponse(response) {
    if (response && typeof response === 'object' && typeof response.acceptDraft === 'boolean' && Array.isArray(response.moves)) {
      return response;
    }

    if (typeof response !== 'string') {
      return null;
    }

    try {
      return JSON.parse(response);
    } catch (_error) {
      return null;
    }
  }

  function validateAutoSegmentPromptReview(group, review) {
    if (!review || typeof review.acceptDraft !== 'boolean' || !Array.isArray(review.moves)) {
      return false;
    }

    for (const move of review.moves) {
      const fromIndex = Math.round(Number(move && move.fromIndex));
      const toIndex = Math.round(Number(move && move.toIndex));
      const sentenceCount = Math.round(Number(move && move.sentenceCount));
      if (
        !Number.isInteger(fromIndex) ||
        !Number.isInteger(toIndex) ||
        Math.abs(fromIndex - toIndex) !== 1 ||
        fromIndex < 1 ||
        toIndex < 1 ||
        fromIndex > group.segments.length ||
        toIndex > group.segments.length ||
        !Number.isInteger(sentenceCount) ||
        sentenceCount < 1
      ) {
        return false;
      }
    }

    return true;
  }

  async function redistributeAutoSegmentText(payload) {
    const group = normalizeAutoSegmentPromptGroup(payload);
    if (!group) {
      return {
        ok: false,
        reason: 'invalid-group'
      };
    }

    const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : '';
    let record = sessionId ? promptSessions.get(sessionId) : null;
    let shouldDestroy = false;
    if (!record) {
      const model = await getPromptApiLanguageModel();
      if (!model || !model.ok || !model.session) {
        return model || { ok: false, reason: 'prompt-api-unavailable' };
      }
      record = { session: model.session };
      shouldDestroy = true;
    }

    const session = record.session;
    try {
      const audioSamples = collectAutoSegmentPromptAudioSamples(group);
      const responseConstraint = getAutoSegmentPromptReviewSchema();
      const response = await session.prompt(buildAutoSegmentPromptMessages(group, audioSamples), {
        responseConstraint
      });
      const parsed = parseAutoSegmentPromptResponse(response);
      if (!validateAutoSegmentPromptReview(group, parsed)) {
        return {
          ok: false,
          reason: 'invalid-prompt-review'
        };
      }

      return {
        ok: true,
        review: {
          acceptDraft: parsed.acceptDraft,
          moves: parsed.moves,
          notes: typeof parsed.notes === 'string' ? parsed.notes : ''
        },
        audioSampleCount: audioSamples.length
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'prompt-api-prompt-failed',
        errorName: error && error.name ? error.name : '',
        errorMessage: error && error.message ? error.message : ''
      };
    } finally {
      if (shouldDestroy) {
        destroyPromptSessionRecord(record);
      }
    }
  }

  function getSegmentTranscriptionPromptSchema() {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string' }
      }
    };
  }

  function buildSegmentTranscriptionPromptMessages(audioBuffer) {
    return [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            value: 'Напиши точный текст, сказанный в аудио. Верни только расшифровку без пояснений.'
          },
          {
            type: 'audio',
            value: audioBuffer
          }
        ]
      }
    ];
  }

  function parseSegmentTranscriptionPromptResponse(response) {
    if (response && typeof response === 'object' && typeof response.text === 'string') {
      return response.text;
    }

    if (typeof response !== 'string') {
      return '';
    }

    try {
      const parsed = JSON.parse(response);
      if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
        return parsed.text;
      }
    } catch (_error) {
      // Plain text responses are acceptable for this one-shot transcription helper.
    }

    return response;
  }

  function appendPromptStreamChunk(text, chunk) {
    const current = typeof text === 'string' ? text : '';
    const next = typeof chunk === 'string' ? chunk : chunk == null ? '' : String(chunk);
    if (!next) {
      return current;
    }
    if (next.indexOf(current) === 0) {
      return next;
    }
    return current + next;
  }

  function estimateSegmentTranscriptionCharCount(audioDurationSeconds) {
    const duration = Math.max(1, Number(audioDurationSeconds) || 1);
    return Math.max(80, Math.round(duration * 12));
  }

  function emitSegmentTranscriptionProgress(onProgress, progress) {
    if (typeof onProgress !== 'function') {
      return;
    }

    try {
      onProgress(progress);
    } catch (_error) {
      // Progress updates are best-effort; the final bridge response still matters.
    }
  }

  async function transcribeSegmentAudio(payload, onProgress) {
    const speakerKey = payload && typeof payload.speakerKey === 'string' ? payload.speakerKey.trim() : '';
    const hostMarker = payload && typeof payload.hostMarker === 'string' ? payload.hostMarker : '';
    const startSeconds = Number(payload && payload.startSeconds);
    const endSeconds = Number(payload && payload.endSeconds);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return {
        ok: false,
        reason: 'invalid-segment-range'
      };
    }

    let resolved = resolveWaveForHost(hostMarker);
    if (
      !resolved.wave ||
      !isUsableWaveCandidate(resolved.wave, resolved.host) ||
      !hostMatchesSpeaker(resolved.host, speakerKey)
    ) {
      resolved = resolveWaveForVisibleSpeaker(speakerKey);
    }

    const wave = resolved.wave;
    if (!wave || !isUsableWaveCandidate(wave, resolved.host)) {
      return {
        ok: false,
        reason: 'missing-speaker-audio'
      };
    }

    const decoded = getDecodedAudioChannelsForTrim(wave);
    if (!decoded) {
      return {
        ok: false,
        reason: 'missing-decoded-audio'
      };
    }

    const segment = {
      startSeconds,
      endSeconds
    };
    emitSegmentTranscriptionProgress(onProgress, {
      phase: 'preparing-audio',
      percent: 5,
      audioDurationSeconds: endSeconds - startSeconds
    });
    const audioBuffer = createAutoSegmentPromptAudioBuffer(decoded, segment, null);
    if (!audioBuffer) {
      return {
        ok: false,
        reason: 'missing-audio-sample'
      };
    }

    const audioDurationSeconds = Number(audioBuffer.duration) || endSeconds - startSeconds;
    const estimatedCharCount = estimateSegmentTranscriptionCharCount(audioDurationSeconds);
    emitSegmentTranscriptionProgress(onProgress, {
      phase: 'starting-model',
      percent: 15,
      audioDurationSeconds,
      generatedCharCount: 0,
      estimatedCharCount
    });

    const model = await getPromptApiLanguageModel(AUTO_SEGMENT_TRANSCRIBE_SESSION_OPTIONS);
    if (!model || !model.ok || !model.session) {
      return model || { ok: false, reason: 'prompt-api-unavailable' };
    }

    const session = model.session;
    try {
      let text = '';
      if (typeof session.promptStreaming === 'function') {
        emitSegmentTranscriptionProgress(onProgress, {
          phase: 'transcribing',
          percent: 20,
          audioDurationSeconds,
          generatedCharCount: 0,
          estimatedCharCount
        });
        const stream = session.promptStreaming(buildSegmentTranscriptionPromptMessages(audioBuffer));
        for await (const chunk of stream) {
          text = appendPromptStreamChunk(text, chunk);
          const generatedCharCount = normalizeAutoSegmentPromptText(text).length;
          const percent = Math.min(
            95,
            20 + Math.round((generatedCharCount / Math.max(estimatedCharCount, 1)) * 75)
          );
          emitSegmentTranscriptionProgress(onProgress, {
            phase: 'transcribing',
            percent,
            audioDurationSeconds,
            generatedCharCount: normalizeAutoSegmentPromptText(text).length,
            estimatedCharCount
          });
        }
      } else {
        const responseConstraint = getSegmentTranscriptionPromptSchema();
        const response = await session.prompt(buildSegmentTranscriptionPromptMessages(audioBuffer), {
          responseConstraint
        });
        text = parseSegmentTranscriptionPromptResponse(response);
        emitSegmentTranscriptionProgress(onProgress, {
          phase: 'transcribing',
          percent: 95,
          audioDurationSeconds,
          generatedCharCount: normalizeAutoSegmentPromptText(text).length,
          estimatedCharCount
        });
      }

      text = normalizeAutoSegmentPromptText(text);
      if (!text) {
        return {
          ok: false,
          reason: 'empty-transcription'
        };
      }

      return {
        ok: true,
        text,
        speakerKey,
        startSeconds,
        endSeconds,
        audioDurationSeconds,
        availability: model.availability
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'prompt-api-transcription-failed',
        errorName: error && error.name ? error.name : '',
        errorMessage: error && error.message ? error.message : ''
      };
    } finally {
      if (session && typeof session.destroy === 'function') {
        session.destroy();
      }
    }
  }

  function indexToSeconds(index, length, duration) {
    if (!(duration > 0) || !(length > 1) || !Number.isFinite(index)) {
      return 0;
    }

    return clamp((index / (length - 1)) * duration, 0, duration);
  }

  function findFirstAboveThresholdInArray(values, startIndex, endIndexExclusive, threshold) {
    if (!values || !values.length) {
      return -1;
    }

    const from = clamp(Math.floor(startIndex), 0, values.length);
    const to = clamp(Math.ceil(endIndexExclusive), 0, values.length);
    for (let index = from; index < to; index += 1) {
      if (Math.abs(Number(values[index]) || 0) >= threshold) {
        return index;
      }
    }

    return -1;
  }

  function findLastAboveThresholdInArray(values, startIndex, endIndexExclusive, threshold) {
    if (!values || !values.length) {
      return -1;
    }

    const from = clamp(Math.floor(startIndex), 0, values.length - 1);
    const to = clamp(Math.ceil(endIndexExclusive), 0, values.length);
    for (let index = to - 1; index >= from; index -= 1) {
      if (Math.abs(Number(values[index]) || 0) >= threshold) {
        return index;
      }
    }

    return -1;
  }

  function findFirstAboveThresholdInChannels(channels, startIndex, endIndexExclusive, threshold) {
    if (!Array.isArray(channels) || !channels.length) {
      return -1;
    }

    const maxLen = Math.max(...channels.map((channel) => (channel && channel.length ? channel.length : 0)));
    if (!(maxLen > 0)) {
      return -1;
    }

    const from = clamp(Math.floor(startIndex), 0, maxLen);
    const to = clamp(Math.ceil(endIndexExclusive), 0, maxLen);
    for (let index = from; index < to; index += 1) {
      for (const channel of channels) {
        if (Math.abs(Number(channel[index]) || 0) >= threshold) {
          return index;
        }
      }
    }

    return -1;
  }

  function findLastAboveThresholdInChannels(channels, startIndex, endIndexExclusive, threshold) {
    if (!Array.isArray(channels) || !channels.length) {
      return -1;
    }

    const maxLen = Math.max(...channels.map((channel) => (channel && channel.length ? channel.length : 0)));
    if (!(maxLen > 0)) {
      return -1;
    }

    const from = clamp(Math.floor(startIndex), 0, maxLen - 1);
    const to = clamp(Math.ceil(endIndexExclusive), 0, maxLen);
    for (let index = to - 1; index >= from; index -= 1) {
      for (const channel of channels) {
        if (Math.abs(Number(channel[index]) || 0) >= threshold) {
          return index;
        }
      }
    }

    return -1;
  }

  function isSilentInChannels(channels, index, threshold) {
    for (const channel of channels) {
      if (Math.abs(Number(channel[index]) || 0) >= threshold) {
        return false;
      }
    }

    return true;
  }

  function isSilentBlockInChannels(channels, startIndex, endIndexExclusive, threshold) {
    if (!Array.isArray(channels) || !channels.length) {
      return false;
    }

    const maxLen = Math.max(...channels.map((channel) => (channel && channel.length ? channel.length : 0)));
    if (!(maxLen > 0)) {
      return false;
    }

    const from = clamp(Math.floor(startIndex), 0, maxLen);
    const to = clamp(Math.ceil(endIndexExclusive), 0, maxLen);
    if (to <= from) {
      return false;
    }

    for (let index = from; index < to; index += 1) {
      if (!isSilentInChannels(channels, index, threshold)) {
        return false;
      }
    }

    return true;
  }

  function findPreviousSilenceInChannels(channels, startIndex, threshold, stepSamples = 1) {
    if (!Array.isArray(channels) || !channels.length) {
      return -1;
    }

    const maxLen = Math.max(...channels.map((channel) => (channel && channel.length ? channel.length : 0)));
    if (!(maxLen > 0)) {
      return -1;
    }

    const step = Math.max(1, Math.floor(Number(stepSamples) || 1));
    for (let index = clamp(Math.floor(startIndex), 0, maxLen - 1); index >= 0; index -= step) {
      const blockStart = Math.max(0, index - step + 1);
      const blockEndExclusive = index + 1;
      if (isSilentBlockInChannels(channels, blockStart, blockEndExclusive, threshold)) {
        return index;
      }
    }

    return -1;
  }

  function findNextSilenceInChannels(channels, startIndex, threshold, stepSamples = 1) {
    if (!Array.isArray(channels) || !channels.length) {
      return -1;
    }

    const maxLen = Math.max(...channels.map((channel) => (channel && channel.length ? channel.length : 0)));
    if (!(maxLen > 0)) {
      return -1;
    }

    const step = Math.max(1, Math.floor(Number(stepSamples) || 1));
    for (let index = clamp(Math.ceil(startIndex), 0, maxLen - 1); index < maxLen; index += step) {
      const blockEndExclusive = Math.min(maxLen, index + step);
      if (isSilentBlockInChannels(channels, index, blockEndExclusive, threshold)) {
        return index;
      }
    }

    return -1;
  }

  function isSilentBlockInArray(values, startIndex, endIndexExclusive, threshold) {
    if (!values || !values.length) {
      return false;
    }

    const from = clamp(Math.floor(startIndex), 0, values.length);
    const to = clamp(Math.ceil(endIndexExclusive), 0, values.length);
    if (to <= from) {
      return false;
    }

    for (let index = from; index < to; index += 1) {
      if (Math.abs(Number(values[index]) || 0) >= threshold) {
        return false;
      }
    }

    return true;
  }

  function findPreviousSilenceInArray(values, startIndex, threshold, stepSamples = 1) {
    if (!values || !values.length) {
      return -1;
    }

    const step = Math.max(1, Math.floor(Number(stepSamples) || 1));
    for (let index = clamp(Math.floor(startIndex), 0, values.length - 1); index >= 0; index -= step) {
      const blockStart = Math.max(0, index - step + 1);
      const blockEndExclusive = index + 1;
      if (isSilentBlockInArray(values, blockStart, blockEndExclusive, threshold)) {
        return index;
      }
    }

    return -1;
  }

  function findNextSilenceInArray(values, startIndex, threshold, stepSamples = 1) {
    if (!values || !values.length) {
      return -1;
    }

    const step = Math.max(1, Math.floor(Number(stepSamples) || 1));
    for (let index = clamp(Math.ceil(startIndex), 0, values.length - 1); index < values.length; index += step) {
      const blockEndExclusive = Math.min(values.length, index + step);
      if (isSilentBlockInArray(values, index, blockEndExclusive, threshold)) {
        return index;
      }
    }

    return -1;
  }

  function buildSilenceRunsFromPredicate(startIndex, endIndexExclusive, indexToSecondsValue, isSilentAtIndex, minimumSilenceSeconds) {
    const runs = [];
    const from = Math.max(0, Math.floor(Number(startIndex) || 0));
    const to = Math.max(from, Math.ceil(Number(endIndexExclusive) || 0));
    const minimumDuration = Math.max(0, Number(minimumSilenceSeconds) || 0);
    let runStartIndex = -1;

    const finishRun = (endIndex) => {
      if (runStartIndex < 0) {
        return;
      }

      const startSeconds = indexToSecondsValue(runStartIndex);
      const endSeconds = indexToSecondsValue(endIndex);
      const durationSeconds = endSeconds - startSeconds;
      if (
        Number.isFinite(startSeconds) &&
        Number.isFinite(endSeconds) &&
        durationSeconds >= minimumDuration
      ) {
        runs.push({
          startSeconds,
          endSeconds,
          durationSeconds,
          splitSeconds: (startSeconds + endSeconds) / 2
        });
      }

      runStartIndex = -1;
    };

    for (let index = from; index < to; index += 1) {
      if (isSilentAtIndex(index)) {
        if (runStartIndex < 0) {
          runStartIndex = index;
        }
      } else {
        finishRun(index);
      }
    }

    finishRun(to);
    return runs;
  }

  function hasRegionCoveringTime(regions, caretSeconds) {
    if (!Array.isArray(regions) || !Number.isFinite(caretSeconds)) {
      return false;
    }

    return regions.some((region) => region.start <= caretSeconds && region.end >= caretSeconds);
  }

  function hasRegionOverlap(regions, targetStartSeconds, targetEndSeconds) {
    if (!Array.isArray(regions) || !Number.isFinite(targetStartSeconds) || !Number.isFinite(targetEndSeconds)) {
      return false;
    }

    return regions.some(
      (region) =>
        Math.min(region.end, targetEndSeconds) - Math.max(region.start, targetStartSeconds) > 0.01
    );
  }

  function getDirectionalNearestSpeechIslandScanLimits(regions, searchStart, searchEnd, caretSeconds) {
    let leftStopSeconds = searchStart;
    let rightStopSeconds = searchEnd;

    if (Array.isArray(regions) && Number.isFinite(caretSeconds)) {
      for (const region of regions) {
        const regionStart = Number(region && region.start);
        const regionEnd = Number(region && region.end);
        if (!Number.isFinite(regionStart) || !Number.isFinite(regionEnd) || regionEnd <= regionStart) {
          continue;
        }

        if (regionEnd <= caretSeconds && regionEnd > leftStopSeconds && regionStart < caretSeconds) {
          leftStopSeconds = clamp(regionEnd, searchStart, caretSeconds);
        }

        if (regionStart >= caretSeconds && regionStart < rightStopSeconds && regionEnd > caretSeconds) {
          rightStopSeconds = clamp(regionStart, caretSeconds, searchEnd);
        }
      }
    }

    return {
      leftSearchStartSeconds: leftStopSeconds,
      rightSearchEndSeconds: rightStopSeconds
    };
  }

  function chooseNearestDirectionalSpeechIsland(leftCandidate, rightCandidate, caretSeconds) {
    if (!leftCandidate) {
      return rightCandidate || null;
    }

    if (!rightCandidate) {
      return leftCandidate;
    }

    const leftSeconds = Number(leftCandidate.foundSeconds);
    const rightSeconds = Number(rightCandidate.foundSeconds);
    const leftDistance = Number.isFinite(leftSeconds) ? Math.abs(leftSeconds - caretSeconds) : Infinity;
    const rightDistance = Number.isFinite(rightSeconds) ? Math.abs(rightSeconds - caretSeconds) : Infinity;
    return leftDistance <= rightDistance ? leftCandidate : rightCandidate;
  }

  function normalizeNearestSpeechIslandRange(detectedStartSeconds, detectedEndSeconds, centerSeconds, searchStart, searchEnd, paddingSeconds) {
    const padding = clamp(Number(paddingSeconds) || 0, 0, 1);
    const minimumDuration = 0.03;
    let targetStartSeconds = clamp(detectedStartSeconds - padding, searchStart, searchEnd);
    let targetEndSeconds = clamp(detectedEndSeconds + padding, searchStart, searchEnd);
    const center = clamp(Number(centerSeconds) || detectedStartSeconds, searchStart, searchEnd);

    if (!(targetEndSeconds > targetStartSeconds)) {
      targetStartSeconds = clamp(center - minimumDuration / 2, searchStart, searchEnd);
      targetEndSeconds = clamp(center + minimumDuration / 2, searchStart, searchEnd);
    }

    if (targetEndSeconds - targetStartSeconds < minimumDuration) {
      const half = minimumDuration / 2;
      targetStartSeconds = clamp(center - half, searchStart, searchEnd);
      targetEndSeconds = clamp(center + half, searchStart, searchEnd);
      if (targetStartSeconds <= searchStart) {
        targetEndSeconds = clamp(targetStartSeconds + minimumDuration, searchStart, searchEnd);
      } else if (targetEndSeconds >= searchEnd) {
        targetStartSeconds = clamp(targetEndSeconds - minimumDuration, searchStart, searchEnd);
      }
    }

    if (!(targetEndSeconds > targetStartSeconds)) {
      return null;
    }

    return {
      targetStartSeconds,
      targetEndSeconds
    };
  }

  function buildNearestSpeechIslandInArrayCandidate(values, foundIndex, searchStart, searchEnd, duration, threshold, paddingSeconds, direction) {
    const startLimit = clamp(Math.floor((searchStart / duration) * (values.length - 1)), 0, values.length - 1);
    const endLimit = clamp(Math.ceil((searchEnd / duration) * (values.length - 1) + 1) - 1, 0, values.length - 1);
    let leftBoundary = foundIndex;
    while (
      leftBoundary > startLimit &&
      Math.abs(Number(values[leftBoundary - 1]) || 0) >= threshold
    ) {
      leftBoundary -= 1;
    }

    let rightBoundary = foundIndex;
    while (
      rightBoundary < endLimit &&
      Math.abs(Number(values[rightBoundary + 1]) || 0) >= threshold
    ) {
      rightBoundary += 1;
    }

    const detectedStartSeconds = clamp(indexToSeconds(leftBoundary, values.length, duration), searchStart, searchEnd);
    const detectedEndSeconds = clamp(indexToSeconds(rightBoundary, values.length, duration), searchStart, searchEnd);
    const foundSeconds = indexToSeconds(foundIndex, values.length, duration);
    const range = normalizeNearestSpeechIslandRange(
      detectedStartSeconds,
      detectedEndSeconds,
      foundSeconds,
      searchStart,
      searchEnd,
      paddingSeconds
    );
    if (!range) {
      return null;
    }

    return {
      direction,
      foundIndex,
      foundSeconds,
      detectedStartSeconds,
      detectedEndSeconds,
      ...range
    };
  }

  function findNearestSpeechIslandInArray(values, searchStart, searchEnd, caretSeconds, duration, threshold, paddingSeconds, scanLimits) {
    if (!values || values.length <= 1 || !(duration > 0)) {
      return null;
    }

    const leftSearchStartSeconds =
      scanLimits && Number.isFinite(Number(scanLimits.leftSearchStartSeconds))
        ? clamp(Number(scanLimits.leftSearchStartSeconds), searchStart, caretSeconds)
        : searchStart;
    const rightSearchEndSeconds =
      scanLimits && Number.isFinite(Number(scanLimits.rightSearchEndSeconds))
        ? clamp(Number(scanLimits.rightSearchEndSeconds), caretSeconds, searchEnd)
        : searchEnd;
    const openSearchStart = clamp(leftSearchStartSeconds, searchStart, caretSeconds);
    const openSearchEnd = clamp(rightSearchEndSeconds, caretSeconds, searchEnd);
    if (!(openSearchEnd > openSearchStart)) {
      return null;
    }

    const caretIndex = (caretSeconds / duration) * (values.length - 1);
    const leftStartIndex = (openSearchStart / duration) * (values.length - 1);
    const rightEndIndexExclusive = (openSearchEnd / duration) * (values.length - 1) + 1;
    const leftIndex =
      openSearchStart < caretSeconds
        ? findLastAboveThresholdInArray(values, leftStartIndex, caretIndex + 1, threshold)
        : -1;
    const rightIndex =
      openSearchEnd > caretSeconds
        ? findFirstAboveThresholdInArray(values, caretIndex, rightEndIndexExclusive, threshold)
        : -1;
    const leftCandidate =
      leftIndex >= 0
        ? buildNearestSpeechIslandInArrayCandidate(
            values,
            leftIndex,
            openSearchStart,
            openSearchEnd,
            duration,
            threshold,
            paddingSeconds,
            'left'
          )
        : null;
    const rightCandidate =
      rightIndex >= 0
        ? buildNearestSpeechIslandInArrayCandidate(
            values,
            rightIndex,
            openSearchStart,
            openSearchEnd,
            duration,
            threshold,
            paddingSeconds,
            'right'
          )
        : null;
    return chooseNearestDirectionalSpeechIsland(leftCandidate, rightCandidate, caretSeconds);
  }

  function buildNearestSpeechIslandInChannelsCandidate(channels, foundIndex, sampleLength, sampleRate, searchStart, searchEnd, threshold, paddingSeconds, direction) {
    const startLimit = clamp(Math.floor(searchStart * sampleRate), 0, sampleLength - 1);
    const endLimit = clamp(Math.ceil(searchEnd * sampleRate) - 1, 0, sampleLength - 1);
    let leftBoundary = foundIndex;
    while (leftBoundary > startLimit && !isSilentInChannels(channels, leftBoundary - 1, threshold)) {
      leftBoundary -= 1;
    }

    let rightBoundary = foundIndex;
    while (rightBoundary < endLimit && !isSilentInChannels(channels, rightBoundary + 1, threshold)) {
      rightBoundary += 1;
    }

    const detectedStartSeconds = clamp(leftBoundary / sampleRate, searchStart, searchEnd);
    const detectedEndSeconds = clamp(rightBoundary / sampleRate, searchStart, searchEnd);
    const foundSeconds = foundIndex / sampleRate;
    const range = normalizeNearestSpeechIslandRange(
      detectedStartSeconds,
      detectedEndSeconds,
      foundSeconds,
      searchStart,
      searchEnd,
      paddingSeconds
    );
    if (!range) {
      return null;
    }

    return {
      direction,
      foundIndex,
      foundSeconds,
      detectedStartSeconds,
      detectedEndSeconds,
      ...range
    };
  }

  function findNearestSpeechIslandInChannels(channels, sampleLength, sampleRate, searchStart, searchEnd, caretSeconds, threshold, paddingSeconds, scanLimits) {
    if (!Array.isArray(channels) || !channels.length || !(sampleLength > 1) || !(sampleRate > 0)) {
      return null;
    }

    const leftSearchStartSeconds =
      scanLimits && Number.isFinite(Number(scanLimits.leftSearchStartSeconds))
        ? clamp(Number(scanLimits.leftSearchStartSeconds), searchStart, caretSeconds)
        : searchStart;
    const rightSearchEndSeconds =
      scanLimits && Number.isFinite(Number(scanLimits.rightSearchEndSeconds))
        ? clamp(Number(scanLimits.rightSearchEndSeconds), caretSeconds, searchEnd)
        : searchEnd;
    const openSearchStart = clamp(leftSearchStartSeconds, searchStart, caretSeconds);
    const openSearchEnd = clamp(rightSearchEndSeconds, caretSeconds, searchEnd);
    if (!(openSearchEnd > openSearchStart)) {
      return null;
    }

    const caretIndex = caretSeconds * sampleRate;
    const leftStartIndex = openSearchStart * sampleRate;
    const rightEndIndexExclusive = openSearchEnd * sampleRate;
    const leftIndex =
      openSearchStart < caretSeconds
        ? findLastAboveThresholdInChannels(channels, leftStartIndex, caretIndex + 1, threshold)
        : -1;
    const rightIndex =
      openSearchEnd > caretSeconds
        ? findFirstAboveThresholdInChannels(channels, caretIndex, rightEndIndexExclusive, threshold)
        : -1;
    const leftCandidate =
      leftIndex >= 0
        ? buildNearestSpeechIslandInChannelsCandidate(
            channels,
            leftIndex,
            sampleLength,
            sampleRate,
            openSearchStart,
            openSearchEnd,
            threshold,
            paddingSeconds,
            'left'
          )
        : null;
    const rightCandidate =
      rightIndex >= 0
        ? buildNearestSpeechIslandInChannelsCandidate(
            channels,
            rightIndex,
            sampleLength,
            sampleRate,
            openSearchStart,
            openSearchEnd,
            threshold,
            paddingSeconds,
            'right'
          )
        : null;
    return chooseNearestDirectionalSpeechIsland(leftCandidate, rightCandidate, caretSeconds);
  }

  function createNearestSpeechIslandResponse(base, source, nearest, regions) {
    const targetStartSeconds = nearest.targetStartSeconds;
    const targetEndSeconds = nearest.targetEndSeconds;
    if (hasRegionOverlap(regions, targetStartSeconds, targetEndSeconds)) {
      return {
        ...base,
        ok: true,
        foundAudio: false,
        skipped: true,
        reason: 'covered-candidate',
        source,
        detectedStartSeconds: nearest.detectedStartSeconds,
        detectedEndSeconds: nearest.detectedEndSeconds,
        targetStartSeconds,
        targetEndSeconds
      };
    }

    return {
      ...base,
      ok: true,
      foundAudio: true,
      skipped: false,
      source,
      detectedStartSeconds: nearest.detectedStartSeconds,
      detectedEndSeconds: nearest.detectedEndSeconds,
      targetStartSeconds,
      targetEndSeconds
    };
  }

  function findNearestSpeechIslandForResolvedWave(host, wave, caretSecondsInput, scanWindowSeconds, amplitudeThreshold, paddingSeconds) {
    if (!(host instanceof HTMLElement) || !wave || !isUsableWaveCandidate(wave, host)) {
      return {
        ok: false,
        reason: 'missing-wave'
      };
    }

    const duration = getDuration(wave);
    if (!(duration > 0)) {
      return {
        ok: false,
        reason: 'missing-duration'
      };
    }

    const rawCaretSeconds = Number(caretSecondsInput);
    const waveCurrentSeconds = Number(safe(() => wave.getCurrentTime(), 0));
    const caretSeconds = clamp(
      Number.isFinite(rawCaretSeconds) ? rawCaretSeconds : Number(waveCurrentSeconds) || 0,
      0,
      duration
    );
    const scanWindow = clamp(Number(scanWindowSeconds) || 1, 0.05, 5);
    const searchStart = clamp(caretSeconds - scanWindow, 0, duration);
    const searchEnd = clamp(caretSeconds + scanWindow, 0, duration);
    const base = {
      duration,
      caretSeconds,
      searchStartSeconds: searchStart,
      searchEndSeconds: searchEnd
    };
    if (!(searchEnd > searchStart)) {
      return {
        ...base,
        ok: false,
        reason: 'invalid-range'
      };
    }

    const regions = getSourceRegionEntries(wave);
    if (hasRegionCoveringTime(regions, caretSeconds)) {
      return {
        ...base,
        ok: true,
        foundAudio: false,
        skipped: true,
        reason: 'covered-at-caret'
      };
    }
    const scanLimits = getDirectionalNearestSpeechIslandScanLimits(regions, searchStart, searchEnd, caretSeconds);

    const threshold = Math.max(0, Number(amplitudeThreshold) || 0);
    const rawPeaks = getRawExportPeaks(wave);
    if (rawPeaks && rawPeaks.length > 1) {
      const nearest = findNearestSpeechIslandInArray(
        rawPeaks,
        searchStart,
        searchEnd,
        caretSeconds,
        duration,
        threshold,
        paddingSeconds,
        scanLimits
      );
      if (nearest) {
        return createNearestSpeechIslandResponse(base, 'export-peaks', nearest, regions);
      }

      return {
        ...base,
        ok: true,
        foundAudio: false,
        source: 'export-peaks'
      };
    }

    const decoded = getDecodedAudioChannelsForTrim(wave);
    if (decoded && decoded.audio.length > 1 && decoded.audio.duration > 0) {
      const sampleLength = decoded.audio.length;
      const sampleRate = Number(decoded.audio.sampleRate) || 1;
      const decodedSearchStart = clamp(searchStart, 0, decoded.audio.duration);
      const decodedSearchEnd = clamp(searchEnd, 0, decoded.audio.duration);
      const decodedCaret = clamp(caretSeconds, decodedSearchStart, decodedSearchEnd);
      const nearest = findNearestSpeechIslandInChannels(
        decoded.channels,
        sampleLength,
        sampleRate,
        decodedSearchStart,
        decodedSearchEnd,
        decodedCaret,
        threshold,
        paddingSeconds,
        scanLimits
      );
      if (nearest) {
        return createNearestSpeechIslandResponse(base, 'decoded-audio', nearest, regions);
      }

      return {
        ...base,
        ok: true,
        foundAudio: false,
        source: 'decoded-audio'
      };
    }

    return {
      ...base,
      ok: false,
      reason: 'missing-audio-data'
    };
  }

  function findSegmentSilenceRunsForResolvedWave(host, wave, startSeconds, endSeconds, amplitudeThreshold, minimumSilenceSeconds) {
    if (!(host instanceof HTMLElement) || !wave || !isUsableWaveCandidate(wave, host)) {
      return {
        ok: false,
        reason: 'missing-wave'
      };
    }

    const duration = getDuration(wave);
    const segmentStart = clamp(Number(startSeconds) || 0, 0, duration > 0 ? duration : Number(startSeconds) || 0);
    const segmentEnd = clamp(Number(endSeconds) || 0, 0, duration > 0 ? duration : Number(endSeconds) || 0);
    if (!(segmentEnd > segmentStart)) {
      return {
        ok: false,
        reason: 'invalid-range'
      };
    }

    const threshold = Math.max(0, Number(amplitudeThreshold) || 0);
    const rawPeaks = getRawExportPeaks(wave);
    if (rawPeaks && rawPeaks.length > 1 && duration > 0) {
      const startIndex = (segmentStart / duration) * (rawPeaks.length - 1);
      const endIndexExclusive = (segmentEnd / duration) * (rawPeaks.length - 1) + 1;
      const runs = buildSilenceRunsFromPredicate(
        startIndex,
        endIndexExclusive,
        (index) => clamp(indexToSeconds(index, rawPeaks.length, duration), segmentStart, segmentEnd),
        (index) => Math.abs(Number(rawPeaks[index]) || 0) < threshold,
        minimumSilenceSeconds
      );

      return {
        ok: true,
        duration,
        source: 'export-peaks',
        runs
      };
    }

    const decoded = getDecodedAudioChannelsForTrim(wave);
    if (decoded && decoded.audio.length > 1 && decoded.audio.duration > 0) {
      const sampleLength = decoded.audio.length;
      const sampleRate = Number(decoded.audio.sampleRate) || 1;
      const startIndex = (segmentStart / decoded.audio.duration) * sampleLength;
      const endIndexExclusive = (segmentEnd / decoded.audio.duration) * sampleLength;
      const runs = buildSilenceRunsFromPredicate(
        startIndex,
        endIndexExclusive,
        (index) => clamp(index / sampleRate, segmentStart, segmentEnd),
        (index) => isSilentInChannels(decoded.channels, index, threshold),
        minimumSilenceSeconds
      );

      return {
        ok: true,
        duration,
        source: 'decoded-audio',
        runs
      };
    }

    return {
      ok: false,
      reason: 'missing-audio-data'
    };
  }

  function findTrimTargetsForResolvedWave(host, wave, startSeconds, endSeconds, amplitudeThreshold, paddingSeconds) {
    if (!(host instanceof HTMLElement) || !wave || !isUsableWaveCandidate(wave, host)) {
      return {
        ok: false,
        reason: 'missing-wave'
      };
    }

    const duration = getDuration(wave);
    const segmentStart = clamp(Number(startSeconds) || 0, 0, duration > 0 ? duration : Number(startSeconds) || 0);
    const segmentEnd = clamp(Number(endSeconds) || 0, 0, duration > 0 ? duration : Number(endSeconds) || 0);
    if (!(segmentEnd > segmentStart)) {
      return {
        ok: false,
        reason: 'invalid-range'
      };
    }

    const threshold = Math.max(0, Number(amplitudeThreshold) || 0);
    const padding = clamp(Number(paddingSeconds) || 0, 0, 0.05);

    const decoded = getDecodedAudioChannelsForTrim(wave);
    if (decoded && decoded.audio.length > 1 && decoded.audio.duration > 0) {
      const sampleLength = decoded.audio.length;
      const startIndex = (segmentStart / decoded.audio.duration) * sampleLength;
      const endIndexExclusive = (segmentEnd / decoded.audio.duration) * sampleLength;
      const firstIndex = findFirstAboveThresholdInChannels(
        decoded.channels,
        startIndex,
        endIndexExclusive,
        threshold
      );
      const lastIndex = findLastAboveThresholdInChannels(
        decoded.channels,
        startIndex,
        endIndexExclusive,
        threshold
      );
      if (firstIndex < 0 || lastIndex < 0 || lastIndex < firstIndex) {
        return {
          ok: true,
          foundAudio: false,
          duration,
          source: 'decoded-audio'
        };
      }

      const sampleRate = Number(decoded.audio.sampleRate) || 1;
      const firstSeconds = clamp(firstIndex / sampleRate, segmentStart, segmentEnd);
      const lastSeconds = clamp(lastIndex / sampleRate, segmentStart, segmentEnd);
      return {
        ok: true,
        foundAudio: true,
        duration,
        source: 'decoded-audio',
        detectedStartSeconds: firstSeconds,
        detectedEndSeconds: lastSeconds,
        targetStartSeconds: clamp(firstSeconds - padding, segmentStart, segmentEnd),
        targetEndSeconds: clamp(lastSeconds + padding, segmentStart, segmentEnd)
      };
    }

    const rawPeaks = getRawExportPeaks(wave);
    if (rawPeaks && rawPeaks.length > 1) {
      const startIndex = (segmentStart / duration) * (rawPeaks.length - 1);
      const endIndexExclusive = (segmentEnd / duration) * (rawPeaks.length - 1) + 1;
      const firstIndex = findFirstAboveThresholdInArray(rawPeaks, startIndex, endIndexExclusive, threshold);
      const lastIndex = findLastAboveThresholdInArray(rawPeaks, startIndex, endIndexExclusive, threshold);
      if (firstIndex < 0 || lastIndex < 0 || lastIndex < firstIndex) {
        return {
          ok: true,
          foundAudio: false,
          duration,
          source: 'export-peaks'
        };
      }

      const firstSeconds = indexToSeconds(firstIndex, rawPeaks.length, duration);
      const lastSeconds = indexToSeconds(lastIndex, rawPeaks.length, duration);
      return {
        ok: true,
        foundAudio: true,
        duration,
        source: 'export-peaks',
        detectedStartSeconds: firstSeconds,
        detectedEndSeconds: lastSeconds,
        targetStartSeconds: clamp(firstSeconds - padding, segmentStart, segmentEnd),
        targetEndSeconds: clamp(lastSeconds + padding, segmentStart, segmentEnd)
      };
    }

    return {
      ok: false,
      reason: 'missing-audio-data'
    };
  }

  function findExtendTargetsForResolvedWave(host, wave, startSeconds, endSeconds, amplitudeThreshold, stepSeconds) {
    if (!(host instanceof HTMLElement) || !wave || !isUsableWaveCandidate(wave, host)) {
      return {
        ok: false,
        reason: 'missing-wave'
      };
    }

    const duration = getDuration(wave);
    const segmentStart = clamp(Number(startSeconds) || 0, 0, duration > 0 ? duration : Number(startSeconds) || 0);
    const segmentEnd = clamp(Number(endSeconds) || 0, 0, duration > 0 ? duration : Number(endSeconds) || 0);
    if (!(segmentEnd > segmentStart)) {
      return {
        ok: false,
        reason: 'invalid-range'
      };
    }

    const threshold = Math.max(0, Number(amplitudeThreshold) || 0);
    const outwardStepSeconds = Math.max(0, Number(stepSeconds) || 0);
    const decoded = getDecodedAudioChannelsForTrim(wave);
    if (decoded && decoded.audio.length > 1 && decoded.audio.duration > 0) {
      const sampleLength = decoded.audio.length;
      const startIndex = (segmentStart / decoded.audio.duration) * sampleLength;
      const endIndex = (segmentEnd / decoded.audio.duration) * sampleLength;
      const sampleRate = Number(decoded.audio.sampleRate) || 1;
      const stepSamples = Math.max(1, Math.floor(outwardStepSeconds * sampleRate));
      const leftIndex = findPreviousSilenceInChannels(decoded.channels, startIndex - 1, threshold, stepSamples);
      const rightIndex = findNextSilenceInChannels(decoded.channels, endIndex, threshold, stepSamples);

      return {
        ok: true,
        foundLeftSilence: leftIndex >= 0,
        foundRightSilence: rightIndex >= 0,
        duration,
        source: 'decoded-audio',
        targetStartSeconds: leftIndex >= 0 ? clamp(leftIndex / sampleRate, 0, segmentStart) : segmentStart,
        targetEndSeconds: rightIndex >= 0 ? clamp(rightIndex / sampleRate, segmentEnd, duration) : segmentEnd
      };
    }

    const rawPeaks = getRawExportPeaks(wave);
    if (rawPeaks && rawPeaks.length > 1 && duration > 0) {
      const startIndex = (segmentStart / duration) * (rawPeaks.length - 1);
      const endIndex = (segmentEnd / duration) * (rawPeaks.length - 1);
      const stepSamples = Math.max(1, Math.floor((outwardStepSeconds / duration) * (rawPeaks.length - 1)));
      const leftIndex = findPreviousSilenceInArray(rawPeaks, startIndex - 1, threshold, stepSamples);
      const rightIndex = findNextSilenceInArray(rawPeaks, endIndex, threshold, stepSamples);

      return {
        ok: true,
        foundLeftSilence: leftIndex >= 0,
        foundRightSilence: rightIndex >= 0,
        duration,
        source: 'export-peaks',
        targetStartSeconds: leftIndex >= 0 ? clamp(indexToSeconds(leftIndex, rawPeaks.length, duration), 0, segmentStart) : segmentStart,
        targetEndSeconds: rightIndex >= 0 ? clamp(indexToSeconds(rightIndex, rawPeaks.length, duration), segmentEnd, duration) : segmentEnd
      };
    }

    return {
      ok: false,
      reason: 'missing-audio-data'
    };
  }

  function normalizeSpeakerKey(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  function getSpeakerKeysForHost(host) {
    if (!(host instanceof HTMLElement)) {
      return [];
    }

    const trackProps = getTrackPropsForHost(host);
    const track =
      trackProps &&
      typeof trackProps === 'object' &&
      trackProps.track &&
      typeof trackProps.track === 'object'
        ? trackProps.track
        : null;
    const keys = [];

    if (track && typeof track.label === 'string' && track.label.trim()) {
      keys.push(track.label);
    }

    const trackId = getTrackIdFromTrack(track);
    if (trackId) {
      keys.push(trackId);
    }

    return Array.from(new Set(keys.map(normalizeSpeakerKey).filter(Boolean)));
  }

  function hostMatchesSpeaker(host, speakerKey) {
    const normalizedSpeakerKey = normalizeSpeakerKey(speakerKey);
    if (!normalizedSpeakerKey) {
      return true;
    }

    return getSpeakerKeysForHost(host).includes(normalizedSpeakerKey);
  }

  function resolveWaveForVisibleSpeaker(speakerKey) {
    const hosts = getVisibleWaveHosts();
    if (!hosts.length) {
      return {
        host: null,
        wave: null
      };
    }

    const normalizedSpeakerKey = normalizeSpeakerKey(speakerKey);
    let host = null;

    if (normalizedSpeakerKey) {
      host =
        hosts.find((candidate) => getSpeakerKeysForHost(candidate).includes(normalizedSpeakerKey)) || null;
    }

    if (!normalizedSpeakerKey && !(host instanceof HTMLElement) && hosts.length === 1) {
      host = hosts[0];
    }

    if (!(host instanceof HTMLElement)) {
      return {
        host: null,
        wave: null
      };
    }

    const exact = findExactWaveCandidate(host);
    const selection = exact || safe(() => findWaveCandidate(host).candidate, null);
    return {
      host,
      wave: selection && selection.value ? selection.value : null
    };
  }

  function findTrimTargets(hostMarker, startSeconds, endSeconds, amplitudeThreshold, paddingSeconds) {
    const resolved = resolveWaveForHost(hostMarker);
    return findTrimTargetsForResolvedWave(
      resolved.host,
      resolved.wave,
      startSeconds,
      endSeconds,
      amplitudeThreshold,
      paddingSeconds
    );
  }

  function findSegmentSilenceRuns(hostMarker, speakerKey, startSeconds, endSeconds, amplitudeThreshold, minimumSilenceSeconds) {
    let resolved = resolveWaveForHost(hostMarker);
    if (
      !resolved.wave ||
      !isUsableWaveCandidate(resolved.wave, resolved.host) ||
      !hostMatchesSpeaker(resolved.host, speakerKey)
    ) {
      resolved = resolveWaveForVisibleSpeaker(speakerKey);
    }
    return findSegmentSilenceRunsForResolvedWave(
      resolved.host,
      resolved.wave,
      startSeconds,
      endSeconds,
      amplitudeThreshold,
      minimumSilenceSeconds
    );
  }

  function findNearestSpeechIsland(hostMarker, speakerKey, caretSeconds, scanWindowSeconds, amplitudeThreshold, paddingSeconds) {
    const hostResolved = resolveWaveForHost(hostMarker);
    if (hostResolved.wave && isUsableWaveCandidate(hostResolved.wave, hostResolved.host)) {
      return findNearestSpeechIslandForResolvedWave(
        hostResolved.host,
        hostResolved.wave,
        caretSeconds,
        scanWindowSeconds,
        amplitudeThreshold,
        paddingSeconds
      );
    }

    const resolved = resolveWaveForVisibleSpeaker(speakerKey);
    return findNearestSpeechIslandForResolvedWave(
      resolved.host,
      resolved.wave,
      caretSeconds,
      scanWindowSeconds,
      amplitudeThreshold,
      paddingSeconds
    );
  }

  function findTrimTargetsForSpeaker(speakerKey, startSeconds, endSeconds, amplitudeThreshold, paddingSeconds) {
    const resolved = resolveWaveForVisibleSpeaker(speakerKey);
    return findTrimTargetsForResolvedWave(
      resolved.host,
      resolved.wave,
      startSeconds,
      endSeconds,
      amplitudeThreshold,
      paddingSeconds
    );
  }

  function findExtendTargets(hostMarker, startSeconds, endSeconds, amplitudeThreshold, stepSeconds) {
    const resolved = resolveWaveForHost(hostMarker);
    return findExtendTargetsForResolvedWave(
      resolved.host,
      resolved.wave,
      startSeconds,
      endSeconds,
      amplitudeThreshold,
      stepSeconds
    );
  }

  function findExtendTargetsForSpeaker(speakerKey, startSeconds, endSeconds, amplitudeThreshold, stepSeconds) {
    const resolved = resolveWaveForVisibleSpeaker(speakerKey);
    return findExtendTargetsForResolvedWave(
      resolved.host,
      resolved.wave,
      startSeconds,
      endSeconds,
      amplitudeThreshold,
      stepSeconds
    );
  }

  function computeMinimapPeaksRaw(wave, binCount) {
    const fromExport = peaksFromExportPeaks(wave, binCount);
    if (fromExport && fromExport.length) {
      return fromExport;
    }

    const fromDecoded = peaksFromDecodedAudio(wave, binCount);
    return fromDecoded && fromDecoded.length ? fromDecoded : [];
  }

  function collectMinimapPeaks(wave, requestedBins) {
    const bins = clamp(Math.floor(Number(requestedBins) || 512), 64, 2048);
    const cacheBins = Math.max(bins, 1024);
    const signature = getMinimapPeakSignature(wave);

    let base = minimapPeakCache.get(wave);
    if (!base || base.signature !== signature || !Array.isArray(base.peaks) || !base.peaks.length) {
      const peaks = computeMinimapPeaksRaw(wave, cacheBins);
      base = {
        signature,
        peaks
      };
      if (peaks.length) {
        minimapPeakCache.set(wave, base);
      }
    }

    if (!base || !Array.isArray(base.peaks) || !base.peaks.length) {
      return [];
    }

    return bins === base.peaks.length ? Array.from(base.peaks) : resamplePeaksLinear(base.peaks, bins);
  }

  function getSourceRegionEntries(sourceWave) {
    if (!sourceWave || !sourceWave.plugins || typeof sourceWave.plugins !== 'object') {
      return [];
    }

    const regionPlugin = Object.values(sourceWave.plugins).find(
      (plugin) =>
        plugin &&
        (typeof plugin.getRegions === 'function' ||
          (plugin.regions && typeof plugin.regions === 'object'))
    );
    if (!regionPlugin) {
      return [];
    }

    const sourceRegions = safe(
      () =>
        typeof regionPlugin.getRegions === 'function'
          ? regionPlugin.getRegions()
          : Object.values(regionPlugin.regions || {}),
      []
    );

    return sourceRegions
      .map((region) => {
        const start = Number(region && region.start);
        const end = Number(region && region.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          return null;
        }

        const element = region && region.element instanceof HTMLElement ? region.element : null;
        const styles = element ? window.getComputedStyle(element) : null;
        return {
          start,
          end,
          backgroundColor:
            (region && typeof region.color === 'string' && region.color) ||
            (styles && styles.backgroundColor) ||
            'rgba(176, 131, 255, 0.25)',
          borderLeft: (styles && styles.borderLeft) || '',
          borderRight: (styles && styles.borderRight) || '',
          borderRadius: (styles && styles.borderRadius) || '2px',
          filter: (styles && styles.filter) || ''
        };
      })
      .filter(Boolean);
  }

  function collectDiagnostics(host, mount, extra) {
    const selection = findWaveCandidate(host);
    const best = selection.candidate;
    const diagnostics = {
      bridgeReady: true,
      host: describeHost(host),
      mountPresent: mount instanceof HTMLElement,
      windowWaveSurfer: {
        present: Boolean(window.WaveSurfer),
        ctor: getCtorName(window.WaveSurfer),
        create: typeof safe(() => window.WaveSurfer.create, null) === 'function'
      },
      bestCandidate: best
        ? summarizeCandidateRecord(best, host)
        : null,
      fallbackCandidate:
        selection.fallback && selection.fallback !== best
          ? summarizeCandidateRecord(selection.fallback, host)
          : null,
      registryCandidates: collectRegistryCandidates(host)
        .slice(0, 6)
        .map((record) => summarizeCandidateRecord(record, host)),
      candidates: collectWaveCandidates(host),
      react: getElementSearchSeeds(host).slice(0, 8).map((seed) => describeReactPath(seed.path, seed.value))
    };

    if (extra && typeof extra === 'object') {
      diagnostics.context = extra;
    }

    return diagnostics;
  }

  function getRenderRoot(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    if (element.shadowRoot && element.shadowRoot.querySelector('[part="scroll"]')) {
      return element.shadowRoot;
    }

    if (element.querySelector('[part="scroll"]')) {
      return element;
    }

    for (const child of Array.from(element.children)) {
      if (!(child instanceof HTMLElement)) {
        continue;
      }

      if (child.shadowRoot && child.shadowRoot.querySelector('[part="scroll"]')) {
        return child.shadowRoot;
      }

      if (child.querySelector('[part="scroll"]')) {
        return child;
      }
    }

    return null;
  }

  function resolveWaveForHost(hostMarker) {
    const host = findLoopHostElement(hostMarker) || findHostElement(hostMarker);
    if (!(host instanceof HTMLElement)) {
      return {
        host: null,
        wave: null
      };
    }

    const exact = findExactWaveCandidate(host);
    const selection = exact || safe(() => findWaveCandidate(host).candidate, null);
    return {
      host,
      wave: selection && selection.value ? selection.value : null
    };
  }

  function resolveVisibleLaneTargets(lanes) {
    const requestedLanes = Array.isArray(lanes) ? lanes : [];
    const targets = [];

    for (let index = 0; index < requestedLanes.length; index += 1) {
      const lane = requestedLanes[index] || {};
      const hostMarker =
        typeof lane.hostMarker === 'string' && lane.hostMarker ? lane.hostMarker : '';
      const resolved = resolveWaveForHost(hostMarker);
      const host = resolved.host;
      if (!(host instanceof HTMLElement)) {
        targets.push({
          ok: false,
          index,
          hostMarker,
          processedRecordingId: '',
          trackId: '',
          speakerKey: '',
          trackLabel: '',
          hasWave: false,
          source: 'react-track-props',
          reason: 'missing-host'
        });
        continue;
      }

      const trackProps = getTrackPropsForHost(host);
      const track =
        trackProps &&
        typeof trackProps === 'object' &&
        trackProps.track &&
        typeof trackProps.track === 'object'
          ? trackProps.track
          : null;
      const processedRecordingId = getTrackIdFromTrack(track) || '';
      const trackLabel = getTrackLabelFromTrack(track);
      targets.push({
        ok: Boolean(processedRecordingId),
        index,
        hostMarker,
        processedRecordingId,
        trackId: processedRecordingId,
        speakerKey: processedRecordingId || trackLabel,
        trackLabel,
        hasWave: Boolean(resolved.wave && isUsableWaveCandidate(resolved.wave, host)),
        source: 'react-track-props',
        reason: processedRecordingId ? null : 'missing-react-track-id'
      });
    }

    return {
      ok: true,
      targets
    };
  }

  function getViewportMetrics(host, wave) {
    const renderRoot = getRenderRoot(host) || getRenderRoot(getCandidateContainer(wave));
    if (!renderRoot) {
      return {
        totalWidth: 0,
        visibleWidth: 0,
        scrollLeft: 0
      };
    }

    const wrapper = renderRoot.querySelector('[part="wrapper"]');
    const scroll = renderRoot.querySelector('[part="scroll"]');
    const totalWidth = getWaveRenderWidth(wave, wrapper, getSourcePixelsPerSecond(wave));
    const visibleWidth =
      scroll instanceof HTMLElement
        ? Number(scroll.clientWidth) || 0
        : wrapper instanceof HTMLElement
          ? Number(wrapper.clientWidth) || 0
          : 0;
    const scrollLeft = scroll instanceof HTMLElement ? Number(scroll.scrollLeft) || 0 : 0;

    return {
      totalWidth,
      visibleWidth,
      scrollLeft,
      scroll
    };
  }

  function applySourceTime(wave, targetTime, duration) {
    if (!wave || typeof wave.setTime !== 'function') {
      return false;
    }

    const applied = safe(() => {
      wave.setTime(targetTime);
      return true;
    }, false);

    const progress = duration > 0 ? clamp(targetTime / duration, 0, 1) : null;
    if (progress != null) {
      safe(() => {
        const renderer = wave.renderer;
        if (renderer && typeof renderer.renderProgress === 'function') {
          renderer.renderProgress(progress);
        }
      }, null);
    }

    return Boolean(applied);
  }

  function applySourceTimeToWaves(waves, targetTime, duration) {
    let applied = 0;
    const seen = new Set();
    for (const wave of Array.isArray(waves) ? waves : []) {
      if (!wave || seen.has(wave)) {
        continue;
      }
      seen.add(wave);
      if (applySourceTime(wave, targetTime, duration)) {
        applied += 1;
      }
    }

    return applied;
  }

  function centerViewportOnTime(viewport, targetTime, pixelsPerSecond) {
    if (
      !(
        viewport &&
        viewport.scroll instanceof HTMLElement &&
        viewport.totalWidth > 0 &&
        viewport.visibleWidth > 0 &&
        pixelsPerSecond > 0
      )
    ) {
      return viewport && Number.isFinite(viewport.scrollLeft) ? viewport.scrollLeft : 0;
    }

    const maxScroll = Math.max(0, viewport.totalWidth - viewport.visibleWidth);
    const desiredLeft = clamp(
      targetTime * pixelsPerSecond - viewport.visibleWidth / 2,
      0,
      maxScroll
    );
    viewport.scroll.scrollLeft = desiredLeft;
    viewport.scrollLeft = desiredLeft;
    safe(() => {
      viewport.scroll.dispatchEvent(new Event('scroll'));
    }, null);

    return desiredLeft;
  }

  function getMinimapData(hostMarker, payload) {
    const resolved = resolveWaveForHost(hostMarker);
    const host = resolved.host;
    const wave = resolved.wave;
    if (!(host instanceof HTMLElement) || !host.isConnected || !wave || !isUsableWaveCandidate(wave, host)) {
      return {
        ok: false,
        reason: 'missing-wave'
      };
    }

    const rect = host.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) {
      return {
        ok: false,
        reason: 'hidden-host'
      };
    }

    const style = window.getComputedStyle(host);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return {
        ok: false,
        reason: 'hidden-style'
      };
    }

    const duration = getDuration(wave);
    const sourcePixelsPerSecond = getSourcePixelsPerSecond(wave);
    const viewport = getViewportMetrics(host, wave);
    const viewportOnly = Boolean(payload && payload.viewportOnly);

    if (viewportOnly) {
      return {
        ok: true,
        duration,
        currentTime: Number(safe(() => wave.getCurrentTime(), 0)) || 0,
        contentSignature: getMinimapContentSignature(wave),
        sourcePixelsPerSecond,
        totalWidth: viewport.totalWidth,
        visibleWidth: viewport.visibleWidth,
        scrollLeft: viewport.scrollLeft
      };
    }

    const peakBins = clamp(Math.floor(Number(payload && payload.peakBins) || 512), 64, 2048);

    return {
      ok: true,
      duration,
      currentTime: Number(safe(() => wave.getCurrentTime(), 0)) || 0,
      contentSignature: getMinimapContentSignature(wave),
      sourcePixelsPerSecond,
      totalWidth: viewport.totalWidth,
      visibleWidth: viewport.visibleWidth,
      scrollLeft: viewport.scrollLeft,
      regions: getSourceRegionEntries(wave),
      peaks: collectMinimapPeaks(wave, peakBins)
    };
  }

  function ensureLens(hostMarker, mountMarker, height, scale) {
    const host = findHostElement(hostMarker);
    const mount = findMountElement(host, mountMarker);
    if (!(host instanceof HTMLElement) || !(mount instanceof HTMLElement)) {
      return { ok: false, reason: 'missing-dom' };
    }

    for (const [id, record] of instances.entries()) {
      if (record.host === host && record.mount === mount) {
        return { ok: true, id };
      }
    }

    const selection = findWaveCandidate(host);
    const sourceRecord = selection.candidate;
    const sourceWave = sourceRecord ? sourceRecord.value : null;
    const sourceMetrics = sourceWave ? getSourceRenderMetrics(sourceWave, host) : null;
    const factory =
      sourceWave &&
      sourceWave.constructor &&
      typeof sourceWave.constructor.create === 'function'
        ? sourceWave.constructor.create.bind(sourceWave.constructor)
        : null;
    if (!sourceWave || !factory) {
      return { ok: false, reason: 'no-wave-instance' };
    }

    let createError = null;
    const wave = safe(() => {
      try {
        return factory(buildLensOptions(sourceWave, mount, scale, sourceMetrics));
      } catch (error) {
        createError = error instanceof Error ? error.message : String(error);
        return null;
      }
    }, null);
    if (!wave) {
      return { ok: false, reason: 'create-failed', error: createError || null };
    }

    const id = 'lens-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const record = {
      host,
      mount,
      sourcePath: sourceRecord ? sourceRecord.path : null,
      sourceMetrics,
      sourceWave,
      wave
    };

    syncLensDecodedAudio(record);
    instances.set(id, record);

    return {
      ok: true,
      id,
      duration: getDuration(sourceWave),
      sourcePixelsPerSecond: getSourcePixelsPerSecond(sourceWave)
    };
  }

  function updateLens(id, time, width, height, scale) {
    const record = instances.get(id);
    if (!record) {
      return { ok: false, reason: 'missing-instance' };
    }

    const targetPixelsPerSecond = Math.max(1, (getSourcePixelsPerSecond(record.sourceWave) || 1) * scale);

    safe(() => {
      if (record.wave && typeof record.wave.setOptions === 'function') {
        record.wave.setOptions({
          minPxPerSec: targetPixelsPerSecond,
          height: height
        });
      } else if (record.wave && typeof record.wave.zoom === 'function') {
        record.wave.zoom(targetPixelsPerSecond);
      }
    }, null);

    syncLensDecodedAudio(record);

    const duration = getDuration(record.sourceWave) || getDuration(record.wave);
    if (!(duration > 0)) {
      return { ok: false, reason: 'missing-duration' };
    }

    const renderRoot = getRenderRoot(record.mount);
    if (!renderRoot) {
      return { ok: false, reason: 'missing-render-root' };
    }

    const wrapper = renderRoot.querySelector('[part="wrapper"]');
    const scroll = renderRoot.querySelector('[part="scroll"]');
    if (!(wrapper instanceof HTMLElement) || !(scroll instanceof HTMLElement)) {
      return { ok: false, reason: 'missing-scroll' };
    }

    const renderHeight = height;
    const verticalOffset = 0;

    record.mount.style.inset = 'auto';
    record.mount.style.left = '0';
    record.mount.style.top = verticalOffset + 'px';
    record.mount.style.width = width + 'px';
    record.mount.style.height = renderHeight + 'px';

    const wrapperWidth = getWaveRenderWidth(record.wave, wrapper, targetPixelsPerSecond);
    if (wrapperWidth > 0) {
      wrapper.style.width = wrapperWidth + 'px';
    }
    const maxScroll = Math.max(0, wrapperWidth - width);
    const scrollLeft = clamp(time * targetPixelsPerSecond - width / 2, 0, maxScroll);
    scroll.scrollLeft = scrollLeft;

    return {
      ok: true,
      windowStart: scrollLeft / targetPixelsPerSecond,
      windowEnd: (scrollLeft + width) / targetPixelsPerSecond,
      duration,
      sourcePixelsPerSecond: getSourcePixelsPerSecond(record.sourceWave),
      regions: getSourceRegionEntries(record.sourceWave)
    };
  }

  function seekSource(hostMarker, time) {
    const resolved = resolveWaveForHost(hostMarker);
    const host = resolved.host;
    const wave = resolved.wave;
    if (!(host instanceof HTMLElement) || !wave || typeof wave.setTime !== 'function') {
      return { ok: false };
    }

    wave.setTime(time);
    return { ok: true };
  }

  function navigateSource(hostMarker, time) {
    const resolved = resolveWaveForHost(hostMarker);
    const host = resolved.host;
    const wave = resolved.wave;
    if (!(host instanceof HTMLElement) || !wave || typeof wave.setTime !== 'function') {
      return {
        ok: false,
        reason: 'missing-wave'
      };
    }

    const duration = getDuration(wave);
    const targetTime = clamp(Number(time) || 0, 0, duration > 0 ? duration : Number(time) || 0);
    const viewport = getViewportMetrics(host, wave);
    const pixelsPerSecond = getSourcePixelsPerSecond(wave);
    const waves = getNavigationWaveSet(host, wave);
    const applied = applySourceTimeToWaves(waves, targetTime, duration);
    if (!applied) {
      return {
        ok: false,
        reason: 'wave-set-failed'
      };
    }
    const scrollLeft = centerViewportOnTime(viewport, targetTime, pixelsPerSecond);

    const nextToken = (minimapNavigationTokens.get(wave) || 0) + 1;
    minimapNavigationTokens.set(wave, nextToken);
    safe(() => {
      window.requestAnimationFrame(() => {
        if (minimapNavigationTokens.get(wave) !== nextToken) {
          return;
        }
        const nextViewport = getViewportMetrics(host, wave);
        applySourceTimeToWaves(waves, targetTime, duration);
        centerViewportOnTime(nextViewport, targetTime, pixelsPerSecond);
      });
    }, null);

    return {
      ok: true,
      time: targetTime,
      waveCount: applied,
      totalWidth: viewport.totalWidth,
      visibleWidth: viewport.visibleWidth,
      scrollLeft
    };
  }

  function destroyLens(id) {
    const record = instances.get(id);
    if (record && record.wave && typeof record.wave.destroy === 'function') {
      safe(() => record.wave.destroy(), null);
    }
    instances.delete(id);
    return { ok: true };
  }

  function findExactWaveCandidate(host) {
    if (!(host instanceof HTMLElement)) {
      return null;
    }

    const trackProps = getTrackPropsForHost(host);
    const trackId =
      trackProps && trackProps.track && typeof trackProps.track === 'object'
        ? getTrackIdFromTrack(trackProps.track)
        : null;
    const registryMatches = collectRegistryCandidates(host);
    let wrapperMatch = null;
    let trackMatch = null;

    for (const record of registryMatches) {
      if (!record || !record.value || !isUsableWaveCandidate(record.value, host)) {
        continue;
      }

      const wave = record.value;
      const container = getCandidateContainer(wave);
      const wrapper = safe(() => (typeof wave.getWrapper === 'function' ? wave.getWrapper() : null), null);
      const wrapperRoot = wrapper && typeof wrapper.getRootNode === 'function' ? wrapper.getRootNode() : null;
      const wrapperHost = wrapperRoot instanceof ShadowRoot ? wrapperRoot.host : null;
      const containerMatches = container instanceof HTMLElement && elementsOverlapContext(host, container);
      const wrapperMatches =
        wrapper instanceof HTMLElement
          ? elementsOverlapContext(host, wrapper)
          : wrapperHost instanceof HTMLElement && elementsOverlapContext(host, wrapperHost);
      const pathMatchesTrack =
        trackId && typeof record.path === 'string'
          ? record.path.indexOf('.' + trackId + '.wavesurfer') !== -1
          : false;

      if ((containerMatches || wrapperMatches) && pathMatchesTrack) {
        return record;
      }

      if ((containerMatches || wrapperMatches) && !wrapperMatch) {
        wrapperMatch = record;
      }

      if (pathMatchesTrack && !trackMatch) {
        trackMatch = record;
      }
    }

    if (wrapperMatch || trackMatch) {
      return wrapperMatch || trackMatch;
    }

    const broader = findWaveCandidate(host);
    return broader && broader.candidate ? broader.candidate : null;
  }

  function getVisibleWaveHosts() {
    return Array.from(document.querySelectorAll('div')).filter((element) => {
      if (!(element instanceof HTMLElement) || !element.shadowRoot) {
        return false;
      }

      return Boolean(
        element.shadowRoot.querySelector('[part="wrapper"]') &&
        element.shadowRoot.querySelector('[part="scroll"]')
      );
    });
  }

  function getNavigationWaveSet(host, primaryWave) {
    const seen = new Set();
    const orderedHosts = [
      host,
      ...getVisibleWaveHosts().filter((candidate) => candidate !== host)
    ];
    const waves = [];

    if (primaryWave && typeof primaryWave === 'object') {
      seen.add(primaryWave);
      waves.push(primaryWave);
    }

    for (const candidateHost of orderedHosts) {
      const record = findExactWaveCandidate(candidateHost);
      const wave = record ? record.value : null;
      if (!wave || typeof wave !== 'object' || seen.has(wave)) {
        continue;
      }

      seen.add(wave);
      waves.push(wave);
    }

    return waves;
  }

  function getLoopWaveSet(hostMarker) {
    const host = findLoopHostElement(hostMarker);
    if (!(host instanceof HTMLElement)) {
      return null;
    }

    const seen = new Set();
    const orderedHosts = [host, ...getVisibleWaveHosts().filter((candidate) => candidate !== host)];
    const waves = [];

    for (const candidateHost of orderedHosts) {
      const record = findExactWaveCandidate(candidateHost);
      const wave = record ? record.value : null;
      if (!wave || typeof wave !== 'object' || seen.has(wave)) {
        continue;
      }

      seen.add(wave);
      waves.push(wave);
    }

    if (!waves.length) {
      return null;
    }

    return {
      host,
      wave: waves[0],
      waves
    };
  }

  function playWaveRange(wave, start, end) {
    if (!wave || typeof wave.play !== 'function') {
      return;
    }

    try {
      const result = wave.play(start, end);
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    } catch (error) {
      // Ignore playback exceptions; caller will surface a bridge failure if needed.
    }
  }

  function stopLoop(hostMarker) {
    const loop = loops.get(hostMarker);
    if (loop && loop.timer) {
      clearInterval(loop.timer);
    }
    loops.delete(hostMarker);
    return { ok: true };
  }

  function getZoomSliderElement() {
    const selector =
      '[role="slider"][data-orientation="horizontal"][aria-valuemin="10"][aria-valuemax="2000"]';
    const slider = document.querySelector(selector);
    return slider instanceof HTMLElement ? slider : null;
  }

  function getZoomValueCallbacks(slider) {
    if (!(slider instanceof HTMLElement)) {
      return [];
    }

    const callbacks = [];
    let node = getReactFiber(slider);
    let depth = 0;
    while (node && typeof node === 'object' && depth < 40) {
      const props = safe(() => node.memoizedProps, null);
      if (props && typeof props === 'object' && typeof props.onValueChange === 'function') {
        callbacks.push(props.onValueChange);
      }

      node = safe(() => node.return, null);
      depth += 1;
    }

    return callbacks;
  }

  function getSliderNumericProp(slider, propName, fallbackValue) {
    if (!(slider instanceof HTMLElement)) {
      return fallbackValue;
    }

    let node = getReactFiber(slider);
    let depth = 0;
    while (node && typeof node === 'object' && depth < 40) {
      const props = safe(() => node.memoizedProps, null);
      const numeric = Number(props && typeof props === 'object' ? props[propName] : NaN);
      if (Number.isFinite(numeric)) {
        return numeric;
      }

      node = safe(() => node.return, null);
      depth += 1;
    }

    return fallbackValue;
  }

  function patchSliderNumericProps(slider, propName, nextValue) {
    if (!(slider instanceof HTMLElement)) {
      return 0;
    }

    let patched = 0;
    let node = getReactFiber(slider);
    let depth = 0;
    while (node && typeof node === 'object' && depth < 40) {
      const memoizedProps = safe(() => node.memoizedProps, null);
      if (
        memoizedProps &&
        typeof memoizedProps === 'object' &&
        Number.isFinite(Number(memoizedProps[propName]))
      ) {
        memoizedProps[propName] = nextValue;
        patched += 1;
      }

      const pendingProps = safe(() => node.pendingProps, null);
      if (
        pendingProps &&
        typeof pendingProps === 'object' &&
        Number.isFinite(Number(pendingProps[propName]))
      ) {
        pendingProps[propName] = nextValue;
        patched += 1;
      }

      node = safe(() => node.return, null);
      depth += 1;
    }

    return patched;
  }

  function isWaveformScaleSlider(slider) {
    if (!(slider instanceof HTMLElement)) {
      return false;
    }

    if (slider.getAttribute('data-orientation') !== 'vertical') {
      return false;
    }

    const min = Number(slider.getAttribute('aria-valuemin'));
    return Number.isFinite(min) && Math.abs(min - WAVEFORM_SCALE_DEFAULT_MIN) < 0.01;
  }

  function getWaveformScaleTrack(slider) {
    if (!(slider instanceof HTMLElement)) {
      return null;
    }

    let current = slider.parentElement;
    while (current instanceof HTMLElement) {
      if (
        current.getAttribute('data-orientation') === 'vertical' &&
        current !== slider &&
        current.getBoundingClientRect().height > slider.getBoundingClientRect().height + 4
      ) {
        return current;
      }
      current = current.parentElement;
    }

    return slider.parentElement instanceof HTMLElement ? slider.parentElement : slider;
  }

  function getWaveformScaleVisualParts(slider) {
    const wrapper = slider instanceof HTMLElement ? slider.parentElement : null;
    const root = wrapper instanceof HTMLElement ? wrapper.parentElement : null;
    const track =
      root instanceof HTMLElement ? root.querySelector(':scope > span:first-child') : null;
    const range =
      track instanceof HTMLElement ? track.querySelector(':scope > span') : null;
    const tooltip =
      slider instanceof HTMLElement ? slider.querySelector('div') : null;

    return {
      wrapper: wrapper instanceof HTMLElement ? wrapper : null,
      root: root instanceof HTMLElement ? root : null,
      track: track instanceof HTMLElement ? track : null,
      range: range instanceof HTMLElement ? range : null,
      tooltip: tooltip instanceof HTMLElement ? tooltip : null
    };
  }

  function formatWaveformScaleLabel(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return '';
    }

    if (Math.abs(numeric - Math.round(numeric)) < 0.001) {
      return Math.round(numeric) + 'x';
    }

    return numeric.toFixed(1).replace(/\.0$/, '') + 'x';
  }

  function applyWaveformScaleVisuals(slider, value, min, max) {
    if (!(slider instanceof HTMLElement)) {
      return;
    }

    const numericValue = Number(value);
    const numericMin = Number(min);
    const numericMax = Number(max);
    if (
      !Number.isFinite(numericValue) ||
      !Number.isFinite(numericMin) ||
      !Number.isFinite(numericMax) ||
      numericMax <= numericMin
    ) {
      return;
    }

    const ratio = clamp((numericValue - numericMin) / (numericMax - numericMin), 0, 1);
    const percent = ratio * 100;
    const visuals = getWaveformScaleVisualParts(slider);
    if (visuals.wrapper) {
      visuals.wrapper.style.bottom = 'calc(' + percent + '% - 6px)';
    }
    if (visuals.range) {
      visuals.range.style.bottom = '0%';
      visuals.range.style.top = (100 - percent) + '%';
    }

    const label = formatWaveformScaleLabel(numericValue);
    if (label) {
      slider.setAttribute('aria-valuetext', label);
      if (visuals.tooltip) {
        visuals.tooltip.textContent = label;
      }
    }
  }

  function patchWaveformScaleSlider(slider) {
    if (!isWaveformScaleSlider(slider)) {
      return false;
    }

    const nextMax = Math.max(WAVEFORM_SCALE_DEFAULT_MAX, Number(waveformScaleState.max) || 1000);
    const patchedMax = patchSliderNumericProps(slider, 'max', nextMax);
    const currentMin = getSliderNumericProp(slider, 'min', WAVEFORM_SCALE_DEFAULT_MIN);
    if (Number.isFinite(currentMin)) {
      patchSliderNumericProps(slider, 'min', currentMin);
    }

    if (slider.getAttribute('aria-valuemax') !== String(nextMax)) {
      slider.setAttribute('aria-valuemax', String(nextMax));
    }
    if (slider.getAttribute(WAVEFORM_SCALE_PATCH_ATTR) !== String(nextMax)) {
      slider.setAttribute(WAVEFORM_SCALE_PATCH_ATTR, String(nextMax));
    }

    const currentValue = Number(slider.getAttribute('aria-valuenow'));
    if (Number.isFinite(currentValue)) {
      applyWaveformScaleVisuals(
        slider,
        currentValue,
        Number.isFinite(currentMin) ? currentMin : WAVEFORM_SCALE_DEFAULT_MIN,
        nextMax
      );
    }

    return patchedMax > 0;
  }

  function patchWaveformScaleSliders() {
    let patched = 0;
    for (const slider of Array.from(document.querySelectorAll(WAVEFORM_SCALE_SELECTOR))) {
      if (patchWaveformScaleSlider(slider)) {
        patched += 1;
      }
    }
    return patched;
  }

  function getWaveformScaleSliderByIndex(index) {
    const numericIndex = Math.max(0, Math.floor(Number(index) || 0));
    const sliders = Array.from(document.querySelectorAll(WAVEFORM_SCALE_SELECTOR)).filter((slider) =>
      isWaveformScaleSlider(slider)
    );
    const target = sliders[numericIndex];
    return target instanceof HTMLElement ? target : null;
  }

  function getWaveformScaleControl(target) {
    const slider =
      target instanceof HTMLElement
        ? target.closest(WAVEFORM_SCALE_SELECTOR)
        : null;
    if (!(slider instanceof HTMLElement) || !isWaveformScaleSlider(slider)) {
      return null;
    }

    patchWaveformScaleSlider(slider);

    const track = getWaveformScaleTrack(slider);
    const callbacks = getZoomValueCallbacks(slider);
    if (!callbacks.length) {
      return null;
    }

    return {
      slider,
      track,
      callbacks,
      min: getSliderNumericProp(slider, 'min', Number(slider.getAttribute('aria-valuemin')) || WAVEFORM_SCALE_DEFAULT_MIN),
      max: Math.max(
        Number(waveformScaleState.max) || 1000,
        getSliderNumericProp(slider, 'max', Number(slider.getAttribute('aria-valuemax')) || WAVEFORM_SCALE_DEFAULT_MAX)
      ),
      step: getSliderNumericProp(slider, 'step', WAVEFORM_SCALE_DEFAULT_STEP),
      value: Number(slider.getAttribute('aria-valuenow'))
    };
  }

  function setWaveformScaleValue(control, value) {
    if (!control || !Array.isArray(control.callbacks) || !control.callbacks.length) {
      return { ok: false, reason: 'missing-control' };
    }

    patchWaveformScaleSlider(control.slider);

    const target = clamp(
      Number(value),
      Number.isFinite(control.min) ? control.min : WAVEFORM_SCALE_DEFAULT_MIN,
      Number.isFinite(control.max) ? control.max : Number(waveformScaleState.max) || 1000
    );
    if (!Number.isFinite(target)) {
      return { ok: false, reason: 'invalid-value' };
    }

    for (const callback of control.callbacks) {
      try {
        callback([target]);
      } catch (_error) {
        // Ignore duplicate callback wrappers; another callback may succeed.
      }
    }

    control.slider.setAttribute('aria-valuenow', String(target));
    applyWaveformScaleVisuals(control.slider, target, control.min, control.max);

    return {
      ok: true,
      target,
      current: Number(control.slider.getAttribute('aria-valuenow')) || null
    };
  }

  function getWaveformScaleValueFromPointer(control, clientY) {
    const track = control && control.track instanceof HTMLElement ? control.track : null;
    if (!track) {
      return null;
    }

    const rect = track.getBoundingClientRect();
    if (!(rect.height > 0)) {
      return null;
    }

    const ratio = clamp((rect.bottom - Number(clientY)) / rect.height, 0, 1);
    return control.min + ratio * (control.max - control.min);
  }

  function handleWaveformScalePointerDown(event) {
    if (!waveformScaleState.enabled || !event || event.button !== 0) {
      return;
    }

    const control = getWaveformScaleControl(event.target);
    if (!control) {
      return;
    }

    const nextValue = getWaveformScaleValueFromPointer(control, event.clientY);
    if (!Number.isFinite(nextValue)) {
      return;
    }

    waveformScaleState.drag = {
      pointerId: typeof event.pointerId === 'number' ? event.pointerId : 1,
      slider: control.slider
    };

    setWaveformScaleValue(control, nextValue);
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
  }

  function handleWaveformScalePointerMove(event) {
    const drag = waveformScaleState.drag;
    if (!waveformScaleState.enabled || !drag) {
      return;
    }

    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (pointerId !== drag.pointerId) {
      return;
    }

    const control = getWaveformScaleControl(drag.slider);
    if (!control) {
      waveformScaleState.drag = null;
      return;
    }

    const nextValue = getWaveformScaleValueFromPointer(control, event.clientY);
    if (!Number.isFinite(nextValue)) {
      return;
    }

    setWaveformScaleValue(control, nextValue);
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
  }

  function handleWaveformScalePointerEnd(event) {
    const drag = waveformScaleState.drag;
    if (!drag) {
      return;
    }

    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (pointerId !== drag.pointerId) {
      return;
    }

    waveformScaleState.drag = null;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
  }

  function handleWaveformScaleKeyDown(event) {
    if (!waveformScaleState.enabled) {
      return;
    }

    const control = getWaveformScaleControl(event.target);
    if (!control) {
      return;
    }

    let nextValue = null;
    const step = Number.isFinite(control.step) && control.step > 0 ? control.step : WAVEFORM_SCALE_DEFAULT_STEP;
    const largeStep = step * 10;
    const current = Number.isFinite(control.value) ? control.value : control.min;

    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      nextValue = current + (event.shiftKey ? largeStep : step);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      nextValue = current - (event.shiftKey ? largeStep : step);
    } else if (event.key === 'PageUp') {
      nextValue = current + largeStep;
    } else if (event.key === 'PageDown') {
      nextValue = current - largeStep;
    } else if (event.key === 'Home') {
      nextValue = control.min;
    } else if (event.key === 'End') {
      nextValue = control.max;
    }

    if (!Number.isFinite(nextValue)) {
      return;
    }

    setWaveformScaleValue(control, nextValue);
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
  }

  function bindWaveformScaleUnlock() {
    if (waveformScaleState.enabled) {
      patchWaveformScaleSliders();
      return true;
    }

    waveformScaleState.enabled = true;
    patchWaveformScaleSliders();

    if (typeof MutationObserver === 'function' && document.body instanceof HTMLElement) {
      waveformScaleState.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            if (mutation.target instanceof HTMLElement && isWaveformScaleSlider(mutation.target)) {
              patchWaveformScaleSlider(mutation.target);
              return;
            }
            continue;
          }

          for (const node of mutation.addedNodes) {
            if (!(node instanceof HTMLElement)) {
              continue;
            }

            if (isWaveformScaleSlider(node) || node.querySelector(WAVEFORM_SCALE_SELECTOR)) {
              patchWaveformScaleSliders();
              return;
            }
          }
        }
      });

      waveformScaleState.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-valuemax', 'aria-valuenow']
      });
    }

    document.addEventListener('pointerdown', handleWaveformScalePointerDown, true);
    document.addEventListener('pointermove', handleWaveformScalePointerMove, true);
    document.addEventListener('pointerup', handleWaveformScalePointerEnd, true);
    document.addEventListener('pointercancel', handleWaveformScalePointerEnd, true);
    document.addEventListener('keydown', handleWaveformScaleKeyDown, true);
    return true;
  }

  function unbindWaveformScaleUnlock() {
    waveformScaleState.enabled = false;
    waveformScaleState.drag = null;

    document.removeEventListener('pointerdown', handleWaveformScalePointerDown, true);
    document.removeEventListener('pointermove', handleWaveformScalePointerMove, true);
    document.removeEventListener('pointerup', handleWaveformScalePointerEnd, true);
    document.removeEventListener('pointercancel', handleWaveformScalePointerEnd, true);
    document.removeEventListener('keydown', handleWaveformScaleKeyDown, true);

    if (waveformScaleState.observer && typeof waveformScaleState.observer.disconnect === 'function') {
      waveformScaleState.observer.disconnect();
    }

    waveformScaleState.observer = null;
    return { ok: true };
  }

  function enableWaveformScaleUnlock(max) {
    const numericMax = Number(max);
    if (Number.isFinite(numericMax) && numericMax > WAVEFORM_SCALE_DEFAULT_MAX) {
      waveformScaleState.max = numericMax;
    }

    bindWaveformScaleUnlock();
    return {
      ok: true,
      max: waveformScaleState.max,
      patched: patchWaveformScaleSliders()
    };
  }

  function setWaveformScaleByIndex(index, value, max) {
    const numericMax = Number(max);
    if (Number.isFinite(numericMax) && numericMax > WAVEFORM_SCALE_DEFAULT_MAX) {
      waveformScaleState.max = numericMax;
    }

    bindWaveformScaleUnlock();

    const slider = getWaveformScaleSliderByIndex(index);
    if (!(slider instanceof HTMLElement)) {
      return { ok: false, reason: 'missing-slider' };
    }

    const control = getWaveformScaleControl(slider);
    if (!control) {
      return { ok: false, reason: 'missing-control' };
    }

    const result = setWaveformScaleValue(control, value);
    return {
      ...result,
      index: Number(index) || 0
    };
  }

  function setZoomValue(value) {
    const slider = getZoomSliderElement();
    if (!(slider instanceof HTMLElement)) {
      return { ok: false, reason: 'missing-slider' };
    }

    const min = Number(slider.getAttribute('aria-valuemin'));
    const max = Number(slider.getAttribute('aria-valuemax'));
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      return { ok: false, reason: 'invalid-slider-range' };
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return { ok: false, reason: 'invalid-value' };
    }

    const target = clamp(numeric, min, max);
    const callbacks = getZoomValueCallbacks(slider);
    if (!callbacks.length) {
      return { ok: false, reason: 'missing-onValueChange' };
    }

    for (const callback of callbacks) {
      try {
        callback([target]);
      } catch (_error) {
        // Ignore callback errors and continue; multiple callbacks can exist.
      }
    }

    return {
      ok: true,
      target,
      current: Number(slider.getAttribute('aria-valuenow')) || null
    };
  }

  function startLoop(hostMarker, start, end) {
    const startSeconds = Number(start);
    const endSeconds = Number(end);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return { ok: false, reason: 'invalid-range' };
    }

    const resolved = getLoopWaveSet(hostMarker);
    if (!resolved) {
      return { ok: false, reason: 'missing-wave' };
    }

    stopLoop(hostMarker);

    const loop = {
      hostMarker,
      wave: resolved.wave,
      waves: resolved.waves,
      startSeconds,
      endSeconds,
      lastTime: Number(safe(() => resolved.wave.getCurrentTime(), startSeconds)) || startSeconds,
      internalSeekUntil: 0,
      timer: null
    };

    for (const wave of loop.waves) {
      playWaveRange(wave, loop.startSeconds, loop.endSeconds);
    }
    loop.lastTime = loop.startSeconds;

    loop.timer = setInterval(() => {
      if (loops.get(hostMarker) !== loop) {
        return;
      }

      const currentTime = Number(safe(() => loop.wave.getCurrentTime(), NaN));
      if (!Number.isFinite(currentTime)) {
        return;
      }

      const now = Date.now();
      const delta = currentTime - loop.lastTime;
      if (now > loop.internalSeekUntil) {
        if (currentTime < loop.startSeconds - 0.08 || currentTime > loop.endSeconds + 0.08) {
          stopLoop(hostMarker);
          return;
        }

        if (delta < -0.08 || delta > 0.35) {
          stopLoop(hostMarker);
          return;
        }
      }

      if (currentTime >= loop.endSeconds - 0.03) {
        loop.internalSeekUntil = now + 220;
        for (const wave of loop.waves) {
          playWaveRange(wave, loop.startSeconds, loop.endSeconds);
        }
        loop.lastTime = loop.startSeconds;
        return;
      }

      loop.lastTime = currentTime;
    }, 40);

    loops.set(hostMarker, loop);

    return {
      ok: true
    };
  }

  function handleRequest(event) {
    const detail = event.detail || {};
    const id = detail.id;
    const operation = detail.operation;
    const payload = detail.payload || {};

    if (!id || !operation) {
      return;
    }

    if (operation === 'ensure') {
      respond(id, ensureLens(payload.hostMarker, payload.mountMarker, payload.height, payload.scale));
      return;
    }

    if (operation === 'update') {
      respond(id, updateLens(payload.instanceId, payload.time, payload.width, payload.height, payload.scale));
      return;
    }

    if (operation === 'destroy') {
      respond(id, destroyLens(payload.instanceId));
      return;
    }

    if (operation === 'loop-start') {
      respond(id, startLoop(payload.hostMarker, payload.startSeconds, payload.endSeconds));
      return;
    }

    if (operation === 'selection-time-range') {
      respond(id, measureSelectionTimeRange(payload.hostMarker, payload.leftPx, payload.rightPx));
      return;
    }

    if (operation === 'trim-segment-audio') {
      respond(
        id,
        findTrimTargets(
          payload.hostMarker,
          payload.startSeconds,
          payload.endSeconds,
          payload.amplitudeThreshold,
          payload.paddingSeconds
        )
      );
      return;
    }

    if (operation === 'find-segment-silence-runs') {
      respond(
        id,
        findSegmentSilenceRuns(
          payload.hostMarker,
          payload.speakerKey,
          payload.startSeconds,
          payload.endSeconds,
          payload.amplitudeThreshold,
          payload.minimumSilenceSeconds
        )
      );
      return;
    }

    if (operation === 'find-nearest-speech-island') {
      respond(
        id,
        findNearestSpeechIsland(
          payload.hostMarker,
          payload.speakerKey,
          payload.caretSeconds,
          payload.scanWindowSeconds,
          payload.amplitudeThreshold,
          payload.paddingSeconds
        )
      );
      return;
    }

    if (operation === 'resolve-visible-lane-targets') {
      respond(id, resolveVisibleLaneTargets(payload.lanes));
      return;
    }

    if (operation === 'prepare-auto-segment-text-redistribution') {
      Promise.resolve(prepareAutoSegmentTextRedistributionSession(payload))
        .then((result) => respond(id, result))
        .catch((error) =>
          respond(id, {
            ok: false,
            reason: 'prompt-api-prepare-failed',
            errorName: error && error.name ? error.name : '',
            errorMessage: error && error.message ? error.message : ''
          })
        );
      return;
    }

    if (operation === 'auto-segment-redistribute-text') {
      Promise.resolve(redistributeAutoSegmentText(payload))
        .then((result) => respond(id, result))
        .catch((error) =>
          respond(id, {
            ok: false,
            reason: 'prompt-api-redistribution-failed',
            errorName: error && error.name ? error.name : '',
            errorMessage: error && error.message ? error.message : ''
          })
        );
      return;
    }

    if (operation === 'transcribe-segment-audio') {
      Promise.resolve(transcribeSegmentAudio(payload, (progress) => respondProgress(id, progress)))
        .then((result) => respond(id, result))
        .catch((error) =>
          respond(id, {
            ok: false,
            reason: 'prompt-api-transcription-failed',
            errorName: error && error.name ? error.name : '',
            errorMessage: error && error.message ? error.message : ''
          })
        );
      return;
    }

    if (operation === 'destroy-auto-segment-text-redistribution-session') {
      respond(id, destroyAutoSegmentTextRedistributionSession(payload));
      return;
    }

    if (operation === 'trim-segment-audio-for-speaker') {
      respond(
        id,
        findTrimTargetsForSpeaker(
          payload.speakerKey,
          payload.startSeconds,
          payload.endSeconds,
          payload.amplitudeThreshold,
          payload.paddingSeconds
        )
      );
      return;
    }

    if (operation === 'extend-segment-audio-to-silence') {
      respond(
        id,
        findExtendTargets(
          payload.hostMarker,
          payload.startSeconds,
          payload.endSeconds,
          payload.amplitudeThreshold,
          payload.stepSeconds
        )
      );
      return;
    }

    if (operation === 'extend-segment-audio-to-silence-for-speaker') {
      respond(
        id,
        findExtendTargetsForSpeaker(
          payload.speakerKey,
          payload.startSeconds,
          payload.endSeconds,
          payload.amplitudeThreshold,
          payload.stepSeconds
        )
      );
      return;
    }

    if (operation === 'zoom-set') {
      respond(id, setZoomValue(payload.value));
      return;
    }

    if (operation === 'waveform-scale-unlock-enable') {
      respond(id, enableWaveformScaleUnlock(payload.max));
      return;
    }

    if (operation === 'waveform-scale-unlock-disable') {
      respond(id, unbindWaveformScaleUnlock());
      return;
    }

    if (operation === 'waveform-scale-set') {
      respond(id, setWaveformScaleByIndex(payload.index, payload.value, payload.max));
      return;
    }

    if (operation === 'loop-stop') {
      respond(id, stopLoop(payload.hostMarker));
      return;
    }

    if (operation === 'seek-source') {
      respond(id, seekSource(payload.hostMarker, payload.time));
      return;
    }

    if (operation === 'navigate-source') {
      respond(id, navigateSource(payload.hostMarker, payload.time));
      return;
    }

    if (operation === 'minimap-data') {
      respond(id, getMinimapData(payload.hostMarker, payload));
      return;
    }
  }

  function dispose() {
    for (const id of Array.from(instances.keys())) {
      destroyLens(id);
    }
    for (const hostMarker of Array.from(loops.keys())) {
      stopLoop(hostMarker);
    }
    for (const record of Array.from(promptSessions.values())) {
      destroyPromptSessionRecord(record);
    }
    promptSessions.clear();
    unbindWaveformScaleUnlock();
    window.removeEventListener(REQUEST_EVENT, handleRequest, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    delete window.__babelHelperMagnifierBridge;
  }

  window.addEventListener(REQUEST_EVENT, handleRequest, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);

  window.__babelHelperMagnifierBridge = {
    instances,
    loops,
    findTrimTargetsForSpeaker,
    findNearestSpeechIsland: findNearestSpeechIslandForResolvedWave,
    dispose
  };
}

initMagnifierBridge();

