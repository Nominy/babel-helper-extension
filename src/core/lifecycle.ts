// @ts-nocheck
import { createEditorInput } from '../features/editor-input';
import { registerPlaybackRowTracking } from '../features/playback-row-tracking';
import { readNativeSessionState } from '../site/editor-control';
import { showNativeAutomationFailure } from '../ui/native-automation-failure';

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

  let disposed = false;
  let sessionAccessInFlight = null;
  let lastNativeSession = '';
  let sessionFailure = '';
  let lastHref = window.location.href;
  let routeRefreshQueued = false;
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
    if (disposed || sessionAccessInFlight || sessionFailure) return;
    const href = window.location.href;
    const revision = helper.state.sessionLifecycleRevision;
    const request = Promise.resolve().then(async () => {
      if (disposed || href !== window.location.href || revision !== helper.state.sessionLifecycleRevision) return;
      await helper.refreshEditorSnapshot?.('native-session-access');
      if (disposed || href !== window.location.href || revision !== helper.state.sessionLifecycleRevision) return;
      if (readNativeSessionState()) helper.runtime.scheduleRouteRefresh('native-session-ready');
      else if (hasTranscriptSurface()) failSession('native-session-access',
        new Error(readSessionPublication()?.error || 'Native editor session subscription is unavailable.'));
    }).catch(error => {
      if (!disposed && href === window.location.href && revision === helper.state.sessionLifecycleRevision) {
        failSession('native-session-access', error);
      }
    }).finally(() => {
      if (sessionAccessInFlight === request) sessionAccessInFlight = null;
    });
    sessionAccessInFlight = request;
  }

  function readSessionPublication() {
    try {
      const state = JSON.parse(document.documentElement.getAttribute('data-babel-helper-native-session') || 'null');
      return state?.href === window.location.href ? state : null;
    } catch { return null; }
  }

  function hasTranscriptSurface() {
    // The native scroll surface also exists for empty and speaker-filtered tasks.
    return Boolean(document.querySelector('[data-transcript-scroll]'));
  }

  helper.runtime.isSessionInteractive = function isSessionInteractive() {
    return Boolean(
      !disposed &&
      !sessionFailure &&
      isTranscriptionRoute() &&
      hasTranscriptSurface() &&
      readNativeSessionState()?.readOnly === false
    );
  };


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

  function handleRouteEvent(reason) {
    if (disposed || lastHref === window.location.href) return;
    lastHref = window.location.href;
    sessionFailure = '';
    sessionAccessInFlight = null;
    lastNativeSession = '';
    clearSessionFeatures(reason || 'route-change');
    helper.runtime.scheduleRouteRefresh(reason);
    helper.analytics?.record('session:route-change', { reason, url: window.location.href });
  }

  function handlePopState() { handleRouteEvent('popstate'); }
  function handleHashChange() { handleRouteEvent('hashchange'); }
  function handleNavigation() { handleRouteEvent('navigation'); }
  function handlePageShow() {
    handleRouteEvent('pageshow');
    helper.runtime.scheduleRouteRefresh('pageshow');
  }
  function handleNativeSession() {
    // MAIN owns mount/root observation and publishes a generation even when
    // React replaces the root without changing this surface or the URL.
    if (disposed) return;
    helper.runtime.scheduleRouteRefresh('native-session-change');
  }

  function bindRouteWatchers() {
    if (helper.state.routeWatchBound) return;
    window.navigation?.addEventListener('currententrychange', handleNavigation);
    window.addEventListener('babel-helper:native-route-change', handleNavigation, true);
    window.addEventListener('babel-helper:native-session-change', handleNativeSession, true);
    window.addEventListener('popstate', handlePopState, true);
    window.addEventListener('hashchange', handleHashChange, true);
    window.addEventListener('pageshow', handlePageShow, true);
    helper.state.routeWatchBound = true;
  }

  function unbindRouteWatchers() {
    if (!helper.state.routeWatchBound) return;
    window.navigation?.removeEventListener('currententrychange', handleNavigation);
    window.removeEventListener('babel-helper:native-route-change', handleNavigation, true);
    window.removeEventListener('babel-helper:native-session-change', handleNativeSession, true);
    window.removeEventListener('popstate', handlePopState, true);
    window.removeEventListener('hashchange', handleHashChange, true);
    window.removeEventListener('pageshow', handlePageShow, true);
    helper.state.routeWatchBound = false;
  }

  helper.runtime.disposeLifecycle = function disposeLifecycle(reason) {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('DOMContentLoaded', helper.init, false);
    clearSessionFeatures(reason || 'lifecycle-dispose');
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
    helper.state.nativeSessionAdmission = null;
    helper.state.sessionBindPromise = null;
    helper.state.onLoadedCalled = false;
    helper.state.onLoadedInFlight = false;
    helper.state.onLoadedInFlightRevision = -1;
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

  function failSession(stage, error) {
    if (disposed || sessionFailure) return;
    sessionFailure = getLifecycleErrorMessage(error);
    recordLifecycleError(stage, error);
    console.error('[babel-helper] Session automation stopped:', sessionFailure);
    clearSessionFeatures(stage);
    showNativeAutomationFailure('Session automation', sessionFailure);
  }

  function isCurrentSessionSurface(href, reviewActionId) {
    if (disposed || sessionFailure || href !== window.location.href || !isTranscriptionRoute() || !hasTranscriptSurface()) return false;
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
          lifecycleRevision !== helper.state.sessionLifecycleRevision ||
          !isCurrentSessionSurface(bindHref, reviewActionId)
        ) {
          return;
        }
        if (activated === false) throw new Error('Native session feature activation was refused.');
        helper.state.onLoadedCalled = true;
        helper.state.onLoadedCalledRevision = lifecycleRevision;
      })
      .catch((error) => {
        if (lifecycleRevision !== helper.state.sessionLifecycleRevision) {
          return;
        }
        helper.state.onLoadedCalled = false;
        failSession('on-loaded-error', error);
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
    const bindPromise = (async () => {
      const wasSessionActive = Boolean(helper.state.sessionActive);
      const ready = await helper.runtime.ensureSessionRuntime?.(reason || 'session-ready');
      if (
        lifecycleRevision !== helper.state.sessionLifecycleRevision ||
        !isCurrentSessionSurface(bindHref, reviewActionId)
      ) {
        return false;
      }
      if (ready === false) throw new Error('Native session runtime initialization was refused.');
      // This identity lease is published only after live task/permission validation.
      // Gold's DOM task marker can still describe the previous same-URL task.
      helper.state.nativeSessionAdmission = { href: bindHref, reviewActionId, lifecycleRevision };

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
      helper.perf?.setPhase?.('session-ready', { reason });

      if (!wasSessionActive && helper.analytics) {
        helper.analytics.record('session:start', {
          url: window.location.href
        });
      }
      return { lifecycleRevision };
    })();
    helper.state.sessionBindPromise = bindPromise;

    try {
      return await bindPromise;
    } finally {
      if (helper.state.sessionBindPromise === bindPromise) helper.state.sessionBindPromise = null;
    }
  }

  helper.runtime.scheduleRouteRefresh = function scheduleRouteRefresh(reason) {
    if (disposed || routeRefreshQueued) return;
    routeRefreshQueued = true;
    queueMicrotask(() => {
      routeRefreshQueued = false;
      if (!disposed) helper.runtime.refreshRouteSession(reason || 'native-event');
    });
  };

  helper.runtime.refreshRouteSession = function refreshRouteSession(reason) {
    if (disposed) return false;
    if (!isTranscriptionRoute()) {
      if (helper.state.sessionActive || helper.state.sessionBindPromise || helper.state.onLoadedInFlight) {
        clearSessionFeatures(reason || 'route-exit');
      }
      return false;
    }
    const publication = readSessionPublication();
    const status = hasTranscriptSurface() ? readNativeSessionState() : null;
    const key = status ? `${window.location.href}:${publication?.generation || 0}:${status.reviewActionId}:${status.readOnly}` : '';
    if (key && key !== lastNativeSession) {
      if (lastNativeSession) clearSessionFeatures('native-session-change');
      lastNativeSession = key;
      sessionFailure = '';
    }
    if (publication?.status === 'error') {
      failSession('native-session-hook', new Error(publication.error || 'Native editor commit subscription failed.'));
      return false;
    }
    if (sessionFailure) return false;
    if (!status) {
      if (helper.state.sessionActive || helper.state.sessionBindPromise || helper.state.onLoadedInFlight) {
        clearSessionFeatures(reason || 'native-session-unavailable');
      }
      // MAIN must be injected before the surface mounts; it owns the only mount observer.
      if (!publication || hasTranscriptSurface()) requestNativeSessionAccess();
      return false;
    }
    if (status.readOnly) {
      if (helper.state.sessionActive || helper.state.sessionBindPromise || helper.state.onLoadedInFlight) {
        clearSessionFeatures(reason || 'native-read-only');
      }
      return false;
    }
    if (helper.state.sessionActive || helper.state.sessionBindPromise) return true;
    const bindHref = window.location.href;
    const revision = helper.state.sessionLifecycleRevision;
    void bindSessionFeatures(reason || 'transcript-surface', status.reviewActionId)
      .then(bound => {
        if (bound) runSessionOnLoaded(reason || 'transcript-surface', bindHref, bound.lifecycleRevision, status.reviewActionId);
      })
      .catch(error => {
        if (!disposed && revision === helper.state.sessionLifecycleRevision) failSession('session-bind-error', error);
      });
    return true;
  };

  helper.init = function init() {
    if (disposed || helper.state.runtimeBound) {
      return;
    }

    helper.state.runtimeBound = true;
    bindRouteWatchers();
    bindGlobalListeners();
    void helper.runtime.refreshRouteSession('init');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', helper.init, { once: true });
  } else {
    helper.init();
  }
}


