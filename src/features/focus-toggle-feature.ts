// @ts-nocheck
import type { FeatureModule } from '../core/types';
import type { RowModules } from '../services/row-service';
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';

export function registerFocusToggle(helper: any, api: Pick<RowModules, 'cursor' | 'time' | 'playback'>) {
  let escapePlaybackQueue = Promise.resolve();


  helper.clearActiveFocus = function clearActiveFocus() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return false;
    }

    if (helper.isEditable(active)) {
      active.blur();
    }

    if (document.activeElement === active) {
      document.body.setAttribute('tabindex', '-1');
      document.body.focus({
        preventScroll: true
      });
      document.body.removeAttribute('tabindex');
    }

    return document.activeElement !== active;
  };


  helper.toggleEditorFocus = function toggleEditorFocus() {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.matches(helper.config.rowTextareaSelector)) {
      const row = active.closest('tr');
      if (row) {
        helper.setCurrentRow(row);
      }

      const selStart = active.selectionStart;
      const selEnd = active.selectionEnd;
      const textLen = (active.value || '').length;
      const rowId = row ? (helper.getRowIdentity(row)?.annotationId ?? null) : null;

      helper.state.lastBlur = {
        row: row || helper.getCurrentRow(),
        selectionStart: selStart,
        selectionEnd: selEnd,
        direction: active.selectionDirection || 'none'
      };
      helper.state.blurRestorePending = true;

      // Preserve the current cursor baseline. If the user manually moved
      // the cursor since the last restore, cursorBaseline was already
      // updated by the input/selectionchange listener. If not, use the
      // current selection as a sensible default.
      if (typeof helper.state.cursorBaseline !== 'number') {
        helper.state.cursorBaseline = selStart;
      }

      const cleared = helper.clearActiveFocus();

      if (helper.analytics) {
        helper.analytics.record('focus:blur', {
          rowId,
          cursorPos: selStart,
          selectionLength: selEnd - selStart,
          textLength: textLen,
          cursorBaseline: helper.state.cursorBaseline,
          cursorRatio: textLen > 0 ? Math.round((selStart / textLen) * 100) / 100 : null
        });
      }

      return cleared;
    }

    const remembered = helper.state.lastBlur;
    if (!helper.state.blurRestorePending) {
      return false;
    }

    // Snapshot the visible ghost target before teardown, including a lane
    // selected with Tab rather than the originally blurred row.
    const preservedGhostTarget = api.cursor.getGhostCursorTarget();

    // Tear down the ghost cursor as soon as we begin restoring focus.
    api.cursor.stopGhostCursor();

    const currentRow = helper.getCurrentRow();
    if (!remembered) {
      const focused = preservedGhostTarget
        ? helper.focusRow(preservedGhostTarget.row, {
          activateRow: false,
          selectionStart: preservedGhostTarget.offset,
          selectionEnd: preservedGhostTarget.offset,
          direction: 'none'
        })
        : helper.focusRow(currentRow, { cursor: 'start' });
      if (focused) {
        helper.state.blurRestorePending = false;
        if (helper.analytics) {
          helper.analytics.record('focus:restore-fallback', {
            reason: preservedGhostTarget ? 'ghost-cursor-no-remembered-blur' : 'no-remembered-blur'
          });
        }
      }
      return focused;
    }

    const rememberedRow = remembered.row;
    const rememberedRowStillCurrent =
      rememberedRow &&
      rememberedRow.isConnected &&
      currentRow &&
      currentRow === rememberedRow &&
      (!preservedGhostTarget || preservedGhostTarget.row === rememberedRow);

    if (rememberedRowStillCurrent) {
      let selectionStart = remembered.selectionStart;
      let selectionEnd = remembered.selectionEnd;
      let direction = remembered.direction;
      let usedProportional = false;

      if (preservedGhostTarget && preservedGhostTarget.row === rememberedRow) {
        selectionStart = preservedGhostTarget.offset;
        selectionEnd = preservedGhostTarget.offset;
        direction = 'none';
        usedProportional = true;
      } else if (helper.config.features.proportionalCursorRestore) {
        const blurTime = helper.state.blurPlaybackTime;
        const restoreTime = helper.state.restorePlaybackTime;
        if (
          typeof blurTime === 'number' && Number.isFinite(blurTime) &&
          typeof restoreTime === 'number' && Number.isFinite(restoreTime) &&
          Math.abs(restoreTime - blurTime) >= api.cursor.PROPORTIONAL_MIN_DELTA_SECONDS
        ) {
          const timeRange = api.time.getRowTimeRange(rememberedRow);
          if (timeRange) {
            const textarea = helper.getRowTextarea(rememberedRow);
            const text = textarea instanceof HTMLTextAreaElement ? textarea.value || '' : '';
            if (text.length > 0) {
              const baseline = typeof helper.state.cursorBaseline === 'number'
                ? helper.state.cursorBaseline
                : remembered.selectionStart;
              const result = api.cursor.computeRestoreOffset(text, timeRange, restoreTime, blurTime, baseline);
              if (result) {
                selectionStart = result.offset;
                selectionEnd = result.offset;
                direction = 'none';
                usedProportional = true;

                if (helper.analytics) {
                  helper.analytics.record('cursor:proportional-offset', {
                    blurTime,
                    restoreTime,
                    playbackDelta: Math.round((restoreTime - blurTime) * 1000) / 1000,
                    timeRange,
                    textLength: text.length,
                    baseline,
                    rawOffset: result.offset,
                    clamped: result.clamped,
                    rememberedPos: remembered.selectionStart
                  });
                }
              }
            }
          }
        }
      }

      helper.state.blurPlaybackTime = null;
      helper.state.restorePlaybackTime = null;

      // Update baseline to the restored position so the next Esc cycle
      // uses it as the floor. The user can further advance it by editing.
      helper.state.cursorBaseline = selectionStart;

      const focused = helper.focusRow(rememberedRow, {
        activateRow: false,
        selectionStart: selectionStart,
        selectionEnd: selectionEnd,
        direction: direction
      });
      if (focused) {
        helper.state.blurRestorePending = false;

        if (helper.analytics) {
          const rowId = helper.getRowIdentity(rememberedRow)?.annotationId ?? null;
          const eventType = usedProportional ? 'focus:restore-proportional' : 'focus:restore';
          helper.analytics.record(eventType, {
            rowId,
            cursorPos: selectionStart,
            proportional: usedProportional,
            sameRow: true,
            cursorBaseline: helper.state.cursorBaseline
          });
          helper.analytics.endEscCycle({
            playbackTime: helper.state.restorePlaybackTime,
            cursorPos: selectionStart,
            proportional: usedProportional,
            rowId
          });
        }
      }
      return focused;
    }

    if (preservedGhostTarget) {
      helper.state.blurPlaybackTime = null;
      helper.state.restorePlaybackTime = null;
      helper.state.blurRestorePending = false;
      helper.state.cursorBaseline = preservedGhostTarget.offset;

      const focused = helper.focusRow(preservedGhostTarget.row, {
        activateRow: false,
        selectionStart: preservedGhostTarget.offset,
        selectionEnd: preservedGhostTarget.offset,
        direction: 'none'
      });
      if (focused && helper.analytics) {
        const rowId = helper.getRowIdentity(preservedGhostTarget.row)?.annotationId ?? null;
        helper.analytics.record('focus:restore-fallback', {
          rowId,
          reason: 'ghost-cursor-target',
          cursorPos: preservedGhostTarget.offset,
          rememberedRowConnected: rememberedRow?.isConnected ?? false,
          currentRowConnected: currentRow?.isConnected ?? false
        });
        helper.analytics.endEscCycle({
          cursorPos: preservedGhostTarget.offset,
          proportional: true,
          rowId
        });
      }
      return focused;
    }

    const fallbackRow =
      (currentRow && currentRow.isConnected && currentRow) ||
      (rememberedRow && rememberedRow.isConnected && rememberedRow) ||
      helper.getTranscriptRows()[0] ||
      null;
    if (!fallbackRow) {
      if (helper.analytics) {
        helper.analytics.record('focus:restore-failed', { reason: 'no-fallback-row' });
      }
      return false;
    }

    const focused = helper.focusRow(fallbackRow, {
      activateRow: false,
      cursor: 'start'
    });
    if (focused) {
      helper.state.blurRestorePending = false;
      if (helper.analytics) {
        const rowId = helper.getRowIdentity(fallbackRow)?.annotationId ?? null;
        helper.analytics.record('focus:restore-fallback', {
          rowId,
          reason: 'row-mismatch',
          rememberedRowConnected: rememberedRow?.isConnected ?? false,
          currentRowConnected: currentRow?.isConnected ?? false
        });
        helper.analytics.endEscCycle({
          cursorPos: 0,
          proportional: false,
          rowId
        });
      }
    }
    return focused;
  };


  function queueEscapePlaybackTask(task) {
    const scheduled = escapePlaybackQueue.catch(() => { }).then(task);
    escapePlaybackQueue = scheduled.catch(() => { });
    return scheduled;
  }


  helper.syncCurrentRowToPlayback = async function syncCurrentRowToPlayback() {
    if (
      helper.runtime &&
      typeof helper.runtime.isSessionInteractive === 'function' &&
      !helper.runtime.isSessionInteractive()
    ) {
      api.time.rememberPlaybackRow(null);
      return null;
    }

    const playback =
      typeof helper.getPlaybackState === 'function'
        ? await helper.getPlaybackState()
        : api.playback.unavailablePlaybackState();
    if (!playback || !playback.ok) {
      return api.time.getLastPlaybackRow();
    }

    const playbackRow =
      typeof playback.currentTime === 'number' ? api.time.findRowByPlaybackTime(playback.currentTime) : null;
    const preferredRow = playbackRow || api.time.getLastPlaybackRow();

    if (playbackRow) {
      api.time.rememberPlaybackRow(playbackRow);
    }

    if (playback.paused === false && preferredRow && !helper.state.ghostCursorElement) {
      api.cursor.startGhostCursor(preferredRow);
    } else if (playback.paused !== false) {
      api.cursor.stopGhostCursor();
    }

    if (!(helper.getActiveRowTextarea() instanceof HTMLTextAreaElement) && preferredRow) {
      helper.setCurrentRow(preferredRow);
    }

    return {
      row: preferredRow,
      playback
    };
  };


  function focusCurrentEditorForEscape() {
    if (helper.state.blurRestorePending && helper.toggleEditorFocus()) {
      return true;
    }

    const ghostTarget = api.cursor.getGhostCursorTarget();
    // toggleEditorFocus either was not called (blurRestorePending was false)
    // or failed before reaching its own stopGhostCursor. Tear down the ghost
    // now so the interval / DOM element are cleaned up in every code path.
    api.cursor.stopGhostCursor();

    if (ghostTarget) {
      helper.state.blurPlaybackTime = null;
      helper.state.restorePlaybackTime = null;
      helper.state.blurRestorePending = false;
      helper.state.cursorBaseline = ghostTarget.offset;

      if (helper.analytics) {
        const rowId = helper.getRowIdentity(ghostTarget.row)?.annotationId ?? null;
        helper.analytics.record('focus:restore-fallback', {
          reason: 'ghost-cursor-escape',
          rowId,
          cursorPos: ghostTarget.offset
        });
        helper.analytics.endEscCycle({
          cursorPos: ghostTarget.offset,
          proportional: true,
          rowId
        });
      }

      return helper.focusRow(ghostTarget.row, {
        activateRow: false,
        selectionStart: ghostTarget.offset,
        selectionEnd: ghostTarget.offset,
        direction: 'none'
      });
    }

    // toggleEditorFocus may have failed because the remembered row reference
    // went stale (e.g. Babel re-rendered rows while audio was playing).
    // Try to find the correct row by playback time and focus it with a
    // proportional cursor offset.
    const restoreTime = helper.state.restorePlaybackTime;
    if (typeof restoreTime === 'number' && Number.isFinite(restoreTime)) {
      const timeRow = api.time.findRowByPlaybackTime(restoreTime);
      if (timeRow instanceof HTMLElement) {
        const timeRange = api.time.getRowTimeRange(timeRow);
        const textarea = helper.getRowTextarea(timeRow);
        if (timeRange && textarea instanceof HTMLTextAreaElement) {
          const text = textarea.value || '';
          if (text.length > 0 && helper.config.features.proportionalCursorRestore) {
            const blurTime = helper.state.blurPlaybackTime;
            const baseline = typeof helper.state.cursorBaseline === 'number'
              ? helper.state.cursorBaseline : 0;
            const result = api.cursor.computeRestoreOffset(text, timeRange, restoreTime, blurTime, baseline);

            helper.state.blurPlaybackTime = null;
            helper.state.restorePlaybackTime = null;
            helper.state.blurRestorePending = false;

            if (result) {
              helper.state.cursorBaseline = result.offset;

              if (helper.analytics) {
                const rowId = helper.getRowIdentity(timeRow)?.annotationId ?? null;
                helper.analytics.record('focus:restore-fallback', {
                  reason: 'time-lookup-proportional',
                  rowId,
                  cursorPos: result.offset,
                  playbackTime: restoreTime,
                  clamped: result.clamped
                });
                helper.analytics.endEscCycle({
                  playbackTime: restoreTime,
                  cursorPos: result.offset,
                  proportional: true,
                  rowId
                });
              }

              return helper.focusRow(timeRow, {
                activateRow: false,
                selectionStart: result.offset,
                selectionEnd: result.offset,
                direction: 'none'
              });
            }
          }
        }

        // Fall back to start of the time-matched row
        helper.state.blurPlaybackTime = null;
        helper.state.restorePlaybackTime = null;
        helper.state.blurRestorePending = false;

        if (helper.analytics) {
          const rowId = helper.getRowIdentity(timeRow)?.annotationId ?? null;
          helper.analytics.record('focus:restore-fallback', {
            reason: 'time-lookup-start',
            rowId,
            playbackTime: restoreTime
          });
          helper.analytics.endEscCycle({
            playbackTime: restoreTime,
            cursorPos: 0,
            proportional: false,
            rowId
          });
        }

        return helper.focusRow(timeRow, {
          activateRow: false,
          cursor: 'start'
        });
      }
    }

    const currentRow = helper.getCurrentRow();
    if (!(currentRow instanceof HTMLElement)) {
      if (helper.analytics) {
        helper.analytics.record('focus:restore-failed', { reason: 'no-current-row-for-escape' });
      }
      return false;
    }

    if (helper.analytics) {
      const rowId = helper.getRowIdentity(currentRow)?.annotationId ?? null;
      helper.analytics.record('focus:restore-fallback', {
        reason: 'current-row-fallback',
        rowId
      });
      helper.analytics.endEscCycle({
        cursorPos: 0,
        proportional: false,
        rowId
      });
    }

    return helper.focusRow(currentRow, {
      activateRow: false,
      cursor: 'start'
    });
  }


  helper.handleEscapeWorkflow = function handleEscapeWorkflow() {
    const focused = helper.getActiveRowTextarea() instanceof HTMLTextAreaElement;

    if (helper.analytics) {
      helper.analytics.record('hotkey:escape', {
        focused,
        blurRestorePending: helper.state.blurRestorePending,
        hasLastBlur: Boolean(helper.state.lastBlur),
        cursorBaseline: helper.state.cursorBaseline
      });
    }

    void queueEscapePlaybackTask(async () => {
      const playback = await helper.getPlaybackState();
      const isPlaying = Boolean(playback && playback.ok && playback.paused === false);
      const currentTime = playback && typeof playback.currentTime === 'number' ? playback.currentTime : null;

      if (helper.analytics) {
        helper.analytics.record('esc:playback-query', {
          ok: playback?.ok,
          paused: playback?.paused,
          currentTime,
          source: playback?.source
        });
      }

      if (focused && isPlaying) {
        // State 1: focused + playing -> pause only
        if (helper.analytics) {
          helper.analytics.record('esc:state1:focused-playing', {
            playbackTime: currentTime
          });
        }
        await helper.setPlaybackPaused(true);
        if (helper.analytics) {
          helper.analytics.record('playback:pause', { via: 'esc-state1', playbackTime: currentTime });
        }
        return;
      }

      if (!focused && isPlaying) {
        // State 2: unfocused + playing -> restore focus + pause
        // NOTE: do NOT call stopGhostCursor() here. The restore path
        // inside toggleEditorFocus (called via focusCurrentEditorForEscape)
        // snapshots the ghost target *before* tearing it down (line 2065-2068).
        // Stopping the ghost prematurely nulls ghostCursorOffset so
        // getGhostCursorTarget() returns null, causing the restore to fall
        // through to cursor:'start' (position 0) instead of the live ghost
        // position.
        helper.state.restorePlaybackTime =
          playback && typeof playback.currentTime === 'number' ? playback.currentTime : null;

        if (helper.analytics) {
          const rowId = helper.state.lastBlur?.row
            ? (helper.getRowIdentity(helper.state.lastBlur.row)?.annotationId ?? null)
            : null;
          helper.analytics.record('esc:state2:unfocused-playing', {
            playbackTime: currentTime,
            blurPlaybackTime: helper.state.blurPlaybackTime,
            playbackDelta: currentTime != null && helper.state.blurPlaybackTime != null
              ? Math.round((currentTime - helper.state.blurPlaybackTime) * 1000) / 1000
              : null,
            rowId,
            blurRestorePending: helper.state.blurRestorePending
          });
        }

        focusCurrentEditorForEscape();
        await helper.setPlaybackPaused(true);
        if (helper.analytics) {
          helper.analytics.record('playback:pause', { via: 'esc-state2', playbackTime: currentTime });
        }
        return;
      }

      if (focused && !isPlaying) {
        // State 3: focused + not playing -> blur + play
        const activeTextarea = helper.getActiveRowTextarea();
        const cursorPos = activeTextarea ? activeTextarea.selectionStart : null;
        const textLen = activeTextarea ? (activeTextarea.value || '').length : null;
        const row = activeTextarea ? activeTextarea.closest('tr') : null;
        const rowId = row ? (helper.getRowIdentity(row)?.annotationId ?? null) : null;

        helper.toggleEditorFocus();
        helper.state.blurPlaybackTime =
          playback && typeof playback.currentTime === 'number' ? playback.currentTime : null;

        if (helper.analytics) {
          helper.analytics.record('esc:state3:focused-notplaying', {
            playbackTime: currentTime,
            cursorPos,
            textLength: textLen,
            rowId,
            cursorBaseline: helper.state.cursorBaseline
          });
          helper.analytics.startEscCycle(3, {
            playbackTime: currentTime,
            rowId,
            cursorPos,
            textLength: textLen
          });
        }

        await helper.setPlaybackPaused(false);
        if (helper.analytics) {
          helper.analytics.record('playback:resume', { via: 'esc-state3', playbackTime: currentTime });
        }

        // Start the ghost cursor on the just-blurred row so the user sees
        // a live preview of where the cursor would land.
        const blurredRow = helper.state.lastBlur && helper.state.lastBlur.row;
        if (blurredRow) {
          api.cursor.startGhostCursor(blurredRow);
        }
        return;
      }

      // State 4: !focused && !isPlaying — bootstrap a synthetic blur so the
      // next Esc press (State 2) can restore focus with proportional cursor.

      // Find the row matching current playback position, falling back to
      // Babel-active row or the DOM/React-state active row.
      const bootstrapRow =
        (typeof currentTime === 'number' && api.time.findRowByPlaybackTime(currentTime)) ||
        helper.findActiveRowByDomState() ||
        helper.findActiveRowByReactState() ||
        helper.getCurrentRow();

      const bootstrapRowId = bootstrapRow ? (helper.getRowIdentity(bootstrapRow)?.annotationId ?? null) : null;

      if (helper.analytics) {
        helper.analytics.record('esc:state4:unfocused-notplaying', {
          playbackTime: currentTime,
          bootstrapRowId,
          hasBootstrapRow: Boolean(bootstrapRow)
        });
        helper.analytics.startEscCycle(4, {
          playbackTime: currentTime,
          rowId: bootstrapRowId,
          cursorPos: 0,
          textLength: bootstrapRow ? (helper.getRowTextValue(bootstrapRow) || '').length : null
        });
      }

      if (bootstrapRow) {
        helper.state.lastBlur = {
          row: bootstrapRow,
          selectionStart: 0,
          selectionEnd: 0,
          direction: 'none',
          synthetic: true
        };
        helper.state.blurRestorePending = true;
        helper.state.cursorBaseline = 0;
        helper.state.blurPlaybackTime =
          typeof currentTime === 'number' ? currentTime : null;
        helper.setCurrentRow(bootstrapRow);
      }

      await helper.setPlaybackPaused(false);
      if (helper.analytics) {
        helper.analytics.record('playback:resume', { via: 'esc-state4', playbackTime: currentTime });
      }

      // Start the ghost cursor so the user sees a live preview of where
      // the cursor would land if they press Esc.
      if (bootstrapRow && helper.config.features.proportionalCursorRestore) {
        api.cursor.startGhostCursor(bootstrapRow);
      }
    });
    return true;
  };

  return {};
}

export function createFocusToggleFeature(): FeatureModule {
  return {
    id: 'focus-toggle'
  };
}

export function registerFocusInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;

  hooks.on('keydown', (event) => {
    if (isFeatureEnabled('focusToggle') && event.key === 'Escape') {
      if (typeof helper.handleEscapeWorkflow === 'function' && helper.handleEscapeWorkflow()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return true;
    }
  }, 50);
}
