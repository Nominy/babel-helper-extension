import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['src/content/native-render-editor.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { createNativeEditorAdapter } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const jsx = (type, props, key) => ({ type, props, key });

function harness() {
  let active;
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const React = {
    useRef(value) { const index = active.cursor++; return active.hooks[index] ||= { current: value }; },
    useState(initial) {
      const owner = active, index = owner.cursor++;
      owner.hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [owner.hooks[index].value, next => { const state = owner.hooks[index]; state.value = typeof next === 'function' ? next(state.value) : next; owner.dirty = true; }];
    },
    useMemo(calculate, deps) {
      const index = active.cursor++, prior = active.hooks[index];
      if (!prior || !equalDeps(prior.deps, deps)) active.hooks[index] = { value: calculate(), deps };
      return active.hooks[index].value;
    },
    useCallback(callback, deps) { return React.useMemo(() => callback, deps); },
    useLayoutEffect(effect, deps) {
      const owner = active, index = owner.cursor++, prior = owner.hooks[index];
      if (!prior || !equalDeps(prior.deps, deps)) owner.effects.push(() => { prior?.release?.(); owner.hooks[index] = { deps, release: effect() }; });
    },
    useSyncExternalStore(subscribe, snapshot) {
      const owner = active, index = owner.cursor++;
      const prior = owner.hooks[index];
      if (!prior || prior.subscribe !== subscribe) owner.effects.push(() => {
        prior?.release?.();
        const record = { subscribe, snapshot, value: snapshot(), notifications: 0 };
        record.release = subscribe(() => { record.notifications++; owner.dirty = true; record.value = record.snapshot(); });
        owner.hooks[index] = record;
      });
      else prior.snapshot = snapshot;
      return snapshot();
    },
    memo(render, compare) { return { render, compare }; },
    forwardRef(render) { return { render: props => render(props, props.ref) }; }
  };
  React.useEffect = React.useLayoutEffect;
  return { React, instance(type) {
    const owner = { hooks: [], cursor: 0, effects: [], dirty: true };
    return {
      owner,
      render(props, commit = true) {
        if (!owner.dirty && type.compare?.(owner.props, props)) return owner.output;
        owner.cursor = 0; owner.effects = []; owner.dirty = false; active = owner;
        try { owner.output = (type.render || type)(props); owner.props = props; }
        finally { active = null; }
        if (commit) this.commit();
        return owner.output;
      },
      commit() { for (const effect of owner.effects.splice(0)) effect(); },
      release() { for (const hook of owner.hooks) hook?.release?.(); }
    };
  } };
}
function clock() {
  let time = 0;
  const listeners = new Set();
  return { subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, getTime: () => time,
    update(value) { time = value; for (const listener of listeners) listener(); }, listeners };
}
function setup() {
  const runtime = harness(), reports = [];
  const adapter = createNativeEditorAdapter(value => reports.push(value));
  const React = adapter.adaptImport(runtime.React);
  const runtimeJsx = { jsx, jsxs: jsx };
  return { ...runtime, nativeReact: runtime.React, React, reports, adapter, jsx: adapter.adaptImport(runtimeJsx).jsx, runtimeJsx };
}
function rowProps(playhead, id, start = 0) {
  return { turn: { id, content: 'native tokens', startTimeInSeconds: start, endTimeInSeconds: start + 2 },
    machineWords: [], issues: [], lowConfidenceWords: [], handlers: {}, playhead,
    readOnly: false, localEdits: false, isEditing: false, diffMap: null };
}

test('real native word memo stays authoritative; rows share one clock subscription with indexed notifications', () => {
  const run = setup(), playhead = clock();
  let bodies = 0, tokenizations = 0;
  function RenamedNativeTurn(props) {
    bodies++;
    const words = run.React.useMemo(() => { tokenizations++; return [
      { nativeToken: 'custom-private-tokenizer', startTime: props.turn.startTimeInSeconds, endTime: props.turn.endTimeInSeconds }
    ]; }, [props.turn.content, props.turn.startTimeInSeconds, props.turn.endTimeInSeconds, props.machineWords]);
    const snapshot = () => words.findIndex(word => playhead.getTime() >= word.startTime && playhead.getTime() < word.endTime);
    const active = run.React.useSyncExternalStore(props.playhead.subscribe, snapshot, snapshot);
    const [local, setLocal] = run.React.useState('native-local');
    return { words, active, local, setLocal, props };
  }
  const propsA = rowProps(playhead, 'a'), propsB = rowProps(playhead, 'b', 10);
  const elementA = run.jsx(RenamedNativeTurn, propsA, 'a'), elementB = run.jsx(RenamedNativeTurn, propsB, 'b');
  assert.equal(elementA.props.className, 'babel-helper-native-turn');
  assert.equal(elementA.key, 'a');
  const a = run.instance(elementA.props.children.type), b = run.instance(elementB.props.children.type);
  const first = a.render(propsA); b.render(propsB);
  assert.equal(first.words[0].nativeToken, 'custom-private-tokenizer');
  assert.equal(playhead.listeners.size, 1);
  const aStore = a.owner.hooks.find(hook => hook?.subscribe), bStore = b.owner.hooks.find(hook => hook?.subscribe);
  playhead.update(0.5); playhead.update(1.5);
  assert.equal(aStore.notifications, 0); assert.equal(bStore.notifications, 0);
  playhead.update(2); playhead.update(10); playhead.update(0);
  assert.equal(aStore.notifications, 2); assert.equal(bStore.notifications, 2);
  first.setLocal('edited');
  assert.equal(a.render(propsA).local, 'edited');
  const unchanged = { ...propsA, machineWords: [], issues: [], lowConfidenceWords: [] };
  a.render(unchanged);
  assert.equal(bodies, 3); assert.equal(tokenizations, 2);
  const changed = { ...unchanged, readOnly: true, isEditing: true, diffMap: new Map(), handlers: { onChange() {} } };
  const changedRow = a.render(changed);
  assert.equal(changedRow.props.handlers, changed.handlers);
  assert.equal(changedRow.props.readOnly, true);
  assert.equal(changedRow.props.diffMap, changed.diffMap);
  assert.equal(changedRow.props.machineWords, first.props.machineWords);
  assert.equal(tokenizations, 2);
  assert.equal(a.render(changed).local, 'edited');
  a.release(); assert.equal(playhead.listeners.size, 1);
  b.release(); assert.equal(playhead.listeners.size, 0);
  run.adapter.release();
});

test('native vocabulary dependencies refresh indexed word boundaries without disabling playback', () => {
  const run = setup(), playhead = clock();
  playhead.update(1.25);
  function NativeVocabularyTurn(props) {
    const words = run.React.useMemo(() => props.vocabulary.length
      ? [{ text: props.vocabulary[0], startTime: 0, endTime: 2 }]
      : [{ text: 'first', startTime: 0, endTime: 1 }, { text: 'second', startTime: 1, endTime: 2 }],
    [props.turn.content, props.turn.startTimeInSeconds, props.turn.endTimeInSeconds, props.machineWords, props.vocabulary]);
    const snapshot = () => words.findIndex(word => playhead.getTime() >= word.startTime && playhead.getTime() < word.endTime);
    return { words, active: run.React.useSyncExternalStore(props.playhead.subscribe, snapshot, snapshot) };
  }
  const props = { ...rowProps(playhead, 'vocabulary'), vocabulary: [] };
  const element = run.jsx(NativeVocabularyTurn, props, 'vocabulary');
  const row = run.instance(element.props.children.type);
  assert.equal(row.render(props).active, 1);
  const changed = { ...props, vocabulary: ['first second'] };
  const merged = row.render(changed);
  assert.equal(merged.active, 0);
  assert.equal(merged.words[0].text, 'first second');
  assert.equal(playhead.listeners.size, 1);
  playhead.update(2);
  assert.equal(row.render(changed).active, -1);
  assert.ok(run.reports.some(report => report.boundary === 'turn-playhead' && report.state === 'installed'));
  assert.equal(run.reports.some(report => report.state === 'unsupported'), false);
  row.release();
  assert.equal(playhead.listeners.size, 0);
  run.adapter.release();
});

test('transcript native history/copy/body survive; matching memo uses midpoint index only after validation', () => {
  const run = setup(), playhead = clock();
  let calculations = 0, bodies = 0;
  function NativePanel(props) {
    bodies++;
    const [history] = run.React.useState(() => new Map());
    const words = run.React.useMemo(() => {
      calculations++;
      return new Map(props.turns.map(turn => [turn.id, props.machineWords.filter(word => {
        const midpoint = (word.start + word.end) / 2;
        return midpoint >= (turn.startTimeInSeconds ?? 0) && midpoint < (turn.endTimeInSeconds ?? 0);
      })]));
    }, [props.machineWords, props.turns]);
    return { history, words, onCopy: props.onCopy, localEdits: props.localEdits, children: props.turns };
  }
  const props = { turns: [{ id: 'one', startTimeInSeconds: 0, endTimeInSeconds: 2 }],
    machineWords: [{ start: 1, end: 1 }, { start: 2, end: 2 }, { start: 0, end: 0 }], ghosts: [], handlers: {}, lowConfidence: {}, playhead, onCopy() {}, localEdits: true };
  const panel = run.instance(run.jsx(NativePanel, props).type);
  const first = panel.render(props);
  first.history.set('one', { undo: ['native'] });
  assert.deepEqual(first.words.get('one'), [props.machineWords[0], props.machineWords[2]]);
  const second = panel.render({ ...props, turns: [...props.turns], localEdits: false });
  assert.equal(second.history, first.history); assert.equal(second.onCopy, props.onCopy);
  assert.equal(second.localEdits, false); assert.equal(second.children.length, 1);
  assert.equal(calculations, 1); assert.equal(bodies, 2);
  assert.ok(run.reports.some(report => report.boundary === 'transcript-word-index' && report.state === 'installed'));
  run.adapter.release();
});

test('contract disagreement disables only mapping and native errors cannot leak render scope', () => {
  const run = setup(), playhead = clock();
  let calculations = 0;
  const props = { turns: [], machineWords: [], ghosts: [], handlers: {}, lowConfidence: {}, playhead };
  function ChangedPanel(props) {
    return run.React.useMemo(() => { calculations++; return { changedNativeContract: true }; }, [props.machineWords, props.turns]);
  }
  const panel = run.instance(run.jsx(ChangedPanel, props).type);
  assert.deepEqual(panel.render(props), { changedNativeContract: true });
  panel.render({ ...props, turns: [] });
  assert.equal(calculations, 2);
  assert.equal(run.reports.filter(report => report.boundary === 'transcript-word-index' && report.state === 'unsupported').length, 1);
  function ThrowingTurn() { throw new Error('native failure'); }
  const wrapped = run.jsx(ThrowingTurn, rowProps(playhead, 'bad')).props.children.type;
  assert.throws(() => run.instance(wrapped).render(rowProps(playhead, 'bad')), /native failure/);
  const outside = run.instance(() => run.React.useMemo(() => 'untouched', ['', 0, 2, props.machineWords]));
  assert.equal(outside.render({}), 'untouched');
  run.adapter.release();
});

test('Editable forwards refs/native props and uses only the latest committed beforeinput callback', () => {
  const run = setup(), calls = [], ref = {};
  function Editable() {}
  const firstProps = { ref, renderElement() {}, renderLeaf() {}, readOnly: false, onDOMBeforeInput: () => calls.push('first') };
  const firstElement = run.jsx(Editable, firstProps);
  const editable = run.instance(firstElement.type);
  const first = editable.render(firstProps), handler = first.props.onDOMBeforeInput;
  assert.equal(first.type, Editable); assert.equal(first.props.ref, ref);
  const nextProps = { ...firstProps, readOnly: true, onDOMBeforeInput: () => calls.push('second') };
  assert.equal(run.jsx(Editable, nextProps).type, firstElement.type);
  const next = editable.render(nextProps, false);
  assert.equal(next.props.onDOMBeforeInput, handler); assert.equal(next.props.readOnly, true);
  handler(); assert.deepEqual(calls, ['first']);
  editable.commit(); handler(); assert.deepEqual(calls, ['first', 'second']);
  assert.notEqual(run.React.useMemo, run.nativeReact.useMemo);
  assert.equal(run.runtimeJsx.jsx, jsx);
  run.adapter.release();
  assert.equal(run.jsx(Editable, nextProps).type, firstElement.type);
  assert.equal(editable.render(nextProps).props.onDOMBeforeInput, handler);
});

test('renamed Slate-history exports bind the actual returned editor and native API without global edits', () => {
  const run = setup(), editor = { children: [], history: { undos: ['native'], redos: [] } };
  const api = { isHistoryEditor: value => value === editor, withNewBatch(value, callback) { assert.equal(value, editor); callback(); } };
  let calls = 0;
  const original = { renamedApi: api, renamedWithHistory(value) { calls++; assert.equal(value, editor); return value; } };
  const adapted = run.adapter.adaptImport(original);
  assert.notEqual(adapted, original); assert.equal(adapted.renamedApi, api);
  assert.equal(adapted.renamedWithHistory(editor), editor);
  assert.equal(editor[Symbol.for('babel-helper/native-slate-history/oct15')], api);
  assert.equal(calls, 1); assert.deepEqual(editor.history.undos, ['native']);
  const unrelated = { something: () => 'unchanged' };
  assert.equal(run.adapter.adaptImport(unrelated), unrelated);
  assert.equal(run.adapter.adaptImport(original), adapted);
  run.adapter.release();
  assert.equal(run.adapter.adaptImport(original), adapted);
});

test('teardown preserves mounted row identity, native local state and ongoing clock notifications', () => {
  const run = setup(), playhead = clock(), props = rowProps(playhead, 'mounted');
  function NativeTurn(props) {
    const words = run.React.useMemo(() => [{ startTime: 0, endTime: 2 }],
      [props.turn.content, props.turn.startTimeInSeconds, props.turn.endTimeInSeconds, props.machineWords]);
    const snapshot = () => words.findIndex(word => playhead.getTime() >= word.startTime && playhead.getTime() < word.endTime);
    const active = run.React.useSyncExternalStore(playhead.subscribe, snapshot, snapshot);
    const [pendingEdit, edit] = run.React.useState('initial');
    return { pendingEdit, edit, active };
  }
  const element = run.jsx(NativeTurn, props, 'mounted');
  const row = run.instance(element.props.children.type);
  row.render(props).edit('uncommitted native edit');
  assert.equal(row.render(props).pendingEdit, 'uncommitted native edit');
  const hookCount = row.owner.cursor;
  run.adapter.release();
  assert.equal(run.jsx(NativeTurn, props, 'mounted').props.children.type, element.props.children.type);
  assert.equal(playhead.listeners.size, 1);
  playhead.update(3);
  const next = row.render(props);
  assert.equal(next.active, -1);
  assert.equal(next.pendingEdit, 'uncommitted native edit');
  assert.equal(row.owner.cursor, hookCount);
  assert.equal(playhead.listeners.size, 1);
  row.release();
  assert.equal(playhead.listeners.size, 0);
});

test('abandoned renders never subscribe and fully unmounted clocks can remount before teardown', () => {
  const run = setup(), playhead = clock(), props = rowProps(playhead, 'remount');
  function NativeTurn(props) {
    const words = run.React.useMemo(() => [{ startTime: 0, endTime: 2 }],
      [props.turn.content, props.turn.startTimeInSeconds, props.turn.endTimeInSeconds, props.machineWords]);
    const snapshot = () => words.findIndex(word => playhead.getTime() >= word.startTime && playhead.getTime() < word.endTime);
    return run.React.useSyncExternalStore(playhead.subscribe, snapshot, snapshot);
  }
  const type = run.jsx(NativeTurn, props).props.children.type;
  run.instance(type).render(props, false);
  assert.equal(playhead.listeners.size, 0);
  const first = run.instance(type);
  assert.equal(first.render(props), 0);
  assert.equal(playhead.listeners.size, 1);
  playhead.update(3);
  first.release();
  assert.equal(playhead.listeners.size, 0);
  const second = run.instance(type);
  assert.equal(second.render(props), -1);
  assert.equal(playhead.listeners.size, 1);
  playhead.update(1);
  assert.equal(second.render(props), 0);
  run.adapter.release();
  assert.equal(playhead.listeners.size, 1);
  second.release();
  assert.equal(playhead.listeners.size, 0);
});

test('namespace discovery does not probe dynamic RPC members or invoke unrelated APIs', () => {
  const reads = [], requests = [];
  const client = new Proxy(function() {}, {
    get(_target, key) {
      reads.push(key);
      if (key === 'query') return value => { requests.push(value); return value.id; };
      throw new Error(`Unsupported RPC member: ${String(key)}`);
    }
  });
  const adapter = createNativeEditorAdapter();
  const imported = adapter.adaptImport({ rpc: client });
  const direct = adapter.adaptImport(client);
  assert.deepEqual(reads, []);
  assert.deepEqual(requests, []);
  assert.equal(imported.rpc.query({ id: 'native-task' }), 'native-task');
  assert.equal(direct.query({ id: 'next-task' }), 'next-task');
  assert.deepEqual(reads, ['query', 'query']);
  assert.deepEqual(requests, [{ id: 'native-task' }, { id: 'next-task' }]);
  adapter.release();
});
