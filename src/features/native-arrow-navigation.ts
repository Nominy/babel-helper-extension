// @ts-nocheck
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';

export function registerNativeArrowInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled } = input;
  function shouldSuppressNativeArrowHotkey(event) {
    if (!isFeatureEnabled('disableNativeArrowSeek')) {
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
  hooks.on('bubble', (event) => {
    if (!shouldSuppressNativeArrowHotkey(event)) {
      return false;
    }
    // Native Slate must receive the event first. Only prevent propagation from
    // document to Babel's outer window listener, not native caret handling.
    event.stopPropagation();
    if (helper.analytics) {
      helper.analytics.record('hotkey:arrow-suppressed', { key: event.key, ctrlKey: event.ctrlKey });
    }
    return true;
  }, 40);
}
