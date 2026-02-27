(function initBabelHelperShared() {
  if (window.__babelWorkflowHelperLoaded) {
    return;
  }

  window.__babelWorkflowHelperLoaded = true;

  const helper = {
    config: {
      rowTextareaSelector: 'textarea[placeholder^="What was said"]',
      actionTriggerSelector: 'button[aria-haspopup="menu"]',
      hotkeysHelpMarker: 'data-babel-helper-hotkeys',
      hotkeysDialogPatterns: [
        /\bkeyboard shortcuts\b/i,
        /\buse these shortcuts to navigate and control the transcription workbench\b/i,
        /\bhotkeys\b/i
      ],
      hotkeysHelpRows: [
        ['Esc', 'Toggle blur and restore cursor'],
        ['Alt + [ (Х)', 'Move text before caret to previous segment'],
        ['Alt + ] (Ъ)', 'Move text after caret to next segment'],
        ['Alt + Shift + Up', 'Merge with previous segment'],
        ['Alt + Shift + Down', 'Merge with next segment'],
        ['Del', 'Delete current segment']
      ],
      actionPatterns: {
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
      }
    },
    state: {
      currentRow: null,
      lastBlur: null,
      blurRestorePending: false
    }
  };

  helper.isEditable = function isEditable(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.isContentEditable) {
      return true;
    }

    return element.matches('textarea, input');
  };

  helper.isVisible = function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  helper.normalizeText = function normalizeText(element) {
    if (!(element instanceof HTMLElement)) {
      return '';
    }

    return element.innerText.replace(/\s+/g, ' ').trim();
  };

  helper.setEditableValue = function setEditableValue(element, value) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const nextValue = typeof value === 'string' ? value : String(value ?? '');
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    const setter = prototype
      ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set
      : null;

    if (typeof setter === 'function') {
      setter.call(element, nextValue);
    } else if ('value' in element) {
      element.value = nextValue;
    } else {
      return false;
    }

    element.dispatchEvent(
      typeof InputEvent === 'function'
        ? new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            data: null,
            inputType: 'insertText'
          })
        : new Event('input', {
            bubbles: true,
            cancelable: false
          })
    );

    return true;
  };

  helper.dispatchClick = function dispatchClick(element) {
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
  };

  helper.sleep = function sleep(milliseconds) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, milliseconds);
    });
  };

  helper.waitFor = async function waitFor(getValue, timeoutMs, intervalMs) {
    const timeout = timeoutMs || 800;
    const interval = intervalMs || 50;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeout) {
      const value = getValue();
      if (value) {
        return value;
      }

      await helper.sleep(interval);
    }

    return null;
  };

  window.__babelWorkflowHelper = helper;
})();
