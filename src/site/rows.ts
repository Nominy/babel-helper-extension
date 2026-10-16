// @ts-nocheck
import { BABEL_TRANSCRIPT_ROW_SELECTOR, isBabelActiveRowClassList } from '../core/babel-editor-contract';
import { getEditorControl, getEditorControlFromTarget, readTurnState, readNativeRowIdentityIndex } from './editor-control';
import type { RowModules } from '../services/row-service';

export function createRowSiteApi(helper: any, api: Pick<RowModules, 'time'>) {

  let rows = [], byRow = new Map(), byAnnotation = new Map(), rowOrder = new Map();
  let dirty = true, revision = 0, publication = null, activeIds = new Set();
  let observer = null, observing = false;
  const listeners = new Set();
  const formatTime = seconds => Number.isFinite(seconds)
    ? `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}` : '';

  function invalidate() {
    dirty = true;
    revision++;
    helper.invalidateRowTimeCache?.();
    for (const listener of listeners) listener(revision);
  }

  function membershipChanged(mutations) {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        if (byRow.has(mutation.target) || mutation.target.matches(BABEL_TRANSCRIPT_ROW_SELECTOR)) return true;
        continue;
      }
      for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (node instanceof Element &&
            (node.matches(BABEL_TRANSCRIPT_ROW_SELECTOR) || node.querySelector(BABEL_TRANSCRIPT_ROW_SELECTOR))) return true;
      }
    }
    return false;
  }

  function onCommit(event) {
    let next;
    try { next = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail; } catch { return; }
    if (!next || next.href !== document.location.href) return;
    const changed = !publication || next.generation !== publication.generation ||
      next.reviewActionId !== publication.reviewActionId || next.annotationRevision !== publication.annotationRevision;
    publication = next;
    activeIds = new Set(next.activeIds || []);
    if (changed) invalidate();
  }

  function onSessionChange() {
    publication = null;
    activeIds.clear();
    rows = [];
    byRow.clear();
    byAnnotation.clear();
    rowOrder.clear();
    invalidate();
  }

  function observe() {
    if (observing) return;
    observing = true;
    observer = new MutationObserver(mutations => {
      if (membershipChanged(mutations)) invalidate();
    });
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['data-annotation-id', 'data-babel-classic-row']
    });
    window.addEventListener('babel-helper:native-editor-commit', onCommit);
    window.addEventListener('babel-helper:native-session-change', onSessionChange);
    window.addEventListener('babel-helper:native-route-change', onSessionChange);
  }

  function drainMembership() {
    observe();
    if (membershipChanged(observer.takeRecords())) invalidate();
  }

  function ensureIndex() {
    drainMembership();
    if (!dirty) return;
    helper.perf?.count?.('row.scan');
    rows = Array.from(document.querySelectorAll(BABEL_TRANSCRIPT_ROW_SELECTOR));
    const snapshot = readNativeRowIdentityIndex();
    publication = snapshot;
    activeIds = new Set(snapshot?.activeIds || []);
    byRow = new Map();
    byAnnotation = new Map();
    rowOrder = new Map(rows.map((row, index) => [row, index]));
    const identities = new Map((snapshot?.identities || []).map(identity => [identity.annotationId, identity]));
    for (const row of rows) {
      const identity = identities.get(row.dataset.annotationId);
      if (!identity) continue;
      const speaker = row.querySelector('select[id^="speaker-"]');
      const processedRecordingId = identity.processedRecordingId || speaker?.value || null;
      const value = { ...identity, processedRecordingId,
        trackLabel: identity.trackLabel || speaker?.selectedOptions?.[0]?.textContent?.trim() || '',
        speakerKey: processedRecordingId || '', startText: formatTime(identity.startSeconds),
        endText: formatTime(identity.endSeconds) };
      byRow.set(row, value);
      byAnnotation.set(identity.annotationId, row);
    }
    helper.perf?.count?.('row-index.rebuild');
    dirty = false;
  }

  helper.getRowIndexRevision = function getRowIndexRevision() {
    drainMembership();
    return revision;
  };
  helper.subscribeRowIndexChanges = function subscribeRowIndexChanges(listener) {
    observe();
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  helper.disposeRowIndex = function disposeRowIndex() {
    observer?.disconnect();
    observer = null;
    observing = false;
    window.removeEventListener('babel-helper:native-editor-commit', onCommit);
    window.removeEventListener('babel-helper:native-session-change', onSessionChange);
    window.removeEventListener('babel-helper:native-route-change', onSessionChange);
    listeners.clear();
    onSessionChange();
  };

  helper.getTranscriptRows = function getTranscriptRows() {
    ensureIndex();
    return rows;
  };


  helper.getRowEditor = getEditorControl;


  helper.getRowTextValue = function getRowTextValue(row) {
    return row instanceof HTMLElement ? readTurnState(row)?.text ?? '' : '';
  };


  helper.getActiveRowEditor = function getActiveRowEditor() {
    return getEditorControlFromTarget(document.activeElement);
  };




  // Cached identities describe presentation only. EditorControl requests still
  // revalidate current task, source, permissions and native input ownership.
  helper.getRowIdentity = function getRowIdentity(row) {
    if (!(row instanceof HTMLElement) || !row.isConnected) return null;
    ensureIndex();
    const identity = byRow.get(row);
    if (!identity || identity.annotationId !== row.dataset.annotationId) return null;
    return { ...identity, isActive: activeIds.has(identity.annotationId),
      isEditing: publication?.editingId === identity.annotationId, readOnly: publication?.readOnly !== false };
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
    ensureIndex();
    let first = null;
    for (const id of activeIds) {
      const row = byAnnotation.get(id);
      if (row?.isConnected && (!first || rowOrder.get(row) < rowOrder.get(first))) first = row;
    }
    return first;
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


  function getActiveRowFromCommittedIndex() {
    ensureIndex();
    let first = null, firstStart = Infinity, firstOrder = Infinity;
    for (const id of activeIds) {
      const row = byAnnotation.get(id);
      if (!row?.isConnected) continue;
      const start = byRow.get(row)?.startSeconds ?? 0, order = rowOrder.get(row);
      if (start < firstStart || start === firstStart && order < firstOrder) {
        first = row;
        firstStart = start;
        firstOrder = order;
      }
    }
    return first;
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
      const byId = byAnnotation.get(identity.annotationId);
      if (byId && (!identity.reviewActionId || identity.reviewActionId === byRow.get(byId)?.reviewActionId)) return byId;
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

    const snapshotRow = getActiveRowFromCommittedIndex();
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

    const snapshotRow = getActiveRowFromCommittedIndex();
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

  return { dispose: helper.disposeRowIndex };
}
