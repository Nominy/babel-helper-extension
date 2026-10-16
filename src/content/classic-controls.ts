// @ts-nocheck
import { registerBabelClassicInput, readBabelClassicInput, flushBabelClassicInputs,
  readBabelTranscriptBindings } from '@nominy/babel-babel-runtime';
import { classicTextRects, classicOffsetAtPoint, releaseClassicInputGeometry } from './classic-input-geometry';
import { showNativeAutomationFailure } from '../ui/native-automation-failure';

export const CLASSIC_ROW_SELECTOR = '[data-babel-classic-row="true"][data-annotation-id]';
export const CLASSIC_INPUT_SELECTOR = 'textarea[data-babel-classic-input="true"]';

function slateText(editor) {
  return editor.children.map(block => block.children.map(leaf => leaf.text).join('')).join('\n');
}

function slatePoint(editor, offset) {
  let remaining = Math.max(0, offset), last = null;
  for (let block = 0; block < editor.children.length; block++) {
    if (block) remaining--;
    for (let leaf = 0; leaf < editor.children[block].children.length; leaf++) {
      const text = editor.children[block].children[leaf].text;
      if (typeof text !== 'string') throw new Error('classic-slate-nontext-node');
      last = { path: [block, leaf], offset: text.length };
      if (remaining <= text.length) return { path: [block, leaf], offset: Math.max(0, remaining) };
      remaining -= text.length;
    }
  }
  return last;
}

function slateOffset(editor, point) {
  if (!point) return null;
  let offset = 0;
  for (let block = 0; block <= point.path[0]; block++) {
    if (block) offset++;
    const children = editor.children[block]?.children;
    if (!children) return null;
    const count = block === point.path[0] ? point.path[1] : children.length;
    for (let leaf = 0; leaf < count; leaf++) offset += children[leaf].text.length;
  }
  return offset + point.offset;
}

/** Binding arguments come from instrumented captured locals, never DOM guesses. */
export function createClassicControls(React, useContext) {
  const leases = new Set();
  const slateBindings = new Map();
  let released = false;

  function useRow(binding) {
    const context = useContext();
    const committed = React.useRef({ binding, context });
    const leaseRef = React.useRef(null);
    const conflict = React.useRef(false);
    React.useLayoutEffect(() => {
      const previous = committed.current.binding;
      const source = previous.annotation, next = binding.annotation;
      const changed = source.id !== next.id || source.processedRecordingId !== next.processedRecordingId ||
        source.startTimeInSeconds !== next.startTimeInSeconds || source.endTimeInSeconds !== next.endTimeInSeconds ||
        (source.content ?? '') !== (next.content ?? '');
      if (changed && previous.text !== (source.content ?? '') && binding.text !== (next.content ?? '')) {
        conflict.current = true;
        previous.cancel();
      }
      if (binding.readOnly) previous.cancel();
      committed.current = { binding, context };
    });
    React.useLayoutEffect(() => {
      if (released) return;
      const row = binding.rootRef.current;
      if (!row || !context?.reviewActionId || typeof context.flushSync !== 'function') {
        throw new Error('classic-input-native-context-unavailable');
      }
      let composing = false, disposed = false, pendingSelection = null, geometryInput = null;
      const id = binding.annotation.id;
      row.setAttribute('data-babel-classic-row', 'true');
      row.setAttribute('data-annotation-id', id);
      const slate = () => slateBindings.get(row);
      const textarea = () => committed.current.binding.inputRef.current;
      function ownGeometry(input) {
        if (input !== geometryInput) {
          if (geometryInput) releaseClassicInputGeometry(geometryInput);
          geometryInput = input;
        }
        return input;
      }
      function authorize(write = false) {
        if (disposed || released) return null;
        const owned = readBabelClassicInput(id, row.ownerDocument);
        return owned?.input === lease && (!write || (!owned.readOnly && !conflict.current)) ? owned : null;
      }
      function sync(callback) {
        committed.current.context.flushSync(callback);
      }
      function select(start, end = start, direction = 'none', focus = false) {
        if (!authorize(true) || composing) return false;
        const value = lease.read().text;
        if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
        start = Math.max(0, Math.min(start, value.length));
        end = Math.max(start, Math.min(end, value.length));
        if (focus) {
          sync(() => {
            committed.current.context.transcriptProps.handlers.onActivate(id);
            committed.current.binding.enterEdit();
          });
        }
        const rich = slate(), input = textarea();
        if (rich) {
          const anchor = slatePoint(rich.editor, direction === 'backward' ? end : start);
          const focusPoint = slatePoint(rich.editor, direction === 'backward' ? start : end);
          if (!anchor || !focusPoint) return false;
          if (focus) row.querySelector('[data-slate-editor="true"]')?.focus({ preventScroll: true });
          rich.transforms.select(rich.editor, { anchor, focus: focusPoint });
        } else if (input) {
          if (focus) input.focus({ preventScroll: true });
          input.setSelectionRange(start, end, direction);
          pendingSelection = { start, end, direction, text: value };
        } else return false;
        return true;
      }
      const lease = {
        batchNative: sync,
        get annotation() { return committed.current.binding.annotation; },
        get reviewActionId() { return committed.current.context.reviewActionId; },
        get handlers() { return committed.current.context.transcriptProps.handlers; },
        get readOnly() { return Boolean(committed.current.binding.readOnly || slate()?.readOnly); },
        get element() { return slate() ? row.querySelector('[data-slate-editor="true"]') : textarea(); },
        get autocomplete() { return slate()?.autocomplete || committed.current.binding.autocomplete; },
        read() {
          const rich = slate(), input = textarea();
          const text = rich ? slateText(rich.editor) : committed.current.binding.text;
          const anchor = rich ? slateOffset(rich.editor, rich.editor.selection?.anchor) : input?.selectionStart;
          const focus = rich ? slateOffset(rich.editor, rich.editor.selection?.focus) : input?.selectionEnd;
          return { text, start: Math.min(anchor ?? text.length, focus ?? text.length),
            end: Math.max(anchor ?? text.length, focus ?? text.length),
            direction: rich ? anchor === focus ? 'none' : anchor > focus ? 'backward' : 'forward'
              : input?.selectionDirection || 'none', composing: composing || rich?.editor.isComposing === true,
            editor: rich?.editor || null };
        },
        flush() {
          const owned = authorize(true), state = lease.read();
          if (!owned || state.composing) return false;
          if (state.text === (owned.annotation.content ?? '')) return true;
          sync(() => {
            const rich = slate();
            if (rich) rich.onValueChange(rich.editor.children);
            // A debounce may have elapsed while IME composition prohibited its
            // commit. Requeue via the actual captured change callback, not DOM.
            committed.current.binding.change(state.text);
            committed.current.binding.flush();
          });
          const current = authorize(true);
          return Boolean(current && (current.annotation.content ?? '') === state.text);
        },
        replace(text, options = {}) {
          if (!authorize(true) || typeof text !== 'string' || lease.read().composing) return false;
          // Separate pending user typing from the Helper command in native history.
          if (!lease.flush() || !authorize(true)) return false;
          if (text === lease.read().text) return (!lease.element && !options.focus) ||
            select(options.start ?? text.length, options.end ?? options.start ?? text.length, options.direction || 'none', options.focus === true);
          const rich = slate();
          if (rich) {
            if (typeof rich.historyEditor?.withNewBatch !== 'function') throw new Error('classic-slate-history-unavailable');
            sync(() => rich.historyEditor.withNewBatch(rich.editor, () => {
              rich.transforms.select(rich.editor, { anchor: rich.editorApi.start(rich.editor, []),
                focus: rich.editorApi.end(rich.editor, []) });
              if (text) rich.editor.insertText(text); else rich.editor.deleteFragment();
              rich.onValueChange(rich.editor.children);
              committed.current.binding.flush();
            }));
          } else {
            sync(() => {
              committed.current.binding.change(text);
              committed.current.binding.flush();
            });
          }
          const applied = authorize(true);
          if (!applied || (applied.annotation.content ?? '') !== text || lease.read().text !== text) return false;
          if (!lease.element && !options.focus) return true;
          return select(options.start ?? text.length, options.end ?? options.start ?? text.length,
            options.direction || 'none', options.focus === true);
        },
        select,
        rects(start, end = start) {
          if (!authorize()) return [];
          const input = ownGeometry(textarea());
          if (input) return classicTextRects(input, lease.read().text, start, end);
          const rich = slate();
          const startPoint = rich && slatePoint(rich.editor, start), endPoint = rich && slatePoint(rich.editor, end);
          if (!startPoint || !endPoint) return [];
          const nodes = row.querySelectorAll('[data-slate-node="text"]');
          const flatIndex = point => rich.editor.children.slice(0, point.path[0]).reduce((sum, block) => sum + block.children.length, 0) + point.path[1];
          const resolve = point => {
            if (!nodes[flatIndex(point)]) return null;
            const walker = row.ownerDocument.createTreeWalker(nodes[flatIndex(point)], NodeFilter.SHOW_TEXT);
            let node, remaining = point.offset;
            while ((node = walker.nextNode())) {
              if (remaining <= node.length) return [node, remaining];
              remaining -= node.length;
            }
            return null;
          };
          const left = resolve(startPoint), right = resolve(endPoint);
          if (!left || !right) return [];
          const range = row.ownerDocument.createRange();
          range.setStart(...left); range.setEnd(...right);
          return Array.from(range.getClientRects());
        },
        offsetAtPoint(x, y) {
          if (!authorize()) return null;
          const input = ownGeometry(textarea());
          if (input) return classicOffsetAtPoint(input, lease.read().text, x, y);
          const doc = row.ownerDocument, point = doc.caretPositionFromPoint?.(x, y);
          const range = point ? null : doc.caretRangeFromPoint?.(x, y);
          const node = point?.offsetNode || range?.startContainer, offset = point ? point.offset : range?.startOffset;
          const textNode = node?.parentElement?.closest('[data-slate-node="text"]');
          const rich = slate();
          if (!rich || !textNode || !row.contains(textNode)) return null;
          const nodes = Array.from(row.querySelectorAll('[data-slate-node="text"]'));
          const index = nodes.indexOf(textNode);
          const prefix = doc.createRange(); prefix.selectNodeContents(textNode); prefix.setEnd(node, offset);
          let flat = 0, raw = 0;
          for (const [blockIndex, block] of rich.editor.children.entries()) {
            if (blockIndex) raw++;
            for (const leaf of block.children) {
              if (flat++ === index) return raw + Math.min(leaf.text.length, prefix.toString().length);
              raw += leaf.text.length;
            }
          }
          return null;
        },
        page(direction, extend) {
          const input = lease.element, viewport = row.closest('[data-transcript-scroll]');
          if (!authorize(true) || !input || input.ownerDocument.activeElement !== input || !viewport) return false;
          const state = lease.read(), offset = state.direction === 'backward' ? state.start : state.end;
          const rect = lease.rects(offset)[0];
          if (!rect) return false;
          const delta = (direction === 'up' ? -1 : 1) * Math.max(rect.height, viewport.clientHeight - rect.height);
          const next = lease.offsetAtPoint(rect.left, rect.top + rect.height / 2 + delta);
          if (next === null) return false;
          const anchor = state.direction === 'backward' ? state.end : state.start;
          if (!select(extend ? Math.min(anchor, next) : next, extend ? Math.max(anchor, next) : next,
            extend ? next < anchor ? 'backward' : 'forward' : 'none')) return false;
          viewport.scrollTop += delta;
          return true;
        },
        history(redo) {
          if (!authorize(true) || !lease.flush()) return false;
          const state = lease.read(), bindings = readBabelTranscriptBindings(row.ownerDocument);
          if (!bindings?.history || bindings.reviewActionId !== lease.reviewActionId || bindings.readOnly) return false;
          sync(() => redo ? bindings.history.redo() : bindings.history.undo());
          const length = lease.read().text.length;
          return select(Math.min(state.start, length), Math.min(state.end, length), state.direction);
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          ownGeometry(null);
          unregister();
          binding.cancel();
          row.removeEventListener('compositionstart', onCompositionStart, true);
          row.removeEventListener('compositionend', onCompositionEnd, true);
          row.removeEventListener('focusin', onNativeFocus, true);
          row.removeEventListener('focusout', onNativeBlur, true);
          leases.delete(lease);
        }
      };
      const onCompositionStart = () => { composing = true; };
      const onCompositionEnd = () => {
        composing = false;
        queueMicrotask(() => { if (!disposed && authorize(true)) lease.flush(); });
      };
      const onNativeFocus = event => {
        const element = lease.element;
        if (!element || !(event.target === element || element.contains(event.target)) || !authorize(true)) return;
        const current = committed.current.context.transcriptProps;
        if (current.editingId !== id) current.handlers.onActivate(id);
      };
      const onNativeBlur = event => {
        const element = lease.element;
        if (!element || !(event.target === element || element.contains(event.target)) || !authorize(true)) return;
        if (lease.flush()) committed.current.context.transcriptProps.handlers.onDeactivate(id);
      };
      row.addEventListener('compositionstart', onCompositionStart, true);
      row.addEventListener('compositionend', onCompositionEnd, true);
      row.addEventListener('focusin', onNativeFocus, true);
      row.addEventListener('focusout', onNativeBlur, true);
      const unregister = registerBabelClassicInput(row, lease);
      leaseRef.current = { lease, committed, ownGeometry, get pendingSelection() { return pendingSelection; }, clearSelection() { pendingSelection = null; } };
      leases.add(lease);
      return () => { lease.dispose(); leaseRef.current = null; };
    }, [context.reviewActionId, binding.annotation.id]);
    React.useLayoutEffect(() => {
      const input = binding.inputRef.current;
      leaseRef.current?.ownGeometry(input);
      if (input && input.getAttribute('data-babel-classic-input') !== 'true') input.setAttribute('data-babel-classic-input', 'true');
      const pending = leaseRef.current?.pendingSelection;
      if (pending && input && input.value === pending.text) {
        input.setSelectionRange(pending.start, pending.end, pending.direction);
        leaseRef.current.clearSelection();
      }
    });
    return {
      canCommitDraft() {
        const lease = leaseRef.current?.lease;
        if (!lease || conflict.current) return false;
        const owned = readBabelClassicInput(binding.annotation.id, binding.rootRef.current?.ownerDocument);
        return owned?.input === lease && !owned.readOnly && !lease.read().composing;
      },
      canSyncModelText() { return !conflict.current; }
    };
  }

  function useSlate(binding) {
    const context = useContext();
    React.useLayoutEffect(() => {
      const row = Array.from(document.querySelectorAll(CLASSIC_ROW_SELECTOR))
        .find(element => element.getAttribute('data-annotation-id') === context.annotation?.id);
      if (!row) throw new Error('classic-slate-row-unavailable');
      slateBindings.set(row, binding);
      return () => { if (slateBindings.get(row) === binding) slateBindings.delete(row); };
    });
  }

  function flushBeforeAction(event) {
    if (!leases.size || event.defaultPrevented || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    const key = event.type === 'keydown' && (event.ctrlKey || event.metaKey) && !event.altKey
      ? event.key.toLowerCase() : '';
    const input = target?.closest(CLASSIC_INPUT_SELECTOR);
    const undo = input && (key === 'z' || key === 'y');
    // Native save/submit/row actions run after capture. Input events retain the
    // captured row's own debounce; no duplicate timer, controller or save path.
    if (!undo && !(event.type === 'pointerdown' && !target?.closest(`${CLASSIC_INPUT_SELECTOR}, [data-slate-editor="true"]`)) &&
        !(event.type === 'click' && target?.closest('button, [role="menuitem"]')) && key !== 's') return;
    if (!flushBabelClassicInputs()) {
      event.preventDefault(); event.stopImmediatePropagation();
      showNativeAutomationFailure('Classic native input', 'Finish composition or resolve the changed native row before saving or applying an action. Pending text has been retained.');
      return;
    }
    if (undo) {
      const owned = readBabelClassicInput(input.closest(CLASSIC_ROW_SELECTOR).getAttribute('data-annotation-id'));
      if (!owned || owned.readOnly || !leases.has(owned.input)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      owned.input.history(key === 'y' || event.shiftKey);
    }
  }
  window.addEventListener('pointerdown', flushBeforeAction, true);
  window.addEventListener('click', flushBeforeAction, true);
  window.addEventListener('keydown', flushBeforeAction, true);
  return { useRow, useSlate, release() {
    released = true;
    for (const lease of [...leases]) lease.dispose();
    slateBindings.clear();
    window.removeEventListener('pointerdown', flushBeforeAction, true);
    window.removeEventListener('click', flushBeforeAction, true);
    window.removeEventListener('keydown', flushBeforeAction, true);
  } };
}
