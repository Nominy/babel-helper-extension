// @ts-nocheck
import { findBabelEditorFiber, readBabelTranscriptBindings, readBabelClassicInput, flushBabelClassicInputs } from '@nominy/babel-babel-runtime';
import { BABEL_TRANSCRIPT_ROW_SELECTOR, BABEL_ROW_EDITOR_SELECTOR } from '../core/babel-editor-contract';
import { resolveNativeAnnotationTransaction } from './native-annotation-transaction';

export const TRANSCRIPT_ROW_SELECTOR = BABEL_TRANSCRIPT_ROW_SELECTOR;
export const TRANSCRIPT_EDITOR_SELECTOR = BABEL_ROW_EDITOR_SELECTOR;

// The exact native factory supplies its own slate-history module. Keep this
// editor-local so independently emitted MAIN bundles share the same lease.
const NATIVE_SLATE_HISTORY = Symbol.for('babel-helper/native-slate-history/oct15');

export function bindNativeSlateHistory(editor, historyEditor) {
  if (typeof historyEditor?.withNewBatch === 'function' && historyEditor.isHistoryEditor?.(editor)) {
    Object.defineProperty(editor, NATIVE_SLATE_HISTORY, { value: historyEditor });
  }
  return editor;
}

/** Slate's DOM ref depends on this callback. Replacing it during a sibling
 * commit clears the still-focused editor's DOM mapping before layout effects. */
export function useNativeSlateBeforeInput(React, callback) {
  const current = React.useRef(callback);
  React.useLayoutEffect(() => { current.current = callback; });
  return React.useCallback(event => current.current(event), [current]);
}

export function findNativeDescendant(root, predicate) {
  const pending = root ? [root] : [];
  const seen = new Set();
  while (pending.length && seen.size < 20000) {
    const fiber = pending.pop();
    if (!fiber || seen.has(fiber)) continue;
    seen.add(fiber);
    if (predicate(fiber)) return fiber;
    for (let child = fiber.child; child; child = child.sibling) pending.push(child);
  }
  return null;
}

export function findNativeTurnFiber(annotationId) {
  return findNativeDescendant(findBabelEditorFiber(), fiber =>
    fiber.memoizedProps?.turn?.id === annotationId && fiber.memoizedProps?.handlers);
}

export function getNativeSlateEditor(annotationId) {
  return findNativeDescendant(findNativeTurnFiber(annotationId), fiber => {
    const editor = fiber.memoizedProps?.editor;
    return editor && Array.isArray(editor.children) && typeof editor.apply === 'function' &&
      typeof editor.insertData === 'function';
  })?.memoizedProps.editor || null;
}

export function serializeNativeSlate(editor) {
  return (editor.children[0]?.children || []).map(node =>
    typeof node.text === 'string' ? node.text : node.raw || '').join('');
}

function rawOffset(editor, point) {
  if (!point) return null;
  const children = editor.children[0]?.children || [];
  const index = point.path[1] || 0;
  let offset = 0;
  for (let i = 0; i < index; i++) offset += (children[i]?.text ?? children[i]?.raw ?? '').length;
  const node = children[index];
  return offset + (typeof node?.text === 'string' ? point.offset : (node?.raw || '').length);
}

export function readNativeSlateSelection(editor) {
  const anchor = rawOffset(editor, editor?.selection?.anchor);
  const focus = rawOffset(editor, editor?.selection?.focus);
  if (anchor === null || focus === null) return null;
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus),
    direction: anchor === focus ? 'none' : anchor > focus ? 'backward' : 'forward' };
}

function rawPoint(editor, offset) {
  let start = 0;
  let last = null;
  for (const [index, node] of (editor.children[0]?.children || []).entries()) {
    const length = (node.text ?? node.raw ?? '').length;
    if (typeof node.text === 'string') {
      last = { path: [0, index], offset: length };
      if (offset <= start + length) return { path: [0, index], offset: Math.max(0, offset - start) };
    }
    start += length;
  }
  return last;
}

export function selectNativeSlate(editor, start, end = start, direction = 'none') {
  const anchor = rawPoint(editor, direction === 'backward' ? end : start);
  const focus = rawPoint(editor, direction === 'backward' ? start : end);
  if (!anchor || !focus) return false;
  const previous = editor.selection;
  // rawPoint returns native paragraph text points [0, childIndex]. Avoid
  // dispatching duplicate selection operations on every captured keydown.
  if (previous && previous.anchor.offset === anchor.offset && previous.focus.offset === focus.offset &&
      previous.anchor.path.length === 2 && previous.focus.path.length === 2 &&
      previous.anchor.path[0] === 0 && previous.focus.path[0] === 0 &&
      previous.anchor.path[1] === anchor.path[1] && previous.focus.path[1] === focus.path[1]) return true;
  editor.apply({ type: 'set_selection', properties: editor.selection, newProperties: { anchor, focus } });
  return true;
}

export function nativeDomPointOffset(row, node, offset, editor = null) {
  if (!node || !row?.contains(node)) return null;
  const scope = editor ? row.querySelector('[data-slate-editor="true"]')
    : row.querySelector('[role="textbox"][aria-label="Edit turn text"]') || row.querySelector('[data-offset]')?.parentElement;
  if (!scope?.contains(node)) return null;
  const elements = scope.querySelectorAll(editor ? '[data-slate-node="text"]' : '[data-offset]');
  const children = editor?.children[0]?.children;
  const range = document.createRange();
  let start = 0;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const child = children?.[index];
    const chip = editor ? typeof child?.text !== 'string' : element.hasAttribute('data-chip');
    const length = editor ? (child?.text ?? child?.raw ?? '').length
      : chip ? Number(element.getAttribute('data-chip')) : element.textContent.length;
    if (!editor) start = Number(element.getAttribute('data-offset'));
    const segment = editor && chip ? element.closest('[data-slate-void="true"]') : element;
    if (!segment || !scope.contains(segment)) return null;
    range.selectNodeContents(segment);
    const relative = range.comparePoint(node, offset);
    if (relative < 0) return start;
    if (relative === 0) {
      // Root/paragraph element boundaries are valid browser selections too.
      // Treat inline voids atomically; their visible labels do not spell raw tags.
      if (chip) return start + (node === segment && offset === 0 ? 0 : length);
      range.setEnd(node, offset);
      // Clamp native empty-leaf sentinels without stripping real U+FEFF text.
      return start + Math.min(length, range.toString().length);
    }
    start += length;
  }
  return elements.length ? start : null;
}

export function readNativeTurn(annotationId, bindings = readBabelTranscriptBindings()) {
  const annotation = bindings?.annotations.find(turn => turn.id === annotationId);
  if (!annotation) return null;
  const classic = readBabelClassicInput(annotationId);
  if (classic) {
    const value = classic.input.read();
    return { annotation, editor: value.editor, classic: classic.input, text: value.text,
      start: value.start, end: value.end, direction: value.direction,
      isActive: bindings.transcript.activeIds?.has(annotationId) === true,
      isEditing: bindings.transcript.editingId === annotationId, readOnly: classic.readOnly };
  }
  const host = findNativeDescendant(findNativeTurnFiber(annotationId), fiber => {
    if (fiber.memoizedProps?.['data-babel-classic-row'] === 'true') return true;
    const editor = fiber.memoizedProps?.editor;
    return editor && Array.isArray(editor.children) && typeof editor.apply === 'function' && typeof editor.insertData === 'function';
  });
  if (host?.memoizedProps?.['data-babel-classic-row'] === 'true') return null;
  const editor = host?.memoizedProps?.editor || null;
  const text = editor ? serializeNativeSlate(editor) : annotation.content || '';
  let anchor = editor ? rawOffset(editor, editor.selection?.anchor) : null;
  let focus = editor ? rawOffset(editor, editor.selection?.focus) : null;
  const selection = window.getSelection?.();
  const element = selection?.anchorNode?.parentElement;
  const row = element?.closest(TRANSCRIPT_ROW_SELECTOR);
  if (row?.getAttribute('data-annotation-id') === annotationId) {
    // Slate applies browser selectionchange asynchronously. MAIN keydown
    // consumers run before that update, so read the real selected DOM range
    // in raw tag coordinates rather than the previous editor.selection.
    const domAnchor = nativeDomPointOffset(row, selection.anchorNode, selection.anchorOffset, editor);
    const domFocus = nativeDomPointOffset(row, selection.focusNode, selection.focusOffset, editor);
    if (domAnchor !== null && domFocus !== null) { anchor = domAnchor; focus = domFocus; }
  }
  return { annotation, editor, text, start: Math.min(anchor ?? text.length, focus ?? text.length),
    end: Math.max(anchor ?? text.length, focus ?? text.length),
    direction: anchor == null || anchor === focus ? 'none' : anchor > focus ? 'backward' : 'forward',
    isActive: bindings.transcript.activeIds?.has(annotationId) === true,
    isEditing: bindings.transcript.editingId === annotationId,
    readOnly: bindings.readOnly };
}

export function replaceNativeTurn(annotationId, text, options = {}) {
  const bindings = readBabelTranscriptBindings();
  if (!bindings || bindings.readOnly ||
      (options.reviewActionId && options.reviewActionId !== bindings.reviewActionId)) return false;
  const state = readNativeTurn(annotationId, bindings);
  if (!state || typeof text !== 'string') return false;
  if (state.readOnly) return false;
  if (state.classic) return state.classic.replace(text, options);
  if (state.text === text) return true;
  if (state.editor) {
    const history = state.editor[NATIVE_SLATE_HISTORY];
    if (typeof history?.withNewBatch !== 'function') throw new Error('native-slate-history-unavailable');
    // Use this editor's genuine history boundary. Retained Oct15 history must
    // not merge a Helper replacement into typing from a previous mount.
    let selected = false;
    history.withNewBatch(state.editor, () => {
      selected = selectNativeSlate(state.editor, 0, state.text.length);
      if (!selected) return;
      // insertData is the native plain-text tokenizer, retaining raw tag nodes.
      if (text) {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        state.editor.insertData(data);
      } else {
        state.editor.deleteFragment();
      }
      selectNativeSlate(state.editor, options.start ?? text.length, options.end ?? options.start ?? text.length, options.direction);
      // Flush native onChange before immediate blur can lose the debounced edit.
      state.editor.onChange();
    });
    if (!selected) return false;
  } else {
    const change = bindings.transcript.handlers.onChangeText;
    if (typeof change !== 'function') return false;
    change(annotationId, text);
  }
  return true;
}

/** Classic cross-row edits use one real native command, with no partial local writes. */
export function replaceClassicTurns(request) {
  if (!Array.isArray(request.changes) || !request.changes.length) return false;
  const ids = new Set();
  let first = null;
  for (const change of request.changes) {
    if (!change || typeof change.annotationId !== 'string' || ids.has(change.annotationId) ||
        typeof change.text !== 'string' || typeof change.before !== 'string') return false;
    ids.add(change.annotationId);
    const owned = readBabelClassicInput(change.annotationId);
    if (!owned || owned.readOnly || owned.input.reviewActionId !== request.reviewActionId ||
        owned.annotation.type !== 'transcription' ||
        owned.annotation.processedRecordingId !== change.processedRecordingId ||
        owned.annotation.startTimeInSeconds !== change.startSeconds || owned.annotation.endTimeInSeconds !== change.endSeconds ||
        owned.input.read().composing || owned.input.read().text !== change.before) return false;
    first ||= owned.input;
  }
  if (!flushBabelClassicInputs()) return false;
  const binding = readBabelTranscriptBindings(), root = findBabelEditorFiber();
  if (!root || !binding || binding.readOnly || binding.reviewActionId !== request.reviewActionId) return false;
  const before = new Map(), after = new Map(), selections = [];
  const updatedAt = new Date().toISOString();
  for (const change of request.changes) {
    const owned = readBabelClassicInput(change.annotationId);
    const annotation = binding.annotations.find(turn => turn.id === change.annotationId);
    if (!owned || owned.readOnly || !annotation || (annotation.content ?? '') !== change.before ||
        annotation.processedRecordingId !== change.processedRecordingId ||
        annotation.startTimeInSeconds !== change.startSeconds || annotation.endTimeInSeconds !== change.endSeconds) return false;
    if (change.text === change.before) continue;
    before.set(annotation.id, annotation);
    after.set(annotation.id, { ...annotation, content: change.text, updatedAt,
      metadata: { ...annotation.metadata, lowConfidenceResolved: true } });
    selections.push({ input: owned.input, state: owned.input.read(), length: change.text.length });
  }
  if (!after.size) return true;
  const capability = resolveNativeAnnotationTransaction(root, binding);
  first.batchNative(() => {
    for (const id of after.keys()) capability.clearSegment(id);
    capability.execute({
      do() { capability.writeAnnotations(annotations => annotations.map(annotation => after.get(annotation.id) || annotation)); },
      undo() { capability.writeAnnotations(annotations => annotations.map(annotation => before.get(annotation.id) || annotation)); }
    });
  });
  for (const { input, state, length } of selections) {
    input.select(Math.min(state.start, length), Math.min(state.end, length), state.direction);
  }
  return true;
}
