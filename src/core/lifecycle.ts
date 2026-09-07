// @ts-nocheck
import { createEditorInput } from '../features/editor-input';
import { registerPlaybackRowTracking } from '../features/playback-row-tracking';

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
  const { handleKeydown, handleNativeArrowSuppress, handleGlobalKeyup, handleWindowBlur } = input;
  helper.runtime.editorHooks = input.hooks;
  registerPlaybackRowTracking(helper);
  helper.handleKeydown = handleKeydown;

  const ROUTE_REFRESH_DELAY_MS = 80;
  const ROUTE_REFRESH_MAX_ATTEMPTS = 60;
  const ROUTE_REFRESH_MAX_WINDOW_MS = 10000;
  const URL_POLL_INTERVAL_MS = 2000;
  const SESSION_BIND_RETRY_DELAYS_MS = [250, 750, 1500, 3000];
  const EXTENSION_COMMAND_MESSAGE_TYPE = 'babel-helper-command';

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
    // The native table remains mounted when a track filter has no annotations.
    return Boolean(document.querySelector('main table'));
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

    helper.perf?.count?.('observer.start', { name: 'hotkeys' });
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

    helper.perf?.count?.('observer.start', { name: 'route-recovery' });
    helper.state.routeRecoveryObserver = observer;
  }

  async function runExtensionAutoInsertSegmentCommand() {
    if (!isTranscriptionRoute() || isReadOnlyFeedbackRoute()) {
      return {
        ok: false,
        reason: 'not-transcription-route'
      };
    }

    if (!isFeatureEnabled('timelineSelection')) {
      return {
        ok: false,
        reason: 'feature-disabled'
      };
    }

    if (!hasTranscriptSurface()) {
      helper.runtime.scheduleRouteRefresh('command:auto-insert-segment');
      return {
        ok: false,
        reason: 'missing-transcript-surface'
      };
    }

    if (helper.runtime && typeof helper.runtime.ensureSessionRuntime === 'function') {
      await helper.runtime.ensureSessionRuntime('command:auto-insert-segment');
    }

    if (typeof helper.autoInsertSegmentAtCaret !== 'function') {
      return {
        ok: false,
        reason: 'auto-insert-unavailable'
      };
    }

    helper.state.autoInsertSegmentHotkeyHandledAt = Date.now();
    const result = await helper.autoInsertSegmentAtCaret();
    if (helper.analytics) {
      helper.analytics.record('hotkey:trim', {
        scope: 'auto-insert-segment',
        via: 'chrome-command',
        ok: Boolean(result && result.ok),
        reason: result && result.reason ? result.reason : null
      });
    }
    return result;
  }

  function handleExtensionCommandMessage(message, _sender, sendResponse) {
    if (
      !message ||
      message.type !== EXTENSION_COMMAND_MESSAGE_TYPE ||
      message.command !== 'auto-insert-segment'
    ) {
      return false;
    }

    void runExtensionAutoInsertSegmentCommand()
      .then((result) => {
        sendResponse(result || null);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          reason: 'command-error',
          message: error instanceof Error ? error.message : String(error || '')
        });
      });

    return true;
  }

  function bindGlobalListeners() {
    if (helper.state.keydownBound) {
      return;
    }

    window.addEventListener('keydown', handleNativeArrowSuppress, true);
    window.addEventListener('keyup', handleGlobalKeyup, true);
    window.addEventListener('blur', handleWindowBlur, true);
    document.addEventListener('keydown', helper.handleKeydown, true);
    if (
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      chrome.runtime.onMessage &&
      typeof chrome.runtime.onMessage.addListener === 'function'
    ) {
      chrome.runtime.onMessage.addListener(handleExtensionCommandMessage);
    }
    helper.state.keydownBound = true;
    helper.state.nativeArrowSuppressBound = true;
  }

  function unbindGlobalListeners() {
    if (!helper.state.keydownBound) {
      return;
    }

    window.removeEventListener('keydown', handleNativeArrowSuppress, true);
    window.removeEventListener('keyup', handleGlobalKeyup, true);
    window.removeEventListener('blur', handleWindowBlur, true);
    document.removeEventListener('keydown', helper.handleKeydown, true);
    if (
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      chrome.runtime.onMessage &&
      typeof chrome.runtime.onMessage.removeListener === 'function'
    ) {
      chrome.runtime.onMessage.removeListener(handleExtensionCommandMessage);
    }
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

  function isCurrentSessionSurface(href) {
    return Boolean(
      href === window.location.href &&
      isTranscriptionRoute() &&
      !isReadOnlyFeedbackRoute() &&
      hasTranscriptSurface()
    );
  }

  function runSessionOnLoaded(reason, bindHref, lifecycleRevision) {
    if (
      helper.state.onLoadedCalledRevision === lifecycleRevision ||
      helper.state.onLoadedInFlightRevision === lifecycleRevision ||
      lifecycleRevision !== helper.state.sessionLifecycleRevision ||
      !isCurrentSessionSurface(bindHref)
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
      .then(() => helper.runtime.onLoaded(reason || 'session-ready'))
      .then((activated) => {
        if (
          activated === false ||
          lifecycleRevision !== helper.state.sessionLifecycleRevision ||
          !isCurrentSessionSurface(bindHref)
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

  async function bindSessionFeatures(reason) {
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
        !isCurrentSessionSurface(bindHref)
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
    helper.runtime.clearRuntimeTimer();
    const delay = Number.isFinite(Number(delayMs)) ? Math.max(0, Number(delayMs)) : ROUTE_REFRESH_DELAY_MS;
    helper.state.routeRefreshTimer = window.setTimeout(() => {
      helper.state.routeRefreshTimer = 0;
      void helper.runtime.refreshRouteSession(reason || 'scheduled');
    }, delay);
  };

  helper.runtime.refreshRouteSession = function refreshRouteSession(reason) {
    if (!isTranscriptionRoute()) {
      clearSessionFeatures(reason || 'route-exit');
      stopRouteRecoveryObserver();
      helper.runtime.clearRuntimeTimer();
      helper.state.routeRefreshAttempts = 0;
      helper.state.routeRefreshWindowStartedAt = 0;
      return false;
    }

    if (isReadOnlyFeedbackRoute()) {
      clearSessionFeatures(reason || 'read-only-route');
      startRouteRecoveryObserver();
      helper.runtime.clearRuntimeTimer();
      helper.state.routeRefreshAttempts = 0;
      helper.state.routeRefreshWindowStartedAt = 0;
      return false;
    }

    if (hasTranscriptSurface()) {
      const bindHref = window.location.href;
      void bindSessionFeatures(reason || 'transcript-surface')
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
            bound.lifecycleRevision
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
    resetRouteRefreshWindow();
    void helper.runtime.refreshRouteSession('init');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', helper.init, { once: true });
  } else {
    helper.init();
  }
}


