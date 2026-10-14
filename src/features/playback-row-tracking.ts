// @ts-nocheck
import { BABEL_TRANSCRIPT_ROW_SELECTOR } from '../core/babel-editor-contract';
import { getEditorControlFromTarget } from '../site/editor-control';

export function registerPlaybackRowTracking(helper: any) {
  const isFeatureEnabled = (key) => helper.isFeatureEnabled?.(key) ?? true;
  let trackingGeneration = 0;
  function handleRowFocusIn(event) {
    if (!helper.runtime.isSessionInteractive()) {
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const row = target.closest(BABEL_TRANSCRIPT_ROW_SELECTOR);
    if (row && row.querySelector(helper.config.rowEditorSelector)) {
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
          isEditor: Boolean(getEditorControlFromTarget(target))
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

    const row = target.closest(BABEL_TRANSCRIPT_ROW_SELECTOR);
    if (row && row.querySelector(helper.config.rowEditorSelector)) {
      const active = document.activeElement;
      if (event.button === 0 && active instanceof HTMLElement && active.isConnected &&
          active.matches('[data-slate-editor="true"]') &&
          active.closest(BABEL_TRANSCRIPT_ROW_SELECTOR) !== row) {
        // Native onMouseDown activates the next turn before the browser's
        // default blur. Flush the still-mounted Slate editor first.
        active.blur();
      }
      helper.setCurrentRow(row);
    }
  }

  /**
   * Update the cursor baseline when the user manually interacts with a
   * transcript editor. Covers typing (input), arrow keys / click
   * selection changes (keyup + pointerup) so that the proportional restore
   * system never drags the cursor backward past a position the user
   * intentionally placed it at.
   */
  function handleCursorBaselineUpdate(event) {
    const target = getEditorControlFromTarget(event.target);
    if (!target) return;

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
      event.shiftKey ||
      event.button !== 0
    ) {
      return;
    }
    const editor = getEditorControlFromTarget(event.target);
    if (!editor) return;
    // Native36978 seeks on mousedown (static text) and mouseup (Slate).
    // Own the complete gesture before either approximate native seek can run.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click') return;
    const row = editor.row;
    const offset = editor.getOffsetAtPoint(event.clientX, event.clientY);
    if (
      !(row instanceof HTMLElement) ||
      typeof offset !== 'number' ||
      typeof helper.getL0TimestampForRowOffset !== 'function'
    ) {
      return;
    }
    const revision = helper.state.sessionLifecycleRevision;
    // Slate's pointer handlers still own the mounted editor for this event.
    // Activate/select only after the whole gesture has finished dispatching.
    queueMicrotask(() => {
      if (!editor.isConnected || !editor.state ||
          revision !== helper.state.sessionLifecycleRevision ||
          !helper.runtime.isSessionInteractive() || !isFeatureEnabled('rowActions')) return;
      let targetSeconds = helper.getL0TimestampForRowOffset(row, offset);
      if (!Number.isFinite(targetSeconds)) return;
      if (helper.getActiveRowEditor()?.row === row) {
        if (!editor.setSelectionRange(offset, offset)) return;
      } else if (!helper.focusRow(row, { selectionStart: offset, selectionEnd: offset, scroll: false })) {
        return;
      }
      helper.setCurrentRow(row);
      void helper.getPlaybackState()
        .then((playback) => {
          if (
            !editor.isConnected || !editor.state ||
            revision !== helper.state.sessionLifecycleRevision ||
            !helper.runtime.isSessionInteractive() || !isFeatureEnabled('rowActions') ||
            !playback ||
            !Number.isFinite(playback.currentTime) ||
            typeof helper.seekPlaybackBySeconds !== 'function'
          ) {
            return false;
          }
          targetSeconds = helper.getL0TimestampForRowOffset(row, offset);
          if (!Number.isFinite(targetSeconds)) return false;
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
        });
    });
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
    const generation = trackingGeneration;
    helper.state.playbackRowSyncTimer = window.setTimeout(() => {
      helper.state.playbackRowSyncTimer = null;
      if (generation !== trackingGeneration || !helper.state.rowTrackingBound) return;
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
          if (generation !== trackingGeneration) return;
          nextDelay = getPlaybackSyncDelay(result);
        })
        .finally(() => {
          if (generation !== trackingGeneration) return;
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
    document.addEventListener('mousedown', handleTimestampWordSeekClick, true);
    document.addEventListener('mouseup', handleTimestampWordSeekClick, true);
    document.addEventListener('click', handleTimestampWordSeekClick, true);
    helper.state.rowTrackingBound = true;
    trackingGeneration += 1;
    schedulePlaybackRowSync();
    helper.perf?.count?.('row-tracking.bound');
  };

  helper.unbindRowTracking = function unbindRowTracking() {
    trackingGeneration += 1;
    helper.stopGhostCursor?.();
    helper.state.ghostCursorLaneLock = null;
    helper.cancelSpeakerWorkflow?.();
    helper.invalidateRowTimeCache?.();
    helper.state.lastBlur = null;
    helper.state.blurRestorePending = false;
    helper.state.blurPlaybackTime = null;
    helper.state.restorePlaybackTime = null;
    helper.state.cursorBaseline = null;
    if (!helper.state.rowTrackingBound) {
      return;
    }

    document.removeEventListener('focusin', handleRowFocusIn, true);
    document.removeEventListener('pointerdown', handleRowPointerDown, true);
    document.removeEventListener('input', handleCursorBaselineUpdate, true);
    document.removeEventListener('keyup', handleCursorBaselineUpdate, true);
    document.removeEventListener('pointerup', handleCursorBaselineUpdate, true);
    document.removeEventListener('mousedown', handleTimestampWordSeekClick, true);
    document.removeEventListener('mouseup', handleTimestampWordSeekClick, true);
    document.removeEventListener('click', handleTimestampWordSeekClick, true);
    clearPlaybackRowSyncTimer();
    helper.state.playbackRowSyncInFlight = false;
    helper.state.lastPlaybackRow = null;
    helper.state.lastPlaybackRowIdentity = null;
    helper.state.rowTrackingBound = false;
  };

}
