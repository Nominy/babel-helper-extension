import {
  findBabelEditorFiber, readBabelTranscriptBindings,
  type BabelNativeAnnotation, type BabelNativeTranscriptBindings
} from '@nominy/babel-babel-runtime';
import { findNativeDescendant, findNativeTurnFiber, getNativeSlateEditor, serializeNativeSlate } from './native-transcript';
import { resolveNativeAnnotationTransaction } from './native-annotation-transaction';
import {
  compileReplacementRules, replaceTextWithRules,
  type ReplacementRule, type ReplacementResult, type ReplacementStatus
} from '../core/replacement-rules';

interface NativeRoot { alternate?: unknown }
interface NativeFiber { stateNode?: unknown; memoizedProps?: { readOnly?: boolean; editor?: NativeSlateEditor } }
interface NativeSlateEditor {
  isComposing?: boolean;
  children: { children?: { text?: string; raw?: string }[] }[];
}
interface ReplacementContext {
  binding: BabelNativeTranscriptBindings;
  root: NativeRoot;
  route: string;
}
interface SegmentIdentity {
  id: string;
  recordingId: string | null;
  start: number | null;
  end: number | null;
}
interface ReplacementChange { id: string; before: string | null; after: string | null }
interface RecoveryReceipt {
  structure: SegmentIdentity[];
  changes: ReplacementChange[];
  count: number;
}
interface ReplacementSession {
  id: string;
  root: NativeRoot;
  route: string;
  reviewActionId: string;
  recovery: RecoveryReceipt | null;
}
interface NativeSource {
  model: string;
  live: string;
  pending: boolean;
  turn: NativeFiber | null;
}

let session: ReplacementSession | null = null;
let disposeTracking: (() => void) | null = null;
const composingTargets = new Set<Element>();

export function invalidateNativeReplacementSession(): void {
  session = null;
  composingTargets.clear();
}

/** Observe native composition only; no external extension, polling or DOM writes. */
export function installNativeReplacementTracking(): () => void {
  disposeTracking?.();
  const start = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-slate-editor="true"]') : null;
    const root = findBabelEditorFiber();
    if (target && root && findNativeDescendant(root, (fiber: NativeFiber) => fiber.stateNode === target)) {
      composingTargets.add(target);
    }
  };
  const end = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-slate-editor="true"]') : null;
    if (target) composingTargets.delete(target);
  };
  window.addEventListener('compositionstart', start, true);
  window.addEventListener('compositionend', end, true);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener('compositionstart', start, true);
    window.removeEventListener('compositionend', end, true);
    if (disposeTracking === dispose) disposeTracking = null;
    invalidateNativeReplacementSession();
  };
  disposeTracking = dispose;
  return dispose;
}

function currentContext(): ReplacementContext {
  if (document.documentElement.getAttribute('data-babel-helper-native-find-replace') !== 'true') {
    invalidateNativeReplacementSession();
    throw new Error('native-find-replace-disabled');
  }
  const binding = readBabelTranscriptBindings(), root = findBabelEditorFiber();
  if (!root || typeof root !== 'object' || !binding?.reviewActionId || !Array.isArray(binding.annotations)) {
    invalidateNativeReplacementSession();
    throw new Error('native-find-replace-task-unavailable');
  }
  const nativeRoot: NativeRoot = root;
  const route = window.location.href;
  if (!session || session.reviewActionId !== binding.reviewActionId || session.route !== route ||
      (session.root !== nativeRoot && nativeRoot.alternate !== session.root && session.root.alternate !== nativeRoot)) {
    session = { id: crypto.randomUUID(), root: nativeRoot, route, reviewActionId: binding.reviewActionId, recovery: null };
  }
  if (binding.readOnly || binding.panel?.readOnly || binding.transcript?.readOnly) {
    session.recovery = null;
    throw new Error('native-find-replace-read-only');
  }
  if (binding.panel?.mode && binding.panel.mode !== 'transcription') {
    session.recovery = null;
    throw new Error('native-find-replace-unsupported-mode');
  }
  if (findNativeDescendant(root, (fiber: NativeFiber) => fiber.memoizedProps?.editor?.isComposing === true ||
      (fiber.stateNode instanceof Element && composingTargets.has(fiber.stateNode)))) {
    throw new Error('native-find-replace-composition-active');
  }
  return { binding, root: nativeRoot, route };
}

function readStructure(binding: BabelNativeTranscriptBindings): SegmentIdentity[] {
  const ids = new Set<string>();
  const structure: SegmentIdentity[] = [];
  for (const annotation of binding.annotations) {
    if (typeof annotation.id !== 'string' || !annotation.id || ids.has(annotation.id)) {
      throw new Error('native-find-replace-annotation-identity-unavailable');
    }
    ids.add(annotation.id);
    if (annotation.type === 'transcription') structure.push({ id: annotation.id,
      recordingId: annotation.processedRecordingId, start: annotation.startTimeInSeconds, end: annotation.endTimeInSeconds });
  }
  return structure;
}

function readSource(annotation: BabelNativeAnnotation, binding: BabelNativeTranscriptBindings): NativeSource {
  const model = annotation.content === null ? '' : annotation.content;
  if (typeof model !== 'string') throw new Error('native-find-replace-text-unavailable');
  const turn: NativeFiber | null = findNativeTurnFiber(annotation.id);
  const editor: NativeSlateEditor | null = getNativeSlateEditor(annotation.id);
  if (editor?.isComposing === true) throw new Error('native-find-replace-composition-active');
  let slate = model;
  if (editor) {
    if (editor.children.length !== 1 || !Array.isArray(editor.children[0]?.children) ||
        editor.children[0].children.some(node => typeof node.text !== 'string' && typeof node.raw !== 'string')) {
      throw new Error('native-find-replace-slate-structure-unsupported');
    }
    slate = serializeNativeSlate(editor);
  }
  const pending = Object.prototype.hasOwnProperty.call(binding.pendingTextById || {}, annotation.id);
  const live = pending ? binding.pendingTextById[annotation.id] : slate;
  if (typeof live !== 'string') throw new Error('native-find-replace-text-unavailable');
  if (editor && live !== slate) throw new Error('native-find-replace-pending-text-changed');
  return { model, live, pending, turn };
}

function requireCommittedSource(source: NativeSource): void {
  if (source.turn?.memoizedProps?.readOnly) throw new Error('native-find-replace-turn-read-only');
  if (source.pending || source.live !== source.model) throw new Error('native-find-replace-pending-text-requires-blur');
  const active = document.activeElement?.closest('[data-slate-editor="true"]');
  if (active && source.turn && findNativeDescendant(source.turn, (fiber: NativeFiber) => fiber.stateNode === active)) {
    throw new Error('native-find-replace-pending-text-requires-blur');
  }
}

/** Only transcript structure and affected text authorize a receipt. Unrelated
 * content/metadata may change; recovery must not overwrite those native edits. */
function requireRecoverable(context: ReplacementContext, receipt: RecoveryReceipt, requireBlur: boolean): void {
  const structure = readStructure(context.binding);
  if (structure.length !== receipt.structure.length || structure.some((row, index) => {
    const expected = receipt.structure[index];
    return row.id !== expected.id || row.recordingId !== expected.recordingId || row.start !== expected.start || row.end !== expected.end;
  })) throw new Error('native-find-replace-structure-changed');
  const annotations = new Map(context.binding.annotations.map(annotation => [annotation.id, annotation]));
  for (const change of receipt.changes) {
    const annotation = annotations.get(change.id);
    if (!annotation) throw new Error('native-find-replace-source-changed');
    const source = readSource(annotation, context.binding);
    if (source.model !== change.after || source.live !== change.after) throw new Error('native-find-replace-source-changed');
    if (source.turn?.memoizedProps?.readOnly) throw new Error('native-find-replace-turn-read-only');
    if (requireBlur) requireCommittedSource(source);
  }
}

function refreshRecovery(context: ReplacementContext, owned: ReplacementSession): boolean {
  if (!owned.recovery) return false;
  try { requireRecoverable(context, owned.recovery, false); return true; }
  catch { owned.recovery = null; return false; }
}

export function getNativeReplacementStatus(): ReplacementStatus {
  const context = currentContext();
  const owned = session!;
  return { ok: true, sessionId: owned.id, segmentCount: readStructure(context.binding).length,
    canRecover: refreshRecovery(context, owned) };
}

function changedAnnotation(annotation: BabelNativeAnnotation, content: string | null, updatedAt: string): BabelNativeAnnotation {
  const metadata = annotation.metadata;
  if (metadata !== undefined && metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    throw new Error('native-find-replace-metadata-unsupported');
  }
  return { ...annotation, content, metadata: { ...metadata, lowConfidenceResolved: true }, updatedAt };
}

/** All validation completes before native confidence/history/writer mutation.
 * The native writer, not a raw setter, owns region sync and save/dirty state. */
function commitChanges(context: ReplacementContext, owned: ReplacementSession, changes: ReplacementChange[],
  receipt: RecoveryReceipt | null): void {
  const before = new Map<string, BabelNativeAnnotation>(), after = new Map<string, BabelNativeAnnotation>();
  const annotations = new Map(context.binding.annotations.map(annotation => [annotation.id, annotation]));
  const updatedAt = new Date().toISOString();
  for (const change of changes) {
    const annotation = annotations.get(change.id);
    if (!annotation || annotation.type !== 'transcription' || !annotation.processedRecordingId) {
      throw new Error('native-find-replace-recording-unavailable');
    }
    before.set(change.id, { ...annotation });
    after.set(change.id, changedAnnotation(annotation, change.after, updatedAt));
  }
  const capability = resolveNativeAnnotationTransaction(context.root, context.binding);
  for (const id of after.keys()) capability.clearSegment(id);
  capability.execute({
    do() {
      capability.writeAnnotations((annotations: BabelNativeAnnotation[]) => annotations.map(annotation => after.get(annotation.id) || annotation));
    },
    undo() {
      // Native Redo may reapply the text, but must not resurrect a used receipt.
      if (session === owned && owned.recovery === receipt) owned.recovery = null;
      capability.writeAnnotations((annotations: BabelNativeAnnotation[]) => annotations.map(annotation => before.get(annotation.id) || annotation));
    }
  });
}

export function runNativeReplacementRules(request: { sessionId: string; rules: ReplacementRule[] }): ReplacementResult {
  const context = currentContext(), owned = session!;
  if (!request || typeof request.sessionId !== 'string' || request.sessionId !== owned.id) {
    throw new Error('native-find-replace-session-changed');
  }
  const rules = compileReplacementRules(request.rules);
  const structure = readStructure(context.binding);
  const changes: ReplacementChange[] = [];
  let count = 0;
  for (const annotation of context.binding.annotations) {
    if (annotation.type !== 'transcription') continue;
    const source = readSource(annotation, context.binding);
    const replacement = replaceTextWithRules(source.model, rules);
    // A stale model must never turn an affected pending edit into a false noop.
    const pendingAffected = source.live !== source.model && replaceTextWithRules(source.live, rules).text !== source.live;
    if (replacement.text === source.model && !pendingAffected) continue;
    requireCommittedSource(source);
    changes.push({ id: annotation.id, before: annotation.content, after: replacement.text });
    count += replacement.count;
  }
  if (!changes.length) return { ok: true, sessionId: owned.id, segmentCount: structure.length,
    canRecover: refreshRecovery(context, owned), count: 0, changedRows: 0 };
  const receipt: RecoveryReceipt = { structure, changes, count };
  commitChanges(context, owned, changes, receipt);
  owned.recovery = receipt;
  return { ok: true, sessionId: owned.id, segmentCount: structure.length, canRecover: true, count, changedRows: changes.length };
}

export function recoverNativeReplacementRules(request: { sessionId: string }): ReplacementResult {
  const context = currentContext(), owned = session!;
  if (!request || typeof request.sessionId !== 'string' || request.sessionId !== owned.id) {
    throw new Error('native-find-replace-session-changed');
  }
  const receipt = owned.recovery;
  if (!receipt) throw new Error('native-find-replace-recovery-unavailable');
  try { requireRecoverable(context, receipt, true); }
  catch (error) {
    if (error instanceof Error && (error.message === 'native-find-replace-source-changed' ||
        error.message === 'native-find-replace-structure-changed')) owned.recovery = null;
    throw error;
  }
  const changes = receipt.changes.map(change => ({ id: change.id, before: change.after, after: change.before }));
  commitChanges(context, owned, changes, null);
  owned.recovery = null;
  return { ok: true, sessionId: owned.id, segmentCount: receipt.structure.length, canRecover: false,
    count: receipt.count, changedRows: changes.length };
}
