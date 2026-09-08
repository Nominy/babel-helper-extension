// @ts-nocheck
import { isBabelActiveRowClassList } from '../core/babel-editor-contract';
import type { RowModules } from '../services/row-service';

export function createRowSiteApi(helper: any, api: Pick<RowModules, 'time'>) {

  helper.getTranscriptRows = function getTranscriptRows() {
    helper.perf?.count?.('row.scan');
    return Array.from(document.querySelectorAll('tbody tr')).filter((row) =>
      row.querySelector(helper.config.rowTextareaSelector)
    );
  };


  helper.getRowTextarea = function getRowTextarea(row) {
    return row ? row.querySelector(helper.config.rowTextareaSelector) : null;
  };


  helper.getRowTextValue = function getRowTextValue(row) {
    const textarea = helper.getRowTextarea(row);
    return textarea instanceof HTMLTextAreaElement ? textarea.value || '' : '';
  };


  helper.getActiveRowTextarea = function getActiveRowTextarea() {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.matches(helper.config.rowTextareaSelector)
      ? active
      : null;
  };


  function getReactInternalValue(element, prefix) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    for (const name of Object.getOwnPropertyNames(element)) {
      if (typeof name === 'string' && name.indexOf(prefix) === 0) {
        return element[name];
      }
    }

    return null;
  }


  function getReactFiber(element) {
    return getReactInternalValue(element, '__reactFiber$');
  }


  helper.getRowIdentity = function getRowIdentity(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const identity = {
      annotationId: null,
      processedRecordingId: null,
      trackLabel: '',
      speakerKey: '',
      isActive: false,
      startText: '',
      endText: ''
    };

    const startCell = row.children[2];
    const endCell = row.children[3];
    identity.startText = startCell instanceof HTMLElement ? helper.normalizeText(startCell) : '';
    identity.endText = endCell instanceof HTMLElement ? helper.normalizeText(endCell) : '';

    let fiber = getReactFiber(row);
    if (!fiber) {
      const textarea = helper.getRowTextarea(row);
      fiber = getReactFiber(textarea);
    }

    let current = fiber;
    let depth = 0;
    while (current && typeof current === 'object' && depth < 12) {
      const props = current.memoizedProps;
      if (props && typeof props === 'object' && typeof props.isActive === 'boolean') {
        identity.isActive = props.isActive;
      }

      const annotation =
        props && typeof props === 'object' && props.annotation && typeof props.annotation === 'object'
          ? props.annotation
          : null;
      if (annotation && typeof annotation.id === 'string' && annotation.id) {
        identity.annotationId = annotation.id;
        identity.processedRecordingId =
          annotation.processedRecordingId != null ? String(annotation.processedRecordingId) : null;
        identity.trackLabel =
          typeof annotation.trackLabel === 'string' ? annotation.trackLabel.trim() : '';
        identity.speakerKey =
          identity.processedRecordingId ||
          identity.trackLabel ||
          (row.children[1] instanceof HTMLElement ? helper.normalizeText(row.children[1]) : '');
        break;
      }

      current = current.return;
      depth += 1;
    }

    if (!identity.speakerKey) {
      identity.speakerKey =
        (row.children[1] instanceof HTMLElement ? helper.normalizeText(row.children[1]) : '') || '';
    }

    if (!identity.annotationId && !identity.startText && !identity.endText && !identity.speakerKey) {
      return null;
    }

    return identity;
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
      if (!(candidate instanceof HTMLTableRowElement)) {
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
    if (!rowIdentity) {
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
        return rowIdentity && rowIdentity.annotationId === identity.annotationId;
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
      const activeRow = active.closest('tr');
      if (activeRow && activeRow.querySelector(helper.config.rowTextareaSelector)) {
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
      const activeRow = active.closest('tr');
      if (activeRow && activeRow.querySelector(helper.config.rowTextareaSelector)) {
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

    const textarea = helper.getRowTextarea(row);
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    helper.setCurrentRow(row);
    if (!options || options.scroll !== false) {
      row.scrollIntoView({
        block: 'center',
        behavior: 'smooth'
      });
    }
    // A native row click can reset the playhead; focus restoration must pass activateRow: false.
    if (!options || options.activateRow !== false) {
      row.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );
    }
    textarea.focus({
      preventScroll: true
    });

    try {
      if (options && typeof options.selectionStart === 'number') {
        const end =
          typeof options.selectionEnd === 'number' ? options.selectionEnd : options.selectionStart;
        textarea.setSelectionRange(
          options.selectionStart,
          end,
          typeof options.direction === 'string' ? options.direction : 'none'
        );
      } else if (options && options.cursor === 'start') {
        textarea.setSelectionRange(0, 0);
      } else {
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      }
    } catch (_error) {
      // Ignore selection errors from browsers that reject the call mid-render.
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
