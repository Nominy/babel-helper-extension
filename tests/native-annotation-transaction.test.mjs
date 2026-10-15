import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/content/native-annotation-transaction.ts'], bundle: true,
  format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { resolveNativeAnnotationTransaction } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const hooks = entries => entries.reduceRight((next, memoizedState) => ({ memoizedState, next }), null);

function fixture() {
  let annotations = [{ id: 'one', content: 'before' }];
  const initial = annotations;
  const commands = [], cleared = [];
  const history = { executeAndPush(command) { command.do(); commands.push(command); } };
  const execute = command => history.executeAndPush(command);
  const writer = update => {
    const native = { isSyncingAnnotationsToWaveSurferRef: { current: false } };
    if (!native.isSyncingAnnotationsToWaveSurferRef.current) {
      annotations = "function" == typeof update ? update(annotations) : update;
    }
  };
  const confidence = { clearSegment(id) { cleared.push(id); } };
  const makeMerge = () => (id, direction) => ({
    content: direction === "above" ? 'previous current' : 'current next',
    start: Math.min(1, 2), end: Math.max(3, 4), lowConfidenceResolved: true, undo: () => {}
  });
  const merge = makeMerge();
  const retainedWrapper = () => { throw new Error('The old panel callback must never choose or execute the transaction'); };
  const currentWrapper = (id, direction) => { confidence.clearSegment(id); merge(id, direction); };
  const controller = { mergeUp(id) { currentWrapper(id, 'above'); } };
  const dependencies = [currentWrapper];
  const entries = [[currentWrapper, [confidence, merge]], [merge, [initial, execute, writer]],
    [execute, [history]], [controller, dependencies]];
  const alternate = { memoizedState: hooks([[() => {}, []]]) };
  const current = { alternate, memoizedState: hooks(entries) };
  alternate.alternate = current;
  const binding = { annotations: initial, panel: { onMergeAnnotations: retainedWrapper }, controller, history };
  return { current, binding, commands, cleared, entries, dependencies, makeMerge, confidence, execute, writer,
    refresh() { current.memoizedState = hooks(entries); }, annotations: () => annotations };
}

test('a panel callback older than both render slots cannot block a current native transaction or Undo', () => {
  const f = fixture();
  const capability = resolveNativeAnnotationTransaction(f.current, f.binding);
  const before = f.annotations();
  capability.clearSegment('one');
  capability.execute({
    do() { capability.writeAnnotations(rows => rows.map(row => ({ ...row, content: 'after' }))); },
    undo() { capability.writeAnnotations(before); }
  });
  assert.deepEqual(f.annotations(), [{ id: 'one', content: 'after' }]);
  f.commands[0].undo();
  assert.deepEqual(f.annotations(), [{ id: 'one', content: 'before' }]);
});

for (const drift of ['annotations', 'history', 'foreign-controller', 'alternate-only-controller', 'raw-setter', 'ambiguous-command']) {
  test(`current controller rejects ${drift} without mutation`, () => {
    const f = fixture();
    if (drift === 'annotations') f.binding.annotations = [{ id: 'replacement', content: 'different task data' }];
    if (drift === 'history') f.binding.history = { executeAndPush() { throw new Error('foreign history'); } };
    if (drift === 'foreign-controller') f.binding.controller = { ...f.binding.controller };
    if (drift === 'alternate-only-controller') {
      f.current.alternate.memoizedState = f.current.memoizedState;
      f.current.memoizedState = null;
    }
    if (drift === 'raw-setter') f.entries[1][1][2] = () => { throw new Error('raw setter'); };
    if (drift === 'ambiguous-command') {
      const merge = f.makeMerge(), confidence = f.confidence;
      const wrapper = (id, direction) => { confidence.clearSegment(id); merge(id, direction); };
      f.dependencies.push(wrapper);
      f.entries.push([wrapper, [confidence, merge]], [merge, [f.binding.annotations, f.execute, f.writer]]);
      f.refresh();
    }
    assert.throws(() => resolveNativeAnnotationTransaction(f.current, f.binding));
    assert.deepEqual(f.annotations(), [{ id: 'one', content: 'before' }]);
    assert.equal(f.commands.length, 0);
    assert.deepEqual(f.cleared, []);
  });
}
