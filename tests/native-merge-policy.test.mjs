import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-native-merge-'));
await build({ entryPoints: {
    'native-merge-policy': fileURLToPath(new URL('../src/content/native-merge-policy.ts', import.meta.url)),
    'native-merge-helper-copy': fileURLToPath(new URL('../src/content/native-merge-policy.ts', import.meta.url)),
    'native-annotation-transaction': fileURLToPath(new URL('../src/content/native-annotation-transaction.ts', import.meta.url))
  },
  outdir: directory, outExtension: { '.js': '.mjs' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
const policy = await import(pathToFileURL(path.join(directory, 'native-merge-policy.mjs')).href);
const transaction = await import(pathToFileURL(path.join(directory, 'native-annotation-transaction.mjs')).href);
const independent = await import(pathToFileURL(path.join(directory, 'native-merge-helper-copy.mjs')).href);
await fs.rm(directory, { recursive: true, force: true });

function fixture() {
  const turn = (id, lane, start, end, content) => ({ id, type: 'transcription',
    processedRecordingId: lane, startTimeInSeconds: start, endTimeInSeconds: end, content });
  const annotations = [turn('previous', 'a', 0.682875, 58.063125, 'Earlier [laugh]'),
    turn('other', 'b', 59.529341, 110.976875, 'Other speaker'),
    turn('segment05', 'a', 64.962875, 65.317, 'Now'),
    turn('next', 'a', 73.046, 73.565875, 'Later')];
  const binding = { reviewActionId: 'task', annotations, pendingTextById: {},
    panel: { mode: 'transcription' }, transcript: {}, readOnly: false };
  const undo = [], redo = [], cleared = [];
  let regionWrites = 0;
  const capability = {
    clearSegment: id => cleared.push(id),
    writeAnnotations(update) { binding.annotations = update(binding.annotations); regionWrites++; },
    execute(command) { command.do(); undo.push(command); }
  };
  return { binding, capability, undo, redo, cleared, annotations, get regionWrites() { return regionWrites; } };
}

for (const direction of ['above', 'below']) {
  test(`live-shaped same-lane ${direction} merge uses one undo and native region writer`, () => {
    const f = fixture();
    const pair = policy.readSameLaneMerge(f.binding, 'segment05', direction);
    assert.ok(pair.gap > 2);
    policy.executeSameLaneMerge(f.binding, pair, f.capability);
    assert.equal(f.undo.length, 1);
    assert.equal(f.regionWrites, 1);
    assert.equal(f.binding.annotations.length, 3);
    assert.equal(f.binding.annotations.find(turn => turn.id === 'other'), f.annotations[1]);
    const merged = f.binding.annotations.find(turn => turn.id === 'segment05');
    assert.equal(merged.content, direction === 'above' ? 'Earlier [laugh] Now' : 'Now Later');
    assert.equal(merged.startTimeInSeconds, direction === 'above' ? 0.682875 : 64.962875);
    assert.equal(merged.endTimeInSeconds, direction === 'above' ? 65.317 : 73.565875);
    f.undo[0].undo();
    assert.deepEqual(f.binding.annotations, f.annotations);
    assert.equal(f.regionWrites, 2);
    f.undo[0].do();
    assert.equal(f.binding.annotations.find(turn => turn.id === 'segment05'), merged);
  });
}

test('true lane edges, readOnly, locks and unsupported modes remain ineligible', () => {
  const { binding } = fixture();
  assert.equal(policy.readSameLaneMerge(binding, 'previous', 'above').reason, 'merge-disabled');
  assert.equal(policy.readSameLaneMerge(binding, 'next', 'below').reason, 'merge-disabled');
  binding.transcript.lockSegments = true;
  assert.equal(policy.readSameLaneMerge(binding, 'segment05', 'above').reason, 'segments-locked');
  binding.transcript.lockSegments = false;
  binding.readOnly = true;
  assert.equal(policy.readSameLaneMerge(binding, 'segment05', 'above').reason, 'read-only');
  binding.readOnly = false;
  binding.panel.mode = 'annotation';
  assert.equal(policy.readSameLaneMerge(binding, 'segment05', 'above').reason, 'unsupported-mode');
});

test('pending native text is never overwritten by a stale merge command', () => {
  const f = fixture();
  f.binding.pendingTextById.segment05 = 'Uncommitted [noise]';
  assert.throws(() => policy.executeSameLaneMerge(f.binding,
    policy.readSameLaneMerge(f.binding, 'segment05', 'above'), f.capability), /pending-text/);
  assert.equal(f.undo.length, 0);
  assert.equal(f.regionWrites, 0);
});

test('within-two-second merges keep the original native callback', () => {
  const { binding } = fixture();
  binding.annotations[2] = { ...binding.annotations[2], startTimeInSeconds: 59 };
  const calls = [];
  binding.panel.onMergeAnnotations = (...args) => calls.push(args);
  policy.invokeNativeSameLaneMerge(binding, 'segment05', 'above');
  assert.deepEqual(calls, [['segment05', 'above']]);
});

test('a retained command refuses changed task, route or editor root before resolving capabilities', () => {
  const f = fixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task/one', search: '' };
  let editor = {};
  const initialEditor = editor;
  f.binding.readOnly = true;
  const installed = policy.installNativeMergePolicy({ onFailure(error) { throw error; },
    readBindings: () => f.binding, findEditor: () => editor });
  f.binding.readOnly = false;
  try {
    f.binding.reviewActionId = 'replacement-task';
    assert.throws(() => installed.merge('segment05', 'above', 'task', initialEditor, '/task/one'), /stale-task/);
    f.binding.reviewActionId = 'task';
    editor = {};
    assert.throws(() => installed.merge('segment05', 'above', 'task', initialEditor, '/task/one'), /stale-task/);
    editor = initialEditor;
    globalThis.location.pathname = '/task/two';
    assert.throws(() => installed.merge('segment05', 'above', 'task', initialEditor, '/task/one'), /stale-task/);
    assert.equal(f.undo.length, 0);
  } finally {
    installed.dispose();
    globalThis.location = originalLocation;
  }
});

test('unknown native callback identity fails before any annotation or history write', () => {
  const f = fixture();
  f.binding.panel.onMergeAnnotations = () => assert.fail('must not invoke an unowned callback');
  assert.throws(() => transaction.resolveNativeAnnotationTransaction({ memoizedState: null }, f.binding));
  assert.equal(f.undo.length, 0);
});

function nativeFixture() {
  const f = fixture();
  const confidence = { clearSegment: f.capability.clearSegment };
  const history = { executeAndPush: f.capability.execute, undoStack: [] };
  const execute = command => { history.executeAndPush(command); };
  const state = { isSyncingAnnotationsToWaveSurferRef: { current: false } };
  const writer = update => {
    if (!state.isSyncingAnnotationsToWaveSurferRef.current && "function" == typeof update) {
      f.capability.writeAnnotations(update);
    }
  };
  const nativeMerge = (id, direction) => ({ content: direction === "above" ? 'previous current' : 'current next',
    start: Math.min(1, 2), end: Math.max(3, 4), lowConfidenceResolved: true, undo: () => {} });
  const wrapper = (id, direction) => { confidence.clearSegment(id); nativeMerge(id, direction); };
  f.binding.panel.onMergeAnnotations = wrapper;
  f.binding.panel.onClearLowConfidence = () => assert.fail('only the verified current transaction owns confidence mutation');
  f.binding.history = history;
  f.binding.controller = { mergeUp(id) { wrapper(id, 'above'); } };
  const hooks = [[wrapper, [confidence, nativeMerge]],
    [nativeMerge, [f.binding.annotations, execute, writer]], [execute, [history]],
    [f.binding.controller, [wrapper]]];
  const editor = { memoizedState: hooks.reduceRight((next, memoizedState) => ({ next, memoizedState }), null) };
  const items = ['Above', 'Below'].map(suffix => ({ props: { disabled: true,
    onClick() { assert.fail('gap-limited native command must not be called'); },
    children: `Merge With ${suffix}` } }));
  const menuProps = { annotationId: 'segment05', canMergeAbove: false, canMergeBelow: false,
    mergeAboveHint: "This speaker's previous turn is more than 2s away",
    mergeBelowHint: "This speaker's next turn is more than 2s away",
    onMergeAbove() {}, onMergeBelow() {}, onDelete() {} };
  const menu = { memoizedProps: menuProps, child: { memoizedProps: { children: items } } };
  const eligibility = Object.fromEntries(f.binding.annotations.map(turn => [turn.id, {
    canMergeAbove: false, canMergeBelow: false,
    mergeAboveHint: "This speaker's previous turn is more than 2s away",
    mergeBelowHint: "This speaker's next turn is more than 2s away"
  }]));
  editor.child = { memoizedProps: f.binding.panel, child: menu, memoizedState: {
    memoizedState: [eligibility, [f.binding.annotations, false]], next: null
  } };
  return { ...f, editor, items, menuProps, hooks, eligibility };
}

test('owned native menu JSX enables only gap-restricted items and restores its leases', () => {
  const f = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  const originalClicks = f.items.map(item => item.props.onClick);
  const failures = [];
  const installed = policy.installNativeMergePolicy({ onFailure: error => failures.push(error),
    readBindings: () => f.binding, findEditor: () => f.editor });
  try {
    assert.equal(f.menuProps.canMergeAbove, true);
    assert.equal(f.menuProps.canMergeBelow, true);
    assert.deepEqual(f.items.map(item => item.props.disabled), [false, false]);
    f.items[0].props.onClick();
    assert.equal(f.undo.length, 1);
    assert.equal(f.binding.annotations.find(turn => turn.id === 'segment05').content, 'Earlier [laugh] Now');
    assert.deepEqual(failures, []);
  } finally {
    installed.dispose();
    globalThis.location = originalLocation;
  }
  assert.equal(f.menuProps.canMergeAbove, false);
  assert.deepEqual(f.items.map(item => item.props.disabled), [true, true]);
  assert.deepEqual(f.items.map(item => item.props.onClick), originalClicks);
});

test('native keyboard handler uses its proven controller dependency and restores on disable', () => {
  const f = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  let enabled = true;
  const nativeCalls = [];
  const callback = id => { nativeCalls.push({ id, direction: "above", hint: "There's no earlier turn within " }); };
  const controller = { mergeUp: callback };
  const handlers = { onMergeUp: callback };
  f.binding.transcript.handlers = handlers;
  f.binding.controller = controller;
  f.hooks.push([handlers, [controller]], [controller, [f.binding.panel.onMergeAnnotations]]);
  f.editor.memoizedState = f.hooks.reduceRight((next, memoizedState) => ({ next, memoizedState }), null);
  const failures = [];
  const installed = policy.installNativeMergePolicy({ isEnabled: () => enabled,
    onFailure: error => failures.push(error), readBindings: () => f.binding, findEditor: () => f.editor });
  try {
    handlers.onMergeUp('segment05');
    assert.equal(f.undo.length, 1);
    assert.deepEqual(nativeCalls, []);
    assert.deepEqual(failures, []);
    enabled = false;
    installed.reconcile();
    assert.equal(handlers.onMergeUp, callback);
    assert.equal(f.menuProps.canMergeAbove, false);
    installed.merge('next', 'above', 'task');
    assert.equal(f.undo.length, 1, 'disabled override leaves the native callback in charge');
  } finally {
    installed.dispose();
    globalThis.location = originalLocation;
  }
});

test('menu merge waits on native text commits without changing raw tags or selection', () => {
  const f = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  f.binding.pendingTextById.segment05 = '[noise] Pending';
  let listener = null;
  const failures = [];
  const installed = policy.installNativeMergePolicy({ onFailure: error => failures.push(error),
    readBindings: () => f.binding, findEditor: () => f.editor,
    subscribe(callback) { listener = callback; return () => { listener = null; }; } });
  try {
    f.items[0].props.onClick();
    assert.equal(f.undo.length, 0);
    assert.equal(typeof listener, 'function');
    f.binding.annotations = f.binding.annotations.map(turn => turn.id === 'segment05'
      ? { ...turn, content: '[noise] Pending' } : turn);
    f.hooks[1][1][0] = f.binding.annotations;
    f.editor.child.memoizedState.memoizedState[1][0] = f.binding.annotations;
    f.binding.pendingTextById = {};
    listener();
    assert.equal(f.undo.length, 1);
    assert.equal(listener, null);
    assert.equal(f.binding.annotations.find(turn => turn.id === 'segment05').content, 'Earlier [laugh] [noise] Pending');
    f.undo[0].undo();
    assert.equal(f.binding.annotations.find(turn => turn.id === 'segment05').content, '[noise] Pending');
    assert.deepEqual(failures, []);
  } finally {
    installed.dispose();
    globalThis.location = originalLocation;
  }
});

test('an already-open disabled menu closes through native Radix state, never DOM attributes', () => {
  const f = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  const closes = [];
  const dropdown = f.editor.child.child.child;
  Object.assign(dropdown.memoizedProps, { open: true, triggerId: 'native-trigger', triggerRef: { current: {} },
    onOpenChange: value => closes.push(value) });
  const mounted = { memoizedProps: { role: 'menuitem', 'aria-disabled': true },
    stateNode: { textContent: 'Merge With Above' } };
  dropdown.child = mounted;
  const installed = policy.installNativeMergePolicy({ onFailure(error) { throw error; },
    readBindings: () => f.binding, findEditor: () => f.editor });
  try {
    assert.deepEqual(closes, [false]);
    assert.equal(mounted.memoizedProps['aria-disabled'], true, 'do not fake mounted native disabled semantics');
    assert.equal(f.items[0].props.disabled, false, 'the next native mount receives enabled JSX');
  } finally {
    installed.dispose();
    globalThis.location = originalLocation;
  }
});

test('frozen native menu elements fail visibly instead of leaving a partial patch', () => {
  const f = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  Object.freeze(f.items[1].props);
  try {
    assert.throws(() => policy.installNativeMergePolicy({ onFailure(error) { throw error; },
      readBindings: () => f.binding, findEditor: () => f.editor }), /props-unsupported/);
    assert.equal(f.items[0].props.disabled, true);
    assert.equal(f.menuProps.canMergeAbove, false);
    assert.equal(f.undo.length, 0);
  } finally { globalThis.location = originalLocation; }
});

test('the transaction capability is available independently of the gap-policy setting', () => {
  const f = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  const installed = policy.installNativeMergePolicy({ isEnabled: () => false,
    onFailure(error) { throw error; }, readBindings: () => f.binding, findEditor: () => f.editor });
  try {
    const capability = transaction.resolveNativeAnnotationTransaction(f.editor, f.binding);
    assert.equal(typeof capability.execute, 'function');
    assert.equal(typeof capability.writeAnnotations, 'function');
    assert.equal(f.menuProps.canMergeAbove, false);
    installed.merge('segment05', 'above', 'task');
    assert.equal(f.undo.length, 0);
    assert.deepEqual(f.cleared, ['segment05'], 'native callback still runs when override is disabled');
  } finally {
    installed.dispose();
    globalThis.location = originalLocation;
  }
});

test('playback-only native renders retain eligibility without reconciliation and route a fresh menu click once', () => {
  const f = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  let reads = 0;
  const closes = [], failures = [], nativeCalls = [];
  const installed = policy.installNativeMergePolicy({ onFailure: error => failures.push(error),
    readBindings() { reads++; return f.binding; }, findEditor: () => f.editor });
  try {
    const readsAfterInstall = reads;
    let item = null;
    for (let frame = 0; frame < 100; frame++) {
      // aJ renders fresh aF props from the same owned useMemo map. No extension
      // commit callback or transcript/Fiber preparation runs on these renders.
      const eligibility = f.eligibility.segment05;
      assert.equal(eligibility.canMergeAbove, true);
      assert.equal(eligibility.canMergeBelow, true);
      const menu = { memoizedProps: { ...f.menuProps, ...eligibility,
        onMergeAbove() { nativeCalls.push('blocked-native-command'); } } };
      item = { nodeType: 1, textContent: 'Merge With Above',
        closest(selector) { return selector === '[role="menuitem"]' ? this : null; } };
      const host = { stateNode: item, memoizedProps: { role: 'menuitem', 'aria-disabled': false } };
      const dropdown = { memoizedProps: { open: true, triggerId: 'native-trigger',
        triggerRef: { current: {} }, onOpenChange: value => closes.push(value) }, child: host, return: menu };
      menu.child = dropdown;
      host.return = dropdown;
      item.__reactFiber$test = host;
      f.editor.child.child = menu;
      f.binding.panel = { ...f.binding.panel, playingState: { a: Boolean(frame % 2) } };
      f.editor.child.memoizedProps = f.binding.panel;
      assert.deepEqual(closes, [], 'playback must not close the open native menu');
    }
    assert.equal(reads, readsAfterInstall, 'no transcript snapshots on playback-only renders');
    const event = { type: 'click', target: item, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.stopped = true; } };
    installed.handleInteraction(event);
    assert.equal(event.stopped, true);
    assert.equal(f.undo.length, 1);
    assert.deepEqual(closes, [false], 'the selected action uses the native close/focus path once');
    assert.deepEqual(nativeCalls, []);
    assert.deepEqual(failures, []);
    assert.equal(f.binding.annotations.find(turn => turn.id === 'segment05').content, 'Earlier [laugh] Now');
  } finally {
    installed.dispose();
    globalThis.location = originalLocation;
  }
});

test('unknown native eligibility memo fails before enabling a gap menu', () => {
  const f = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  f.editor.child.memoizedState = null;
  try {
    assert.throws(() => policy.installNativeMergePolicy({ onFailure(error) { throw error; },
      readBindings: () => f.binding, findEditor: () => f.editor }), /eligibility-unsupported/);
    assert.equal(f.menuProps.canMergeAbove, false);
    assert.equal(f.items[0].props.disabled, true);
  } finally { globalThis.location = originalLocation; }
});

test('obsolete unrestricted keyboard contracts fail before any native mutation', () => {
  const f = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  const nativeCalls = [];
  f.editor.child.memoizedState = null;
  delete f.menuProps.mergeAboveHint;
  delete f.menuProps.mergeBelowHint;
  f.menuProps.canMergeAbove = f.menuProps.canMergeBelow = true;
  for (const item of f.items) item.props.disabled = false;
  const originalClick = f.items[0].props.onClick;
  const oldKeyboard = id => nativeCalls.push(id);
  f.binding.transcript.handlers = { onMergeUp: oldKeyboard };
  try {
    assert.throws(() => policy.installNativeMergePolicy({
      onFailure(error) { throw error; }, readBindings: () => f.binding, findEditor: () => f.editor
    }), /native-merge-keyboard-unsupported/);
    assert.equal(f.binding.transcript.handlers.onMergeUp, oldKeyboard);
    assert.equal(f.items[0].props.onClick, originalClick);
    assert.deepEqual(nativeCalls, []);
    assert.equal(f.undo.length, 0);
  } finally {
    globalThis.location = originalLocation;
  }
});

test('independently bundled Helper commands share the owned MAIN policy lease', () => {
  const f = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  assert.notEqual(independent.invokeNativeSameLaneMerge, policy.invokeNativeSameLaneMerge);
  const installed = policy.installNativeMergePolicy({ onFailure(error) { throw error; },
    readBindings: () => f.binding, findEditor: () => f.editor });
  try {
    independent.invokeNativeSameLaneMerge(f.binding, 'segment05', 'above');
    assert.equal(f.undo.length, 1);
    assert.equal(f.binding.annotations.find(turn => turn.id === 'segment05').content, 'Earlier [laugh] Now');
  } finally {
    installed.dispose();
    globalThis.location = originalLocation;
  }
  assert.throws(() => independent.invokeNativeSameLaneMerge(f.binding, 'segment05', 'below'), /policy-unavailable/);
});

test('replaced bundle owners cannot dispose a newer shared MAIN policy lease', () => {
  const firstFixture = nativeFixture(), secondFixture = nativeFixture();
  const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  const first = policy.installNativeMergePolicy({ onFailure(error) { throw error; },
    readBindings: () => firstFixture.binding, findEditor: () => firstFixture.editor });
  const second = independent.installNativeMergePolicy({ onFailure(error) { throw error; },
    readBindings: () => secondFixture.binding, findEditor: () => secondFixture.editor });
  try {
    first.dispose();
    policy.invokeNativeSameLaneMerge(secondFixture.binding, 'segment05', 'above');
    assert.equal(secondFixture.undo.length, 1);
    assert.equal(firstFixture.undo.length, 0);
    assert.equal(firstFixture.menuProps.canMergeAbove, false, 'replacement restored the previous owner');
  } finally {
    second.dispose();
    globalThis.location = originalLocation;
  }
});

test('a panel callback older than both render slots still permits a guarded same-lane merge', () => {
  const f = nativeFixture();
  const previousLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  f.binding.panel.onMergeAnnotations = () => assert.fail('retired panel closure must not execute');
  f.editor.alternate = { memoizedState: null };
  const installed = policy.installNativeMergePolicy({ onFailure(error) { throw error; },
    readBindings: () => f.binding, findEditor: () => f.editor });
  try {
    f.items[0].props.onClick();
    assert.equal(f.binding.annotations.find(turn => turn.id === 'segment05').content, 'Earlier [laugh] Now');
    assert.equal(f.binding.annotations.find(turn => turn.id === 'other'), f.annotations[1]);
    assert.equal(f.undo.length, 1);
    f.undo[0].undo();
    assert.deepEqual(f.binding.annotations, f.annotations);
  } finally { installed.dispose(); globalThis.location = previousLocation; }
});

test('retained keyboard entrypoints dispatch through the current controller without old hook ownership', () => {
  const f = nativeFixture();
  const previousLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  const oldCalls = [], currentCalls = [];
  const createMergeUp = calls => id => { calls.push({ id, direction: "above", hint: "There's no earlier turn within " }); };
  const handlers = { onMergeUp: createMergeUp(oldCalls) };
  const controller = { mergeUp: createMergeUp(currentCalls) };
  f.binding.transcript.handlers = handlers;
  f.binding.controller = controller;
  f.hooks.push([controller, [f.binding.panel.onMergeAnnotations]]);
  f.binding.panel.onMergeAnnotations = () => assert.fail('retired panel closure must not execute');
  f.editor.memoizedState = f.hooks.reduceRight((next, memoizedState) => ({ next, memoizedState }), null);
  const installed = policy.installNativeMergePolicy({ onFailure(error) { throw error; },
    readBindings: () => f.binding, findEditor: () => f.editor });
  try {
    handlers.onMergeUp('previous');
    assert.deepEqual(currentCalls.map(call => call.id), ['previous']);
    assert.deepEqual(oldCalls, []);
    handlers.onMergeUp('segment05');
    assert.equal(f.binding.annotations.find(turn => turn.id === 'segment05').content, 'Earlier [laugh] Now');
    assert.equal(f.undo.length, 1);
    assert.deepEqual(oldCalls, []);
  } finally { installed.dispose(); globalThis.location = previousLocation; }
});

test('retained keyboard callbacks cannot mutate a replacement root on the same task and route', () => {
  const f = nativeFixture();
  const previousLocation = globalThis.location;
  globalThis.location = { pathname: '/task', search: '' };
  const calls = [], failures = [];
  const mergeUp = id => { calls.push({ id, direction: "above", hint: "There's no earlier turn within " }); };
  const controller = { mergeUp };
  const handlers = { onMergeUp: mergeUp };
  f.binding.controller = controller;
  f.binding.transcript.handlers = handlers;
  f.hooks.push([controller, [f.binding.panel.onMergeAnnotations]]);
  f.editor.memoizedState = f.hooks.reduceRight((next, memoizedState) => ({ next, memoizedState }), null);
  let currentRoot = f.editor;
  const installed = policy.installNativeMergePolicy({ onFailure: error => failures.push(error.message),
    readBindings: () => f.binding, findEditor: () => currentRoot });
  try {
    currentRoot = { ...f.editor };
    handlers.onMergeUp('previous');
    assert.deepEqual(calls, []);
    assert.deepEqual(failures, ['native-merge-stale-task']);
    assert.equal(f.undo.length, 0);
  } finally { installed.dispose(); globalThis.location = previousLocation; }
});
