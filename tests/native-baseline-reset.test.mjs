import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/content/native-baseline-reset.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
  plugins: [{ name: 'baseline-native-fixture', setup(build) {
    build.onResolve({ filter: /^@nominy\/babel-babel-runtime$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
    build.onResolve({ filter: /\/native-transcript$/ }, () => ({ path: 'transcript', namespace: 'fixture' }));
    build.onResolve({ filter: /\/native-annotation-transaction$/ }, () => ({ path: 'transaction', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      runtime: `export const findBabelEditorFiber = () => globalThis.resetFixture.root;
        export const readBabelTranscriptBindings = () => globalThis.resetFixture.binding;
        export const readBabelClassicInput = id => globalThis.resetFixture.classic[id] || null;
        export const flushBabelClassicInputs = () => globalThis.resetFixture.flush();
        export const subscribeBabelEditorCommits = callback => {
          const f = globalThis.resetFixture; f.listeners.add(callback); return () => f.listeners.delete(callback);
        };`,
      transcript: `export const findNativeDescendant = (root, predicate) => root ? [root, ...(root.nodes || [])].find(predicate) || null : null;
        export const findNativeTurnFiber = () => null;
        export const getNativeSlateEditor = id => globalThis.resetFixture.slate[id] || null;
        export const serializeNativeSlate = editor => editor.children[0].children.map(node => node.raw ?? node.text).join('');
        export const TRANSCRIPT_EDITOR_SELECTOR = '[data-slate-editor="true"]';`,
      transaction: `export const resolveNativeAnnotationTransaction = () => globalThis.resetFixture.transaction;`
    }[path] }));
  } }]
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
const action = (id, level) => ({ id, level, createdAt: '2026-01-01', workerId: null });
const annotation = (id, owner = 'current', text = 'current text') => ({ id, reviewActionId: owner,
  type: 'transcription', content: text, processedRecordingId: 'speaker-b', startTimeInSeconds: 0.123456789,
  endTimeInSeconds: 7.987654321, intensity: null, metadata: { speaker: 'B', tags: ['raw'] }, createdAt: 'old', updatedAt: 'old' });

function fixture(t) {
  api.invalidateBaselineReset();
  const saved = new Map();
  const set = (name, value) => { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); };
  class Element { matches() { return true; } closest() { return this; } }
  const f = { classic: {}, slate: {}, calls: [], listeners: new Set(), writes: 0, flushes: 0,
    actions: [action('level-zero', 0), action('level-one', 1), action('current', 2), action('other-two', 2)],
    response: { annotations: [annotation('baseline-one', 'level-one', '  exact\n<raw> text  '),
      { ...annotation('baseline-two', 'level-one', 'Speaker A'), processedRecordingId: 'speaker-a', startTimeInSeconds: 8, endTimeInSeconds: 10 }], lintErrors: [] },
    binding: { reviewActionId: 'current', readOnly: false, panel: { mode: 'transcription', assessment: { phase: null } }, transcript: {},
      tracks: [{ id: 'speaker-a' }, { id: 'speaker-b' }], annotations: [annotation('existing')], pendingTextById: {},
      history: { undoStack: [], redoStack: [] } },
    root: { memoizedProps: { reviewActionId: 'current', mode: 'transcription', transcriptionChunkProcessedRecordings: [
      { processedRecordingId: 'speaker-b', chunkedProcessedRecordingId: 'chunk-b', speaker: 'B' },
      { processedRecordingId: 'speaker-a', chunkedProcessedRecordingId: 'chunk-a', speaker: 'A' }] } },
    emit() { for (const listener of [...f.listeners]) listener(); },
    flush() {
      f.flushes++;
      if (f.flushBlocked) return false;
      for (const row of f.binding.annotations) {
        const text = f.classic[row.id]?.input.read().text ?? f.binding.pendingTextById[row.id];
        if (text !== undefined) { row.content = text; row.updatedAt = 'flushed'; row.metadata = { ...row.metadata, lowConfidenceResolved: true }; }
      }
      f.binding.pendingTextById = {};
      f.onFlush?.();
      queueMicrotask(f.emit);
      return true;
    }
  };
  class NativeClient {
    query(path, input, options) { f.calls.push({ path, input, options }); return f.query?.(path, input) ?? Promise.resolve(path.endsWith('getReviewActionsForChunk') ? f.actions : f.response); }
    mutation() { throw new Error('mutation forbidden'); }
    requestAsPromise() {}
  }
  f.client = new NativeClient();
  f.root.return = { memoizedProps: { value: { client: f.client, queryClient: {} } } };
  const registry = Object.fromEntries(f.binding.tracks.map(track => [track.id, { plugins: { regions: { rows: [], getRegions() { return this.rows; } } } }]));
  const getTracksRef = () => registry;
  function deleteRegionFromWaveSurfer(row) { return getTracksRef()[row.processedRecordingId].plugins.regions; }
  function writeAnnotations(rows) {
    f.writes++;
    f.binding.annotations = rows;
    for (const [id, track] of Object.entries(registry)) track.plugins.regions.rows = rows.filter(row => row.processedRecordingId === id)
      .map(row => ({ id: row.id, start: row.startTimeInSeconds, end: row.endTimeInSeconds, data: { label: row.content ?? '' } }));
  }
  const helpers = { isSyncingAnnotationsToWaveSurferRef: { current: false }, deleteRegionFromWaveSurfer };
  f.root.memoizedState = { memoizedState: [writeAnnotations, [helpers]], next: { memoizedState: [deleteRegionFromWaveSurfer, [getTracksRef]], next: null } };
  f.transaction = { writeAnnotations, execute(command) {
    command.do(); f.binding.history.undoStack = [...f.binding.history.undoStack, command]; f.binding.history.redoStack = []; queueMicrotask(f.emit);
  } };
  set('resetFixture', f); set('Element', Element); set('HTMLElement', Element);
  set('window', { location: { href: 'https://babel.test/current' }, addEventListener() {}, removeEventListener() {} });
  set('document', { activeElement: null });
  t.after(() => { api.invalidateBaselineReset(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return f;
}
const prepare = () => api.prepareBaselineReset({ expectedReviewActionId: 'current' });
const apply = plan => api.applyBaselineReset({ token: plan.token, expectedReviewActionId: 'current' });

test('authoritative selection prefers latest valid L1, excludes current and all other levels', () => {
  const rows = [action('zero', 0), action('current', 1), action('other', 2), action('one-old', 1),
    { ...action('one-new', 1), createdAt: new Date('2026-02-01') }];
  assert.equal(api.selectBaselineAction(rows, 'current').id, 'one-new');
  assert.equal(api.selectBaselineAction([action('current', 1), action('zero', 0)], 'current').id, 'zero');
  assert.throws(() => api.selectBaselineAction([action('current', 2)], 'current'), /baseline-unavailable/);
  assert.throws(() => api.selectBaselineAction([{ ...action('answer', 0), label: 'Answer' }], 'current'), /assessment/);
  assert.throws(() => api.selectBaselineAction([action('first', 1), action('second', 1)], 'current'), /ambiguous/);
  assert.throws(() => api.selectBaselineAction([{ ...action('invalid', 1), createdAt: 'invalid' }], 'current'), /invalid/);
});

test('prepare reads genuine native query client only, sends no content, and mutates nothing', async t => {
  const f = fixture(t), before = structuredClone(f.binding.annotations), plan = await prepare();
  assert.equal(plan.ok, true); assert.equal(plan.level, 1); assert.equal(plan.segmentCount, 2);
  assert.equal('annotations' in plan, false); assert.equal(f.writes, 0); assert.equal(f.flushes, 0);
  assert.deepEqual(f.binding.annotations, before);
  assert.deepEqual(f.calls.map(call => [call.path, call.input]), [
    ['transcriptions.getReviewActionsForChunk', { reviewActionId: 'current' }],
    ['transcriptions.getAnnotationsByReviewActionId', { reviewActionId: 'level-one' }]]);
  assert.ok(f.calls.every(call => call.options.signal instanceof AbortSignal));
});

test('L0 used only if no other L1 exists; available L1 network errors never fall back', async t => {
  const f = fixture(t); f.actions = [action('level-zero', 0)];
  f.response.annotations = f.response.annotations.map(row => ({ ...row, reviewActionId: 'level-zero' }));
  assert.equal((await prepare()).level, 0);
  f.actions.push(action('level-one', 1)); f.calls = [];
  f.query = path => path.endsWith('getReviewActionsForChunk') ? Promise.resolve(f.actions) : Promise.reject(new Error('network failed'));
  assert.deepEqual(await prepare(), { ok: false, reason: 'network failed' });
  assert.equal(f.calls.length, 2); assert.equal(f.writes, 0);
});

test('malformed, partial, foreign and ambiguous baseline payloads are rejected whole', async t => {
  const f = fixture(t), original = structuredClone(f.response);
  for (const corrupt of [response => delete response.lintErrors, response => response.annotations.push(response.annotations[0]),
    response => response.annotations[0].reviewActionId = 'wrong', response => response.annotations[0].processedRecordingId = 'unknown',
    response => response.annotations[0].startTimeInSeconds = '0.1', response => delete response.annotations[0].content]) {
    f.response = structuredClone(original); corrupt(f.response);
    assert.equal((await prepare()).ok, false);
  }
  f.response = original; f.binding.tracks.push({ id: 'speaker-a' });
  assert.equal((await prepare()).ok, false); assert.equal(f.writes, 0);
});

test('whole native command preserves exact layout/content/metadata and one Undo restores all original fields', async t => {
  const f = fixture(t), before = structuredClone(f.binding.annotations), plan = await prepare();
  const result = await apply(plan); assert.equal(result.ok, true, result.reason); assert.equal(f.writes, 1);
  assert.equal(f.binding.history.undoStack.length, 1);
  for (let i = 0; i < f.response.annotations.length; i++) {
    const actual = f.binding.annotations[i], expected = f.response.annotations[i];
    assert.notEqual(actual.id, expected.id); assert.equal(actual.reviewActionId, 'current');
    for (const key of ['content', 'type', 'processedRecordingId', 'startTimeInSeconds', 'endTimeInSeconds', 'intensity', 'metadata']) assert.deepEqual(actual[key], expected[key]);
  }
  const after = structuredClone(f.binding.annotations), command = f.binding.history.undoStack[0];
  command.undo(); assert.deepEqual(f.binding.annotations, before);
  command.do(); assert.deepEqual(f.binding.annotations, after);
  assert.equal((await apply(plan)).ok, false);
});

test('deleted-all current transcript and authoritative empty baseline both work', async t => {
  const f = fixture(t); f.binding.annotations = [];
  assert.equal((await apply(await prepare())).ok, true);
  f.response.annotations = [];
  assert.equal((await apply(await prepare())).ok, true);
  assert.deepEqual(f.binding.annotations, []);
});

test('cancel, intervening text, metadata, task, route, read-only and recording changes fail before writes', async t => {
  const f = fixture(t);
  let plan = await prepare(); api.discardBaselineReset({ token: plan.token }); assert.equal((await apply(plan)).ok, false);
  const mutate = [() => f.binding.annotations[0].content += ' edit', () => f.binding.annotations[0].metadata.tags.push('edit'),
    () => window.location.href += '?changed', () => f.root.memoizedProps.transcriptionChunkProcessedRecordings[0].speaker = 'changed'];
  for (const change of mutate) { plan = await prepare(); assert.equal(plan.ok, true); change(); assert.equal((await apply(plan)).ok, false); }
  plan = await prepare(); f.binding.readOnly = true; assert.equal((await apply(plan)).ok, false); f.binding.readOnly = false;
  plan = await prepare(); f.binding.reviewActionId = 'new-task'; assert.equal((await apply(plan)).ok, false);
  assert.equal(f.writes, 0);
});

test('Classic pending genuine text is flushed only after confirmation and preserved by reset Undo', async t => {
  const f = fixture(t); f.classic.existing = { readOnly: false, input: { read: () => ({ text: 'genuine draft', composing: false }) } };
  const plan = await prepare(); assert.equal(f.flushes, 0); assert.equal(f.writes, 0);
  const result = await apply(plan); assert.equal(result.ok, true, result.reason); assert.equal(f.flushes, 1);
  f.binding.history.undoStack.at(-1).undo(); assert.equal(f.binding.annotations[0].content, 'genuine draft');
});

test('Slate pending source settles through native blur and remains in Undo', async t => {
  const f = fixture(t); f.slate.existing = { children: [{ children: [{ text: 'slate draft' }] }] };
  f.binding.pendingTextById.existing = 'slate draft';
  document.activeElement = new HTMLElement(); document.activeElement.blur = () => { f.blurred = true; };
  const result = await apply(await prepare()); assert.equal(result.ok, true, result.reason); assert.equal(f.blurred, true);
  f.binding.history.undoStack.at(-1).undo(); assert.equal(f.binding.annotations[0].content, 'slate draft');
});

test('IME, failed pending flush and cancellation during settling cannot reset', async t => {
  const f = fixture(t); f.classic.existing = { input: { read: () => ({ text: 'draft', composing: true }) } };
  assert.equal((await prepare()).reason, 'baseline-composition-active');
  f.classic.existing.input.read = () => ({ text: 'draft', composing: false });
  f.flushBlocked = true; assert.equal((await apply(await prepare())).ok, false);
  f.flushBlocked = false; const plan = await prepare(); f.onFlush = () => api.discardBaselineReset({ token: plan.token });
  assert.equal((await apply(plan)).ok, false); assert.equal(f.writes, 0);
});

test('assessment answers are never requested and arbitrary proxy provider getters are never invoked', async t => {
  const f = fixture(t); f.root.memoizedProps.onboarding = {};
  assert.equal((await prepare()).reason, 'baseline-assessment-unsupported'); assert.equal(f.calls.length, 0);
  delete f.root.memoizedProps.onboarding; f.binding.panel.assessment = { phase: 'practice' };
  assert.equal((await prepare()).ok, false); f.binding.panel.assessment = { phase: null };
  f.root.return.memoizedProps.value = Object.defineProperty({}, 'client', { get() { throw new Error('getter touched'); } });
  assert.equal((await prepare()).reason, 'baseline-query-client-unavailable'); assert.equal(f.calls.length, 0);
});

test('task switch while baseline is loading aborts without annotation query or plan', async t => {
  const f = fixture(t), gate = Promise.withResolvers(); f.query = () => gate.promise;
  const pending = prepare(); f.binding.reviewActionId = 'new-task'; gate.resolve(f.actions);
  assert.equal((await pending).ok, false); assert.equal(f.calls.length, 1); assert.equal(f.writes, 0);
});

test('source is captured at end of load; subsequent pending changes invalidate it', async t => {
  const f = fixture(t), gate = Promise.withResolvers();
  f.query = path => path.endsWith('getReviewActionsForChunk') ? Promise.resolve(f.actions) : gate.promise;
  const pending = prepare(); await Promise.resolve(); f.binding.annotations[0].content = 'during load'; gate.resolve(f.response);
  const plan = await pending; assert.equal(plan.ok, true);
  f.binding.pendingTextById.existing = 'after confirmation opened';
  api.reconcileBaselineReset(); assert.equal((await apply(plan)).ok, false); assert.equal(f.writes, 0);
});

test('nullable baseline content remains null and pre-reset source survives Undo', async t => {
  const f = fixture(t), before = structuredClone(f.binding.annotations);
  f.response.annotations[0].content = null;
  const result = await apply(await prepare()); assert.equal(result.ok, true, result.reason);
  assert.equal(f.binding.annotations[0].content, null);
  f.binding.history.undoStack.at(-1).undo(); assert.deepEqual(f.binding.annotations, before);
});

test('invalidating an in-flight preparation cancels the read and leaves no hidden plan', async t => {
  const f = fixture(t), gate = Promise.withResolvers(); f.query = () => gate.promise;
  const pending = prepare(); api.invalidateBaselineReset();
  assert.equal((await pending).reason, 'baseline-load-cancelled');
  gate.resolve(f.actions);
  assert.equal(f.writes, 0);
});

test('commit success is not published until native model, history and regions are committed', async t => {
  const f = fixture(t), plan = await prepare(), original = f.transaction.execute;
  let deferred;
  f.transaction.execute = command => { deferred = () => original(command); };
  let returned = false;
  const pending = apply(plan).then(result => { returned = true; return result; });
  await Promise.resolve();
  assert.equal(returned, false); assert.equal(f.writes, 0);
  deferred(); const result = await pending;
  assert.equal(result.ok, true, result.reason); assert.equal(f.writes, 1);
});
