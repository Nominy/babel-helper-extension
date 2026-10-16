import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ts from 'typescript';
import { nativeFactorySource } from './fixtures/native-factory-source.mjs';

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const algorithms = await load('src/content/native-render-algorithms.ts');
const { installNativeRenderPerformance } = await load('src/content/native-render-performance.ts');
const { createNativeEditorAdapter } = await load('src/content/native-render-editor.ts');
function emitter() {
  const listeners = new Map();
  return {
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); return () => listeners.get(name).delete(callback); },
    emit(name, ...args) { for (const callback of listeners.get(name) || []) callback(...args); },
    once(name, callback) { const release = this.on(name, (...args) => { release(); callback(...args); }); return release; },
    listenerCount(name) { return listeners.get(name)?.size || 0; }
  };
}
function exportPlugin(id) {
  const factory = new Function(`return (${nativeFactorySource(id)})`)();
  const exports = {};
  const require = () => { throw new Error('Unexpected plugin import'); };
  require.d = (target, values) => { for (const key of Object.keys(values)) Object.defineProperty(target, key, { get: values[key] }); };
  factory({}, exports, require);
  return exports.Z;
}

test('interval lookup retains native first-match order, gaps and half-open ends', () => {
  const values = [{ start: 4, end: 9 }, { start: 0, end: 5 }, { start: 3, end: 4 }, { start: 6, end: 6 }];
  const index = new algorithms.NativeIntervalIndex(values, value => value.start, value => value.end);
  for (let time = -1; time <= 11; time += 0.125) {
    assert.deepEqual(index.query(time), values.filter(value => time >= value.start && time < value.end));
    assert.equal(index.first(time)?.value, values.find(value => time >= value.start && time < value.end));
  }
});

test('word subscriptions notify only changed snapshots, including backwards seeks and overlaps', () => {
  const clock = new algorithms.NativeRenderPlayhead();
  const calls = [0, 0, 0];
  const words = [
    [{ startTime: 0, endTime: 1 }, { startTime: 0.5, endTime: 2 }],
    [{ startTime: 10, endTime: 11 }],
    [{ startTime: 0, endTime: 0.5 }]
  ];
  const releases = words.map((list, index) => clock.subscribeWords(list, () => calls[index]++));
  let previous = words.map(list => list.findIndex(word => 0 >= word.startTime && 0 < word.endTime));
  const expected = [0, 0, 0];
  for (const time of [0.1, 0.2, 0.5, 0.9, 1, 1.1, 2, 10, 10.5, 11, 0.25]) {
    words.forEach((list, index) => { const current = list.findIndex(word => time >= word.startTime && time < word.endTime); if (current !== previous[index]) expected[index]++; previous[index] = current; });
    clock.update(time);
    assert.deepEqual(calls, expected);
  }
  releases.forEach(release => release());
  clock.update(10);
  assert.deepEqual(calls, expected);
});


test('unchanged active highlighting does not rewrite every region style', () => {
  let writes = 0;
  const regions = Array.from({ length: 500 }, (_, index) => {
    let filter = '';
    return { id: String(index), start: index, end: index + 1, element: { style: { get filter() { return filter; }, set filter(value) { writes++; filter = value; } } } };
  });
  const plugin = { ...emitter(), regions };
  algorithms.highlightRegion(plugin, '200');
  for (let index = 0; index < 100; index++) algorithms.highlightRegion(plugin, '200');
  assert.equal(writes, 1);
  algorithms.highlightRegion(plugin, '201');
  assert.equal(writes, 3);
});


test('real captured timeline visibility agrees for edge widths and backward scroll', () => {
  const run = optimized => {
    const Plugin = exportPlugin(60039);
    const plugin = Object.create(Plugin.prototype);
    const visible = new Set();
    const container = { appendChild(element) { visible.add(element.id); } };
    plugin.notchElements = new Map(Array.from({ length: 100 }, (_, id) => [{ id, remove() { visible.delete(id); } }, { start: id * 10, width: id % 3 * 3, wasVisible: false }]));
    const snapshots = [];
    for (const [left, right] of [[0, 100], [9, 109], [500, 600], [400, 401], [0, 1000]]) {
      if (optimized) algorithms.updateVisibleNotches(plugin, left, right, container);
      else plugin.updateVisibleNotches(left, right, container);
      snapshots.push([...visible].sort((a, b) => a - b));
    }
    return snapshots;
  };
  assert.deepEqual(run(true), run(false));
});

test('native editor execution survives unrelated imports and registry ownership changes', () => {
  const windowRef = { webpackChunk_N_E: [] };
  const release = installNativeRenderPerformance({ windowRef });
  function editor(module, exports, require) {
    exports.markers = ['data-turn-issues', 'data-annotation-id', 'onDraftTag'];
    const nativeAction = require('new-native-dependency');
    require.define(exports, 'run', () => {
      if (module.readOnly) throw new Error('Native readonly guard');
      return nativeAction(module);
    });
  }
  const payload = [[1], { 817: editor }];
  const prior = windowRef.webpackChunk_N_E.push.bind(windowRef.webpackChunk_N_E);
  const webpackPush = value => prior(value);
  windowRef.webpackChunk_N_E.push = webpackPush;
  windowRef.webpackChunk_N_E.push(payload);
  const module = { value: 4, readOnly: false }, exports = {};
  const require = () => target => ++target.value;
  require.define = (target, key, value) => { target[key] = value; };
  payload[1][817](module, exports, require);
  assert.equal(exports.run(), 5);
  module.readOnly = true;
  assert.throws(() => exports.run(), /Native readonly guard/);
  assert.equal(module.value, 5);
  const newer = () => {};
  payload[1][817] = newer;
  release();
  assert.equal(payload[1][817], newer);
  assert.equal(windowRef.webpackChunk_N_E.push, webpackPush);
});

test('region viewport has one scroll subscription and moves only intersecting native elements', async () => {
  let left = 0;
  const wave = { ...emitter(), getDuration: () => 100, getWidth: () => 100, getScroll: () => left };
  const attached = new Set();
  const container = { clientWidth: 1000, appendChild(element) { element.parentElement = this; attached.add(element.id); } };
  const plugin = { ...emitter(), wavesurfer: wave, regions: [] };
  for (let index = 0; index < 100; index++) {
    const region = { ...emitter(), id: String(index), start: index, end: index + 0.5 };
    const element = { id: region.id, parentElement: null, remove() { this.parentElement = null; attached.delete(this.id); } };
    region.element = element;
    algorithms.virtualAppendRegion(plugin, region, container, element);
    plugin.regions.push(region);
    plugin.emit('region-created', region);
  }
  await Promise.resolve();
  assert.equal(wave.listenerCount('scroll'), 1);
  assert.deepEqual([...attached], Array.from({ length: 10 }, (_, index) => String(index)));
  left = 500;
  wave.emit('scroll');
  assert.deepEqual([...attached], Array.from({ length: 10 }, (_, index) => String(index + 50)));
  plugin.regions[0].start = 51;
  plugin.regions[0].end = 51.5;
  algorithms.invalidateRegion(plugin.regions[0]);
  await Promise.resolve();
  assert.ok(attached.has('0'));
  plugin.emit('destroy');
  assert.equal(wave.listenerCount('scroll'), 0);
});

test('auto-center uses one clamped write with the captured renderer final position', () => {
  const original = nativeFactorySource(99407);
  const source = ts.createSourceFile('renderer.js', `(${original})`, ts.ScriptTarget.Latest, true);
  let method;
  const visit = node => {
    if (ts.isClassDeclaration(node) && node.name?.text === 'b') method = node.members.find(member => member.name?.getText(source) === 'scrollIntoView');
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(method);
  const nativeScroll = new Function(`return ({${method.getText(source)}}).scrollIntoView`)();
  const run = (optimized, left, progress, playing, autoCenter, dragging) => {
    let value = left, writes = 0;
    const scrollContainer = { scrollWidth: 1000, clientWidth: 100,
      get scrollLeft() { return value; },
      set scrollLeft(next) { writes++; value = Math.max(0, Math.min(900, next)); }
    };
    const renderer = { scrollContainer, options: { autoCenter }, isDragging: dragging };
    if (optimized) algorithms.scrollIntoView(renderer, progress, playing);
    else nativeScroll.call(renderer, progress, playing);
    return { value, writes };
  };
  for (const left of [0, 200, 900]) for (const progress of [0, 0.1, 0.4, 0.99, 1]) {
    for (const playing of [false, true]) for (const autoCenter of [false, true]) for (const dragging of [false, true]) {
      const native = run(false, left, progress, playing, autoCenter, dragging);
      const optimized = run(true, left, progress, playing, autoCenter, dragging);
      assert.equal(optimized.value, native.value);
      assert.ok(optimized.writes <= 1);
    }
  }
});


test('late installation fails closed and teardown never overwrites a newer push owner', () => {
  const late = { webpackChunk_N_E: [] };
  late.webpackChunk_N_E.push = () => 0;
  assert.throws(() => installNativeRenderPerformance({ windowRef: late }), /before the webpack runtime/);
  const windowRef = { webpackChunk_N_E: [] };
  const release = installNativeRenderPerformance({ windowRef });
  const newer = () => 123;
  Object.defineProperty(windowRef.webpackChunk_N_E, 'push', { configurable: true, writable: true, value: newer });
  release();
  assert.equal(windowRef.webpackChunk_N_E.push, newer);
});

function capturedFunctions(optimized, names, bindings) {
  const source = ts.createSourceFile('editor.js', `(${nativeFactorySource(59327)})`, ts.ScriptTarget.Latest, true);
  const declarations = [];
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(declarations.length, names.length);
  let scopedJsx = jsx;
  if (optimized && bindings.i) {
    const adapter = createNativeEditorAdapter();
    bindings = { ...bindings, i: adapter.adaptImport(bindings.i), r: adapter.adaptImport(jsx) };
    scopedJsx = bindings.r;
  }
  const functions = new Function(...Object.keys(bindings), `${declarations.join('\n')};return {${names.join(',')}};`)(...Object.values(bindings));
  if (optimized && bindings.i) {
    const original = functions[names[0]];
    functions[names[0]] = props => {
      let element = scopedJsx.jsx(original, props);
      if (element.type === 'div' && element.props.className === 'babel-helper-native-turn') element = element.props.children;
      return element.type(element.props);
    };
  }
  return functions;
}
const jsx = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
function hookState() {
  const slots = [];
  let cursor = 0;
  const memo = (callback, deps) => {
    const index = cursor++, previous = slots[index];
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps[i]))) slots[index] = { value: callback(), deps };
    return slots[index].value;
  };
  return {
    begin() { cursor = 0; },
    memo: value => value,
    forwardRef: render => props => render(props, props.ref),
    useLayoutEffect: callback => callback(),
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useRef: value => memo(() => ({ current: value }), []),
    useState(initial) {
      const slot = memo(() => ({ value: typeof initial === 'function' ? initial() : initial }), []);
      return [slot.value, value => { slot.value = typeof value === 'function' ? value(slot.value) : value; }];
    },
    useEffect() {},
    useSyncExternalStore: (_subscribe, snapshot) => snapshot()
  };
}
const transcriptPlayhead = new algorithms.NativeRenderPlayhead();
function transcriptScenario(optimized) {
  const React = hookState(), NativeTurn = () => {}, NativeGhost = () => {};
  const copy = () => {};
  const { ok: NativeTranscript } = capturedFunctions(optimized, ['ok', 'ow', 'or', 'aM', 'aD', 't2'], {
    i: React, r: jsx, ob: NativeTurn, af: NativeGhost, ag: copy,
    aw: { xv: { isText: node => typeof node.text === 'string' } }, oy: []
  });
  const props = {
    turns: [{ id: 'late', content: 'late \t word', startTimeInSeconds: 3, endTimeInSeconds: 7 }, { id: 'early', content: 'first second', startTimeInSeconds: 0, endTimeInSeconds: 4 }],
    ghosts: [{ segmentInfo: { annotationId: 'deleted', startTimeInSeconds: 2 } }], ghostsAsAdded: false,
    activeIds: new Set(['late']), editingId: 'early', tracks: [], vocabulary: [], tagOptions: [],
    lintIssues: [{ annotationId: 'early', reason: 'one' }, { annotationId: 'late', reason: 'two' }, { annotationId: 'early', reason: 'three' }],
    machineWords: [{ word: 'overlap', start: 3, end: 4 }, { word: 'before', start: 0, end: 1 }, { word: 'last-end', start: 7, end: 7 }],
    lowConfidence: { getLowConfidenceIndices: () => [0, 1], getAcknowledgedIndices: () => [0] },
    readOnly: true, localEdits: true, highlightCjkSpaces: true, diffOtherSide: 'added',
    renderActions: turn => turn.id, reviewerFor: turn => turn.id, handlers: {}, playhead: transcriptPlayhead, lintVersion: 1
  };
  const render = () => {
    React.begin();
    const panel = NativeTranscript(props);
    assert.equal(panel.props.onCopy, copy);
    assert.equal(panel.props.children[0].props.children, 'Read-only: edits are not saved');
    return panel.props.children[1].map(element => element.type === 'div' ? element.props.children : element);
  };
  return { props, render, NativeTurn };
}

test('native panel keeps rows mounted, current editing props, midpoint boundaries and per-turn history across rerenders', () => {
  const native = transcriptScenario(false), optimized = transcriptScenario(true);
  const expected = native.render(), actual = optimized.render();
  assert.equal(actual.length, 3);
  const comparable = element => { const { history, ...props } = element.props; return { props, key: element.key }; };
  assert.deepEqual(actual.map(comparable), expected.map(comparable));
  const early = actual.find(element => element.key === 'early').props;
  const late = actual.find(element => element.key === 'late').props;
  assert.equal(early.isEditing, true);
  assert.equal(late.isEditing, false);
  assert.deepEqual(early.machineWords.map(word => word.word), ['overlap', 'before']);
  assert.deepEqual(late.machineWords.map(word => word.word), ['overlap']);
  const snapshot = { value: [{ type: 'paragraph', children: [{ text: 'first second' }] }], undo: ['first'], redo: [] };
  early.history.save('early', snapshot);
  optimized.props.editingId = 'late';
  optimized.props.handlers = { onDeactivate() {} };
  const rerender = optimized.render();
  const nextEarly = rerender.find(element => element.key === 'early').props;
  const nextLate = rerender.find(element => element.key === 'late').props;
  assert.equal(nextEarly.isEditing, false);
  assert.equal(nextLate.isEditing, true);
  assert.equal(nextEarly.history, early.history);
  assert.equal(nextEarly.history.restore('early', 'first second'), snapshot);
  assert.equal(nextLate.history.restore('late', 'first second'), null);
  assert.equal(nextEarly.history.restore('early', 'changed outside editor'), null);
  assert.equal(nextEarly.history.restore('early', 'first second'), null);
  assert.equal(nextLate.handlers, optimized.props.handlers);
  const turns = optimized.props.turns;
  nextEarly.history.save('early', snapshot);
  optimized.props.turns = turns.filter(turn => turn.id !== 'early');
  assert.equal(optimized.render().some(element => element.key === 'early'), false);
  optimized.props.turns = turns;
  const remounted = optimized.render().find(element => element.key === 'early').props;
  assert.equal(remounted.history.restore('early', 'first second'), snapshot);
});


function elementOf(tree, type) {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.type === type) return tree;
  for (const child of [tree.props?.children].flat(Infinity)) {
    const found = elementOf(child, type);
    if (found) return found;
  }
  return null;
}

test('native row keeps local editing, draft suppression, history and current callbacks after optimization', () => {
  for (const optimized of [false, true]) {
    const React = hookState(), calls = [];
    const { ob: NativeTurn } = capturedFunctions(optimized, ['ob', 'ox', 'ax', 'ap', 'av', 'oi'], {
      i: React, r: jsx, np: { cn: (...values) => values.filter(Boolean).join(' ') },
      on: () => [], aU: new Set(['draft-warning']), a4: () => false,
      oo: 'timestamp', iW: { Z: 'play-icon' }, op: 'status', ry: 'diff', rf: 'text', a6: 'editor', ov: 'issues',
    });
    const history = { save() {}, restore() {} };
    const props = {
      turn: { id: 'row', content: '[draft] text', startTimeInSeconds: 0, endTimeInSeconds: 1 },
      number: 1, handlers: {
        onDeactivate: id => calls.push(['deactivate', id]),
        onActivate: id => calls.push(['activate', id]),
        onChangeText: (id, text) => calls.push(['change', id, text]),
        onDelete: id => calls.push(['delete', id])
      },
      tracks: [], issues: [
        { reason: 'draft-warning', severity: 'warning', highlights: [{ start: 0, end: 7 }] },
        { reason: 'unrelated', severity: 'error', highlights: [{ start: 8, end: 12 }] }
      ],
      lowConfidenceWords: [], machineWords: [], playhead: new algorithms.NativeRenderPlayhead(),
      readOnly: true, localEdits: true, isEditing: true, highlightCjkSpaces: true, diffMap: null, lintVersion: 1, history
    };
    const render = () => { React.begin(); return NativeTurn(props); };
    let tree = render();
    assert.equal(elementOf(tree, 'text').props.readOnly, false);
    assert.equal(elementOf(tree, 'text').props.highlightCjkSpaces, true);
    elementOf(tree, 'text').props.onStartEdit({ start: 1, end: 1 });
    tree = render();
    const editor = elementOf(tree, 'editor').props;
    assert.equal(editor.history, history);
    editor.onFocus();
    editor.onChange('local edit');
    assert.deepEqual(calls, [['activate', 'row'], ['change', 'row', 'local edit']]);
    assert.equal(editor.onDeleteEmpty(), false);
    editor.onDraftTag({ start: 0, end: 7, text: '[draft]' });
    tree = render();
    assert.deepEqual(elementOf(tree, 'issues').props.issues.map(issue => issue.reason), ['unrelated']);
    assert.deepEqual(elementOf(tree, 'editor').props.lintSpans, [{ start: 8, end: 12, severity: 'error' }]);
    elementOf(tree, 'editor').props.onDraftTag(null);
    tree = render();
    assert.deepEqual(elementOf(tree, 'issues').props.issues.map(issue => issue.reason), ['draft-warning', 'unrelated']);
    props.handlers = { ...props.handlers, onChangeText: (id, text) => calls.push(['current-change', id, text]) };
    tree = render();
    elementOf(tree, 'editor').props.onChange('latest edit');
    tree.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
    assert.deepEqual(calls.slice(-2), [['current-change', 'row', 'latest edit'], ['deactivate', 'row']]);
    elementOf(tree, 'editor').props.onBlur();
    props.localEdits = false;
    tree = render();
    assert.equal(elementOf(tree, 'text').props.readOnly, true);
    props.diffMap = new Map();
    props.diffOtherSide = 'deleted';
    tree = render();
    assert.equal(elementOf(tree, 'diff').props.otherSideStatus, 'deleted');
    assert.equal(elementOf(tree, 'editor'), null);
  }
});

test('native copy preserves raw tags, partial selections and row boundaries without copying CJK decorations', () => {
  class TextNode {
    constructor(data, raw = null) {
      this.data = data;
      this.parentElement = { closest: () => raw };
    }
  }
  const rawTag = { getAttribute: () => '[laugh]' };
  const nodes = [new TextNode('prefix hello '), new TextNode('pretty', rawTag), new TextNode(' tag', rawTag), new TextNode('\uFEFF world'), new TextNode('second tail')];
  const rows = [{ nodes: nodes.slice(0, 4) }, { nodes: nodes.slice(4) }];
  const range = { startContainer: nodes[0], startOffset: 7, endContainer: nodes[4], endOffset: 6, intersectsNode: () => true };
  const selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range };
  const { ag: copyNativeSelection } = capturedFunctions(false, ['ag'], {
    window: { getSelection: () => selection }, Text: TextNode, NodeFilter: { SHOW_TEXT: 4 },
    document: { createTreeWalker: row => { let index = 0; return { nextNode: () => row.nodes[index++] }; } }
  });
  const copied = [];
  const event = {
    defaultPrevented: false,
    currentTarget: { querySelectorAll: () => rows },
    preventDefault() { this.defaultPrevented = true; },
    clipboardData: { setData: (...args) => copied.push(args) }
  };
  copyNativeSelection(event);
  assert.deepEqual(copied, [['text/plain', 'hello [laugh] world\nsecond']]);
  copyNativeSelection(event);
  assert.equal(copied.length, 1);
  selection.isCollapsed = true;
  event.defaultPrevented = false;
  copyNativeSelection(event);
  assert.equal(copied.length, 1);
  assert.equal(event.defaultPrevented, false);
});

test('an active document rejects another owner and can be reacquired after release', () => {
  const windowRef = { webpackChunk_N_E: [] };
  const release = installNativeRenderPerformance({ windowRef });
  assert.throws(() => installNativeRenderPerformance({ windowRef }), /already owns/);
  release();
  installNativeRenderPerformance({ windowRef })();
});
