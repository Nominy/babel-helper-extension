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

interface NativeInsertion {
  wrap?: { state?: WrapState | null; options?: unknown[] };
  tags?: { query?: { kind: string; start: number; options: unknown[] } | null; highlighted: number };
  pickWrap?: (option: unknown) => void;
  pickTag?: (option: unknown) => void;
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
    insertion?: NativeInsertion;
    options?: unknown[];
    highlighted?: number;
    onPick?: (option: unknown) => void;
    role?: string;
  };
  memoizedState?: NativePickerHook;
}

const scrollFrames = new WeakMap<Element, number>();

function readPicker(turn: NativePickerFiber | null): NativeInsertion | undefined {
  return findNativeDescendant(turn, (fiber: NativePickerFiber) => {
    const insertion = fiber.memoizedProps?.insertion;
    return (insertion?.wrap?.state && Array.isArray(insertion.wrap.options) && typeof insertion.pickWrap === 'function') ||
      (insertion?.tags?.query && Array.isArray(insertion.tags.query.options) && typeof insertion.pickTag === 'function');
  })?.memoizedProps?.insertion;
}

/** One post-key frame, not a polling loop. React owns selection and rendering. */
function schedulePickerScroll(editable: Element, annotationId: string, task: string, picker: NativeInsertion): void {
  const wrap = picker.wrap?.state;
  const query = picker.tags?.query;
  if (!wrap && !query) return;
  const pending = scrollFrames.get(editable);
  if (pending !== undefined) cancelAnimationFrame(pending);
  scrollFrames.set(editable, requestAnimationFrame(() => {
    scrollFrames.delete(editable);
    if (!editable.isConnected || document.documentElement.getAttribute(TAG_DROPDOWN_KEYBOARD_ATTRIBUTE) !== 'true') return;
    const identity = readBabelTurnIdentity(annotationId);
    if (!identity || identity.readOnly || identity.reviewActionId !== task) return;
    const turn = findNativeTurnFiber(annotationId);
    if (!findNativeDescendant(turn, (fiber: NativePickerFiber) => fiber.stateNode === editable)) return;
    const current = readPicker(turn);
    if (!current) return;
    if (wrap) {
      const next = current.wrap?.state;
      if (!next || next.span !== wrap.span || next.kind !== wrap.kind ||
          next.filter !== wrap.filter || next.byKeyboard !== wrap.byKeyboard) return;
    } else if (current.wrap?.state || current.tags?.query !== query) return;
    const options = wrap ? current.wrap?.options : current.tags?.query?.options;
    const highlighted = wrap ? current.wrap?.state?.highlighted : current.tags?.highlighted;
    const onPick = wrap ? current.pickWrap : current.pickTag;
    if (!options?.length || !Number.isInteger(highlighted) || highlighted! < 0 || highlighted! >= options.length ||
        typeof onPick !== 'function') return;
    // Match the actual native picker component, not a similarly styled list.
    const menu = findNativeDescendant(turn, (fiber: NativePickerFiber) =>
      fiber.memoizedProps?.options === options && fiber.memoizedProps?.onPick === onPick &&
      fiber.memoizedProps?.highlighted === highlighted);
    const list = findNativeDescendant(menu, (fiber: NativePickerFiber) =>
      fiber.stateNode instanceof HTMLElement && fiber.stateNode.tagName === 'UL' &&
      fiber.memoizedProps?.role === 'list')?.stateNode;
    if (!(list instanceof HTMLElement) || !list.isConnected || list.children.length !== options.length || list.clientHeight <= 0) return;
    const selected = list.children.item(highlighted!);
    if (!(selected instanceof HTMLElement)) return;
    const bounds = list.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    const top = bounds.top + list.clientTop;
    const bottom = top + list.clientHeight;
    const delta = item.top < top || item.height > list.clientHeight ? item.top - top
      : item.bottom > bottom ? item.bottom - bottom : 0;
    if (delta) list.scrollTo({ top: Math.max(0, Math.min(list.scrollHeight - list.clientHeight, list.scrollTop + delta)), behavior: 'instant' });
  }));
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
  const picker = readPicker(turn);
  const state = picker?.wrap?.state;
  if (picker && event.key !== 'Enter' && (state?.byKeyboard === true || picker.tags?.query)) {
    // Let native navigation run; reveal its committed highlight on the next frame.
    schedulePickerScroll(editable, annotationId, identity.reviewActionId, picker);
  }
  const selection = slate && readNativeSlateSelection(slate);
  // Keyboard-opened menus already implement navigation/filtering themselves.
  if (!picker || !state || state.kind !== 'style' || state.byKeyboard !== false || !selection ||
      state.span.start !== selection.start || state.span.end !== selection.end ||
      selection.start === selection.end || !picker.wrap?.options?.length) return;

  if (event.key === 'Enter') {
    const option = picker.wrap.options[state.highlighted];
    if (!option) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Native pickWrap uses its held span and replaceText's new Slate undo batch.
    picker.pickWrap!(option);
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
      // Native mouse selection opens with -1 (no highlighted option).
      // Up enters at the last option; Down enters at the first.
      const highlighted = current.highlighted < 0 && step < 0 ? count - 1
        : (current.highlighted + step + count) % count;
      return { ...current, highlighted };
    });
    schedulePickerScroll(editable, annotationId, identity.reviewActionId, picker);
    return;
  }
}
