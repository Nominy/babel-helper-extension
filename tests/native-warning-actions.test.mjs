import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/content/native-warning-actions.ts'], bundle: true,
  format: 'esm', platform: 'browser', write: false, logLevel: 'silent', plugins: [{
    name: 'native-warning-authority', setup(build) {
      build.onResolve({ filter: /^@nominy\/babel-babel-runtime$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const findBabelEditorFiber = () => globalThis.nativeWarningFixture.root;
        export const readBabelTranscriptBindings = () => globalThis.nativeWarningFixture.binding;
        export const subscribeBabelEditorCommits = listener => globalThis.nativeWarningFixture.subscribe(listener);
      ` }));
    }
  }] });
const { acceptAllNativeWarnings } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

function fixture(t) {
  const previous = ['window', 'nativeWarningFixture'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  } });
  const listeners = new Set(), commits = [], calls = [], clearances = [], timers = new Map();
  const window = new EventTarget();
  Object.assign(window, { location: { href: 'https://babel.test/transcription/task' },
    setTimeout(callback) { timers.set(1, callback); return 1; }, clearTimeout(id) { timers.delete(id); },
    __babelHelperLinterBridge: { recordNativeWarningAcknowledgement(annotation, task, reason) {
      clearances.push([annotation.id, task, reason]);
    } }
  });
  const annotation = (id, assertedWarnings = []) => ({ id, type: 'transcription', content: `${id} text`,
    processedRecordingId: 'speaker', startTimeInSeconds: 0, endTimeInSeconds: 1,
    metadata: { emotion: 'calm', assertedWarnings } });
  const binding = { reviewActionId: 'task', readOnly: false, panel: { readOnly: false },
    annotations: [annotation('one', ['accepted']), annotation('offscreen'), annotation('error')],
    pendingTextById: { one: 'one pending native edit' },
    transcript: { editingId: 'one', readOnly: false, lintIssues: [
      { annotationId: 'one', reason: 'accepted', severity: 'warning' },
      { annotationId: 'one', reason: 'first', severity: 'warning' },
      { annotationId: 'one', reason: 'second', severity: 'warning' },
      { annotationId: 'one', reason: 'second', severity: 'warning' },
      { annotationId: 'offscreen', reason: 'third', severity: 'warning' },
      { annotationId: 'error', reason: 'error', severity: 'error' },
      { annotationId: 'error', reason: 'prompt', severity: 'warning', signal: {} }
    ] }, controller: null };
  const h = { root: {}, binding, listeners, calls, clearances, commits, window, timers,
    selection: { anchor: 3, focus: 9 }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    render() {
      const captured = binding.annotations;
      binding.controller = { toggleWarningAssertion(id, reason) {
        calls.push([id, reason]);
        const old = captured.find(annotation => annotation.id === id);
        const existing = old.metadata.assertedWarnings;
        const next = { ...old, metadata: { ...old.metadata, assertedWarnings: existing.includes(reason)
          ? existing.filter(entry => entry !== reason) : [...existing, reason] } };
        commits.push(() => { binding.annotations = binding.annotations.map(annotation => annotation.id === id ? next : annotation); h.render(); });
      } };
    },
    async commit() { assert.ok(commits.length, 'native update pending'); commits.shift()();
      for (const listener of [...listeners]) listener(); await Promise.resolve(); },
    notify() { for (const listener of [...listeners]) listener(); }
  };
  h.render();
  globalThis.window = window; globalThis.nativeWarningFixture = h;
  return h;
}

test('accept-all awaits committed callbacks, includes offscreen issues and preserves accepted/errors/drafts/selection', async t => {
  const h = fixture(t), pending = h.binding.pendingTextById, selection = h.selection;
  const result = acceptAllNativeWarnings({ reviewActionId: 'task' });
  assert.deepEqual(h.calls, [['one', 'first']]);
  h.notify();
  assert.equal(h.calls.length, 1, 'unrelated commit is not acknowledgement');
  await h.commit();
  assert.deepEqual(h.calls, [['one', 'first'], ['one', 'second']]);
  await h.commit(); await h.commit();
  assert.deepEqual(await result, { ok: true, acceptedCount: 3 });
  assert.deepEqual(h.binding.annotations.map(value => value.metadata.assertedWarnings), [
    ['accepted', 'first', 'second'], ['third'], []
  ]);
  assert.deepEqual(h.binding.annotations.map(value => value.content), ['one text', 'offscreen text', 'error text']);
  assert.equal(h.binding.pendingTextById, pending); assert.equal(h.selection, selection);
  assert.equal(h.binding.transcript.editingId, 'one');
  assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0);
  assert.deepEqual(await acceptAllNativeWarnings({ reviewActionId: 'task' }), { ok: true, acceptedCount: 0 });
  assert.equal(h.calls.length, 3, 'accepted warnings never toggle back');
  assert.deepEqual(h.clearances, [['one', 'task', 'first'], ['one', 'task', 'second'], ['offscreen', 'task', 'third']]);
});

for (const change of ['task', 'root', 'route', 'readonly', 'pending', 'recording', 'teardown']) {
  test(`accept-all stops before the next native mutation on ${change} change`, async t => {
    const h = fixture(t);
    const result = acceptAllNativeWarnings({ reviewActionId: 'task' });
    if (change === 'task') h.binding.reviewActionId = 'next-task';
    if (change === 'root') h.root = {};
    if (change === 'route') h.window.location.href += '?next';
    if (change === 'readonly') h.binding.readOnly = true;
    if (change === 'pending') h.binding.pendingTextById.one = 'new user edit';
    if (change === 'recording') h.binding.annotations[0].processedRecordingId = 'other';
    if (change === 'teardown') h.window.dispatchEvent(new Event('babel-helper-bridge-teardown'));
    else h.notify();
    const failure = await result;
    assert.equal(failure.ok, false); assert.ok(failure.error); assert.equal(h.calls.length, 1);
    assert.equal(h.listeners.size, 0); assert.equal(h.timers.size, 0);
  });
}

test('accept-all rejects readonly, stale task and missing contracts before writes', async t => {
  const h = fixture(t);
  h.binding.readOnly = true;
  assert.equal((await acceptAllNativeWarnings({ reviewActionId: 'task' })).ok, false);
  h.binding.readOnly = false;
  assert.equal((await acceptAllNativeWarnings({ reviewActionId: 'old-task' })).ok, false);
  h.binding.controller = null;
  assert.equal((await acceptAllNativeWarnings({ reviewActionId: 'task' })).ok, false);
  h.render(); h.binding.transcript.lintIssues = null;
  assert.equal((await acceptAllNativeWarnings({ reviewActionId: 'task' })).ok, false);
  assert.equal(h.calls.length, 0);
});

test('accept-all rejects concurrent actions and stops on commit timeout without retry', async t => {
  const h = fixture(t);
  const result = acceptAllNativeWarnings({ reviewActionId: 'task' });
  assert.equal((await acceptAllNativeWarnings({ reviewActionId: 'task' })).ok, false);
  h.timers.get(1)();
  assert.match((await result).error, /timed out/);
  assert.equal(h.calls.length, 1); assert.equal(h.listeners.size, 0);
});
