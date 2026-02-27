(function registerBabelHelperRows() {
  const helper = window.__babelWorkflowHelper;
  if (!helper || helper.__rowsRegistered) {
    return;
  }

  helper.__rowsRegistered = true;

  helper.getTranscriptRows = function getTranscriptRows() {
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
        break;
      }

      current = current.return;
      depth += 1;
    }

    if (!identity.annotationId && !identity.startText && !identity.endText) {
      return null;
    }

    return identity;
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

        const classes = row.classList;
        return (
          classes.contains('bg-neutral-100') &&
          classes.contains('ring-1') &&
          classes.contains('ring-neutral-300')
        );
      }) || null
    );
  };

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
      identity.startText &&
      identity.endText &&
      identity.startText === rowIdentity.startText &&
      identity.endText === rowIdentity.endText
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

  helper.getMenuRoots = function getMenuRoots() {
    const portalRoots = Array.from(
      document.querySelectorAll('[data-radix-popper-content-wrapper], [data-radix-portal], [role="menu"]')
    );
    return portalRoots.length ? portalRoots : [document.body];
  };

  helper.collectMenuCandidates = function collectMenuCandidates() {
    const selectors = [
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[data-radix-collection-item]'
    ];
    const matches = [];
    const seen = new Set();

    for (const root of helper.getMenuRoots()) {
      const scoped = Array.from(root.querySelectorAll(selectors.join(',')));
      for (const node of scoped) {
        if (seen.has(node) || !helper.isVisible(node)) {
          continue;
        }

        const label = helper.normalizeText(node);
        if (!label) {
          continue;
        }

        seen.add(node);
        matches.push(node);
      }
    }

    if (matches.length) {
      return matches;
    }

    const fallback = [];
    for (const root of helper.getMenuRoots()) {
      const scoped = Array.from(root.querySelectorAll('button, [role], div, span'));
      for (const node of scoped) {
        if (!(node instanceof HTMLElement) || seen.has(node) || !helper.isVisible(node)) {
          continue;
        }

        if (node.children.length > 1 && !node.matches('button, [role]')) {
          continue;
        }

        const label = helper.normalizeText(node);
        if (!label) {
          continue;
        }

        seen.add(node);
        fallback.push(node);
      }
    }

    return fallback;
  };

  helper.findMenuAction = function findMenuAction(actionName, options) {
    const settings = options || {};
    const exclude = settings.exclude instanceof Set ? settings.exclude : null;
    const candidates = helper
      .collectMenuCandidates()
      .filter((candidate) => !(exclude && exclude.has(candidate)));
    const patterns = helper.config.actionPatterns[actionName] || [];
    for (const pattern of patterns) {
      const found = candidates.find((candidate) => pattern.test(helper.normalizeText(candidate)));
      if (found) {
        return found;
      }
    }

    if (actionName === 'mergePrevious' || actionName === 'mergeNext') {
      for (const pattern of helper.config.actionPatterns.mergeFallback) {
        const found = candidates.find((candidate) => pattern.test(helper.normalizeText(candidate)));
        if (found) {
          return found;
        }
      }
    }

    return null;
  };

  helper.runRowAction = async function runRowAction(actionName, options) {
    const settings = options || {};
    const row =
      settings.row instanceof HTMLElement
        ? settings.row
        : helper.getCurrentRow({
            allowFallback: settings.allowFallback !== false
          });
    if (!row) {
      return false;
    }

    const actionTrigger = row.querySelector(helper.config.actionTriggerSelector);
    if (!(actionTrigger instanceof HTMLElement)) {
      return false;
    }

    const rows = helper.getTranscriptRows();
    const originalIndex = rows.indexOf(row);
    helper.setCurrentRow(row);

    const previousCandidates = new Set(helper.collectMenuCandidates());
    helper.dispatchClick(actionTrigger);

    await helper.waitFor(
      () =>
        actionTrigger.getAttribute('aria-expanded') === 'true' ||
        actionTrigger.getAttribute('data-state') === 'open',
      250,
      25
    );

    const actionItem = await helper.waitFor(
      () =>
        helper.findMenuAction(actionName, {
          exclude: previousCandidates
        }) || helper.findMenuAction(actionName),
      1000,
      50
    );
    if (!(actionItem instanceof HTMLElement)) {
      helper.dispatchClick(actionTrigger);
      return false;
    }

    helper.dispatchClick(actionItem);

    window.setTimeout(() => {
      const updatedRows = helper.getTranscriptRows();
      if (!updatedRows.length) {
        helper.setCurrentRow(null);
        return;
      }

      const fallbackIndex = originalIndex >= 0 ? Math.min(originalIndex, updatedRows.length - 1) : 0;
      helper.setCurrentRow(updatedRows[fallbackIndex]);
    }, 180);

    return true;
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

    return helper.focusRow(rows[nextIndex]);
  };

  helper.joinSegmentText = function joinSegmentText(left, right) {
    const before = typeof left === 'string' ? left : String(left ?? '');
    const after = typeof right === 'string' ? right : String(right ?? '');
    if (!before) {
      return after;
    }
    if (!after) {
      return before;
    }

    if (/\s$/.test(before) || /^\s/.test(after)) {
      return before + after;
    }

    return before + ' ' + after;
  };

  helper.splitTextByWordRatio = function splitTextByWordRatio(text, ratio) {
    const source = typeof text === 'string' ? text : String(text ?? '');
    const words = source.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      return {
        firstText: '',
        secondText: '',
        splitCount: 0,
        wordCount: 0
      };
    }

    const clampedRatio = Math.min(Math.max(Number(ratio) || 0, 0), 1);
    let splitCount = Math.round(words.length * clampedRatio);
    if (clampedRatio > 0 && clampedRatio < 1 && words.length > 1) {
      splitCount = Math.max(1, Math.min(words.length - 1, splitCount));
    } else {
      splitCount = Math.max(0, Math.min(words.length, splitCount));
    }

    return {
      firstText: words.slice(0, splitCount).join(' '),
      secondText: words.slice(splitCount).join(' '),
      splitCount,
      wordCount: words.length
    };
  };

  helper.applySmartSplitToRows = function applySmartSplitToRows(leftRow, rightRow, sourceText, ratio) {
    const leftTextarea = helper.getRowTextarea(leftRow);
    const rightTextarea = helper.getRowTextarea(rightRow);
    if (!(leftTextarea instanceof HTMLTextAreaElement) || !(rightTextarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    const parts = helper.splitTextByWordRatio(sourceText, ratio);
    if (!parts.wordCount) {
      return false;
    }

    const wroteLeft = helper.setEditableValue(leftTextarea, parts.firstText);
    const wroteRight = helper.setEditableValue(rightTextarea, parts.secondText);
    return Boolean(wroteLeft && wroteRight);
  };

  helper.moveTextToAdjacentSegment = function moveTextToAdjacentSegment(offset) {
    const textarea = helper.getActiveRowTextarea();
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    const row = textarea.closest('tr');
    if (!(row instanceof HTMLElement)) {
      return false;
    }

    const rows = helper.getTranscriptRows();
    const currentIndex = rows.indexOf(row);
    const targetIndex = currentIndex + offset;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= rows.length) {
      return false;
    }

    const targetTextarea = helper.getRowTextarea(rows[targetIndex]);
    if (!(targetTextarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    const currentValue = textarea.value || '';
    const targetValue = targetTextarea.value || '';
    const selectionStart =
      typeof textarea.selectionStart === 'number' ? textarea.selectionStart : currentValue.length;
    const selectionEnd =
      typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : selectionStart;

    if (offset < 0) {
      const splitIndex = Math.max(0, Math.min(currentValue.length, selectionStart));
      const movedText = currentValue.slice(0, splitIndex).replace(/^\s+/, '').replace(/\s+$/, '');
      if (!movedText) {
        return false;
      }

      const nextCurrentValue = currentValue.slice(splitIndex).replace(/^\s+/, '');
      const nextTargetValue = helper.joinSegmentText(targetValue, movedText);
      if (!helper.setEditableValue(targetTextarea, nextTargetValue)) {
        return false;
      }
      if (!helper.setEditableValue(textarea, nextCurrentValue)) {
        return false;
      }

      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(0, 0);
      helper.setCurrentRow(row);
      return true;
    }

    const splitIndex = Math.max(0, Math.min(currentValue.length, selectionEnd));
    const movedText = currentValue.slice(splitIndex).replace(/^\s+/, '').replace(/\s+$/, '');
    if (!movedText) {
      return false;
    }

    const nextCurrentValue = currentValue.slice(0, splitIndex).replace(/\s+$/, '');
    const nextTargetValue = helper.joinSegmentText(movedText, targetValue);
    if (!helper.setEditableValue(textarea, nextCurrentValue)) {
      return false;
    }
    if (!helper.setEditableValue(targetTextarea, nextTargetValue)) {
      return false;
    }

    const caret = nextCurrentValue.length;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(caret, caret);
    helper.setCurrentRow(row);
    return true;
  };

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

      helper.state.lastBlur = {
        row: row || helper.getCurrentRow(),
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd,
        direction: active.selectionDirection || 'none'
      };
      helper.state.blurRestorePending = true;

      return helper.clearActiveFocus();
    }

    const remembered = helper.state.lastBlur;
    if (!helper.state.blurRestorePending) {
      return false;
    }

    const currentRow = helper.getCurrentRow();
    if (!remembered) {
      const focused = helper.focusRow(currentRow, { cursor: 'start' });
      if (focused) {
        helper.state.blurRestorePending = false;
      }
      return focused;
    }

    const rememberedRow = remembered.row;
    const rememberedRowStillCurrent =
      rememberedRow &&
      rememberedRow.isConnected &&
      currentRow &&
      currentRow === rememberedRow;

    if (rememberedRowStillCurrent) {
      const focused = helper.focusRow(rememberedRow, {
        activateRow: false,
        selectionStart: remembered.selectionStart,
        selectionEnd: remembered.selectionEnd,
        direction: remembered.direction
      });
      if (focused) {
        helper.state.blurRestorePending = false;
      }
      return focused;
    }

    const fallbackRow =
      (currentRow && currentRow.isConnected && currentRow) ||
      (rememberedRow && rememberedRow.isConnected && rememberedRow) ||
      helper.getTranscriptRows()[0] ||
      null;
    if (!fallbackRow) {
      return false;
    }

    const focused = helper.focusRow(fallbackRow, {
      activateRow: false,
      cursor: 'start'
    });
    if (focused) {
      helper.state.blurRestorePending = false;
    }
    return focused;
  };
})();
