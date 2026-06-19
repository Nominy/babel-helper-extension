// @ts-nocheck
import {
  loadWorkflowDefaults,
  updateWorkflowDefaults,
  normalizeZoomValue
} from '../core/workflow-defaults';
import {
  applyAutoSegmentTextReview,
  createAutoSegmentTextRedistributionDraft,
  normalizeAutoSegmentText,
  validateAutoSegmentTextAllocationsPreserveText
} from './auto-segment-text-allocation';

export function registerTimelineSelectionService(helper: any) {
  if (!helper || helper.__cutRegistered) {
    return;
  }

  helper.__cutRegistered = true;

  const CUT_PREVIEW_ATTR = 'data-babel-helper-cut-preview';
  const CUT_PREVIEW_HANDLE_ATTR = 'data-babel-helper-cut-handle';
  const CUT_PREVIEW_MIN_SECONDS = 1;
  const CUT_PREVIEW_SAFETY_MIN_SECONDS = 0.008;
  const CUT_PREVIEW_SAFETY_MAX_SECONDS = 0.03;
  const CUT_PREVIEW_MIN_WIDTH = 8;
  const CUT_PREVIEW_DRAG_THRESHOLD = 5;
  const CUT_PREVIEW_HANDLE_HIT_WIDTH = 12;
  const SELECTION_LOOP_HOST_ATTR = 'data-babel-helper-selection-loop-host';
  const BRIDGE_REQUEST_EVENT = 'babel-helper-magnifier-request';
  const BRIDGE_RESPONSE_EVENT = 'babel-helper-magnifier-response';
  const BRIDGE_SCRIPT_PATH = 'dist/content/magnifier-bridge.js';
  const BRIDGE_TIMEOUT_MS = 700;
  const CUT_PREVIEW_FAST_DUPLICATE_ROW_WAIT_MS = 180;
  const CUT_PREVIEW_SMART_SPLIT_ROW_WAIT_MS = 1200;
  const CUT_PREVIEW_DUPLICATE_ROW_POLL_MS = 40;
  const ZOOM_PERSIST_DEBOUNCE_MS = 240;
  const AUDIO_TRIM_INWARD_THRESHOLD = Math.pow(10, -62 / 20);
  const AUDIO_TRIM_OUTWARD_THRESHOLD = Math.pow(10, -62 / 20);
  const AUDIO_TRIM_OUTWARD_STEP_SECONDS = 0.05;
  const AUDIO_TRIM_PADDING_SECONDS = 0.005;
  const AUDIO_TRIM_EPSILON_SECONDS = 0.0015;
  const AUDIO_TRIM_NEIGHBOR_GUARD_SECONDS = 0.01;
  const AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD = Math.pow(10, -56 / 20);
  const AUTO_SEGMENT_SILENCE_MIN_SECONDS = 1;
  const AUTO_SEGMENT_MERGE_GAP_SECONDS = 1;
  const AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS = 0.05;
  const AUTO_SEGMENT_SPLIT_SETTLE_MS = 220;
  const LONG_TASK_PROGRESS_ID = 'babel-helper-long-task-progress';

  helper.state.cutDraft = null;
  helper.state.cutPreview = null;
  helper.state.cutCommitPending = false;
  helper.state.cutLastContainer = null;
  helper.state.currentTimelineTarget = null;
  helper.state.smartSplitClickDraft = null;
  helper.state.smartSplitClickContext = null;
  helper.state.selectionLoop = null;
  helper.state.longTaskProgress = null;
  helper.state.autoSegmentationPending = false;
  if (isFeatureEnabled('timelineSelection')) {
    helper.config.hotkeysHelpRows.unshift(['Alt + Shift + S', 'Split visible segments on silence runs over 1000ms, then trim all']);
    helper.config.hotkeysHelpRows.unshift(['Alt + Shift + R', 'Trim all visible segments to nearby visible audio']);
    helper.config.hotkeysHelpRows.unshift(['Alt + R', 'Trim current segment to nearby visible audio']);
    helper.config.hotkeysHelpRows.unshift(['Shift + Ctrl/Cmd + Click', 'Run native split and redistribute words']);
    helper.config.hotkeysHelpRows.unshift(['L', 'Loop the selected range until playback caret moves']);
    helper.config.hotkeysHelpRows.unshift(['Shift + S', 'Split the selected range']);
    helper.config.hotkeysHelpRows.unshift(['S', 'Smart-split the selected range']);
    helper.config.hotkeysHelpRows.unshift(['Alt + Drag', 'Create a timeline selection']);
  }

  let bridgeInjected = false;
  let bridgeLoadPromise = null;
  let bridgeRequestId = 0;
  let zoomPersistenceSlider = null;
  let zoomPersistenceObserver = null;
  let zoomPersistenceTimer = 0;
  let zoomPersistenceApplying = false;
  let zoomPersistenceLoaded = false;
  let zoomPersistenceDefaults = null;
  let zoomPersistenceSaveChain = Promise.resolve();
  let autoSegmentTextRedistributionSession = null;
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

  function ensureSelectionHostMarker(container) {
    const host = getWaveformHostFromContainer(container);
    if (!(host instanceof HTMLElement)) {
      return null;
    }

    const existing = host.getAttribute(SELECTION_LOOP_HOST_ATTR);
    if (existing) {
      return existing;
    }

    const marker = nextLoopMarker();
    host.setAttribute(SELECTION_LOOP_HOST_ATTR, marker);
    return marker;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function parseTimeValue(value) {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = trimmed.toLowerCase();

    const timestampMatch = normalized.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
    if (timestampMatch) {
      const parts = timestampMatch[0].split(':');
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

    let total = 0;
    let foundUnit = false;
    const unitPattern = /(-?\d+(?:\.\d+)?)\s*([hms])/g;
    for (const match of normalized.matchAll(unitPattern)) {
      const numeric = Number(match[1]);
      if (!Number.isFinite(numeric)) {
        return null;
      }

      foundUnit = true;
      const unit = match[2];
      if (unit === 'h') {
        total += numeric * 3600;
      } else if (unit === 'm') {
        total += numeric * 60;
      } else {
        total += numeric;
      }
    }

    if (foundUnit) {
      return total;
    }

    const numericMatch = normalized.match(/-?\d+(?:\.\d+)?/);
    if (!numericMatch) {
      return null;
    }

    const numeric = Number(numericMatch[0]);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function ensureLongTaskProgress() {
    let progress = helper.state.longTaskProgress;
    if (
      progress &&
      progress.root instanceof HTMLElement &&
      progress.fill instanceof HTMLElement &&
      progress.label instanceof HTMLElement &&
      progress.detail instanceof HTMLElement &&
      document.documentElement.contains(progress.root)
    ) {
      return progress;
    }

    const root = document.createElement('div');
    root.id = LONG_TASK_PROGRESS_ID;
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.style.position = 'fixed';
    root.style.right = '18px';
    root.style.bottom = '18px';
    root.style.width = '300px';
    root.style.maxWidth = 'calc(100vw - 36px)';
    root.style.padding = '12px 14px';
    root.style.border = '1px solid rgba(15, 23, 42, 0.14)';
    root.style.borderRadius = '8px';
    root.style.background = 'rgba(255, 255, 255, 0.96)';
    root.style.boxShadow = '0 16px 38px rgba(15, 23, 42, 0.18)';
    root.style.color = '#111827';
    root.style.font = '13px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    root.style.zIndex = '2147483647';
    root.style.pointerEvents = 'none';

    const label = document.createElement('div');
    label.style.fontWeight = '650';
    label.style.marginBottom = '6px';

    const detail = document.createElement('div');
    detail.style.color = '#4b5563';
    detail.style.marginBottom = '8px';

    const track = document.createElement('div');
    track.style.height = '6px';
    track.style.overflow = 'hidden';
    track.style.borderRadius = '999px';
    track.style.background = '#e5e7eb';

    const fill = document.createElement('div');
    fill.style.width = '0%';
    fill.style.height = '100%';
    fill.style.borderRadius = '999px';
    fill.style.background = '#2563eb';
    fill.style.transition = 'width 120ms ease';

    track.appendChild(fill);
    root.appendChild(label);
    root.appendChild(detail);
    root.appendChild(track);
    document.body.appendChild(root);

    progress = { root, label, detail, fill };
    helper.state.longTaskProgress = progress;
    return progress;
  }

  function updateLongTaskProgress({ label, current, total }) {
    const progress = ensureLongTaskProgress();
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCurrent = clamp(Number(current) || 0, 0, safeTotal || 1);
    const percent = safeTotal > 0 ? Math.round((safeCurrent / safeTotal) * 100) : 0;

    progress.label.textContent = label || 'Working...';
    progress.detail.textContent = safeTotal > 0 ? `${safeCurrent} / ${safeTotal} segments` : 'Preparing...';
    progress.fill.style.width = `${percent}%`;
  }

  function dismissLongTaskProgress() {
    const progress = helper.state.longTaskProgress;
    helper.state.longTaskProgress = null;
    if (progress && progress.root instanceof HTMLElement) {
      progress.root.remove();
    }
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

  function isNativeTimelineDoubleClickTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (node.hasAttribute(CUT_PREVIEW_ATTR)) {
        return false;
      }

      if (isRegionHandle(node) || isRegionBody(node)) {
        return true;
      }
    }

    const target = event.target;
    return Boolean(
      target instanceof HTMLElement &&
      (getRegionHandleElement(target) || getOwningRegionBody(target))
    );
  }

  function handleTimelineDoubleClick(event) {
    if (!isFeatureEnabled('disableNativeTimelineDoubleClick')) {
      return;
    }

    if (!isNativeTimelineDoubleClickTarget(event)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
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

  function clearZoomPersistenceTimer() {
    if (zoomPersistenceTimer) {
      window.clearTimeout(zoomPersistenceTimer);
      zoomPersistenceTimer = 0;
    }
  }

  function getNumericZoomValueFromSlider(slider) {
    if (!(slider instanceof HTMLElement)) {
      return null;
    }

    const numeric = Number(slider.getAttribute('aria-valuenow'));
    return Number.isFinite(numeric) ? numeric : null;
  }

  async function ensureZoomPersistenceDefaults() {
    if (zoomPersistenceLoaded && zoomPersistenceDefaults) {
      return zoomPersistenceDefaults;
    }

    const loaded = await loadWorkflowDefaults();
    zoomPersistenceDefaults = loaded;
    zoomPersistenceLoaded = true;
    return loaded;
  }

  async function persistZoomValue(value) {
    if (!isFeatureEnabled('timelineZoomDefaults')) {
      return;
    }

    const normalized = normalizeZoomValue(value);
    if (!Number.isFinite(normalized)) {
      return;
    }

    const defaults = await ensureZoomPersistenceDefaults();
    if (defaults.lastZoomValue === normalized) {
      return;
    }

    const saved = await updateWorkflowDefaults((currentDefaults) => ({
      ...currentDefaults,
      lastZoomValue: normalized
    }));
    zoomPersistenceDefaults = saved;
    zoomPersistenceLoaded = true;
  }

  function queuePersistZoomValue(value) {
    zoomPersistenceSaveChain = zoomPersistenceSaveChain
      .then(() => persistZoomValue(value))
      .catch(() => {});
  }

  function scheduleZoomPersistenceFromSlider(slider) {
    if (!isFeatureEnabled('timelineZoomDefaults')) {
      return;
    }

    if (zoomPersistenceApplying) {
      return;
    }

    const value = getNumericZoomValueFromSlider(slider);
    if (!Number.isFinite(value)) {
      return;
    }

    clearZoomPersistenceTimer();
    zoomPersistenceTimer = window.setTimeout(() => {
      zoomPersistenceTimer = 0;
      queuePersistZoomValue(value);
    }, ZOOM_PERSIST_DEBOUNCE_MS);
  }

  function getZoomValueCallbacks(slider) {
    if (!(slider instanceof HTMLElement)) {
      return [];
    }

    const callbacks = [];
    let node = getReactFiber(slider);
    let depth = 0;
    while (node && typeof node === 'object' && depth < 40) {
      const props = node.memoizedProps;
      if (props && typeof props === 'object' && typeof props.onValueChange === 'function') {
        callbacks.push(props.onValueChange);
      }

      node = node.return;
      depth += 1;
    }

    return callbacks;
  }

  async function applyZoomValueToSlider(value) {
    const slider = getZoomSliderElement();
    if (!(slider instanceof HTMLElement)) {
      return false;
    }

    const sliderMin = Number(slider.getAttribute('aria-valuemin'));
    const sliderMax = Number(slider.getAttribute('aria-valuemax'));
    if (!Number.isFinite(sliderMin) || !Number.isFinite(sliderMax) || sliderMax <= sliderMin) {
      return false;
    }

    const normalized = normalizeZoomValue(value);
    if (!Number.isFinite(normalized)) {
      return false;
    }

    const target = Math.min(sliderMax, Math.max(sliderMin, normalized));
    const current = getNumericZoomValueFromSlider(slider);
    if (Number.isFinite(current) && Math.abs(current - target) <= 0.5) {
      return true;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let invoked = false;
      const bridgeResult = await callSelectionBridge('zoom-set', {
        value: target
      });
      if (bridgeResult && bridgeResult.ok) {
        invoked = true;
      }

      if (!invoked) {
        const callbacks = getZoomValueCallbacks(slider);
        for (const callback of callbacks) {
          try {
            callback([target]);
            invoked = true;
          } catch (_error) {
            // Ignore callback shape mismatches; additional callbacks may still apply.
          }
        }
      }

      if (!invoked) {
        return false;
      }

      const settled = await helper.waitFor(() => {
        const refreshedSlider = getZoomSliderElement();
        const refreshedValue = getNumericZoomValueFromSlider(refreshedSlider);
        return Number.isFinite(refreshedValue) && Math.abs(refreshedValue - target) <= 1
          ? refreshedSlider
          : null;
      }, 240, 20);
      if (settled) {
        return true;
      }

      await helper.sleep(32);
    }

    return false;
  }

  helper.bindZoomPersistence = function bindZoomPersistence() {
    if (!isFeatureEnabled('timelineZoomDefaults')) {
      helper.unbindZoomPersistence();
      return false;
    }

    const slider = getZoomSliderElement();
    if (!(slider instanceof HTMLElement) || typeof MutationObserver !== 'function') {
      return false;
    }

    if (zoomPersistenceSlider === slider && zoomPersistenceObserver) {
      return true;
    }

    if (zoomPersistenceObserver && typeof zoomPersistenceObserver.disconnect === 'function') {
      zoomPersistenceObserver.disconnect();
    }

    zoomPersistenceSlider = slider;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'aria-valuenow') {
          scheduleZoomPersistenceFromSlider(slider);
          return;
        }
      }
    });

    observer.observe(slider, {
      attributes: true,
      attributeFilter: ['aria-valuenow']
    });

    zoomPersistenceObserver = observer;
    return true;
  };

  helper.unbindZoomPersistence = function unbindZoomPersistence() {
    clearZoomPersistenceTimer();

    if (zoomPersistenceObserver && typeof zoomPersistenceObserver.disconnect === 'function') {
      zoomPersistenceObserver.disconnect();
    }

    zoomPersistenceObserver = null;
    zoomPersistenceSlider = null;
  };

  helper.applySavedZoomDefault = async function applySavedZoomDefault() {
    if (!isFeatureEnabled('timelineZoomDefaults')) {
      return false;
    }

    const slider =
      getZoomSliderElement() ||
      (await helper.waitFor(() => getZoomSliderElement(), 1000, 50));
    if (!(slider instanceof HTMLElement)) {
      return false;
    }

    helper.bindZoomPersistence();

    const defaults = await ensureZoomPersistenceDefaults();
    const targetValue = normalizeZoomValue(defaults.lastZoomValue);
    if (!Number.isFinite(targetValue)) {
      return false;
    }

    const currentValue = getNumericZoomValueFromSlider(slider);
    if (Number.isFinite(currentValue) && Math.abs(currentValue - targetValue) <= 0.5) {
      return true;
    }

    zoomPersistenceApplying = true;
    try {
      return await applyZoomValueToSlider(targetValue);
    } finally {
      window.setTimeout(() => {
        zoomPersistenceApplying = false;
      }, 120);
    }
  };

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

  function isValidPreviewTimeRange(timeRange) {
    return Boolean(
      timeRange &&
        Number.isFinite(timeRange.startSeconds) &&
        Number.isFinite(timeRange.endSeconds) &&
        timeRange.endSeconds > timeRange.startSeconds
    );
  }

  function getPreviewDurationSeconds(preview) {
    if (!preview) {
      return null;
    }

    const timeRange = getPreviewTimeRange(preview);
    if (
      timeRange &&
      Number.isFinite(timeRange.startSeconds) &&
      Number.isFinite(timeRange.endSeconds) &&
      timeRange.endSeconds > timeRange.startSeconds
    ) {
      return timeRange.endSeconds - timeRange.startSeconds;
    }

    return null;
  }

  function getPreviewCommitSafetySeconds(preview) {
    if (!preview || !(preview.container instanceof HTMLElement)) {
      return CUT_PREVIEW_SAFETY_MIN_SECONDS;
    }
    const waveformEntry = getWaveformEntryForContainer(preview.container);
    const pixelsPerSecond = getWaveformPixelsPerSecond(waveformEntry, preview.container);
    if (!(Number.isFinite(pixelsPerSecond) && pixelsPerSecond > 0)) {
      return CUT_PREVIEW_SAFETY_MIN_SECONDS;
    }
    return clamp(
      2 / pixelsPerSecond,
      CUT_PREVIEW_SAFETY_MIN_SECONDS,
      CUT_PREVIEW_SAFETY_MAX_SECONDS
    );
  }

  function getPreviewTimeRange(preview, options) {
    if (!preview) {
      return null;
    }

    // Only trust the bridge-derived time range (Wavesurfer's native
    // pixelsPerSecond).  No local DOM-snapshot fallback — if we don't have
    // the bridge result yet, return null so callers see "no time" rather
    // than a wrong time.
    if (isValidPreviewTimeRange(preview.timeRange)) {
      return preview.timeRange;
    }

    const settings = options || {};
    if (!preview.timeRangeRequest && settings.allowAsync !== false) {
      void refreshPreviewTimeRange(preview);
    }

    return null;
  }

  async function refreshPreviewTimeRange(preview, options) {
    if (!preview || helper.state.cutPreview !== preview) {
      return null;
    }

    const settings = options || {};
    if (preview.timeRangeRequest && !settings.force) {
      return preview.timeRangeRequest;
    }

    const hostMarker =
      preview.hostMarker ||
      ensureSelectionHostMarker(preview.container);
    if (!hostMarker) {
      preview.timeRange = null;
      return null;
    }

    preview.hostMarker = hostMarker;
    const requestLeftPx = preview.leftPx;
    const requestRightPx = preview.rightPx;
    const request = callSelectionBridge('selection-time-range', {
      hostMarker,
      leftPx: requestLeftPx,
      rightPx: requestRightPx
    }).then((result) => {
      if (preview.timeRangeRequest !== request) {
        return getPreviewTimeRange(preview, { allowAsync: false });
      }

      preview.timeRangeRequest = null;
      if (
        preview.leftPx === requestLeftPx &&
        preview.rightPx === requestRightPx &&
        result &&
        result.ok &&
        isValidPreviewTimeRange(result)
      ) {
        // Always prefer the bridge result — it uses Wavesurfer's native
        // pixelsPerSecond which is exact, unlike DOM-snapshot interpolation.
        preview.timeRange = {
          startSeconds: result.startSeconds,
          endSeconds: result.endSeconds
        };
      } else if (
        preview.leftPx !== requestLeftPx ||
        preview.rightPx !== requestRightPx
      ) {
        // Selection moved while the request was in-flight; keep any existing
        // bridge result rather than clearing it (a fresh request will follow).
      } else {
        preview.timeRange = null;
      }

      if (helper.state.cutPreview === preview) {
        updatePreviewElement();
      }

      return preview.timeRange;
    });

    preview.timeRangeRequest = request;
    return request;
  }

  async function ensurePreviewTimeRange(preview) {
    const cached = getPreviewTimeRange(preview, { allowAsync: false });
    if (cached) {
      return cached;
    }

    if (preview.timeRangeRequest) {
      return (await preview.timeRangeRequest) || null;
    }

    return (await refreshPreviewTimeRange(preview, { force: true })) || null;
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

  function discoverWaveformContainers() {
    const containers = [];
    const seen = new Set();

    if (
      helper.state.cutLastContainer instanceof HTMLElement &&
      helper.state.cutLastContainer.isConnected
    ) {
      seen.add(helper.state.cutLastContainer);
      containers.push(helper.state.cutLastContainer);
    }

    for (const node of Array.from(document.querySelectorAll('div'))) {
      if (
        !(node instanceof HTMLDivElement) ||
        !(node.shadowRoot instanceof ShadowRoot) ||
        !helper.isVisible(node)
      ) {
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
        !container.isConnected
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
    return track && track.id != null ? String(track.id) : null;
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
    const safetyMargin = getPreviewCommitSafetySeconds(preview);
    const requiredDuration = CUT_PREVIEW_MIN_SECONDS + safetyMargin;
    const label = preview.element.querySelector('[data-babel-helper-cut-label]');
    const tooShort = Number.isFinite(duration) && duration < requiredDuration;
    preview.element.style.background = tooShort
      ? 'rgba(239, 68, 68, 0.18)'
      : 'rgba(14, 165, 233, 0.16)';
    preview.element.style.borderColor = tooShort ? 'rgba(220, 38, 38, 0.95)' : 'rgba(2, 132, 199, 0.95)';

    if (label instanceof HTMLElement) {
      const labelText = Number.isFinite(duration) ? duration.toFixed(2) + 's' : '';
      label.textContent = labelText;
      label.style.display = labelText ? 'block' : 'none';
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

    const activePreview = helper.state.cutPreview;
    const previewOwnsMarker =
      activePreview &&
      activePreview.hostMarker &&
      activePreview.hostMarker === loop.hostMarker;

    if (
      loop.host instanceof HTMLElement &&
      loop.hostMarker &&
      loop.host.getAttribute(SELECTION_LOOP_HOST_ATTR) === loop.hostMarker &&
      !previewOwnsMarker
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

    if (preview && preview.hostMarker) {
      const host = getWaveformHostFromContainer(preview.container);
      if (
        host instanceof HTMLElement &&
        host.getAttribute(SELECTION_LOOP_HOST_ATTR) === preview.hostMarker
      ) {
        host.removeAttribute(SELECTION_LOOP_HOST_ATTR);
      }
    }

    helper.state.cutPreview = null;
    helper.state.cutCommitPending = false;
    clearCutDraft();
  };

  helper.resetCutState = function resetCutState() {
    helper.state.smartSplitClickDraft = null;
    helper.state.smartSplitClickContext = null;
    helper.state.cutDraft = null;
    helper.state.cutLastContainer = null;
    helper.clearCutPreview();
  };

  helper.startSelectionLoop = async function startSelectionLoop() {
    const preview = helper.state.cutPreview;
    if (!preview || helper.state.cutCommitPending) {
      setSelectionLoopDebug(!preview ? 'no-preview' : 'commit-pending');
      return false;
    }

    const timeRange = await ensurePreviewTimeRange(preview);
    if (!timeRange) {
      setSelectionLoopDebug('no-time-range');
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
        kind: existing.kind || 'unknown'
      });
      helper.stopSelectionLoop();
      return true;
    }

    helper.stopSelectionLoop();

    const host = getWaveformHostFromContainer(preview.container);
    if (host instanceof HTMLElement) {
      const hostMarker =
        preview.hostMarker ||
        ensureSelectionHostMarker(preview.container);
      if (!hostMarker) {
        return false;
      }
      preview.hostMarker = hostMarker;
      const bridgeResult = await callSelectionBridge('loop-start', {
        hostMarker,
        startSeconds: timeRange.startSeconds,
        endSeconds: timeRange.endSeconds
      });
      if (bridgeResult && bridgeResult.ok) {
        helper.state.selectionLoop = {
          preview,
          host,
          kind: 'bridge',
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

      if (bridgeResult && bridgeResult.reason) {
        setSelectionLoopDebug('bridge-' + bridgeResult.reason);
      } else {
        setSelectionLoopDebug('bridge-failed');
      }
    }

    const playback = getSelectionPlaybackTarget(preview);
    if (!playback) {
      setSelectionLoopDebug('no-playback');
      return false;
    }

    const loop = {
      preview,
      playback,
      kind: playback.kind || 'unknown',
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

    preview.appendChild(leftHandle);
    preview.appendChild(rightHandle);
    preview.appendChild(label);
    draft.container.appendChild(preview);
    rememberCutContainer(draft.container);

    const zoomSignature = getLaneZoomSignature(draft.container);
    const hostMarker = ensureSelectionHostMarker(draft.container);

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
      zoomSignature,
      hostMarker,
      timeRange: null,
      timeRangeRequest: null,
      dragMode: 'create',
      dragStartClientX: draft.startClientX,
      originLeftPx: leftPx,
      originRightPx: rightPx
    };

    clearCutDraft();
    startCutPreviewZoomWatcher(helper.state.cutPreview);
    updatePreviewElement();
    // Eagerly request bridge-based time conversion so it's ready when the drag
    // ends, rather than waiting for the first getPreviewTimeRange call.
    void refreshPreviewTimeRange(helper.state.cutPreview);
  }

  function resetPreviewCreateAnchor(preview, clientX) {
    if (!preview) {
      return;
    }

    const minWidth = CUT_PREVIEW_MIN_WIDTH;
    const anchorPx = clamp(
      clientX - preview.containerRect.left,
      preview.regionLeftPx,
      preview.regionRightPx
    );
    let leftPx = anchorPx;
    let rightPx = Math.min(preview.regionRightPx, anchorPx + minWidth);

    if (rightPx - leftPx < minWidth) {
      leftPx = Math.max(preview.regionLeftPx, rightPx - minWidth);
    }

    preview.leftPx = leftPx;
    preview.rightPx = rightPx;
    preview.dragStartClientX = preview.containerRect.left + anchorPx;
    preview.originLeftPx = leftPx;
    preview.originRightPx = rightPx;
    preview.dragMode = 'create';
    preview.timeRange = null;
    preview.timeRangeRequest = null;
  }

  function applyAnchoredPreviewBounds(preview, anchorPx, currentPx) {
    if (!preview) {
      return;
    }

    const minWidth = CUT_PREVIEW_MIN_WIDTH;
    const normalizedAnchor = clamp(anchorPx, preview.regionLeftPx, preview.regionRightPx);
    const normalizedCurrent = clamp(currentPx, preview.regionLeftPx, preview.regionRightPx);

    if (normalizedCurrent <= normalizedAnchor) {
      preview.rightPx = normalizedAnchor;
      preview.leftPx = Math.min(normalizedCurrent, normalizedAnchor - minWidth);
      preview.leftPx = Math.max(preview.regionLeftPx, preview.leftPx);
      if (preview.rightPx - preview.leftPx < minWidth) {
        preview.leftPx = Math.max(preview.regionLeftPx, preview.rightPx - minWidth);
      }
      return;
    }

    preview.leftPx = normalizedAnchor;
    preview.rightPx = Math.max(normalizedCurrent, normalizedAnchor + minWidth);
    preview.rightPx = Math.min(preview.regionRightPx, preview.rightPx);
    if (preview.rightPx - preview.leftPx < minWidth) {
      preview.rightPx = Math.min(preview.regionRightPx, preview.leftPx + minWidth);
    }
  }

  function beginPreviewDrag(event) {
    if (event.button !== 0) {
      if (event.button === 1) {
        const previewElement = getPreviewHostFromEvent(event);
        if (previewElement instanceof HTMLElement && helper.state.cutPreview) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
      }

      return false;
    }

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
    helper.stopSelectionLoop();
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      resetPreviewCreateAnchor(preview, event.clientX);
      updatePreviewElement();
    } else if (nearLeftEdge && !nearRightEdge) {
      preview.dragStartClientX = event.clientX;
      preview.originLeftPx = preview.leftPx;
      preview.originRightPx = preview.rightPx;
      preview.dragAnchorPx = preview.rightPx;
      preview.dragMode = 'resize-left';
    } else if (nearRightEdge) {
      preview.dragStartClientX = event.clientX;
      preview.originLeftPx = preview.leftPx;
      preview.originRightPx = preview.rightPx;
      preview.dragAnchorPx = preview.leftPx;
      preview.dragMode = 'resize-right';
    } else {
      preview.dragStartClientX = event.clientX;
      preview.originLeftPx = preview.leftPx;
      preview.originRightPx = preview.rightPx;
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
    // Invalidate the cached bridge time range so a fresh request fires for the
    // new pixel bounds.  The bridge will be queried on the next
    // updatePreviewElement → getPreviewTimeRange call.
    preview.timeRange = null;
    preview.timeRangeRequest = null;
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
      const anchorLeft = Math.min(startX, currentX);
      const anchorRight = Math.max(startX, currentX);
      preview.leftPx = anchorLeft;
      preview.rightPx = Math.max(anchorLeft + minWidth, anchorRight);
      preview.rightPx = Math.min(preview.rightPx, preview.regionRightPx);
    } else if (preview.dragMode === 'resize-left') {
      applyAnchoredPreviewBounds(
        preview,
        Number.isFinite(preview.dragAnchorPx) ? preview.dragAnchorPx : preview.originRightPx,
        preview.originLeftPx + dx
      );
    } else if (preview.dragMode === 'resize-right') {
      applyAnchoredPreviewBounds(
        preview,
        Number.isFinite(preview.dragAnchorPx) ? preview.dragAnchorPx : preview.originLeftPx,
        preview.originRightPx + dx
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
    // Force a fresh bridge request for the final selection bounds so the label
    // and subsequent operations use accurate Wavesurfer-derived time.
    void refreshPreviewTimeRange(preview, { force: true });
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

      if (getRegionHandleElement(node)) {
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

  function dispatchSplitClick(target, clientX, clientY, options) {
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const settings = options || {};
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
        shiftKey: Boolean(settings.shiftKey),
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

  function getAudioTrimAmplitudeThreshold(options, fallback) {
    const value = Number(options && options.amplitudeThreshold);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  function getTrimProgressLabel(options) {
    const label = options && typeof options.progressLabel === 'string' ? options.progressLabel.trim() : '';
    return label || 'Trimming visible segments';
  }

  async function requestTrimTargetsForContainer(container, entry, options) {
    if (!(container instanceof HTMLElement) || !entry) {
      return null;
    }

    const hostMarker = ensureSelectionHostMarker(container);
    if (!hostMarker) {
      return null;
    }

    const startSeconds = parseTimeValue(entry.startText);
    const endSeconds = parseTimeValue(entry.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return callSelectionBridge('trim-segment-audio', {
      hostMarker,
      startSeconds,
      endSeconds,
      amplitudeThreshold: getAudioTrimAmplitudeThreshold(options, AUDIO_TRIM_INWARD_THRESHOLD),
      paddingSeconds: AUDIO_TRIM_PADDING_SECONDS
    });
  }

  async function requestTrimTargetsForSpeaker(speakerKey, entry, options) {
    if (!entry) {
      return null;
    }

    const startSeconds = parseTimeValue(entry.startText);
    const endSeconds = parseTimeValue(entry.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return callSelectionBridge('trim-segment-audio-for-speaker', {
      speakerKey,
      startSeconds,
      endSeconds,
      amplitudeThreshold: getAudioTrimAmplitudeThreshold(options, AUDIO_TRIM_INWARD_THRESHOLD),
      paddingSeconds: AUDIO_TRIM_PADDING_SECONDS
    });
  }

  async function requestTrimTargets(target, labels, speakerKey, options) {
    const primary =
      target && target.container instanceof HTMLElement && target.entry
        ? await requestTrimTargetsForContainer(target.container, target.entry, options)
        : null;
    if (primary && primary.ok) {
      return primary;
    }

    const fallbackEntry =
      target && target.entry
        ? target.entry
        : labels && labels.startText && labels.endText
          ? labels
            : null;
    const fallback = await requestTrimTargetsForSpeaker(speakerKey, fallbackEntry, options);
    return fallback || primary;
  }

  async function requestExtendTargetsForContainer(container, entry, options) {
    if (!(container instanceof HTMLElement) || !entry) {
      return null;
    }

    const hostMarker = ensureSelectionHostMarker(container);
    if (!hostMarker) {
      return null;
    }

    const startSeconds = parseTimeValue(entry.startText);
    const endSeconds = parseTimeValue(entry.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return callSelectionBridge('extend-segment-audio-to-silence', {
      hostMarker,
      startSeconds,
      endSeconds,
      amplitudeThreshold: getAudioTrimAmplitudeThreshold(options, AUDIO_TRIM_OUTWARD_THRESHOLD),
      stepSeconds: AUDIO_TRIM_OUTWARD_STEP_SECONDS
    });
  }

  async function requestExtendTargetsForSpeaker(speakerKey, entry, options) {
    if (!entry) {
      return null;
    }

    const startSeconds = parseTimeValue(entry.startText);
    const endSeconds = parseTimeValue(entry.endText);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      return null;
    }

    return callSelectionBridge('extend-segment-audio-to-silence-for-speaker', {
      speakerKey,
      startSeconds,
      endSeconds,
      amplitudeThreshold: getAudioTrimAmplitudeThreshold(options, AUDIO_TRIM_OUTWARD_THRESHOLD),
      stepSeconds: AUDIO_TRIM_OUTWARD_STEP_SECONDS
    });
  }

  async function requestExtendTargets(target, labels, speakerKey, options) {
    const primary =
      target && target.container instanceof HTMLElement && target.entry
        ? await requestExtendTargetsForContainer(target.container, target.entry, options)
        : null;
    if (primary && primary.ok) {
      return primary;
    }

    const fallbackEntry =
      target && target.entry
        ? target.entry
        : labels && labels.startText && labels.endText
          ? labels
            : null;
    const fallback = await requestExtendTargetsForSpeaker(speakerKey, fallbackEntry, options);
    return fallback || primary;
  }

  async function moveSegmentBoundary(side, labels, speakerKey, targetSeconds) {
    return helper.setSegmentBoundaryTime({
      side,
      startText: labels.startText,
      endText: labels.endText,
      speakerKey,
      targetSeconds,
      attempts: 2,
      retryDelayMs: 70
    });
  }

  function getCurrentMoveLabels(row, fallbackLabels) {
    return getRowTimeLabels(row) || fallbackLabels;
  }

  function getSameSpeakerBoundaryNeighborLimits(row, speakerKey) {
    if (!(row instanceof HTMLTableRowElement)) {
      return {
        minStartSeconds: null,
        maxEndSeconds: null
      };
    }

    const targetSpeakerKey =
      (typeof speakerKey === 'string' && speakerKey) || helper.getRowSpeakerKey(row);
    if (!targetSpeakerKey) {
      return {
        minStartSeconds: null,
        maxEndSeconds: null
      };
    }

    const sameSpeakerRows = helper
      .getTranscriptRows()
      .filter(
        (candidate) =>
          candidate instanceof HTMLTableRowElement &&
          candidate.isConnected &&
          helper.getRowSpeakerKey(candidate) === targetSpeakerKey
      );
    const rowIndex = sameSpeakerRows.indexOf(row);
    if (rowIndex < 0) {
      return {
        minStartSeconds: null,
        maxEndSeconds: null
      };
    }

    let minStartSeconds = null;
    for (let index = rowIndex - 1; index >= 0; index -= 1) {
      const previousRange = getRowTimeRange(sameSpeakerRows[index]);
      if (previousRange && Number.isFinite(previousRange.endSeconds)) {
        minStartSeconds = previousRange.endSeconds + AUDIO_TRIM_NEIGHBOR_GUARD_SECONDS;
        break;
      }
    }

    let maxEndSeconds = null;
    for (let index = rowIndex + 1; index < sameSpeakerRows.length; index += 1) {
      const nextRange = getRowTimeRange(sameSpeakerRows[index]);
      if (nextRange && Number.isFinite(nextRange.startSeconds)) {
        maxEndSeconds = nextRange.startSeconds - AUDIO_TRIM_NEIGHBOR_GUARD_SECONDS;
        break;
      }
    }

    return {
      minStartSeconds,
      maxEndSeconds
    };
  }

  function capOutwardBoundaryTarget(row, side, speakerKey, targetSeconds) {
    if (!Number.isFinite(targetSeconds)) {
      return targetSeconds;
    }

    const limits = getSameSpeakerBoundaryNeighborLimits(row, speakerKey);
    if (side === 'right' && Number.isFinite(limits.maxEndSeconds)) {
      return Math.min(targetSeconds, limits.maxEndSeconds);
    }

    if (side === 'left' && Number.isFinite(limits.minStartSeconds)) {
      return Math.max(targetSeconds, limits.minStartSeconds);
    }

    return targetSeconds;
  }

  async function applyInwardTrimToRow(row, speakerKey, trimBridgeResult) {
    let labels = getRowTimeLabels(row);
    const rowRange = getRowTimeRange(row);
    if (!labels || !rowRange || !trimBridgeResult || !trimBridgeResult.ok || !trimBridgeResult.foundAudio) {
      return { ok: true, changed: false };
    }

    let leftChanged = false;
    let rightChanged = false;
    const nextEndSeconds = Number(trimBridgeResult.targetEndSeconds);
    const nextStartSeconds = Number(trimBridgeResult.targetStartSeconds);

    if (
      Number.isFinite(nextEndSeconds) &&
      nextEndSeconds < rowRange.endSeconds - AUDIO_TRIM_EPSILON_SECONDS &&
      nextEndSeconds > rowRange.startSeconds + AUDIO_TRIM_EPSILON_SECONDS
    ) {
      const movedRight = await moveSegmentBoundary('right', labels, speakerKey, nextEndSeconds);
      if (!movedRight || !movedRight.ok) {
        return { ok: false, reason: 'right-trim-failed' };
      }
      rightChanged = true;
      labels = getCurrentMoveLabels(row, labels);
      await helper.sleep(32);
    }

    if (
      Number.isFinite(nextStartSeconds) &&
      nextStartSeconds > rowRange.startSeconds + AUDIO_TRIM_EPSILON_SECONDS &&
      nextStartSeconds < rowRange.endSeconds - AUDIO_TRIM_EPSILON_SECONDS
    ) {
      const movedLeft = await moveSegmentBoundary('left', getCurrentMoveLabels(row, labels), speakerKey, nextStartSeconds);
      if (!movedLeft || !movedLeft.ok) {
        return { ok: false, reason: 'left-trim-failed' };
      }
      leftChanged = true;
    }

    return {
      ok: true,
      changed: leftChanged || rightChanged,
      leftChanged,
      rightChanged
    };
  }

  async function requestTrimTargetsForRow(row, speakerKey, options) {
    const labels = getRowTimeLabels(row);
    if (!labels) {
      return null;
    }

    return requestTrimTargetsForSpeaker(speakerKey, labels, options);
  }

  function collectAutoSegmentTargets() {
    const targets = [];
    const containers = discoverWaveformContainers();
    for (const row of helper.getTranscriptRows()) {
      if (!(row instanceof HTMLTableRowElement)) {
        continue;
      }

      const labels = getRowTimeLabels(row);
      const startSeconds = labels ? parseTimeValue(labels.startText) : null;
      const endSeconds = labels ? parseTimeValue(labels.endText) : null;
      if (!labels || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        continue;
      }

      const speakerKey = helper.getRowSpeakerKey(row);
      const rowIdentity = typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null;
      const container =
        containers.find((candidate) => {
          const candidateSpeakerKey = getSpeakerKeyForContainer(candidate);
          return !speakerKey || candidateSpeakerKey === speakerKey;
        }) || null;

      targets.push({
        row,
        rowIdentity,
        annotationId:
          rowIdentity && typeof rowIdentity.annotationId === 'string' ? rowIdentity.annotationId : '',
        container,
        speakerKey,
        entry: {
          startText: labels.startText,
          endText: labels.endText
        },
        startSeconds,
        endSeconds
      });
    }

    return targets;
  }

  function getAutoSegmentTargetDiagnostics() {
    const rows = helper.getTranscriptRows();
    const fallbackRows = getFallbackTranscriptRows();
    const containers = discoverWaveformContainers();
    return {
      rowCount: rows.length,
      fallbackRowCount: fallbackRows.length,
      containerCount: containers.length,
      rows: rows.slice(0, 5).map((row) => {
        const labels = getRowTimeLabels(row);
        return {
          speakerKey: helper.getRowSpeakerKey(row),
          startText: labels ? labels.startText : '',
          endText: labels ? labels.endText : '',
          hasTextarea: Boolean(row.querySelector('textarea'))
        };
      }),
      containers: containers.slice(0, 5).map((container) => ({
        speakerKey: getSpeakerKeyForContainer(container),
        hasHost: getWaveformHostFromContainer(container) instanceof HTMLElement
      }))
    };
  }

  async function requestAutoSegmentSilenceRuns(target) {
    if (!target || !target.entry) {
      return null;
    }

    const hostMarker =
      target.container instanceof HTMLElement ? ensureSelectionHostMarker(target.container) : '';
    if (target.container instanceof HTMLElement && !hostMarker) {
      return null;
    }

    return callSelectionBridge('find-segment-silence-runs', {
      hostMarker,
      speakerKey: target.speakerKey,
      startSeconds: target.startSeconds,
      endSeconds: target.endSeconds,
      amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD,
      minimumSilenceSeconds: AUTO_SEGMENT_SILENCE_MIN_SECONDS
    });
  }

  function getAutoSegmentRowActionSnapshot(row) {
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    const labels = getRowTimeLabels(row);
    const range = getRowTimeRange(row);
    if (!labels || !range) {
      return null;
    }

    const speakerKey = helper.getRowSpeakerKey(row);
    const rowIdentity = typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null;
    return {
      row,
      rowIdentity,
      annotationId:
        rowIdentity && typeof rowIdentity.annotationId === 'string' ? rowIdentity.annotationId : '',
      speakerKey,
      startText: labels.startText,
      endText: labels.endText,
      startSeconds: range.startSeconds,
      endSeconds: range.endSeconds
    };
  }

  function collectAutoSegmentMergePlans() {
    const rows = helper.getTranscriptRows();
    const rowsBySpeaker = new Map();
    const plans = [];
    const seen = new Set();

    for (const row of rows) {
      const snapshot = getAutoSegmentRowActionSnapshot(row);
      if (!snapshot || !snapshot.speakerKey) {
        continue;
      }

      const speakerRows = rowsBySpeaker.get(snapshot.speakerKey);
      if (speakerRows) {
        speakerRows.push(snapshot);
      } else {
        rowsBySpeaker.set(snapshot.speakerKey, [snapshot]);
      }
    }

    for (const speakerRows of rowsBySpeaker.values()) {
      speakerRows.sort((left, right) => left.startSeconds - right.startSeconds);

      for (let index = speakerRows.length - 2; index >= 0; index -= 1) {
        const current = speakerRows[index];
        const next = speakerRows[index + 1];
        const gapSeconds = next.startSeconds - current.endSeconds;
        if (!Number.isFinite(gapSeconds) || gapSeconds > AUTO_SEGMENT_MERGE_GAP_SECONDS) {
          continue;
        }

        const key = [
          current.annotationId || current.startText,
          next.annotationId || next.startText,
          Math.round(current.endSeconds * 1000),
          Math.round(next.startSeconds * 1000)
        ].join(':');
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        plans.push({
          key,
          current,
          next,
          gapSeconds
        });
      }
    }

    return plans;
  }

  async function mergeAutoSegmentCloseRows() {
    const skipped = new Set();
    let mergeCount = 0;
    let skippedCount = 0;

    for (let attempt = 0; attempt < 200; attempt += 1) {
      const plan = collectAutoSegmentMergePlans().find((candidate) => !skipped.has(candidate.key));
      if (!plan) {
        break;
      }

      const result = await helper.mergeSegmentWithNativeAction({
        direction: 'below',
        annotationId: plan.current.annotationId,
        rowIdentity: plan.current.rowIdentity,
        startText: plan.current.startText,
        endText: plan.current.endText,
        startSeconds: plan.current.startSeconds,
        endSeconds: plan.current.endSeconds,
        speakerKey: plan.current.speakerKey,
        attempts: 2,
        retryDelayMs: 80
      });

      if (result && result.ok) {
        mergeCount += 1;
        skipped.clear();
        await helper.sleep(AUTO_SEGMENT_SPLIT_SETTLE_MS);
        continue;
      }

      skipped.add(plan.key);
      skippedCount += 1;
    }

    return {
      ok: true,
      mergeCount,
      skippedCount
    };
  }

  function findNearestSameSpeakerAutoSegmentRow(silent) {
    if (!silent || !(silent.row instanceof HTMLTableRowElement)) {
      return null;
    }

    const speakerKey = typeof silent.speakerKey === 'string' ? silent.speakerKey : '';
    if (!speakerKey) {
      return null;
    }

    let best = null;
    let bestDistance = Infinity;
    let bestBefore = false;
    for (const candidate of helper.getTranscriptRows()) {
      if (!(candidate instanceof HTMLTableRowElement) || candidate === silent.row) {
        continue;
      }

      const candidateSpeakerKey = helper.getRowSpeakerKey(candidate);
      if (candidateSpeakerKey !== speakerKey) {
        continue;
      }

      const range = getRowTimeRange(candidate);
      if (!range) {
        continue;
      }

      const isBefore = range.endSeconds <= silent.startSeconds;
      const distance = isBefore
        ? silent.startSeconds - range.endSeconds
        : range.startSeconds >= silent.endSeconds
          ? range.startSeconds - silent.endSeconds
          : 0;
      if (
        distance < bestDistance ||
        (distance === bestDistance && isBefore && !bestBefore)
      ) {
        best = {
          row: candidate,
          range
        };
        bestDistance = distance;
        bestBefore = isBefore;
      }
    }

    return best;
  }

  function stitchAutoSegmentSilentText(silent, nearest) {
    if (!silent || !nearest || !(nearest.row instanceof HTMLTableRowElement)) {
      return { ok: false, reason: 'missing-nearest-row' };
    }

    const silentText = helper.getRowTextValue(silent.row);
    if (!silentText) {
      return { ok: true, changed: false };
    }

    const nearestTextarea = helper.getRowTextarea(nearest.row);
    if (!(nearestTextarea instanceof HTMLTextAreaElement)) {
      return { ok: false, reason: 'missing-nearest-textarea' };
    }

    const nearestText = helper.getRowTextValue(nearest.row);
    const silentComesFirst =
      silent.endSeconds <= nearest.range.startSeconds ||
      (silent.startSeconds < nearest.range.startSeconds &&
        !(nearest.range.endSeconds <= silent.startSeconds));
    const nextText = silentComesFirst
      ? helper.joinSegmentText(silentText, nearestText)
      : helper.joinSegmentText(nearestText, silentText);
    if (nextText === nearestText) {
      return { ok: true, changed: false };
    }

    if (!helper.setEditableValue(nearestTextarea, nextText)) {
      return { ok: false, reason: 'text-stitch-failed' };
    }

    return { ok: true, changed: true };
  }

  async function collectAutoSegmentSilentRowPlans() {
    const targets = collectAutoSegmentTargets();
    const silentRows = [];
    for (const target of targets) {
      const labels =
        target && target.entry && target.entry.startText && target.entry.endText
          ? target.entry
          : null;
      if (!labels) {
        continue;
      }

      const probe = await requestTrimTargets(target, labels, target.speakerKey, {
        amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD
      });
      if (probe && probe.ok && !probe.foundAudio) {
        silentRows.push({
          ...target,
          probe
        });
      }
    }

    return silentRows;
  }

  function getAutoSegmentErrorMessage(error) {
    if (!error) {
      return '';
    }
    if (typeof error === 'string') {
      return error.slice(0, 240);
    }
    if (typeof error.message === 'string') {
      return error.message.slice(0, 240);
    }
    return String(error).slice(0, 240);
  }

  function createAutoSegmentCleanupFailureResult(error) {
    return {
      ok: false,
      reason: 'silent-cleanup-threw',
      deleteCount: 0,
      stitchCount: 0,
      skippedCount: 0,
      errorMessage: getAutoSegmentErrorMessage(error)
    };
  }

  function createAutoSegmentRedistributionFailureResult(error) {
    return {
      ok: false,
      reason: 'redistribution-threw',
      changedCount: 0,
      appliedGroupCount: 0,
      skippedCount: 0,
      groupCount: 0,
      audioSampleCount: 0,
      errorMessage: getAutoSegmentErrorMessage(error)
    };
  }

  async function cleanupAutoSegmentSilentRows() {
    let silentRows = [];
    try {
      silentRows = await collectAutoSegmentSilentRowPlans();
    } catch (error) {
      return {
        ok: false,
        reason: 'silent-cleanup-probe-failed',
        deleteCount: 0,
        stitchCount: 0,
        skippedCount: 0,
        errorMessage: getAutoSegmentErrorMessage(error)
      };
    }

    let deleteCount = 0;
    let stitchCount = 0;
    let skippedCount = 0;
    let lastErrorMessage = '';

    if (!silentRows.length) {
      return {
        ok: true,
        deleteCount,
        stitchCount,
        skippedCount,
        reason: 'no-silent-rows'
      };
    }

    if (typeof helper.deleteSegmentWithNativeAction !== 'function') {
      return {
        ok: false,
        reason: 'missing-delete-action',
        deleteCount,
        stitchCount,
        skippedCount: silentRows.length
      };
    }

    for (const silent of silentRows.reverse()) {
      try {
        if (!(silent.row instanceof HTMLTableRowElement) || !silent.row.isConnected) {
          continue;
        }

        const silentText = helper.getRowTextValue(silent.row);
        const nearest = findNearestSameSpeakerAutoSegmentRow(silent);
        if (!nearest && silentText) {
          skippedCount += 1;
          continue;
        }

        if (nearest) {
          const stitchResult = stitchAutoSegmentSilentText(silent, nearest);
          if (!stitchResult || !stitchResult.ok) {
            skippedCount += 1;
            continue;
          }
          if (stitchResult.changed) {
            stitchCount += 1;
            await helper.sleep(32);
          }
        }

        const deleteResult = await helper.deleteSegmentWithNativeAction({
          annotationId: silent.annotationId,
          rowIdentity: silent.rowIdentity,
          startText: silent.entry.startText,
          endText: silent.entry.endText,
          startSeconds: silent.startSeconds,
          endSeconds: silent.endSeconds,
          speakerKey: silent.speakerKey,
          attempts: 2,
          retryDelayMs: 80
        });
        if (deleteResult && deleteResult.ok) {
          deleteCount += 1;
          await helper.sleep(AUTO_SEGMENT_SPLIT_SETTLE_MS);
        } else {
          skippedCount += 1;
        }
      } catch (error) {
        skippedCount += 1;
        lastErrorMessage = getAutoSegmentErrorMessage(error);
      }
    }

    const result = {
      ok: true,
      deleteCount,
      stitchCount,
      skippedCount
    };
    if (lastErrorMessage) {
      result.errorMessage = lastErrorMessage;
    }
    return result;
  }

  function normalizeAutoSegmentRedistributionText(value) {
    return normalizeAutoSegmentText(value);
  }

  function getAutoSegmentRedistributionRowSegment(row, index) {
    if (!(row instanceof HTMLTableRowElement)) {
      return null;
    }

    const speakerKey = helper.getRowSpeakerKey(row);
    const labels = getRowTimeLabels(row);
    const range = getRowTimeRange(row);
    if (!speakerKey || !labels || !range) {
      return null;
    }

    const rowIdentity = typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null;
    const annotationId =
      rowIdentity && typeof rowIdentity.annotationId === 'string' ? rowIdentity.annotationId : '';
    return {
      id:
        annotationId ||
        [
          speakerKey,
          Math.round(range.startSeconds * 1000),
          Math.round(range.endSeconds * 1000),
          index
        ].join(':'),
      row,
      rowIdentity,
      speakerKey,
      startSeconds: range.startSeconds,
      endSeconds: range.endSeconds,
      startText: labels.startText,
      endText: labels.endText,
      text: normalizeAutoSegmentRedistributionText(helper.getRowTextValue(row))
    };
  }

  function collectAutoSegmentTextBaselineGroups() {
    const groups = [];
    let current = null;
    const rows = helper.getTranscriptRows();

    for (let index = 0; index < rows.length; index += 1) {
      const segment = getAutoSegmentRedistributionRowSegment(rows[index], index);
      if (!segment) {
        current = null;
        continue;
      }

      const gapSeconds = current ? segment.startSeconds - current.endSeconds : Infinity;
      if (
        !current ||
        segment.speakerKey !== current.speakerKey ||
        !Number.isFinite(gapSeconds) ||
        gapSeconds > AUTO_SEGMENT_MERGE_GAP_SECONDS
      ) {
        current = {
          id: 'baseline-' + groups.length,
          speakerKey: segment.speakerKey,
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          fullText: '',
          segments: []
        };
        groups.push(current);
      }

      current.segments.push(segment);
      current.startSeconds = Math.min(current.startSeconds, segment.startSeconds);
      current.endSeconds = Math.max(current.endSeconds, segment.endSeconds);
      current.fullText = current.segments
        .map((item) => normalizeAutoSegmentRedistributionText(item.text))
        .filter(Boolean)
        .join(' ');
    }

    return groups.filter(
      (group) =>
        normalizeAutoSegmentRedistributionText(group.fullText) &&
        group.segments.some((segment) => normalizeAutoSegmentRedistributionText(segment.text))
    );
  }

  function collectCurrentAutoSegmentRedistributionSegments() {
    const rows = helper.getTranscriptRows();
    return rows
      .map((row, index) => getAutoSegmentRedistributionRowSegment(row, index))
      .filter(Boolean);
  }

  function collectAutoSegmentTextRedistributionGroups(baselineGroups) {
    const baselines = Array.isArray(baselineGroups) ? baselineGroups : [];
    const currentSegments = collectCurrentAutoSegmentRedistributionSegments();
    if (baselines.length) {
      return baselines
        .map((baseline) => {
          const segments = currentSegments
            .filter(
              (segment) =>
                segment.speakerKey === baseline.speakerKey &&
                segment.endSeconds > baseline.startSeconds - AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS &&
                segment.startSeconds < baseline.endSeconds + AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS
            )
            .sort((left, right) => left.startSeconds - right.startSeconds);
          return {
            speakerKey: baseline.speakerKey,
            fullText: normalizeAutoSegmentRedistributionText(baseline.fullText),
            segments
          };
        })
        .filter((group) => group.fullText && group.segments.length > 0);
    }

    const groups = [];
    let current = null;
    for (const segment of currentSegments) {
      if (!current || segment.speakerKey !== current.speakerKey) {
        current = {
          speakerKey: segment.speakerKey,
          fullText: '',
          segments: []
        };
        groups.push(current);
      }
      current.segments.push(segment);
      current.fullText = current.segments
        .map((item) => normalizeAutoSegmentRedistributionText(item.text))
        .filter(Boolean)
        .join(' ');
    }

    return groups.filter((group) => group.segments.length > 0 && normalizeAutoSegmentRedistributionText(group.fullText));
  }

  async function prepareAutoSegmentTextRedistributionSession() {
    const result = await callSelectionBridge('prepare-auto-segment-text-redistribution', {
      timeoutMs: 30000
    });
    return result || {
      ok: false,
      reason: 'prompt-api-prepare-timeout'
    };
  }

  async function disposeAutoSegmentTextRedistributionSession(sessionResult) {
    const sessionId =
      sessionResult && sessionResult.ok && typeof sessionResult.sessionId === 'string'
        ? sessionResult.sessionId
        : '';
    if (!sessionId) {
      return null;
    }

    return callSelectionBridge('destroy-auto-segment-text-redistribution-session', {
      sessionId,
      timeoutMs: 3000
    });
  }

  function applyAutoSegmentTextRedistributionAllocations(group, allocations) {
    if (!validateAutoSegmentTextAllocationsPreserveText(group, allocations)) {
      return {
        ok: false,
        reason: 'invalid-redistribution'
      };
    }

    let changedCount = 0;
    for (let index = 0; index < group.segments.length; index += 1) {
      const segment = group.segments[index];
      const allocation = allocations[index];
      if (!(segment.row instanceof HTMLTableRowElement) || !segment.row.isConnected) {
        continue;
      }

      const textarea = helper.getRowTextarea(segment.row);
      if (!(textarea instanceof HTMLTextAreaElement)) {
        continue;
      }

      if (allocation.text === normalizeAutoSegmentRedistributionText(textarea.value || '')) {
        continue;
      }

      if (helper.setEditableValue(textarea, allocation.text)) {
        changedCount += 1;
      }
    }

    return {
      ok: true,
      changedCount
    };
  }

  async function redistributeAutoSegmentTextWithPromptApi(baselineGroups) {
    const sessionResult = autoSegmentTextRedistributionSession;
    const hasPromptSession = Boolean(sessionResult && sessionResult.ok && sessionResult.sessionId);
    const groups = collectAutoSegmentTextRedistributionGroups(baselineGroups);
    if (!groups.length) {
      return {
        ok: true,
        changedCount: 0,
        appliedGroupCount: 0,
        skippedCount: 0,
        groupCount: 0,
        reason: 'no-text-redistribution-groups'
      };
    }

    let changedCount = 0;
    let appliedGroupCount = 0;
    let skippedCount = 0;
    let audioSampleCount = 0;
    let errorCount = 0;
    let draftGroupCount = 0;
    let promptReviewCount = 0;
    let rejectedPromptReviewCount = 0;
    let lastErrorMessage = '';

    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      updateLongTaskProgress({
        label: 'Aligning segmented text',
        current: index,
        total: groups.length
      });

      const draftResult = createAutoSegmentTextRedistributionDraft(group);
      if (!draftResult || !draftResult.ok) {
        skippedCount += 1;
        continue;
      }

      draftGroupCount += 1;
      let allocations = draftResult.allocations;
      let bridgeResult = null;
      if (hasPromptSession) {
        try {
          bridgeResult = await callSelectionBridge('auto-segment-redistribute-text', {
            sessionId: sessionResult.sessionId,
            speakerKey: group.speakerKey,
            fullText: draftResult.fullText,
            segments: group.segments.map((segment) => ({
              id: segment.id,
              speakerKey: segment.speakerKey,
              startSeconds: segment.startSeconds,
              endSeconds: segment.endSeconds
            })),
            draftAllocations: draftResult.allocations,
            timeoutMs: 45000
          });
        } catch (error) {
          errorCount += 1;
          lastErrorMessage = getAutoSegmentErrorMessage(error);
        }

        if (bridgeResult && bridgeResult.ok && bridgeResult.review) {
          const reviewResult = applyAutoSegmentTextReview(group, draftResult.allocations, bridgeResult.review);
          if (reviewResult && reviewResult.ok) {
            allocations = reviewResult.allocations;
            promptReviewCount += 1;
          } else {
            rejectedPromptReviewCount += 1;
          }
          audioSampleCount += Number(bridgeResult.audioSampleCount) || 0;
        } else if (bridgeResult && !bridgeResult.ok) {
          rejectedPromptReviewCount += 1;
        }
      }

      let applyResult = null;
      try {
        applyResult = applyAutoSegmentTextRedistributionAllocations(group, allocations);
      } catch (error) {
        skippedCount += 1;
        errorCount += 1;
        lastErrorMessage = getAutoSegmentErrorMessage(error);
        continue;
      }
      if (!applyResult || !applyResult.ok) {
        skippedCount += 1;
        continue;
      }

      appliedGroupCount += 1;
      changedCount += applyResult.changedCount || 0;
      if (applyResult.changedCount) {
        await helper.sleep(32);
      }
    }

    updateLongTaskProgress({
      label: 'Aligning segmented text',
      current: groups.length,
      total: groups.length
    });

    const result = {
      ok: true,
      changedCount,
      appliedGroupCount,
      skippedCount,
      groupCount: groups.length,
      audioSampleCount,
      draftGroupCount,
      promptReviewCount,
      rejectedPromptReviewCount,
      unavailable: !hasPromptSession
    };
    if (errorCount) {
      result.errorCount = errorCount;
      result.errorMessage = lastErrorMessage;
    }
    return result;
  }

  function emitAutoSegmentDebug(detail) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') {
      return;
    }

    window.dispatchEvent(
      new CustomEvent('babel-helper-auto-segmentation-debug', {
        detail
      })
    );
  }

  function collectAutoSegmentSplitPlans(targets, silenceResults) {
    const plans = [];
    const seen = new Set();
    const results = Array.isArray(silenceResults) ? silenceResults : [];

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const result = results[index];
      const runs = result && result.ok && Array.isArray(result.runs) ? result.runs : [];
      for (const run of runs) {
        const splitSeconds = Number(run && run.splitSeconds);
        if (
          !Number.isFinite(splitSeconds) ||
          splitSeconds <= target.startSeconds + AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS ||
          splitSeconds >= target.endSeconds - AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS
        ) {
          continue;
        }

        const key = [
          target.speakerKey || '',
          Math.round(splitSeconds * 1000)
        ].join(':');
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        plans.push({
          container: target.container,
          row: target.row,
          rowIdentity: target.rowIdentity || null,
          annotationId: target.annotationId || '',
          speakerKey: target.speakerKey,
          splitSeconds,
          startSeconds: target.startSeconds,
          endSeconds: target.endSeconds
        });
      }
    }

    return plans.sort((left, right) => right.splitSeconds - left.splitSeconds);
  }

  function findCurrentAutoSegmentSplitRow(plan) {
    if (!plan || !Number.isFinite(plan.splitSeconds)) {
      return null;
    }

    const speakerKey =
      typeof plan.speakerKey === 'string' && plan.speakerKey ? plan.speakerKey : '';
    for (const row of helper.getTranscriptRows()) {
      if (!(row instanceof HTMLTableRowElement)) {
        continue;
      }

      if (speakerKey && helper.getRowSpeakerKey(row) !== speakerKey) {
        continue;
      }

      const range = getRowTimeRange(row);
      if (!range) {
        continue;
      }

      if (
        plan.splitSeconds > range.startSeconds + AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS &&
        plan.splitSeconds < range.endSeconds - Math.max(AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS, 0.1)
      ) {
        return row;
      }
    }

    return plan.row instanceof HTMLTableRowElement && plan.row.isConnected ? plan.row : null;
  }

  function buildSmartSplitPlanForRow(row, splitSeconds, speakerKey) {
    if (!(row instanceof HTMLTableRowElement) || !Number.isFinite(splitSeconds)) {
      return null;
    }

    const range = getRowTimeRange(row);
    if (
      !range ||
      splitSeconds <= range.startSeconds + AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS ||
      splitSeconds >= range.endSeconds - AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS
    ) {
      return null;
    }

    const rows = helper.getTranscriptRows();
    const sourceRowIndex = rows.indexOf(row);
    if (sourceRowIndex < 0) {
      return null;
    }

    const sourceSpeakerKey =
      (typeof speakerKey === 'string' && speakerKey) || helper.getRowSpeakerKey(row);
    const sameSpeakerRows = sourceSpeakerKey
      ? rows.filter((candidate) => helper.getRowSpeakerKey(candidate) === sourceSpeakerKey)
      : rows;
    const sourceSpeakerIndex = sameSpeakerRows.indexOf(row);
    const sourceText = helper.getRowTextValue(row).trim();
    if (!sourceText) {
      return null;
    }

    return {
      sourceRow: row,
      sourceRowIndex,
      sourceSpeakerIndex,
      rowCount: rows.length,
      speakerKey: sourceSpeakerKey,
      sourceText,
      pivotPx: 0,
      ratio: clamp(
        (splitSeconds - range.startSeconds) / (range.endSeconds - range.startSeconds),
        0,
        1
      )
    };
  }

  helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences() {
    if (helper.state.autoSegmentationPending) {
      return {
        ok: false,
        reason: 'auto-segmentation-pending',
        splitCount: 0
      };
    }

    helper.state.autoSegmentationPending = true;
    autoSegmentTextRedistributionSession = null;

    try {
      autoSegmentTextRedistributionSession = await prepareAutoSegmentTextRedistributionSession();
      const preTrimResult = await helper.trimAllSegmentsToAudio({
        amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD,
        progressLabel: 'Pre-trimming visible segments'
      });
      if (!(preTrimResult && preTrimResult.ok)) {
        emitAutoSegmentDebug({
          phase: 'complete',
          ok: false,
          reason: preTrimResult && preTrimResult.reason ? preTrimResult.reason : 'pre-trim-failed',
          targetCount: 0,
          splitCount: 0,
          preTrim: preTrimResult || null,
          diagnostics: getAutoSegmentTargetDiagnostics()
        });
        return {
          ok: false,
          reason: preTrimResult && preTrimResult.reason ? preTrimResult.reason : 'pre-trim-failed',
          splitCount: 0,
          preTrim: preTrimResult || null
        };
      }

      const mergeResult = await mergeAutoSegmentCloseRows();
      if (!mergeResult || !mergeResult.ok) {
        emitAutoSegmentDebug({
          phase: 'complete',
          ok: false,
          reason: mergeResult && mergeResult.reason ? mergeResult.reason : 'merge-failed',
          targetCount: 0,
          splitCount: 0,
          preTrim: preTrimResult,
          merge: mergeResult || null,
          diagnostics: getAutoSegmentTargetDiagnostics()
        });
        return {
          ok: false,
          reason: mergeResult && mergeResult.reason ? mergeResult.reason : 'merge-failed',
          splitCount: 0,
          preTrim: preTrimResult,
          merge: mergeResult || null
        };
      }

      const textBaselineGroups = collectAutoSegmentTextBaselineGroups();
      const targets = collectAutoSegmentTargets();
      if (!targets.length) {
        emitAutoSegmentDebug({
          phase: 'complete',
          ok: false,
          reason: 'missing-segments',
          targetCount: 0,
          splitCount: 0,
          preTrim: preTrimResult,
          merge: mergeResult,
          textBaselineGroupCount: textBaselineGroups.length,
          diagnostics: getAutoSegmentTargetDiagnostics()
        });
        return {
          ok: false,
          reason: 'missing-segments',
          splitCount: 0,
          preTrim: preTrimResult,
          merge: mergeResult,
          textBaselineGroupCount: textBaselineGroups.length
        };
      }

      updateLongTaskProgress({
        label: 'Finding silence runs',
        current: 0,
        total: targets.length
      });

      let splitCount = 0;
      const silenceResults = [];
      for (let index = 0; index < targets.length; index += 1) {
        updateLongTaskProgress({
          label: 'Finding silence runs',
          current: index,
          total: targets.length
        });
        silenceResults.push(await requestAutoSegmentSilenceRuns(targets[index]));
      }

      const splitPlans = collectAutoSegmentSplitPlans(targets, silenceResults);
      emitAutoSegmentDebug({
        phase: 'planned',
        ok: true,
        targetCount: targets.length,
        silenceResultCount: silenceResults.length,
        splitPlanCount: splitPlans.length,
        silenceResults: silenceResults.map((result) => ({
          ok: Boolean(result && result.ok),
          reason: result && result.reason ? result.reason : null,
          source: result && result.source ? result.source : null,
          runCount: result && Array.isArray(result.runs) ? result.runs.length : 0
        }))
      });

      for (let index = 0; index < splitPlans.length; index += 1) {
        updateLongTaskProgress({
          label: 'Splitting on silence',
          current: index,
          total: splitPlans.length
        });

        const plan = splitPlans[index];
        const row = findCurrentAutoSegmentSplitRow(plan);
        if (!(row instanceof HTMLTableRowElement)) {
          continue;
        }

        const labels = getRowTimeLabels(row);
        const range = getRowTimeRange(row);
        const rowIdentity = typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) : null;
        const smartSplitPlan = buildSmartSplitPlanForRow(row, plan.splitSeconds, plan.speakerKey);
        const splitResult = await helper.splitSegmentAtTime({
          annotationId: plan.annotationId,
          rowIdentity: rowIdentity || plan.rowIdentity || null,
          startText: labels ? labels.startText : '',
          endText: labels ? labels.endText : '',
          startSeconds: range ? range.startSeconds : plan.startSeconds,
          endSeconds: range ? range.endSeconds : plan.endSeconds,
          speakerKey: plan.speakerKey,
          splitSeconds: plan.splitSeconds
        });

        if (!splitResult || !splitResult.ok) {
          continue;
        }

        splitCount += 1;
        if (smartSplitPlan) {
          await applySmartSplit(smartSplitPlan);
        }
        await helper.sleep(AUTO_SEGMENT_SPLIT_SETTLE_MS);
      }

      updateLongTaskProgress({
        label: 'Trimming segmented draft',
        current: splitPlans.length,
        total: splitPlans.length
      });
      const postTrimResult = await helper.trimAllSegmentsToAudio({
        amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD,
        progressLabel: 'Post-trimming segmented draft'
      });
      if (!(postTrimResult && postTrimResult.ok)) {
        emitAutoSegmentDebug({
          phase: 'complete',
          ok: false,
          reason: postTrimResult && postTrimResult.reason ? postTrimResult.reason : 'trim-failed',
          targetCount: targets.length,
          splitPlanCount: splitPlans.length,
          splitCount,
          preTrim: preTrimResult,
          merge: mergeResult,
          trim: postTrimResult || null
        });
        return {
          ok: false,
          reason: postTrimResult && postTrimResult.reason ? postTrimResult.reason : 'trim-failed',
          splitCount,
          preTrim: preTrimResult,
          merge: mergeResult,
          trim: postTrimResult || null
        };
      }

      const silentCleanupResult = await cleanupAutoSegmentSilentRows().catch((error) =>
        createAutoSegmentCleanupFailureResult(error)
      );
      const redistributionResult = await redistributeAutoSegmentTextWithPromptApi(textBaselineGroups).catch((error) =>
        createAutoSegmentRedistributionFailureResult(error)
      );
      const finalPhaseOk =
        Boolean(silentCleanupResult && silentCleanupResult.ok) &&
        Boolean(redistributionResult && redistributionResult.ok);
      const result = {
        ok: finalPhaseOk,
        reason: finalPhaseOk ? null : 'finalize-failed',
        changed: splitCount > 0 || Boolean(postTrimResult && postTrimResult.changedCount) || Boolean(mergeResult && mergeResult.mergeCount) || Boolean(silentCleanupResult && silentCleanupResult.deleteCount) || Boolean(redistributionResult && redistributionResult.changedCount),
        splitCount,
        preTrim: preTrimResult,
        merge: mergeResult,
        trim: postTrimResult,
        cleanup: silentCleanupResult,
        redistribution: redistributionResult,
        textBaselineGroupCount: textBaselineGroups.length
      };
      emitAutoSegmentDebug({
        phase: 'complete',
        ok: result.ok,
        reason: result.reason || null,
        changed: result.changed,
        targetCount: targets.length,
        splitPlanCount: splitPlans.length,
        splitCount,
        preTrim: preTrimResult,
        merge: mergeResult,
        trim: postTrimResult,
        cleanup: silentCleanupResult,
        redistribution: redistributionResult,
        textBaselineGroupCount: textBaselineGroups.length
      });
      return result;
    } finally {
      await disposeAutoSegmentTextRedistributionSession(autoSegmentTextRedistributionSession);
      autoSegmentTextRedistributionSession = null;
      helper.state.autoSegmentationPending = false;
      dismissLongTaskProgress();
    }
  };

  async function trimSegmentTarget(target, options) {
    if (!target || !target.entry) {
      return { ok: false, reason: 'missing-target' };
    }

    const speakerKey =
      typeof target.speakerKey === 'string'
        ? target.speakerKey
        : target.row instanceof HTMLTableRowElement
          ? helper.getRowSpeakerKey(target.row)
          : '';
    const entryStartSeconds = parseTimeValue(target.entry.startText);
    const entryEndSeconds = parseTimeValue(target.entry.endText);
    const row =
      findRowByTimeLabels(target.entry.startText, target.entry.endText, {
        speakerKey
      }) ||
      (Number.isFinite(entryStartSeconds) &&
      Number.isFinite(entryEndSeconds) &&
      entryEndSeconds > entryStartSeconds
        ? findRowByTimeRange(entryStartSeconds, entryEndSeconds, {
            speakerKey
          })
        : null) ||
      (target.row instanceof HTMLTableRowElement ? target.row : null);
    if (!(row instanceof HTMLTableRowElement)) {
      return { ok: false, reason: 'missing-row' };
    }

    let labels = getRowTimeLabels(row);
    const rowRange = getRowTimeRange(row);
    if (!labels || !rowRange) {
      return { ok: false, reason: 'missing-row-range' };
    }

    const liveEntry =
      target.container instanceof HTMLElement && target.container.isConnected
        ? findRegionEntryForRow(row, target.container)
        : null;
    const liveTarget = {
      ...target,
      row,
      entry: liveEntry || labels
    };
    if (helper.state.currentTimelineTarget && helper.state.currentTimelineTarget.row === row) {
      helper.state.currentTimelineTarget.startText = labels.startText;
      helper.state.currentTimelineTarget.endText = labels.endText;
    }

    const trimResult = await requestTrimTargets(liveTarget, labels, speakerKey, options);
    if (!trimResult || !trimResult.ok) {
      return { ok: false, reason: 'bridge-failed', bridge: trimResult || null };
    }

    if (!trimResult.foundAudio) {
      return { ok: true, changed: false, reason: 'no-audio-above-threshold' };
    }

    let changed = false;
    const inwardMove = await applyInwardTrimToRow(row, speakerKey, trimResult);
    if (!inwardMove || !inwardMove.ok) {
      return {
        ok: false,
        reason: inwardMove && inwardMove.reason ? inwardMove.reason : 'trim-failed',
        bridge: trimResult
      };
    }
    changed = Boolean(inwardMove.changed);
    const shouldExtendLeft = !inwardMove.leftChanged;
    const shouldExtendRight = !inwardMove.rightChanged;

    if (!shouldExtendLeft && !shouldExtendRight) {
      return {
        ok: true,
        changed,
        trim: trimResult
      };
    }

    if (!isFeatureEnabled('audioTrimOutwardPass')) {
      return {
        ok: true,
        changed,
        trim: trimResult,
        extend: { ok: false, reason: 'outward-pass-disabled' }
      };
    }

    labels = getCurrentMoveLabels(row, labels);
    liveTarget.entry = labels;
    const extendResult = await requestExtendTargets(liveTarget, labels, speakerKey, options);
    if (!extendResult || !extendResult.ok) {
      return {
        ok: true,
        changed: false,
        trim: trimResult,
        extend: extendResult || null
      };
    }

    const extendStartSeconds = Number(extendResult.targetStartSeconds);
    const extendEndSeconds = Number(extendResult.targetEndSeconds);
    const cappedExtendEndSeconds = capOutwardBoundaryTarget(row, 'right', speakerKey, extendEndSeconds);
    const currentRightRange = getRowTimeRange(row) || rowRange;

    if (
      shouldExtendRight &&
      currentRightRange &&
      Number.isFinite(cappedExtendEndSeconds) &&
      cappedExtendEndSeconds > currentRightRange.endSeconds + AUDIO_TRIM_EPSILON_SECONDS &&
      cappedExtendEndSeconds > currentRightRange.startSeconds + AUDIO_TRIM_EPSILON_SECONDS
    ) {
      const movedRight = await moveSegmentBoundary('right', labels, speakerKey, cappedExtendEndSeconds);
      if (!movedRight || !movedRight.ok) {
        return { ok: false, reason: 'right-extend-failed', bridge: extendResult };
      }
      changed = true;
      labels = getCurrentMoveLabels(row, labels);
      await helper.sleep(32);
    }

    const cappedExtendStartSeconds = capOutwardBoundaryTarget(row, 'left', speakerKey, extendStartSeconds);
    const currentLeftRange = getRowTimeRange(row) || currentRightRange || rowRange;
    if (
      shouldExtendLeft &&
      currentLeftRange &&
      Number.isFinite(cappedExtendStartSeconds) &&
      cappedExtendStartSeconds < currentLeftRange.startSeconds - AUDIO_TRIM_EPSILON_SECONDS &&
      cappedExtendStartSeconds < currentLeftRange.endSeconds - AUDIO_TRIM_EPSILON_SECONDS
    ) {
      const movedLeft = await moveSegmentBoundary('left', getCurrentMoveLabels(row, labels), speakerKey, cappedExtendStartSeconds);
      if (!movedLeft || !movedLeft.ok) {
        return { ok: false, reason: 'left-extend-failed', bridge: extendResult };
      }
      changed = true;
    }

    let finalTrimResult = null;
    if (changed) {
      await helper.sleep(32);
      finalTrimResult = await requestTrimTargetsForRow(row, speakerKey, options);
      if (finalTrimResult && finalTrimResult.ok && finalTrimResult.foundAudio) {
        const finalInwardMove = await applyInwardTrimToRow(row, speakerKey, finalTrimResult);
        if (!finalInwardMove || !finalInwardMove.ok) {
          return {
            ok: false,
            reason: finalInwardMove && finalInwardMove.reason ? finalInwardMove.reason : 'final-trim-failed',
            bridge: finalTrimResult
          };
        }
      }
    }

    return {
      ok: true,
      changed,
      trim: trimResult,
      extend: extendResult,
      finalTrim: finalTrimResult
    };
  }

  helper.trimCurrentSegmentToAudio = async function trimCurrentSegmentToAudio(options) {
    const target = findCurrentSegmentTarget();
    if (!target) {
      return { ok: false, reason: 'missing-current-segment' };
    }

    return trimSegmentTarget(target, options);
  };

  helper.trimAllSegmentsToAudio = async function trimAllSegmentsToAudio(options) {
    const progressLabel = getTrimProgressLabel(options);
    const targets = collectAllSegmentTargets();
    if (!targets.length) {
      return {
        ok: false,
        reason: 'missing-segments',
        changedCount: 0
      };
    }

    let changedCount = 0;
    updateLongTaskProgress({
      label: progressLabel,
      current: 0,
      total: targets.length
    });

    try {
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        updateLongTaskProgress({
          label: progressLabel,
          current: index,
          total: targets.length
        });

        const result = await trimSegmentTarget(target, options);
        if (!result || !result.ok) {
          return {
            ok: false,
            reason: result && result.reason ? result.reason : 'trim-failed',
            changedCount
          };
        }
        if (result.changed) {
          changedCount += 1;
        }
        updateLongTaskProgress({
          label: progressLabel,
          current: index + 1,
          total: targets.length
        });
        await helper.sleep(16);
      }

      return {
        ok: true,
        changedCount
      };
    } finally {
      dismissLongTaskProgress();
    }
  };

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

  function getRowsForCompletedSmartSplit(sourceRow, sourceRowIndex, options) {
    const rows = helper.getTranscriptRows();
    if (!rows.length || sourceRowIndex < 0 || sourceRowIndex >= rows.length) {
      return null;
    }

    const settings = options || {};
    const sourceSpeakerKey =
      (typeof settings.speakerKey === 'string' && settings.speakerKey) ||
      helper.getRowSpeakerKey(sourceRow);
    const pairMatchesSpeaker = (leftRow, rightRow) => {
      if (!(leftRow instanceof HTMLTableRowElement) || !(rightRow instanceof HTMLTableRowElement)) {
        return false;
      }

      if (!helper.rowsShareSpeaker(leftRow, rightRow)) {
        return false;
      }

      return !sourceSpeakerKey || helper.getRowSpeakerKey(leftRow) === sourceSpeakerKey;
    };

    let leftRow = null;
    for (let index = Math.min(sourceRowIndex, rows.length - 1); index >= 0; index -= 1) {
      const candidate = rows[index];
      if (
        candidate instanceof HTMLTableRowElement &&
        (!sourceSpeakerKey || helper.getRowSpeakerKey(candidate) === sourceSpeakerKey)
      ) {
        leftRow = candidate;
        break;
      }
    }

    let rightRow = null;
    for (let index = Math.max(0, sourceRowIndex + 1); index < rows.length; index += 1) {
      const candidate = rows[index];
      if (
        candidate instanceof HTMLTableRowElement &&
        (!sourceSpeakerKey || helper.getRowSpeakerKey(candidate) === sourceSpeakerKey)
      ) {
        rightRow = candidate;
        break;
      }
    }

    if (!pairMatchesSpeaker(leftRow, rightRow)) {
      return null;
    }

    return {
      leftRow,
      rightRow
    };
  }

  async function waitForSmartSplitRows(sourceRow, sourceRowIndex, previousRowCount, options) {
    if (sourceRowIndex < 0 || !Number.isFinite(previousRowCount)) {
      return null;
    }

    return helper.waitFor(() => {
      const rows = helper.getTranscriptRows();
      if (rows.length < previousRowCount + 1) {
        return null;
      }

      return getRowsForCompletedSmartSplit(sourceRow, sourceRowIndex, options);
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
        speakerKey: helper.getRowSpeakerKey(row),
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

    return [entry.speakerKey || '', entry.startText || '', entry.endText || '', entry.text || ''].join('|');
  }

  function findNewDuplicateSplitRows(previousRows, options) {
    const previousList = Array.isArray(previousRows) ? previousRows : [];
    const previousSignatures = new Set(previousList.map((entry) => getRowSignature(entry)));
    const settings = options || {};
    const speakerKey =
      typeof settings.speakerKey === 'string' && settings.speakerKey ? settings.speakerKey : '';
    const rows = speakerKey
      ? helper.getTranscriptRows().filter((row) => helper.getRowSpeakerKey(row) === speakerKey)
      : helper.getTranscriptRows();

    for (let index = 0; index < rows.length - 1; index += 1) {
      const leftRow = rows[index];
      const rightRow = rows[index + 1];
      if (!helper.rowsShareSpeaker(leftRow, rightRow)) {
        continue;
      }

      const pairSpeakerKey = helper.getRowSpeakerKey(leftRow);
      if (speakerKey && pairSpeakerKey !== speakerKey) {
        continue;
      }

      const leftText = helper.getRowTextValue(leftRow).trim();
      const rightText = helper.getRowTextValue(rightRow).trim();
      if (!leftText || leftText !== rightText) {
        continue;
      }

      const leftLabels = getRowTimeLabels(leftRow);
      const rightLabels = getRowTimeLabels(rightRow);
      const leftSignature = getRowSignature({
        speakerKey: pairSpeakerKey,
        startText: leftLabels ? leftLabels.startText : '',
        endText: leftLabels ? leftLabels.endText : '',
        text: leftText
      });
      const rightSignature = getRowSignature({
        speakerKey: pairSpeakerKey,
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
        speakerKey: pairSpeakerKey,
        sourceText: leftText,
        ratio: leftDuration / totalDuration
      };
    }

    return null;
  }

  async function waitForDuplicateSplitRows(previousRows, speakerKey, timeoutMs) {
    if (!Array.isArray(previousRows) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return null;
    }

    return helper.waitFor(
      () =>
        findNewDuplicateSplitRows(previousRows, {
          speakerKey
        }),
      timeoutMs,
      CUT_PREVIEW_DUPLICATE_ROW_POLL_MS
    );
  }

  async function applySmartSplitFromDuplicateRows(context) {
    if (!context || !Number.isFinite(context.rowCount)) {
      return false;
    }

    const detected = await waitForDuplicateSplitRows(
      context.rows,
      context.speakerKey,
      CUT_PREVIEW_SMART_SPLIT_ROW_WAIT_MS
    );

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

    const rows = await waitForSmartSplitRows(plan.sourceRow, plan.sourceRowIndex, plan.rowCount, {
      speakerKey: plan.speakerKey,
      sourceSpeakerIndex: plan.sourceSpeakerIndex
    });
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

    const speakerKey = getSpeakerKeyForContainer(container);
    let sourceRow = findRowByTimeLabels(entry.startText, entry.endText, {
      speakerKey
    });

    if (!(sourceRow instanceof HTMLTableRowElement) && container instanceof HTMLElement) {
      const laneTimeScale = getLaneTimeScale(container);
      if (laneTimeScale && Number.isFinite(laneTimeScale.secondsPerPx) && laneTimeScale.secondsPerPx > 0) {
        const startSeconds = laneTimeScale.offsetSeconds + entry.leftPx * laneTimeScale.secondsPerPx;
        const endSeconds = laneTimeScale.offsetSeconds + entry.rightPx * laneTimeScale.secondsPerPx;
        sourceRow = findRowByTimeRange(startSeconds, endSeconds, {
          speakerKey
        });
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

    const sameSpeakerRows = speakerKey
      ? rows.filter((row) => helper.getRowSpeakerKey(row) === speakerKey)
      : rows;
    const sourceSpeakerIndex = sameSpeakerRows.indexOf(sourceRow);

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
      sourceSpeakerIndex,
      rowCount: rows.length,
      speakerKey,
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

    const timeRange = await ensurePreviewTimeRange(preview);
    const duration =
      timeRange &&
      Number.isFinite(timeRange.startSeconds) &&
      Number.isFinite(timeRange.endSeconds) &&
      timeRange.endSeconds > timeRange.startSeconds
        ? timeRange.endSeconds - timeRange.startSeconds
        : null;
    const safetyMargin = getPreviewCommitSafetySeconds(preview);
    const requiredDuration = CUT_PREVIEW_MIN_SECONDS + safetyMargin;
    if (!Number.isFinite(duration) || duration < requiredDuration) {
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
    const splitRowSnapshot = initialOverlapPlan.splitRequired ? captureRowSnapshot() : null;
    const speakerKey = getSpeakerKeyForContainer(commitPlan.container);

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
            speakerKey: getSpeakerKeyForContainer(commitPlan.container),
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
        const deleted = await deleteRegionByTimeLabels(entry.startText, entry.endText, {
          speakerKey: getSpeakerKeyForContainer(commitPlan.container)
        });
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
        if (!initialOverlapPlan.splitRequired) {
          return false;
        }
      }

      const duplicateSplitRows =
        initialOverlapPlan.splitRequired && splitRowSnapshot
          ? await waitForDuplicateSplitRows(
            splitRowSnapshot,
            speakerKey,
            CUT_PREVIEW_FAST_DUPLICATE_ROW_WAIT_MS
          )
          : null;

      const previousTrimLabels =
        shouldTrimPrevious && duplicateSplitRows && duplicateSplitRows.leftRow
          ? getRowTimeLabels(duplicateSplitRows.leftRow)
          : liveSnapshot.previous
            ? {
                startText: liveSnapshot.previous.startText,
                endText: liveSnapshot.previous.endText
              }
            : null;
      const nextTrimLabels =
        shouldTrimNext && duplicateSplitRows && duplicateSplitRows.rightRow
          ? getRowTimeLabels(duplicateSplitRows.rightRow)
          : liveSnapshot.next
            ? {
                startText: liveSnapshot.next.startText,
                endText: liveSnapshot.next.endText
              }
            : null;

      if (shouldTrimPrevious && !previousTrimLabels) {
        return false;
      }

      if (shouldTrimNext && !nextTrimLabels) {
        return false;
      }

      if (shouldTrimPrevious) {
        if (typeof helper.setSegmentBoundaryTime !== 'function') {
          return false;
        }

        const movedPrevious = await helper.setSegmentBoundaryTime({
          side: 'right',
          startText: previousTrimLabels.startText,
          endText: previousTrimLabels.endText,
          speakerKey,
          targetSeconds: timeRange.startSeconds,
          attempts: 2,
          retryDelayMs: 80
        });
        if (!movedPrevious || !movedPrevious.ok) {
          return false;
        }

        await helper.sleep(48);
      }

      if (shouldTrimNext) {
        if (typeof helper.setSegmentBoundaryTime !== 'function') {
          return false;
        }

        const movedNext = await helper.setSegmentBoundaryTime({
          side: 'left',
          startText: nextTrimLabels.startText,
          endText: nextTrimLabels.endText,
          speakerKey,
          targetSeconds: timeRange.endSeconds,
          attempts: 2,
          retryDelayMs: 80
        });
        if (!movedNext || !movedNext.ok) {
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
    if (helper.runtime && typeof helper.runtime.isSessionInteractive === 'function') {
      if (!helper.runtime.isSessionInteractive()) {
        return false;
      }
    }

    if (
      event.altKey &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.code === 'KeyS'
    ) {
      event.preventDefault();
      event.stopPropagation();
      void helper.autoSegmentVisibleSilences();
      return {
        handled: true,
        analyticsType: 'hotkey:trim',
        analyticsData: {
          scope: 'auto-segmentation'
        }
      };
    }

    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.code === 'KeyR'
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        void helper.trimAllSegmentsToAudio();
        return {
          handled: true,
          analyticsType: 'hotkey:trim',
          analyticsData: {
            scope: 'all'
          }
        };
      }

      void helper.trimCurrentSegmentToAudio();
      return {
        handled: true,
        analyticsType: 'hotkey:trim',
        analyticsData: {
          scope: 'current'
        }
      };
    }

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
    if (helper.runtime && typeof helper.runtime.isSessionInteractive === 'function') {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
    }

    if (helper.state.cutCommitPending) {
      return;
    }

    captureTimelineSegmentTarget(event);
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
    if (helper.runtime && typeof helper.runtime.isSessionInteractive === 'function') {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
    }

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
    if (helper.runtime && typeof helper.runtime.isSessionInteractive === 'function') {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
    }

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

    const draft = getSmartSplitClickDraft(event);
    helper.state.smartSplitClickContext = {
      rowCount: helper.getTranscriptRows().length,
      speakerKey:
        (draft && typeof draft.speakerKey === 'string' && draft.speakerKey) ||
        getSpeakerKeyForContainer(helper.state.cutLastContainer),
      rows: captureRowSnapshot()
    };

    helper.state.smartSplitClickDraft = draft || null;
    return draft;
  }

  function handleSmartSplitClick(event) {
    if (helper.runtime && typeof helper.runtime.isSessionInteractive === 'function') {
      if (!helper.runtime.isSessionInteractive()) {
        return;
      }
    }

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
    if (helper.state.cutListenersBound) {
      return;
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('pointerup', handlePointerEnd, true);
    document.addEventListener('pointercancel', handlePointerEnd, true);
    document.addEventListener('click', handleSmartSplitClick, true);
    helper.state.cutListenersBound = true;
  };

  helper.unbindCutPreview = function unbindCutPreview() {
    if (!helper.state.cutListenersBound) {
      return;
    }

    document.removeEventListener('pointerdown', handlePointerDown, true);
    document.removeEventListener('pointermove', handlePointerMove, true);
    document.removeEventListener('pointerup', handlePointerEnd, true);
    document.removeEventListener('pointercancel', handlePointerEnd, true);
    document.removeEventListener('click', handleSmartSplitClick, true);
    helper.state.cutListenersBound = false;
  };

  helper.bindNativeTimelineDoubleClickBlocker = function bindNativeTimelineDoubleClickBlocker() {
    if (helper.state.nativeTimelineDoubleClickBlockerBound) {
      return;
    }

    document.addEventListener('dblclick', handleTimelineDoubleClick, true);
    helper.state.nativeTimelineDoubleClickBlockerBound = true;
  };

  helper.unbindNativeTimelineDoubleClickBlocker = function unbindNativeTimelineDoubleClickBlocker() {
    if (!helper.state.nativeTimelineDoubleClickBlockerBound) {
      return;
    }

    document.removeEventListener('dblclick', handleTimelineDoubleClick, true);
    helper.state.nativeTimelineDoubleClickBlockerBound = false;
  };
}



