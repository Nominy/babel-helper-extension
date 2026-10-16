// @ts-nocheck
import { findBabelEditorFiber, readBabelTranscriptBindings, readBabelClassicInput, flushBabelClassicInputs, subscribeBabelEditorCommits } from '@nominy/babel-babel-runtime';
import { findNativeDescendant, findNativeTurnFiber, getNativeSlateEditor, serializeNativeSlate, TRANSCRIPT_EDITOR_SELECTOR } from './native-transcript';
import { resolveNativeAnnotationTransaction } from './native-annotation-transaction';

let prepared = null;
let loading = null;
let applying = false;
let activePlan = null;
const composing = new Set();
const fail = reason => { throw new Error(reason); };
const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const resultError = error => ({ ok: false, reason: error instanceof Error ? error.message : String(error) });
const sameRoot = (a, b) => a === b || a?.alternate === b || b?.alternate === a;

function canonical(value) {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

/** Read only the observed provider shape. Never traverse opaque RPC proxy members. */
export function resolveBaselineQueryClient(root) {
  for (let fiber = root; fiber; fiber = fiber.return) {
    const value = own(fiber.memoizedProps, 'value');
    const client = own(value, 'client'), queryClient = own(value, 'queryClient');
    if (!client || !queryClient || typeof client !== 'object') continue;
    const prototype = Object.getPrototypeOf(client);
    const query = Object.getOwnPropertyDescriptor(prototype, 'query')?.value;
    const mutation = Object.getOwnPropertyDescriptor(prototype, 'mutation')?.value;
    const request = Object.getOwnPropertyDescriptor(prototype, 'requestAsPromise')?.value;
    if (typeof query === 'function' && typeof mutation === 'function' && typeof request === 'function') {
      // Calling the genuine untyped client preserves its links and transformer.
      return (path, input, signal) => query.call(client, path, input, { signal });
    }
  }
  fail('baseline-query-client-unavailable');
}

export function selectBaselineAction(rows, currentId) {
  if (!Array.isArray(rows)) fail('baseline-actions-incomplete');
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || !Number.isInteger(row.level) ||
        !(typeof row.createdAt === 'string' || row.createdAt instanceof Date) || !Number.isFinite(new Date(row.createdAt).getTime()) ||
        (row.workerId !== null && typeof row.workerId !== 'string')) fail('baseline-actions-invalid');
    ids.add(row.id);
    if (row.label === 'Answer' || row.assessmentPhase != null || row.answerReviewActionId != null || row.isAssessment === true) {
      fail('baseline-assessment-unsupported');
    }
  }
  const candidates = rows.filter(row => row.id !== currentId && row.level === 1);
  if (!candidates.length) candidates.push(...rows.filter(row => row.id !== currentId && row.level === 0));
  if (!candidates.length) fail('baseline-unavailable');
  let selected = candidates[0], newest = new Date(selected.createdAt).getTime(), ambiguous = false;
  for (const row of candidates.slice(1)) {
    const timestamp = new Date(row.createdAt).getTime();
    if (timestamp > newest) { selected = row; newest = timestamp; ambiguous = false; }
    else if (timestamp === newest) ambiguous = true;
  }
  if (ambiguous) fail('baseline-actions-ambiguous');
  return selected;
}

function recordings(context) {
  const native = context.root.memoizedProps.transcriptionChunkProcessedRecordings;
  const tracks = context.binding.tracks;
  if (!Array.isArray(native) || !native.length || !Array.isArray(tracks)) fail('baseline-recordings-unavailable');
  const ids = new Set();
  for (const row of native) {
    if (typeof row.processedRecordingId !== 'string' || !row.processedRecordingId || ids.has(row.processedRecordingId) ||
        tracks.filter(track => track.id === row.processedRecordingId).length !== 1) fail('baseline-recordings-ambiguous');
    ids.add(row.processedRecordingId);
  }
  if (tracks.length !== ids.size) fail('baseline-recordings-ambiguous');
  return { ids, fingerprint: canonical(native.map(row => ({ processedRecordingId: row.processedRecordingId,
    chunkedProcessedRecordingId: row.chunkedProcessedRecordingId, transcriptionChunkId: row.transcriptionChunkId, speaker: row.speaker }))) };
}

function context(expectedReviewActionId) {
  const root = findBabelEditorFiber(), binding = readBabelTranscriptBindings();
  if (!root || !binding || !expectedReviewActionId || binding.reviewActionId !== expectedReviewActionId ||
      root.memoizedProps.reviewActionId !== expectedReviewActionId || !Array.isArray(binding.annotations)) fail('baseline-task-changed');
  if (binding.readOnly || binding.panel?.readOnly || binding.transcript?.readOnly) fail('baseline-read-only');
  if (root.memoizedProps.mode !== 'transcription' || binding.panel?.mode !== 'transcription') fail('baseline-mode-unsupported');
  if (root.memoizedProps.onboarding !== undefined || binding.panel?.assessment?.phase != null ||
      binding.panel?.assessment?.answerReviewActionId != null) fail('baseline-assessment-unsupported');
  if (findNativeDescendant(root, fiber => fiber.memoizedProps?.editor?.isComposing === true || composing.has(fiber.stateNode))) fail('baseline-composition-active');
  const value = { root, binding, route: window.location.href };
  return { ...value, recordings: recordings(value) };
}

function source(context) {
  let pending = false;
  const ids = new Set();
  const rows = context.binding.annotations.map(annotation => {
    if (!annotation?.id || ids.has(annotation.id)) fail('baseline-current-source-invalid');
    ids.add(annotation.id);
    const copy = { ...annotation };
    if (annotation.type === 'transcription') {
      if (annotation.content !== null && typeof annotation.content !== 'string') fail('baseline-current-source-invalid');
      const classic = readBabelClassicInput(annotation.id);
      const turn = findNativeTurnFiber(annotation.id);
      if (turn?.memoizedProps?.readOnly || classic?.readOnly) fail('baseline-read-only');
      let live = annotation.content ?? '';
      if (classic) {
        const state = classic.input.read();
        if (state.composing) fail('baseline-composition-active');
        live = state.text;
      } else {
        if (findNativeDescendant(turn, fiber => fiber.memoizedProps?.['data-babel-classic-row'] === 'true')) fail('baseline-classic-input-unavailable');
        const editor = getNativeSlateEditor(annotation.id);
        if (editor?.isComposing) fail('baseline-composition-active');
        if (editor) {
          if (editor.children.length !== 1 || !Array.isArray(editor.children[0]?.children) ||
              editor.children[0].children.some(node => typeof node.text !== 'string' && typeof node.raw !== 'string')) fail('baseline-slate-unsupported');
          live = serializeNativeSlate(editor);
        }
        if (Object.hasOwn(context.binding.pendingTextById || {}, annotation.id)) {
          const draft = context.binding.pendingTextById[annotation.id];
          if (editor && draft !== live) fail('baseline-pending-source-changed');
          live = draft;
        }
      }
      if (typeof live !== 'string') fail('baseline-current-source-invalid');
      if (live !== (annotation.content ?? '')) {
        pending = true;
        copy.content = live;
        copy.metadata = { ...annotation.metadata, lowConfidenceResolved: true };
      }
    }
    // Genuine native text flush changes this audit field, not the editable source.
    delete copy.updatedAt;
    return copy;
  });
  return { fingerprint: canonical(rows), pending };
}

export function validateBaselineAnnotations(response, baselineId, recordingIds) {
  if (!response || !Array.isArray(response.annotations) || !Array.isArray(response.lintErrors)) fail('baseline-response-incomplete');
  const ids = new Set();
  for (const row of response.annotations) {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || row.reviewActionId !== baselineId ||
        typeof row.type !== 'string' || !row.type || !Object.hasOwn(row, 'content') ||
        !Object.hasOwn(row, 'intensity') || (row.intensity !== null && !Number.isFinite(row.intensity)) ||
        !recordingIds.has(row.processedRecordingId) || !Number.isFinite(row.startTimeInSeconds) ||
        !Number.isFinite(row.endTimeInSeconds) || row.startTimeInSeconds < 0 || row.endTimeInSeconds < row.startTimeInSeconds ||
        (row.type === 'transcription' && row.content !== null && typeof row.content !== 'string') ||
        (row.metadata != null && (typeof row.metadata !== 'object' || Array.isArray(row.metadata)))) fail('baseline-annotations-invalid');
    ids.add(row.id);
  }
  return structuredClone(response.annotations);
}

function requireSame(current, previous) {
  if (!sameRoot(current.root, previous.root) || current.route !== previous.route ||
      current.binding.reviewActionId !== previous.binding.reviewActionId ||
      current.recordings.fingerprint !== previous.recordings.fingerprint) fail('baseline-task-changed');
}

export function invalidateBaselineReset() {
  prepared = null;
  if (activePlan) activePlan.cancelled = true;
  loading?.abort();
  loading = null;
}

export function reconcileBaselineReset() {
  if (!prepared || applying) return;
  try {
    const current = context(prepared.reviewActionId);
    requireSame(current, prepared.context);
    if (Date.now() > prepared.expires || source(current).fingerprint !== prepared.source) prepared = null;
  } catch { prepared = null; }
}

export function installBaselineResetTracking() {
  const start = event => {
    const target = event.target instanceof Element ? event.target.closest(TRANSCRIPT_EDITOR_SELECTOR) : null;
    if (target) { composing.add(target); reconcileBaselineReset(); }
  };
  const end = event => { if (event.target instanceof Element) composing.delete(event.target.closest(TRANSCRIPT_EDITOR_SELECTOR)); };
  window.addEventListener('compositionstart', start, true);
  window.addEventListener('compositionend', end, true);
  window.addEventListener('input', reconcileBaselineReset, true);
  return () => {
    window.removeEventListener('compositionstart', start, true);
    window.removeEventListener('compositionend', end, true);
    window.removeEventListener('input', reconcileBaselineReset, true);
    composing.clear();
    invalidateBaselineReset();
  };
}

export async function prepareBaselineReset(request) {
  if (applying || loading) return { ok: false, reason: 'baseline-busy' };
  prepared = null;
  const controller = new AbortController();
  loading = controller;
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const initial = context(request?.expectedReviewActionId);
    source(initial);
    const query = resolveBaselineQueryClient(initial.root);
    const aborted = Promise.withResolvers();
    controller.signal.addEventListener('abort', () => aborted.reject(new Error('baseline-load-cancelled')), { once: true });
    const queryRead = (path, id) => {
      if (controller.signal.aborted) fail('baseline-load-cancelled');
      return Promise.race([query(path, { reviewActionId: id }, controller.signal), aborted.promise]);
    };
    const actions = await queryRead('transcriptions.getReviewActionsForChunk', initial.binding.reviewActionId);
    requireSame(context(request.expectedReviewActionId), initial);
    const action = selectBaselineAction(actions, initial.binding.reviewActionId);
    // Failure of an available L1 is an error, never permission to fall back to L0.
    const response = await queryRead('transcriptions.getAnnotationsByReviewActionId', action.id);
    const current = context(request.expectedReviewActionId);
    requireSame(current, initial);
    if (loading !== controller || controller.signal.aborted) fail('baseline-load-cancelled');
    if (request.deadlineAt !== undefined && (!Number.isFinite(request.deadlineAt) || Date.now() >= request.deadlineAt)) fail('baseline-load-cancelled');
    const annotations = validateBaselineAnnotations(response, action.id, current.recordings.ids);
    const effective = source(current);
    resolveNativeAnnotationTransaction(current.root, current.binding);
    prepared = { token: crypto.randomUUID(), reviewActionId: current.binding.reviewActionId, baselineReviewActionId: action.id,
      level: action.level, annotations, context: current, source: effective.fingerprint, expires: Date.now() + 300_000 };
    return { ok: true, token: prepared.token, level: action.level, segmentCount: annotations.length,
      reviewActionId: prepared.reviewActionId, baselineReviewActionId: action.id };
  } catch (error) { return resultError(error); }
  finally { clearTimeout(timer); if (loading === controller) loading = null; }
}

export function discardBaselineReset(request) {
  if (prepared?.token === request?.token) prepared = null;
  if (activePlan?.token === request?.token) activePlan.cancelled = true;
  return { ok: true };
}

function memoDependencies(root, callback) {
  for (let hook = root.memoizedState; hook; hook = hook.next) {
    if (Array.isArray(hook.memoizedState) && hook.memoizedState[0] === callback) return hook.memoizedState[1];
  }
  return null;
}

/** Resolve the same registry used by the writer's native region deletion callback. */
function regionReader(root, transaction, ids) {
  const dependencies = memoDependencies(root, transaction.writeAnnotations);
  const helpers = dependencies?.filter(value => own(value, 'isSyncingAnnotationsToWaveSurferRef') &&
    typeof own(value, 'deleteRegionFromWaveSurfer') === 'function');
  if (helpers?.length !== 1) fail('baseline-region-reader-unavailable');
  const remove = helpers[0].deleteRegionFromWaveSurfer;
  const deps = memoDependencies(root, remove);
  if (deps?.length !== 1 || typeof deps[0] !== 'function' || !/\.plugins\.regions/.test(Function.prototype.toString.call(remove))) fail('baseline-region-reader-unavailable');
  const registry = deps[0]();
  const plugins = new Map();
  for (const id of ids) {
    const plugin = registry?.[id]?.plugins?.regions;
    if (typeof plugin?.getRegions !== 'function') fail('baseline-regions-unavailable');
    plugins.set(id, plugin);
  }
  return (annotations, removed) => {
    if (deps[0]() !== registry) fail('baseline-waveforms-changed');
    const regions = new Map();
    for (const [id, plugin] of plugins) {
      if (registry[id]?.plugins?.regions !== plugin) fail('baseline-waveforms-changed');
      regions.set(id, plugin.getRegions());
    }
    return annotations.every(row => regions.get(row.processedRecordingId)?.filter(region => region.id === row.id &&
      region.start === row.startTimeInSeconds && region.end === row.endTimeInSeconds && region.data?.label === (row.content ?? '')).length === 1) &&
      removed.every(row => ![...regions.values()].some(list => list.some(region => region.id === row.id)));
  };
}

/** Wait on real commits, with a deadline rather than optimistic setter success. */
function waitForCommit(check, mutate) {
  const { promise, resolve, reject } = Promise.withResolvers();
  let stop = () => {}, timer, finished = false;
  const finish = error => { if (finished) return; finished = true; clearTimeout(timer); stop(); error ? reject(error) : resolve(); };
  const inspect = () => { try { if (check()) finish(); } catch (error) { finish(error); } };
  try {
    stop = subscribeBabelEditorCommits(inspect);
    timer = setTimeout(() => finish(new Error('baseline-commit-unconfirmed')), 3000);
    mutate();
    inspect();
  } catch (error) { finish(error); }
  return promise;
}

export async function applyBaselineReset(request) {
  if (applying || loading) return { ok: false, reason: 'baseline-busy' };
  const plan = prepared;
  prepared = null;
  if (!plan || request?.token !== plan.token || request.expectedReviewActionId !== plan.reviewActionId || Date.now() > plan.expires) {
    return { ok: false, reason: 'baseline-plan-expired' };
  }
  applying = true;
  activePlan = plan;
  try {
    const current = () => {
      if (plan.cancelled) fail('baseline-plan-cancelled');
      if (request.deadlineAt !== undefined && (!Number.isFinite(request.deadlineAt) || Date.now() >= request.deadlineAt)) fail('baseline-plan-expired');
      const value = context(plan.reviewActionId);
      requireSame(value, plan.context);
      if (source(value).fingerprint !== plan.source) fail('baseline-source-changed');
      return value;
    };
    const initial = current();
    if (source(initial).pending) {
      await waitForCommit(() => !source(current()).pending, () => {
        if (!flushBabelClassicInputs()) fail('baseline-pending-input-unavailable');
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused.matches(TRANSCRIPT_EDITOR_SELECTOR)) focused.blur();
      });
    }
    const settled = current();
    if (source(settled).pending) fail('baseline-pending-input-unavailable');
    const transaction = resolveNativeAnnotationTransaction(settled.root, settled.binding);
    const verifyRegions = regionReader(settled.root, transaction, settled.recordings.ids);
    const before = structuredClone(settled.binding.annotations);
    const timestamp = new Date().toISOString();
    const after = plan.annotations.map(row => ({ id: crypto.randomUUID(), reviewActionId: plan.reviewActionId,
      type: row.type, content: row.content, processedRecordingId: row.processedRecordingId,
      startTimeInSeconds: row.startTimeInSeconds, endTimeInSeconds: row.endTimeInSeconds, intensity: row.intensity,
      ...(Object.hasOwn(row, 'metadata') ? { metadata: row.metadata } : {}), createdAt: timestamp, updatedAt: timestamp }));
    const command = { do() { transaction.writeAnnotations(after); }, undo() { transaction.writeAnnotations(before); } };
    const historyBefore = settled.binding.history.undoStack;
    await waitForCommit(() => {
      const committed = context(plan.reviewActionId);
      requireSame(committed, settled);
      const stack = committed.binding.history?.undoStack;
      return canonical(committed.binding.annotations) === canonical(after) && Array.isArray(stack) &&
        stack.length === historyBefore.length + 1 && stack[stack.length - 1] === command && verifyRegions(after, before);
    }, () => { current(); transaction.execute(command); });
    return { ok: true, reviewActionId: plan.reviewActionId, baselineReviewActionId: plan.baselineReviewActionId,
      level: plan.level, segmentCount: after.length };
  } catch (error) { return resultError(error); }
  finally { applying = false; activePlan = null; }
}
