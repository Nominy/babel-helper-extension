import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ts from 'typescript';
import { createNativeRenderFactories } from '../src/content/native-render-factories.generated.js';

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const algorithms = await load('src/content/native-render-algorithms.ts');
const { installNativeRenderPerformance } = await load('src/content/native-render-performance.ts');
const { prepareNativeTranscript } = await load('src/content/native-render-transcript.ts');
const factories = createNativeRenderFactories({ ...algorithms, prepareNativeTranscript });
function emitter() {
  const listeners = new Map();
  return {
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); return () => listeners.get(name).delete(callback); },
    emit(name, ...args) { for (const callback of listeners.get(name) || []) callback(...args); },
    once(name, callback) { const release = this.on(name, (...args) => { release(); callback(...args); }); return release; },
    listenerCount(name) { return listeners.get(name)?.size || 0; }
  };
}
function exportPlugin(id, optimized) {
  const contract = factories.find(contract => contract.id === id);
  // Test-only oracle executes checked-in original captured code; deployed code
  // never constructs functions or needs this test's original factory evaluator.
  const factory = optimized ? contract.factory : new Function(`return (${contract.originals[0]})`)();
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

test('active regions preserve overlap order, excluded overlays and last-array-element end rule', () => {
  const plugin = { ...emitter(), regions: [
    { id: 'first', start: 2, end: 8 }, { id: 'second', start: 0, end: 4 },
    { id: 'loop', start: 0, end: 100 }, { id: 'overlay-x', start: 0, end: 100 },
    { id: 'last', start: 4, end: 6 }
  ] };
  const native = time => {
    const eligible = plugin.regions.filter(region => region.id !== 'loop' && !region.id.startsWith('overlay-'));
    return eligible.find(region => time >= region.start && time < region.end) || eligible.find(region => time >= region.start && time === region.end && region === eligible.at(-1)) || null;
  };
  for (const time of [0, 2, 4, 6, 8, 10]) assert.equal(algorithms.activeRegion(plugin, time, 'loop', 'overlay-'), native(time));
  plugin.regions[0].start = 20;
  algorithms.invalidateRegion(plugin.regions[0]);
  for (const time of [2, 4, 6, 8]) assert.equal(algorithms.activeRegion(plugin, time, 'loop', 'overlay-'), native(time));
  const added = { id: 'new', start: 8, end: 10 };
  plugin.regions.push(added); plugin.emit('region-created', added);
  assert.equal(algorithms.activeRegion(plugin, 10, 'loop', 'overlay-'), added);
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

test('real captured region event callback matches optimized enter/exit ordering and marker end rules', () => {
  const run = optimized => {
    const Plugin = exportPlugin(94846, optimized);
    const wave = { ...emitter(), getWrapper: () => ({ appendChild() {} }) };
    const plugin = Object.assign(Object.create(Plugin.prototype), {
      listeners: {}, subscriptions: [], wavesurfer: wave, regionsContainer: {}, regions: [
        { id: 'later-first', start: 1, end: 4 }, { id: 'earlier-second', start: 0, end: 2 }, { id: 'point', start: 3, end: 3 }
      ]
    });
    const events = [];
    plugin.on('region-in', region => events.push(['in', region.id]));
    plugin.on('region-out', region => events.push(['out', region.id]));
    plugin.onInit();
    for (const time of [0, 1, 2, 2.01, 3, 3.05, 3.051, 4, 4.1, 1]) wave.emit('timeupdate', time);
    return events;
  };
  assert.deepEqual(run(true), run(false));
});

test('real captured timeline visibility agrees for edge widths and backward scroll', () => {
  const run = optimized => {
    const Plugin = exportPlugin(60039, optimized);
    const plugin = Object.create(Plugin.prototype);
    const visible = new Set();
    const container = { appendChild(element) { visible.add(element.id); } };
    plugin.notchElements = new Map(Array.from({ length: 100 }, (_, id) => [{ id, remove() { visible.delete(id); } }, { start: id * 10, width: id % 3 * 3, wasVisible: false }]));
    const snapshots = [];
    for (const [left, right] of [[0, 100], [9, 109], [500, 600], [400, 401], [0, 1000]]) {
      plugin.updateVisibleNotches(left, right, container);
      snapshots.push([...visible].sort((a, b) => a - b));
    }
    return snapshots;
  };
  assert.deepEqual(run(true), run(false));
});

test('native registry hook rejects unknown sources, composes with webpack push replacement and restores ownership', () => {
  const windowRef = { IntersectionObserver() {}, ResizeObserver() {}, webpackChunk_N_E: [] };
  const notices = [];
  const release = installNativeRenderPerformance({ windowRef, onStatus: status => notices.push(status) });
  const contract = factories.find(contract => contract.id === 60039);
  const original = new Function(`return (${contract.originals[0]})`)();
  const payload = [[1], { 60039: original }];
  const prior = windowRef.webpackChunk_N_E.push.bind(windowRef.webpackChunk_N_E);
  let nativeCalls = 0;
  const webpackPush = function(value) { nativeCalls++; return prior(value); };
  windowRef.webpackChunk_N_E.push = webpackPush;
  assert.equal(windowRef.webpackChunk_N_E.push(payload), 1);
  assert.equal(nativeCalls, 1);
  assert.notEqual(payload[1][60039], original);
  assert.equal(release.status()[60039], 'installed-exact-oct15-factory');
  const unknown = () => {};
  const unsupported = [[2], { 59327: unknown }];
  windowRef.webpackChunk_N_E.push(unsupported);
  assert.equal(unsupported[1][59327], unknown);
  assert.equal(release.status()[59327], 'unsupported-native-factory-source');
  release();
  assert.equal(payload[1][60039], original);
  assert.equal(windowRef.webpackChunk_N_E.push, webpackPush);
  assert.ok(notices.some(notice => notice.state === 'unsupported-native-factory-source'));
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
  const original = factories.find(contract => contract.id === 99407).originals[1];
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

test('all pinned raw and recovered factory sources are admitted without source rewriting at runtime', () => {
  const windowRef = { webpackChunk_N_E: [] };
  const release = installNativeRenderPerformance({ windowRef });
  for (const contract of factories) for (const source of contract.originals) {
    const original = new Function(`return (${source})`)();
    const payload = [[], { [contract.id]: original }];
    windowRef.webpackChunk_N_E.push(payload);
    assert.notEqual(payload[1][contract.id], original);
    assert.equal(release.status()[contract.id], 'installed-exact-oct15-factory');
  }
  release();
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
  const contract = factories.find(contract => contract.id === 59327);
  const source = ts.createSourceFile('editor.js', `(${optimized ? contract.factory.toString() : contract.originals[1]})`, ts.ScriptTarget.Latest, true);
  const declarations = [];
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(declarations.length, names.length);
  return new Function(...Object.keys(bindings), `${declarations.join('\n')};return {${names.join(',')}};`)(...Object.values(bindings));
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
function transcriptScenario(optimized) {
  const React = hookState(), NativeTurn = () => {}, NativeGhost = () => {};
  const copy = () => {};
  const { ok: NativeTranscript } = capturedFunctions(optimized, ['ok', 'ow', 'or', 'aM', 'aD', 't2'], {
    i: React, r: jsx, ob: NativeTurn, af: NativeGhost, ag: copy,
    aw: { xv: { isText: node => typeof node.text === 'string' } }, oy: [], __bhRender: { prepareNativeTranscript }
  });
  const props = {
    turns: [{ id: 'late', content: 'late \t word', startTimeInSeconds: 3, endTimeInSeconds: 7 }, { id: 'early', content: 'first second', startTimeInSeconds: 0, endTimeInSeconds: 4 }],
    ghosts: [{ segmentInfo: { annotationId: 'deleted', startTimeInSeconds: 2 } }], ghostsAsAdded: false,
    activeIds: new Set(['late']), editingId: 'early', tracks: [], vocabulary: [], tagOptions: [],
    lintIssues: [{ annotationId: 'early', reason: 'one' }, { annotationId: 'late', reason: 'two' }, { annotationId: 'early', reason: 'three' }],
    machineWords: [{ word: 'overlap', start: 3, end: 4 }, { word: 'before', start: 0, end: 1 }, { word: 'last-end', start: 7, end: 7 }],
    lowConfidence: { getLowConfidenceIndices: () => [0, 1], getAcknowledgedIndices: () => [0] },
    readOnly: true, localEdits: true, highlightCjkSpaces: true, diffOtherSide: 'added',
    renderActions: turn => turn.id, reviewerFor: turn => turn.id, handlers: {}, playhead: {}, lintVersion: 1
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

test('exact instrumented recreation selects its export-preserving factory and rejects altered instrumentation', () => {
  const contract = factories.find(contract => contract.id === 59327);
  assert.equal(typeof contract.recoveredOriginal, 'string');
  assert.equal(typeof contract.recoveredFactory, 'function');
  const windowRef = { webpackChunk_N_E: [] };
  const release = installNativeRenderPerformance({ windowRef });
  const production = [[], { 59327: new Function(`return (${contract.originals[0]})`)() }];
  const recovered = [[], { 59327: new Function(`return (${contract.recoveredOriginal})`)() }];
  const originalRecovered = recovered[1][59327];
  windowRef.webpackChunk_N_E.push(production, recovered);
  assert.notEqual(recovered[1][59327], originalRecovered);
  assert.notEqual(recovered[1][59327], production[1][59327]);
  assert.equal(release.status()[59327], 'installed-exact-oct15-factory');
  const changedSource = contract.recoveredOriginal.replace('"RecoveredPageController"', '"UnverifiedRecoveryExport"');
  const changed = new Function(`return (${changedSource})`)();
  const rejected = [[], { 59327: changed }];
  windowRef.webpackChunk_N_E.push(rejected);
  assert.equal(rejected[1][59327], changed);
  assert.equal(release.status()[59327], 'unsupported-native-factory-source');
  release();
  assert.equal(recovered[1][59327], originalRecovered);
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
      __bhRender: algorithms
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
  for (const optimized of [false, true]) {
    const { ag: copyNativeSelection } = capturedFunctions(optimized, ['ag'], {
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
    selection.isCollapsed = false;
  }
});

test('exact source guard rejects formatting-only edits and current lease rejects a second owner', () => {
  const windowRef = { webpackChunk_N_E: [] };
  const release = installNativeRenderPerformance({ windowRef });
  assert.throws(() => installNativeRenderPerformance({ windowRef }), /already owns/);
  for (const contract of factories) {
    const source = contract.originals[0];
    const modified = source.replace('{', '{/* unverified bytes */');
    const original = new Function(`return (${modified})`)();
    const payload = [[], { [contract.id]: original }];
    windowRef.webpackChunk_N_E.push(payload);
    assert.equal(payload[1][contract.id], original);
    assert.equal(release.status()[contract.id], 'unsupported-native-factory-source');
  }
  release();
  const next = installNativeRenderPerformance({ windowRef });
  next();
});
