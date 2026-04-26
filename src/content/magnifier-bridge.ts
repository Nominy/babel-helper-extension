// @ts-nocheck
export function initMagnifierBridge() {
  if (window.__babelHelperMagnifierBridge) {
    return;
  }

  const REQUEST_EVENT = 'babel-helper-magnifier-request';
  const RESPONSE_EVENT = 'babel-helper-magnifier-response';
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
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
  const waveformScaleState = {
    enabled: false,
    max: 1000,
    drag: null,
    observer: null
  };

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

    const anchor = host.parentElement instanceof HTMLElement ? host.parentElement : host;
    const fiber = getReactFiber(anchor);
    const trackFiber = findTrackFiber(fiber);
    const props = safe(() => trackFiber.memoizedProps, null);
    return props && typeof props === 'object' ? props : null;
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

    if (track && track.id != null) {
      keys.push(String(track.id));
    }

    return Array.from(new Set(keys.map(normalizeSpeakerKey).filter(Boolean)));
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

    if (!(host instanceof HTMLElement) && hosts.length === 1) {
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

    let base = minimapPeakCache.get(wave);
    if (!base || !base.length) {
      base = computeMinimapPeaksRaw(wave, cacheBins);
      if (base.length) {
        minimapPeakCache.set(wave, base);
      }
    }

    if (!base || !base.length) {
      return [];
    }

    return bins === base.length ? Array.from(base) : resamplePeaksLinear(base, bins);
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
    wave.setTime(targetTime);

    const viewport = getViewportMetrics(host, wave);
    if (viewport.scroll instanceof HTMLElement && viewport.totalWidth > 0 && viewport.visibleWidth > 0) {
      const pixelsPerSecond = getSourcePixelsPerSecond(wave);
      if (pixelsPerSecond > 0) {
        const maxScroll = Math.max(0, viewport.totalWidth - viewport.visibleWidth);
        const desiredLeft = clamp(
          targetTime * pixelsPerSecond - viewport.visibleWidth / 2,
          0,
          maxScroll
        );
        viewport.scroll.scrollLeft = desiredLeft;
        viewport.scrollLeft = desiredLeft;
      }
    }

    return {
      ok: true,
      time: targetTime,
      totalWidth: viewport.totalWidth,
      visibleWidth: viewport.visibleWidth,
      scrollLeft: viewport.scrollLeft
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
      trackProps &&
      trackProps.track &&
      typeof trackProps.track === 'object' &&
      trackProps.track.id != null
        ? String(trackProps.track.id)
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
    dispose
  };
}

initMagnifierBridge();

