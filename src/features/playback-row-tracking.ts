// @ts-nocheck

export function registerPlaybackRowTracking(helper: any) {
  const isFeatureEnabled = (key) => helper.isFeatureEnabled?.(key) ?? true;
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

  function handleTimestampWordSeekClick(event) {
    if (
      !helper.runtime.isSessionInteractive() ||
      !isFeatureEnabled('rowActions') ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    const textarea = event.target;
    if (
      !(textarea instanceof HTMLTextAreaElement) ||
      !textarea.matches(helper.config.rowTextareaSelector)
    ) {
      return;
    }
    const row = textarea.closest('tr');
    const offset = textarea.selectionStart;
    if (
      !(row instanceof HTMLTableRowElement) ||
      typeof offset !== 'number' ||
      typeof helper.getL0TimestampForRowOffset !== 'function'
    ) {
      return;
    }
    const targetSeconds = helper.getL0TimestampForRowOffset(row, offset);
    if (!Number.isFinite(targetSeconds)) {
      return;
    }
    helper.setCurrentRow(row);
    void helper.getPlaybackState()
      .then((playback) => {
        if (
          !playback ||
          !Number.isFinite(playback.currentTime) ||
          typeof helper.seekPlaybackBySeconds !== 'function'
        ) {
          return false;
        }
        return helper.seekPlaybackBySeconds(targetSeconds - playback.currentTime);
      })
      .then((seekResult) => {
        if (seekResult !== false && helper.analytics) {
          helper.analytics.record('playback:seek', {
            source: 'timestamp-word-alt-click',
            targetSeconds,
            rowId: helper.getRowIdentity(row)?.annotationId ?? null,
            characterOffset: offset
          });
        }
      })
      .catch(() => undefined);
  }

  function clearPlaybackRowSyncTimer() {
    if (helper.state.playbackRowSyncTimer != null) {
      window.clearTimeout(helper.state.playbackRowSyncTimer);
      helper.state.playbackRowSyncTimer = null;
    }
  }

  function getPlaybackSyncDelay(result) {
    if (!helper.runtime.isSessionInteractive() || document.hidden) {
      return 2000;
    }
    if (result && result.playback && result.playback.paused === false) {
      return 250;
    }
    return 1250;
  }

  function schedulePlaybackRowSync(delay = 0) {
    if (
      !helper.state.rowTrackingBound ||
      helper.state.playbackRowSyncInFlight ||
      typeof helper.syncCurrentRowToPlayback !== 'function'
    ) {
      return;
    }

    clearPlaybackRowSyncTimer();
    helper.state.playbackRowSyncTimer = window.setTimeout(() => {
      helper.state.playbackRowSyncTimer = null;
      if (
        helper.state.playbackRowSyncInFlight ||
        typeof helper.syncCurrentRowToPlayback !== 'function'
      ) {
        return;
      }

      helper.state.playbackRowSyncInFlight = true;
      helper.perf?.count?.('playback.sync.tick');
      let nextDelay = 1250;
      void helper.syncCurrentRowToPlayback()
        .then((result) => {
          nextDelay = getPlaybackSyncDelay(result);
        })
        .finally(() => {
          helper.state.playbackRowSyncInFlight = false;
          schedulePlaybackRowSync(nextDelay);
        });
    }, delay);
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
    document.addEventListener('click', handleTimestampWordSeekClick, true);
    helper.state.rowTrackingBound = true;
    schedulePlaybackRowSync();
    helper.perf?.count?.('row-tracking.bound');
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
    document.removeEventListener('click', handleTimestampWordSeekClick, true);
    clearPlaybackRowSyncTimer();
    helper.state.playbackRowSyncInFlight = false;
    helper.state.lastPlaybackRow = null;
    helper.state.lastPlaybackRowIdentity = null;
    helper.state.rowTrackingBound = false;
  };

}
