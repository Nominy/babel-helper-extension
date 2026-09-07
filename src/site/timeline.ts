// @ts-nocheck
import { parseTimeValue } from '../hooks/parsing';

export function createTimelineSiteApi(helper: any) {
  const BRIDGE_REQUEST_EVENT = 'babel-helper-magnifier-request';

  const BRIDGE_RESPONSE_EVENT = 'babel-helper-magnifier-response';

  const BRIDGE_SCRIPT_PATH = 'dist/content/magnifier-bridge.js';

  const BRIDGE_TIMEOUT_MS = 700;

  helper.state.currentTimelineTarget = null;


  let bridgeInjected = false;

  let bridgeLoadPromise = null;

  let bridgeRequestId = 0;

  const getTranscriptRowsFromHelper =
    typeof helper.getTranscriptRows === 'function' ? helper.getTranscriptRows.bind(helper) : null;


  helper.getTranscriptRows = () => {
    const rows = getTranscriptRowsFromHelper ? getTranscriptRowsFromHelper() : [];
    if (Array.isArray(rows) && rows.length) {
      return rows;
    }

    return getFallbackTranscriptRows();
  };


  function isFeatureEnabled(featureKey) {
    if (typeof helper.isFeatureEnabled === 'function') {
      return helper.isFeatureEnabled(featureKey);
    }

    return true;
  }


  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }


  function parseSecondsLabel(value) {
    const parsed = parseTimeValue(value);
    return Number.isFinite(parsed) ? parsed : null;
  }


  function getFallbackTranscriptRows() {
    return Array.from(document.querySelectorAll('tbody tr')).filter((row) => {
      if (!(row instanceof HTMLTableRowElement) || row.children.length < 5) {
        return false;
      }

      if (!row.querySelector('textarea')) {
        return false;
      }

      const startText = helper.normalizeText(row.children[2]);
      const endText = helper.normalizeText(row.children[3]);
      const startSeconds = parseTimeValue(startText);
      const endSeconds = parseTimeValue(endText);
      return Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds;
    });
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


  function getRegionHandleElement(element) {
    let current = element instanceof HTMLElement ? element : null;
    while (current instanceof HTMLElement) {
      if (isRegionHandle(current)) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
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


  function getRegionTimeText(region, selector) {
    if (!(region instanceof HTMLElement)) {
      return '';
    }

    const tooltip = region.querySelector(selector);
    if (!(tooltip instanceof HTMLElement)) {
      return '';
    }

    const normalized = helper.normalizeText(tooltip);
    if (normalized) {
      return normalized;
    }

    return typeof tooltip.textContent === 'string' ? tooltip.textContent.replace(/\s+/g, ' ').trim() : '';
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

    const startSeconds = parseTimeValue(labels.startText);
    const endSeconds = parseTimeValue(labels.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return {
      startSeconds,
      endSeconds
    };
  }


  function findRowByTimeRange(startSeconds, endSeconds, options) {
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    const settings = options || {};
    const speakerKey =
      typeof settings.speakerKey === 'string' && settings.speakerKey ? settings.speakerKey : '';
    const rows = helper.getTranscriptRows();
    let bestRow = null;
    let bestScore = -Infinity;

    for (const row of rows) {
      if (speakerKey && helper.getRowSpeakerKey(row) !== speakerKey) {
        continue;
      }

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


  function findRowByTimeLabels(startText, endText, options) {
    if (!startText || !endText) {
      return null;
    }

    const settings = options || {};
    const speakerKey =
      typeof settings.speakerKey === 'string' && settings.speakerKey ? settings.speakerKey : '';
    const rows = helper.getTranscriptRows();
    const exactMatch =
      rows.find((row) => {
        if (speakerKey && helper.getRowSpeakerKey(row) !== speakerKey) {
          return false;
        }

        const labels = getRowTimeLabels(row);
        return labels && labels.startText === startText && labels.endText === endText;
      }) || null;
    if (exactMatch) {
      return exactMatch;
    }

    const targetStart = parseTimeValue(startText);
    const targetEnd = parseTimeValue(endText);
    if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd) || targetEnd <= targetStart) {
      return null;
    }

    return findRowByTimeRange(targetStart, targetEnd, {
      speakerKey
    });
  }


  async function deleteRegionByTimeLabels(startText, endText, options) {
    const row = findRowByTimeLabels(startText, endText, options);
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
        const start = parseTimeValue(getRegionTimeText(region, '.wavesurfer-region-tooltip-start'));
        const end = parseTimeValue(getRegionTimeText(region, '.wavesurfer-region-tooltip-end'));
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
      try {
        script.src = chrome.runtime.getURL(BRIDGE_SCRIPT_PATH);
      } catch (_error) {
        script.remove();
        bridgeLoadPromise = null;
        resolve(false);
        return;
      }
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


  async function callSelectionBridge(operation, payload, options) {
    const ready = await injectSelectionBridge();
    if (!ready) {
      return null;
    }
    const onProgress = options && typeof options.onProgress === 'function' ? options.onProgress : null;

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

        if (detail.progress) {
          if (onProgress) {
            onProgress(detail.progress);
          }
          return;
        }

        finish(detail.result || null);
      };

      const requestedTimeoutMs = Number(payload && payload.timeoutMs);
      const timeoutMs = Math.max(
        BRIDGE_TIMEOUT_MS,
        Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : 0
      );
      const timeoutId = window.setTimeout(() => finish(null), timeoutMs);
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


  function isVisibleWaveformHost(host) {
    if (
      !(host instanceof HTMLElement) ||
      !host.isConnected ||
      !helper.isVisible(host) ||
      !(host.shadowRoot instanceof ShadowRoot)
    ) {
      return false;
    }

    const wrapper = host.shadowRoot.querySelector('[part="wrapper"]');
    const scroll = host.shadowRoot.querySelector('[part="scroll"]');
    return Boolean(
      wrapper instanceof HTMLElement &&
      scroll instanceof HTMLElement &&
      helper.isVisible(scroll)
    );
  }


  function isVisibleWaveformContainer(container) {
    if (!(container instanceof HTMLElement) || !container.isConnected) {
      return false;
    }

    const host = getWaveformHostFromContainer(container);
    return host instanceof HTMLElement && isVisibleWaveformHost(host);
  }



  function discoverWaveformContainers() {
    const containers = [];
    const seen = new Set();

    if (helper.state.cutLastContainer instanceof HTMLElement) {
      if (isVisibleWaveformContainer(helper.state.cutLastContainer)) {
        seen.add(helper.state.cutLastContainer);
        containers.push(helper.state.cutLastContainer);
      } else if (helper.state.cutLastContainer.isConnected) {
        helper.state.cutLastContainer = null;
      }
    }

    for (const node of Array.from(document.querySelectorAll('div'))) {
      if (!(node instanceof HTMLDivElement) || !isVisibleWaveformHost(node)) {
        continue;
      }

      const container =
        node.shadowRoot.querySelector('[part="regions-container"]') ||
        (() => {
          const region = node.shadowRoot.querySelector('[part~="region"]');
          return region instanceof HTMLElement ? region.parentElement : null;
        })();
      if (
        !(container instanceof HTMLElement) ||
        seen.has(container) ||
        !isVisibleWaveformContainer(container)
      ) {
        continue;
      }

      seen.add(container);
      containers.push(container);
    }

    return containers;
  }


  function getTrackDetailsForHost(host) {
    if (!(host instanceof HTMLElement)) {
      return null;
    }

    let fiber = getReactFiber(host);
    if (!fiber && host.parentElement instanceof HTMLElement) {
      fiber = getReactFiber(host.parentElement);
    }

    let owner = fiber;
    let ownerDepth = 0;
    while (owner && typeof owner === 'object' && ownerDepth < 20) {
      const props = owner.memoizedProps;
      const track =
        props && typeof props === 'object' && props.track && typeof props.track === 'object'
          ? props.track
          : null;
      if (track) {
        return track;
      }

      owner = owner.return;
      ownerDepth += 1;
    }

    return null;
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


  function getTrackIdForHost(host) {
    const track = getTrackDetailsForHost(host);
    if (!track || typeof track !== 'object') {
      return null;
    }

    if (track.processedRecordingId != null) {
      return String(track.processedRecordingId);
    }

    return track.id != null ? String(track.id) : null;
  }


  function getSpeakerKeyForContainer(container) {
    const host = getWaveformHostFromContainer(container);
    if (!(host instanceof HTMLElement)) {
      return '';
    }

    const track = getTrackDetailsForHost(host);
    if (track && typeof track.label === 'string' && track.label.trim()) {
      return track.label.trim();
    }

    return getTrackIdForHost(host) || '';
  }


  function normalizeSpeakerLaneLabel(value) {
    const text = typeof value === 'string' ? value : String(value ?? '');
    const match = text.match(/\bspeaker\s*([12])\b/i);
    return match ? 'Speaker ' + match[1] : '';
  }


  function getSpeakerLaneVisibilityForLabel(label) {
    const normalizedTarget = normalizeSpeakerLaneLabel(label);
    if (!normalizedTarget) {
      return '';
    }

    const targetLower = normalizedTarget.toLowerCase();
    for (const heading of Array.from(document.querySelectorAll('h3'))) {
      if (!(heading instanceof HTMLElement)) {
        continue;
      }

      if (helper.normalizeText(heading).toLowerCase() !== targetLower) {
        continue;
      }

      const header = heading.parentElement;
      if (!(header instanceof HTMLElement)) {
        continue;
      }

      const visibilityButton = header.querySelector(
        'button[aria-label="Show track"], button[aria-label="Hide track"]'
      );
      if (!(visibilityButton instanceof HTMLElement)) {
        continue;
      }

      const semantic = (visibilityButton.getAttribute('aria-label') || '').trim().toLowerCase();
      const text = helper.normalizeText(visibilityButton).toLowerCase();
      if (semantic === 'show track' || text === 'show track') {
        return 'hidden';
      }
      if (semantic === 'hide track' || text === 'hide track') {
        return 'visible';
      }
    }

    return '';
  }


  function isAutoInsertLaneSemanticallyVisible(target) {
    const labels = [
      target && target.trackLabel,
      target && target.speakerKey
    ]
      .map(normalizeSpeakerLaneLabel)
      .filter(Boolean);
    const uniqueLabels = Array.from(new Set(labels));
    if (!uniqueLabels.length) {
      return true;
    }

    for (const label of uniqueLabels) {
      const state = getSpeakerLaneVisibilityForLabel(label);
      if (state === 'hidden') {
        return false;
      }
      if (state === 'visible') {
        return true;
      }
    }

    return true;
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

    const trackId = getTrackIdForHost(host);
    let wrapperMatch = null;
    let trackMatch = null;
    for (const key of Object.keys(registry)) {
      const entry = registry[key];
      const wavesurfer =
        entry && typeof entry === 'object' && entry.wavesurfer ? entry.wavesurfer : null;
      if (!wavesurfer || typeof wavesurfer !== 'object') {
        continue;
      }

      const wrapper =
        typeof wavesurfer.getWrapper === 'function' ? wavesurfer.getWrapper() : null;
      const wrapperHost =
        wrapper && typeof wrapper.getRootNode === 'function'
          ? wrapper.getRootNode().host
          : null;
      const containerMatches =
        wavesurfer.container === host ||
        wavesurfer.container === container ||
        wrapper === container ||
        wrapperHost === host;
      const keyMatchesTrack = trackId && String(key) === trackId;

      if (containerMatches && keyMatchesTrack) {
        return entry;
      }

      if (containerMatches && !wrapperMatch) {
        wrapperMatch = entry;
      }

      if (keyMatchesTrack && !trackMatch) {
        trackMatch = entry;
      }
    }

    return wrapperMatch || trackMatch || null;
  }


  function getWaveformDurationSeconds(wavesurfer) {
    if (!wavesurfer || typeof wavesurfer !== 'object') {
      return 0;
    }

    const direct =
      typeof wavesurfer.getDuration === 'function' ? Number(wavesurfer.getDuration()) : NaN;
    if (Number.isFinite(direct) && direct > 0) {
      return direct;
    }

    const optionValue = Number(
      wavesurfer.options && typeof wavesurfer.options === 'object'
        ? wavesurfer.options.duration
        : NaN
    );
    return Number.isFinite(optionValue) && optionValue > 0 ? optionValue : 0;
  }


  function getWaveformWrapperForEntry(entry, container) {
    const wavesurfer =
      entry && typeof entry === 'object' && entry.wavesurfer ? entry.wavesurfer : null;
    const directWrapper =
      wavesurfer && typeof wavesurfer.getWrapper === 'function' ? wavesurfer.getWrapper() : null;
    if (directWrapper instanceof HTMLElement) {
      return directWrapper;
    }

    const host = getWaveformHostFromContainer(container);
    const shadowWrapper =
      host && host.shadowRoot ? host.shadowRoot.querySelector('[part="wrapper"]') : null;
    return shadowWrapper instanceof HTMLElement ? shadowWrapper : null;
  }


  function getWaveformPixelsPerSecond(entry, container) {
    const wavesurfer =
      entry && typeof entry === 'object' && entry.wavesurfer ? entry.wavesurfer : null;
    const renderer =
      wavesurfer && wavesurfer.renderer && typeof wavesurfer.renderer === 'object'
        ? wavesurfer.renderer
        : null;
    const rendererWrapper =
      renderer && renderer.wrapper instanceof HTMLElement ? renderer.wrapper : null;
    const duration = getWaveformDurationSeconds(wavesurfer);
    const fullWidth =
      rendererWrapper instanceof HTMLElement
        ? Number(rendererWrapper.scrollWidth) ||
        parsePixels(rendererWrapper.style.width || '') ||
        Number(rendererWrapper.clientWidth)
        : NaN;
    if (Number.isFinite(fullWidth) && fullWidth > 0 && duration > 0) {
      return fullWidth / duration;
    }

    const optionValue = Number(
      wavesurfer && wavesurfer.options && typeof wavesurfer.options === 'object'
        ? wavesurfer.options.minPxPerSec
        : NaN
    );
    if (Number.isFinite(optionValue) && optionValue > 0) {
      return optionValue;
    }

    return 0;
  }


  function rememberCutContainer(container) {
    if (container instanceof HTMLElement && container.isConnected) {
      helper.state.cutLastContainer = container;
    }
  }


  function getRegionElements(container) {
    if (!(container instanceof HTMLElement)) {
      return [];
    }

    return Array.from(container.children).filter((child) => isRegionBody(child));
  }


  function findRegionEntryForRow(row, container) {
    if (!(row instanceof HTMLTableRowElement) || !(container instanceof HTMLElement)) {
      return null;
    }

    const labels = getRowTimeLabels(row);
    const speakerKey = helper.getRowSpeakerKey(row);
    const snapshot = collectRegionSnapshot(container);
    if (!labels || !snapshot) {
      return null;
    }

    const exactMatch =
      snapshot.bounds.find(
        (entry) => entry.startText === labels.startText && entry.endText === labels.endText
      ) || null;
    if (exactMatch) {
      return exactMatch;
    }

    const rowRange = getRowTimeRange(row);
    if (!rowRange) {
      return null;
    }

    let best = null;
    let bestScore = -Infinity;
    for (const entry of snapshot.bounds) {
      if (speakerKey && getSpeakerKeyForContainer(container) !== speakerKey) {
        break;
      }

      const startSeconds = parseTimeValue(entry.startText);
      const endSeconds = parseTimeValue(entry.endText);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        continue;
      }

      const overlap = Math.max(
        0,
        Math.min(endSeconds, rowRange.endSeconds) - Math.max(startSeconds, rowRange.startSeconds)
      );
      const distance =
        Math.abs(startSeconds - rowRange.startSeconds) + Math.abs(endSeconds - rowRange.endSeconds);
      const score = overlap > 0 ? overlap * 100 - distance : -distance;
      if (score > bestScore) {
        best = entry;
        bestScore = score;
      }
    }

    return best;
  }


  function rememberTimelineSegmentTarget(row, container, entry, speakerKey) {
    if (!(row instanceof HTMLTableRowElement) || !entry) {
      return null;
    }

    const target = {
      row,
      rowIdentity: typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null,
      speakerKey: typeof speakerKey === 'string' ? speakerKey : helper.getRowSpeakerKey(row),
      startText: entry.startText || '',
      endText: entry.endText || '',
      container: container instanceof HTMLElement ? container : null,
      capturedAt: Date.now()
    };
    helper.state.currentTimelineTarget = target;
    helper.setCurrentRow(row);
    return target;
  }


  helper.resolveTimelineSegmentTargetRow = function resolveTimelineSegmentTargetRow() {
    const target = helper.state.currentTimelineTarget;
    if (!target || typeof target !== 'object') {
      return null;
    }

    if (
      target.row instanceof HTMLTableRowElement &&
      target.row.isConnected &&
      (!target.rowIdentity ||
        typeof helper.rowMatchesIdentity !== 'function' ||
        helper.rowMatchesIdentity(target.row, target.rowIdentity))
    ) {
      return target.row;
    }

    if (target.rowIdentity && typeof helper.findRowByIdentity === 'function') {
      const byIdentity = helper.findRowByIdentity(target.rowIdentity);
      if (byIdentity instanceof HTMLTableRowElement) {
        target.row = byIdentity;
        return byIdentity;
      }
    }

    if (target.startText && target.endText) {
      const byLabels = findRowByTimeLabels(target.startText, target.endText, {
        speakerKey: target.speakerKey || ''
      });
      if (byLabels instanceof HTMLTableRowElement) {
        target.row = byLabels;
        target.rowIdentity = typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(byLabels) : null;
        return byLabels;
      }
    }

    return null;
  };


  function captureTimelineSegmentTarget(event) {
    if (!event || event.button !== 0) {
      return null;
    }

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    let sourceRegion = null;
    let container = null;

    for (const node of path) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (!sourceRegion && isRegionHandle(node)) {
        sourceRegion = getOwningRegionBody(node);
      }

      if (!sourceRegion && isRegionBody(node)) {
        sourceRegion = node;
      }

      if (!container && sourceRegion instanceof HTMLElement && sourceRegion.parentElement instanceof HTMLElement) {
        container = sourceRegion.parentElement;
      }

      if (!container && getRegionElements(node).length) {
        container = node;
      }
    }

    if (!(sourceRegion instanceof HTMLElement) || !(container instanceof HTMLElement)) {
      return null;
    }

    const snapshot = collectRegionSnapshot(container);
    if (!snapshot) {
      return null;
    }

    const entry = snapshot.bounds.find((candidate) => candidate.region === sourceRegion) || null;
    if (!entry || !entry.startText || !entry.endText) {
      return null;
    }

    const speakerKey = getSpeakerKeyForContainer(container);
    const row = findRowByTimeLabels(entry.startText, entry.endText, { speakerKey });
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    return rememberTimelineSegmentTarget(row, container, entry, speakerKey);
  }


  function findCurrentSegmentTarget() {
    const timelineRow =
      typeof helper.resolveTimelineSegmentTargetRow === 'function'
        ? helper.resolveTimelineSegmentTargetRow()
        : null;
    const row =
      timelineRow ||
      (typeof helper.getCurrentActionRow === 'function'
        ? helper.getCurrentActionRow({ allowFallback: false })
        : helper.getCurrentRow({ allowFallback: false }));
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    const rowSpeakerKey = helper.getRowSpeakerKey(row);
    const rowLabels = getRowTimeLabels(row);
    const rememberedTarget = helper.state.currentTimelineTarget;
    const containers = discoverWaveformContainers();
    const orderedContainers = [
      rememberedTarget &&
        rememberedTarget.row === row &&
        rememberedTarget.container instanceof HTMLElement &&
        rememberedTarget.container.isConnected
        ? rememberedTarget.container
        : null,
      ...containers
    ].filter((container, index, all) => container instanceof HTMLElement && all.indexOf(container) === index);

    for (const container of orderedContainers) {
      if (rowSpeakerKey && getSpeakerKeyForContainer(container) !== rowSpeakerKey) {
        continue;
      }

      const entry = findRegionEntryForRow(row, container);
      if (entry) {
        return {
          row,
          speakerKey: rowSpeakerKey,
          container,
          entry
        };
      }

      if (rowLabels && rowLabels.startText && rowLabels.endText) {
        return {
          row,
          speakerKey: rowSpeakerKey,
          container,
          entry: {
            startText: rowLabels.startText,
            endText: rowLabels.endText
          }
        };
      }
    }

    if (rowLabels && rowLabels.startText && rowLabels.endText) {
      return {
        row,
        speakerKey: rowSpeakerKey,
        container: null,
        entry: {
          startText: rowLabels.startText,
          endText: rowLabels.endText
        }
      };
    }

    return null;
  }


  function collectAllSegmentTargets() {
    const targets = [];
    const containers = discoverWaveformContainers();
    for (const row of helper.getTranscriptRows()) {
      if (!(row instanceof HTMLTableRowElement)) {
        continue;
      }

      const speakerKey = helper.getRowSpeakerKey(row);
      const labels = getRowTimeLabels(row);
      if (!labels || !labels.startText || !labels.endText) {
        continue;
      }

      const rowRange = getRowTimeRange(row);
      if (!rowRange) {
        continue;
      }

      const container =
        containers.find((candidate) => {
          const candidateSpeakerKey = getSpeakerKeyForContainer(candidate);
          return !speakerKey || candidateSpeakerKey === speakerKey;
        }) || null;

      const entry =
        container instanceof HTMLElement
          ? findRegionEntryForRow(row, container) || {
            startText: labels.startText,
            endText: labels.endText
          }
          : {
            startText: labels.startText,
            endText: labels.endText
          };
      targets.push({
        row,
        speakerKey,
        container,
        entry
      });
    }

    return targets;
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

  return { isFeatureEnabled, getWaveformHostFromContainer, clamp, isRegionHandle, isRegionBody, getRegionHandleElement, getOwningRegionBody, getZoomSliderElement, getReactFiber, callSelectionBridge, getWaveformEntryForContainer, getWaveformPixelsPerSecond, getSelectionAudioElement, getLaneZoomSignature, rememberCutContainer, getRegionElements, discoverWaveformContainers, getRowTimeLabels, getRowTimeRange, getSpeakerKeyForContainer, getFallbackTranscriptRows, isAutoInsertLaneSemanticallyVisible, findRowByTimeLabels, findRowByTimeRange, rememberTimelineSegmentTarget, findRegionEntryForRow, isVisibleWaveformContainer, getLaneTimeScale, collectRegionSnapshot, findCurrentSegmentTarget, collectAllSegmentTargets, deleteRegionByTimeLabels, captureTimelineSegmentTarget };
}
