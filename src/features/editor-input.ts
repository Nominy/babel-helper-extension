import { createEditorHooks } from '../core/editor-hooks';
import { isTextControl } from '../hooks/selected-number-to-skaz';
import { getEditorControlFromTarget } from '../site/editor-control';
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

const SELECTION_NAVIGATION_KEYS: Readonly<Record<string, true>> = {
  ArrowLeft: true, ArrowRight: true, ArrowUp: true, ArrowDown: true,
  Home: true, End: true, PageUp: true, PageDown: true
};

export interface EditorInputState {
  isFeatureEnabled(key: string): boolean;
  isTypingInTextControl(event: KeyboardEvent): boolean;
}

// Only ordering and shared event eligibility belong here; shortcuts are owned
// by their feature modules and subscribe to the same hook surface.
export function createEditorInput(helper: any) {
  let composing = false;
  function isFeatureEnabled(featureKey: string) {
    if (typeof helper.isFeatureEnabled === 'function') {
      return helper.isFeatureEnabled(featureKey);
    }

    return true;
  }
  function isEditableTextTarget(element: EventTarget | null) {
    return Boolean(
      getEditorControlFromTarget(element) ||
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
  function isDialogEvent(event: Event) {
    // Nonmodal notices do not own transcript input; only yield for an event
    // originating inside an actual dialog.
    return event.composedPath().some((node) =>
      node instanceof HTMLElement && node.matches('[role="dialog"], [role="alertdialog"], dialog[open]'));
  }
  function isAudioStrengthEvent(event: Event) {
    return event.composedPath?.().some(node =>
      node instanceof HTMLElement && node.matches('[data-babel-helper-audio-enhancement]')) === true;
  }
  function hasIndependentArrowControl(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false;
    const control = event.composedPath().find((node): node is HTMLElement =>
      node instanceof HTMLElement && node.matches(
        'input, textarea, select, [contenteditable="true"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="listbox"], [role="menu"], [role="tablist"], [role="tree"], [role="grid"]'
      ));
    return Boolean(control && !control.matches(helper.config.rowEditorSelector));
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
      if (!helper.runtime.isSessionInteractive() || isDialogEvent(event) || isAudioStrengthEvent(event)) {
        return;
      }
      if (!event.defaultPrevented && !composing && !event.isComposing && event.keyCode !== 229) {
        const editor = getEditorControlFromTarget(event.target);
        if ((event.key === 'PageDown' || event.key === 'PageUp') &&
            !event.altKey && !event.ctrlKey && !event.metaKey &&
            editor && editor.element === document.activeElement &&
            editor.element?.matches('[data-slate-editor="true"]') &&
            editor.pageSelection(event.key === 'PageDown' ? 'down' : 'up', event.shiftKey)) {
          // Own only focused native paging: browser default reveals every
          // scroll ancestor, while this command moves the caret and transcript.
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.code === 'KeyA' && (event.ctrlKey !== event.metaKey) &&
            !event.altKey && !event.shiftKey && editor && editor.element === document.activeElement &&
            editor.element?.matches('[data-slate-editor="true"]')) {
          // Select-all is an explicit native command, not a delayed DOM range
          // notification. Commit its known range before native render effects.
          if (editor.selectAll()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }
        // Slate can defer selectionchange past a modifier-triggered render.
        // Commit the actual browser selection before native shortcuts render it.
        if (SELECTION_NAVIGATION_KEYS[event.key] !== true) editor?.synchronizeSelection();
      }
      hooks.dispatch('keydown', event);
    },
    handleNativeTextInput(event: InputEvent | ClipboardEvent) {
      if (event.defaultPrevented || composing || ('isComposing' in event && event.isComposing) ||
          !helper.runtime.isSessionInteractive() || isDialogEvent(event) || isAudioStrengthEvent(event)) return;
      // Paste and browser text replacement can select DOM containers without
      // a preceding keydown. Slate must see that range before its own handler.
      getEditorControlFromTarget(event.target)?.synchronizeSelection();
    },
    handleNativeSelectionChange() {
      if (composing || !helper.runtime.isSessionInteractive()) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !active.isConnected ||
          !active.matches('[data-slate-editor="true"]')) return;
      const selection = document.getSelection();
      if (!selection || !active.contains(selection.anchorNode) || !active.contains(selection.focusNode)) return;
      // Native Slate throttles selectionchange. Its next render must not
      // overwrite a newer browser selection before keydown/beforeinput arrives.
      getEditorControlFromTarget(active)?.synchronizeSelection('selectionchange');
    },
    handleNativePointerDown(event: PointerEvent) {
      if (event.defaultPrevented || composing || !helper.runtime.isSessionInteractive() ||
          isDialogEvent(event) || isAudioStrengthEvent(event)) return;
      // A new pointer gesture supersedes an explicit focus/selection command;
      // it has not produced its final DOM range yet, so release ownership only.
      getEditorControlFromTarget(event.target)?.synchronizeSelection('intent');
    },
    handleComposition(event: CompositionEvent) {
      composing = event.type === 'compositionstart';
    },
    handleKeyCapture(event: KeyboardEvent) {
      updateRightShiftState(event);
      if (isDialogEvent(event) || isAudioStrengthEvent(event)) {
        return;
      }
      if (!event.defaultPrevented && !composing && !event.isComposing && event.keyCode !== 229 &&
          helper.runtime.isSessionInteractive() && SELECTION_NAVIGATION_KEYS[event.key] === true) {
        getEditorControlFromTarget(event.target)?.synchronizeSelection('intent');
      }
      if (hasIndependentArrowControl(event)) return;
      hooks.dispatch('capture', event);
    },
    handleKeyBubble(event: KeyboardEvent) {
      if (!helper.runtime.isSessionInteractive() || isDialogEvent(event) || isAudioStrengthEvent(event) ||
          hasIndependentArrowControl(event)) return;
      hooks.dispatch('bubble', event);
    },
    handleGlobalKeyup(event: KeyboardEvent) {
      updateRightShiftState(event);
      if (isDialogEvent(event) || isAudioStrengthEvent(event)) {
        return;
      }
      hooks.dispatch('keyup', event);
    },
    handleWindowBlur() { helper.state.rightShiftPressed = false; composing = false; }
  };
}
