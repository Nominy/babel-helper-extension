// @ts-nocheck
import { matchesShortcut } from '../core/shortcuts';
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';
import { autoConvertSelectedNumberText, isTextControl, getSelectedTextFromTextControl, convertSelectionWithDigit } from '../hooks/selected-number-to-skaz';

export function registerSelectedNumberInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;

  hooks.on('keydown', (event) => {
    if (
      isFeatureEnabled('selectedNumberToSkaz') &&
      event.code.startsWith('Digit') &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      const target = event.target;
      if (isTextControl(target)) {
        const selectedText = getSelectedTextFromTextControl(target);
        if (selectedText && selectedText.trim().length > 0) {
          const handled = convertSelectionWithDigit(target, event.key);
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
            if (helper.analytics) {
              helper.analytics.record('hotkey:number-entry-immediate', { key: event.key });
            }
            return true;
          }
        }
      }
    }
    if (
      isFeatureEnabled('selectedNumberToSkaz') &&
      matchesShortcut(helper.config?.shortcuts, 'number.convert', event, helper.state?.rightShiftPressed)
    ) {
      const handled = autoConvertSelectedNumberText(event.target);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
        if (helper.analytics) {
          helper.analytics.record('hotkey:selected-number-auto-convert', {
            ctrlKey: event.ctrlKey
          });
        }
      }
      return true;
    }
  }, 80);
}
