import { createEditorHooks } from '../core/editor-hooks';
import { isTextControl } from '../hooks/selected-number-to-skaz';
import { registerTimelineInput } from './timeline-selection-feature';
import { registerPlaybackSpeedInput } from './playback-speed-hotkeys';
import { registerGhostCursorInput } from './ghost-cursor';
import { registerFocusInput } from './focus-toggle-feature';
import { registerRowActionInput } from './row-actions-feature';
import { registerPlaybackRewindInput } from './playback-rewind';
import { registerSelectedNumberInput } from './selected-number-feature';
import { registerSpeakerInput } from './speaker-workflow';
import { registerTextMoveInput } from './text-move-feature';
import { registerLinterInput } from './custom-linter/feature';
import { registerNativeArrowInput } from './native-arrow-navigation';

export interface EditorInputState {
  isFeatureEnabled(key: string): boolean;
  isTypingInTextControl(event: KeyboardEvent): boolean;
}

// Only ordering and shared event eligibility belong here; shortcuts are owned
// by their feature modules and subscribe to the same hook surface.
export function createEditorInput(helper: any) {
  function isFeatureEnabled(featureKey: string) {
    if (typeof helper.isFeatureEnabled === 'function') {
      return helper.isFeatureEnabled(featureKey);
    }

    return true;
  }
  function isEditableTextTarget(element: EventTarget | null) {
    return Boolean(
      isTextControl(element) ||
      (typeof helper.isEditable === 'function' && helper.isEditable(element))
    );
  }
  function isTypingInTextControl(event: KeyboardEvent) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (isEditableTextTarget(target)) {
      return true;
    }

    return isEditableTextTarget(document.activeElement);
  }
  function updateRightShiftState(event: KeyboardEvent) {
    if (event.code === 'ShiftRight') {
      helper.state.rightShiftPressed = event.type === 'keydown';
      return;
    }

    if (!event.shiftKey) {
      helper.state.rightShiftPressed = false;
    }
  }
  function isDialogKeyboardEvent(event: KeyboardEvent) {
    // Nonmodal dialogs (for example an onboarding notice) do not own the
    // editor's keys. Only yield when this keyboard event originated in a dialog.
    return event.composedPath().some((node) =>
      node instanceof HTMLElement && node.matches('[role="dialog"], [role="alertdialog"], dialog[open]'));
  }
  const hooks = createEditorHooks();
  const input = { isFeatureEnabled, isTypingInTextControl };
  hooks.on('keydown', event => event.defaultPrevented, 20);
  registerTimelineInput(helper, hooks, input);
  registerPlaybackSpeedInput(helper, hooks, input);
  registerGhostCursorInput(helper, hooks, input);
  registerFocusInput(helper, hooks, input);
  registerRowActionInput(helper, hooks, input);
  registerPlaybackRewindInput(helper, hooks, input);
  registerSelectedNumberInput(helper, hooks, input);
  registerSpeakerInput(helper, hooks, input);
  registerTextMoveInput(helper, hooks, input);
  registerLinterInput(helper, hooks, input);
  registerNativeArrowInput(helper, hooks, input);
  return {
    hooks,
    handleKeydown(event: KeyboardEvent) {
      if (!helper.runtime.isSessionInteractive() || isDialogKeyboardEvent(event)) {
        return;
      }
      hooks.dispatch('keydown', event);
    },
    handleNativeArrowSuppress(event: KeyboardEvent) {
      updateRightShiftState(event);
      if (isDialogKeyboardEvent(event)) {
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const control = event.composedPath().find((node): node is HTMLElement =>
          node instanceof HTMLElement && node.matches(
            'input, textarea, select, [contenteditable="true"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="listbox"], [role="menu"], [role="tablist"], [role="tree"], [role="grid"]'
          ));
        // Suppress Babel's global seek, not a focused control's own navigation.
        // Transcript editors retain Helper's caret/segment-navigation behavior.
        if (control && !control.matches(helper.config.rowTextareaSelector)) {
          return;
        }
      }
      hooks.dispatch('capture', event);
    },
    handleGlobalKeyup(event: KeyboardEvent) {
      updateRightShiftState(event);
      if (isDialogKeyboardEvent(event)) {
        return;
      }
      hooks.dispatch('keyup', event);
    },
    handleWindowBlur() { helper.state.rightShiftPressed = false; }
  };
}
