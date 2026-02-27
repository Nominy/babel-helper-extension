(function initBabelHelperMain() {
  const helper = window.__babelWorkflowHelper;
  if (!helper || helper.__mainInitialized) {
    return;
  }

  helper.__mainInitialized = true;

  helper.handleKeydown = function handleKeydown(event) {
    if (event.defaultPrevented) {
      return;
    }

    if (typeof helper.handleCutPreviewKeydown === 'function' && helper.handleCutPreviewKeydown(event)) {
      return;
    }

    if (event.key === 'Escape') {
      if (helper.toggleEditorFocus()) {
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
      helper.getCurrentRow()
    ) {
      event.preventDefault();
      event.stopPropagation();
      void helper.runRowAction('deleteSegment');
      return;
    }

    if (event.ctrlKey || event.metaKey || !event.altKey) {
      return;
    }

    let handled = false;
    if (!event.shiftKey && event.key === 'ArrowUp') {
      handled = helper.moveFocus(-1);
    } else if (!event.shiftKey && event.key === 'ArrowDown') {
      handled = helper.moveFocus(1);
    } else if (event.shiftKey && event.key === 'ArrowUp') {
      handled = true;
      void helper.runRowAction('mergePrevious');
    } else if (event.shiftKey && event.key === 'ArrowDown') {
      handled = true;
      void helper.runRowAction('mergeNext');
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  helper.bindRowTracking = function bindRowTracking() {
    document.addEventListener(
      'focusin',
      (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
          return;
        }

        const row = target.closest('tr');
        if (row && row.querySelector(helper.config.rowTextareaSelector)) {
          helper.setCurrentRow(row);
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
        if (row && row.querySelector(helper.config.rowTextareaSelector)) {
          helper.setCurrentRow(row);
        }
      },
      true
    );
  };

  helper.init = function init() {
    helper.bindRowTracking();
    if (typeof helper.bindCutPreview === 'function') {
      helper.bindCutPreview();
    }
    helper.enhanceHotkeysDialog();
    document.addEventListener('keydown', helper.handleKeydown, true);

    const observer = new MutationObserver(() => {
      helper.enhanceHotkeysDialog();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', helper.init, { once: true });
  } else {
    helper.init();
  }
})();
