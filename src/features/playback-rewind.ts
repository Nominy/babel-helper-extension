// @ts-nocheck
import { matchesShortcut } from '../core/shortcuts';
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';

export function registerPlaybackRewindInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;
  hooks.on('keydown', (event) => {
    if (isFeatureEnabled('rowActions') && matchesShortcut(helper.config?.shortcuts, 'playback.rewind', event, helper.state?.rightShiftPressed)) {
      const handled =
        typeof helper.seekPlaybackBySeconds === 'function' &&
        helper.seekPlaybackBySeconds(-1);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
        if (helper.analytics) {
          helper.analytics.record('hotkey:rewind', { seconds: 1, code: event.code });
        }
      }
      return true;
    }
  }, 70);
}
