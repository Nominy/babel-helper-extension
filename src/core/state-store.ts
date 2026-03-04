export function createState() {
  return {
    currentRow: null,
    currentRowIdentity: null,
    lastBlur: null,
    blurRestorePending: false,
    runtimeBound: false,
    routeWatchBound: false,
    routeRefreshTimer: 0,
    routeRefreshAttempts: 0,
    routeRefreshWindowStartedAt: 0,
    hotkeysEnhanceFrame: 0,
    hotkeysObserver: null,
    routeRecoveryObserver: null,
    keydownBound: false,
    sessionActive: false,
    rowTrackingBound: false,
    cutListenersBound: false,
    magnifierListenersBound: false,
    cutDraft: null,
    cutPreview: null,
    cutCommitPending: false,
    cutLastContainer: null,
    smartSplitClickDraft: null,
    smartSplitClickContext: null,
    selectionLoop: null,
    magnifier: null,
    magnifierDrag: null,
    speakerSwitchPending: false
  };
}

