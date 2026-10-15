import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ts from 'typescript';
import { createNativeRenderFactories } from '../src/content/native-render-factories.generated.js';

const bundle = await build({ entryPoints: ['src/content/native-transcript.ts'], bundle: true,
  format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`;
const { readNativeTurn, replaceNativeTurn, bindNativeSlateHistory, useNativeSlateBeforeInput } = await import(moduleUrl);

function nativeLeaveTurn(setEditing) {
  const contract = createNativeRenderFactories({}).find(contract => contract.id === 59327);
  const source = ts.createSourceFile('native-editor.js', `(${contract.originals[0]})`, ts.ScriptTarget.Latest, true);
  const controllers = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const properties = new Map(node.properties.filter(ts.isPropertyAssignment).map(property => [property.name.getText(source), property]));
      if (properties.has('editTurn') && properties.has('leaveTurn') && properties.has('selectTurn')) controllers.push(properties);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(controllers.length, 1);
  const properties = controllers[0];
  const setter = properties.get('editTurn').initializer;
  assert.ok(ts.isIdentifier(setter));
  return new Function(setter.text, `return (${properties.get('leaveTurn').initializer.getText(source)});`)(setEditing);
}

test('captured Oct15 leaveTurn cannot deactivate a newer row', () => {
  let editingId = 'first';
  const leave = nativeLeaveTurn(update => { editingId = update(editingId); });
  editingId = 'second';
  leave('first');
  assert.equal(editingId, 'second', 'late blur from the old row cannot close the current editor');
  leave('second');
  assert.equal(editingId, null);
  leave('first');
  assert.equal(editingId, null);
});

function fixture(t) {
  const previous = new Map(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const writes = [], commands = [];
  const annotation = { id: 'turn', content: 'Saved [laugh]', metadata: { owner: 'native' } };
  const transcript = { memoizedProps: { turns: [annotation], editingId: null, localEdits: false, activeIds: new Set(),
    handlers: { onActivate() {}, onDeactivate() {}, onSelect() {}, onChangeText(id, text) {
      const before = annotation.content;
      const command = { do() { annotation.content = text; }, undo() { annotation.content = before; } };
      writes.push([id, text]); commands.push(command); command.do();
    } } } };
  const panel = { memoizedProps: { annotations: [annotation], tracks: [], saveState: {}, renderTranscript() {}, onSave() {},
    onChangeAnnotationContent() { assert.fail('panel text writer is not an alternate contract'); }
  }, child: transcript };
  const editor = { memoizedProps: { reviewActionId: 'task', transcriptionChunkProcessedRecordings: [] }, child: panel };
  const root = { child: editor };
  root.stateNode = { current: root };
  editor.return = root; panel.return = editor; transcript.return = panel;
  const seed = { __reactFiber$native: editor };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => [seed] } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { getSelection: () => null } });
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { annotation, transcript, panel, editor, writes, commands };
}

test('static text replacement uses the current native writer and its global Undo', t => {
  const f = fixture(t);
  const previous = f.transcript.memoizedProps;
  const current = { ...previous, handlers: { ...previous.handlers } };
  previous.handlers.onChangeText = () => assert.fail('retired render writer');
  f.transcript.memoizedProps = current;
  assert.equal(replaceNativeTurn('turn', 'Current [laugh]', { reviewActionId: 'task' }), true);
  assert.deepEqual(f.writes, [['turn', 'Current [laugh]']]);
  assert.equal(f.annotation.content, 'Current [laugh]');
  assert.equal(f.annotation.metadata.owner, 'native');
  f.commands[0].undo();
  assert.equal(f.annotation.content, 'Saved [laugh]');
  delete current.handlers.onChangeText;
  assert.equal(replaceNativeTurn('turn', 'Unsupported'), false);
  assert.equal(f.commands.length, 1, 'missing native handler must not fall back to the panel writer');
});

test('pending Slate text and local Undo remain readable without granting read-only localEdits write authority', t => {
  const f = fixture(t);
  const localHistory = { undos: [{ operations: ['insert_text'] }], redos: [] };
  const slate = { children: [{ children: [{ text: 'Pending ' }, { type: 'tag', raw: '[laugh]', children: [{ text: '' }] }] }],
    history: localHistory, selection: null, apply() { assert.fail('read-only Slate mutation'); }, insertData() { assert.fail('read-only paste'); } };
  f.transcript.child = { memoizedProps: { turn: f.annotation, handlers: f.transcript.memoizedProps.handlers },
    child: { memoizedProps: { editor: slate } } };
  Object.assign(f.transcript.memoizedProps, { editingId: 'turn', localEdits: true, readOnly: true });
  const state = readNativeTurn('turn');
  assert.equal(state.text, 'Pending [laugh]');
  assert.equal(state.isEditing, true);
  assert.equal(state.isActive, false);
  assert.equal(state.readOnly, true);
  assert.equal(replaceNativeTurn('turn', 'Not permitted'), false);
  assert.equal(slate.history, localHistory);
  assert.equal(f.annotation.content, 'Saved [laugh]');
  assert.deepEqual(f.writes, []);
});

test('missing native history refuses a Helper replacement before changing live text or selection', t => {
  const f = fixture(t);
  const selection = { anchor: { path: [0, 0], offset: 3 }, focus: { path: [0, 0], offset: 3 } };
  const slate = { children: [{ children: [{ text: 'Live draft' }] }], selection,
    apply() { assert.fail('missing history must not change native selection'); },
    insertData() { assert.fail('missing history must not change native text'); } };
  f.transcript.child = { memoizedProps: { turn: f.annotation, handlers: f.transcript.memoizedProps.handlers },
    child: { memoizedProps: { editor: slate } } };
  assert.throws(() => replaceNativeTurn('turn', 'Replacement'), /native-slate-history-unavailable/);
  assert.equal(readNativeTurn('turn').text, 'Live draft');
  assert.equal(slate.selection, selection);
  assert.deepEqual(f.writes, []);
  assert.equal(bindNativeSlateHistory(slate, {}), slate, 'unsupported history leaves native editing intact');
  assert.throws(() => replaceNativeTurn('turn', 'Replacement'), /native-slate-history-unavailable/);
});

test('separate MAIN bundles share the exact editor history lease for replacement and deletion batches', async t => {
  const f = fixture(t);
  let activeBatch = null;
  const batches = [];
  const nativeHistory = { undos: [{ operations: ['retained native typing'] }], redos: [] };
  const slate = { children: [{ children: [{ text: 'Live draft' }] }], history: nativeHistory, selection: null,
    apply(operation) {
      assert.ok(activeBatch, 'selection belongs to the same native replacement batch');
      this.selection = operation.newProperties;
    },
    insertData(data) {
      assert.ok(activeBatch);
      this.children[0].children = [{ text: data.getData('text/plain') }];
      activeBatch.push('insert');
    },
    deleteFragment() {
      assert.ok(activeBatch);
      this.children[0].children = [{ text: '' }];
      activeBatch.push('delete');
    },
    onChange() { assert.ok(activeBatch); activeBatch.push('change'); }
  };
  f.transcript.child = { memoizedProps: { turn: f.annotation, handlers: f.transcript.memoizedProps.handlers },
    child: { memoizedProps: { editor: slate } } };
  const transfer = Object.getOwnPropertyDescriptor(globalThis, 'DataTransfer');
  Object.defineProperty(globalThis, 'DataTransfer', { configurable: true, value: class {
    setData(type, text) { assert.equal(type, 'text/plain'); this.text = text; }
    getData(type) { assert.equal(type, 'text/plain'); return this.text; }
  } });
  t.after(() => transfer ? Object.defineProperty(globalThis, 'DataTransfer', transfer) : delete globalThis.DataTransfer);
  const { bindNativeSlateHistory: bindFromFactoryBundle } = await import(`${moduleUrl}#native-factory-bundle`);
  const suppliedHistory = {
    isHistoryEditor: editor => editor === slate,
    withNewBatch(editor, operation) {
      assert.equal(editor, slate);
      assert.equal(this, suppliedHistory, 'the supplied native API owns each batch');
      assert.equal(activeBatch, null);
      activeBatch = [];
      try { operation(); batches.push(activeBatch); } finally { activeBatch = null; }
    }
  };
  assert.equal(bindFromFactoryBundle(slate, suppliedHistory), slate);
  assert.equal(replaceNativeTurn('turn', 'Replacement', { start: 2, end: 5, direction: 'backward' }), true);
  assert.equal(readNativeTurn('turn').text, 'Replacement');
  assert.deepEqual(slate.selection, { anchor: { path: [0, 0], offset: 5 }, focus: { path: [0, 0], offset: 2 } });
  assert.equal(replaceNativeTurn('turn', '', { start: 0 }), true);
  assert.equal(readNativeTurn('turn').text, '');
  assert.deepEqual(slate.selection, { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } });
  assert.deepEqual(batches, [['insert', 'change'], ['delete', 'change']]);
  assert.equal(slate.history, nativeHistory, 'Helper never replaces retained native history');
  assert.deepEqual(nativeHistory.undos, [{ operations: ['retained native typing'] }]);
  assert.deepEqual(f.writes, [], 'live editor replacements do not bypass native onChange');
});

test('native beforeinput retains its DOM-ref dependency while delegating only the latest committed controller', () => {
  let ref, stable, commit;
  const React = {
    useRef(value) { return ref ??= { current: value }; },
    useLayoutEffect(effect) { commit = effect; },
    useCallback(callback) { return stable ??= callback; }
  };
  const firstDocument = { text: '' }, nextDocument = { text: '' };
  const first = useNativeSlateBeforeInput(React, input => { firstDocument.text += input.data; });
  commit();
  first({ inputType: 'insertText', data: 'A' });
  const next = useNativeSlateBeforeInput(React, input => { nextDocument.text += input.data; });
  assert.equal(next, first, 'Slate must not detach its DOM mapping on a native parent rerender');
  next({ inputType: 'insertText', data: 'B' });
  assert.deepEqual([firstDocument.text, nextDocument.text], ['AB', ''],
    'input before commit still belongs to the current native document');
  commit();
  next({ inputType: 'insertText', data: 'C' });
  assert.deepEqual([firstDocument.text, nextDocument.text], ['AB', 'C'],
    'after commit input belongs to the newly committed native document');
});

