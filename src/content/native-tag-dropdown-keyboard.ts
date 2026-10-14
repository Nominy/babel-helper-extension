import { readBabelTurnIdentity } from '@nominy/babel-babel-runtime';
import { TAG_DROPDOWN_KEYBOARD_ATTRIBUTE } from '../features/native-tag-dropdown-keyboard-feature';
import {
  findNativeDescendant, findNativeTurnFiber, readNativeSlateSelection, TRANSCRIPT_ROW_SELECTOR
} from './native-transcript';

interface WrapState {
  kind: string;
  span: { start: number; end: number };
  filter: string;
  highlighted: number;
  byKeyboard: boolean;
}

interface NativePickerHook {
  memoizedState?: unknown;
  queue?: { dispatch?: (update: (state: WrapState | null) => WrapState | null) => void };
  next?: NativePickerHook;
}

interface NativePickerFiber {
  stateNode?: unknown;
  memoizedProps?: {
    editor?: { children?: unknown[]; apply?: unknown };
    insertion?: {
      wrap?: { state?: WrapState; options?: unknown[] };
      pickWrap?: (option: unknown) => void;
    };
  };
  memoizedState?: NativePickerHook;
}

/** MAIN-world capture, before Slate closes a mouse-opened wrap picker on keydown. */
export function handleNativeTagDropdownKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
      event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') ||
      document.documentElement.getAttribute(TAG_DROPDOWN_KEYBOARD_ATTRIBUTE) !== 'true') return;

  const target = event.target instanceof Element ? event.target : null;
  const editable = target?.closest('[data-slate-editor="true"]');
  const row = editable?.closest(TRANSCRIPT_ROW_SELECTOR);
  const annotationId = row?.getAttribute('data-annotation-id');
  if (!editable?.isConnected || !annotationId) return;
  const identity = readBabelTurnIdentity(annotationId);
  if (!identity || identity.readOnly) return;

  const turn = findNativeTurnFiber(annotationId);
  // Resolve only the committed editor owning this DOM target, never an old task's picker.
  const host = findNativeDescendant(turn, (fiber: NativePickerFiber) => fiber.stateNode === editable);
  if (!host) return;
  const slate = findNativeDescendant(turn, (fiber: NativePickerFiber) => {
    const editor = fiber.memoizedProps?.editor;
    return editor && Array.isArray(editor.children) && typeof editor.apply === 'function';
  })?.memoizedProps.editor;
  const picker = findNativeDescendant(turn, (fiber: NativePickerFiber) => {
    const insertion = fiber.memoizedProps?.insertion;
    return insertion?.wrap?.state?.kind === 'style' &&
      Array.isArray(insertion.wrap.options) && typeof insertion.pickWrap === 'function';
  })?.memoizedProps.insertion;
  const state: WrapState | undefined = picker?.wrap.state;
  const selection = slate && readNativeSlateSelection(slate);
  // Keyboard-opened menus already implement navigation/filtering themselves.
  if (!state || state.byKeyboard !== false || !selection ||
      state.span.start !== selection.start || state.span.end !== selection.end ||
      selection.start === selection.end || !picker.wrap.options.length) return;

  if (event.key === 'Enter') {
    const option = picker.wrap.options[state.highlighted];
    if (!option) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Native pickWrap uses its held span and replaceText's new Slate undo batch.
    picker.pickWrap(option);
    return;
  }

  // The native wrap controller exposes no highlight setter. Locate its actual
  // useState dispatch by state identity, not hook index or a stale alternate.
  const owner = findNativeDescendant(turn, (fiber: NativePickerFiber) => {
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      if (hook.memoizedState === state && typeof hook.queue?.dispatch === 'function') return true;
    }
    return false;
  });
  if (!owner) return;
  for (let hook = owner.memoizedState; hook; hook = hook.next) {
    if (hook.memoizedState !== state || typeof hook.queue?.dispatch !== 'function') continue;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const count = picker.wrap.options.length;
    event.preventDefault();
    event.stopImmediatePropagation();
    hook.queue.dispatch((current: WrapState | null) => {
      if (!current || current.span !== state.span || current.kind !== state.kind ||
          current.filter !== state.filter || current.byKeyboard !== false) return current;
      return { ...current, highlighted: (current.highlighted + step + count) % count };
    });
    return;
  }
}
