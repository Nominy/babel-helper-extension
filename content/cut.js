(function registerBabelHelperCut() {
  const helper = window.__babelWorkflowHelper;
  if (!helper || helper.__cutRegistered) {
    return;
  }

  helper.__cutRegistered = true;

  const CUT_PREVIEW_ATTR = 'data-babel-helper-cut-preview';
  const CUT_PREVIEW_HANDLE_ATTR = 'data-babel-helper-cut-handle';
  const CUT_PREVIEW_MIN_SECONDS = 1;
  const CUT_PREVIEW_MIN_WIDTH = 8;
  const CUT_PREVIEW_DRAG_THRESHOLD = 5;
  const CUT_PREVIEW_HANDLE_HIT_WIDTH = 12;
  const SELECTION_LOOP_HOST_ATTR = 'data-babel-helper-selection-loop-host';
  const BRIDGE_REQUEST_EVENT = 'babel-helper-magnifier-request';
  const BRIDGE_RESPONSE_EVENT = 'babel-helper-magnifier-response';
  const BRIDGE_SCRIPT_PATH = 'content/mangifier-bridge.js';
  const BRIDGE_TIMEOUT_MS = 700;

  helper.state.cutDraft = null;
  helper.state.cutPreview = null;
  helper.state.cutCommitPending = false;
  helper.state.cutLastContainer = null;
  helper.state.smartSplitClickDraft = null;
  helper.state.smartSplitClickContext = null;
  helper.state.selectionLoop = null;
  helper.config.hotkeysHelpRows.unshift(['Shift + Ctrl/Cmd + Click', 'Run native split and redistribute words']);
  helper.config.hotkeysHelpRows.unshift(['L', 'Loop the selected range until playback caret moves']);
  helper.config.hotkeysHelpRows.unshift(['Shift + S', 'Split the selected range']);
  helper.config.hotkeysHelpRows.unshift(['S', 'Smart-split the selected range']);
  helper.config.hotkeysHelpRows.unshift(['Alt + Drag', 'Create a timeline selection']);

  let bridgeInjected = false;
  let bridgeLoadPromise = null;
  let bridgeRequestId = 0;

  function setSelectionLoopDebug(stage, details) {
    const root = document.documentElement;
    if (!(root instanceof HTMLElement)) {
      return;
    }

    root.dataset.babelHelperSelectionLoopStage = stage || '';
    if (details && typeof details === 'object') {
      try {
        root.dataset.babelHelperSelectionLoopInfo = JSON.stringify(details);
      } catch (error) {
        root.dataset.babelHelperSelectionLoopInfo = String(error && error.message ? error.message : error);
      }
    } else {
      delete root.dataset.babelHelperSelectionLoopInfo;
    }
  }

  function nextLoopMarker() {
    return 'selection-loop-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function parseTimestamp(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const parts = trimmed.split(':');
    if (parts.length < 2) {
      return null;
    }

    let total = 0;
    for (const part of parts) {
      const numeric = Number(part);
      if (!Number.isFinite(numeric)) {
        return null;
      }
      total = total * 60 + numeric;
    }

    return total;
  }

  function parseSecondsLabel(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const secondsMatch = trimmed.match(/(-?\d+(?:\.\d+)?)\s*s\b/i);
    if (secondsMatch) {
      const numeric = Number(secondsMatch[1]);
      return Number.isFinite(numeric) ? numeric : null;
    }

    return parseTimestamp(trimmed);
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

  function parseTranslateXPixels(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const match = value.match(/translateX\((-?\d+(?:\.\d+)?)px\)/i);
    if (!match) {
      return null;
    }

    const numeric = Number(match[1]);
    return Number.isFinite(numeric) ? numeric : null;
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

  function getRegionPartTokens(element) {
    const part = element instanceof Element ? element.getAttribute('part') : '';
    return part ? part.split(/\s+/).filter(Boolean) : [];
  }

  function isRegionHandle(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const tokens = getRegionPartTokens(element);
    return (
      tokens.includes('region-handle') ||
      tokens.includes('region-handle-left') ||
      tokens.includes('region-handle-right')
    );
  }

  function isRegionBody(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const tokens = getRegionPartTokens(element);
    return tokens.includes('region');
  }

  function getOwningRegionBody(element) {
    let current = element instanceof HTMLElement ? element : null;
    while (current instanceof HTMLElement) {
      if (isRegionBody(current)) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  function isSmartSplitClickEvent(event) {
    return Boolean(
      event &&
      event.button === 0 &&
      !event.altKey &&
      event.shiftKey &&
      (event.ctrlKey || event.metaKey)
    );
  }

  function getPreviewHostFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (node instanceof HTMLElement && node.hasAttribute(CUT_PREVIEW_ATTR)) {
        return node;
      }
    }

    return null;
  }

  function parseRowDurationSeconds() {
    const row = helper.getCurrentRow();
    if (!(row instanceof HTMLTableRowElement) || row.children.length < 4) {
      return null;
    }

    const start = parseTimestamp(helper.normalizeText(row.children[2]));
    const end = parseTimestamp(helper.normalizeText(row.children[3]));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }

    return end - start;
  }

  function getRegionTimeText(region, selector) {
    if (!(region instanceof HTMLElement)) {
      return '';
    }

    const tooltip = region.querySelector(selector);
    return tooltip instanceof HTMLElement ? helper.normalizeText(tooltip) : '';
  }

  function getRowTimeLabels(row) {
    if (!(row instanceof HTMLTableRowElement) || row.children.length < 4) {
      return null;
    }

    return {
      startText: helper.normalizeText(row.children[2]),
      endText: helper.normalizeText(row.children[3])
    };
  }

  function getRowTimeRange(row) {
    const labels = getRowTimeLabels(row);
    if (!labels) {
      return null;
    }

    const startSeconds = parseTimestamp(labels.startText);
    const endSeconds = parseTimestamp(labels.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return {
      startSeconds,
      endSeconds
    };
  }

  function findRowByTimeRange(startSeconds, endSeconds) {
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    const rows = helper.getTranscriptRows();
    let bestRow = null;
    let bestScore = -Infinity;

    for (const row of rows) {
      const range = getRowTimeRange(row);
      if (!range) {
        continue;
      }

      const overlap = Math.max(
        0,
        Math.min(endSeconds, range.endSeconds) - Math.max(startSeconds, range.startSeconds)
      );
      const distance =
        Math.abs(range.startSeconds - startSeconds) + Math.abs(range.endSeconds - endSeconds);
      const score = overlap > 0 ? overlap * 100 - distance : -distance;

      if (score > bestScore) {
        bestScore = score;
        bestRow = row;
      }
    }

    return bestRow;
  }

  function findRowByTimeLabels(startText, endText) {
    if (!startText || !endText) {
      return null;
    }

    const rows = helper.getTranscriptRows();
    const exactMatch =
      rows.find((row) => {
        const labels = getRowTimeLabels(row);
        return labels && labels.startText === startText && labels.endText === endText;
      }) || null;
    if (exactMatch) {
      return exactMatch;
    }

    const targetStart = parseTimestamp(startText);
    const targetEnd = parseTimestamp(endText);
    if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd) || targetEnd <= targetStart) {
      return null;
    }

    return findRowByTimeRange(targetStart, targetEnd);
  }

  async function deleteRegionByTimeLabels(startText, endText) {
    const row = findRowByTimeLabels(startText, endText);
    if (!(row instanceof HTMLTableRowElement)) {
      return false;
    }

    helper.setCurrentRow(row);
    return helper.runRowAction('deleteSegment');
  }

  function getWaveformScope(container) {
    const timelineSelector = '[part~="timeline-notch-primary"], [part~="timeline-notch-secondary"]';
    let scope = container instanceof HTMLElement ? container : null;

    while (scope instanceof HTMLElement) {
      if (scope.querySelectorAll(timelineSelector).length >= 2) {
        return scope;
      }
      scope = scope.parentElement;
    }

    const root = container && typeof container.getRootNode === 'function' ? container.getRootNode() : null;
    if (root && typeof root.querySelectorAll === 'function' && root.querySelectorAll(timelineSelector).length >= 2) {
      return root;
    }

    return root && typeof root.querySelector === 'function' ? root : null;
  }

  function getZoomSliderElement() {
    const selector =
      '[role="slider"][data-orientation="horizontal"][aria-valuemin="10"][aria-valuemax="2000"]';
    const slider = document.querySelector(selector);
    return slider instanceof HTMLElement ? slider : null;
  }

  function getZoomSliderSignature() {
    const slider = getZoomSliderElement();
    if (!(slider instanceof HTMLElement)) {
      return '';
    }

    const numericValue = Number(slider.getAttribute('aria-valuenow'));
    if (Number.isFinite(numericValue)) {
      return 'slider:' + numericValue;
    }

    const tooltip = slider.querySelector('div');
    const label = parseSecondsLabel(helper.normalizeText(tooltip));
    if (Number.isFinite(label)) {
      return 'slider-label:' + Math.round(label * 1000) / 1000;
    }

    return '';
  }

  function getWaveformWrapperElement(container) {
    const scope = getWaveformScope(container);
    if (!scope || typeof scope.querySelector !== 'function') {
      return null;
    }

    const wrapper = scope.querySelector('[part="wrapper"]');
    return wrapper instanceof HTMLElement ? wrapper : null;
  }

  function getWaveformWrapperWidth(container) {
    const wrapper = getWaveformWrapperElement(container);
    if (!(wrapper instanceof HTMLElement)) {
      return null;
    }

    const styleWidth = parsePixels(wrapper.style.width || '');
    if (Number.isFinite(styleWidth) && styleWidth > 0) {
      return styleWidth;
    }

    const rect = wrapper.getBoundingClientRect();
    return rect.width > 0 ? rect.width : null;
  }

  function getLaneTimelinePoints(container) {
    const scope = getWaveformScope(container);
    if (!scope || typeof scope.querySelectorAll !== 'function') {
      return [];
    }

    const notchSelector = '[part~="timeline-notch-primary"], [part~="timeline-notch-secondary"]';
    return Array.from(scope.querySelectorAll(notchSelector))
      .map((notch) => {
        if (!(notch instanceof HTMLElement)) {
          return null;
        }

        const seconds = parseSecondsLabel(helper.normalizeText(notch));
        const leftPx = parsePixels(notch.style.left || '');
        if (!Number.isFinite(seconds) || !Number.isFinite(leftPx)) {
          return null;
        }

        return {
          seconds,
          leftPx
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.leftPx - right.leftPx);
  }

  function getLaneZoomSignature(container) {
    const zoomSliderSignature = getZoomSliderSignature();
    if (zoomSliderSignature) {
      return zoomSliderSignature;
    }

    const wrapperWidth = getWaveformWrapperWidth(container);
    if (Number.isFinite(wrapperWidth) && wrapperWidth > 0) {
      return 'wrapper:' + Math.round(wrapperWidth * 10) / 10;
    }

    const timeScale = getLaneTimeScale(container);
    if (timeScale && Number.isFinite(timeScale.secondsPerPx) && timeScale.secondsPerPx > 0) {
      return 'scale:' + Math.round(timeScale.secondsPerPx * 1000000) / 1000000;
    }

    const regionSecondsPerPx = getLaneSecondsPerPixelFromRegions(container);
    if (Number.isFinite(regionSecondsPerPx) && regionSecondsPerPx > 0) {
      return 'region-scale:' + Math.round(regionSecondsPerPx * 1000000) / 1000000;
    }

    return '';
  }

  function getLaneTimeScale(container) {
    const scope = getWaveformScope(container);
    if (!scope || typeof scope.querySelector !== 'function') {
      return null;
    }

    const points = getLaneTimelinePoints(container);

    if (points.length >= 2) {
      const first = points[0];
      const last = points[points.length - 1];
      const dx = last.leftPx - first.leftPx;
      const dt = last.seconds - first.seconds;
      if (dx !== 0 && dt > 0) {
        const secondsPerPx = dt / dx;
        return {
          secondsPerPx,
          offsetSeconds: first.seconds - first.leftPx * secondsPerPx
        };
      }
    }

    const hover = typeof scope.querySelector === 'function' ? scope.querySelector('[part="hover"]') : null;
    const hoverLabel =
      hover instanceof HTMLElement ? hover.querySelector('[part="hover-label"]') : null;
    const hoverSeconds = parseSecondsLabel(helper.normalizeText(hoverLabel));
    const hoverPx =
      hover instanceof HTMLElement
        ? parseTranslateXPixels(hover.style.transform || '')
        : null;

    if (Number.isFinite(hoverSeconds) && Number.isFinite(hoverPx)) {
      const secondsPerPixel = getLaneSecondsPerPixelFromRegions(container);
      if (Number.isFinite(secondsPerPixel) && secondsPerPixel > 0) {
        return {
          secondsPerPx: secondsPerPixel,
          offsetSeconds: hoverSeconds - hoverPx * secondsPerPixel
        };
      }
    }

    return null;
  }

  function getLaneSecondsPerPixelFromRegions(container) {
    const ratios = getRegionElements(container)
      .map((region) => {
        const start = parseTimestamp(getRegionTimeText(region, '.wavesurfer-region-tooltip-start'));
        const end = parseTimestamp(getRegionTimeText(region, '.wavesurfer-region-tooltip-end'));
        const width = region.getBoundingClientRect().width;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || width <= 0) {
          return null;
        }

        return (end - start) / width;
      })
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);

    if (!ratios.length) {
      return null;
    }

    const middle = Math.floor(ratios.length / 2);
    if (ratios.length % 2 === 1) {
      return ratios[middle];
    }

    return (ratios[middle - 1] + ratios[middle]) / 2;
  }

  function getPreviewDurationSeconds(preview) {
    if (!preview) {
      return null;
    }

    const previewWidth = preview.rightPx - preview.leftPx;
    if (previewWidth <= 0) {
      return null;
    }

    const laneTimeScale = preview.timeScale || getLaneTimeScale(preview.container);
    if (laneTimeScale && Number.isFinite(laneTimeScale.secondsPerPx) && laneTimeScale.secondsPerPx > 0) {
      const startSeconds = laneTimeScale.offsetSeconds + preview.leftPx * laneTimeScale.secondsPerPx;
      const endSeconds = laneTimeScale.offsetSeconds + preview.rightPx * laneTimeScale.secondsPerPx;
      const duration = endSeconds - startSeconds;
      if (duration > 0) {
        return duration;
      }
    }

    const laneSecondsPerPixel = getLaneSecondsPerPixelFromRegions(preview.container);
    if (Number.isFinite(laneSecondsPerPixel) && laneSecondsPerPixel > 0) {
      return previewWidth * laneSecondsPerPixel;
    }

    if (preview.sourceRegion instanceof HTMLElement && preview.sourceRegion.isConnected) {
      const sourceDuration = parseRowDurationSeconds();
      const sourceWidth = preview.sourceRegion.getBoundingClientRect().width;
      if (Number.isFinite(sourceDuration) && sourceDuration > 0 && sourceWidth > 0) {
        return sourceDuration * (previewWidth / sourceWidth);
      }
    }

    return null;
  }

  function getPreviewTimeRange(preview) {
    if (!preview) {
      return null;
    }

    const previewWidth = preview.rightPx - preview.leftPx;
    if (previewWidth <= 0) {
      return null;
    }

    const waveformEntry = getWaveformEntryForContainer(preview.container);
    const wavesurfer =
      waveformEntry && typeof waveformEntry === 'object' ? waveformEntry.wavesurfer : null;
    if (wavesurfer && typeof wavesurfer === 'object') {
      const pixelsPerSecond =
        Number(
          wavesurfer.options && typeof wavesurfer.options === 'object'
            ? wavesurfer.options.minPxPerSec
            : NaN
        ) ||
        (typeof wavesurfer.getWidth === 'function' &&
        typeof wavesurfer.getDuration === 'function' &&
        Number.isFinite(wavesurfer.getWidth()) &&
        Number.isFinite(wavesurfer.getDuration()) &&
        wavesurfer.getDuration() > 0
          ? wavesurfer.getWidth() / wavesurfer.getDuration()
          : NaN);
      const scrollPx =
        typeof wavesurfer.getScroll === 'function' ? Number(wavesurfer.getScroll()) : 0;
      if (Number.isFinite(pixelsPerSecond) && pixelsPerSecond > 0) {
        const startSeconds = (scrollPx + preview.leftPx) / pixelsPerSecond;
        const endSeconds = (scrollPx + preview.rightPx) / pixelsPerSecond;
        if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds) {
          return {
            startSeconds,
            endSeconds
          };
        }
      }
    }

    const laneTimeScale = preview.timeScale || getLaneTimeScale(preview.container);
    if (laneTimeScale && Number.isFinite(laneTimeScale.secondsPerPx) && laneTimeScale.secondsPerPx > 0) {
      const startSeconds = laneTimeScale.offsetSeconds + preview.leftPx * laneTimeScale.secondsPerPx;
      const endSeconds = laneTimeScale.offsetSeconds + preview.rightPx * laneTimeScale.secondsPerPx;
      if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds) {
        return {
          startSeconds,
          endSeconds
        };
      }
    }

    const laneSecondsPerPixel = getLaneSecondsPerPixelFromRegions(preview.container);
    if (Number.isFinite(laneSecondsPerPixel) && laneSecondsPerPixel > 0) {
      const startSeconds = preview.leftPx * laneSecondsPerPixel;
      const endSeconds = preview.rightPx * laneSecondsPerPixel;
      if (endSeconds > startSeconds) {
        return {
          startSeconds,
          endSeconds
        };
      }
    }

    return null;
  }

  function getSelectionAudioElement() {
    const audio = document.querySelector('audio');
    return audio instanceof HTMLMediaElement ? audio : null;
  }

  function injectSelectionBridge() {
    if (bridgeInjected && window.__babelHelperMagnifierBridge) {
      return Promise.resolve(true);
    }

    if (bridgeLoadPromise) {
      return bridgeLoadPromise;
    }

    bridgeLoadPromise = new Promise((resolve) => {
      const parent = document.documentElement || document.head || document.body;
      if (
        !parent ||
        typeof chrome === 'undefined' ||
        !chrome.runtime ||
        typeof chrome.runtime.getURL !== 'function'
      ) {
        bridgeLoadPromise = null;
        resolve(false);
        return;
      }

      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(BRIDGE_SCRIPT_PATH);
      script.async = false;
      script.onload = () => {
        script.remove();
        bridgeInjected = true;
        resolve(true);
      };
      script.onerror = () => {
        script.remove();
        bridgeLoadPromise = null;
        resolve(false);
      };

      parent.appendChild(script);
    });

    return bridgeLoadPromise;
  }

  async function callSelectionBridge(operation, payload) {
    const ready = await injectSelectionBridge();
    if (!ready) {
      return null;
    }

    return new Promise((resolve) => {
      bridgeRequestId += 1;
      const id = 'cut-loop-request-' + bridgeRequestId;
      let settled = false;

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        window.removeEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
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

      const timeoutId = window.setTimeout(() => finish(null), BRIDGE_TIMEOUT_MS);
      window.addEventListener(BRIDGE_RESPONSE_EVENT, handleResponse, true);
      window.dispatchEvent(
        new CustomEvent(BRIDGE_REQUEST_EVENT, {
          detail: {
            id,
            operation,
            payload: payload || {}
          }
        })
      );
    });
  }

  function getWaveformHostFromContainer(container) {
    if (!(container instanceof HTMLElement) || typeof container.getRootNode !== 'function') {
      return null;
    }

    const root = container.getRootNode();
    return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
  }

  function getWaveformRegistryFromHost(host) {
    let fiber = getReactFiber(host);
    if (!fiber && host instanceof HTMLElement) {
      fiber = getReactFiber(host.parentElement);
    }

    let owner = fiber;
    let ownerDepth = 0;
    while (owner && typeof owner === 'object' && ownerDepth < 16) {
      let hook = owner.memoizedState;
      let hookIndex = 0;
      while (hook && typeof hook === 'object' && hookIndex < 24) {
        const value = hook.memoizedState;
        const current =
          value && typeof value === 'object' && !Array.isArray(value) && value.current
            ? value.current
            : null;
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          const keys = Object.keys(current);
          const hasWaveEntry = keys.some((key) => {
            const entry = current[key];
            return entry && typeof entry === 'object' && entry.wavesurfer;
          });
          if (hasWaveEntry) {
            return current;
          }
        }

        hook = hook.next;
        hookIndex += 1;
      }

      owner = owner.return;
      ownerDepth += 1;
    }

    return null;
  }

  function getWaveformEntryForContainer(container) {
    const host = getWaveformHostFromContainer(container);
    if (!(host instanceof HTMLElement)) {
      return null;
    }

    const registry = getWaveformRegistryFromHost(host);
    if (!registry || typeof registry !== 'object') {
      return null;
    }

    let fallbackEntry = null;
    for (const key of Object.keys(registry)) {
      const entry = registry[key];
      const wavesurfer =
        entry && typeof entry === 'object' && entry.wavesurfer ? entry.wavesurfer : null;
      if (!wavesurfer || typeof wavesurfer !== 'object') {
        continue;
      }

      if (!fallbackEntry) {
        fallbackEntry = entry;
      }

      const wrapper =
        typeof wavesurfer.getWrapper === 'function' ? wavesurfer.getWrapper() : null;
      const wrapperHost =
        wrapper && typeof wrapper.getRootNode === 'function'
          ? wrapper.getRootNode().host
          : null;
      if (
        wavesurfer.container === host ||
        wavesurfer.container === container ||
        wrapper === container ||
        wrapperHost === host
      ) {
        return entry;
      }
    }

    return fallbackEntry;
  }

  function getSelectionPlaybackTarget(preview) {
    const entry = getWaveformEntryForContainer(preview && preview.container);
    const wavesurfer =
      entry && typeof entry === 'object' && entry.wavesurfer ? entry.wavesurfer : null;
    if (
      wavesurfer &&
      typeof wavesurfer.getCurrentTime === 'function' &&
      typeof wavesurfer.setTime === 'function'
    ) {
      return {
        kind: 'wavesurfer',
        getCurrentTime() {
          const time = Number(wavesurfer.getCurrentTime());
          return Number.isFinite(time) ? time : null;
        },
        setTime(seconds) {
          wavesurfer.setTime(seconds);
        },
        play() {
          if (typeof wavesurfer.play === 'function') {
            return wavesurfer.play();
          }
          return null;
        },
        playRange(startSeconds, endSeconds) {
          if (typeof wavesurfer.play === 'function') {
            return wavesurfer.play(startSeconds, endSeconds);
          }
          wavesurfer.setTime(startSeconds);
          if (typeof wavesurfer.play === 'function') {
            return wavesurfer.play();
          }
          return null;
        },
        isPaused() {
          if (typeof wavesurfer.isPlaying === 'function') {
            return !wavesurfer.isPlaying();
          }
          if (wavesurfer.media && 'paused' in wavesurfer.media) {
            return Boolean(wavesurfer.media.paused);
          }
          return false;
        }
      };
    }

    const audio = getSelectionAudioElement();
    if (!(audio instanceof HTMLMediaElement)) {
      return null;
    }

    return {
      kind: 'audio',
      getCurrentTime() {
        const time = Number(audio.currentTime);
        return Number.isFinite(time) ? time : null;
      },
      setTime(seconds) {
        audio.currentTime = seconds;
      },
      play() {
        return typeof audio.play === 'function' ? audio.play() : null;
      },
      playRange(startSeconds) {
        audio.currentTime = startSeconds;
        return typeof audio.play === 'function' ? audio.play() : null;
      },
      isPaused() {
        return Boolean(audio.paused);
      }
    };
  }

  function updatePreviewElement() {
    const preview = helper.state.cutPreview;
    if (!preview || !(preview.element instanceof HTMLElement)) {
      return;
    }

    preview.element.style.left = preview.leftPx + 'px';
    preview.element.style.width = Math.max(CUT_PREVIEW_MIN_WIDTH, preview.rightPx - preview.leftPx) + 'px';

    const duration = getPreviewDurationSeconds(preview);
    const label = preview.element.querySelector('[data-babel-helper-cut-label]');
    const tooShort = Number.isFinite(duration) && duration < CUT_PREVIEW_MIN_SECONDS;
    preview.element.style.background = tooShort
      ? 'rgba(239, 68, 68, 0.18)'
      : 'rgba(14, 165, 233, 0.16)';
    preview.element.style.borderColor = tooShort ? 'rgba(220, 38, 38, 0.95)' : 'rgba(2, 132, 199, 0.95)';

    if (label instanceof HTMLElement) {
      label.textContent = Number.isFinite(duration)
        ? duration.toFixed(2) + 's'
        : 'Selection';
      label.style.background = tooShort ? 'rgba(127, 29, 29, 0.92)' : 'rgba(15, 23, 42, 0.82)';
    }
  }

  function clearCutDraft() {
    helper.state.cutDraft = null;
  }

  function rememberCutContainer(container) {
    if (container instanceof HTMLElement && container.isConnected) {
      helper.state.cutLastContainer = container;
    }
  }

  helper.stopSelectionLoop = function stopSelectionLoop() {
    const loop = helper.state.selectionLoop;
    if (!loop) {
      return;
    }

    if (loop.timer) {
      window.clearInterval(loop.timer);
    }

    if (loop.hostMarker) {
      void callSelectionBridge('loop-stop', {
        hostMarker: loop.hostMarker
      });
    }

    if (
      loop.host instanceof HTMLElement &&
      loop.hostMarker &&
      loop.host.getAttribute(SELECTION_LOOP_HOST_ATTR) === loop.hostMarker
    ) {
      loop.host.removeAttribute(SELECTION_LOOP_HOST_ATTR);
    }

    helper.state.selectionLoop = null;
  };

  helper.clearCutPreview = function clearCutPreview() {
    const preview = helper.state.cutPreview;
    helper.stopSelectionLoop();
    if (preview && preview.zoomObserver) {
      preview.zoomObserver.disconnect();
    }

    if (preview && preview.element && preview.element.isConnected) {
      preview.element.remove();
    }

    helper.state.cutPreview = null;
    helper.state.cutCommitPending = false;
    clearCutDraft();
  };

  helper.startSelectionLoop = async function startSelectionLoop() {
    const preview = helper.state.cutPreview;
    if (!preview || helper.state.cutCommitPending) {
      setSelectionLoopDebug(!preview ? 'no-preview' : 'commit-pending');
      return false;
    }

    const timeRange = getPreviewTimeRange(preview);
    if (!timeRange) {
      setSelectionLoopDebug('no-time-range');
      return false;
    }

    const playback = getSelectionPlaybackTarget(preview);
    if (!playback) {
      setSelectionLoopDebug('no-playback');
      return false;
    }

    const existing = helper.state.selectionLoop;
    if (
      existing &&
      existing.preview === preview &&
      Math.abs(existing.startSeconds - timeRange.startSeconds) < 0.01 &&
      Math.abs(existing.endSeconds - timeRange.endSeconds) < 0.01
    ) {
      setSelectionLoopDebug('toggle-off', {
        startSeconds: timeRange.startSeconds,
        endSeconds: timeRange.endSeconds,
        kind: playback.kind || 'unknown'
      });
      helper.stopSelectionLoop();
      return true;
    }

    helper.stopSelectionLoop();

    const host = getWaveformHostFromContainer(preview.container);
    if (host instanceof HTMLElement) {
      const hostMarker = nextLoopMarker();
      host.setAttribute(SELECTION_LOOP_HOST_ATTR, hostMarker);
      const bridgeResult = await callSelectionBridge('loop-start', {
        hostMarker,
        startSeconds: timeRange.startSeconds,
        endSeconds: timeRange.endSeconds
      });
      if (bridgeResult && bridgeResult.ok) {
        helper.state.selectionLoop = {
          preview,
          host,
          hostMarker,
          startSeconds: timeRange.startSeconds,
          endSeconds: timeRange.endSeconds,
          timer: null
        };
        setSelectionLoopDebug('started', {
          startSeconds: timeRange.startSeconds,
          endSeconds: timeRange.endSeconds,
          kind: 'bridge'
        });
        return true;
      }

      host.removeAttribute(SELECTION_LOOP_HOST_ATTR);
      if (bridgeResult && bridgeResult.reason) {
        setSelectionLoopDebug('bridge-' + bridgeResult.reason);
      } else {
        setSelectionLoopDebug('bridge-failed');
      }
    }

    const loop = {
      preview,
      playback,
      startSeconds: timeRange.startSeconds,
      endSeconds: timeRange.endSeconds,
      lastTime: playback.getCurrentTime() || 0,
      internalSeekUntil: 0,
      timer: null
    };

    const runTick = () => {
      if (helper.state.selectionLoop !== loop) {
        return;
      }

      const activePreview = helper.state.cutPreview;
      if (!activePreview || activePreview !== preview) {
        setSelectionLoopDebug('lost-preview');
        helper.stopSelectionLoop();
        return;
      }

      const currentRange = getPreviewTimeRange(activePreview);
      if (!currentRange) {
        setSelectionLoopDebug('lost-range');
        helper.stopSelectionLoop();
        return;
      }

      loop.startSeconds = currentRange.startSeconds;
      loop.endSeconds = currentRange.endSeconds;

      const currentTime = loop.playback.getCurrentTime();
      if (!Number.isFinite(currentTime)) {
        return;
      }

      const now = Date.now();
      const delta = currentTime - loop.lastTime;
      if (now > loop.internalSeekUntil) {
        if (currentTime < loop.startSeconds - 0.08 || currentTime > loop.endSeconds + 0.08) {
          setSelectionLoopDebug('escaped-range', {
            currentTime,
            startSeconds: loop.startSeconds,
            endSeconds: loop.endSeconds,
            delta
          });
          helper.stopSelectionLoop();
          return;
        }

        if (delta < -0.08 || delta > 0.35) {
          setSelectionLoopDebug('user-move', {
            currentTime,
            startSeconds: loop.startSeconds,
            endSeconds: loop.endSeconds,
            delta
          });
          helper.stopSelectionLoop();
          return;
        }
      }

      if (currentTime >= loop.endSeconds - 0.03) {
        loop.internalSeekUntil = now + 220;
        const playResult =
          typeof loop.playback.playRange === 'function'
            ? loop.playback.playRange(loop.startSeconds, loop.endSeconds)
            : (loop.playback.setTime(loop.startSeconds), loop.playback.play());
        if (playResult && typeof playResult.catch === 'function') {
          playResult.catch(() => {});
        }
        loop.lastTime = loop.startSeconds;
        return;
      }

      loop.lastTime = currentTime;
    };

    if (
      !Number.isFinite(loop.lastTime) ||
      loop.lastTime < loop.startSeconds ||
      loop.lastTime > loop.endSeconds
    ) {
      loop.internalSeekUntil = Date.now() + 220;
      loop.lastTime = loop.startSeconds;
    }

    const playResult =
      typeof loop.playback.playRange === 'function'
        ? loop.playback.playRange(loop.startSeconds, loop.endSeconds)
        : (loop.playback.setTime(loop.startSeconds), loop.playback.play());
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => {});
    }

    loop.timer = window.setInterval(runTick, 40);
    helper.state.selectionLoop = loop;
    setSelectionLoopDebug('started', {
      startSeconds: loop.startSeconds,
      endSeconds: loop.endSeconds,
      kind: loop.playback.kind || 'unknown'
    });
    return true;
  };

  function cancelCutPreviewIfZoomChanged() {
    const preview = helper.state.cutPreview;
    if (!preview || !preview.zoomSignature || !(preview.container instanceof HTMLElement)) {
      return false;
    }

    if (getLaneZoomSignature(preview.container) === preview.zoomSignature) {
      return false;
    }

    helper.clearCutPreview();
    return true;
  }

  function startCutPreviewZoomWatcher(preview) {
    if (!preview || !(preview.container instanceof HTMLElement)) {
      return;
    }

    const zoomSlider = getZoomSliderElement();
    if (!(zoomSlider instanceof HTMLElement) || typeof MutationObserver !== 'function') {
      return;
    }

    const observer = new MutationObserver(() => {
      const activePreview = helper.state.cutPreview;
      if (!activePreview || activePreview !== preview || helper.state.cutCommitPending) {
        return;
      }

      if (activePreview.zoomSignature && getLaneZoomSignature(activePreview.container) !== activePreview.zoomSignature) {
        helper.clearCutPreview();
      }
    });

    observer.observe(zoomSlider, {
      attributes: true,
      attributeFilter: ['aria-valuenow', 'style']
    });

    preview.zoomObserver = observer;
  }

  function createPreviewFromDraft(draft, clientX) {
    const localX = clamp(clientX - draft.containerRect.left, draft.regionLeftPx, draft.regionRightPx);
    const startX = clamp(draft.startClientX - draft.containerRect.left, draft.regionLeftPx, draft.regionRightPx);
    const leftPx = Math.min(startX, localX);
    const rightPx = Math.max(startX, localX);

    const preview = document.createElement('div');
    preview.setAttribute(CUT_PREVIEW_ATTR, 'true');
    preview.style.position = 'absolute';
    preview.style.top = '0';
    preview.style.height = '100%';
    preview.style.boxSizing = 'border-box';
    preview.style.border = '2px solid rgba(2, 132, 199, 0.95)';
    preview.style.borderRadius = '3px';
    preview.style.pointerEvents = 'auto';
    preview.style.cursor = 'default';
    preview.style.zIndex = '6';
    preview.style.touchAction = 'none';

    const leftHandle = document.createElement('div');
    leftHandle.setAttribute(CUT_PREVIEW_HANDLE_ATTR, 'left');
    leftHandle.style.position = 'absolute';
    leftHandle.style.left = '0';
    leftHandle.style.top = '0';
    leftHandle.style.width = '8px';
    leftHandle.style.height = '100%';
    leftHandle.style.cursor = 'ew-resize';

    const rightHandle = document.createElement('div');
    rightHandle.setAttribute(CUT_PREVIEW_HANDLE_ATTR, 'right');
    rightHandle.style.position = 'absolute';
    rightHandle.style.right = '0';
    rightHandle.style.top = '0';
    rightHandle.style.width = '8px';
    rightHandle.style.height = '100%';
    rightHandle.style.cursor = 'ew-resize';

    const label = document.createElement('div');
    label.setAttribute('data-babel-helper-cut-label', 'true');
    label.style.position = 'absolute';
    label.style.left = '50%';
    label.style.top = '4px';
    label.style.transform = 'translateX(-50%)';
    label.style.padding = '2px 6px';
    label.style.borderRadius = '999px';
    label.style.fontSize = '10px';
    label.style.fontWeight = '700';
    label.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
    label.style.color = '#f8fafc';
    label.style.pointerEvents = 'none';
    label.style.whiteSpace = 'nowrap';

    const modeBadge = document.createElement('div');
    modeBadge.setAttribute('data-babel-helper-cut-mode', 'true');
    modeBadge.textContent = 'Selection';
    modeBadge.style.position = 'absolute';
    modeBadge.style.left = '6px';
    modeBadge.style.top = '4px';
    modeBadge.style.padding = '2px 6px';
    modeBadge.style.borderRadius = '999px';
    modeBadge.style.fontSize = '10px';
    modeBadge.style.fontWeight = '700';
    modeBadge.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
    modeBadge.style.color = '#e0f2fe';
    modeBadge.style.background = 'rgba(3, 105, 161, 0.88)';
    modeBadge.style.pointerEvents = 'none';
    modeBadge.style.whiteSpace = 'nowrap';

    preview.appendChild(leftHandle);
    preview.appendChild(rightHandle);
    preview.appendChild(label);
    preview.appendChild(modeBadge);
    draft.container.appendChild(preview);
    rememberCutContainer(draft.container);

    const timeScale = getLaneTimeScale(draft.container);
    const zoomSignature = getLaneZoomSignature(draft.container);

    helper.state.cutPreview = {
      pointerId: draft.pointerId,
      sourceRegion: draft.sourceRegion,
      container: draft.container,
      containerRect: draft.containerRect,
      regionLeftPx: draft.regionLeftPx,
      regionRightPx: draft.regionRightPx,
      leftPx,
      rightPx,
      element: preview,
      timeScale,
      zoomSignature,
      dragMode: 'create',
      dragStartClientX: draft.startClientX,
      originLeftPx: leftPx,
      originRightPx: rightPx
    };

    clearCutDraft();
    startCutPreviewZoomWatcher(helper.state.cutPreview);
    updatePreviewElement();
  }

  function beginPreviewDrag(event) {
    const previewElement = getPreviewHostFromEvent(event);
    const preview = helper.state.cutPreview;
    if (!(previewElement instanceof HTMLElement) || !preview) {
      return false;
    }

    const previewRect = previewElement.getBoundingClientRect();
    const localX = event.clientX - previewRect.left;
    const nearLeftEdge = localX <= CUT_PREVIEW_HANDLE_HIT_WIDTH;
    const nearRightEdge = localX >= previewRect.width - CUT_PREVIEW_HANDLE_HIT_WIDTH;

    preview.pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    preview.dragStartClientX = event.clientX;
    preview.originLeftPx = preview.leftPx;
    preview.originRightPx = preview.rightPx;
    helper.stopSelectionLoop();
    if (nearLeftEdge && !nearRightEdge) {
      preview.dragMode = 'resize-left';
    } else if (nearRightEdge) {
      preview.dragMode = 'resize-right';
    } else {
      preview.dragMode = 'locked';
    }

    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function updatePreviewDrag(event) {
    const preview = helper.state.cutPreview;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (!preview || preview.pointerId !== pointerId || !preview.dragMode) {
      return false;
    }

    const dx = event.clientX - preview.dragStartClientX;
    const minWidth = CUT_PREVIEW_MIN_WIDTH;
    if (preview.dragMode === 'create') {
      const currentX = clamp(
        event.clientX - preview.containerRect.left,
        preview.regionLeftPx,
        preview.regionRightPx
      );
      const startX = clamp(
        preview.dragStartClientX - preview.containerRect.left,
        preview.regionLeftPx,
        preview.regionRightPx
      );
      preview.leftPx = Math.min(startX, currentX);
      preview.rightPx = Math.max(preview.leftPx + minWidth, currentX);
      preview.rightPx = Math.min(preview.rightPx, preview.regionRightPx);
    } else if (preview.dragMode === 'resize-left') {
      preview.leftPx = clamp(
        preview.originLeftPx + dx,
        preview.regionLeftPx,
        preview.rightPx - minWidth
      );
    } else if (preview.dragMode === 'resize-right') {
      preview.rightPx = clamp(
        preview.originRightPx + dx,
        preview.leftPx + minWidth,
        preview.regionRightPx
      );
    } else if (preview.dragMode === 'locked') {
      // Absorb preview-body drags so they do not fall through to Babel.
    } else {
      return false;
    }

    updatePreviewElement();
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function endPreviewDrag(event) {
    const preview = helper.state.cutPreview;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (!preview || preview.pointerId !== pointerId || !preview.dragMode) {
      return false;
    }

    preview.dragMode = null;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function getRegionDraft(event) {
    if (
      event.button !== 0 ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return null;
    }

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    let sourceRegion = null;
    let container = null;

    for (const node of path) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (node.hasAttribute(CUT_PREVIEW_ATTR)) {
        return null;
      }

      if (isRegionHandle(node)) {
        return null;
      }

      if (!sourceRegion && isRegionBody(node)) {
        sourceRegion = node;
        if (node.parentElement instanceof HTMLElement) {
          container = node.parentElement;
        }
      }

      if (!container && getRegionElements(node).length) {
        container = node;
      }

      if (
        !container &&
        helper.state.cutLastContainer instanceof HTMLElement &&
        (node === helper.state.cutLastContainer || helper.state.cutLastContainer.contains(node))
      ) {
        container = helper.state.cutLastContainer;
      }
    }

    if (!(container instanceof HTMLElement)) {
      return null;
    }

    const containerRect = container.getBoundingClientRect();
    if (containerRect.width <= 0) {
      return null;
    }

    rememberCutContainer(container);

    return {
      pointerId: typeof event.pointerId === 'number' ? event.pointerId : 1,
      sourceRegion,
      container,
      containerRect,
      regionLeftPx: 0,
      regionRightPx: containerRect.width,
      startClientX: clamp(event.clientX, containerRect.left, containerRect.right)
    };
  }

  function dispatchSplitClick(target, clientX, clientY) {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const useMeta = /\bMac\b/i.test(navigator.platform || '');
    target.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX,
        clientY,
        button: 0,
        buttons: 0,
        detail: 1,
        ctrlKey: !useMeta,
        metaKey: useMeta
      })
    );
  }

  function getRegionElements(container) {
    if (!(container instanceof HTMLElement)) {
      return [];
    }

    return Array.from(container.children).filter((child) => isRegionBody(child));
  }

  function getRegionBounds(region, containerRect) {
    if (!(region instanceof HTMLElement)) {
      return null;
    }

    const rect = region.getBoundingClientRect();
    return {
      region,
      rect,
      leftPx: rect.left - containerRect.left,
      rightPx: rect.right - containerRect.left,
      startText: getRegionTimeText(region, '.wavesurfer-region-tooltip-start'),
      endText: getRegionTimeText(region, '.wavesurfer-region-tooltip-end')
    };
  }

  function collectRegionSnapshot(container) {
    const containerRect = container instanceof HTMLElement ? container.getBoundingClientRect() : null;
    if (!containerRect || containerRect.width <= 0) {
      return null;
    }

    const bounds = getRegionElements(container)
      .map((region) => getRegionBounds(region, containerRect))
      .filter(Boolean)
      .sort((left, right) => left.leftPx - right.leftPx);

    if (!bounds.length) {
      return null;
    }

    return {
      containerRect,
      bounds
    };
  }

  function getSnapshotSignature(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.bounds)) {
      return '';
    }

    return snapshot.bounds
      .map((entry) => {
        const left = Math.round(entry.leftPx * 10) / 10;
        const right = Math.round(entry.rightPx * 10) / 10;
        return left + ':' + right;
      })
      .join('|');
  }

  async function waitForRegionRefresh(container, previousSignature) {
    const updated = await helper.waitFor(() => {
      const snapshot = collectRegionSnapshot(container);
      if (!snapshot) {
        return null;
      }

      return getSnapshotSignature(snapshot) !== previousSignature ? snapshot : null;
    }, 900, 40);

    return updated || collectRegionSnapshot(container);
  }

  async function waitForRegionChange(container, previousSignature) {
    return helper.waitFor(() => {
      const snapshot = collectRegionSnapshot(container);
      if (!snapshot) {
        return null;
      }

      return getSnapshotSignature(snapshot) !== previousSignature ? snapshot : null;
    }, 900, 40);
  }

  function collectOverlapPlan(snapshot, cutLeftPx, cutRightPx) {
    if (!snapshot || !Array.isArray(snapshot.bounds) || !snapshot.bounds.length) {
      return null;
    }

    const tolerance = 1;
    const overlapping = snapshot.bounds.filter((entry) => entry.rightPx > cutLeftPx + tolerance && entry.leftPx < cutRightPx - tolerance);
    if (!overlapping.length) {
      return {
        overlapping: [],
        toDelete: [],
        trimLeft: null,
        trimRight: null,
        splitRequired: false,
        splitRegion: null
      };
    }

    let trimLeft = null;
    let trimRight = null;
    let splitRegion = null;
    const toDelete = [];

    for (const entry of overlapping) {
      const coversLeft = entry.leftPx < cutLeftPx - tolerance && entry.rightPx > cutLeftPx + tolerance;
      const coversRight = entry.leftPx < cutRightPx - tolerance && entry.rightPx > cutRightPx + tolerance;
      const fullyInside = entry.leftPx >= cutLeftPx - tolerance && entry.rightPx <= cutRightPx + tolerance;

      if (coversLeft && coversRight) {
        splitRegion = entry;
      } else if (coversLeft) {
        trimLeft = entry;
      } else if (coversRight) {
        trimRight = entry;
      } else if (fullyInside) {
        toDelete.push(entry);
      }
    }

    return {
      overlapping,
      toDelete,
      trimLeft,
      trimRight,
      splitRequired: Boolean(splitRegion),
      splitRegion
    };
  }

  function findReconciliationTargets(snapshot, cutLeftPx, cutRightPx, options) {
    const settings = options || {};
    const includePrevious = settings.includePrevious !== false;
    const includeNext = settings.includeNext !== false;
    const containerRect =
      snapshot && snapshot.containerRect
        ? snapshot.containerRect
        : settings.containerRect || null;

    if (!containerRect) {
      return null;
    }

    const bounds = snapshot && Array.isArray(snapshot.bounds) ? snapshot.bounds : [];
    let previous = null;
    let next = null;

    if (includePrevious) {
      for (const entry of bounds) {
        if (entry.leftPx >= cutLeftPx - 1) {
          continue;
        }

        if (!previous || entry.rightPx > previous.rightPx) {
          previous = entry;
        }
      }
    }

    if (includeNext) {
      for (const entry of bounds) {
        if (entry.rightPx <= cutRightPx + 1) {
          continue;
        }

        next = entry;
        break;
      }
    }

    return {
      containerRect,
      previous,
      next
    };
  }

  function getRowsForCompletedSmartSplit(sourceRow, sourceRowIndex) {
    const rows = helper.getTranscriptRows();
    if (!rows.length || sourceRowIndex < 0 || sourceRowIndex >= rows.length) {
      return null;
    }

    if (sourceRow instanceof HTMLTableRowElement && sourceRow.isConnected) {
      const liveIndex = rows.indexOf(sourceRow);
      if (liveIndex >= 0) {
        if (liveIndex > sourceRowIndex && rows[liveIndex - 1] instanceof HTMLTableRowElement) {
          return {
            leftRow: rows[liveIndex - 1],
            rightRow: sourceRow
          };
        }

        if (rows[liveIndex + 1] instanceof HTMLTableRowElement) {
          return {
            leftRow: sourceRow,
            rightRow: rows[liveIndex + 1]
          };
        }

        if (liveIndex > 0 && rows[liveIndex - 1] instanceof HTMLTableRowElement) {
          return {
            leftRow: rows[liveIndex - 1],
            rightRow: sourceRow
          };
        }
      }
    }

    const leftRow = rows[sourceRowIndex];
    const rightRow = rows[sourceRowIndex + 1];
    if (!(leftRow instanceof HTMLTableRowElement) || !(rightRow instanceof HTMLTableRowElement)) {
      return null;
    }

    return {
      leftRow,
      rightRow
    };
  }

  async function waitForSmartSplitRows(sourceRow, sourceRowIndex, previousRowCount) {
    if (sourceRowIndex < 0 || !Number.isFinite(previousRowCount)) {
      return null;
    }

    return helper.waitFor(() => {
      const rows = helper.getTranscriptRows();
      if (rows.length < previousRowCount + 1) {
        return null;
      }

      return getRowsForCompletedSmartSplit(sourceRow, sourceRowIndex);
    }, 1200, 40);
  }

  function captureRowSnapshot() {
    return helper.getTranscriptRows().map((row) => {
      const labels = getRowTimeLabels(row) || {
        startText: '',
        endText: ''
      };
      return {
        row,
        startText: labels.startText,
        endText: labels.endText,
        text: helper.getRowTextValue(row).trim()
      };
    });
  }

  function getRowSignature(entry) {
    if (!entry) {
      return '';
    }

    return [entry.startText || '', entry.endText || '', entry.text || ''].join('|');
  }

  function findNewDuplicateSplitRows(previousRows) {
    const previousList = Array.isArray(previousRows) ? previousRows : [];
    const previousSignatures = new Set(previousList.map((entry) => getRowSignature(entry)));
    const rows = helper.getTranscriptRows();

    for (let index = 0; index < rows.length - 1; index += 1) {
      const leftRow = rows[index];
      const rightRow = rows[index + 1];
      const leftText = helper.getRowTextValue(leftRow).trim();
      const rightText = helper.getRowTextValue(rightRow).trim();
      if (!leftText || leftText !== rightText) {
        continue;
      }

      const leftLabels = getRowTimeLabels(leftRow);
      const rightLabels = getRowTimeLabels(rightRow);
      const leftSignature = getRowSignature({
        startText: leftLabels ? leftLabels.startText : '',
        endText: leftLabels ? leftLabels.endText : '',
        text: leftText
      });
      const rightSignature = getRowSignature({
        startText: rightLabels ? rightLabels.startText : '',
        endText: rightLabels ? rightLabels.endText : '',
        text: rightText
      });

      if (previousSignatures.has(leftSignature) && previousSignatures.has(rightSignature)) {
        continue;
      }

      const leftRange = getRowTimeRange(leftRow);
      const rightRange = getRowTimeRange(rightRow);
      if (!leftRange || !rightRange) {
        continue;
      }

      const leftDuration = leftRange.endSeconds - leftRange.startSeconds;
      const rightDuration = rightRange.endSeconds - rightRange.startSeconds;
      const totalDuration = leftDuration + rightDuration;
      if (!(leftDuration > 0) || !(rightDuration > 0) || !(totalDuration > 0)) {
        continue;
      }

      return {
        leftRow,
        rightRow,
        sourceText: leftText,
        ratio: leftDuration / totalDuration
      };
    }

    return null;
  }

  async function applySmartSplitFromDuplicateRows(context) {
    if (!context || !Number.isFinite(context.rowCount)) {
      return false;
    }

    const detected = await helper.waitFor(() => {
      const rows = helper.getTranscriptRows();
      if (rows.length < context.rowCount + 1) {
        return null;
      }

      return findNewDuplicateSplitRows(context.rows);
    }, 1200, 40);

    if (!detected) {
      return false;
    }

    return helper.applySmartSplitToRows(
      detected.leftRow,
      detected.rightRow,
      detected.sourceText,
      detected.ratio
    );
  }

  async function waitForSmartSplitTextReady(rows, sourceText) {
    if (!rows || !sourceText) {
      return null;
    }

    return helper.waitFor(() => {
      const leftText = helper.getRowTextValue(rows.leftRow).trim();
      const rightText = helper.getRowTextValue(rows.rightRow).trim();
      if (!leftText && !rightText) {
        return null;
      }

      // Let Babel finish its own duplicated-text write before we overwrite it.
      if (leftText === sourceText || rightText === sourceText || leftText === rightText) {
        return {
          leftText,
          rightText,
          duplicated: true
        };
      }

      return {
        leftText,
        rightText,
        duplicated: false
      };
    }, 800, 40);
  }

  async function applySmartSplit(plan) {
    if (!plan || !plan.sourceText) {
      return false;
    }

    const rows = await waitForSmartSplitRows(plan.sourceRow, plan.sourceRowIndex, plan.rowCount);
    if (!rows) {
      return false;
    }

    const parts = helper.splitTextByWordRatio(plan.sourceText, plan.ratio);
    if (!parts.wordCount) {
      return false;
    }

    const readyState = await waitForSmartSplitTextReady(rows, plan.sourceText);
    if (readyState && readyState.duplicated) {
      await helper.sleep(80);
    }

    const applyOnce = () =>
      helper.applySmartSplitToRows(rows.leftRow, rows.rightRow, plan.sourceText, plan.ratio);

    if (!applyOnce()) {
      return false;
    }

    await helper.sleep(140);

    const leftCurrent = helper.getRowTextValue(rows.leftRow).trim();
    const rightCurrent = helper.getRowTextValue(rows.rightRow).trim();
    if (leftCurrent !== parts.firstText || rightCurrent !== parts.secondText) {
      return applyOnce();
    }
    return true;
  }

  function buildSmartSplitPlanForRegion(entry, pivotPx, container) {
    if (!entry) {
      return null;
    }

    let sourceRow = findRowByTimeLabels(entry.startText, entry.endText);

    if (!(sourceRow instanceof HTMLTableRowElement) && container instanceof HTMLElement) {
      const laneTimeScale = getLaneTimeScale(container);
      if (laneTimeScale && Number.isFinite(laneTimeScale.secondsPerPx) && laneTimeScale.secondsPerPx > 0) {
        const startSeconds = laneTimeScale.offsetSeconds + entry.leftPx * laneTimeScale.secondsPerPx;
        const endSeconds = laneTimeScale.offsetSeconds + entry.rightPx * laneTimeScale.secondsPerPx;
        sourceRow = findRowByTimeRange(startSeconds, endSeconds);
      }
    }

    if (!(sourceRow instanceof HTMLTableRowElement)) {
      return null;
    }

    const rows = helper.getTranscriptRows();
    const sourceRowIndex = rows.indexOf(sourceRow);
    if (sourceRowIndex < 0) {
      return null;
    }

    const sourceText = helper.getRowTextValue(sourceRow).trim();
    if (!sourceText) {
      return null;
    }

    const width = entry.rightPx - entry.leftPx;
    const ratio =
      width > 0 ? clamp((pivotPx - entry.leftPx) / width, 0, 1) : 0.5;

    return {
      sourceRow,
      sourceRowIndex,
      rowCount: rows.length,
      sourceText,
      pivotPx,
      ratio
    };
  }

  function getHandle(region, side) {
    if (!(region instanceof HTMLElement)) {
      return null;
    }

    const selector =
      side === 'left'
        ? '[part~="region-handle-left"]'
        : '[part~="region-handle-right"]';
    const handle = region.querySelector(selector);
    return handle instanceof HTMLElement ? handle : null;
  }

  async function dragHandleToClientX(handle, targetClientX) {
    if (!(handle instanceof HTMLElement) || !handle.isConnected) {
      return false;
    }

    const rect = handle.getBoundingClientRect();
    const startClientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const doc = handle.ownerDocument;

    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientY,
      button: 0
    };

    if (typeof PointerEvent === 'function') {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          ...base,
          clientX: startClientX,
          buttons: 1,
          pointerId: 1,
          pointerType: 'mouse'
        })
      );
    }

    handle.dispatchEvent(
      new MouseEvent('mousedown', {
        ...base,
        clientX: startClientX,
        buttons: 1
      })
    );

    await helper.sleep(16);

    if (typeof PointerEvent === 'function') {
      doc.dispatchEvent(
        new PointerEvent('pointermove', {
          ...base,
          clientX: targetClientX,
          buttons: 1,
          pointerId: 1,
          pointerType: 'mouse'
        })
      );
    }

    doc.dispatchEvent(
      new MouseEvent('mousemove', {
        ...base,
        clientX: targetClientX,
        buttons: 1
      })
    );

    await helper.sleep(16);

    if (typeof PointerEvent === 'function') {
      doc.dispatchEvent(
        new PointerEvent('pointerup', {
          ...base,
          clientX: targetClientX,
          buttons: 0,
          pointerId: 1,
          pointerType: 'mouse'
        })
      );
    }

    doc.dispatchEvent(
      new MouseEvent('mouseup', {
        ...base,
        clientX: targetClientX,
        buttons: 0
      })
    );

    return true;
  }

  helper.commitCutPreview = async function commitCutPreview(options) {
    const preview = helper.state.cutPreview;
    if (!preview || helper.state.cutCommitPending) {
      return false;
    }

    helper.stopSelectionLoop();

    const settings = options || {};
    const useSmartSplit = Boolean(settings.smartSplit);

    if (cancelCutPreviewIfZoomChanged()) {
      return false;
    }

    const duration = getPreviewDurationSeconds(preview);
    if (Number.isFinite(duration) && duration < CUT_PREVIEW_MIN_SECONDS) {
      return false;
    }

    const commitPlan = {
      container: preview.container,
      containerRect:
        preview.container instanceof HTMLElement
          ? preview.container.getBoundingClientRect()
          : preview.containerRect,
      leftPx: preview.leftPx,
      rightPx: preview.rightPx
    };

    const containerRect = commitPlan.containerRect;
    if (!(commitPlan.container instanceof HTMLElement) || containerRect.width <= 0) {
      return false;
    }

    const beforeSnapshot = collectRegionSnapshot(commitPlan.container);
    const initialOverlapPlan = collectOverlapPlan(beforeSnapshot, commitPlan.leftPx, commitPlan.rightPx);
    if (!beforeSnapshot || !initialOverlapPlan || !initialOverlapPlan.overlapping.length) {
      return false;
    }

    const smartSplitPlan =
      useSmartSplit &&
      initialOverlapPlan.splitRequired &&
      initialOverlapPlan.overlapping.length === 1 &&
      initialOverlapPlan.splitRegion
        ? buildSmartSplitPlanForRegion(
            initialOverlapPlan.splitRegion,
            (commitPlan.leftPx + commitPlan.rightPx) / 2,
            commitPlan.container
          )
        : null;
    const smartSplitFallbackContext =
      useSmartSplit &&
      initialOverlapPlan.splitRequired &&
      initialOverlapPlan.overlapping.length === 1
        ? {
            rowCount: helper.getTranscriptRows().length,
            rows: captureRowSnapshot()
          }
        : null;

    const previewElement = preview.element instanceof HTMLElement ? preview.element : null;
    const originalOpacity = previewElement ? previewElement.style.opacity : '';
    if (previewElement) {
      previewElement.style.pointerEvents = 'none';
      previewElement.style.opacity = '0.72';
    }

    helper.state.cutCommitPending = true;

    try {
      const liveContainerRect = commitPlan.container.getBoundingClientRect();

      if (initialOverlapPlan.splitRequired) {
        const splitClientX = liveContainerRect.left + commitPlan.leftPx;
        const splitClientY = liveContainerRect.top + liveContainerRect.height / 2;
        const splitTarget = initialOverlapPlan.splitRegion ? initialOverlapPlan.splitRegion.region : null;
        if (!(splitTarget instanceof HTMLElement) || !splitTarget.isConnected) {
          return false;
        }

        dispatchSplitClick(splitTarget, splitClientX, splitClientY);
      }

      const deleteTargets = initialOverlapPlan.toDelete.slice();
      for (const entry of deleteTargets) {
        const deleted = await deleteRegionByTimeLabels(entry.startText, entry.endText);
        if (!deleted) {
          return false;
        }
        await helper.sleep(80);
      }

      const shouldTrimPrevious = Boolean(initialOverlapPlan.trimLeft || initialOverlapPlan.splitRequired);
      const shouldTrimNext = Boolean(initialOverlapPlan.trimRight || initialOverlapPlan.splitRequired);

      const refreshedSnapshot =
        initialOverlapPlan.splitRequired || deleteTargets.length
          ? await waitForRegionRefresh(
            commitPlan.container,
            getSnapshotSignature(beforeSnapshot)
          )
          : collectRegionSnapshot(commitPlan.container);

      const overlapPlan = collectOverlapPlan(refreshedSnapshot, commitPlan.leftPx, commitPlan.rightPx);
      if (
        (shouldTrimPrevious || shouldTrimNext) &&
        (!overlapPlan || !refreshedSnapshot)
      ) {
        return false;
      }

      const liveSnapshot = findReconciliationTargets(
        refreshedSnapshot,
        commitPlan.leftPx,
        commitPlan.rightPx,
        {
          includePrevious: shouldTrimPrevious,
          includeNext: shouldTrimNext,
          containerRect: refreshedSnapshot
            ? refreshedSnapshot.containerRect
            : commitPlan.container.getBoundingClientRect()
        }
      );

      if (!liveSnapshot || !liveSnapshot.containerRect) {
        return false;
      }

      if ((shouldTrimPrevious && !liveSnapshot.previous) || (shouldTrimNext && !liveSnapshot.next)) {
        return false;
      }

      const targetStartClientX = liveSnapshot.containerRect.left + commitPlan.leftPx;
      const targetEndClientX = liveSnapshot.containerRect.left + commitPlan.rightPx;

      if (shouldTrimPrevious && liveSnapshot.previous) {
        const previousRightHandle = getHandle(liveSnapshot.previous.region, 'right');
        if (!(previousRightHandle instanceof HTMLElement)) {
          return false;
        }

        const movedPrevious = await dragHandleToClientX(previousRightHandle, targetStartClientX);
        if (!movedPrevious) {
          return false;
        }

        await helper.sleep(48);
      }

      if (shouldTrimNext && liveSnapshot.next) {
        const nextLeftHandle = getHandle(liveSnapshot.next.region, 'left');
        if (!(nextLeftHandle instanceof HTMLElement)) {
          return false;
        }

        const movedNext = await dragHandleToClientX(nextLeftHandle, targetEndClientX);
        if (!movedNext) {
          return false;
        }
      }

      if (smartSplitPlan) {
        await helper.sleep(64);
        void applySmartSplit(smartSplitPlan);
      } else if (smartSplitFallbackContext) {
        await helper.sleep(64);
        void applySmartSplitFromDuplicateRows(smartSplitFallbackContext);
      }

      helper.clearCutPreview();
      return true;
    } finally {
      helper.state.cutCommitPending = false;
      const currentPreview = helper.state.cutPreview;
      if (currentPreview && currentPreview.element === previewElement && previewElement) {
        previewElement.style.pointerEvents = 'auto';
        previewElement.style.opacity = originalOpacity;
      }
    }
  };

  helper.handleCutPreviewKeydown = function handleCutPreviewKeydown(event) {
    if (!helper.state.cutPreview) {
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === 'KeyL') {
        setSelectionLoopDebug('no-preview-key');
      }
      return false;
    }

    if (cancelCutPreviewIfZoomChanged()) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    if (helper.state.cutCommitPending) {
      if (
        event.key === 'Escape' ||
        event.key.toLowerCase() === 's' ||
        event.key.toLowerCase() === 'l' ||
        event.key === 'Delete' ||
        (event.altKey && !event.ctrlKey && !event.metaKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }

      return false;
    }

    if (event.key === 'Escape') {
      helper.clearCutPreview();
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === 'KeyS') {
      event.preventDefault();
      event.stopPropagation();
      void helper.commitCutPreview({
        smartSplit: true
      });
      return true;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.shiftKey && event.code === 'KeyS') {
      event.preventDefault();
      event.stopPropagation();
      void helper.commitCutPreview();
      return true;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.code === 'KeyL') {
      event.preventDefault();
      event.stopPropagation();
      void helper.startSelectionLoop();
      return true;
    }

    if (
      event.key === 'Delete' ||
      (event.altKey && !event.ctrlKey && !event.metaKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    return false;
  };

  function handlePointerDown(event) {
    if (helper.state.cutCommitPending) {
      return;
    }

    captureSmartSplitClickDraft(event);

    if (beginPreviewDrag(event)) {
      return;
    }

    const draft = getRegionDraft(event);
    if (!draft) {
      return;
    }

    if (helper.state.cutPreview) {
      helper.clearCutPreview();
    }

    helper.state.cutDraft = draft;
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePointerMove(event) {
    if (helper.state.cutCommitPending) {
      return;
    }

    if (updatePreviewDrag(event)) {
      return;
    }

    const draft = helper.state.cutDraft;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (!draft || draft.pointerId !== pointerId) {
      return;
    }

    const currentX = clamp(event.clientX, draft.containerRect.left, draft.containerRect.right);
    if (Math.abs(currentX - draft.startClientX) < CUT_PREVIEW_DRAG_THRESHOLD) {
      return;
    }

    createPreviewFromDraft(draft, currentX);
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePointerEnd(event) {
    if (helper.state.cutCommitPending) {
      return;
    }

    if (endPreviewDrag(event)) {
      return;
    }

    const draft = helper.state.cutDraft;
    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    if (draft && draft.pointerId === pointerId) {
      clearCutDraft();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function getSmartSplitClickDraft(event) {
    if (
      !isSmartSplitClickEvent(event)
    ) {
      return null;
    }

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    let sourceRegion = null;
    let container = null;

    for (const node of path) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (node.hasAttribute(CUT_PREVIEW_ATTR)) {
        return null;
      }

      if (!sourceRegion && isRegionHandle(node)) {
        const owningRegion = getOwningRegionBody(node);
        if (owningRegion) {
          sourceRegion = owningRegion;
          if (owningRegion.parentElement instanceof HTMLElement) {
            container = owningRegion.parentElement;
          }
        }
        continue;
      }

      if (!sourceRegion && isRegionBody(node)) {
        sourceRegion = node;
        if (node.parentElement instanceof HTMLElement) {
          container = node.parentElement;
        }
      }

      if (!container && getRegionElements(node).length) {
        container = node;
      }

      if (
        !container &&
        node instanceof HTMLElement &&
        node.parentElement instanceof HTMLElement &&
        getRegionElements(node.parentElement).length
      ) {
        container = node.parentElement;
      }
    }

    if (
      !(container instanceof HTMLElement) &&
      helper.state.cutLastContainer instanceof HTMLElement &&
      helper.state.cutLastContainer.isConnected
    ) {
      container = helper.state.cutLastContainer;
    }

    if (!(container instanceof HTMLElement)) {
      return null;
    }

    const snapshot = collectRegionSnapshot(container);
    if (!snapshot) {
      return null;
    }

    const localX = clamp(event.clientX - snapshot.containerRect.left, 0, snapshot.containerRect.width);
    let entry =
      sourceRegion instanceof HTMLElement
        ? snapshot.bounds.find((candidate) => candidate.region === sourceRegion) || null
        : null;

    if (!entry) {
      const tolerance = 2;
      entry =
        snapshot.bounds.find(
          (candidate) =>
            localX >= candidate.leftPx - tolerance && localX <= candidate.rightPx + tolerance
        ) || null;
    }

    if (!entry) {
      let bestEntry = null;
      let bestDistance = Infinity;
      for (const candidate of snapshot.bounds) {
        const center = (candidate.leftPx + candidate.rightPx) / 2;
        const distance = Math.abs(center - localX);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestEntry = candidate;
        }
      }
      entry = bestEntry;
    }

    if (!entry) {
      return null;
    }

    const pivotPx = clamp(localX, entry.leftPx, entry.rightPx);
    return buildSmartSplitPlanForRegion(entry, pivotPx, container);
  }

  function captureSmartSplitClickDraft(event) {
    if (!isSmartSplitClickEvent(event)) {
      helper.state.smartSplitClickDraft = null;
      helper.state.smartSplitClickContext = null;
      return null;
    }

    helper.state.smartSplitClickContext = {
      rowCount: helper.getTranscriptRows().length,
      rows: captureRowSnapshot()
    };

    const draft = getSmartSplitClickDraft(event);
    helper.state.smartSplitClickDraft = draft || null;
    return draft;
  }

  function handleSmartSplitClick(event) {
    if (helper.state.cutCommitPending) {
      return;
    }

    const context = helper.state.smartSplitClickContext;
    const draft =
      (isSmartSplitClickEvent(event) ? helper.state.smartSplitClickDraft : null) ||
      getSmartSplitClickDraft(event);
    helper.state.smartSplitClickDraft = null;
    helper.state.smartSplitClickContext = null;
    if (!draft) {
      if (isSmartSplitClickEvent(event)) {
        if (context) {
          void applySmartSplitFromDuplicateRows(context);
        }
      }
      return;
    }
    void applySmartSplit(draft);
  }

  helper.bindCutPreview = function bindCutPreview() {
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('pointerup', handlePointerEnd, true);
    document.addEventListener('pointercancel', handlePointerEnd, true);
    document.addEventListener('click', handleSmartSplitClick, true);
  };
})();
