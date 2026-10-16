import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: `
  export { replaceClassicTurns, readNativeTurn, replaceNativeTurn } from './src/content/native-transcript';
  export { registerBabelClassicInput } from '@nominy/babel-babel-runtime';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
const hooks = entries => entries.reduceRight((next, memoizedState) => ({ memoizedState, next }), null);

function fixture(t) {
  const installed = new Map();
  function install(key, value) {
    installed.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => { for (const [key, descriptor] of installed) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  let annotations = ['first', 'second', 'untouched'].map((id, index) => ({ id, content: id, type: 'transcription',
    processedRecordingId: 'lane', startTimeInSeconds: index * 3, endTimeInSeconds: index * 3 + 2,
    metadata: { preserved: id }, updatedAt: 'original' }));
  const original = annotations, cleared = [], inputs = new Map(), hosts = new Map();
  const history = { undoStack: [], redoStack: [],
    executeAndPush(command) { command.do(); this.undoStack.push(command); this.redoStack = []; },
    undo() { const command = this.undoStack.pop(); if (command) { command.undo(); this.redoStack.push(command); } },
    redo() { const command = this.redoStack.pop(); if (command) { command.do(); this.undoStack.push(command); } } };
  const execute = command => history.executeAndPush(command);
  const writer = update => {
    const native = { isSyncingAnnotationsToWaveSurferRef: { current: false } };
    if (!native.isSyncingAnnotationsToWaveSurferRef.current) {
      annotations = 'function' == typeof update ? update(annotations) : update;
      commit();
    }
  };
  const confidence = { clearSegment(id) { cleared.push(id); } };
  const merge = (id, direction) => ({ content: direction === 'above' ? 'above' : 'below',
    start: Math.min(1, 2), end: Math.max(3, 4), lowConfidenceResolved: true, undo: () => {} });
  const wrapper = (id, direction) => { confidence.clearSegment(id); merge(id, direction); };
  const controller = { editTurn() {}, leaveTurn() {}, selectTurn() {}, seekTurn() {}, updateTime() {},
    updateText(id, text) {
      const before = annotations.find(turn => turn.id === id), after = { ...before, content: text };
      execute({ do() { writer(rows => rows.map(row => row.id === id ? after : row)); },
        undo() { writer(rows => rows.map(row => row.id === id ? before : row)); } });
    }, split() {}, remove() {}, toggleWarningAssertion() {}, mergeUp(id) { wrapper(id, 'above'); } };
  const handlers = { onActivate: controller.editTurn, onDeactivate: controller.leaveTurn,
    onSelect: controller.selectTurn, onChangeText: controller.updateText };
  const transcript = { memoizedProps: { turns: annotations, editingId: 'first', handlers } };
  const panel = { memoizedProps: { annotations, saveState: {}, renderTranscript() {}, onSave() {} },
    memoizedState: { memoizedState: history, queue: { getSnapshot: () => history } }, child: transcript };
  const workbench = { memoizedProps: { reviewActionId: 'task', transcriptionChunkProcessedRecordings: [] }, child: panel };
  const root = { child: workbench }; root.stateNode = { current: root };
  workbench.return = root; panel.return = workbench; transcript.return = panel;
  const document = { querySelectorAll: () => [{ __reactFiber$classic: workbench }] };
  install('document', document); install('window', { getSelection: () => null });
  for (const annotation of annotations) {
    const row = { isConnected: true, ownerDocument: document, getAttribute: name =>
      name === 'data-annotation-id' ? annotation.id : name === 'data-babel-classic-row' ? 'true' : null };
    const host = { memoizedProps: { turn: annotation, handlers }, child: { stateNode: row,
      memoizedProps: { 'data-babel-classic-row': 'true' } } };
    host.return = transcript; host.child.return = host;
    const input = { annotation, reviewActionId: 'task', handlers, readOnly: false, text: annotation.content,
      start: 1, end: 2, direction: 'backward', composing: false,
      read() { return { text: this.text, start: this.start, end: this.end, direction: this.direction, composing: this.composing, editor: null }; },
      flush() { if (this.text !== this.annotation.content) controller.updateText(this.annotation.id, this.text); return true; },
      batchNative(callback) { callback(); },
      select(start, end, direction) { Object.assign(this, { start, end, direction }); return true; },
      replace(text, options) { this.flush(); controller.updateText(this.annotation.id, text); return this.select(options.start, options.end, options.direction); }
    };
    inputs.set(annotation.id, input); hosts.set(annotation.id, host);
    api.registerBabelClassicInput(row, input);
  }
  function commit() {
    panel.memoizedProps.annotations = annotations;
    transcript.memoizedProps.turns = annotations;
    const list = [...hosts.values()]; transcript.child = list[0];
    for (let index = 0; index < list.length; index++) list[index].sibling = list[index + 1] || null;
    for (const annotation of annotations) {
      const input = inputs.get(annotation.id);
      if (input.annotation !== annotation) { input.annotation = annotation; input.text = annotation.content; }
      hosts.get(annotation.id).memoizedProps.turn = annotation;
    }
    workbench.memoizedState = hooks([[wrapper, [confidence, merge]], [merge, [annotations, execute, writer]],
      [execute, [history]], [controller, [wrapper]]]);
  }
  commit();
  const change = (id, text) => {
    const source = inputs.get(id);
    return { annotationId: id, before: source.text, text, processedRecordingId: source.annotation.processedRecordingId,
      startSeconds: source.annotation.startTimeInSeconds, endSeconds: source.annotation.endTimeInSeconds };
  };
  return { inputs, original, cleared, history, panel, workbench, change, annotations: () => annotations };
}

test('Classic cross-row replacement flushes typing first then makes one native reversible command', t => {
  const f = fixture(t);
  f.inputs.get('first').text = 'typed first';
  const request = { reviewActionId: 'task', changes: [f.change('first', 'left'), f.change('second', 'right')] };
  assert.equal(api.replaceClassicTurns(request), true);
  assert.equal(f.history.undoStack.length, 2, 'native typing flush and multirow command are separate Undo steps');
  assert.deepEqual(f.annotations().map(row => row.content), ['left', 'right', 'untouched']);
  assert.equal(f.annotations()[2], f.original[2]);
  for (let index = 0; index < 2; index++) {
    assert.equal(f.annotations()[index].startTimeInSeconds, f.original[index].startTimeInSeconds);
    assert.equal(f.annotations()[index].endTimeInSeconds, f.original[index].endTimeInSeconds);
    assert.equal(f.annotations()[index].metadata.preserved, f.original[index].id);
    assert.notEqual(f.annotations()[index].updatedAt, 'original');
    assert.equal(f.inputs.get(f.original[index].id).direction, 'backward');
  }
  f.history.undo();
  assert.deepEqual(f.annotations().map(row => row.content), ['typed first', 'second', 'untouched']);
  assert.equal(f.annotations()[1].updatedAt, 'original');
  f.history.redo();
  assert.deepEqual(f.annotations().map(row => row.content), ['left', 'right', 'untouched']);
});

test('Classic cross-row source, task, timing, readonly and composition failures write no rows', t => {
  const f = fixture(t);
  for (const mutate of [
    request => { request.reviewActionId = 'other'; },
    request => { request.changes[1].before = 'stale'; },
    request => { request.changes[1].processedRecordingId = 'other-lane'; },
    request => { request.changes[1].startSeconds = 77; },
    () => { f.inputs.get('second').readOnly = true; },
    () => { f.inputs.get('second').composing = true; }
  ]) {
    f.inputs.get('second').readOnly = false; f.inputs.get('second').composing = false;
    const request = { reviewActionId: 'task', changes: [f.change('first', 'left'), f.change('second', 'right')] };
    mutate(request);
    assert.equal(api.replaceClassicTurns(request), false);
    assert.equal(f.annotations(), f.original);
    assert.equal(f.history.undoStack.length, 0);
    assert.deepEqual(f.cleared, []);
  }
});
