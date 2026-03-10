(function quickRegionAutocompleteBridge() {
  const TOGGLE_EVENT = 'babel-helper-quick-region-autocomplete-toggle';
  const QUICK_TEXTAREA_SELECTOR = 'textarea[placeholder^="Enter text for this region"]';
  const ROW_TEXTAREA_SELECTOR = 'textarea[placeholder^="What was said"]';
  const LISTBOX_ATTR = 'data-babel-helper-quick-region-listbox';
  const DISMISS_DELAY_MS = 150;
  const MAX_SUGGESTIONS = 100;

  let enabled = false;
  let bound = false;
  let dismissTimer = 0;

  const state = {
    isOpen: false,
    suggestions: [] as Array<{ label: string; insertText: string; type: string }>,
    highlightedIndex: 0,
    position: null as null | { top: number; left: number }
  };

  const contextState = {
    current: null as null | {
      context: { type: string; open: string; close: string };
      partial: string;
      triggerIndex: number;
      cursorPosition: number;
      fullText: string;
      wrapSelection: null | {
        textarea: HTMLTextAreaElement;
        fullText: string;
        selectionStart: number;
        selectionEnd: number;
        selectedText: string;
      };
    }
  };

  const pendingWrapSelection = {
    current: null as null | {
      textarea: HTMLTextAreaElement;
      fullText: string;
      selectionStart: number;
      selectionEnd: number;
      selectedText: string;
    }
  };

  const selectionRestoreState = {
    token: 0
  };

  const pendingNativeRowAutocomplete = {
    current: null as null | {
      textarea: HTMLTextAreaElement;
      beforeValue: string;
      triggerIndex: number;
      cursorPosition: number;
      context: { type: string; open: string; close: string };
      suggestions: Array<{ label: string; insertText: string; type: string }>;
    }
  };

  type TextareaSelectionDirection = 'forward' | 'backward' | 'none';

  let listboxRoot: HTMLUListElement | null = null;

  function getReactFiber(element: unknown) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    for (const key of Object.getOwnPropertyNames(element)) {
      if (key.startsWith('__reactFiber$')) {
        return (element as unknown as Record<string, unknown>)[key] ?? null;
      }
    }

    return null;
  }

  function getAutocompleteConfigFromMemoizedState(memoizedState: unknown) {
    if (!Array.isArray(memoizedState) || !memoizedState.length) {
      return null;
    }

    const candidate = memoizedState[0];
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const config = candidate as {
      bracketTags?: unknown;
      styleTags?: unknown;
      bracketTypes?: unknown;
    };

    if (
      !Array.isArray(config.bracketTags) &&
      !Array.isArray(config.styleTags) &&
      !Array.isArray(config.bracketTypes)
    ) {
      return null;
    }

    return config;
  }

  function findAutocompleteConfig(textarea: HTMLTextAreaElement) {
    let fiber: any = getReactFiber(textarea);
    let depth = 0;

    while (fiber && depth < 24) {
      let hook: any = fiber.memoizedState ?? null;
      let hookIndex = 0;

      while (hook && hookIndex < 32) {
        const config = getAutocompleteConfigFromMemoizedState(hook.memoizedState);
        if (config) {
          return config;
        }

        hook = hook.next ?? null;
        hookIndex += 1;
      }

      fiber = fiber.return ?? null;
      depth += 1;
    }

    return null;
  }

  function getBridgeData() {
    const sourceTextarea = document.querySelector(ROW_TEXTAREA_SELECTOR);
    if (!(sourceTextarea instanceof HTMLTextAreaElement)) {
      return null;
    }

    const config = findAutocompleteConfig(sourceTextarea);
    if (!config) {
      return null;
    }

    const bracketTypes = Array.isArray(config.bracketTypes) ? config.bracketTypes : [];
    const bracketTags = Array.isArray(config.bracketTags) ? [...config.bracketTags].sort((a, b) => a.localeCompare(b)) : [];
    const styleTags = Array.isArray(config.styleTags) ? [...config.styleTags].sort((a, b) => a.localeCompare(b)) : [];
    const curlyTags = ['MIS: ', 'PRO: '];

    const openMap = new Map<string, { type: string; open: string; close: string }>();
    for (const bracketType of bracketTypes) {
      if (bracketType && typeof bracketType.open === 'string' && typeof bracketType.close === 'string') {
        openMap.set(bracketType.open, {
          type: 'bracket',
          open: bracketType.open,
          close: bracketType.close
        });
      }
    }

    openMap.set('<', { type: 'style', open: '<', close: '>' });
    openMap.set('{', { type: 'curly', open: '{', close: '}' });

    const stopSet = new Set<string>();
    for (const bracketType of bracketTypes) {
      if (bracketType && typeof bracketType.close === 'string') {
        stopSet.add(bracketType.close);
      }
    }
    stopSet.add('>');
    stopSet.add('}');

    return {
      bracketTags,
      styleTags,
      curlyTags,
      openMap,
      stopSet
    };
  }

  function isQuickTextarea(target: EventTarget | null): target is HTMLTextAreaElement {
    return target instanceof HTMLTextAreaElement && target.matches(QUICK_TEXTAREA_SELECTOR);
  }

  function isRowTextarea(target: EventTarget | null): target is HTMLTextAreaElement {
    return target instanceof HTMLTextAreaElement && target.matches(ROW_TEXTAREA_SELECTOR);
  }

  function isSupportedTextarea(target: EventTarget | null): target is HTMLTextAreaElement {
    return isQuickTextarea(target) || isRowTextarea(target);
  }

  function getActiveSupportedTextarea() {
    const active = document.activeElement;
    return isSupportedTextarea(active) ? active : null;
  }

  function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (typeof setter === 'function') {
      setter.call(textarea, value);
    } else {
      textarea.value = value;
    }
  }

  function dispatchInputEvent(textarea: HTMLTextAreaElement) {
    textarea.dispatchEvent(
      typeof InputEvent === 'function'
        ? new InputEvent('input', {
            bubbles: true,
            cancelable: false,
            data: null,
            inputType: 'insertText'
          })
        : new Event('input', {
            bubbles: true,
            cancelable: false
          })
    );
  }

  function setTextareaSelection(
    textarea: HTMLTextAreaElement,
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
    direction: TextareaSelectionDirection = 'none',
    attempts = 6
  ) {
    selectionRestoreState.token += 1;
    const token = selectionRestoreState.token;
    let remaining = Math.max(1, attempts);

    const apply = () => {
      if (selectionRestoreState.token !== token || !textarea.isConnected) {
        return;
      }

      textarea.focus({ preventScroll: true });
      setTextareaSelection(textarea, start, end, direction);
      remaining -= 1;
      if (remaining > 0) {
        window.requestAnimationFrame(apply);
      }
    };

    apply();
  }

  function getInsertedSuggestionCursorPosition(
    context: { type: string; open: string; close: string },
    triggerIndex: number,
    suggestion: { label: string; insertText: string; type: string }
  ) {
    if (context.type === 'style') {
      return triggerIndex + 1 + suggestion.label.length + 2;
    }

    if (context.type === 'curly') {
      return triggerIndex + suggestion.insertText.length - 1;
    }

    return triggerIndex + suggestion.insertText.length;
  }

  function matchNativeRowAutocompleteInsertion(
    pending: NonNullable<typeof pendingNativeRowAutocomplete.current>,
    nextValue: string
  ) {
    const before = pending.beforeValue.substring(0, pending.triggerIndex);
    const after = pending.beforeValue.substring(pending.cursorPosition);

    for (const suggestion of pending.suggestions) {
      const expectedValue = `${before}${suggestion.insertText}${after}`;
      if (expectedValue !== nextValue) {
        continue;
      }

      return {
        suggestion,
        caret: getInsertedSuggestionCursorPosition(pending.context, pending.triggerIndex, suggestion)
      };
    }

    return null;
  }

  function scheduleNativeRowAutocompleteCaretRestore(
    pending: NonNullable<typeof pendingNativeRowAutocomplete.current>
  ) {
    let attempts = 6;

    const apply = () => {
      if (pendingNativeRowAutocomplete.current !== pending) {
        return;
      }

      const textarea = pending.textarea;
      if (!(textarea instanceof HTMLTextAreaElement) || !textarea.isConnected) {
        pendingNativeRowAutocomplete.current = null;
        return;
      }

      const match = matchNativeRowAutocompleteInsertion(pending, textarea.value);
      if (match) {
        const currentStart =
          typeof textarea.selectionStart === 'number' ? textarea.selectionStart : -1;
        const currentEnd =
          typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : -1;
        if (currentStart !== match.caret || currentEnd !== match.caret) {
          textarea.focus({ preventScroll: true });
          setTextareaSelection(textarea, match.caret, match.caret);
        }
      }

      attempts -= 1;
      if (attempts <= 0) {
        if (pendingNativeRowAutocomplete.current === pending) {
          pendingNativeRowAutocomplete.current = null;
        }
        return;
      }

      window.requestAnimationFrame(apply);
    };

    window.requestAnimationFrame(apply);
  }

  function maybeTrackNativeRowAutocompleteEnter(textarea: HTMLTextAreaElement, event: KeyboardEvent) {
    if (
      !isRowTextarea(textarea) ||
      event.key !== 'Enter' ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      state.isOpen
    ) {
      return;
    }

    const selectionStart =
      typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length;
    const selectionEnd =
      typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : selectionStart;
    if (selectionStart !== selectionEnd) {
      return;
    }

    const data = getBridgeData();
    if (!data) {
      return;
    }

    const textBeforeCursor = textarea.value.substring(0, selectionStart);
    const trigger = findTriggerContext(textBeforeCursor, data.openMap, data.stopSet);
    if (!trigger) {
      return;
    }

    const suggestions = getSuggestions(trigger.context, trigger.partial, data);
    if (!suggestions.length) {
      return;
    }

    const triggerIndex = textBeforeCursor.length - trigger.partial.length - 1;
    pendingNativeRowAutocomplete.current = {
      textarea,
      beforeValue: textarea.value,
      triggerIndex,
      cursorPosition: selectionStart,
      context: trigger.context,
      suggestions
    };
    scheduleNativeRowAutocompleteCaretRestore(pendingNativeRowAutocomplete.current);
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

  function scheduleDismiss() {
    clearDismissTimer();
    dismissTimer = window.setTimeout(() => {
      dismissTimer = 0;
      dismiss();
    }, DISMISS_DELAY_MS);
  }

  function getCaretPosition(textarea: HTMLTextAreaElement, index: number, isRtl: boolean, suggestionCount: number) {
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

  function renderListbox() {
    if (!listboxRoot) {
      return;
    }

    if (!state.isOpen || !state.position || !state.suggestions.length) {
      listboxRoot.replaceChildren();
      listboxRoot.style.display = 'none';
      return;
    }

    listboxRoot.style.display = 'block';
    listboxRoot.style.top = `${state.position.top}px`;
    listboxRoot.style.left = `${state.position.left}px`;

    const fragment = document.createDocumentFragment();
    state.suggestions.forEach((suggestion, index) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', index === state.highlightedIndex ? 'true' : 'false');
      item.dataset.quickRegionSuggestionIndex = String(index);
      item.className =
        index === state.highlightedIndex
          ? 'cursor-pointer select-none px-3 py-1.5 text-xs bg-accent text-accent-foreground'
          : 'cursor-pointer select-none px-3 py-1.5 text-xs hover:bg-accent/50';

      const label = document.createElement('span');
      label.className = 'font-mono font-semibold text-blue-600 dark:text-blue-400';
      label.textContent = suggestion.label;
      item.appendChild(label);
      fragment.appendChild(item);
    });

    listboxRoot.replaceChildren(fragment);
  }

  function ensureListboxRoot() {
    if (listboxRoot) {
      return listboxRoot;
    }

    const root = document.createElement('ul');
    root.setAttribute('role', 'listbox');
    root.setAttribute(LISTBOX_ATTR, 'true');
    root.className =
      'fixed z-[9999] max-h-[140px] min-w-[180px] overflow-y-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-lg';
    root.style.display = 'none';
    document.body.appendChild(root);
    listboxRoot = root;
    return root;
  }

  function openWrapSuggestions(textarea: HTMLTextAreaElement, wrapSelection: NonNullable<typeof pendingWrapSelection.current>) {
    const data = getBridgeData();
    if (!data) {
      dismiss();
      return;
    }

    const suggestions = getSuggestions({ type: 'style', open: '<', close: '>' }, '', data);
    if (!suggestions.length) {
      dismiss();
      return;
    }

    const isRtl = (textarea.dir || document.documentElement.dir || '').toLowerCase() === 'rtl';
    const position = getCaretPosition(textarea, wrapSelection.selectionStart, isRtl, suggestions.length);

    clearDismissTimer();
    state.isOpen = true;
    state.suggestions = suggestions;
    state.highlightedIndex = 0;
    state.position = position;
    contextState.current = {
      context: { type: 'style', open: '<', close: '>' },
      partial: '',
      triggerIndex: wrapSelection.selectionStart,
      cursorPosition: wrapSelection.selectionStart,
      fullText: wrapSelection.fullText,
      wrapSelection
    };
    renderListbox();
  }

  function openForTextarea(textarea: HTMLTextAreaElement) {
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
    const isRtl = (textarea.dir || document.documentElement.dir || '').toLowerCase() === 'rtl';
    const position = getCaretPosition(textarea, cursorPosition, isRtl, suggestions.length);

    clearDismissTimer();
    state.isOpen = true;
    state.suggestions = suggestions;
    state.highlightedIndex = 0;
    state.position = position;
    contextState.current = {
      context: trigger.context,
      partial: trigger.partial,
      triggerIndex,
      cursorPosition,
      fullText: textarea.value,
      wrapSelection:
        trigger.context.type === 'style' &&
        pendingWrapSelection.current &&
        pendingWrapSelection.current.textarea === textarea &&
        pendingWrapSelection.current.selectionStart === triggerIndex
          ? pendingWrapSelection.current
          : null
    };

    if (trigger.context.type !== 'style') {
      pendingWrapSelection.current = null;
    }
    renderListbox();
  }

  function insertSuggestion(textarea: HTMLTextAreaElement, suggestionIndex: number) {
    const suggestion = state.suggestions[suggestionIndex];
    const context = contextState.current;
    if (!suggestion || !context) {
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

    setNativeTextareaValue(textarea, `${before}${insertText}${after}`);
    textarea.focus({ preventScroll: true });
    setTextareaSelection(textarea, nextCursorPosition, nextCursorPosition);
    dispatchInputEvent(textarea);
    restoreSelectionStably(textarea, nextCursorPosition, nextCursorPosition);
    pendingWrapSelection.current = null;
    dismiss();
    return true;
  }

  function onBeforeInput(event: InputEvent) {
    const textarea = isSupportedTextarea(event.target) ? event.target : null;
    if (!textarea) {
      return;
    }

    if (
      event.inputType === 'insertText' &&
      event.data === '<' &&
      typeof textarea.selectionStart === 'number' &&
      typeof textarea.selectionEnd === 'number' &&
      textarea.selectionStart !== textarea.selectionEnd
    ) {
      event.preventDefault();
      pendingWrapSelection.current = {
        textarea,
        fullText: textarea.value,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        selectedText: textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
      };
      textarea.setSelectionRange(textarea.selectionStart, textarea.selectionStart);
      openWrapSuggestions(textarea, pendingWrapSelection.current);
      return;
    }

    if (
      pendingWrapSelection.current &&
      pendingWrapSelection.current.textarea === textarea &&
      event.inputType !== 'insertText' &&
      event.inputType !== 'insertCompositionText'
    ) {
      pendingWrapSelection.current = null;
    }
  }

  function onInput(event: Event) {
    if (!isQuickTextarea(event.target)) {
      return;
    }

    openForTextarea(event.target);
  }

  function onClick(event: MouseEvent) {
    const target = event.target as Element | null;
    const activeSupportedTextarea = getActiveSupportedTextarea();

    if (isQuickTextarea(target)) {
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
    const textarea = isSupportedTextarea(event.target) ? event.target : null;
    if (!textarea || event.isComposing) {
      return;
    }

    maybeTrackNativeRowAutocompleteEnter(textarea, event);

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
    if (!isSupportedTextarea(target)) {
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
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusout', onFocusOut, true);
    bound = true;
  }

  function unbind() {
    if (!bound) {
      return;
    }

    document.removeEventListener('beforeinput', onBeforeInput, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('focusout', onFocusOut, true);
    bound = false;
    pendingWrapSelection.current = null;
    dismiss();
  }

  window.addEventListener(TOGGLE_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<{ enabled?: boolean }>).detail || {};
    enabled = Boolean(detail.enabled);
    if (enabled) {
      bind();
    } else {
      unbind();
    }
  });
})();
