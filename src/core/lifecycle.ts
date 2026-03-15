// @ts-nocheck
import { requestAutoFix } from '../features/custom-linter-feature';
import { autoConvertSelectedNumberText } from '../hooks/selected-number-to-skaz';

export function registerLifecycle(helper: any) {
  if (!helper || helper.__mainInitialized) {
    return;
  }

  helper.__mainInitialized = true;

  const ROUTE_REFRESH_DELAY_MS = 80;
  const ROUTE_REFRESH_MAX_ATTEMPTS = 12;
  const ROUTE_REFRESH_MAX_WINDOW_MS = 1200;

  function isFeatureEnabled(featureKey) {
    if (typeof helper.isFeatureEnabled === 'function') {
      return helper.isFeatureEnabled(featureKey);
    }

    return true;
  }

  function isTranscriptionRoute() {
    return /^\/transcription(?:\/|$)/.test(window.location.pathname || '');
  }

  function isReadOnlyFeedbackRoute() {
    const params = new URLSearchParams(window.location.search || '');
    const displayFeedback = params.get('displayFeedback');
    if (displayFeedback === 'true') {
      return true;
    }

    return Boolean(
      params.has('reviewActionId') &&
      displayFeedback != null &&
      displayFeedback !== 'false'
    );
  }

  function hasTranscriptSurface() {
    return Boolean(document.querySelector(helper.config.rowTextareaSelector));
  }

  helper.runtime.isSessionInteractive = function isSessionInteractive() {
    return Boolean(
      isTranscriptionRoute() &&
      !isReadOnlyFeedbackRoute() &&
      hasTranscriptSurface()
    );
  };

  function resetRouteRefreshWindow() {
    helper.state.routeRefreshAttempts = 0;
    helper.state.routeRefreshWindowStartedAt = Date.now();
  }

  function startHotkeysEnhanceFrame() {
    if (!isFeatureEnabled('hotkeysHelp')) {
      return;
    }

    if (helper.state.hotkeysEnhanceFrame) {
      return;
    }

    helper.state.hotkeysEnhanceFrame = window.requestAnimationFrame(() => {
      helper.state.hotkeysEnhanceFrame = 0;
      helper.enhanceHotkeysDialog();
    });
  }

  function stopHotkeysEnhanceFrame() {
    if (!helper.state.hotkeysEnhanceFrame) {
      return;
    }

    window.cancelAnimationFrame(helper.state.hotkeysEnhanceFrame);
    helper.state.hotkeysEnhanceFrame = 0;
  }

  function stopHotkeysObserver() {
    const observer = helper.state.hotkeysObserver;
    if (observer && typeof observer.disconnect === 'function') {
      observer.disconnect();
    }

    helper.state.hotkeysObserver = null;
  }

  function stopRouteRecoveryObserver() {
    const observer = helper.state.routeRecoveryObserver;
    if (observer && typeof observer.disconnect === 'function') {
      observer.disconnect();
    }

    helper.state.routeRecoveryObserver = null;
  }

  function isHotkeysMutationCandidate(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    if (node.matches('[role="dialog"], [data-radix-popper-content-wrapper], [data-radix-portal]')) {
      return true;
    }

    return Boolean(
      node.querySelector('[role="dialog"], [data-radix-popper-content-wrapper], [data-radix-portal]')
    );
  }

  function startHotkeysObserver() {
    if (!isFeatureEnabled('hotkeysHelp')) {
      stopHotkeysObserver();
      return;
    }

    stopHotkeysObserver();

    if (!(document.body instanceof HTMLElement) || typeof MutationObserver !== 'function') {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== 'childList' || !mutation.addedNodes.length) {
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (isHotkeysMutationCandidate(node)) {
            startHotkeysEnhanceFrame();
            return;
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    helper.state.hotkeysObserver = observer;
  }

  function startRouteRecoveryObserver() {
    if (helper.state.routeRecoveryObserver || !(document.body instanceof HTMLElement)) {
      return;
    }

    if (typeof MutationObserver !== 'function') {
      return;
    }

    const observer = new MutationObserver(() => {
      if (!isTranscriptionRoute() || isReadOnlyFeedbackRoute()) {
        return;
      }

      if (!hasTranscriptSurface()) {
        return;
      }

      stopRouteRecoveryObserver();
      resetRouteRefreshWindow();
      helper.runtime.scheduleRouteRefresh('recovery-observer');
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['placeholder'],
      childList: true,
      subtree: true
    });

    helper.state.routeRecoveryObserver = observer;
  }

  function tryDeleteCurrentRow(event) {
    const row = helper.getCurrentRow({ allowFallback: false });
    if (!row) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    void helper.runRowAction('deleteSegment', {
      row,
      allowFallback: false
    });
    return true;
  }

  function matchPlaybackRewindShortcut(event) {
    const shortcuts = Array.isArray(helper.config.playbackRewindShortcuts)
      ? helper.config.playbackRewindShortcuts
      : [];

    function matchesShortcutCode(shortcut) {
      const eventKeyCode = Number.isFinite(Number(event.keyCode)) ? Number(event.keyCode) : null;
      if (Array.isArray(shortcut.codes) && shortcut.codes.includes(event.code)) {
        return true;
      }

      if (shortcut.code && shortcut.code === event.code) {
        return true;
      }

      if (eventKeyCode != null && Number.isFinite(Number(shortcut.keyCode))) {
        return Number(shortcut.keyCode) === eventKeyCode;
      }

      return false;
    }

    return (
      shortcuts.find(
        (shortcut) =>
          shortcut &&
          matchesShortcutCode(shortcut) &&
          Boolean(shortcut.ctrlKey) === Boolean(event.ctrlKey) &&
          Boolean(shortcut.altKey) === Boolean(event.altKey) &&
          Boolean(shortcut.shiftKey) === Boolean(event.shiftKey) &&
          Boolean(shortcut.metaKey) === Boolean(event.metaKey) &&
          Number.isFinite(Number(shortcut.seconds))
      ) || null
    );
  }

  function shouldSuppressNativeArrowHotkey(event) {
    if (!isFeatureEnabled('disableNativeArrowSeek')) {
      return false;
    }

    if (!helper.runtime.isSessionInteractive()) {
      return false;
    }

    if (event.defaultPrevented) {
      return false;
    }

    if (event.altKey) {
      return false;
    }

    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return false;
    }

    if (event.ctrlKey || event.metaKey) {
      return true;
    }

    return !event.shiftKey;
  }

  function handleNativeArrowSuppress(event) {
    if (!shouldSuppressNativeArrowHotkey(event)) {
      return;
    }

    event.stopImmediatePropagation();
    if (helper.analytics) {
      helper.analytics.record('hotkey:arrow-suppressed', { key: event.key, ctrlKey: event.ctrlKey });
    }
  }

  helper.handleKeydown = function handleKeydown(event) {
    if (!helper.runtime.isSessionInteractive()) {
      return;
    }

    if (event.defaultPrevented) {
      return;
    }

    if (
      isFeatureEnabled('timelineSelection') &&
      typeof helper.handleCutPreviewKeydown === 'function' &&
      helper.handleCutPreviewKeydown(event)
    ) {
      if (helper.analytics) {
        helper.analytics.record('hotkey:cut-preview', { key: event.key, code: event.code });
      }
      return;
    }

    if (isFeatureEnabled('focusToggle') && event.key === 'Escape') {
      if (typeof helper.handleEscapeWorkflow === 'function' && helper.handleEscapeWorkflow()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (
      isFeatureEnabled('rowActions') &&
      event.key === 'Delete' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      helper.getCurrentRow({ allowFallback: false })
    ) {
      if (helper.analytics) {
        helper.analytics.record('hotkey:delete', { key: 'Delete' });
      }
      tryDeleteCurrentRow(event);
      return;
    }

    if (
      isFeatureEnabled('rowActions') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.code === 'KeyD' &&
      !helper.isEditable(event.target instanceof HTMLElement ? event.target : null)
    ) {
      if (tryDeleteCurrentRow(event)) {
        if (helper.analytics) {
          helper.analytics.record('hotkey:delete', { key: 'D' });
        }
        return;
      }
    }

    const rewindShortcut = isFeatureEnabled('rowActions') ? matchPlaybackRewindShortcut(event) : null;
    if (rewindShortcut) {
      const handled =
        typeof helper.seekPlaybackBySeconds === 'function' &&
        helper.seekPlaybackBySeconds(-Number(rewindShortcut.seconds));
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
        if (helper.analytics) {
          helper.analytics.record('hotkey:rewind', { seconds: Number(rewindShortcut.seconds), code: event.code });
        }
      }
      return;
    }

    if (
      isFeatureEnabled('selectedNumberToSkaz') &&
      event.code === 'KeyA' &&
      event.altKey &&
      !event.shiftKey &&
      !event.metaKey
    ) {
      const handled = autoConvertSelectedNumberText(event.target);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
        if (helper.analytics) {
          helper.analytics.record('hotkey:selected-number-auto-convert', {
            ctrlKey: event.ctrlKey
          });
        }
      }
      return;
    }

    if (event.ctrlKey || event.metaKey || !event.altKey) {
      return;
    }

    let handled = false;
    if (
      isFeatureEnabled('rowActions') &&
      isFeatureEnabled('speakerWorkflowHotkeys') &&
      !event.shiftKey &&
      event.code === 'Digit1' &&
      typeof helper.switchSpeakerWorkflow === 'function'
    ) {
      handled = true;
      void helper.switchSpeakerWorkflow('Speaker 1');
      if (helper.analytics) {
        helper.analytics.record('hotkey:speaker-switch', { speaker: 'Speaker 1' });
      }
    } else if (
      isFeatureEnabled('rowActions') &&
      isFeatureEnabled('speakerWorkflowHotkeys') &&
      !event.shiftKey &&
      event.code === 'Digit2' &&
      typeof helper.switchSpeakerWorkflow === 'function'
    ) {
      handled = true;
      void helper.switchSpeakerWorkflow('Speaker 2');
      if (helper.analytics) {
        helper.analytics.record('hotkey:speaker-switch', { speaker: 'Speaker 2' });
      }
    } else if (
      isFeatureEnabled('rowActions') &&
      isFeatureEnabled('speakerWorkflowHotkeys') &&
      event.code === 'Backquote' &&
      typeof helper.resetSpeakerWorkflow === 'function'
    ) {
      handled = true;
      void helper.resetSpeakerWorkflow();
      if (helper.analytics) {
        helper.analytics.record('hotkey:speaker-reset', {});
      }
    } else if (isFeatureEnabled('textMove') && !event.shiftKey && event.code === 'BracketLeft') {
      handled = helper.moveTextToAdjacentSegment(-1);
      if (handled && helper.analytics) {
        helper.analytics.record('hotkey:text-move', { direction: 'left' });
      }
    } else if (isFeatureEnabled('textMove') && !event.shiftKey && event.code === 'BracketRight') {
      handled = helper.moveTextToAdjacentSegment(1);
      if (handled && helper.analytics) {
        helper.analytics.record('hotkey:text-move', { direction: 'right' });
      }
    } else if (isFeatureEnabled('rowActions') && event.shiftKey && event.key === 'ArrowUp') {
      handled = true;
      void helper.runRowAction('mergePrevious');
      if (helper.analytics) {
        helper.analytics.record('hotkey:merge', { direction: 'previous' });
      }
    } else if (isFeatureEnabled('rowActions') && event.shiftKey && event.key === 'ArrowDown') {
      handled = true;
      void helper.runRowAction('mergeNext');
      if (helper.analytics) {
        helper.analytics.record('hotkey:merge', { direction: 'next' });
      }
    } else if (isFeatureEnabled('customLinter') && event.code === 'KeyF') {
      handled = true;
      const scope = event.shiftKey ? 'all' : 'current';
      void requestAutoFix(scope).then((result) => {
        if (helper.analytics) {
          helper.analytics.record('hotkey:lint-autofix', { scope, ...result });
        }
      });
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  function handleRowFocusIn(event) {
    if (!helper.runtime.isSessionInteractive()) {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const row = target.closest('tr');
    if (row && row.querySelector(helper.config.rowTextareaSelector)) {
      // Reset the cursor baseline when focus moves to a different row,
      // since the baseline is only meaningful within a single segment.
      const rowChanged = helper.state.currentRow && helper.state.currentRow !== row;
      if (rowChanged) {
        helper.state.cursorBaseline = null;
      }
      helper.setCurrentRow(row);

      if (helper.analytics) {
        const rowId = typeof helper.getRowIdentity === 'function'
          ? (helper.getRowIdentity(row)?.annotationId ?? null)
          : null;
        helper.analytics.record('row:focus-in', {
          rowId,
          rowChanged,
          isTextarea: target instanceof HTMLTextAreaElement
        });
      }
    }
  }

  function handleRowPointerDown(event) {
    if (!helper.runtime.isSessionInteractive()) {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const row = target.closest('tr');
    if (row && row.querySelector(helper.config.rowTextareaSelector)) {
      helper.setCurrentRow(row);
    }
  }

  /**
   * Update the cursor baseline when the user manually interacts with a
   * transcript textarea.  Covers typing (input), arrow keys / click
   * selection changes (keyup + pointerup) so that the proportional restore
   * system never drags the cursor backward past a position the user
   * intentionally placed it at.
   */
  function handleCursorBaselineUpdate(event) {
    const target = event.target;
    if (
      !(target instanceof HTMLTextAreaElement) ||
      !target.matches(helper.config.rowTextareaSelector)
    ) {
      return;
    }

    const pos = target.selectionStart;
    if (typeof pos === 'number') {
      const prevBaseline = helper.state.cursorBaseline;
      helper.state.cursorBaseline = pos;

      // Only log meaningful baseline changes (not every micro-movement)
      if (helper.analytics && event.type === 'input') {
        helper.analytics.recordTextEdit({
          cursorPos: pos,
          textLength: (target.value || '').length,
          prevBaseline
        });
      }

      if (helper.analytics && prevBaseline !== pos && event.type !== 'input') {
        helper.analytics.record('cursor:baseline-update', {
          pos,
          prevBaseline,
          eventType: event.type,
          textLength: (target.value || '').length
        });
      }
    }
  }

  function schedulePlaybackRowSync() {
    if (
      helper.state.playbackRowSyncInFlight ||
      typeof helper.syncCurrentRowToPlayback !== 'function'
    ) {
      return;
    }

    helper.state.playbackRowSyncInFlight = true;
    void helper.syncCurrentRowToPlayback().finally(() => {
      helper.state.playbackRowSyncInFlight = false;
    });
  }

  helper.bindRowTracking = function bindRowTracking() {
    if (helper.state.rowTrackingBound) {
      return;
    }

    document.addEventListener('focusin', handleRowFocusIn, true);
    document.addEventListener('pointerdown', handleRowPointerDown, true);
    document.addEventListener('input', handleCursorBaselineUpdate, true);
    document.addEventListener('keyup', handleCursorBaselineUpdate, true);
    document.addEventListener('pointerup', handleCursorBaselineUpdate, true);
    schedulePlaybackRowSync();
    helper.state.playbackRowSyncTimer = window.setInterval(schedulePlaybackRowSync, 250);
    helper.state.rowTrackingBound = true;
  };

  helper.unbindRowTracking = function unbindRowTracking() {
    if (!helper.state.rowTrackingBound) {
      return;
    }

    document.removeEventListener('focusin', handleRowFocusIn, true);
    document.removeEventListener('pointerdown', handleRowPointerDown, true);
    document.removeEventListener('input', handleCursorBaselineUpdate, true);
    document.removeEventListener('keyup', handleCursorBaselineUpdate, true);
    document.removeEventListener('pointerup', handleCursorBaselineUpdate, true);
    if (helper.state.playbackRowSyncTimer != null) {
      window.clearInterval(helper.state.playbackRowSyncTimer);
      helper.state.playbackRowSyncTimer = null;
    }
    helper.state.playbackRowSyncInFlight = false;
    helper.state.lastPlaybackRow = null;
    helper.state.lastPlaybackRowIdentity = null;
    helper.state.rowTrackingBound = false;
  };

  function bindGlobalListeners() {
    if (helper.state.keydownBound) {
      return;
    }

    window.addEventListener('keydown', handleNativeArrowSuppress, true);
    document.addEventListener('keydown', helper.handleKeydown, true);
    helper.state.keydownBound = true;
    helper.state.nativeArrowSuppressBound = true;
  }

  function patchHistoryMethod(name) {
    const current = window.history[name];
    if (typeof current !== 'function') {
      return;
    }

    if (current.__babelHelperPatched) {
      return;
    }

    const original = current.__babelHelperOriginal || current;

    function patchedHistoryMethod() {
      const result = original.apply(this, arguments);
      resetRouteRefreshWindow();
      helper.runtime.scheduleRouteRefresh('route-change');
      return result;
    }

    patchedHistoryMethod.__babelHelperPatched = true;
    patchedHistoryMethod.__babelHelperOriginal = original;
    window.history[name] = patchedHistoryMethod;
  }

  function ensureHistoryPatches() {
    if (
      typeof window.history.pushState === 'function' &&
      !window.history.pushState.__babelHelperPatched
    ) {
      patchHistoryMethod('pushState');
    }

    if (
      typeof window.history.replaceState === 'function' &&
      !window.history.replaceState.__babelHelperPatched
    ) {
      patchHistoryMethod('replaceState');
    }
  }

  var URL_POLL_INTERVAL_MS = 500;
  var lastPolledHref = '';
  var urlPollTimer = 0;

  function startUrlPolling() {
    if (urlPollTimer) {
      return;
    }

    lastPolledHref = window.location.href;
    urlPollTimer = window.setInterval(function pollUrl() {
      ensureHistoryPatches();

      var currentHref = window.location.href;
      if (currentHref !== lastPolledHref) {
        lastPolledHref = currentHref;
        handleRouteEvent('url-poll');
      }
    }, URL_POLL_INTERVAL_MS);
  }

  function handleRouteEvent(reason) {
    lastPolledHref = window.location.href;
    resetRouteRefreshWindow();
    helper.runtime.scheduleRouteRefresh(reason);
    if (helper.analytics) {
      helper.analytics.record('session:route-change', {
        reason,
        url: window.location.href
      });
    }
  }

  function handlePopState() {
    handleRouteEvent('popstate');
  }

  function handlePageShow() {
    handleRouteEvent('pageshow');
  }

  function bindRouteWatchers() {
    if (helper.state.routeWatchBound) {
      return;
    }

    patchHistoryMethod('pushState');
    patchHistoryMethod('replaceState');
    window.addEventListener('popstate', handlePopState, true);
    window.addEventListener('pageshow', handlePageShow, true);
    startUrlPolling();
    helper.state.routeWatchBound = true;
  }

  function clearSessionFeatures() {
    stopHotkeysObserver();
    stopHotkeysEnhanceFrame();

    if (typeof helper.resetCutState === 'function') {
      helper.resetCutState();
    } else if (typeof helper.clearCutPreview === 'function') {
      helper.clearCutPreview();
    }

    if (typeof helper.clearMagnifier === 'function') {
      helper.clearMagnifier();
    }

    if (typeof helper.unbindZoomPersistence === 'function') {
      helper.unbindZoomPersistence();
    }

    if (typeof helper.setCurrentRow === 'function') {
      helper.setCurrentRow(null);
    }

    if (helper.state.sessionActive && helper.analytics) {
      helper.analytics.record('session:end', {
        url: window.location.href,
        summary: helper.analytics.getSummary()
      });
    }

    helper.state.sessionActive = false;
  }

  function bindSessionFeatures() {
    const wasSessionActive = Boolean(helper.state.sessionActive);
    stopRouteRecoveryObserver();

    if (isFeatureEnabled('hotkeysHelp')) {
      if (typeof helper.enhanceHotkeysDialog === 'function') {
        helper.enhanceHotkeysDialog();
      }
      startHotkeysObserver();
    } else {
      stopHotkeysObserver();
      stopHotkeysEnhanceFrame();
    }

    if (
      isFeatureEnabled('timelineSelection') &&
      isFeatureEnabled('timelineZoomDefaults') &&
      typeof helper.bindZoomPersistence === 'function'
    ) {
      helper.bindZoomPersistence();
    }

    if (
      !wasSessionActive &&
      isFeatureEnabled('timelineSelection') &&
      isFeatureEnabled('timelineZoomDefaults') &&
      typeof helper.applySavedZoomDefault === 'function'
    ) {
      void helper.applySavedZoomDefault();
    }

    helper.state.sessionActive = true;

    if (!wasSessionActive && helper.analytics) {
      helper.analytics.record('session:start', {
        url: window.location.href
      });
    }
  }

  helper.runtime.scheduleRouteRefresh = function scheduleRouteRefresh(reason) {
    helper.runtime.clearRuntimeTimer();
    helper.state.routeRefreshTimer = window.setTimeout(() => {
      helper.state.routeRefreshTimer = 0;
      void helper.runtime.refreshRouteSession(reason || 'scheduled');
    }, ROUTE_REFRESH_DELAY_MS);
  };

  helper.runtime.refreshRouteSession = function refreshRouteSession(reason) {
    if (!isTranscriptionRoute()) {
      clearSessionFeatures();
      stopRouteRecoveryObserver();
      helper.runtime.clearRuntimeTimer();
      helper.state.routeRefreshAttempts = 0;
      helper.state.routeRefreshWindowStartedAt = 0;
      return false;
    }

    if (isReadOnlyFeedbackRoute()) {
      clearSessionFeatures();
      startRouteRecoveryObserver();
      helper.runtime.clearRuntimeTimer();
      helper.state.routeRefreshAttempts = 0;
      helper.state.routeRefreshWindowStartedAt = 0;
      return false;
    }

    if (hasTranscriptSurface()) {
      bindSessionFeatures();
      helper.runtime.clearRuntimeTimer();
      helper.state.routeRefreshAttempts = 0;
      helper.state.routeRefreshWindowStartedAt = 0;
      return true;
    }

    startRouteRecoveryObserver();

    const startedAt = helper.state.routeRefreshWindowStartedAt || Date.now();
    if (!helper.state.routeRefreshWindowStartedAt) {
      helper.state.routeRefreshWindowStartedAt = startedAt;
    }

    helper.state.routeRefreshAttempts += 1;
    if (
      helper.state.routeRefreshAttempts >= ROUTE_REFRESH_MAX_ATTEMPTS ||
      Date.now() - startedAt >= ROUTE_REFRESH_MAX_WINDOW_MS
    ) {
      helper.runtime.clearRuntimeTimer();
      return false;
    }

    helper.runtime.scheduleRouteRefresh(reason === 'await-surface' ? reason : 'await-surface');
    return false;
  };

  helper.init = function init() {
    if (helper.state.runtimeBound) {
      return;
    }

    helper.state.runtimeBound = true;
    bindRouteWatchers();
    bindGlobalListeners();
    helper.bindRowTracking();
    if (isFeatureEnabled('timelineSelection') && typeof helper.bindCutPreview === 'function') {
      helper.bindCutPreview();
    }
    if (isFeatureEnabled('magnifier') && typeof helper.bindMagnifier === 'function') {
      helper.bindMagnifier();
    }
    resetRouteRefreshWindow();
    void helper.runtime.refreshRouteSession('init');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', helper.init, { once: true });
  } else {
    helper.init();
  }
}


