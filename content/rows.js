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

  helper.getCurrentRow = function getCurrentRow() {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const activeRow = active.closest('tr');
      if (activeRow && activeRow.querySelector(helper.config.rowTextareaSelector)) {
        return activeRow;
      }
    }

    if (helper.state.currentRow && helper.state.currentRow.isConnected) {
      return helper.state.currentRow;
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
    } else {
      helper.state.currentRow = null;
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

  helper.findMenuAction = function findMenuAction(actionName) {
    const candidates = helper.collectMenuCandidates();
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

  helper.runRowAction = async function runRowAction(actionName) {
    const row = helper.getCurrentRow();
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

    helper.dispatchClick(actionTrigger);

    const actionItem = await helper.waitFor(() => helper.findMenuAction(actionName), 1000, 50);
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
