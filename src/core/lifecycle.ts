// @ts-nocheck
import { createEditorInput } from '../features/editor-input';
import { registerPlaybackRowTracking } from '../features/playback-row-tracking';
import { readNativeSessionState } from '../site/editor-control';

export function registerLifecycle(helper: any) {
  if (!helper || helper.__mainInitialized) {
    return;
  }

  helper.__mainInitialized = true;
  helper.state.sessionLifecycleRevision = Math.max(
    0,
    Number(helper.state.sessionLifecycleRevision) || 0
  );
  helper.state.onLoadedCalledRevision = -1;
  helper.state.onLoadedInFlightRevision = -1;

  const input = createEditorInput(helper);
  const { handleKeydown, handleKeyCapture, handleKeyBubble, handleNativeTextInput,
    handleNativeSelectionChange, handleNativePointerDown, handleComposition, handleGlobalKeyup, handleWindowBlur } = input;
  helper.runtime.editorHooks = input.hooks;
  registerPlaybackRowTracking(helper);
  helper.handleKeydown = handleKeydown;

  const ROUTE_REFRESH_DELAY_MS = 80;
  const ROUTE_REFRESH_MAX_ATTEMPTS = 60;
  const ROUTE_REFRESH_MAX_WINDOW_MS = 10000;
  const URL_POLL_INTERVAL_MS = 2000;
  const SESSION_BIND_RETRY_DELAYS_MS = [250, 750, 1500, 3000];
  let disposed = false;
  let sessionAccessInFlight = false;
  let lastPolledNativeSession = '';
  let hotkeysObservedBody: HTMLElement | null = null;

  function isFeatureEnabled(featureKey) {
    if (typeof helper.isFeatureEnabled === 'function') {
      return helper.isFeatureEnabled(featureKey);
    }

    return true;
  }

  function isTranscriptionRoute() {
    return /^\/transcription(?:\/|$)/.test(window.location.pathname || '');
  }

  function requestNativeSessionAccess() {
    if (disposed || sessionAccessInFlight) return;
    sessionAccessInFlight = true;
    const href = window.location.href;
    const revision = helper.state.sessionLifecycleRevision;
    // Lifecycle registration can precede snapshot-service registration during
    // kernel boot. Resolve that dependency on the next microtask, not from URL.
    void Promise.resolve()
      .then(() => {
        if (disposed || href !== window.location.href || revision !== helper.state.sessionLifecycleRevision) return;
        return helper.refreshEditorSnapshot?.('native-session-access');
      })
      .then(() => {
        if (!disposed && href === window.location.href && revision === helper.state.sessionLifecycleRevision &&
            readNativeSessionState()) helper.runtime.scheduleRouteRefresh('native-session-ready', 0);
      })
      .finally(() => { sessionAccessInFlight = false; });
  }

  function hasTranscriptSurface() {
    // The native scroll surface also exists for empty and speaker-filtered tasks.
    return Boolean(document.querySelector('[data-transcript-scroll]'));
  }

  helper.runtime.isSessionInteractive = function isSessionInteractive() {
    return Boolean(
      !disposed &&
      isTranscriptionRoute() &&
      hasTranscriptSurface() &&
      readNativeSessionState()?.readOnly === false
    );
  };

  function resetRouteRefreshWindow() {
    helper.state.routeRefreshAttempts = 0;
    helper.state.routeRefreshWindowStartedAt = Date.now();
    helper.state.sessionBindRetryCount = 0;
    helper.state.onLoadedCalled = false;
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
    hotkeysObservedBody = null;
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

    if (helper.state.hotkeysObserver && hotkeysObservedBody === document.body) return;
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

    helper.perf?.count?.('observer.start', { name: 'hotkeys' });
    helper.state.hotkeysObserver = observer;
    hotkeysObservedBody = document.body;
  }

  function startRouteRecoveryObserver() {
    if (helper.state.routeRecoveryObserver || !(document.body instanceof HTMLElement)) {
      return;
    }

    if (typeof MutationObserver !== 'function') {
      return;
    }

    const observer = new MutationObserver(() => {
      if (!isTranscriptionRoute() || disposed) {
        return;
      }

      if (!hasTranscriptSurface()) {
        return;
      }
      const status = readNativeSessionState();
      // Unrelated rendering must not restart the bounded bootstrap window or
      // repeatedly rebind a known read-only session. The URL fallback still
      // detects native metadata transitions without a corresponding DOM event.
      if (!status || (status.readOnly && `${status.reviewActionId}:${status.readOnly}` === lastPolledNativeSession)) {
        return;
      }

      stopRouteRecoveryObserver();
      resetRouteRefreshWindow();
      helper.runtime.scheduleRouteRefresh('recovery-observer');
    });

    observer.observe(document.documentElement || document.body, {
      attributes: true,
      attributeFilter: ['data-transcript-scroll', 'data-babel-review-action-id', 'role', 'contenteditable', 'disabled'],
      childList: true,
      subtree: true
    });

    helper.perf?.count?.('observer.start', { name: 'route-recovery' });
    helper.state.routeRecoveryObserver = observer;
  }


  function bindGlobalListeners() {
    if (helper.state.keydownBound) {
      return;
    }

    window.addEventListener('keydown', handleKeyCapture, true);
    window.addEventListener('keyup', handleGlobalKeyup, true);
    window.addEventListener('blur', handleWindowBlur, true);
    window.addEventListener('selectionchange', handleNativeSelectionChange, true);
    window.addEventListener('pointerdown', handleNativePointerDown, true);
    window.addEventListener('compositionstart', handleComposition, true);
    window.addEventListener('compositionend', handleComposition, true);
    document.addEventListener('keydown', helper.handleKeydown, true);
    document.addEventListener('keydown', handleKeyBubble, false);
    document.addEventListener('beforeinput', handleNativeTextInput, true);
    document.addEventListener('paste', handleNativeTextInput, true);
    helper.state.keydownBound = true;
    helper.state.nativeArrowSuppressBound = true;
  }

  function unbindGlobalListeners() {
    if (!helper.state.keydownBound) {
      return;
    }

    window.removeEventListener('keydown', handleKeyCapture, true);
    window.removeEventListener('keyup', handleGlobalKeyup, true);
    window.removeEventListener('blur', handleWindowBlur, true);
    window.removeEventListener('selectionchange', handleNativeSelectionChange, true);
    window.removeEventListener('pointerdown', handleNativePointerDown, true);
    window.removeEventListener('compositionstart', handleComposition, true);
    window.removeEventListener('compositionend', handleComposition, true);
    document.removeEventListener('keydown', helper.handleKeydown, true);
    document.removeEventListener('keydown', handleKeyBubble, false);
    document.removeEventListener('beforeinput', handleNativeTextInput, true);
    document.removeEventListener('paste', handleNativeTextInput, true);
    helper.state.keydownBound = false;
    helper.state.nativeArrowSuppressBound = false;
    helper.state.rightShiftPressed = false;
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

  function restoreHistoryMethod(name) {
    const current = window.history[name];
    if (
      current &&
      current.__babelHelperPatched &&
      typeof current.__babelHelperOriginal === 'function'
    ) {
      window.history[name] = current.__babelHelperOriginal;
    }
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

  var lastPolledHref = '';
  var urlPollTimer = 0;

  function startUrlPolling() {
    if (urlPollTimer) {
      return;
    }

    lastPolledHref = window.location.href;
    urlPollTimer = window.setInterval(function pollUrl() {
      helper.perf?.count?.('url.poll.tick');
      ensureHistoryPatches();

      var currentHref = window.location.href;
      if (currentHref !== lastPolledHref) {
        lastPolledHref = currentHref;
        handleRouteEvent('url-poll');
      }
      else if (isTranscriptionRoute() && hasTranscriptSurface()) {
        const status = readNativeSessionState();
        const key = status ? `${status.reviewActionId}:${status.readOnly}` : '';
        if (key !== lastPolledNativeSession) {
          lastPolledNativeSession = key;
          handleRouteEvent('native-session-change');
        }
      }
    }, URL_POLL_INTERVAL_MS);
  }

  function stopUrlPolling() {
    if (!urlPollTimer) {
      return;
    }

    window.clearInterval(urlPollTimer);
    urlPollTimer = 0;
  }

  function handleRouteEvent(reason) {
    lastPolledHref = window.location.href;
    resetRouteRefreshWindow();
    if (
      helper.state.sessionActive ||
      helper.state.onLoadedInFlight ||
      helper.state.sessionBindPromise
    ) {
      clearSessionFeatures(reason || 'route-change');
    }
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

  function unbindRouteWatchers() {
    if (!helper.state.routeWatchBound) {
      return;
    }

    window.removeEventListener('popstate', handlePopState, true);
    window.removeEventListener('pageshow', handlePageShow, true);
    stopUrlPolling();
    restoreHistoryMethod('pushState');
    restoreHistoryMethod('replaceState');
    helper.state.routeWatchBound = false;
  }

  helper.runtime.disposeLifecycle = function disposeLifecycle(reason) {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('DOMContentLoaded', helper.init, false);
    helper.runtime.clearRuntimeTimer();
    clearSessionFeatures(reason || 'lifecycle-dispose');
    stopRouteRecoveryObserver();
    unbindRouteWatchers();
    unbindGlobalListeners();
    if (typeof helper.unbindRowTracking === 'function') {
      helper.unbindRowTracking();
    }
    helper.state.runtimeBound = false;
    helper.__mainInitialized = false;
  };

  function clearSessionFeatures(reason) {
    helper.state.sessionLifecycleRevision =
      Math.max(0, Number(helper.state.sessionLifecycleRevision) || 0) + 1;
    stopHotkeysObserver();
    stopHotkeysEnhanceFrame();
    void helper.runtime.deactivateFeature?.('session', reason || 'session-clear');
    if (typeof helper.unbindRowTracking === 'function') {
      helper.unbindRowTracking();
    }

    if (typeof helper.resetCutState === 'function') {
      helper.resetCutState();
    } else if (typeof helper.clearCutPreview === 'function') {
      helper.clearCutPreview();
    }

    if (typeof helper.clearMagnifier === 'function') {
      helper.clearMagnifier();
    }

    if (typeof helper.unbindWaveformScaleUnlock === 'function') {
      helper.unbindWaveformScaleUnlock();
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

  function getLifecycleErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function recordLifecycleError(stage, error) {
    const message = getLifecycleErrorMessage(error);
    helper.perf?.count?.('lifecycle.error', { stage, message });
  }

  function getSessionBindRetryDelay() {
    const retryCount = Math.max(1, Number(helper.state.sessionBindRetryCount) || 1);
    const index = Math.min(retryCount - 1, SESSION_BIND_RETRY_DELAYS_MS.length - 1);
    return SESSION_BIND_RETRY_DELAYS_MS[index];
  }

  function scheduleSessionBindRetry(reason, error) {
    if (error) {
      recordLifecycleError(reason || 'session-bind-retry', error);
    }
    helper.state.sessionBindRetryCount = Math.max(0, Number(helper.state.sessionBindRetryCount) || 0) + 1;
    helper.runtime.scheduleRouteRefresh(reason || 'session-bind-retry', getSessionBindRetryDelay());
  }

  function isCurrentSessionSurface(href, reviewActionId) {
    if (disposed || href !== window.location.href || !isTranscriptionRoute() || !hasTranscriptSurface()) return false;
    const status = readNativeSessionState();
    return Boolean(status?.readOnly === false && status.reviewActionId === reviewActionId);
  }

  function runSessionOnLoaded(reason, bindHref, lifecycleRevision, reviewActionId) {
    if (
      helper.state.onLoadedCalledRevision === lifecycleRevision ||
      helper.state.onLoadedInFlightRevision === lifecycleRevision ||
      lifecycleRevision !== helper.state.sessionLifecycleRevision ||
      !isCurrentSessionSurface(bindHref, reviewActionId)
    ) {
      return;
    }

    if (typeof helper.runtime.onLoaded !== 'function') {
      helper.state.onLoadedCalled = true;
      helper.state.onLoadedCalledRevision = lifecycleRevision;
      return;
    }

    helper.state.onLoadedInFlight = true;
    helper.state.onLoadedInFlightRevision = lifecycleRevision;
    Promise.resolve()
      .then(() => lifecycleRevision === helper.state.sessionLifecycleRevision &&
        isCurrentSessionSurface(bindHref, reviewActionId) ? helper.runtime.onLoaded(reason || 'session-ready') : false)
      .then((activated) => {
        if (
          activated === false ||
          lifecycleRevision !== helper.state.sessionLifecycleRevision ||
          !isCurrentSessionSurface(bindHref, reviewActionId)
        ) {
          return;
        }
        helper.state.onLoadedCalled = true;
        helper.state.onLoadedCalledRevision = lifecycleRevision;
        helper.state.sessionBindRetryCount = 0;
      })
      .catch((error) => {
        if (lifecycleRevision !== helper.state.sessionLifecycleRevision) {
          return;
        }
        helper.state.onLoadedCalled = false;
        scheduleSessionBindRetry('on-loaded-error', error);
      })
      .finally(() => {
        if (helper.state.onLoadedInFlightRevision === lifecycleRevision) {
          helper.state.onLoadedInFlight = false;
          helper.state.onLoadedInFlightRevision = -1;
        }
      });
  }

  helper.runtime.reconcileSessionSettings = function reconcileSessionSettings() {
    if (!helper.state.sessionActive || !helper.runtime.isSessionInteractive()) return;
    if (isFeatureEnabled('timelineSelection')) {
      helper.bindCutPreview?.();
    } else {
      helper.clearCutPreview?.();
      helper.unbindCutPreview?.();
    }
    if (isFeatureEnabled('disableNativeTimelineDoubleClick')) {
      helper.bindNativeTimelineDoubleClickBlocker?.();
    } else {
      helper.unbindNativeTimelineDoubleClickBlocker?.();
    }
    if (isFeatureEnabled('hotkeysHelp')) {
      helper.enhanceHotkeysDialog?.();
      startHotkeysObserver();
    } else {
      stopHotkeysObserver();
      stopHotkeysEnhanceFrame();
    }
    if (isFeatureEnabled('waveformScaleUnlock')) {
      helper.bindWaveformScaleUnlock?.();
    } else {
      helper.unbindWaveformScaleUnlock?.();
    }
    if (isFeatureEnabled('timelineSelection') && isFeatureEnabled('timelineZoomDefaults')) {
      helper.bindZoomPersistence?.();
    } else {
      helper.unbindZoomPersistence?.();
    }
    if (!isFeatureEnabled('proportionalCursorRestore')) helper.stopGhostCursor?.();
  };


  async function bindSessionFeatures(reason, reviewActionId) {
    if (helper.state.sessionBindPromise) {
      return helper.state.sessionBindPromise;
    }

    const bindHref = window.location.href;
    const lifecycleRevision = Math.max(
      0,
      Number(helper.state.sessionLifecycleRevision) || 0
    );
    helper.state.sessionBindPromise = (async () => {
      const wasSessionActive = Boolean(helper.state.sessionActive);
      stopRouteRecoveryObserver();
      await helper.runtime.ensureSessionRuntime?.(reason || 'session-ready');
      if (
        lifecycleRevision !== helper.state.sessionLifecycleRevision ||
        !isCurrentSessionSurface(bindHref, reviewActionId)
      ) {
        return false;
      }

      if (typeof helper.invalidateRowTimeCache === 'function') {
        helper.invalidateRowTimeCache();
      }

      if (typeof helper.bindRowTracking === 'function') {
        helper.bindRowTracking();
      }
      if (isFeatureEnabled('timelineSelection') && typeof helper.bindCutPreview === 'function') {
        helper.bindCutPreview();
      }
      if (
        isFeatureEnabled('disableNativeTimelineDoubleClick') &&
        typeof helper.bindNativeTimelineDoubleClickBlocker === 'function'
      ) {
        helper.bindNativeTimelineDoubleClickBlocker();
      }
      if (isFeatureEnabled('magnifier') && typeof helper.bindMagnifier === 'function') {
        helper.bindMagnifier();
      }

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
        isFeatureEnabled('waveformScaleUnlock') &&
        typeof helper.bindWaveformScaleUnlock === 'function'
      ) {
        helper.bindWaveformScaleUnlock();
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
        void helper.applySavedZoomDefault().catch((error) => {
          recordLifecycleError('zoom-default', error);
        });
      }

      helper.state.sessionActive = true;
      helper.state.sessionBindRetryCount = 0;
      helper.perf?.setPhase?.('session-ready', { reason });

      if (!wasSessionActive && helper.analytics) {
        helper.analytics.record('session:start', {
          url: window.location.href
        });
      }
      return { lifecycleRevision };
    })();

    try {
      return await helper.state.sessionBindPromise;
    } finally {
      helper.state.sessionBindPromise = null;
    }
  }

  helper.runtime.scheduleRouteRefresh = function scheduleRouteRefresh(reason, delayMs) {
    if (disposed) return;
    helper.runtime.clearRuntimeTimer();
    const delay = Number.isFinite(Number(delayMs)) ? Math.max(0, Number(delayMs)) : ROUTE_REFRESH_DELAY_MS;
    helper.state.routeRefreshTimer = window.setTimeout(() => {
      helper.state.routeRefreshTimer = 0;
      void helper.runtime.refreshRouteSession(reason || 'scheduled');
    }, delay);
  };

  helper.runtime.refreshRouteSession = function refreshRouteSession(reason) {
    if (disposed) return false;
    if (!isTranscriptionRoute()) {
      clearSessionFeatures(reason || 'route-exit');
      stopRouteRecoveryObserver();
      helper.runtime.clearRuntimeTimer();
      helper.state.routeRefreshAttempts = 0;
      helper.state.routeRefreshWindowStartedAt = 0;
      lastPolledNativeSession = '';
      return false;
    }

    const hasSurface = hasTranscriptSurface();
    const status = hasSurface ? readNativeSessionState() : null;
    if (status) {
      const key = `${status.reviewActionId}:${status.readOnly}`;
      if (lastPolledNativeSession && key !== lastPolledNativeSession &&
          (helper.state.sessionActive || helper.state.onLoadedInFlight || helper.state.sessionBindPromise)) {
        clearSessionFeatures('native-session-change');
      }
      lastPolledNativeSession = key;
    }
    if (status?.readOnly === true) {
      if (helper.state.sessionActive || helper.state.onLoadedInFlight || helper.state.sessionBindPromise) {
        clearSessionFeatures(reason || 'native-read-only');
      }
      startRouteRecoveryObserver();
      helper.runtime.clearRuntimeTimer();
      helper.state.routeRefreshAttempts = 0;
      helper.state.routeRefreshWindowStartedAt = 0;
      return false;
    }

    if (status?.readOnly === false) {
      const bindHref = window.location.href;
      void bindSessionFeatures(reason || 'transcript-surface', status.reviewActionId)
        .then((bound) => {
          if (!bound) {
            if (bindHref === window.location.href) {
              helper.runtime.scheduleRouteRefresh('stale-session-bind');
            }
            return;
          }
          runSessionOnLoaded(
            reason || 'transcript-surface',
            bindHref,
            bound.lifecycleRevision,
            status.reviewActionId
          );
        })
        .catch((error) => {
          scheduleSessionBindRetry('session-bind-error', error);
        });

      helper.runtime.clearRuntimeTimer();
      helper.state.routeRefreshAttempts = 0;
      helper.state.routeRefreshWindowStartedAt = 0;
      return true;
    }

    startRouteRecoveryObserver();
    if (helper.state.sessionActive || helper.state.onLoadedInFlight || helper.state.sessionBindPromise) {
      clearSessionFeatures(reason || 'native-session-unavailable');
    }
    requestNativeSessionAccess();

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
    if (disposed || helper.state.runtimeBound) {
      return;
    }

    helper.state.runtimeBound = true;
    bindRouteWatchers();
    bindGlobalListeners();
    resetRouteRefreshWindow();
    void helper.runtime.refreshRouteSession('init');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', helper.init, { once: true });
  } else {
    helper.init();
  }
}


