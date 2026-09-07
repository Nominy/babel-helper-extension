// @ts-nocheck
import type { FeatureModule } from '../core/types';
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';

export function registerTextMove(helper: any) {

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
    if (currentIndex < 0) {
      return false;
    }

    const targetRow = helper.findAdjacentRowBySpeaker(row, offset);
    if (!(targetRow instanceof HTMLTableRowElement)) {
      return false;
    }

    const targetTextarea = helper.getRowTextarea(targetRow);
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

      if (helper.analytics) {
        helper.analytics.record('text:move-left', {
          movedLength: movedText.length,
          splitIndex,
          remainingLength: nextCurrentValue.length,
          targetLength: nextTargetValue.length
        });
      }
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

    if (helper.analytics) {
      helper.analytics.record('text:move-right', {
        movedLength: movedText.length,
        splitIndex,
        remainingLength: nextCurrentValue.length,
        targetLength: nextTargetValue.length
      });
    }
    return true;
  };

  return {};
}

export function createTextMoveFeature(): FeatureModule {
  return {
    id: 'text-move'
  };
}

export function registerTextMoveInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;

  hooks.on('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || !event.altKey) return false;
    let handled = false;
    if (isFeatureEnabled('textMove') && !event.shiftKey && event.code === 'BracketLeft') {
      handled = helper.moveTextToAdjacentSegment(-1);
      if (handled && helper.analytics) {
        helper.analytics.record('hotkey:text-move', { direction: 'left' });
      }
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return handled;
  }, 93);
  hooks.on('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || !event.altKey) return false;
    let handled = false;
    if (isFeatureEnabled('textMove') && !event.shiftKey && event.code === 'BracketRight') {
      handled = helper.moveTextToAdjacentSegment(1);
      if (handled && helper.analytics) {
        helper.analytics.record('hotkey:text-move', { direction: 'right' });
      }
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return handled;
  }, 94);
}
