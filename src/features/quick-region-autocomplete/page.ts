import { themeRoot } from '@nominy/babel-extension-frontend';
import {
  getAngleTagPartBackspaceEdit,
  shouldHandleAngleTagPartBackspaceEvent
} from '../../content/tag-part-backspace';
import { type EditorControl, isEditorControl, getEditorControlFromTarget } from '../../site/editor-control';
import { readBabelTranscriptBindings } from '@nominy/babel-babel-runtime';

type TextControl = HTMLTextAreaElement | EditorControl;
const controlElement = (control: TextControl): HTMLElement =>
  control instanceof HTMLTextAreaElement ? control : control.element || control.row;
const sameControl = (left: TextControl, right: TextControl): boolean =>
  left === right || (isEditorControl(left) && isEditorControl(right) && left.row === right.row);

(function quickRegionAutocompleteBridge() {
  if ((window as any).__babelHelperQuickRegionAutocompleteBridge) {
    return;
  }

  const TOGGLE_EVENT = 'babel-helper-quick-region-autocomplete-toggle';
  const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
  const SERVICE_ID = 'page.quickRegionAutocomplete';
  const QUICK_TEXTAREA_SELECTOR = 'textarea[placeholder^="Enter text for this region"]';
  const LISTBOX_ATTR = 'data-babel-helper-quick-region-listbox';
  const DISMISS_DELAY_MS = 150;
  const MAX_SUGGESTIONS = 100;
  const SELECTION_RESTORE_INTENT_EVENTS = [
    'keydown', 'pointerdown', 'mousedown', 'beforeinput', 'input', 'focusin', 'focusout'
  ] as const;

  let enabled = false;
  let bound = false;
  let dismissTimer = 0;
  let mouseMoveBound = false;
  let serviceRegistry: any = null;
  let serviceProviderHandle: { dispose(): void } | null = null;

  const state = {
    isOpen: false,
    suggestions: [] as Array<{ label: string; insertText: string; type: string }>,
    highlightedIndex: 0,
    position: null as null | { top: number; left: number }
  };

  const contextState = {
    current: null as null | {
      owner: TextControl;
      route: string;
      context: { type: string; open: string; close: string };
      partial: string;
      triggerIndex: number;
      cursorPosition: number;
      fullText: string;
      wrapSelection: null | {
        textarea: TextControl;
        fullText: string;
        selectionStart: number;
        selectionEnd: number;
        selectedText: string;
      };
    }
  };

  const pendingWrapSelection = {
    current: null as null | {
      textarea: TextControl;
      fullText: string;
      selectionStart: number;
      selectionEnd: number;
      selectedText: string;
    }
  };

  const selectionRestoreState = {
    cancel: null as null | (() => void)
  };


  type TextareaSelectionDirection = 'forward' | 'backward' | 'none';

  let listboxRoot: HTMLUListElement | null = null;

  function getBridgeData() {
    const bindings = readBabelTranscriptBindings(document);
    if (!bindings || bindings.readOnly) return null;
    const config = bindings.transcript as {
      vocabulary?: { bracketTypes: Array<{ open: string; close: string }> };
      tagOptions?: { bracket: Array<{ name: string }>; style: Array<{ name: string }>; curly: Array<{ name: string }> };
    };
    if (!config?.vocabulary || !config?.tagOptions) return null;
    const { vocabulary, tagOptions } = config;
    const names = (options: Array<{ name: string }> = []) =>
      [...new Set(options.map((option) => option.name))].sort((a, b) => a.localeCompare(b));
    const bracketTags = names(tagOptions.bracket);
    const styleTags = names(tagOptions.style);
    const curlyTags = names(tagOptions.curly).map((name) => `${name.replace(/:\s*$/, '')}: `);
    const openMap = new Map<string, { type: string; open: string; close: string }>();
    const stopSet = new Set<string>();
    for (const { open, close } of vocabulary.bracketTypes) {
      openMap.set(open, { type: 'bracket', open, close });
      stopSet.add(close);
    }
    openMap.set('<', { type: 'style', open: '<', close: '>' });
    openMap.set('{', { type: 'curly', open: '{', close: '}' });
    stopSet.add('>');
    stopSet.add('}');
    return { bracketTags, styleTags, curlyTags, openMap, stopSet };
  }

  function isQuickTextarea(target: EventTarget | null): target is HTMLTextAreaElement {
    return target instanceof HTMLTextAreaElement && target.matches(QUICK_TEXTAREA_SELECTOR);
  }

  function getSupportedControl(target: EventTarget | null): TextControl | null {
    if (isQuickTextarea(target)) return target.disabled || target.readOnly ? null : target;
    const control = getEditorControlFromTarget(target);
    return control && !control.readOnly ? control : null;
  }

  function getActiveSupportedTextarea() {
    return getSupportedControl(document.activeElement);
  }

  function setNativeTextareaValue(textarea: TextControl, value: string, start: number, end: number): boolean {
    if (!textarea.isConnected || textarea.readOnly) return false;
    if (isEditorControl(textarea)) return textarea.replaceValue(value, { start, end, focus: true });
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (typeof setter === 'function') {
      setter.call(textarea, value);
    } else {
      textarea.value = value;
    }
    return true;
  }

  function dispatchInputEvent(textarea: TextControl, inputType = 'insertText') {
    if (isEditorControl(textarea)) return;
    textarea.dispatchEvent(
      typeof InputEvent === 'function'
        ? new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            data: null,
            inputType
          })
        : new Event('input', {
            bubbles: true,
            cancelable: false
          })
    );
  }

  function copyTextWithTemporaryTextarea(
    text: string,
    restoreTarget: TextControl,
    selectionStart: number,
    selectionEnd: number
  ) {
    const activeElement = document.activeElement;
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.tabIndex = -1;
    scratch.setAttribute('aria-hidden', 'true');
    scratch.style.position = 'fixed';
    scratch.style.left = '-9999px';
    scratch.style.top = '0';
    scratch.style.opacity = '0';

    document.body.appendChild(scratch);
    try {
      scratch.focus({ preventScroll: true });
      scratch.select();
      document.execCommand('copy');
    } catch (_error) {
      // Clipboard writes are best-effort in page-world script contexts.
    } finally {
      scratch.remove();
      if (restoreTarget.isConnected) {
        restoreTarget.focus({ preventScroll: true });
        setTextareaSelection(restoreTarget, selectionStart, selectionEnd);
      } else if (activeElement instanceof HTMLElement) {
        activeElement.focus({ preventScroll: true });
      }
    }
  }

  function writeRemovedTagPartToClipboard(
    text: string,
    textarea: TextControl,
    selectionStart: number,
    selectionEnd: number
  ) {
    const clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      void clipboard
        .writeText(text)
        .catch(() => {
          if (textarea.isConnected && !textarea.readOnly &&
              document.activeElement === controlElement(textarea) &&
              textarea.selectionStart === selectionStart && textarea.selectionEnd === selectionEnd) {
            copyTextWithTemporaryTextarea(text, textarea, selectionStart, selectionEnd);
          }
        });
      return;
    }

    copyTextWithTemporaryTextarea(text, textarea, selectionStart, selectionEnd);
  }

  function removeAngleTagPartOnBackspace(textarea: TextControl, event: KeyboardEvent) {
    if (
      !shouldHandleAngleTagPartBackspaceEvent(event) ||
      (textarea instanceof HTMLTextAreaElement && textarea.disabled) ||
      textarea.readOnly
    ) {
      return false;
    }

    const selectionStart =
      typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length;
    const selectionEnd =
      typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : selectionStart;
    const edit = getAngleTagPartBackspaceEdit(textarea.value, selectionStart, selectionEnd, {
      skipAdjacentSuffix: event.ctrlKey
    });
    if (!edit) {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    if (!setNativeTextareaValue(textarea, edit.nextValue, edit.selectionStart, edit.selectionEnd)) return false;
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.focus({ preventScroll: true });
      setTextareaSelection(textarea, edit.selectionStart, edit.selectionEnd);
      dispatchInputEvent(textarea, 'deleteContentBackward');
      restoreSelectionStably(textarea, edit.selectionStart, edit.selectionEnd, edit.nextValue);
    }
    writeRemovedTagPartToClipboard(edit.removedText, textarea, edit.selectionStart, edit.selectionEnd);
    dismiss();
    return true;
  }

  function setTextareaSelection(
    textarea: TextControl,
    start: number,
    end: number,
    direction: TextareaSelectionDirection = 'none'
  ) {
    try {
      textarea.setSelectionRange(start, end, direction);
    } catch (_error) {
      // Ignore selection failures while Babel is re-rendering the controlled textarea.
    }
  }

  function restoreSelectionStably(
    textarea: HTMLTextAreaElement,
    start: number,
    end: number,
    expectedValue: string,
    direction: TextareaSelectionDirection = 'none',
    attempts = 6
  ) {
    selectionRestoreState.cancel?.();
    if (!textarea.isConnected || document.activeElement !== controlElement(textarea)) {
      return;
    }

    // The input dispatch may synchronously commit a controlled value and move
    // the caret. Correct that commit, but never reclaim focus from another edit.
    setTextareaSelection(textarea, start, end, direction);
    const value = textarea.value;
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    const selectionDirection = textarea.selectionDirection;
    let remaining = Math.max(1, attempts) - 1;
    if (value === expectedValue || remaining === 0) {
      return;
    }

    let frame = 0;
    const cancel = () => {
      window.cancelAnimationFrame(frame);
      for (const type of SELECTION_RESTORE_INTENT_EVENTS) {
        document.removeEventListener(type, cancel, true);
      }
      document.removeEventListener('select', onSelectionChange, true);
      document.removeEventListener('selectionchange', onSelectionChange, true);
      if (selectionRestoreState.cancel === cancel) {
        selectionRestoreState.cancel = null;
      }
    };
    const canRestore = () => {
      if (!textarea.isConnected || document.activeElement !== controlElement(textarea)) {
        return false;
      }
      if (textarea.value !== value) {
        // A deferred controlled commit sets the intended value and collapses
        // selection at its end. An intervening input event cancels this first.
        return textarea.value === expectedValue &&
          textarea.selectionStart === expectedValue.length &&
          textarea.selectionEnd === expectedValue.length;
      }
      return textarea.selectionStart === selectionStart &&
        textarea.selectionEnd === selectionEnd &&
        textarea.selectionDirection === selectionDirection;
    };
    const onSelectionChange = () => {
      // Selection events are queued, including our own setSelectionRange calls.
      // Compare the live range, not event trust or a timeout-based suppression.
      if (!canRestore()) {
        cancel();
      }
    };
    const apply = () => {
      if (selectionRestoreState.cancel !== cancel) {
        return;
      }
      // Check before writing too: select-all may precede its selection event.
      if (!canRestore()) {
        cancel();
        return;
      }
      if (textarea.value !== value) {
        cancel();
        setTextareaSelection(textarea, start, end, direction);
        return;
      }
      remaining -= 1;
      if (remaining > 0) {
        frame = window.requestAnimationFrame(apply);
      } else {
        cancel();
      }
    };

    selectionRestoreState.cancel = cancel;
    for (const type of SELECTION_RESTORE_INTENT_EVENTS) {
      document.addEventListener(type, cancel, true);
    }
    document.addEventListener('select', onSelectionChange, true);
    document.addEventListener('selectionchange', onSelectionChange, true);
    frame = window.requestAnimationFrame(apply);
  }


  function clearDismissTimer() {
    if (dismissTimer) {
      window.clearTimeout(dismissTimer);
      dismissTimer = 0;
    }
  }

  function dismiss() {
    clearDismissTimer();
    state.isOpen = false;
    state.suggestions = [];
    state.highlightedIndex = 0;
    state.position = null;
    contextState.current = null;
    renderListbox();
  }

  function bindMouseMove() {
    if (mouseMoveBound) {
      return;
    }
    document.addEventListener('mousemove', serviceListeners.mousemove, true);
    mouseMoveBound = true;
  }

  function unbindMouseMove() {
    if (!mouseMoveBound) {
      return;
    }
    document.removeEventListener('mousemove', serviceListeners.mousemove, true);
    mouseMoveBound = false;
  }

  function scheduleDismiss() {
    clearDismissTimer();
    dismissTimer = window.setTimeout(() => {
      dismissTimer = 0;
      dismiss();
    }, DISMISS_DELAY_MS);
  }

  function getCaretPosition(textarea: TextControl, index: number, isRtl: boolean, suggestionCount: number) {
    if (isEditorControl(textarea)) {
      const rect = textarea.getCaretRect(index) || controlElement(textarea).getBoundingClientRect();
      const height = 28 * Math.min(suggestionCount, 5) + 8;
      return {
        top: Math.max(10, rect.bottom + height > window.innerHeight ? rect.top - height : rect.bottom),
        left: Math.max(10, Math.min(rect.left, window.innerWidth - 190))
      };
    }
    const mirror = document.createElement('div');

    try {
      const computed = window.getComputedStyle(textarea);
      mirror.style.position = 'absolute';
      mirror.style.visibility = 'hidden';
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.wordWrap = 'break-word';
      mirror.style.overflow = 'hidden';
      mirror.style.width = `${textarea.clientWidth}px`;

      const copiedProps = [
        'fontFamily',
        'fontSize',
        'fontWeight',
        'fontStyle',
        'letterSpacing',
        'textTransform',
        'wordSpacing',
        'textIndent',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'borderTopWidth',
        'borderRightWidth',
        'borderBottomWidth',
        'borderLeftWidth',
        'lineHeight',
        'whiteSpace',
        'wordWrap',
        'overflowWrap',
        'direction'
      ] as const;

      for (const prop of copiedProps) {
        mirror.style[prop] = computed[prop];
      }

      if (isRtl) {
        mirror.style.direction = 'rtl';
        mirror.style.textAlign = 'right';
      }

      const beforeCaret = textarea.value.substring(0, index);
      mirror.appendChild(document.createTextNode(beforeCaret));
      const marker = document.createElement('span');
      marker.textContent = '\u200b';
      mirror.appendChild(marker);
      document.body.appendChild(mirror);

      const textareaRect = textarea.getBoundingClientRect();
      const mirrorRect = mirror.getBoundingClientRect();
      const markerRect = marker.getBoundingClientRect();

      let top = textareaRect.top + (markerRect.top - mirrorRect.top) - textarea.scrollTop;
      let left = textareaRect.left + (markerRect.left - mirrorRect.left) - textarea.scrollLeft;
      const popupHeight = 28 * Math.min(suggestionCount, 5) + 8;
      const viewport = {
        width: window.innerWidth,
        height: window.innerHeight
      };

      if (top + 14 + popupHeight > viewport.height) {
        top = Math.max(10, top - 2 - popupHeight);
      } else {
        top += 14;
      }

      if (left + 180 > viewport.width) {
        left = Math.max(10, viewport.width - 180 - 10);
      }

      return {
        top: Math.max(10, top),
        left: Math.max(10, left)
      };
    } finally {
      if (mirror.parentNode) {
        mirror.parentNode.removeChild(mirror);
      }
    }
  }

  function getSuggestions(
    context: { type: string; open: string; close: string },
    partial: string,
    data: NonNullable<ReturnType<typeof getBridgeData>>
  ) {
    const startsWith = (values: string[], query: string, limit: number) => {
      const lowerQuery = query.toLowerCase();
      return values
        .filter((value) => value.toLowerCase().startsWith(lowerQuery))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, limit);
    };

    switch (context.type) {
      case 'bracket':
        return startsWith(data.bracketTags, partial, MAX_SUGGESTIONS).map((label) => ({
          label,
          insertText: `${context.open}${label}${context.close}`,
          type: 'bracket'
        }));
      case 'style':
        return startsWith(data.styleTags, partial, MAX_SUGGESTIONS).map((label) => ({
          label,
          insertText: `<${label}> </${label}>`,
          type: 'style'
        }));
      case 'curly':
        return startsWith(data.curlyTags, partial, MAX_SUGGESTIONS).map((label) => ({
          label: label.trim(),
          insertText: `{${label}}`,
          type: label.trim() === 'PRO:' ? 'pro' : 'mis'
        }));
      default:
        return [];
    }
  }

  function findTriggerContext(
    textBeforeCursor: string,
    openMap: Map<string, { type: string; open: string; close: string }>,
    stopSet: Set<string>
  ) {
    for (let index = textBeforeCursor.length - 1; index >= 0; index -= 1) {
      const char = textBeforeCursor[index];
      const context = openMap.get(char);
      if (context) {
        const partial = textBeforeCursor.slice(index + 1);
        if (partial.includes(context.close) || (context.type === 'style' && partial.includes('/'))) {
          return null;
        }

        return {
          context,
          partial
        };
      }

      if (stopSet.has(char)) {
        break;
      }
    }

    return null;
  }

  function renderListbox(textarea = getActiveSupportedTextarea()) {
    if (!state.isOpen || !state.position || !state.suggestions.length || !textarea) {
      listboxRoot?.remove();
      listboxRoot = null;
      unbindMouseMove();
      return;
    }

    const root = ensureListboxRoot(textarea);
    const host = root.parentElement;
    let { top, left } = state.position;
    if (host && host !== document.body) {
      // Native dialogs are translated (and animate with scale), so their
      // absolute children use local padding-box rather than viewport coordinates.
      const rect = host.getBoundingClientRect();
      const scaleX = host.offsetWidth ? rect.width / host.offsetWidth : 1;
      const scaleY = host.offsetHeight ? rect.height / host.offsetHeight : 1;
      left = (left - rect.left) / (scaleX || 1) + host.scrollLeft - host.clientLeft;
      top = (top - rect.top) / (scaleY || 1) + host.scrollTop - host.clientTop;
    }

    bindMouseMove();
    root.style.display = 'block';
    root.style.top = `${top}px`;
    root.style.left = `${left}px`;

    const fragment = document.createDocumentFragment();
    state.suggestions.forEach((suggestion, index) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', index === state.highlightedIndex ? 'true' : 'false');
      item.dataset.quickRegionSuggestionIndex = String(index);
      item.className = 'bui-menu-item';

      const label = document.createElement('span');
      label.className = 'bui-code';
      label.textContent = suggestion.label;
      item.appendChild(label);
      fragment.appendChild(item);
    });

    root.replaceChildren(fragment);
  }

  function ensureListboxRoot(textarea: TextControl | null = null) {
    const host = textarea ? controlElement(textarea).closest<HTMLElement>('[role="dialog"], dialog') ?? document.body : document.body;
    if (listboxRoot?.parentElement === host && listboxRoot.isConnected) {
      return listboxRoot;
    }
    // A body-hosted root may have been hidden by the native modal manager.
    // Recreate it in the new owner instead of carrying aria-hidden across hosts.
    listboxRoot?.remove();

    const root = document.createElement('ul');
    root.setAttribute('role', 'listbox');
    root.setAttribute(LISTBOX_ATTR, 'true');
    root.className = 'bui-menu';
    themeRoot(root, 'white');
    root.style.display = 'none';
    root.style.position = host === document.body ? 'fixed' : 'absolute';
    root.style.pointerEvents = 'auto';
    root.style.zIndex = '2147483647';
    root.style.maxHeight = '140px';
    root.style.minWidth = '180px';
    root.style.overflowY = 'auto';
    host.appendChild(root);
    listboxRoot = root;
    return root;
  }

  function openWrapSuggestions(textarea: TextControl, wrapSelection: NonNullable<typeof pendingWrapSelection.current>) {
    const data = getBridgeData();
    if (!data) {
      dismiss();
      return false;
    }

    const suggestions = getSuggestions({ type: 'style', open: '<', close: '>' }, '', data);
    if (!suggestions.length) {
      dismiss();
      return false;
    }

    const isRtl = (controlElement(textarea).dir || document.documentElement.dir || '').toLowerCase() === 'rtl';
    const position = getCaretPosition(textarea, wrapSelection.selectionStart, isRtl, suggestions.length);

    clearDismissTimer();
    state.isOpen = true;
    state.suggestions = suggestions;
    state.highlightedIndex = 0;
    state.position = position;
    contextState.current = {
      owner: textarea,
      route: window.location.pathname + window.location.search,
      context: { type: 'style', open: '<', close: '>' },
      partial: '',
      triggerIndex: wrapSelection.selectionStart,
      cursorPosition: wrapSelection.selectionStart,
      fullText: wrapSelection.fullText,
      wrapSelection
    };
    renderListbox(textarea);
    return true;
  }

  function beginStyleWrap(textarea: TextControl): boolean {
    const nativeState = isEditorControl(textarea) ? textarea.state : null;
    const selectionStart = nativeState?.start ?? textarea.selectionStart;
    const selectionEnd = nativeState?.end ?? textarea.selectionEnd;
    if (selectionStart === selectionEnd) return false;
    const fullText = nativeState?.text ?? textarea.value;
    const wrapSelection = {
      textarea, fullText, selectionStart, selectionEnd,
      selectedText: fullText.slice(selectionStart, selectionEnd)
    };
    if (!openWrapSuggestions(textarea, wrapSelection)) return false;
    pendingWrapSelection.current = wrapSelection;
    textarea.setSelectionRange(selectionStart, selectionStart);
    return true;
  }

  function openForTextarea(textarea: TextControl) {
    if (textarea.readOnly || !textarea.isConnected) { dismiss(); return; }
    const data = getBridgeData();
    if (!data) {
      dismiss();
      return;
    }

    const cursorPosition =
      typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length;
    const textBeforeCursor = textarea.value.substring(0, cursorPosition);
    const trigger = findTriggerContext(textBeforeCursor, data.openMap, data.stopSet);
    if (!trigger) {
      dismiss();
      return;
    }

    const suggestions = getSuggestions(trigger.context, trigger.partial, data);
    if (!suggestions.length) {
      dismiss();
      return;
    }

    const triggerIndex = textBeforeCursor.length - trigger.partial.length - 1;
    const isRtl = (controlElement(textarea).dir || document.documentElement.dir || '').toLowerCase() === 'rtl';
    const position = getCaretPosition(textarea, cursorPosition, isRtl, suggestions.length);

    clearDismissTimer();
    state.isOpen = true;
    state.suggestions = suggestions;
    state.highlightedIndex = 0;
    state.position = position;
    contextState.current = {
      owner: textarea,
      route: window.location.pathname + window.location.search,
      context: trigger.context,
      partial: trigger.partial,
      triggerIndex,
      cursorPosition,
      fullText: textarea.value,
      wrapSelection:
        trigger.context.type === 'style' &&
        pendingWrapSelection.current &&
        sameControl(pendingWrapSelection.current.textarea, textarea) &&
        pendingWrapSelection.current.selectionStart === triggerIndex
          ? pendingWrapSelection.current
          : null
    };

    if (trigger.context.type !== 'style') {
      pendingWrapSelection.current = null;
    }
    renderListbox(textarea);
  }

  function insertSuggestion(textarea: TextControl, suggestionIndex: number) {
    const suggestion = state.suggestions[suggestionIndex];
    const context = contextState.current;
    if (!suggestion || !context || !sameControl(context.owner, textarea) ||
        context.route !== window.location.pathname + window.location.search ||
        textarea.readOnly || !textarea.isConnected || textarea.value !== context.fullText) {
      return false;
    }

    const wrapSelection = context.wrapSelection;
    const before = wrapSelection
      ? wrapSelection.fullText.substring(0, wrapSelection.selectionStart)
      : context.fullText.substring(0, context.triggerIndex);
    const after = wrapSelection
      ? wrapSelection.fullText.substring(wrapSelection.selectionEnd)
      : context.fullText.substring(context.cursorPosition);
    const insertText =
      context.context.type === 'style' && wrapSelection
        ? `<${suggestion.label}> ${wrapSelection.selectedText} </${suggestion.label}>`
        : suggestion.insertText;

    let nextCursorPosition = context.triggerIndex + insertText.length;
    if (context.context.type === 'style') {
      nextCursorPosition = wrapSelection
        ? before.length + insertText.length
        : context.triggerIndex + 1 + suggestion.label.length + 2;
    } else if (context.context.type === 'curly') {
      nextCursorPosition = context.triggerIndex + insertText.length - 1;
    }

    const nextValue = `${before}${insertText}${after}`;
    if (!setNativeTextareaValue(textarea, nextValue, nextCursorPosition, nextCursorPosition)) { dismiss(); return false; }
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.focus({ preventScroll: true });
      setTextareaSelection(textarea, nextCursorPosition, nextCursorPosition);
      dispatchInputEvent(textarea);
      restoreSelectionStably(textarea, nextCursorPosition, nextCursorPosition, nextValue);
    }
    pendingWrapSelection.current = null;
    dismiss();
    return true;
  }

  function onBeforeInput(event: InputEvent) {
    const textarea = getSupportedControl(event.target);
    if (!textarea) {
      return;
    }

    if (event.inputType === 'insertText' && event.data === '<' && beginStyleWrap(textarea)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (
      pendingWrapSelection.current &&
      sameControl(pendingWrapSelection.current.textarea, textarea) &&
      event.inputType !== 'insertText' &&
      event.inputType !== 'insertCompositionText'
    ) {
      pendingWrapSelection.current = null;
    }
  }

  function onInput(event: Event) {
    // Ordinary turn completion belongs to Slate's native tag picker. Only the
    // separate quick-region dialog lacks that picker; do not render two menus.
    if (isQuickTextarea(event.target) && !event.target.readOnly && !event.target.disabled) {
      openForTextarea(event.target);
    }
  }

  function onClick(event: MouseEvent) {
    const target = event.target as Element | null;
    const activeSupportedTextarea = getActiveSupportedTextarea();

    if (isQuickTextarea(target) && !target.readOnly && !target.disabled) {
      openForTextarea(target);
      return;
    }

    if (!activeSupportedTextarea) {
      dismiss();
      return;
    }

    const option = target?.closest?.(`[${LISTBOX_ATTR}="true"] [role="option"]`);
    if (!(option instanceof HTMLElement)) {
      dismiss();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const index = Number(option.dataset.quickRegionSuggestionIndex || '-1');
    if (index >= 0) {
      insertSuggestion(activeSupportedTextarea, index);
    }
  }

  function onMouseDown(event: MouseEvent) {
    const option = (event.target as Element | null)?.closest?.(`[${LISTBOX_ATTR}="true"] [role="option"]`);
    if (option instanceof HTMLElement) {
      clearDismissTimer();
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function onMouseMove(event: MouseEvent) {
    const option = (event.target as Element | null)?.closest?.(`[${LISTBOX_ATTR}="true"] [role="option"]`);
    if (!(option instanceof HTMLElement)) {
      return;
    }

    const index = Number(option.dataset.quickRegionSuggestionIndex || '-1');
    if (index < 0 || index === state.highlightedIndex) {
      return;
    }

    state.highlightedIndex = index;
    renderListbox();
  }

  function onKeyDown(event: KeyboardEvent) {
    const textarea = getSupportedControl(event.target);
    if (!textarea || event.isComposing) {
      return;
    }

    if (removeAngleTagPartOnBackspace(textarea, event)) {
      return;
    }

    // Slate consumes selected "<" on keydown and prevents beforeinput entirely.
    // Capture only selection wrapping; collapsed typing stays with its native picker.
    if (isEditorControl(textarea) && event.key === '<' &&
        !event.ctrlKey && !event.metaKey && !event.altKey && beginStyleWrap(textarea)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (!state.isOpen || !state.suggestions.length) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        state.highlightedIndex = (state.highlightedIndex + 1) % state.suggestions.length;
        renderListbox();
        return;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        state.highlightedIndex =
          (state.highlightedIndex - 1 + state.suggestions.length) % state.suggestions.length;
        renderListbox();
        return;
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        insertSuggestion(textarea, state.highlightedIndex);
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      default:
        return;
    }
  }

  function onFocusOut(event: FocusEvent) {
    const target = event.target;
    if (!getSupportedControl(target)) {
      return;
    }

    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Element && nextTarget.closest(`[${LISTBOX_ATTR}="true"]`)) {
      return;
    }

    scheduleDismiss();
  }

  function bind() {
    if (bound) {
      return;
    }

    ensureListboxRoot();
    document.addEventListener('beforeinput', serviceListeners.beforeinput, true);
    document.addEventListener('input', serviceListeners.input, true);
    document.addEventListener('click', serviceListeners.click, true);
    document.addEventListener('mousedown', serviceListeners.mousedown, true);
    document.addEventListener('keydown', serviceListeners.keydown, true);
    document.addEventListener('focusout', serviceListeners.focusout, true);
    bound = true;
  }

  function unbind() {
    selectionRestoreState.cancel?.();
    if (!bound) {
      return;
    }

    document.removeEventListener('beforeinput', serviceListeners.beforeinput, true);
    document.removeEventListener('input', serviceListeners.input, true);
    document.removeEventListener('click', serviceListeners.click, true);
    document.removeEventListener('mousedown', serviceListeners.mousedown, true);
    unbindMouseMove();
    document.removeEventListener('keydown', serviceListeners.keydown, true);
    document.removeEventListener('focusout', serviceListeners.focusout, true);
    bound = false;
    pendingWrapSelection.current = null;
    dismiss();
  }

  function setEnabled(nextEnabled: boolean) {
    enabled = Boolean(nextEnabled);
    if (enabled) {
      bind();
    } else {
      unbind();
    }
    return enabled;
  }

  const rawImplementation = {
    setEnabled,
    isEnabled: () => enabled,
    bind,
    unbind,
    dismiss,
    openForTextarea,
    insertSuggestion,
    onBeforeInput,
    onInput,
    onClick,
    onMouseDown,
    onMouseMove,
    onKeyDown,
    onFocusOut,
    state,
    contextState,
    pendingWrapSelection
  };
  const implementation = {
    setEnabled,
    isEnabled: rawImplementation.isEnabled,
    handleBeforeInput: onBeforeInput,
    handleInput: onInput,
    handleClick: onClick,
    handleMouseDown: onMouseDown,
    handleMouseMove: onMouseMove,
    handleKeyDown: onKeyDown,
    handleFocusOut: onFocusOut,
    raw: rawImplementation
  };

  function getHostServiceRegistry() {
    const services = (window as any).BabelMods?.unsafe?.services;
    return services && typeof services.invoke === 'function' ? services : null;
  }

  function ensureServiceProvider() {
    const currentRegistry = getHostServiceRegistry();
    if (!currentRegistry || typeof currentRegistry.provide !== 'function') {
      return null;
    }

    if (serviceRegistry === currentRegistry && serviceProviderHandle) {
      return currentRegistry;
    }

    serviceProviderHandle?.dispose();
    serviceRegistry = currentRegistry;
    serviceProviderHandle = currentRegistry.provide(SERVICE_ID, implementation, {
      owner: 'builtin:quick-region-autocomplete'
    });
    return currentRegistry;
  }

  function invokeService(method: string, ...args: any[]) {
    const currentRegistry = ensureServiceProvider();
    if (currentRegistry) {
      return currentRegistry.invoke(SERVICE_ID, method, ...args);
    }

    const operation = (implementation as any)[method];
    if (typeof operation !== 'function') {
      throw new TypeError(`Unknown ${SERVICE_ID} operation: ${String(method)}`);
    }
    return operation.apply(implementation, args);
  }

  const serviceListeners = {
    beforeinput: (event: InputEvent) => invokeService('handleBeforeInput', event),
    input: (event: Event) => invokeService('handleInput', event),
    click: (event: MouseEvent) => invokeService('handleClick', event),
    mousedown: (event: MouseEvent) => invokeService('handleMouseDown', event),
    mousemove: (event: MouseEvent) => invokeService('handleMouseMove', event),
    keydown: (event: KeyboardEvent) => invokeService('handleKeyDown', event),
    focusout: (event: FocusEvent) => invokeService('handleFocusOut', event)
  };

  function handleToggle(event: Event) {
    const detail = (event as CustomEvent<{ enabled?: boolean }>).detail || {};
    invokeService('setEnabled', Boolean(detail.enabled));
  }

  function dispose() {
    unbind();
    serviceProviderHandle?.dispose();
    serviceProviderHandle = null;
    serviceRegistry = null;
    listboxRoot?.remove();
    listboxRoot = null;
    window.removeEventListener(TOGGLE_EVENT, handleToggle, true);
    window.removeEventListener(TEARDOWN_EVENT, dispose, true);
    delete (window as any).__babelHelperQuickRegionAutocompleteBridge;
  }

  ensureServiceProvider();
  window.addEventListener(TOGGLE_EVENT, handleToggle, true);
  window.addEventListener(TEARDOWN_EVENT, dispose, true);
  (window as any).__babelHelperQuickRegionAutocompleteBridge = {
    setEnabled: (nextEnabled: boolean) => invokeService('setEnabled', nextEnabled),
    isEnabled: () => invokeService('isEnabled'),
    implementation: rawImplementation,
    dispose
  };
})();
