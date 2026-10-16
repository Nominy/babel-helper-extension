import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  stdin: { contents: `
    export * from './src/content/native-tag-dropdown-keyboard';
    export * from './src/features/native-tag-dropdown-keyboard-feature';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent'
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);

class ElementFixture {
  constructor(kind, parent = null) { this.kind = kind; this.parentElement = parent; this.isConnected = true; this.attributes = new Map(); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  closest(selector) {
    if ((this.kind === 'editor' && selector.includes('[data-slate-editor="true"]')) ||
        (this.kind === 'row' && selector.includes('section[data-annotation-id]'))) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
}

function harness(t) {
  const root = new ElementFixture('root');
  const row = new ElementFixture('row', root);
  row.setAttribute('data-annotation-id', 'turn-one');
  const editable = new ElementFixture('editor', row);
  const selection = { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 5 } };
  const slate = { children: [{ children: [{ text: 'apple pear' }] }], selection, apply() { assert.fail('keyboard navigation must not edit Slate selection/text'); } };
  const state = { kind: 'style', span: { start: 0, end: 5 }, filter: '', highlighted: 0, byKeyboard: false };
  const options = [{ name: 'quiet' }, { name: 'loud' }, { name: 'singing' }];
  const picks = [];
  const frames = new Map();
  let frameId = 0;
  const list = new ElementFixture('list', row);
  Object.assign(list, { tagName: 'UL', scrollTop: 0, clientTop: 2, clientHeight: 60, scrollHeight: 120 });
  const scrolls = [];
  list.getBoundingClientRect = () => ({ top: 100, bottom: 164, height: 64 });
  list.scrollTo = ({ top }) => { list.scrollTop = top; scrolls.push(top); };
  list.children = { get length() { return options.length; }, item(index) {
    if (index < 0 || index >= options.length) return null;
    const item = new ElementFixture('item', list);
    item.getBoundingClientRect = () => {
      const top = 102 + index * 40 - list.scrollTop;
      return { top, bottom: top + 40, height: 40 };
    };
    return item;
  } };
  root.scrollTop = 47; row.scrollTop = 83;
  root.scrollIntoView = row.scrollIntoView = list.scrollIntoView = () => assert.fail('must not scroll ancestors');
  const insertion = { wrap: { state, options }, pickWrap(option) { picks.push(option); insertion.wrap.state = null; } };
  const hook = { memoizedState: state, queue: { dispatch(update) {
    hook.memoizedState = update(hook.memoizedState);
    insertion.wrap.state = hook.memoizedState;
  } } };
  const fiber = (props = {}, children = []) => {
    const node = { memoizedProps: props };
    node.child = children[0];
    children.forEach((child, index) => { child.return = node; child.sibling = children[index + 1]; });
    return node;
  };
  const host = fiber(); host.stateNode = editable;
  const menuHost = fiber({ role: 'list' }); menuHost.stateNode = list;
  const menu = fiber({
    get options() { return insertion.wrap.state ? insertion.wrap.options : insertion.tags?.query?.options; },
    get highlighted() { return insertion.wrap.state ? insertion.wrap.state.highlighted : insertion.tags?.highlighted; },
    get onPick() { return insertion.wrap.state ? insertion.pickWrap : insertion.pickTag; }
  }, [menuHost]);
  const owner = fiber({}, [fiber({ editor: slate }, [host]), fiber({ insertion }, [menu])]);
  owner.memoizedState = hook;
  const turn = fiber({ turn: { id: 'turn-one' }, handlers: {} }, [owner]);
  const transcript = fiber({ turns: [], editingId: null, handlers: { onActivate() {}, onDeactivate() {}, onSelect() {}, onChangeText() {} } }, [turn]);
  const panel = fiber({ annotations: [{ id: 'turn-one' }], saveState: {}, renderTranscript() {}, onSave() {} }, [transcript]);
  const workbench = fiber({ reviewActionId: 'task-one', transcriptionChunkProcessedRecordings: [] }, [panel]);
  const committed = fiber({}, [workbench]); committed.stateNode = { current: committed };
  row.__reactFiber$test = host;
  const doc = { documentElement: root, querySelectorAll: () => [row] };
  for (const [key, value] of Object.entries({
    document: doc, Element: ElementFixture, HTMLElement: ElementFixture,
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  const feature = api.createNativeTagDropdownKeyboardFeature();
  feature.activate();
  function press(key, extra = {}) {
    const event = { key, target: editable, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...extra };
    api.handleNativeTagDropdownKeydown(event);
    return event;
  }
  return { root, row, editable, selection, slate, state, insertion, options, picks, hook, panel, host,
    workbench, feature, press, list, scrolls, frames,
    flushFrame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); } };
}

test('mouse-selected native wrap menu navigates cyclically and Enter delegates the exact option without changing selection', t => {
  const h = harness(t);
  assert.equal(h.press('ArrowDown').defaultPrevented, true);
  assert.equal(h.insertion.wrap.state.highlighted, 1);
  assert.equal(h.press('ArrowUp').stopped, true);
  assert.equal(h.insertion.wrap.state.highlighted, 0);
  h.press('ArrowUp');
  assert.equal(h.insertion.wrap.state.highlighted, 2);
  assert.equal(h.insertion.wrap.state.span, h.state.span);
  assert.equal(h.insertion.wrap.state.byKeyboard, false, 'disabling must not leave the native picker in keyboard mode');
  assert.equal(h.press('Enter').defaultPrevented, true);
  assert.deepEqual(h.picks, [h.options[2]]);
  assert.equal(h.slate.selection, h.selection);
  assert.deepEqual(h.selection, { anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 5 } });
  assert.equal(h.press('ArrowDown').defaultPrevented, false, 'normal arrows resume after the picker closes');
});

for (const [key, highlighted] of [['ArrowUp', 2], ['ArrowDown', 0]]) {
  test(`unhighlighted native mouse wrap enters ${key} at the correct boundary without moving the caret`, t => {
    const h = harness(t);
    h.state.highlighted = -1;
    assert.equal(h.press('Enter').defaultPrevented, false, 'no implicit option before keyboard selection');
    assert.equal(h.picks.length, 0);
    assert.equal(h.press(key).defaultPrevented, true);
    assert.equal(h.insertion.wrap.state.highlighted, highlighted);
    h.flushFrame();
    assert.equal(h.list.scrollTop, highlighted === 2 ? 60 : 0);
    assert.equal(h.press('Enter').defaultPrevented, true);
    assert.deepEqual(h.picks, [h.options[highlighted]]);
    assert.equal(h.slate.selection, h.selection);
    assert.equal(h.root.scrollTop, 47);
    assert.equal(h.row.scrollTop, 83);
  });
}

test('feature disable, Escape, search typing, mouse handling and keyboard-opened picker remain native', t => {
  const h = harness(t);
  for (const key of ['Escape', 'q', 'Backspace', 'Tab', 'ArrowLeft']) {
    assert.equal(h.press(key).defaultPrevented, false);
  }
  const input = new ElementFixture('input', h.row);
  assert.equal(h.press('ArrowDown', { target: input }).defaultPrevented, false);
  h.insertion.wrap.state.byKeyboard = true;
  assert.equal(h.press('ArrowDown').defaultPrevented, false);
  h.insertion.wrap.state.byKeyboard = false;
  h.press('ArrowDown');
  h.feature.deactivate();
  assert.equal(h.press('Enter').defaultPrevented, false);
  h.feature.onLoaded();
  assert.equal(h.press('ArrowDown').defaultPrevented, true);
  h.feature.stop();
  assert.equal(h.press('Enter').defaultPrevented, false);
  assert.equal(h.picks.length, 0);
});

test('readonly, stale selection/DOM, composition and modified keys cannot consume native navigation', t => {
  const h = harness(t);
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true },
    { altKey: true }, { shiftKey: true }, { defaultPrevented: true }]) {
    assert.equal(h.press('ArrowDown', extra).stopped, false);
  }
  h.panel.memoizedProps.readOnly = true;
  assert.equal(h.press('Enter').defaultPrevented, false);
  h.panel.memoizedProps.readOnly = false;
  h.selection.focus.offset = 4;
  assert.equal(h.press('Enter').defaultPrevented, false);
  h.selection.focus.offset = 5;
  h.host.stateNode = new ElementFixture('editor', h.row);
  assert.equal(h.press('Enter').defaultPrevented, false);
  h.host.stateNode = h.editable;
  h.editable.isConnected = false;
  assert.equal(h.press('Enter').defaultPrevented, false);
  assert.equal(h.picks.length, 0);
});

test('missing native dispatch fails closed and a queued highlight never resurrects a closed picker', t => {
  const h = harness(t);
  const dispatch = h.hook.queue.dispatch;
  h.hook.queue.dispatch = null;
  assert.equal(h.press('ArrowDown').defaultPrevented, false);
  let queued;
  h.hook.queue.dispatch = update => { queued = update; };
  assert.equal(h.press('ArrowDown').defaultPrevented, true);
  assert.equal(queued(null), null);
  const changed = { ...h.state, span: { start: 6, end: 10 } };
  assert.equal(queued(changed), changed);
  h.hook.queue.dispatch = dispatch;
});

test('highlight scrolling reveals partially hidden options, wraps both ways and never moves ancestors', t => {
  const h = harness(t);
  h.press('ArrowDown'); h.flushFrame();
  assert.equal(h.list.scrollTop, 20);
  h.press('ArrowDown'); h.flushFrame();
  assert.equal(h.list.scrollTop, 60);
  h.press('ArrowDown'); h.flushFrame();
  assert.equal(h.list.scrollTop, 0);
  h.press('ArrowUp'); h.flushFrame();
  assert.equal(h.list.scrollTop, 60);
  assert.equal(h.root.scrollTop, 47);
  assert.equal(h.row.scrollTop, 83);
  assert.equal(h.slate.selection, h.selection);
});

test('visible options retain manual scroll and rapid keys reveal only the final committed highlight', t => {
  const h = harness(t);
  h.list.scrollTop = 35;
  h.press('ArrowDown'); h.flushFrame();
  assert.deepEqual(h.scrolls, []);
  h.press('ArrowDown');
  h.press('ArrowUp');
  h.press('ArrowDown');
  assert.equal(h.frames.size, 1);
  h.flushFrame();
  assert.deepEqual(h.scrolls, [60]);
});

test('native keyboard-opened wrap and tag pickers scroll without intercepting native navigation', t => {
  const h = harness(t);
  h.insertion.wrap.state.byKeyboard = true;
  assert.equal(h.press('ArrowUp').defaultPrevented, false);
  h.insertion.wrap.state = { ...h.insertion.wrap.state, highlighted: 2 };
  h.flushFrame();
  assert.equal(h.list.scrollTop, 60);
  h.insertion.wrap.state = null;
  h.insertion.tags = { query: { kind: 'style', start: 0, options: h.options }, highlighted: 2 };
  h.insertion.pickTag = option => h.picks.push(option);
  assert.equal(h.press('ArrowDown').defaultPrevented, false);
  h.insertion.tags.highlighted = 0;
  h.flushFrame();
  assert.equal(h.list.scrollTop, 0);
});

for (const change of ['close', 'filter', 'selection', 'task', 'readonly', 'disabled', 'detached']) {
  test(`a queued reveal ignores ${change} before the next frame`, t => {
    const h = harness(t);
    h.press('ArrowUp');
    if (change === 'close') h.insertion.wrap.state = null;
    if (change === 'filter') h.insertion.wrap.state = { ...h.insertion.wrap.state, filter: 'new' };
    if (change === 'selection') h.insertion.wrap.state = { ...h.insertion.wrap.state, span: { start: 6, end: 10 } };
    if (change === 'task') h.workbench.memoizedProps.reviewActionId = 'new-task';
    if (change === 'readonly') h.panel.memoizedProps.readOnly = true;
    if (change === 'disabled') h.feature.deactivate();
    if (change === 'detached') h.editable.isConnected = false;
    h.flushFrame();
    assert.deepEqual(h.scrolls, []);
  });
}
