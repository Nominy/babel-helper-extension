(function babelWorkflowHelper() {
  if (window.__babelWorkflowHelperLoaded) {
    return;
  }

  window.__babelWorkflowHelperLoaded = true;

  const ROW_TEXTAREA_SELECTOR = 'textarea[placeholder^="What was said"]';
  const ACTION_TRIGGER_SELECTOR = 'button[aria-haspopup="menu"]';
  const HOTKEYS_HELP_MARKER = 'data-babel-helper-hotkeys';
  const HOTKEYS_DIALOG_PATTERNS = [
    /\bkeyboard shortcuts\b/i,
    /\buse these shortcuts to navigate and control the transcription workbench\b/i,
    /\bhotkeys\b/i
  ];
  const HOTKEYS_HELP_ROWS = [
    ['Esc', 'Toggle blur and restore cursor'],
    ['Alt + Up', 'Focus previous segment'],
    ['Alt + Down', 'Focus next segment'],
    ['Alt + Shift + Up', 'Merge with previous segment'],
    ['Alt + Shift + Down', 'Merge with next segment'],
    ['Del', 'Delete current segment']
  ];
  const ACTION_PATTERNS = {
    deleteSegment: [
      /\bdelete(?:\s+segment)?\b/i,
      /\bremove(?:\s+segment)?\b/i
    ],
    mergePrevious: [
      /\bmerge\b.*\b(previous|prev|above|before|up)\b/i,
      /\b(previous|prev|above|before|up)\b.*\b(merge|combine|join)\b/i,
      /\b(combine|join)\b.*\b(previous|prev|above|before|up)\b/i
    ],
    mergeNext: [
      /\bmerge\b.*\b(next|below|after|following|down)\b/i,
      /\b(next|below|after|following|down)\b.*\b(merge|combine|join)\b/i,
      /\b(combine|join)\b.*\b(next|below|after|following|down)\b/i
    ],
    mergeFallback: [
      /\bmerge\b/i,
      /\bcombine\b/i,
      /\bjoin\b/i
    ]
  };
  const state = {
    currentRow: null,
    lastBlur: null
  };

  function isEditable(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.isContentEditable) {
      return true;
    }

    return element.matches('textarea, input');
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeText(element) {
    if (!(element instanceof HTMLElement)) {
      return '';
    }

    return element.innerText.replace(/\s+/g, ' ').trim();
  }

  function getTranscriptRows() {
    return Array.from(document.querySelectorAll('tbody tr')).filter((row) =>
      row.querySelector(ROW_TEXTAREA_SELECTOR)
    );
  }

  function getRowTextarea(row) {
    return row ? row.querySelector(ROW_TEXTAREA_SELECTOR) : null;
  }

  function getCurrentRow() {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const activeRow = active.closest('tr');
      if (activeRow && activeRow.querySelector(ROW_TEXTAREA_SELECTOR)) {
        return activeRow;
      }
    }

    if (state.currentRow && state.currentRow.isConnected) {
      return state.currentRow;
    }

    const rows = getTranscriptRows();
    return rows[0] || null;
  }

  function getCurrentRowIndex() {
    const rows = getTranscriptRows();
    const currentRow = getCurrentRow();
    return currentRow ? rows.indexOf(currentRow) : -1;
  }

  function setCurrentRow(row) {
    if (row && row.isConnected) {
      state.currentRow = row;
    } else {
      state.currentRow = null;
    }
  }

  function dispatchClick(element) {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    if (typeof PointerEvent === 'function') {
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse'
        })
      );
    }

    element.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
    element.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        view: window
      })
    );
    element.click();
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  }

  async function waitFor(getValue, timeoutMs, intervalMs) {
    const timeout = timeoutMs || 800;
    const interval = intervalMs || 50;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeout) {
      const value = getValue();
      if (value) {
        return value;
      }

      await sleep(interval);
    }

    return null;
  }

  function getMenuRoots() {
    const portalRoots = Array.from(
      document.querySelectorAll('[data-radix-popper-content-wrapper], [data-radix-portal], [role="menu"]')
    );
    return portalRoots.length ? portalRoots : [document.body];
  }

  function collectMenuCandidates() {
    const selectors = [
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[data-radix-collection-item]'
    ];
    const matches = [];
    const seen = new Set();

    for (const root of getMenuRoots()) {
      const scoped = Array.from(root.querySelectorAll(selectors.join(',')));
      for (const node of scoped) {
        if (seen.has(node) || !isVisible(node)) {
          continue;
        }

        const label = normalizeText(node);
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
    for (const root of getMenuRoots()) {
      const scoped = Array.from(root.querySelectorAll('button, [role], div, span'));
      for (const node of scoped) {
        if (!(node instanceof HTMLElement) || seen.has(node) || !isVisible(node)) {
          continue;
        }

        if (node.children.length > 1 && !node.matches('button, [role]')) {
          continue;
        }

        const label = normalizeText(node);
        if (!label) {
          continue;
        }

        seen.add(node);
        fallback.push(node);
      }
    }

    return fallback;
  }

  function findMenuAction(actionName) {
    const candidates = collectMenuCandidates();
    const patterns = ACTION_PATTERNS[actionName] || [];
    for (const pattern of patterns) {
      const found = candidates.find((candidate) => pattern.test(normalizeText(candidate)));
      if (found) {
        return found;
      }
    }

    if (actionName === 'mergePrevious' || actionName === 'mergeNext') {
      for (const pattern of ACTION_PATTERNS.mergeFallback) {
        const found = candidates.find((candidate) => pattern.test(normalizeText(candidate)));
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  async function runRowAction(actionName) {
    const row = getCurrentRow();
    if (!row) {
      return false;
    }

    const actionTrigger = row.querySelector(ACTION_TRIGGER_SELECTOR);
    if (!(actionTrigger instanceof HTMLElement)) {
      return false;
    }

    const rows = getTranscriptRows();
    const originalIndex = rows.indexOf(row);
    setCurrentRow(row);

    dispatchClick(actionTrigger);

    const actionItem = await waitFor(() => findMenuAction(actionName), 1000, 50);
    if (!(actionItem instanceof HTMLElement)) {
      dispatchClick(actionTrigger);
      return false;
    }

    dispatchClick(actionItem);

    window.setTimeout(() => {
      const updatedRows = getTranscriptRows();
      if (!updatedRows.length) {
        setCurrentRow(null);
        return;
      }

      const fallbackIndex = originalIndex >= 0 ? Math.min(originalIndex, updatedRows.length - 1) : 0;
      setCurrentRow(updatedRows[fallbackIndex]);
    }, 180);

    return true;
  }

  function focusRow(row, options) {
    if (!row) {
      return false;
    }

    const textarea = getRowTextarea(row);
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    setCurrentRow(row);
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
  }

  function moveFocus(offset) {
    const rows = getTranscriptRows();
    if (!rows.length) {
      return false;
    }

    const currentIndex = getCurrentRowIndex();
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.max(0, Math.min(rows.length - 1, baseIndex + offset));
    if (nextIndex === baseIndex && currentIndex >= 0) {
      return false;
    }

    return focusRow(rows[nextIndex]);
  }

  function clearActiveFocus() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
      return false;
    }

    if (isEditable(active)) {
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
  }

  function toggleEditorFocus() {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.matches(ROW_TEXTAREA_SELECTOR)) {
      const row = active.closest('tr');
      if (row) {
        setCurrentRow(row);
      }

      state.lastBlur = {
        row: row || getCurrentRow(),
        selectionStart: active.selectionStart,
        selectionEnd: active.selectionEnd,
        direction: active.selectionDirection || 'none'
      };

      return clearActiveFocus();
    }

    const remembered = state.lastBlur;
    const currentRow = getCurrentRow();
    if (!remembered) {
      return focusRow(currentRow, { cursor: 'start' });
    }

    const rememberedRow = remembered.row;
    const rememberedRowStillCurrent =
      rememberedRow &&
      rememberedRow.isConnected &&
      currentRow &&
      currentRow === rememberedRow;

    if (rememberedRowStillCurrent) {
      return focusRow(rememberedRow, {
        activateRow: false,
        selectionStart: remembered.selectionStart,
        selectionEnd: remembered.selectionEnd,
        direction: remembered.direction
      });
    }

    const fallbackRow =
      (currentRow && currentRow.isConnected && currentRow) ||
      (rememberedRow && rememberedRow.isConnected && rememberedRow) ||
      getTranscriptRows()[0] ||
      null;
    if (!fallbackRow) {
      return false;
    }

    return focusRow(fallbackRow, {
      activateRow: false,
      cursor: 'start'
    });
  }

  function findHotkeysHosts() {
    const candidates = Array.from(
      document.querySelectorAll('[role="dialog"], [data-radix-popper-content-wrapper], [data-radix-portal]')
    );

    return candidates
      .filter((candidate) => candidate instanceof HTMLElement && isVisible(candidate))
      .map((candidate) =>
        candidate.matches('[role="dialog"]') ? candidate : candidate.querySelector('[role="dialog"]') || candidate
      )
      .filter((candidate) => candidate instanceof HTMLElement && isVisible(candidate))
      .filter((candidate) => {
        const text = normalizeText(candidate);
        return HOTKEYS_DIALOG_PATTERNS.some((pattern) => pattern.test(text));
      });
  }

  function buildHotkeysHelpBlock() {
    const wrapper = document.createElement('div');
    wrapper.setAttribute(HOTKEYS_HELP_MARKER, 'true');
    wrapper.style.marginTop = '12px';
    wrapper.style.paddingTop = '12px';
    wrapper.style.borderTop = '1px solid rgba(148, 163, 184, 0.35)';

    const title = document.createElement('div');
    title.textContent = 'Babel Helper';
    title.style.fontWeight = '700';
    title.style.fontSize = '14px';
    title.style.marginBottom = '8px';
    wrapper.appendChild(title);

    for (const [shortcut, description] of HOTKEYS_HELP_ROWS) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';
      row.style.gap = '12px';
      row.style.marginTop = '4px';

      const text = document.createElement('span');
      text.textContent = description;
      text.style.flex = '1';
      text.style.minWidth = '0';
      text.style.fontSize = '14px';
      text.style.color = 'rgb(51, 65, 85)';
      text.style.textAlign = 'left';

      const key = document.createElement('kbd');
      key.textContent = shortcut;
      key.style.marginLeft = 'auto';
      key.style.padding = '3px 8px';
      key.style.border = '1px solid rgb(226, 232, 240)';
      key.style.borderRadius = '8px';
      key.style.background = 'rgb(248, 250, 252)';
      key.style.fontFamily = 'ui-monospace, SFMono-Regular, Consolas, monospace';
      key.style.fontSize = '12px';
      key.style.fontWeight = '700';
      key.style.whiteSpace = 'nowrap';
      key.style.color = 'rgb(100, 116, 139)';

      row.appendChild(text);
      row.appendChild(key);
      wrapper.appendChild(row);
    }

    return wrapper;
  }

  function enhanceHotkeysDialog() {
    for (const host of findHotkeysHosts()) {
      if (!(host instanceof HTMLElement) || host.querySelector('[' + HOTKEYS_HELP_MARKER + ']')) {
        continue;
      }

      const contentTarget =
        host.querySelector('[data-slot="dialog-content"]') ||
        host.querySelector('[class*="overflow-y-auto"]') ||
        host.querySelector('[class*="overflow-auto"]') ||
        host.querySelector('[class*="max-h"]') ||
        host;
      if (contentTarget instanceof HTMLElement) {
        contentTarget.style.overflowY = 'auto';
        contentTarget.style.maxHeight = 'min(80vh, calc(100vh - 96px))';
      }
      contentTarget.appendChild(buildHotkeysHelpBlock());
    }
  }

  function handleKeydown(event) {
    if (event.defaultPrevented) {
      return;
    }

    if (event.key === 'Escape') {
      if (toggleEditorFocus()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (
      event.key === 'Delete' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      getCurrentRow()
    ) {
      event.preventDefault();
      event.stopPropagation();
      void runRowAction('deleteSegment');
      return;
    }

    if (event.ctrlKey || event.metaKey || !event.altKey) {
      return;
    }

    let handled = false;
    if (!event.shiftKey && event.key === 'ArrowUp') {
      handled = moveFocus(-1);
    } else if (!event.shiftKey && event.key === 'ArrowDown') {
      handled = moveFocus(1);
    } else if (event.shiftKey && event.key === 'ArrowUp') {
      handled = true;
      void runRowAction('mergePrevious');
    } else if (event.shiftKey && event.key === 'ArrowDown') {
      handled = true;
      void runRowAction('mergeNext');
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function bindRowTracking() {
    document.addEventListener(
      'focusin',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const row = target.closest('tr');
        if (row && row.querySelector(ROW_TEXTAREA_SELECTOR)) {
          setCurrentRow(row);
        }
      },
      true
    );

    document.addEventListener(
      'pointerdown',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const row = target.closest('tr');
        if (row && row.querySelector(ROW_TEXTAREA_SELECTOR)) {
          setCurrentRow(row);
        }
      },
      true
    );
  }

  function init() {
    bindRowTracking();
    enhanceHotkeysDialog();
    document.addEventListener('keydown', handleKeydown, true);

    const observer = new MutationObserver(() => {
      enhanceHotkeysDialog();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
