import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/content/native-annotation-transaction.ts'], bundle: true,
  format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { resolveNativeAnnotationTransaction } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

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
  const merge = () => ({ lowConfidenceResolved: true, undo: () => {} });
  const retainedWrapper = (id, direction) => { confidence.clearSegment(id); merge(id, direction); };
  const currentWrapper = (id, direction) => { confidence.clearSegment(id); merge(id, direction); };
  const hooks = entries => entries.reduceRight((next, memoizedState) => ({ memoizedState, next }), null);
  const alternate = { memoizedState: hooks([[retainedWrapper, [confidence, merge]],
    [merge, [initial, execute, writer]], [execute, [history]]]) };
  const current = { alternate, memoizedState: hooks([[currentWrapper, [confidence, merge]]]) };
  alternate.alternate = current;
  const binding = { annotations: initial, panel: { onMergeAnnotations: retainedWrapper }, history };
  return { current, binding, commands, cleared, annotations: () => annotations };
}

test('a retained panel callback resolves its exact alternate ownership and remains natively undoable', () => {
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

for (const drift of ['annotations', 'history', 'foreign-callback']) {
  test(`retained ownership rejects ${drift} drift without mutation`, () => {
    const f = fixture();
    if (drift === 'annotations') f.binding.annotations = [{ id: 'replacement', content: 'different task data' }];
    if (drift === 'history') f.binding.history = { executeAndPush() { throw new Error('foreign history'); } };
    if (drift === 'foreign-callback') f.binding.panel.onMergeAnnotations = () => {};
    assert.throws(() => resolveNativeAnnotationTransaction(f.current, f.binding), /native-annotation-/);
    assert.deepEqual(f.annotations(), [{ id: 'one', content: 'before' }]);
    assert.equal(f.commands.length, 0);
    assert.deepEqual(f.cleared, []);
  });
}
