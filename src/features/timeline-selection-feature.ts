// @ts-nocheck
import type { FeatureModule } from '../core/types';
import type { TimelineModules } from '../services/timeline-selection-service';
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';

export function registerTimelineSelection(helper: any, api: Pick<TimelineModules, 'site' | 'edge' | 'loop' | 'split'>) {

  const CUT_PREVIEW_ATTR = 'data-babel-helper-cut-preview';

  const CUT_PREVIEW_HANDLE_ATTR = 'data-babel-helper-cut-handle';

  const CUT_PREVIEW_MIN_SECONDS = 1;

  const CUT_PREVIEW_SAFETY_MIN_SECONDS = 0.008;

  const CUT_PREVIEW_SAFETY_MAX_SECONDS = 0.03;

  const CUT_PREVIEW_MIN_WIDTH = 8;

  const CUT_PREVIEW_DRAG_THRESHOLD = 5;

  const CUT_PREVIEW_HANDLE_HIT_WIDTH = 12;


  helper.state.cutDraft = null;

  helper.state.cutPreview = null;

  helper.state.cutCommitPending = false;

  helper.state.cutLastContainer = null;

  if (api.site.isFeatureEnabled('timelineSelection')) {
    helper.config.hotkeysHelpRows.unshift(['Alt + C', 'Create empty segment around nearest uncovered speech near caret']);
    helper.config.hotkeysHelpRows.unshift(['Alt + Shift + G', 'Transcribe current empty segment with free L0']);
    helper.config.hotkeysHelpRows.unshift(['Alt + Shift + S', 'Split visible segments on silence runs over 1000ms, then trim all']);
    helper.config.hotkeysHelpRows.unshift(['Alt + Shift + R', 'Trim all visible segments to nearby visible audio']);
    helper.config.hotkeysHelpRows.unshift(['Alt + R', 'Trim current segment to nearby visible audio']);
    helper.config.hotkeysHelpRows.unshift(['Shift + Ctrl/Cmd + Click', 'Run native split and redistribute words']);
    helper.config.hotkeysHelpRows.unshift(['L', 'Loop the selected range until playback caret moves']);
    helper.config.hotkeysHelpRows.unshift(['Shift + S', 'Split the selected range']);
    helper.config.hotkeysHelpRows.unshift(['S', 'Smart-split the selected range']);
    helper.config.hotkeysHelpRows.unshift(['Alt + Drag', 'Create a timeline selection']);
  }


  function isNativeTimelineDoubleClickTarget(event) {
    if (api.edge.isAltTimelineEdgeClickEvent(event) && getTimelineLaneFromEvent(event)) {
      return true;
    }

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      if (node.hasAttribute(CUT_PREVIEW_ATTR)) {
        return false;
      }

      if (api.site.isRegionHandle(node) || api.site.isRegionBody(node)) {
        return true;
      }
    }

    const target = event.target;
    return Boolean(
      target instanceof HTMLElement &&
      (api.site.getRegionHandleElement(target) || api.site.getOwningRegionBody(target))
    );
  }


  function handleTimelineDoubleClick(event) {
    if (!api.site.isFeatureEnabled('disableNativeTimelineDoubleClick')) {
      return;
    }

    if (!isNativeTimelineDoubleClickTarget(event)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
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
    const waveformEntry = api.site.getWaveformEntryForContainer(preview.container);
    const pixelsPerSecond = api.site.getWaveformPixelsPerSecond(waveformEntry, preview.container);
    if (!(Number.isFinite(pixelsPerSecond) && pixelsPerSecond > 0)) {
      return CUT_PREVIEW_SAFETY_MIN_SECONDS;
    }
    return api.site.clamp(
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
      api.loop.ensureSelectionHostMarker(preview.container);
    if (!hostMarker) {
      preview.timeRange = null;
      return null;
    }

    preview.hostMarker = hostMarker;
    const requestLeftPx = preview.leftPx;
    const requestRightPx = preview.rightPx;
    const request = api.site.callSelectionBridge('selection-time-range', {
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


  function getSelectionPlaybackTarget(preview) {
    const entry = api.site.getWaveformEntryForContainer(preview && preview.container);
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

    const audio = api.site.getSelectionAudioElement();
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
      const host = api.site.getWaveformHostFromContainer(preview.container);
      if (
        host instanceof HTMLElement &&
        host.getAttribute(api.loop.SELECTION_LOOP_HOST_ATTR) === preview.hostMarker
      ) {
        host.removeAttribute(api.loop.SELECTION_LOOP_HOST_ATTR);
      }
    }

    helper.state.cutPreview = null;
    helper.state.cutCommitPending = false;
    helper.state.timelineEdgeClickDraft = null;
    clearCutDraft();
  };


  helper.resetCutState = function resetCutState() {
    helper.state.smartSplitClickDraft = null;
    helper.state.smartSplitClickContext = null;
    helper.state.cutDraft = null;
    helper.state.timelineEdgeClickDraft = null;
    helper.state.cutLastContainer = null;
    helper.clearCutPreview();
  };


  function cancelCutPreviewIfZoomChanged() {
    const preview = helper.state.cutPreview;
    if (!preview || !preview.zoomSignature || !(preview.container instanceof HTMLElement)) {
      return false;
    }

    if (api.site.getLaneZoomSignature(preview.container) === preview.zoomSignature) {
      return false;
    }

    helper.clearCutPreview();
    return true;
  }


  function startCutPreviewZoomWatcher(preview) {
    if (!preview || !(preview.container instanceof HTMLElement)) {
      return;
    }

    const zoomSlider = api.site.getZoomSliderElement();
    if (!(zoomSlider instanceof HTMLElement) || typeof MutationObserver !== 'function') {
      return;
    }

    const observer = new MutationObserver(() => {
      const activePreview = helper.state.cutPreview;
      if (!activePreview || activePreview !== preview || helper.state.cutCommitPending) {
        return;
      }

      if (activePreview.zoomSignature && api.site.getLaneZoomSignature(activePreview.container) !== activePreview.zoomSignature) {
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
    const localX = api.site.clamp(clientX - draft.containerRect.left, draft.regionLeftPx, draft.regionRightPx);
    const startX = api.site.clamp(draft.startClientX - draft.containerRect.left, draft.regionLeftPx, draft.regionRightPx);
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
    api.site.rememberCutContainer(draft.container);

    const zoomSignature = api.site.getLaneZoomSignature(draft.container);
    const hostMarker = api.loop.ensureSelectionHostMarker(draft.container);

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
    const anchorPx = api.site.clamp(
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
    const normalizedAnchor = api.site.clamp(anchorPx, preview.regionLeftPx, preview.regionRightPx);
    const normalizedCurrent = api.site.clamp(currentPx, preview.regionLeftPx, preview.regionRightPx);

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
      const currentX = api.site.clamp(
        event.clientX - preview.containerRect.left,
        preview.regionLeftPx,
        preview.regionRightPx
      );
      const startX = api.site.clamp(
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


  function getTimelineLaneFromEvent(event) {
    if (!event) {
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

      if (!sourceRegion && api.site.isRegionHandle(node)) {
        sourceRegion = api.site.getOwningRegionBody(node);
      }

      if (!sourceRegion && api.site.isRegionBody(node)) {
        sourceRegion = node;
      }

      if (!container && sourceRegion instanceof HTMLElement && sourceRegion.parentElement instanceof HTMLElement) {
        container = sourceRegion.parentElement;
      }

      if (!container && api.site.getRegionElements(node).length) {
        container = node;
      }

      if (
        !container &&
        node.parentElement instanceof HTMLElement &&
        api.site.getRegionElements(node.parentElement).length
      ) {
        container = node.parentElement;
      }
    }

    if (container instanceof HTMLElement) {
      return {
        container,
        sourceRegion: sourceRegion instanceof HTMLElement ? sourceRegion : null
      };
    }

    for (const candidate of api.site.discoverWaveformContainers()) {
      const rect = candidate.getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left <= event.clientX &&
        event.clientX <= rect.right &&
        rect.top <= event.clientY &&
        event.clientY <= rect.bottom
      ) {
        return {
          container: candidate,
          sourceRegion: null
        };
      }
    }

    return null;
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

      if (api.site.getRegionHandleElement(node)) {
        return null;
      }

      if (!sourceRegion && api.site.isRegionBody(node)) {
        sourceRegion = node;
        if (node.parentElement instanceof HTMLElement) {
          container = node.parentElement;
        }
      }

      if (!container && api.site.getRegionElements(node).length) {
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
      const lane = getTimelineLaneFromEvent(event);
      if (lane) {
        container = lane.container;
        sourceRegion = lane.sourceRegion;
      }
    }

    if (!(container instanceof HTMLElement)) {
      return null;
    }

    const containerRect = container.getBoundingClientRect();
    if (containerRect.width <= 0) {
      return null;
    }

    api.site.rememberCutContainer(container);

    return {
      pointerId: typeof event.pointerId === 'number' ? event.pointerId : 1,
      sourceRegion,
      container,
      containerRect,
      regionLeftPx: 0,
      regionRightPx: containerRect.width,
      startClientX: api.site.clamp(event.clientX, containerRect.left, containerRect.right)
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
      const snapshot = api.site.collectRegionSnapshot(container);
      if (!snapshot) {
        return null;
      }

      return getSnapshotSignature(snapshot) !== previousSignature ? snapshot : null;
    }, 900, 40);

    return updated || api.site.collectRegionSnapshot(container);
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

    const beforeSnapshot = api.site.collectRegionSnapshot(commitPlan.container);
    const initialOverlapPlan = collectOverlapPlan(beforeSnapshot, commitPlan.leftPx, commitPlan.rightPx);
    if (!beforeSnapshot || !initialOverlapPlan || !initialOverlapPlan.overlapping.length) {
      return false;
    }
    const splitRowSnapshot = initialOverlapPlan.splitRequired ? api.split.captureRowSnapshot() : null;
    const speakerKey = api.site.getSpeakerKeyForContainer(commitPlan.container);

    const smartSplitPlan =
      useSmartSplit &&
        initialOverlapPlan.splitRequired &&
        initialOverlapPlan.overlapping.length === 1 &&
        initialOverlapPlan.splitRegion
        ? api.split.buildSmartSplitPlanForRegion(
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
          speakerKey: api.site.getSpeakerKeyForContainer(commitPlan.container),
          rows: api.split.captureRowSnapshot()
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

        api.split.dispatchSplitClick(splitTarget, splitClientX, splitClientY);
      }

      const deleteTargets = initialOverlapPlan.toDelete.slice();
      for (const entry of deleteTargets) {
        const deleted = await api.site.deleteRegionByTimeLabels(entry.startText, entry.endText, {
          speakerKey: api.site.getSpeakerKeyForContainer(commitPlan.container)
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
          : api.site.collectRegionSnapshot(commitPlan.container);

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
          ? await api.split.waitForDuplicateSplitRows(
            splitRowSnapshot,
            speakerKey,
            api.split.CUT_PREVIEW_FAST_DUPLICATE_ROW_WAIT_MS
          )
          : null;

      const previousTrimLabels =
        shouldTrimPrevious && duplicateSplitRows && duplicateSplitRows.leftRow
          ? api.site.getRowTimeLabels(duplicateSplitRows.leftRow)
          : liveSnapshot.previous
            ? {
              startText: liveSnapshot.previous.startText,
              endText: liveSnapshot.previous.endText
            }
            : null;
      const nextTrimLabels =
        shouldTrimNext && duplicateSplitRows && duplicateSplitRows.rightRow
          ? api.site.getRowTimeLabels(duplicateSplitRows.rightRow)
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
        void api.split.applySmartSplit(smartSplitPlan);
      } else if (smartSplitFallbackContext) {
        await helper.sleep(64);
        void api.split.applySmartSplitFromDuplicateRows(smartSplitFallbackContext);
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


  function isAutoInsertSegmentHotkey(event) {
    return Boolean(
      event.altKey &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.code === 'KeyC'
    );
  }


  function runAutoInsertSegmentHotkey(event) {
    event.preventDefault();
    event.stopPropagation();
    helper.state.autoInsertSegmentHotkeyHandledAt = Date.now();
    void helper.autoInsertSegmentAtCaret();
    return {
      handled: true,
      analyticsType: 'hotkey:trim',
      analyticsData: {
        scope: 'auto-insert-segment'
      }
    };
  }


  helper.handleCutPreviewKeyup = function handleCutPreviewKeyup(event) {
    if (helper.runtime && typeof helper.runtime.isSessionInteractive === 'function') {
      if (!helper.runtime.isSessionInteractive()) {
        return false;
      }
    }

    if (!isAutoInsertSegmentHotkey(event)) {
      return false;
    }

    const lastHandledAt = Number(helper.state.autoInsertSegmentHotkeyHandledAt) || 0;
    if (Date.now() - lastHandledAt < 700) {
      event.preventDefault();
      event.stopPropagation();
      return {
        handled: true,
        analyticsType: 'hotkey:trim',
        analyticsData: {
          scope: 'auto-insert-segment',
          deduped: true
        }
      };
    }

    return runAutoInsertSegmentHotkey(event);
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
      event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.code === 'KeyG'
    ) {
      event.preventDefault();
      event.stopPropagation();
      void helper.transcribeCurrentSegmentWithL0();
      return {
        handled: true,
        analyticsType: 'hotkey:trim',
        analyticsData: {
          scope: 'segment-transcription'
        }
      };
    }

    if (isAutoInsertSegmentHotkey(event)) {
      return runAutoInsertSegmentHotkey(event);
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
        api.loop.setSelectionLoopDebug('no-preview-key');
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

    api.site.captureTimelineSegmentTarget(event);
    api.split.captureSmartSplitClickDraft(event);

    const timelineEdgeClickDraft = api.edge.getAltClickTimelineEdgeDraft(event);
    if (timelineEdgeClickDraft) {
      helper.state.timelineEdgeClickDraft = timelineEdgeClickDraft;
      api.edge.suppressAltTimelineEdgeEvent(event);
    } else {
      helper.state.timelineEdgeClickDraft = null;
    }

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

    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    const timelineEdgeClickDraft = helper.state.timelineEdgeClickDraft;
    if (timelineEdgeClickDraft && timelineEdgeClickDraft.pointerId === pointerId) {
      const currentX = api.site.clamp(
        event.clientX,
        timelineEdgeClickDraft.containerRect.left,
        timelineEdgeClickDraft.containerRect.right
      );
      const currentY = api.site.clamp(
        event.clientY,
        timelineEdgeClickDraft.containerRect.top,
        timelineEdgeClickDraft.containerRect.bottom
      );
      const movedEnoughForTimelineEdgeClick =
        Math.abs(currentX - timelineEdgeClickDraft.startClientX) >= CUT_PREVIEW_DRAG_THRESHOLD ||
        Math.abs(currentY - timelineEdgeClickDraft.startClientY) >= CUT_PREVIEW_DRAG_THRESHOLD;
      if (!movedEnoughForTimelineEdgeClick) {
        api.edge.suppressAltTimelineEdgeEvent(event);
        return;
      }

      helper.state.timelineEdgeClickDraft = null;
    }

    const draft = helper.state.cutDraft;
    if (!draft || draft.pointerId !== pointerId) {
      return;
    }

    const currentX = api.site.clamp(event.clientX, draft.containerRect.left, draft.containerRect.right);
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

    const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 1;
    {
      const draft = helper.state.timelineEdgeClickDraft;
      if (draft && draft.pointerId === pointerId) {
        helper.state.timelineEdgeClickDraft = null;
        const currentX = api.site.clamp(event.clientX, draft.containerRect.left, draft.containerRect.right);
        const currentY = api.site.clamp(event.clientY, draft.containerRect.top, draft.containerRect.bottom);
        const wasClick =
          Math.abs(currentX - draft.startClientX) < CUT_PREVIEW_DRAG_THRESHOLD &&
          Math.abs(currentY - draft.startClientY) < CUT_PREVIEW_DRAG_THRESHOLD;
        if (wasClick) {
          clearCutDraft();
          void helper.adjustNearestTimelineSegmentEdgeFromAltClick(draft, event);
        }
        api.edge.suppressAltTimelineEdgeEvent(event);
        return;
      }
    }

    const draft = helper.state.cutDraft;
    if (draft && draft.pointerId === pointerId) {
      clearCutDraft();
      event.preventDefault();
      event.stopPropagation();
    }
  }


  function handleAltTimelineEdgeMouseEvent(event) {
    if (api.edge.isAltTimelineEdgeClickEvent(event) && getTimelineLaneFromEvent(event)) {
      api.edge.suppressAltTimelineEdgeEvent(event);
    }
  }


  helper.bindCutPreview = function bindCutPreview() {
    if (helper.state.cutListenersBound) {
      return;
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('pointerup', handlePointerEnd, true);
    document.addEventListener('pointercancel', handlePointerEnd, true);
    document.addEventListener('mousedown', handleAltTimelineEdgeMouseEvent, true);
    document.addEventListener('mouseup', handleAltTimelineEdgeMouseEvent, true);
    document.addEventListener('click', api.split.handleSmartSplitClick, true);
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
    document.removeEventListener('mousedown', handleAltTimelineEdgeMouseEvent, true);
    document.removeEventListener('mouseup', handleAltTimelineEdgeMouseEvent, true);
    document.removeEventListener('click', api.split.handleSmartSplitClick, true);
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

  return { ensurePreviewTimeRange, getSelectionPlaybackTarget, getPreviewTimeRange, getTimelineLaneFromEvent, CUT_PREVIEW_ATTR };
}

export function createTimelineSelectionFeature(): FeatureModule {
  return {
    id: 'timeline-selection'
  };
}

export function registerTimelineInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;

  hooks.on('keydown', (event) => {
    const timelineHotkeyResult =
      isFeatureEnabled('timelineSelection') &&
        typeof helper.handleCutPreviewKeydown === 'function'
        ? helper.handleCutPreviewKeydown(event)
        : false;
    if (timelineHotkeyResult) {
      if (helper.analytics) {
        const analyticsType =
          typeof timelineHotkeyResult === 'object' &&
            timelineHotkeyResult &&
            typeof timelineHotkeyResult.analyticsType === 'string'
            ? timelineHotkeyResult.analyticsType
            : 'hotkey:cut-preview';
        const analyticsData =
          typeof timelineHotkeyResult === 'object' &&
            timelineHotkeyResult &&
            timelineHotkeyResult.analyticsData &&
            typeof timelineHotkeyResult.analyticsData === 'object'
            ? timelineHotkeyResult.analyticsData
            : {};
        helper.analytics.record(analyticsType, {
          key: event.key,
          code: event.code,
          ...analyticsData
        });
      }
      return true;
    }
  }, 10);
  hooks.on('capture', (event) => {
    if (
      helper.runtime.isSessionInteractive() &&
      isFeatureEnabled('timelineSelection') &&
      typeof helper.handleCutPreviewKeydown === 'function' &&
      event.altKey &&
      (
        (
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          event.code === 'KeyC'
        ) ||
        event.code === 'KeyR' ||
        (
          event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          (event.code === 'KeyS' || event.code === 'KeyG')
        )
      )
    ) {
      const timelineHotkeyResult = helper.handleCutPreviewKeydown(event);
      if (timelineHotkeyResult) {
        event.stopImmediatePropagation();
        if (helper.analytics) {
          const analyticsType =
            typeof timelineHotkeyResult === 'object' &&
              timelineHotkeyResult &&
              typeof timelineHotkeyResult.analyticsType === 'string'
              ? timelineHotkeyResult.analyticsType
              : 'hotkey:cut-preview';
          const analyticsData =
            typeof timelineHotkeyResult === 'object' &&
              timelineHotkeyResult &&
              timelineHotkeyResult.analyticsData &&
              typeof timelineHotkeyResult.analyticsData === 'object'
              ? timelineHotkeyResult.analyticsData
              : {};
          helper.analytics.record(analyticsType, {
            key: event.key,
            code: event.code,
            ...analyticsData
          });
        }
        return true;
      }
    }
  }, 20);
  hooks.on('keyup', (event) => {
    const timelineHotkeyResult =
      helper.runtime.isSessionInteractive() &&
        isFeatureEnabled('timelineSelection') &&
        typeof helper.handleCutPreviewKeyup === 'function'
        ? helper.handleCutPreviewKeyup(event)
        : false;
    if (timelineHotkeyResult) {
      event.stopImmediatePropagation();
      if (helper.analytics) {
        const analyticsType =
          typeof timelineHotkeyResult === 'object' &&
            timelineHotkeyResult &&
            typeof timelineHotkeyResult.analyticsType === 'string'
            ? timelineHotkeyResult.analyticsType
            : 'hotkey:cut-preview';
        const analyticsData =
          typeof timelineHotkeyResult === 'object' &&
            timelineHotkeyResult &&
            timelineHotkeyResult.analyticsData &&
            typeof timelineHotkeyResult.analyticsData === 'object'
            ? timelineHotkeyResult.analyticsData
            : {};
        helper.analytics.record(analyticsType, {
          key: event.key,
          code: event.code,
          ...analyticsData
        });
      }
    }
  }, 10);
}
