// @ts-nocheck
import type { FeatureModule } from '../core/types';
import { getBabelRowActionLabel } from '../core/babel-editor-contract';
import type { RowModules } from '../services/row-service';
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';

export function registerRowActions(helper: any, api: Pick<RowModules, 'time'>) {

  // Native menus appear asynchronously in portals outside the row; never scope lookup to the row.
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
    const actionLabel = getBabelRowActionLabel(actionName);
    return actionLabel
      ? candidates.find((candidate) => helper.normalizeText(candidate) === actionLabel) || null
      : null;
  };


  function getMergeActionPlan(actionName, row, rows, originalIndex) {
    if (
      (actionName !== 'mergePrevious' && actionName !== 'mergeNext') ||
      !(row instanceof HTMLTableRowElement) ||
      !Array.isArray(rows) ||
      originalIndex < 0
    ) {
      return null;
    }

    const direction = actionName === 'mergePrevious' ? -1 : 1;
    const adjacentRow = rows[originalIndex + direction];
    if (!(adjacentRow instanceof HTMLTableRowElement)) {
      return null;
    }

    const survivingRow = direction < 0 ? adjacentRow : row;
    const survivingText = helper.getRowTextValue(survivingRow);
    const mergedText =
      direction < 0
        ? helper.joinSegmentText(helper.getRowTextValue(adjacentRow), helper.getRowTextValue(row))
        : helper.joinSegmentText(helper.getRowTextValue(row), helper.getRowTextValue(adjacentRow));
    const appendedText = direction < 0 ? helper.getRowTextValue(row) : helper.getRowTextValue(adjacentRow);
    const caretOffset =
      appendedText && mergedText.endsWith(appendedText)
        ? mergedText.length - appendedText.length
        : survivingText.length;

    return {
      actionName,
      adjacentRow,
      adjacentText: helper.getRowTextValue(adjacentRow),
      expectedRowCount: rows.length - 1,
      mergedText,
      originalIndex,
      survivingRow,
      survivingText,
      targetIndex: direction < 0 ? Math.max(0, originalIndex - 1) : originalIndex,
      caretOffset
    };
  }


  function findMergedRow(plan, updatedRows) {
    if (!plan || !Array.isArray(updatedRows) || !updatedRows.length) {
      return null;
    }

    const candidates = [];
    if (plan.survivingRow instanceof HTMLTableRowElement && plan.survivingRow.isConnected) {
      candidates.push(plan.survivingRow);
    }

    const indexed = updatedRows[plan.targetIndex];
    if (indexed instanceof HTMLTableRowElement && !candidates.includes(indexed)) {
      candidates.push(indexed);
    }

    for (const row of updatedRows) {
      if (row instanceof HTMLTableRowElement && !candidates.includes(row)) {
        candidates.push(row);
      }
    }

    for (const candidate of candidates) {
      const text = helper.getRowTextValue(candidate);
      if (!text) {
        continue;
      }

      if (text === plan.mergedText) {
        return candidate;
      }

      if (
        text !== plan.survivingText &&
        text.includes(plan.survivingText) &&
        (!plan.adjacentText || text.includes(plan.adjacentText))
      ) {
        return candidate;
      }
    }

    return candidates[0] || null;
  }


  function restoreMergeSelection(row, caretOffset) {
    if (!(row instanceof HTMLTableRowElement)) {
      return false;
    }

    const textarea = helper.getRowTextarea(row);
    if (!(textarea instanceof HTMLTextAreaElement)) {
      return false;
    }

    const caret = Math.max(0, Math.min(textarea.value.length, Number(caretOffset) || 0));
    helper.state.lastBlur = {
      row,
      selectionStart: caret,
      selectionEnd: caret,
      direction: 'none'
    };
    helper.state.blurRestorePending = true;
    // The native merge has already committed. Restore once; deferred focus
    // replays would steal a subsequent edit or Escape/Delete workflow.
    return helper.focusRow(row, {
      activateRow: false,
      scroll: false,
      selectionStart: caret,
      selectionEnd: caret
    });

  }


  function getNativeRowActionPayload(row) {
    if (!(row instanceof HTMLElement)) {
      return null;
    }

    const rowIdentity = helper.getRowIdentity(row) || {};
    const timeRange = api.time.getRowTimeRange(row) || {};
    const startText =
      typeof rowIdentity.startText === 'string' && rowIdentity.startText
        ? rowIdentity.startText
        : row.children[2] instanceof HTMLElement
          ? helper.normalizeText(row.children[2])
          : '';
    const endText =
      typeof rowIdentity.endText === 'string' && rowIdentity.endText
        ? rowIdentity.endText
        : row.children[3] instanceof HTMLElement
          ? helper.normalizeText(row.children[3])
          : '';

    return {
      annotationId:
        typeof rowIdentity.annotationId === 'string' && rowIdentity.annotationId
          ? rowIdentity.annotationId
          : '',
      rowIdentity,
      speakerKey:
        typeof rowIdentity.speakerKey === 'string' && rowIdentity.speakerKey
          ? rowIdentity.speakerKey
          : api.time.getRowSpeakerKeySafe(row),
      startText,
      endText,
      startSeconds:
        typeof timeRange.startSeconds === 'number'
          ? timeRange.startSeconds
          : api.time.parseSegmentTimeValue(startText),
      endSeconds:
        typeof timeRange.endSeconds === 'number'
          ? timeRange.endSeconds
          : api.time.parseSegmentTimeValue(endText),
      attempts: 1,
      retryDelayMs: 0
    };
  }


  async function runNativeRowAction(actionName, row, settings) {
    if (settings && settings.preferNative === false) {
      return null;
    }

    const payload = getNativeRowActionPayload(row);
    if (!payload) {
      return null;
    }

    if (actionName === 'deleteSegment' && typeof helper.deleteSegmentWithNativeAction === 'function') {
      return helper.deleteSegmentWithNativeAction(payload);
    }

    if (
      (actionName === 'mergePrevious' || actionName === 'mergeNext') &&
      typeof helper.mergeSegmentWithNativeAction === 'function'
    ) {
      return helper.mergeSegmentWithNativeAction({
        ...payload,
        direction: actionName === 'mergeNext' ? 'below' : 'above'
      });
    }

    return null;
  }


  function recordRowActionAnalytics(actionName, originalIndex, mergePlan) {
    if (!helper.analytics) {
      return;
    }

    if (actionName === 'mergePrevious') {
      helper.analytics.record('text:merge-previous', {
        rowIndex: originalIndex,
        hasMergePlan: Boolean(mergePlan)
      });
    } else if (actionName === 'mergeNext') {
      helper.analytics.record('text:merge-next', {
        rowIndex: originalIndex,
        hasMergePlan: Boolean(mergePlan)
      });
    }
  }


  async function restoreAfterMergeAction(mergePlan) {
    if (!mergePlan) {
      return false;
    }

    const mergedRow = await helper.waitFor(() => {
      const updatedRows = helper.getTranscriptRows();
      const candidate = findMergedRow(mergePlan, updatedRows);
      if (!(candidate instanceof HTMLTableRowElement)) {
        return null;
      }

      const text = helper.getRowTextValue(candidate);
      const rowCountSettled = updatedRows.length <= mergePlan.expectedRowCount;
      const textSettled =
        text === mergePlan.mergedText ||
        (text !== mergePlan.survivingText &&
          text.includes(mergePlan.survivingText) &&
          (!mergePlan.adjacentText || text.includes(mergePlan.adjacentText)));
      const adjacentRemoved =
        !(mergePlan.adjacentRow instanceof HTMLTableRowElement) || !mergePlan.adjacentRow.isConnected;

      return rowCountSettled || textSettled || adjacentRemoved ? candidate : null;
    }, 1200, 40);

    const resolvedRow =
      (mergedRow instanceof HTMLTableRowElement && mergedRow) ||
      findMergedRow(mergePlan, helper.getTranscriptRows());
    if (resolvedRow) {
      helper.setCurrentRow(resolvedRow);
      restoreMergeSelection(resolvedRow, mergePlan.caretOffset);
      return true;
    }

    return false;
  }


  function rememberRowAfterAction(originalIndex) {
    window.setTimeout(() => {
      const updatedRows = helper.getTranscriptRows();
      if (!updatedRows.length) {
        helper.setCurrentRow(null);
        return;
      }

      const fallbackIndex = originalIndex >= 0 ? Math.min(originalIndex, updatedRows.length - 1) : 0;
      helper.setCurrentRow(updatedRows[fallbackIndex]);
    }, 180);
  }


  helper.runRowAction = async function runRowAction(actionName, options) {
    const settings = options || {};
    if (typeof helper.refreshEditorSnapshot === 'function') {
      await helper.refreshEditorSnapshot('row-action').catch(() => null);
    }

    const row =
      settings.row instanceof HTMLElement
        ? settings.row
        : typeof helper.getCurrentActionRow === 'function'
          ? helper.getCurrentActionRow({
            allowFallback: settings.allowFallback === true
          })
          : helper.getCurrentRow({
            allowFallback: settings.allowFallback === true
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
    const mergePlan = getMergeActionPlan(actionName, row, rows, originalIndex);
    helper.setCurrentRow(row);

    const nativeResult = await runNativeRowAction(actionName, row, settings);
    if (nativeResult && nativeResult.ok) {
      recordRowActionAnalytics(actionName, originalIndex, mergePlan);
      if (mergePlan && await restoreAfterMergeAction(mergePlan)) {
        return true;
      }
      rememberRowAfterAction(originalIndex);
      return true;
    }

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

    recordRowActionAnalytics(actionName, originalIndex, mergePlan);

    if (mergePlan && await restoreAfterMergeAction(mergePlan)) {
      return true;
    }

    rememberRowAfterAction(originalIndex);
    return true;
  };

  return {};
}

export function createRowActionsFeature(): FeatureModule {
  return {
    id: 'row-actions',
    register(ctx) {
      if (typeof ctx.services.rows.getTranscriptRows !== 'function') {
        ctx.logger.warn('Row service is missing getTranscriptRows');
      }
    }
  };
}

export function registerRowActionInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;
  function tryDeleteCurrentRow(event) {
    const row =
      typeof helper.getCurrentActionRow === 'function'
        ? helper.getCurrentActionRow({ allowFallback: false })
        : helper.getCurrentRow({ allowFallback: false });
    if (!row) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    void helper.runRowAction('deleteSegment', {
      row,
      allowFallback: false
    });
    return true;
  }
  function isRightShiftSegmentNavigationShortcut(event) {
    return Boolean(
      isFeatureEnabled('rowActions') &&
      helper.state.rightShiftPressed &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    );
  }
  hooks.on('keydown', (event) => {
    if (
      isFeatureEnabled('rowActions') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.code === 'KeyD' &&
      !helper.isEditable(event.target instanceof HTMLElement ? event.target : null)
    ) {
      if (tryDeleteCurrentRow(event)) {
        if (helper.analytics) {
          helper.analytics.record('hotkey:delete', { key: 'D' });
        }
        return true;
      }
    }
  }, 60);
  hooks.on('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || !event.altKey) return false;
    let handled = false;
    if (isFeatureEnabled('rowActions') && event.shiftKey && event.key === 'ArrowUp') {
      handled = true;
      void helper.runRowAction('mergePrevious');
      if (helper.analytics) {
        helper.analytics.record('hotkey:merge', { direction: 'previous' });
      }
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return handled;
  }, 95);
  hooks.on('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || !event.altKey) return false;
    let handled = false;
    if (isFeatureEnabled('rowActions') && event.shiftKey && event.key === 'ArrowDown') {
      handled = true;
      void helper.runRowAction('mergeNext');
      if (helper.analytics) {
        helper.analytics.record('hotkey:merge', { direction: 'next' });
      }
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return handled;
  }, 96);
  hooks.on('capture', (event) => {
    if (isRightShiftSegmentNavigationShortcut(event)) {
      const offset = event.key === 'ArrowRight' ? 1 : -1;
      const handled =
        typeof helper.moveFocus === 'function' &&
        helper.moveFocus(offset);

      event.preventDefault();
      event.stopImmediatePropagation();

      if (handled && helper.analytics) {
        helper.analytics.record('hotkey:segment-nav', {
          direction: offset > 0 ? 'next' : 'previous',
          via: 'right-shift-arrow'
        });
      }
      return true;
    }
  }, 30);
}
