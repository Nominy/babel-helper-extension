// @ts-nocheck
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';

export function registerNativeArrowInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;
  function shouldSuppressNativeArrowHotkey(event) {
    if (!isFeatureEnabled('disableNativeArrowSeek')) {
      return false;
    }

    if (!helper.runtime.isSessionInteractive()) {
      return false;
    }

    if (event.defaultPrevented) {
      return false;
    }

    if (event.altKey) {
      return false;
    }

    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return false;
    }

    if (event.ctrlKey || event.metaKey) {
      return true;
    }

    return !event.shiftKey;
  }
  hooks.on('capture', (event) => {
    if (!shouldSuppressNativeArrowHotkey(event)) {
      return true;
    }
    event.stopImmediatePropagation();
    if (helper.analytics) {
      helper.analytics.record('hotkey:arrow-suppressed', { key: event.key, ctrlKey: event.ctrlKey });
    }
  }, 40);
}
