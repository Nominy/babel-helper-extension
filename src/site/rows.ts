// @ts-nocheck
import { BABEL_TRANSCRIPT_ROW_SELECTOR, isBabelActiveRowClassList } from '../core/babel-editor-contract';
import { getEditorControl, getEditorControlFromTarget, readTurnState, readTurnIdentity } from './editor-control';
import type { RowModules } from '../services/row-service';

export function createRowSiteApi(helper: any, api: Pick<RowModules, 'time'>) {

  helper.getTranscriptRows = function getTranscriptRows() {
    helper.perf?.count?.('row.scan');
    return Array.from(document.querySelectorAll(BABEL_TRANSCRIPT_ROW_SELECTOR));
  };


  helper.getRowEditor = getEditorControl;


  helper.getRowTextValue = function getRowTextValue(row) {
    return row instanceof HTMLElement ? readTurnState(row)?.text ?? '' : '';
  };


  helper.getActiveRowEditor = function getActiveRowEditor() {
    return getEditorControlFromTarget(document.activeElement);
  };




  helper.getRowIdentity = function getRowIdentity(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const annotationId = row.dataset.annotationId;
    if (!annotationId) return null;
    const snapshot = readTurnIdentity(row);
    if (!snapshot) return null;
    const speaker = row.querySelector('select[id^="speaker-"]');
    const processedRecordingId = snapshot?.processedRecordingId || speaker?.value || null;
    const formatTime = (seconds) => Number.isFinite(seconds)
      ? `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}`
      : '';
    return {
      annotationId,
      reviewActionId: snapshot?.reviewActionId || '',
      processedRecordingId,
      trackLabel: snapshot?.trackLabel || snapshot?.speakerLabel || speaker?.selectedOptions?.[0]?.textContent?.trim() || '',
      speakerKey: processedRecordingId || snapshot?.speakerKey || '',
      isActive: snapshot.isActive ?? isBabelActiveRowClassList(row.classList),
      startSeconds: snapshot?.startSeconds ?? null,
      endSeconds: snapshot?.endSeconds ?? null,
      startText: snapshot?.startText || formatTime(snapshot?.startSeconds),
      endText: snapshot?.endText || formatTime(snapshot?.endSeconds)
    };
  };


  helper.getRowSpeakerKey = function getRowSpeakerKey(row) {
    const identity = helper.getRowIdentity(row);
    return identity && typeof identity.speakerKey === 'string' ? identity.speakerKey : '';
  };


  helper.rowsShareSpeaker = function rowsShareSpeaker(leftRow, rightRow) {
    const leftKey = helper.getRowSpeakerKey(leftRow);
    const rightKey = helper.getRowSpeakerKey(rightRow);
    return Boolean(leftKey && rightKey && leftKey === rightKey);
  };


  helper.findAdjacentRowBySpeaker = function findAdjacentRowBySpeaker(row, offset) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const rows = helper.getTranscriptRows();
    const currentIndex = rows.indexOf(row);
    if (currentIndex < 0 || !offset) {
      return null;
    }

    const direction = offset < 0 ? -1 : 1;
    const speakerKey = helper.getRowSpeakerKey(row);
    if (!speakerKey) {
      return null;
    }

    for (
      let index = currentIndex + direction;
      index >= 0 && index < rows.length;
      index += direction
    ) {
      const candidate = rows[index];
      if (!(candidate instanceof HTMLElement)) {
        continue;
      }

      if (helper.getRowSpeakerKey(candidate) === speakerKey) {
        return candidate;
      }
    }

    return null;
  };


  helper.findActiveRowByReactState = function findActiveRowByReactState() {
    const rows = helper.getTranscriptRows();
    return (
      rows.find((row) => {
        const identity = helper.getRowIdentity(row);
        return Boolean(identity && identity.isActive);
      }) || null
    );
  };


  helper.findActiveRowByDomState = function findActiveRowByDomState() {
    const rows = helper.getTranscriptRows();
    return (
      rows.find((row) => {
        if (!(row instanceof HTMLElement)) {
          return false;
        }

        return isBabelActiveRowClassList(row.classList);
      }) || null
    );
  };


  function getActiveRowFromEditorSnapshot() {
    if (typeof helper.findRowFromEditorSnapshot !== 'function') {
      return null;
    }

    const snapshot = typeof helper.getEditorSnapshot === 'function'
      ? helper.getEditorSnapshot()
      : null;
    if (!snapshot || typeof snapshot !== 'object') {
      return null;
    }

    if (typeof snapshot.activeRowId === 'string' && snapshot.activeRowId) {
      const activeRow = helper.findRowFromEditorSnapshot(snapshot.activeRowId);
      if (activeRow instanceof HTMLElement) {
        return activeRow;
      }
    }

    const activeSnapshot = Array.isArray(snapshot.rows)
      ? snapshot.rows.find((row) => row && row.isActive)
      : null;
    if (activeSnapshot) {
      const activeRow = helper.findRowFromEditorSnapshot(activeSnapshot);
      if (activeRow instanceof HTMLElement) {
        return activeRow;
      }
    }

    return null;
  }


  helper.rowMatchesIdentity = function rowMatchesIdentity(row, identity) {
    if (!(row instanceof HTMLElement) || !identity || typeof identity !== 'object') {
      return false;
    }

    const rowIdentity = helper.getRowIdentity(row);
    if (!rowIdentity || (identity.reviewActionId && identity.reviewActionId !== rowIdentity.reviewActionId)) {
      return false;
    }

    if (
      identity.annotationId &&
      rowIdentity.annotationId &&
      identity.annotationId === rowIdentity.annotationId
    ) {
      return true;
    }

    return Boolean(
      identity.speakerKey &&
      rowIdentity.speakerKey &&
      identity.speakerKey === rowIdentity.speakerKey &&
      (
        (
          identity.startText &&
          identity.endText &&
          identity.startText === rowIdentity.startText &&
          identity.endText === rowIdentity.endText
        ) ||
        (
          !identity.startText &&
          !identity.endText
        )
      )
    );
  };


  helper.findRowByIdentity = function findRowByIdentity(identity) {
    if (!identity || typeof identity !== 'object') {
      return null;
    }

    const rows = helper.getTranscriptRows();
    if (identity.annotationId) {
      const byAnnotation = rows.find((row) => {
        const rowIdentity = helper.getRowIdentity(row);
        return rowIdentity && rowIdentity.annotationId === identity.annotationId &&
          (!identity.reviewActionId || identity.reviewActionId === rowIdentity.reviewActionId);
      });
      if (byAnnotation) {
        return byAnnotation;
      }
    }

    if (identity.startText && identity.endText) {
      return (
        rows.find((row) => {
          const rowIdentity = helper.getRowIdentity(row);
          return (
            rowIdentity &&
            (!identity.reviewActionId || identity.reviewActionId === rowIdentity.reviewActionId) &&
            (
              !identity.speakerKey ||
              !rowIdentity.speakerKey ||
              rowIdentity.speakerKey === identity.speakerKey
            ) &&
            rowIdentity.startText === identity.startText &&
            rowIdentity.endText === identity.endText
          );
        }) || null
      );
    }

    return null;
  };


  helper.getCurrentRow = function getCurrentRow(options) {
    const settings = options || {};
    const allowFallback = settings.allowFallback !== false;

    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const activeRow = active.closest(BABEL_TRANSCRIPT_ROW_SELECTOR);
      if (activeRow) {
        helper.setCurrentRow(activeRow);
        return activeRow;
      }
    }

    const snapshotRow = getActiveRowFromEditorSnapshot();
    if (snapshotRow) {
      helper.setCurrentRow(snapshotRow);
      return snapshotRow;
    }

    const playbackRow = api.time.getLastPlaybackRow();
    if (playbackRow) {
      helper.setCurrentRow(playbackRow);
      return playbackRow;
    }

    const activeRowByDom = helper.findActiveRowByDomState();
    if (activeRowByDom) {
      helper.setCurrentRow(activeRowByDom);
      return activeRowByDom;
    }

    const activeRowByState = helper.findActiveRowByReactState();
    if (activeRowByState) {
      helper.setCurrentRow(activeRowByState);
      return activeRowByState;
    }

    const cachedRow = helper.state.currentRow;
    const cachedIdentity =
      helper.state.currentRowIdentity ||
      (cachedRow instanceof HTMLElement ? helper.getRowIdentity(cachedRow) : null);

    if (cachedRow instanceof HTMLElement && cachedRow.isConnected) {
      if (!cachedIdentity || helper.rowMatchesIdentity(cachedRow, cachedIdentity)) {
        return cachedRow;
      }
    }

    if (cachedIdentity) {
      const resolved = helper.findRowByIdentity(cachedIdentity);
      if (resolved) {
        helper.state.currentRow = resolved;
        helper.state.currentRowIdentity = helper.getRowIdentity(resolved);
        return resolved;
      }
    }

    if (!allowFallback) {
      return null;
    }

    const rows = helper.getTranscriptRows();
    return rows[0] || null;
  };


  helper.getCurrentActionRow = function getCurrentActionRow(options) {
    const settings = options || {};
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const activeRow = active.closest(BABEL_TRANSCRIPT_ROW_SELECTOR);
      if (activeRow) {
        helper.setCurrentRow(activeRow);
        return activeRow;
      }
    }

    if (typeof helper.resolveTimelineSegmentTargetRow === 'function') {
      const timelineRow = helper.resolveTimelineSegmentTargetRow();
      if (timelineRow instanceof HTMLElement) {
        helper.setCurrentRow(timelineRow);
        return timelineRow;
      }
    }

    const snapshotRow = getActiveRowFromEditorSnapshot();
    if (snapshotRow) {
      helper.setCurrentRow(snapshotRow);
      return snapshotRow;
    }

    const playbackRow = api.time.getLastPlaybackRow();
    if (playbackRow) {
      helper.setCurrentRow(playbackRow);
      return playbackRow;
    }

    const cachedRow = helper.state.currentRow;
    const cachedIdentity =
      helper.state.currentRowIdentity ||
      (cachedRow instanceof HTMLElement ? helper.getRowIdentity(cachedRow) : null);
    const resolvedCached = api.time.resolveConnectedRow(cachedRow, cachedIdentity);
    if (resolvedCached) {
      helper.setCurrentRow(resolvedCached);
      return resolvedCached;
    }

    if (settings.allowFallback === true) {
      return helper.getCurrentRow({ allowFallback: true });
    }

    return null;
  };


  helper.getCurrentRowIndex = function getCurrentRowIndex() {
    const rows = helper.getTranscriptRows();
    const currentRow = helper.getCurrentRow();
    return currentRow ? rows.indexOf(currentRow) : -1;
  };


  helper.setCurrentRow = function setCurrentRow(row) {
    if (row && row.isConnected) {
      helper.state.currentRow = row;
      helper.state.currentRowIdentity = helper.getRowIdentity(row);
    } else {
      helper.state.currentRow = null;
      helper.state.currentRowIdentity = null;
    }
  };


  helper.focusRow = function focusRow(row, options) {
    if (!row) {
      return false;
    }

    const editor = helper.getRowEditor(row);
    if (!editor || editor.readOnly) {
      return false;
    }

    helper.setCurrentRow(row);
    if (!editor.focus({ preventScroll: true, activateRow: options?.activateRow !== false })) return false;
    const start = typeof options?.selectionStart === 'number'
      ? options.selectionStart
      : options?.cursor === 'start' ? 0 : editor.value.length;
    const end = typeof options?.selectionEnd === 'number' ? options.selectionEnd : start;
    const direction = options?.direction || 'none';
    if (!editor.setSelectionRange(start, end, direction)) return false;
    if (!options || options.scroll !== false) {
      // scrollIntoView also moves overflow-hidden ancestors and the document.
      // Center the actual caret (not an oversized row) in the native viewport.
      const viewport = row.closest('[data-transcript-scroll]');
      const caret = viewport && editor.getCaretRect(direction === 'backward' ? start : end);
      if (caret) {
        const bounds = viewport.getBoundingClientRect();
        viewport.scrollTop += caret.top + caret.height / 2 -
          (bounds.top + viewport.clientTop + viewport.clientHeight / 2);
      }
    }
    return true;
  };


  helper.moveFocus = function moveFocus(offset) {
    const rows = helper.getTranscriptRows();
    if (!rows.length) {
      return false;
    }

    const currentIndex = helper.getCurrentRowIndex();
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.max(0, Math.min(rows.length - 1, baseIndex + offset));
    if (nextIndex === baseIndex && currentIndex >= 0) {
      return false;
    }

    return helper.focusRow(rows[nextIndex], {
      cursor: 'start'
    });
  };

  return {};
}
