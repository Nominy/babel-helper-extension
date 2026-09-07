// @ts-nocheck
import type { EditorHooks } from '../core/editor-hooks';
import type { EditorInputState } from './editor-input';

export function registerPlaybackRewindInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled, isTypingInTextControl } = input;
  function matchPlaybackRewindShortcut(event) {
    const shortcuts = Array.isArray(helper.config.playbackRewindShortcuts)
      ? helper.config.playbackRewindShortcuts
      : [];

    function matchesShortcutCode(shortcut) {
      const eventKeyCode = Number.isFinite(Number(event.keyCode)) ? Number(event.keyCode) : null;
      if (Array.isArray(shortcut.codes) && shortcut.codes.includes(event.code)) {
        return true;
      }

      if (shortcut.code && shortcut.code === event.code) {
        return true;
      }

      if (eventKeyCode != null && Number.isFinite(Number(shortcut.keyCode))) {
        return Number(shortcut.keyCode) === eventKeyCode;
      }

      return false;
    }

    return (
      shortcuts.find(
        (shortcut) =>
          shortcut &&
          matchesShortcutCode(shortcut) &&
          Boolean(shortcut.ctrlKey) === Boolean(event.ctrlKey) &&
          Boolean(shortcut.altKey) === Boolean(event.altKey) &&
          Boolean(shortcut.shiftKey) === Boolean(event.shiftKey) &&
          Boolean(shortcut.metaKey) === Boolean(event.metaKey) &&
          Number.isFinite(Number(shortcut.seconds))
      ) || null
    );
  }
  hooks.on('keydown', (event) => {
    const rewindShortcut = isFeatureEnabled('rowActions') ? matchPlaybackRewindShortcut(event) : null;
    if (rewindShortcut) {
      const handled =
        typeof helper.seekPlaybackBySeconds === 'function' &&
        helper.seekPlaybackBySeconds(-Number(rewindShortcut.seconds));
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
        if (helper.analytics) {
          helper.analytics.record('hotkey:rewind', { seconds: Number(rewindShortcut.seconds), code: event.code });
        }
      }
      return true;
    }
  }, 70);
}
