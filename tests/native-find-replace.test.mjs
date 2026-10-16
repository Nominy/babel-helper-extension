import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/content/native-find-replace.ts'], bundle: true, format: 'esm',
  platform: 'browser', write: false, logLevel: 'silent',
  plugins: [{ name: 'native-replacement-fixture', setup(build) {
    build.onResolve({ filter: /^@nominy\/babel-babel-runtime$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
    build.onResolve({ filter: /\/native-transcript$/ }, () => ({ path: 'transcript', namespace: 'fixture' }));
    build.onResolve({ filter: /\/native-annotation-transaction$/ }, () => ({ path: 'transaction', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      runtime: `export const findBabelEditorFiber = () => globalThis.bulkFixture.root;
        export const readBabelTranscriptBindings = () => globalThis.bulkFixture.binding;
        export const readBabelClassicInput = id => globalThis.bulkFixture.classic?.[id] || null;`,
      transcript: `export const findNativeDescendant = (root, predicate) => {
          if (!root) return null;
          return [root, ...(root.nodes || []), ...(root.fibers || [])].find(predicate) || null;
        };
        export const findNativeTurnFiber = id => globalThis.bulkFixture.turns[id] || null;
        export const getNativeSlateEditor = id => globalThis.bulkFixture.states[id]?.editor || null;
        export const serializeNativeSlate = editor => editor.children[0].children.map(node => node.text ?? node.raw).join('');
        export const TRANSCRIPT_EDITOR_SELECTOR = '[data-slate-editor="true"], textarea[data-babel-classic-input="true"]';`,
      transaction: `export const resolveNativeAnnotationTransaction = () => {
        const f = globalThis.bulkFixture;
        if (f.unsupported) throw new Error('native-annotation-transaction-unsupported');
        return {
          clearSegment(id) { f.cleared.push(id); },
          execute(command) { f.commands.push(command); command.do(); },
          writeAnnotations(update) {
            f.writes++;
            const previous = new Map(f.binding.annotations.map(annotation => [annotation.id, annotation.content]));
            f.binding.annotations = update(f.binding.annotations);
            for (const annotation of f.binding.annotations) {
              const editor = f.states[annotation.id]?.editor;
              if (editor && previous.get(annotation.id) !== annotation.content) {
                editor.children = [{ children: [{ text: annotation.content }] }];
              }
            }
          }
        };
      };`
    }[path] }));
  } }]
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);

function fixture(t) {
  api.invalidateNativeReplacementSession();
  const saved = new Map();
  const set = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const annotation = (id, content, recordingId = 'lane-a') => ({
    id, content, processedRecordingId: recordingId, type: 'transcription', startTimeInSeconds: 1,
    endTimeInSeconds: 2, metadata: { mood: 'calm', lowConfidenceResolved: false }, updatedAt: 'before'
  });
  const listeners = new Map();
  class NativeElement {
    closest(selector) { return selector.includes('[data-slate-editor="true"]') ? this : null; }
  }
  const f = { root: { fibers: [] }, enabled: true, writes: 0, commands: [], cleared: [], states: {}, turns: {},
    binding: { reviewActionId: 'task-one', readOnly: false, panel: { mode: 'transcription' }, transcript: {}, pendingTextById: {},
      annotations: [annotation('one', 'ab <ab> ab </ab> {ab} [ab]'), annotation('two', 'AB', 'lane-b'),
        annotation('untouched', 'other'), { ...annotation('not-transcription', 'ab'), type: 'annotation' }] },
    attach(id, text = f.binding.annotations.find(row => row.id === id).content) {
      const target = new NativeElement(), node = { stateNode: target };
      const turn = { memoizedProps: { readOnly: false }, nodes: [node] };
      f.turns[id] = turn;
      f.root.fibers.push(turn, node);
      f.states[id] = { editor: { children: [{ children: [{ text }] }] } };
      turn.memoizedProps.editor = f.states[id].editor;
      return target;
    },
    emit(type, target) { for (const callback of listeners.get(type) || []) callback({ target }); },
    listenerCount() { return [...listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); },
    annotation
  };
  set('bulkFixture', f);
  set('Element', NativeElement);
  set('document', { activeElement: null, documentElement: { getAttribute: () => String(f.enabled) } });
  set('window', { location: { href: 'https://babel.test/task-one' },
    addEventListener(type, callback, capture) {
      assert.equal(capture, true);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback, capture) {
      assert.equal(capture, true);
      listeners.get(type)?.delete(callback);
    }
  });
  t.after(() => {
    f.dispose?.();
    api.invalidateNativeReplacementSession();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return f;
}

const rule = (id, find, replace, options = {}) => ({ id, find, replace,
  regex: false, caseSensitive: false, wholeWord: false, enabled: true, ...options });
const rules = [rule('first', 'ab', 'xy'), rule('second', 'xy', 'done')];
const sessionId = () => api.getNativeReplacementStatus().sessionId;
const run = (id, selected = rules) => api.runNativeReplacementRules({ sessionId: id, rules: selected });
const recover = id => api.recoverNativeReplacementRules({ sessionId: id });

function assertNoMutation(f, action) {
  const annotations = structuredClone(f.binding.annotations);
  const writes = f.writes, commands = f.commands.length, cleared = [...f.cleared];
  assert.throws(action);
  assert.equal(f.writes, writes);
  assert.equal(f.commands.length, commands);
  assert.deepEqual(f.cleared, cleared);
  assert.deepEqual(f.binding.annotations, annotations);
}

test('status counts all transcription records without writes; ordered rules replace ordinary text and every raw tag spelling', t => {
  const f = fixture(t), id = sessionId();
  assert.deepEqual(api.getNativeReplacementStatus(), { ok: true, sessionId: id, segmentCount: 3, canRecover: false });
  assert.equal(f.writes, 0);
  // No row or Slate editor is mounted for either lane: the model is authoritative.
  const result = run(id);
  assert.deepEqual(result, { ok: true, sessionId: id, segmentCount: 3, canRecover: true, count: 14, changedRows: 2 });
  assert.equal(f.binding.annotations[0].content, 'done <done> done </done> {done} [done]');
  assert.equal(f.binding.annotations[1].content, 'done');
  assert.equal(f.commands.length, 1);
  assert.equal(f.writes, 1);
  assert.deepEqual(f.cleared, ['one', 'two']);
});

test('one native command preserves identity/time/speaker/irrelevant records and restores all original fields on Undo', t => {
  const f = fixture(t), id = sessionId(), originals = structuredClone(f.binding.annotations);
  const untouched = f.binding.annotations[2], unrelated = f.binding.annotations[3];
  run(id);
  assert.equal(f.binding.annotations[2], untouched);
  assert.equal(f.binding.annotations[3], unrelated);
  for (let index = 0; index < 2; index++) {
    const row = f.binding.annotations[index], original = originals[index];
    for (const key of ['id', 'type', 'processedRecordingId', 'startTimeInSeconds', 'endTimeInSeconds']) {
      assert.equal(row[key], original[key]);
    }
    assert.deepEqual(row.metadata, { mood: 'calm', lowConfidenceResolved: true });
    assert.notEqual(row.updatedAt, original.updatedAt);
  }
  const output = structuredClone(f.binding.annotations);
  f.commands[0].undo();
  assert.deepEqual(f.binding.annotations, originals);
  assert.equal(api.getNativeReplacementStatus().canRecover, false);
  f.commands[0].do();
  assert.deepEqual(f.binding.annotations, output);
  assert.equal(api.getNativeReplacementStatus().canRecover, false, 'Redo does not recreate the receipt');
  assertNoMutation(f, () => recover(id));
});

test('Recover survives popup status reads, preserves subsequent unrelated edits, is one native Undo step and is one-use', t => {
  const f = fixture(t), id = sessionId(), originalText = f.binding.annotations.map(row => row.content);
  run(id);
  f.binding.annotations[0].metadata.mood = 'excited';
  f.binding.annotations[2].content = 'independent edit';
  f.binding.annotations[3].content = 'independent non-transcription edit';
  const output = structuredClone(f.binding.annotations);
  assert.equal(api.getNativeReplacementStatus().canRecover, true);
  assert.equal(api.getNativeReplacementStatus().sessionId, id);
  const result = recover(id);
  assert.deepEqual(result, { ok: true, sessionId: id, segmentCount: 3, canRecover: false, count: 14, changedRows: 2 });
  assert.equal(f.binding.annotations[0].content, originalText[0]);
  assert.equal(f.binding.annotations[1].content, originalText[1]);
  assert.equal(f.binding.annotations[0].metadata.mood, 'excited');
  assert.equal(f.binding.annotations[2].content, 'independent edit');
  assert.equal(f.binding.annotations[3].content, 'independent non-transcription edit');
  assert.equal(f.commands.length, 2);
  assert.equal(f.writes, 2);
  const recovered = structuredClone(f.binding.annotations);
  f.commands[1].undo();
  assert.deepEqual(f.binding.annotations, output);
  f.commands[1].do();
  assert.deepEqual(f.binding.annotations, recovered);
  assertNoMutation(f, () => recover(id));
});

test('Recover targets only the latest successful non-noop run', t => {
  const f = fixture(t), id = sessionId();
  run(id);
  const first = f.binding.annotations.map(row => row.content);
  run(id, [rule('next', 'done', 'last')]);
  recover(id);
  assert.deepEqual(f.binding.annotations.map(row => row.content), first);
  assertNoMutation(f, () => recover(id));
});

for (const drift of ['source', 'removed', 'added', 'order', 'recording', 'time', 'unaffected-time', 'task', 'root', 'route',
  'readonly', 'panel-readonly', 'transcript-readonly', 'turn-readonly', 'disabled', 'composition', 'pending', 'slate', 'focused', 'capability', 'metadata']) {
  test(`Recover rejects ${drift} before any annotation, history or confidence mutation`, t => {
    const f = fixture(t), id = sessionId();
    run(id);
    if (drift === 'source') f.binding.annotations[1].content = 'subsequent edit';
    if (drift === 'removed') f.binding.annotations.splice(1, 1);
    if (drift === 'added') f.binding.annotations.push(f.annotation('new', 'done'));
    if (drift === 'order') [f.binding.annotations[0], f.binding.annotations[1]] = [f.binding.annotations[1], f.binding.annotations[0]];
    if (drift === 'recording') f.binding.annotations[1].processedRecordingId = 'other-lane';
    if (drift === 'time') f.binding.annotations[1].startTimeInSeconds = 9;
    if (drift === 'unaffected-time') f.binding.annotations[2].endTimeInSeconds = 9;
    if (drift === 'task') f.binding.reviewActionId = 'task-two';
    if (drift === 'root') f.root = { fibers: [] };
    if (drift === 'route') window.location.href += '/other';
    if (drift === 'readonly') f.binding.readOnly = true;
    if (drift === 'panel-readonly') f.binding.panel.readOnly = true;
    if (drift === 'transcript-readonly') f.binding.transcript.readOnly = true;
    if (drift === 'turn-readonly') { f.attach('two'); f.turns.two.memoizedProps.readOnly = true; }
    if (drift === 'disabled') f.enabled = false;
    if (drift === 'composition') { f.attach('two'); f.states.two.editor.isComposing = true; }
    if (drift === 'pending') f.binding.pendingTextById.two = f.binding.annotations[1].content;
    if (drift === 'slate') f.attach('two', 'uncommitted edit');
    if (drift === 'focused') document.activeElement = f.attach('two');
    if (drift === 'capability') f.unsupported = true;
    if (drift === 'metadata') f.binding.annotations[1].metadata = 'not-native-metadata';
    assertNoMutation(f, () => recover(id));
  });
}

for (const drift of ['task', 'root', 'route', 'readonly', 'disabled', 'mode', 'composition', 'turn-readonly', 'capability', 'recording', 'duplicate-id']) {
  test(`Run rejects ${drift} before any annotation, history or confidence mutation`, t => {
    const f = fixture(t), id = sessionId();
    if (drift === 'task') f.binding.reviewActionId = 'task-two';
    if (drift === 'root') f.root = { fibers: [] };
    if (drift === 'route') window.location.href += '/other';
    if (drift === 'readonly') f.binding.readOnly = true;
    if (drift === 'disabled') f.enabled = false;
    if (drift === 'mode') f.binding.panel.mode = 'review';
    if (drift === 'composition') { f.attach('two'); f.states.two.editor.isComposing = true; }
    if (drift === 'turn-readonly') { f.attach('two'); f.turns.two.memoizedProps.readOnly = true; }
    if (drift === 'capability') f.unsupported = true;
    if (drift === 'recording') f.binding.annotations[1].processedRecordingId = null;
    if (drift === 'duplicate-id') f.binding.annotations[3].id = 'one';
    assertNoMutation(f, () => run(id));
  });
}

test('native read-only localEdits cannot authorize bulk replacement or a retained recovery receipt', t => {
  const f = fixture(t), id = sessionId();
  run(id);
  Object.assign(f.binding.transcript, { readOnly: true, localEdits: true, editingId: 'one' });
  assertNoMutation(f, () => run(id));
  assertNoMutation(f, () => recover(id));
  f.binding.transcript.readOnly = false;
  assert.equal(api.getNativeReplacementStatus().canRecover, false,
    'read-only transition retires recovery ownership rather than preserving a writable capability');
});

test('affected pending text waits for native blur; previously typed text remains in native Undo', t => {
  const f = fixture(t), id = sessionId();
  f.attach('one', 'typed ab <ab>');
  f.binding.pendingTextById.one = 'typed ab <ab>';
  assertNoMutation(f, () => run(id));
  // Model the native editor's real blur commit; the engine never calls a setter.
  f.binding.annotations[0].content = f.binding.pendingTextById.one;
  delete f.binding.pendingTextById.one;
  run(id);
  assert.equal(f.binding.annotations[0].content, 'typed done <done>');
  f.commands[0].undo();
  assert.equal(f.binding.annotations[0].content, 'typed ab <ab>');
});

test('pending-only matches, stale Slate, and a still-focused affected Slate cannot silently noop or commit', t => {
  const f = fixture(t), id = sessionId();
  f.binding.annotations[0].content = 'no model match';
  f.binding.pendingTextById.one = 'ab';
  assertNoMutation(f, () => run(id));
  delete f.binding.pendingTextById.one;
  f.attach('one', 'ab');
  assertNoMutation(f, () => run(id));
  f.binding.annotations[0].content = 'ab';
  document.activeElement = f.turns.one.nodes[0].stateNode;
  assertNoMutation(f, () => run(id));
  document.activeElement = null;
  run(id);
  assert.equal(f.binding.annotations[0].content, 'done');
});

test('a pending edit with no matching rule is left untouched', t => {
  const f = fixture(t), id = sessionId(), untouched = f.binding.annotations[2];
  f.binding.pendingTextById.untouched = 'typing independently';
  f.attach('untouched', 'typing independently');
  run(id);
  assert.equal(f.binding.annotations[2], untouched);
  assert.equal(f.binding.pendingTextById.untouched, 'typing independently');
  assert.equal(f.states.untouched.editor.children[0].children[0].text, 'typing independently');
});

test('invalid rule batches fail atomically, including invalid late expressions and duplicate IDs', t => {
  const f = fixture(t), id = sessionId();
  for (const batch of [null, {}, [rule('a', 'ab', 'changed'), rule('b', '[', 'x', { regex: true })],
    [rule('same', 'ab', 'x'), rule('same', 'done', 'y')], [rule('empty', '', 'x')],
    [rule('bad', 'ab', 'x', { enabled: 'true' })]]) {
    assertNoMutation(f, () => run(id, batch));
  }
});

test('no-match, disabled, identical and net-zero batches add no history and retain the previous receipt', t => {
  const f = fixture(t), id = sessionId();
  run(id);
  f.unsupported = true;
  for (const batch of [[], [rule('missing', 'missing', 'x')], [rule('disabled', '[', 'x', { regex: true, enabled: false })],
    [rule('same', 'done', 'done')], [rule('out', 'done', 'temporary'), rule('back', 'temporary', 'done')]]) {
    const result = run(id, batch);
    assert.equal(result.count, 0);
    assert.equal(result.changedRows, 0);
    assert.equal(result.canRecover, true);
    assert.equal(f.writes, 1);
    assert.equal(f.commands.length, 1);
  }
  assertNoMutation(f, () => run(id, [rule('bad', '[', 'x', { regex: true })]));
  f.unsupported = false;
  recover(id);
  assert.equal(f.binding.annotations[1].content, 'AB');
});

test('Recover restores an originally empty nullable native content value exactly', t => {
  const f = fixture(t), id = sessionId();
  f.binding.annotations[1].content = null;
  run(id, [rule('insert', '^$', 'new', { regex: true })]);
  assert.equal(f.binding.annotations[1].content, 'new');
  recover(id);
  assert.equal(f.binding.annotations[1].content, null);
});

test('observing content drift through failed Recover also retires that receipt', t => {
  const f = fixture(t), id = sessionId();
  run(id);
  f.binding.annotations[1].content = 'edited';
  assertNoMutation(f, () => recover(id));
  f.binding.annotations[1].content = 'done';
  assertNoMutation(f, () => recover(id));
});

test('status permanently retires a receipt after affected content changes, including text changed back later', t => {
  const f = fixture(t), id = sessionId();
  run(id);
  f.binding.annotations[1].content = 'edited';
  assert.equal(api.getNativeReplacementStatus().canRecover, false);
  f.binding.annotations[1].content = 'done';
  assert.equal(api.getNativeReplacementStatus().canRecover, false);
  assertNoMutation(f, () => recover(id));
});

test('session ID survives React root alternation but changes on task/root/route replacement or explicit teardown', t => {
  const f = fixture(t), id = sessionId();
  run(id);
  const originalRoot = f.root;
  f.root = { alternate: originalRoot, fibers: [] };
  originalRoot.alternate = f.root;
  assert.equal(sessionId(), id);
  assert.equal(api.getNativeReplacementStatus().canRecover, true);
  f.root = originalRoot;
  assert.equal(sessionId(), id);
  api.invalidateNativeReplacementSession();
  const next = sessionId();
  assert.notEqual(next, id);
  assertNoMutation(f, () => recover(id));
  assert.equal(api.getNativeReplacementStatus().canRecover, false);
  f.binding.reviewActionId = 'task-two';
  assert.notEqual(sessionId(), next);
});

test('native composition listeners reject real Slate composition, ignore unrelated nodes and dispose without polling', t => {
  const f = fixture(t), id = sessionId();
  const target = f.attach('two');
  f.dispose = api.installNativeReplacementTracking();
  assert.equal(f.listenerCount(), 2);
  f.emit('compositionstart', new Element());
  assert.equal(sessionId(), id, 'unowned Slate-like node is ignored');
  f.emit('compositionstart', target);
  assertNoMutation(f, () => run(id));
  f.emit('compositionend', target);
  run(id);
  f.emit('compositionstart', target);
  assertNoMutation(f, () => recover(id));
  f.emit('compositionend', target);
  recover(id);
  f.dispose();
  f.dispose();
  assert.equal(f.listenerCount(), 0);
  assert.notEqual(sessionId(), id);
});

test('Recover rejects composition in an unaffected native segment before the tracker has seen its start', t => {
  const f = fixture(t), id = sessionId();
  run(id);
  f.attach('untouched');
  f.states.untouched.editor.isComposing = true;
  assertNoMutation(f, () => recover(id));
  f.states.untouched.editor.isComposing = false;
  recover(id);
});

test('Classic pending text and composition cannot be silently replaced by committed model text', t => {
  const f = fixture(t), id = sessionId();
  const annotation = f.binding.annotations[0];
  let text = annotation.content + ' pending', composing = false;
  f.classic = { one: { readOnly: false, input: { read: () => ({ text, composing }) } } };
  assertNoMutation(f, () => run(id));
  text = annotation.content; composing = true;
  assertNoMutation(f, () => run(id));
  composing = false; f.classic.one.readOnly = true;
  assertNoMutation(f, () => run(id));
  f.classic.one.readOnly = false;
  assert.equal(run(id).changedRows, 2);
  assert.equal(f.commands.length, 1);
});
