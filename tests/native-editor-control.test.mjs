import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  stdin: { contents: `
    export * from './src/site/editor-control';
    export * from './src/site/rows';
    export * from './src/site/row-time';
    export * from './src/hooks/selected-number-to-skaz';
    export * from './src/features/text-move-feature';
    export * from './src/features/selected-number-feature';
    export * from './src/services/recovered-editor-snapshot-service';
    export * from './src/features/row-actions-feature';
    export * from './src/features/editor-input';
    export * from './src/hooks/dom';
    export * from './src/core/lifecycle';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
  plugins: [{
    name: 'capture-native-failure',
    setup(build) {
      build.onResolve({ filter: /ui\/native-automation-failure$/ }, () => ({ path: 'native-failure', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export function showNativeAutomationFailure(feature, reason) { globalThis.nativeAutomationFailures.push({feature, reason}); }'
      }));
    }
  }]
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
const separateBundle = await build({
  entryPoints: ['src/site/editor-control.ts'], bundle: true, format: 'esm',
  platform: 'browser', write: false, logLevel: 'silent'
});
const separatelyLoaded = await import(`data:text/javascript;base64,${Buffer.from(separateBundle.outputFiles[0].contents).toString('base64')}`);

class ElementFixture {
  constructor(tagName = 'div') { this.tagName = tagName; this.dataset = {}; this.attributes = new Map(); this.isConnected = true; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) {
    return this.tagName === 'section' ? selector.includes('section[data-annotation-id]')
      : this.tagName === 'tr' ? selector.includes('[data-babel-classic-row="true"]') &&
        this.getAttribute('data-babel-classic-row') === 'true'
      : Boolean(this.editor && selector.includes('data-slate-editor'));
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelector() { return this.nativeElement ?? null; }
  scrollIntoView() {}
}
class TextInputFixture extends ElementFixture {
  constructor(value) { super('input'); this.value = value; this.type = 'text'; this.selectionStart = 0; this.selectionEnd = value.length; this.events = []; }
  matches(selector) { return selector.split(',').some((part) => part.trim() === 'input'); }
  dispatchEvent(event) { this.events.push(event.type); }
  focus() {}
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}

function harness(t) {
  const installed = new Map();
  const cleanup = [];
  const install = (key, value) => {
    if (!installed.has(key)) installed.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const rows = [];
  const doc = { location: { href: 'https://babel.test/transcription/job' }, activeElement: null,
    querySelectorAll: () => rows.filter(row => row.isConnected) };
  const listeners = new Map(), observers = [], batches = [];
  const windowRef = {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); }
  };
  let annotationRevision = 1;
  const root = new ElementFixture('html');
  root.ownerDocument = doc;
  doc.documentElement = root;
  const publication = () => ({ href: doc.location.href, generation: 1, annotationRevision,
    reviewActionId: rows[0]?.state.reviewActionId || '', readOnly: rows[0]?.state.readOnly ?? false,
    activeIds: rows.filter(row => row.state.isActive).map(row => row.state.annotationId),
    editingId: rows.find(row => row.state.isEditing)?.state.annotationId ?? null });
  root.dispatchEvent = event => {
    const request = JSON.parse(event.detail);
    batches.push(request);
    const identities = rows.map(({ state }) => ({
      annotationId: state.annotationId, reviewActionId: state.reviewActionId, processedRecordingId: state.processedRecordingId,
      trackLabel: state.trackLabel, startSeconds: state.startSeconds, endSeconds: state.endSeconds
    }));
    root.setAttribute('data-babel-helper-editor-result', JSON.stringify({
      id: request.id, ok: true, ...publication(), identities
    }));
  };
  install('window', windowRef);
  install('MutationObserver', class {
    constructor(callback) { this.callback = callback; this.records = []; observers.push(this); }
    observe() {}
    takeRecords() { return this.records.splice(0); }
    disconnect() { this.disconnected = true; this.records = []; }
  });
  install('HTMLElement', ElementFixture);
  install('Element', ElementFixture);
  install('HTMLInputElement', TextInputFixture);
  install('HTMLTextAreaElement', class extends TextInputFixture {});
  install('CustomEvent', class { constructor(type, options) { this.type = type; Object.assign(this, options); } });
  install('document', doc);
  install('DOMRect', class { constructor(left, top, width, height) { Object.assign(this, { left, top, width, height }); } });
  t.after(() => {
    for (const dispose of cleanup) dispose();
    for (const [key, descriptor] of installed) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  function turn(text, { id = `turn-${rows.length}`, lane = 'speaker-one', readOnly = false } = {}) {
    const row = new ElementFixture('section');
    row.dataset.annotationId = id;
    row.ownerDocument = doc;
    row.classList = new Set();
    row.state = { ok: true, annotationId: id, reviewActionId: 'task-one', processedRecordingId: lane, trackLabel: lane, startSeconds: 1, endSeconds: 3, text, start: 0, end: 0, direction: 'none', readOnly };
    row.calls = [];
    if (!readOnly) {
      row.nativeElement = new ElementFixture();
      row.nativeElement.editor = true;
      row.nativeElement.parentElement = row;
    }
    row.dispatchEvent = (event) => {
      const request = JSON.parse(event.detail);
      row.calls.push(request);
      const ok = (!request.reviewActionId || request.reviewActionId === row.state.reviewActionId) &&
        (request.processedRecordingId === undefined || request.processedRecordingId === row.state.processedRecordingId) &&
        (['read', 'identity', 'caretRect'].includes(request.operation) || !row.state.readOnly);
      if (ok && request.operation === 'replace') {
        row.state.text = request.text;
        if (request.start != null) Object.assign(row.state, { start: request.start, end: request.end ?? request.start, direction: request.direction ?? 'none' });
        if (request.focus) doc.activeElement = row.nativeElement;
      }
      if (ok && request.operation === 'select') Object.assign(row.state, request.selectAll
        ? { start: 0, end: row.state.text.length, direction: 'forward' }
        : { start: request.start, end: request.end, direction: request.direction });
      if (ok && request.operation === 'focus') doc.activeElement = row.nativeElement;
      row.setAttribute('data-babel-helper-editor-result', JSON.stringify({
        ...row.state, id: request.id, ok,
        ...(request.operation === 'caretRect' ? { rect: { left: request.start * 3, top: 20, width: 0, height: 18 } } : {})
      }));
      return true;
    };
    rows.push(row);
    return row;
  }
  return { doc, rows, turn, install, cleanup, batches, observers, listeners,
    commit(changed = true) {
      if (changed) annotationRevision++;
      windowRef.dispatchEvent({ type: 'babel-helper:native-editor-commit', detail: JSON.stringify(publication()) });
    },
    membership(addedNodes = [], removedNodes = []) {
      for (const observer of observers) if (!observer.disconnected) {
        observer.records.push({ type: 'childList', addedNodes, removedNodes });
      }
    }
  };
}

test('native control follows static-to-Slate replacement without losing raw tag offsets or direction', (t) => {
  const h = harness(t), row = h.turn('<тихо> пять </тихо> потом');
  const editor = api.getEditorControl(row);
  assert.equal(editor.focus({ activateRow: false }), true);
  assert.equal(editor.setSelectionRange(7, 11, 'backward'), true);
  const slate = new ElementFixture();
  slate.editor = true; slate.parentElement = row;
  row.nativeElement = slate;
  assert.equal(editor.element, slate);
  assert.equal(api.getEditorControl(row), editor, 'pending selection consumers share turn identity');
  assert.equal(editor.value, '<тихо> пять </тихо> потом');
  assert.deepEqual([editor.selectionStart, editor.selectionEnd, editor.selectionDirection], [7, 11, 'backward']);
  assert.equal(editor.getCaretRect(19).left, 57, 'geometry is requested in raw serialized coordinates');
  assert.equal(row.getAttribute('data-babel-helper-editor-result'), null, 'bridge results are consumed, not reused');
});

test('native controls reject same-route task replacement, route changes, readonly and detached turns', (t) => {
  const h = harness(t), row = h.turn('original');
  const editor = api.getEditorControl(row);
  row.state.reviewActionId = 'task-two';
  assert.equal(editor.replaceValue('stale'), false);
  assert.equal(row.state.text, 'original');
  const current = api.getEditorControl(row);
  assert.notEqual(current, editor);
  h.doc.location.href += '?next=true';
  const requests = row.calls.length;
  assert.equal(current.replaceValue('other route'), false);
  assert.equal(row.calls.length, requests, 'stale wrapper never reaches native callbacks');
  assert.equal(api.getEditorControl(h.turn('readonly', { readOnly: true })), null);
  row.isConnected = false;
  assert.equal(current.focus(), false);
});

test('native row service includes readonly turns and reads exact committed times and raw content', (t) => {
  const h = harness(t), row = h.turn('42 {СКАЗ: сорок два}', { readOnly: true });
  const helper = { state: {}, getEditorSnapshot: () => null };
  api.createRowSiteApi(helper, { time: {} });
  assert.deepEqual(helper.getTranscriptRows(), [row]);
  assert.equal(helper.getRowEditor(row), null);
  assert.equal(helper.getRowTextValue(row), row.state.text);
  assert.deepEqual([helper.getRowIdentity(row).startSeconds, helper.getRowIdentity(row).endSeconds], [1, 3]);
  assert.equal(helper.focusRow(row), false);
  const oldIdentity = helper.getRowIdentity(row);
  row.state.reviewActionId = 'replacement-task';
  h.commit();
  assert.equal(helper.rowMatchesIdentity(row, oldIdentity), false);
  assert.equal(helper.findRowByIdentity(oldIdentity), null);
});

test('committed row cache batches identities, retains steady playback indexes, and separates active selection', t => {
  const h = harness(t), first = h.turn('one'), second = h.turn('two', { lane: 'speaker-two' });
  Object.assign(second.state, { startSeconds: 4, endSeconds: 7 });
  const counts = new Map();
  const helper = { state: {}, perf: { count(name) { counts.set(name, (counts.get(name) || 0) + 1); } } };
  const modules = {};
  modules.rows = api.createRowSiteApi(helper, modules);
  modules.time = api.createRowTimeApi(helper);
  h.cleanup.push(() => helper.disposeRowIndex());
  const entries = modules.time.getRowTimeEntries();
  for (let index = 0; index < 50; index++) {
    assert.equal(modules.time.getRowTimeEntries(), entries);
    assert.equal(modules.time.findRowEntryByPlaybackTime(5).row, second);
    assert.equal(modules.time.findLatestRowEntryBeforePlaybackTime(8).row, second);
  }
  assert.equal(h.batches.length, 1);
  assert.equal(first.calls.length + second.calls.length, 0, 'no per-row bridge requests');
  assert.equal(counts.get('row.scan'), 1);
  first.state.isActive = true;
  h.commit(false);
  assert.equal(helper.findActiveRowByReactState(), first);
  assert.equal(helper.getRowIdentity(first).isActive, true);
  assert.equal(modules.time.getRowTimeEntries(), entries, 'caret/active changes do not replace timing indexes');
  Object.assign(first.state, { startSeconds: 8, endSeconds: 10 });
  h.commit();
  assert.equal(modules.time.findRowEntryByPlaybackTime(9).row, first);
  assert.equal(modules.time.findRowEntryByPlaybackTime(2), null);
  assert.equal(modules.time.resolveRowTimeEntry(entries[0]).startSeconds, 8, 'retained entries resolve current timing');
  assert.equal(h.batches.length, 2);
});

test('row cache observes filters and same-task remounts synchronously and never authorizes a stale task edit', t => {
  const h = harness(t), first = h.turn('one'), second = h.turn('two', { lane: 'speaker-two' });
  const helper = { state: {} }, modules = {};
  modules.rows = api.createRowSiteApi(helper, modules);
  modules.time = api.createRowTimeApi(helper);
  h.cleanup.push(() => helper.disposeRowIndex());
  const identity = helper.getRowIdentity(first), control = helper.getRowEditor(first);
  modules.time.rememberPlaybackRow(first);
  first.isConnected = false;
  h.membership([], [first]);
  assert.deepEqual(helper.getTranscriptRows(), [second], 'takeRecords closes observer delivery gap');
  assert.equal(modules.time.getRowTimeEntry(first, identity), null);
  const replacement = h.turn('one', { id: identity.annotationId });
  h.membership([replacement]);
  assert.equal(modules.time.getRowTimeEntry(first, identity).row, replacement);
  assert.equal(modules.time.findRowEntryByPlaybackTime(2).row, replacement, 'overlap keeps remounted playback owner');
  const connectedControl = helper.getRowEditor(replacement);
  replacement.state.reviewActionId = second.state.reviewActionId = first.state.reviewActionId = 'task-two';
  h.commit();
  assert.equal(helper.findRowByIdentity(identity), null);
  assert.equal(modules.time.getRowTimeEntry(replacement, identity), null);
  assert.equal(control.replaceValue('stale'), false);
  assert.equal(connectedControl.replaceValue('stale connected edit'), false);
  assert.equal(replacement.state.text, 'one', 'cached presentation cannot authorize a new task');
  helper.disposeRowIndex();
  assert.ok(h.observers.every(observer => observer.disconnected));
  assert.ok([...h.listeners.values()].every(listeners => listeners.size === 0));
  assert.equal(helper.getRowIdentity(replacement).reviewActionId, 'task-two', 'next active session starts a fresh bounded index');
});

test('focus restoration centers only the native transcript viewport and retains a backward range', (t) => {
  const h = harness(t), row = h.turn('remember this selection');
  const viewport = new ElementFixture();
  viewport.matches = selector => selector === '[data-transcript-scroll]';
  viewport.scrollTop = 120;
  viewport.clientTop = 2;
  viewport.clientHeight = 100;
  viewport.getBoundingClientRect = () => ({ top: 10 });
  const outer = new ElementFixture();
  outer.scrollTop = 17;
  viewport.parentElement = outer;
  row.parentElement = viewport;
  row.scrollIntoView = () => { throw new Error('must not reveal outer scroll ancestors'); };
  const helper = { state: {}, getEditorSnapshot: () => null };
  api.createRowSiteApi(helper, { time: {} });

  assert.equal(helper.focusRow(row, { activateRow: false, selectionStart: 3, selectionEnd: 12, direction: 'backward' }), true);
  assert.deepEqual([row.state.start, row.state.end, row.state.direction], [3, 12, 'backward']);
  assert.equal(row.state.text, 'remember this selection');
  assert.equal(h.doc.activeElement, row.nativeElement);
  assert.equal(viewport.scrollTop, 87);
  assert.equal(outer.scrollTop, 17);
  assert.equal(row.calls.find(call => call.operation === 'focus').preventScroll, true);
  assert.equal(row.calls.find(call => call.operation === 'caretRect').start, 3);

  viewport.scrollTop = 120;
  assert.equal(helper.focusRow(row, { scroll: false, selectionStart: 8 }), true);
  assert.equal(viewport.scrollTop, 120, 'explicit no-scroll focus leaves the viewport alone');
  row.parentElement = outer;
  assert.equal(helper.focusRow(row, { selectionStart: 8 }), true);
  assert.equal(outer.scrollTop, 17, 'a missing transcript viewport never falls back to document scrolling');
});

test('digit conversion uses native raw selection while preserving generic input and readonly semantics', (t) => {
  const h = harness(t), row = h.turn('<тихо> пять </тихо> книг');
  Object.assign(row.state, { start: 7, end: 11 });
  assert.equal(api.convertSelectionWithDigit(row.nativeElement, '5'), true);
  assert.equal(row.state.text, '<тихо> 5 {СКАЗ: пять} </тихо> книг');
  assert.equal(row.state.start, 8);
  assert.equal(row.calls.filter((call) => call.operation === 'replace').length, 1);
  assert.deepEqual(row.calls.filter((call) => call.operation === 'replace').map(({ start, end, focus }) => ({ start, end, focus })),
    [{ start: 8, end: 8, focus: true }], 'replacement carries its native selection in the same operation');
  assert.equal(api.convertSelectionWithDigit(row.nativeElement, '%'), false);
  const generic = new TextInputFixture('42');
  assert.equal(api.autoConvertSelectedNumberText(generic), true);
  assert.equal(generic.value, '42 {СКАЗ: сорок два}');
  assert.deepEqual(generic.events, ['input']);
  generic.readOnly = true;
  generic.selectionStart = 0; generic.selectionEnd = generic.value.length;
  assert.equal(api.replaceSelectionInTextControl(generic, 'changed'), false);
});

test('text moves target only same-speaker native controls and refuse a readonly destination before writing', (t) => {
  const h = harness(t), previous = h.turn('left'), other = h.turn('other', { lane: 'speaker-two' }), row = h.turn('move remain');
  Object.assign(row.state, { start: 4, end: 4 });
  h.doc.activeElement = row.nativeElement;
  const helper = { state: {}, getEditorSnapshot: () => null, setEditableValue: (editor, text) => editor.replaceValue(text) };
  api.createRowSiteApi(helper, { time: {} });
  api.registerTextMove(helper);
  assert.equal(helper.moveTextToAdjacentSegment(-1), true);
  assert.deepEqual([previous.state.text, other.state.text, row.state.text], ['left move', 'other', 'remain']);
  Object.assign(row.state, { text: 'again remain', start: 5, end: 5 });
  previous.state.readOnly = true;
  assert.equal(helper.moveTextToAdjacentSegment(-1), false);
  assert.equal(row.state.text, 'again remain');
});

test('selected-number hotkeys leave composing input untouched', (t) => {
  const h = harness(t), row = h.turn('пять');
  Object.assign(row.state, { start: 0, end: 4 });
  let keydown;
  api.registerSelectedNumberInput({}, { on: (_phase, callback) => { keydown = callback; } }, { isFeatureEnabled: () => true });
  assert.equal(keydown({ isComposing: true, target: row.nativeElement, code: 'Digit5', key: '5' }), false);
  assert.equal(row.state.text, 'пять');
  assert.equal(row.calls.length, 0);
});

test('snapshot refresh rejects a reply from a replaced task even on the same route', async (t) => {
  const h = harness(t);
  const root = new ElementFixture('html');
  root.ownerDocument = h.doc;
  root.setAttribute('data-babel-review-action-id', 'task-one');
  h.doc.documentElement = root;
  const listeners = new Map();
  const requests = [];
  const windowRef = {
    location: { href: h.doc.location.href, pathname: '/transcription/job', search: '' },
    __babelHelperRecoveredEditorBridge: {},
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    setTimeout() { return 1; }, clearTimeout() {},
    dispatchEvent(event) { requests.push(event.detail); }
  };
  h.install('window', windowRef);
  h.doc.location = windowRef.location;
  let nativeTask = 'task-one';
  root.dispatchEvent = event => {
    const request = JSON.parse(event.detail);
    root.setAttribute('data-babel-helper-editor-result', JSON.stringify({
      id: request.id, ok: true, reviewActionId: nativeTask, readOnly: false, routeKey: '/transcription/job'
    }));
  };
  const helper = { state: { sessionLifecycleRevision: 0 } };
  api.registerRecoveredEditorSnapshotService(helper);
  const refresh = helper.refreshEditorSnapshot('test');
  await Promise.resolve();
  const request = requests[0];
  assert.ok(request);
  nativeTask = 'task-two';
  listeners.get('babel-helper-recovered-editor-response')({ detail: {
    id: request.id, result: { ok: true, snapshot: {
      contractVersion: 'native-59327-2026-10-15', capturedAt: Date.now(),
      routeKey: '/transcription/job', reviewActionId: 'task-one', readOnly: false, rows: []
    } }
  } });
  assert.equal(await refresh, null);
  assert.equal(helper.state.editorSnapshot, undefined);
  const next = helper.refreshEditorSnapshot('native-task-replaced');
  await Promise.resolve();
  const currentRequest = requests.at(-1);
  const currentSnapshot = {
    contractVersion: 'native-59327-2026-10-15', capturedAt: Date.now(),
    routeKey: '/transcription/job', reviewActionId: 'task-two', readOnly: false, rows: []
  };
  listeners.get('babel-helper-recovered-editor-response')({ detail: {
    id: currentRequest.id, result: { ok: true, snapshot: currentSnapshot }
  } });
  assert.equal(await next, currentSnapshot, 'the native task is accepted while the unrelated Gold marker is still old');
  assert.equal(root.getAttribute('data-babel-review-action-id'), 'task-one');
});

test('accept-all uses native task authority without rendered cards, gates repeats and reports rejection', async (t) => {
  const h = harness(t), row = h.turn('unchanged transcript');
  const root = new ElementFixture('html');
  root.ownerDocument = h.doc;
  root.setAttribute('data-babel-review-action-id', 'stale-gold-marker');
  h.doc.documentElement = root;
  let readOnly = false;
  root.dispatchEvent = event => {
    const request = JSON.parse(event.detail);
    root.setAttribute('data-babel-helper-editor-result', JSON.stringify({
      id: request.id, ok: true, reviewActionId: 'native-task', readOnly, routeKey: ''
    }));
  };
  h.install('window', { location: h.doc.location });
  h.install('nativeAutomationFailures', []);
  row.querySelectorAll = () => { assert.fail('No DOM issue-card discovery'); };
  const requests = [];
  let finish;
  const helper = {
    state: { sessionLifecycleRevision: 0 }, config: {},
    runtime: { isSessionInteractive: () => true },
    acceptAllNativeWarnings(payload) {
      requests.push(payload);
      return new Promise(resolve => { finish = resolve; });
    }
  };
  let accept;
  api.registerRowActionInput(helper, { on(_phase, handler, order) { if (order === 94) accept = handler; } },
    { isFeatureEnabled: () => true, isTypingInTextControl: () => false });
  const event = { key: 'A', code: 'KeyA', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {} };
  assert.equal(accept(event), true);
  assert.deepEqual(requests, [{ reviewActionId: 'native-task' }]);
  accept(event);
  assert.equal(requests.length, 1);
  finish({ ok: false, error: 'Native task changed' });
  await Promise.resolve();
  assert.deepEqual(globalThis.nativeAutomationFailures, [{ feature: 'Accept all warnings', reason: 'Native task changed' }]);
  readOnly = true;
  accept(event);
  assert.equal(requests.length, 1);
  assert.equal(row.state.text, 'unchanged transcript');
});

test('warning bridge client uses a long action deadline and rejects replaced sessions before dispatch', async t => {
  const h = harness(t);
  const root = new ElementFixture('html');
  root.ownerDocument = h.doc;
  h.doc.documentElement = root;
  let task = 'task-one';
  root.dispatchEvent = event => {
    const request = JSON.parse(event.detail);
    root.setAttribute('data-babel-helper-editor-result', JSON.stringify({
      id: request.id, ok: true, reviewActionId: task, readOnly: false, routeKey: ''
    }));
  };
  const listeners = new Map(), requests = [], delays = [];
  h.install('window', {
    location: h.doc.location, __babelHelperRecoveredEditorBridge: {},
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    setTimeout(_callback, delay) { delays.push(delay); return 1; }, clearTimeout() {},
    dispatchEvent(event) { requests.push(event.detail); }
  });
  const helper = { state: { sessionLifecycleRevision: 0 },
    runtime: { isSessionInteractive: () => true }, isFeatureEnabled: () => true };
  api.registerRecoveredEditorSnapshotService(helper);
  const pending = helper.acceptAllNativeWarnings({ reviewActionId: task });
  await Promise.resolve();
  assert.deepEqual(delays, [31_000]);
  assert.equal(requests[0].operation, 'accept-all-warnings');
  listeners.get('babel-helper-recovered-editor-response')({ detail: {
    id: requests[0].id, result: { ok: true, acceptedCount: 3 }
  } });
  assert.deepEqual(await pending, { ok: true, acceptedCount: 3 });
  const stale = helper.acceptAllNativeWarnings({ reviewActionId: task });
  task = 'task-two';
  assert.equal((await stale).ok, false);
  assert.equal(requests.length, 1);
});

test('arrow suppression runs after native handling, follows live settings, and leaves unrelated controls alone', (t) => {
  const h = harness(t), row = h.turn('native text');
  let enabled = true;
  let interactive = true;
  const helper = {
    state: {}, config: { rowEditorSelector: '[data-slate-editor=\"true\"]' },
    runtime: { isSessionInteractive: () => interactive },
    isFeatureEnabled: (key) => key === 'disableNativeArrowSeek' ? enabled : true
  };
  const input = api.createEditorInput(helper);
  const press = (target, nativePreventsDefault = false) => {
    const event = {
      key: 'ArrowRight', code: 'ArrowRight', type: 'keydown', target,
      shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      stopped: false, immediate: false, prevented: false, defaultPrevented: false, composedPath: () => [target],
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; this.immediate = true; },
      preventDefault() { this.prevented = true; this.defaultPrevented = true; }
    };
    input.handleKeyCapture(event);
    input.handleKeydown(event);
    assert.equal(event.stopped, false, 'native Slate receives the key before outer-seek suppression');
    assert.equal(event.prevented, false, 'capture does not replace native caret movement');
    event.nativeHandled = true;
    if (nativePreventsDefault) event.preventDefault();
    input.handleKeyBubble(event);
    return event;
  };
  assert.equal(press(row.nativeElement).stopped, true);
  assert.equal(press(row.nativeElement).prevented, false, 'browser/Slate caret default remains available');
  assert.equal(press(row.nativeElement).immediate, false, 'same-document handlers are not suppressed');
  assert.equal(press(row.nativeElement, true).stopped, false, 'Slate can fully own and prevent its native key');
  assert.equal(press(new ElementFixture('div')).stopped, true, 'bare arrows outside controls cannot reach Babel window seek');
  enabled = false;
  assert.equal(press(row.nativeElement).stopped, false);
  enabled = true;
  assert.equal(press(new TextInputFixture('settings input')).stopped, false);
  interactive = false;
  assert.equal(press(row.nativeElement).stopped, false, 'noninteractive sessions retain native behavior');
});

test('native keydown synchronizes live selection before hooks without touching generic or composing input', (t) => {
  const h = harness(t), row = h.turn('Число 42 сегодня.');
  Object.assign(row.state, { start: 6, end: 8 });
  const input = api.createEditorInput({
    state: {}, config: { rowEditorSelector: '[data-slate-editor="true"]' },
    runtime: { isSessionInteractive: () => true }, isFeatureEnabled: () => true
  });
  const observed = [];
  input.hooks.on('keydown', () => { observed.push(row.calls.at(-1)?.operation); }, 1);
  const event = (target, extra = {}) => ({
    type: 'keydown', key: 'Alt', code: 'AltLeft', altKey: true, shiftKey: false,
    ctrlKey: false, metaKey: false, target, composedPath: () => [target], ...extra
  });
  input.handleKeydown(event(row.nativeElement));
  assert.equal(observed[0], 'syncSelection');
  assert.equal(row.calls.some(({ operation }) => operation === 'focus' || operation === 'replace'), false);
  row.calls.length = 0;
  input.handleKeydown(event(new TextInputFixture('dialog input')));
  input.handleKeydown(event(row.nativeElement, { isComposing: true }));
  input.handleKeydown(event(row.nativeElement, { defaultPrevented: true }));
  assert.equal(row.calls.some(({ operation }) => operation === 'syncSelection'), false);
});

test('paging owns only plain and Shift keys in the focused writable native editor', (t) => {
  const h = harness(t), row = h.turn('native text');
  h.doc.activeElement = row.nativeElement;
  const input = api.createEditorInput({
    state: {}, config: { rowEditorSelector: '[data-slate-editor="true"]' },
    runtime: { isSessionInteractive: () => true }, isFeatureEnabled: () => false
  });
  const press = (extra = {}) => {
    row.calls.length = 0;
    const event = {
      type: 'keydown', key: 'PageDown', code: 'PageDown', target: row.nativeElement,
      shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      defaultPrevented: false, stopped: false, composedPath() { return [this.target]; },
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }, ...extra
    };
    input.handleKeydown(event);
    return { event, paging: row.calls.filter(call => call.operation === 'pageSelection') };
  };
  const down = press();
  assert.equal(down.event.defaultPrevented, true);
  assert.equal(down.event.stopped, true);
  assert.equal(down.paging[0].direction, 'down');
  assert.equal(down.paging[0].extend, false);
  const up = press({ key: 'PageUp', shiftKey: true });
  assert.equal(up.paging[0].direction, 'up');
  assert.equal(up.paging[0].extend, true);
  for (const extra of [{ altKey: true }, { ctrlKey: true }, { metaKey: true },
    { isComposing: true }, { keyCode: 229 }, { target: new TextInputFixture('other control') }]) {
    const result = press(extra);
    assert.equal(result.paging.length, 0);
    assert.equal(result.event.defaultPrevented, false);
  }
  input.handleComposition({ type: 'compositionstart' });
  assert.equal(press().paging.length, 0);
  input.handleComposition({ type: 'compositionend' });
  h.doc.activeElement = null;
  assert.equal(press().paging.length, 0);
  h.doc.activeElement = row.nativeElement;
  row.state.readOnly = true;
  assert.equal(press().paging.length, 0);
});

test('native beforeinput and paste synchronize DOM selection without consuming the native edit', (t) => {
  const h = harness(t), row = h.turn('native original');
  const input = api.createEditorInput({
    state: {}, config: {}, runtime: { isSessionInteractive: () => true }, isFeatureEnabled: () => true
  });
  const event = (type, target, extra = {}) => ({
    type, target, composedPath: () => [target],
    preventDefault() { throw new Error('native text input must remain authoritative'); }, ...extra
  });
  input.handleNativeTextInput(event('beforeinput', row.nativeElement, { inputType: 'insertText' }));
  input.handleNativeTextInput(event('paste', row.nativeElement));
  assert.equal(row.calls.filter(call => call.operation === 'syncSelection').length, 2);
  row.calls.length = 0;
  input.handleNativeTextInput(event('beforeinput', row.nativeElement, { isComposing: true }));
  input.handleNativeTextInput(event('beforeinput', row.nativeElement, { defaultPrevented: true }));
  input.handleNativeTextInput(event('paste', new TextInputFixture('ordinary input')));
  assert.equal(row.calls.length, 0);
  assert.equal(row.state.text, 'native original');
});

test('native controls interoperate across independently emitted entry and lazy-session bundles', (t) => {
  const h = harness(t), row = h.turn('one two');
  const foreign = separatelyLoaded.getEditorControl(row);
  assert.equal(foreign instanceof api.EditorControl, false, 'the regression requires distinct bundled constructors');
  assert.equal(api.isEditorControl(foreign), true);
  assert.equal(api.setEditableValue(foreign, 'three two'), true);
  assert.equal(row.state.text, 'three two');
  foreign.setSelectionRange(0, 5);
  assert.equal(api.replaceSelectionInTextControl(foreign, '3 {СКАЗ: three}'), true);
  assert.equal(row.state.text, '3 {СКАЗ: three} two');
  assert.equal(api.isEditorControl({ replaceValue() {}, setSelectionRange() {}, selectAll() {}, synchronizeSelection() {} }), false,
    'an unbranded arbitrary object is not a native editor control');
});

test('selectionchange synchronizes active native selection immediately without touching composition or outside selections', (t) => {
  const h = harness(t), row = h.turn('<иностранная-речь> hello </иностранная-речь>');
  const inside = new ElementFixture('span'), outside = new ElementFixture('span');
  row.nativeElement.contains = node => node === inside;
  h.doc.activeElement = row.nativeElement;
  let selection = { anchorNode: inside, focusNode: inside };
  h.doc.getSelection = () => selection;
  let interactive = true;
  const input = api.createEditorInput({
    state: {}, config: {}, runtime: { isSessionInteractive: () => interactive }, isFeatureEnabled: () => true
  });
  input.handleNativeSelectionChange();
  assert.equal(row.calls.at(-1).operation, 'syncSelection');
  assert.equal(row.calls.at(-1).source, 'selectionchange');
  row.calls.length = 0;
  input.handleComposition({ type: 'compositionstart' });
  input.handleNativeSelectionChange();
  assert.equal(row.calls.length, 0);
  input.handleComposition({ type: 'compositionend' });
  input.handleNativeSelectionChange();
  assert.equal(row.calls.at(-1).operation, 'syncSelection');
  row.calls.length = 0;
  selection = { anchorNode: inside, focusNode: outside };
  input.handleNativeSelectionChange();
  assert.equal(row.calls.length, 0);
  selection = { anchorNode: inside, focusNode: inside };
  row.state.readOnly = true;
  input.handleNativeSelectionChange();
  assert.equal(row.calls.some(call => call.operation === 'syncSelection'), false);
  row.calls.length = 0;
  row.state.readOnly = false;
  interactive = false;
  input.handleNativeSelectionChange();
  assert.equal(row.calls.length, 0);
  interactive = true;
  row.nativeElement.isConnected = false;
  input.handleNativeSelectionChange();
  assert.equal(row.calls.length, 0);
});

test('native Ctrl/Meta+A commits the explicit raw select-all command and consumes only successful native selection', (t) => {
  const h = harness(t), row = h.turn('<тихо> Текст </тихо> 42');
  h.doc.activeElement = row.nativeElement;
  const input = api.createEditorInput({
    state: {}, config: {}, runtime: { isSessionInteractive: () => true }, isFeatureEnabled: () => true
  });
  const press = (overrides = {}) => {
    const event = { type: 'keydown', key: 'a', code: 'KeyA', target: row.nativeElement,
      ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
      defaultPrevented: false, propagationStopped: false,
      composedPath() { return [this.target]; },
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }, ...overrides };
    input.handleKeydown(event);
    return event;
  };
  for (const modifiers of [{}, { ctrlKey: false, metaKey: true }]) {
    row.state.start = row.state.end = row.state.text.length;
    row.calls.length = 0;
    const event = press(modifiers);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.deepEqual([row.state.start, row.state.end], [0, row.state.text.length]);
    assert.equal(row.calls.find(call => call.operation === 'select').selectAll, true);
    assert.equal(row.calls.some(call => call.operation === 'replace'), false);
  }
  for (const modifiers of [{ ctrlKey: false }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) {
    row.calls.length = 0;
    assert.equal(press(modifiers).defaultPrevented, false);
    assert.equal(row.calls.some(call => call.operation === 'select'), false);
  }
  const nativeDispatch = row.dispatchEvent;
  row.dispatchEvent = event => {
    const request = JSON.parse(event.detail);
    if (request.operation === 'select') {
      row.setAttribute('data-babel-helper-editor-result', JSON.stringify({ ...row.state, id: request.id, ok: false }));
      return true;
    }
    return nativeDispatch(event);
  };
  assert.equal(press().defaultPrevented, false, 'unavailable native selection keeps the browser command available');
  row.dispatchEvent = nativeDispatch;
  const generic = new TextInputFixture('ordinary options text');
  h.doc.activeElement = generic;
  assert.equal(press({ target: generic }).defaultPrevented, false);
});

test('pointer selection intent retires command ownership without applying the old DOM range', (t) => {
  const h = harness(t), row = h.turn('native text');
  const input = api.createEditorInput({
    state: {}, config: {}, runtime: { isSessionInteractive: () => true }, isFeatureEnabled: () => true
  });
  input.handleNativePointerDown({ target: row.nativeElement, composedPath: () => [row.nativeElement] });
  assert.equal(row.calls.at(-1).operation, 'syncSelection');
  assert.equal(row.calls.at(-1).source, 'intent');
  assert.equal(row.calls.some(call => call.operation === 'select' || call.operation === 'replace' || call.operation === 'focus'), false);
});

test('native navigation releases selection ownership without sampling the old DOM again on the same keydown', (t) => {
  const h = harness(t), row = h.turn('native text');
  h.doc.activeElement = row.nativeElement;
  const input = api.createEditorInput({
    state: {}, config: {}, runtime: { isSessionInteractive: () => true }, isFeatureEnabled: () => true
  });
  const event = { type: 'keydown', key: 'Home', code: 'Home', target: row.nativeElement,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, composedPath: () => [row.nativeElement] };
  input.handleKeyCapture(event);
  input.handleKeydown(event);
  assert.deepEqual(row.calls.filter(call => call.operation === 'syncSelection').map(call => call.source), ['intent']);
  assert.equal(row.calls.some(call => call.operation === 'select' || call.operation === 'replace'), false);
});

function nativeSessionHarness(t, { known = true } = {}) {
  const h = harness(t);
  h.doc.location = new URL('https://babel.test/transcription/job?reviewActionId=task-one&displayFeedback=true');
  h.doc.readyState = 'loading';
  const root = new ElementFixture('html'), body = new ElementFixture('body'), surface = new ElementFixture();
  let mountedSurface = surface;
  root.ownerDocument = h.doc;
  h.doc.documentElement = root;
  h.doc.body = body;
  root.setAttribute('data-babel-review-action-id', 'task-one');
  h.doc.querySelector = selector => selector === '[data-transcript-scroll]' ? mountedSurface : null;
  h.doc.addEventListener = () => {};
  h.doc.removeEventListener = () => {};
  const writable = { ok: true, reviewActionId: 'task-one', readOnly: false,
    routeKey: `${h.doc.location.pathname}${h.doc.location.search}` };
  let status = known ? { ...writable } : null;
  root.dispatchEvent = event => {
    const request = JSON.parse(event.detail);
    assert.equal(request.operation, 'session');
    root.setAttribute('data-babel-helper-editor-result', JSON.stringify({
      id: request.id, ...(status || { ok: false, reviewActionId: '', readOnly: true, routeKey: writable.routeKey })
    }));
    return true;
  };
  const timers = new Map();
  const intervals = new Map();
  const observers = [];
  let timerId = 0;
  const listeners = new Map(), navigationListeners = new Map();
  const addListener = (registry, name, listener) => {
    if (!registry.has(name)) registry.set(name, new Set());
    registry.get(name).add(listener);
  };
  const windowRef = {
    location: h.doc.location, history: { pushState() {}, replaceState() {} },
    addEventListener(name, listener) { addListener(listeners, name, listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
    navigation: {
      addEventListener(name, listener) { addListener(navigationListeners, name, listener); },
      removeEventListener(name, listener) { navigationListeners.get(name)?.delete(listener); }
    },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback) { const id = ++timerId; timers.set(id, callback); intervals.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); intervals.delete(id); },
    requestAnimationFrame(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    cancelAnimationFrame(id) { timers.delete(id); }
  };
  h.install('window', windowRef);
  h.install('location', windowRef.location);
  h.install('MutationObserver', class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
  });
  const calls = { ensure: 0, activationIds: [], deactivate: 0, refresh: 0 };
  const failures = [];
  h.install('nativeAutomationFailures', failures);
  let ensureGate = null;
  const helper = {
    state: { sessionActive: false },
    config: { features: {} }, isFeatureEnabled: () => false,
    refreshEditorSnapshot: async () => { calls.refresh++; return null; },
    subscribePlayback: () => () => {},
    runtime: {
      async ensureSessionRuntime() { calls.ensure++; const gate = ensureGate; ensureGate = null; return gate ? await gate : true; },
      async onLoaded() { calls.activationIds.push(api.readNativeSessionState().reviewActionId); return true; },
      deactivateFeature() { calls.deactivate++; }
    }
  };
  api.registerLifecycle(helper);
  h.cleanup.push(() => helper.runtime.disposeLifecycle('test-end'));
  return {
    ...h, root, surface, helper, calls, timers, intervals, observers, writable, windowRef, failures,
    emit(name) { windowRef.dispatchEvent({ type: name }); },
    navigate() { for (const listener of navigationListeners.get('currententrychange') || []) listener(); },
    setSurface(value) { mountedSurface = value; },
    publish(value) {
      root.setAttribute('data-babel-helper-native-session', JSON.stringify({
        href: windowRef.location.href, generation: 1, status: 'ready', ...value
      }));
      windowRef.dispatchEvent({ type: 'babel-helper:native-session-change' });
    },
    get status() { return status; },
    setStatus(next) { status = next; },
    deferEnsure() { const deferred = Promise.withResolvers(); ensureGate = deferred.promise; return deferred; }
  };
}

async function settleNativeSession() {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

test('writable native feedback sessions admit editing even with zero turns; actual readonly metadata denies it', async t => {
  const h = nativeSessionHarness(t);
  assert.equal(h.rows.length, 0);
  assert.equal(h.helper.runtime.isSessionInteractive(), true);
  assert.equal(h.helper.runtime.refreshRouteSession('writable-feedback'), true);
  await settleNativeSession();
  assert.equal(h.helper.state.sessionActive, true);
  assert.deepEqual(h.calls.activationIds, ['task-one']);
  h.setStatus({ ...h.writable, readOnly: true });
  assert.equal(h.helper.runtime.isSessionInteractive(), false);
  assert.equal(h.helper.runtime.refreshRouteSession('native-readonly'), false);
  assert.equal(h.helper.state.sessionActive, false);
  assert.equal(h.helper.state.rowTrackingBound, false);
  assert.equal(h.observers.length, 0, 'session discovery belongs to the MAIN native publisher');
  h.setStatus({ ...h.writable });
  assert.equal(h.helper.runtime.isSessionInteractive(), true, 'native writability, not displayFeedback, owns permission');
});

test('unknown native session bootstraps the real snapshot bridge before admitting any editing', async t => {
  const h = nativeSessionHarness(t, { known: false });
  h.helper.refreshEditorSnapshot = async () => { h.calls.refresh++; h.setStatus({ ...h.writable }); return {}; };
  assert.equal(h.helper.runtime.isSessionInteractive(), false);
  assert.equal(h.helper.runtime.refreshRouteSession('unknown'), false);
  assert.equal(h.calls.ensure, 0);
  await settleNativeSession();
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.helper.state.sessionActive, true);
  assert.deepEqual(h.calls.activationIds, ['task-one']);
});

test('native session reads reject route and malformed metadata, not a stale snapshot task attribute', t => {
  const h = nativeSessionHarness(t);
  h.setStatus({ ...h.writable, reviewActionId: 'old-task' });
  assert.equal(h.helper.runtime.isSessionInteractive(), true, 'live native task identity supersedes stale DOM snapshot metadata');
  h.setStatus({ ...h.writable, routeKey: '/transcription/other' });
  assert.equal(h.helper.runtime.isSessionInteractive(), false);
  h.setStatus({ ...h.writable, readOnly: undefined });
  assert.equal(h.helper.runtime.isSessionInteractive(), false);
  h.setStatus({ ...h.writable, reviewActionId: '' });
  assert.equal(h.helper.runtime.isSessionInteractive(), false);
});

test('a pending session bind cannot activate a different native task on the same feedback URL', async t => {
  const h = nativeSessionHarness(t);
  const gate = h.deferEnsure();
  h.helper.init();
  await settleNativeSession();
  h.root.setAttribute('data-babel-review-action-id', 'task-two');
  h.setStatus({ ...h.writable, reviewActionId: 'task-two' });
  h.publish({ reviewActionId: 'task-two', readOnly: false });
  await settleNativeSession();
  assert.deepEqual(h.calls.activationIds, ['task-two']);
  gate.resolve(true);
  await settleNativeSession();
  assert.deepEqual(h.calls.activationIds, ['task-two'], 'old completion cannot reactivate or clear the new generation');
  assert.equal(h.timers.size, 0);
});

test('disposing lifecycle prevents an in-flight native status probe from resurrecting editing', async t => {
  const h = nativeSessionHarness(t, { known: false });
  const gate = Promise.withResolvers();
  h.helper.refreshEditorSnapshot = () => gate.promise;
  h.helper.runtime.refreshRouteSession('pending-status');
  await settleNativeSession();
  h.helper.runtime.disposeLifecycle('disposed');
  h.setStatus({ ...h.writable });
  gate.resolve({});
  await settleNativeSession();
  assert.equal(h.helper.runtime.isSessionInteractive(), false);
  assert.deepEqual(h.calls.activationIds, []);
  assert.equal(h.timers.size, 0);
});

test('same-URL native permission events retire and readmit once without DOM mutations', async t => {
  const h = nativeSessionHarness(t);
  h.setStatus({ ...h.writable, readOnly: true });
  h.helper.init();
  await settleNativeSession();
  assert.equal(h.observers.length, 0, 'readonly sessions do not install a duplicate global mount observer');
  assert.equal(h.calls.ensure, 0);
  assert.equal(h.timers.size, 0);
  h.setStatus({ ...h.writable });
  h.publish({ reviewActionId: 'task-one', readOnly: false });
  await settleNativeSession();
  assert.equal(h.helper.state.sessionActive, true);
  assert.deepEqual(h.calls.activationIds, ['task-one']);
  for (let index = 0; index < 10; index++) h.emit('babel-helper:native-session-change');
  await settleNativeSession();
  assert.equal(h.calls.ensure, 1, 'duplicate state notifications do not re-admit');
  h.setStatus({ ...h.writable, readOnly: true });
  h.publish({ reviewActionId: 'task-one', readOnly: true });
  await settleNativeSession();
  assert.equal(h.helper.state.sessionActive, false);
});

test('missing surface bootstraps MAIN once before waiting for its native mount publication', async t => {
  const h = nativeSessionHarness(t, { known: false });
  h.setSurface(null);
  h.helper.refreshEditorSnapshot = async () => {
    h.calls.refresh++;
    h.publish({ status: 'unmounted', reviewActionId: '', readOnly: null });
    return null;
  };
  h.helper.init();
  await settleNativeSession();
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.calls.ensure, 0);
  assert.equal(h.timers.size, 0);
  h.setSurface(h.surface);
  h.setStatus({ ...h.writable });
  h.publish({ reviewActionId: 'task-one', readOnly: false });
  await settleNativeSession();
  assert.equal(h.calls.refresh, 1, 'ready native publication needs no extra snapshot discovery');
  assert.deepEqual(h.calls.activationIds, ['task-one']);
  assert.equal(h.intervals.size, 0);
});

test('unsupported native hook fails visibly and unrelated DOM or pageshow cannot retry it', async t => {
  const h = nativeSessionHarness(t, { known: false });
  h.publish({ status: 'error', error: 'root.current is not configurable' });
  h.helper.init();
  await settleNativeSession();
  assert.equal(h.helper.runtime.isSessionInteractive(), false);
  assert.equal(h.calls.ensure, 0);
  assert.equal(h.calls.refresh, 0);
  assert.match(h.failures[0].reason, /not configurable/);
  assert.equal(h.observers.length, 0);
  for (let index = 0; index < 10; index++) h.emit('pageshow');
  await settleNativeSession();
  assert.equal(h.failures.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.refresh, 0);
});

test('session bind rejection is terminal for that admission and does not leave a retry', async t => {
  const h = nativeSessionHarness(t);
  h.helper.runtime.ensureSessionRuntime = async () => { h.calls.ensure++; throw new Error('native bind refused'); };
  h.helper.init();
  await settleNativeSession();
  assert.equal(h.helper.state.sessionActive, false);
  assert.equal(h.helper.runtime.isSessionInteractive(), false);
  assert.match(h.failures[0].reason, /native bind refused/);
  h.emit('pageshow');
  await settleNativeSession();
  assert.equal(h.calls.ensure, 1);
  assert.equal(h.timers.size, 0);
});

test('settings reconciliation keeps one hotkeys observer until its feature is disabled', async t => {
  const h = nativeSessionHarness(t);
  h.helper.isFeatureEnabled = key => key === 'hotkeysHelp';
  h.helper.enhanceHotkeysDialog = () => {};
  h.helper.runtime.refreshRouteSession('interactive');
  await settleNativeSession();
  const observer = h.helper.state.hotkeysObserver;
  assert.ok(observer);
  for (let index = 0; index < 30; index++) h.helper.runtime.reconcileSessionSettings();
  assert.equal(h.observers.filter(item => item !== observer).length, 0, 'hotkeys alone owns its filtered dialog observer');
  assert.equal(h.helper.state.hotkeysObserver, observer);
  assert.notEqual(observer.disconnected, true);
  h.helper.isFeatureEnabled = () => false;
  h.helper.runtime.reconcileSessionSettings();
  assert.equal(observer.disconnected, true);
  assert.equal(h.helper.state.hotkeysObserver, null);
});

test('native Navigation API and hash changes retire routes without patching isolated history or timers', async t => {
  const h = nativeSessionHarness(t);
  const external = function () { return 'external-result'; };
  h.windowRef.history.replaceState = external;
  h.helper.init();
  await settleNativeSession();
  const revision = h.helper.state.sessionLifecycleRevision;
  h.doc.location.pathname = '/transcription/replaced';
  h.setStatus({ ...h.writable, routeKey: `${h.doc.location.pathname}${h.doc.location.search}` });
  h.navigate();
  h.emit('popstate');
  await settleNativeSession();
  assert.ok(h.helper.state.sessionLifecycleRevision > revision);
  assert.deepEqual(h.calls.activationIds, ['task-one', 'task-one'], 'duplicate route notifications admit only once');
  assert.equal(h.windowRef.history.replaceState, external);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timers.size, 0);
  h.doc.location.hash = '#turn';
  h.emit('hashchange');
  await settleNativeSession();
  assert.equal(h.calls.activationIds.length, 3);
  h.helper.runtime.disposeLifecycle('test-dispose');
  h.helper.runtime.scheduleRouteRefresh('late-completion');
  h.navigate();
  await settleNativeSession();
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.activationIds.length, 3);
  assert.equal(h.windowRef.history.replaceState, external);
});

test('same-task native root generation replacement disposes and rebinds exactly once', async t => {
  const h = nativeSessionHarness(t);
  h.publish({ reviewActionId: 'task-one', readOnly: false });
  h.helper.init();
  await settleNativeSession();
  h.publish({ generation: 2, reviewActionId: 'task-one', readOnly: false });
  await settleNativeSession();
  assert.equal(h.calls.deactivate, 1);
  assert.equal(h.calls.ensure, 2);
  assert.deepEqual(h.calls.activationIds, ['task-one', 'task-one']);
  assert.equal(h.timers.size, 0);
});

test('native unmount publication cancels an in-flight admission and same-URL remount admits the new generation', async t => {
  const h = nativeSessionHarness(t);
  const first = h.deferEnsure();
  h.publish({ reviewActionId: 'task-one', readOnly: false });
  h.helper.init();
  await settleNativeSession();
  assert.equal(h.calls.ensure, 1);
  h.setSurface(null);
  h.setStatus(null);
  h.publish({ generation: 2, status: 'unmounted', reviewActionId: '', readOnly: null });
  await settleNativeSession();
  first.resolve(true);
  await settleNativeSession();
  assert.equal(h.helper.state.sessionActive, false);
  assert.equal(h.helper.state.nativeSessionAdmission, null);
  assert.deepEqual(h.calls.activationIds, []);
  h.setSurface(h.surface);
  h.setStatus({ ...h.writable });
  h.publish({ generation: 3, reviewActionId: 'task-one', readOnly: false });
  await settleNativeSession();
  assert.equal(h.helper.state.sessionActive, true);
  assert.equal(h.calls.ensure, 2);
  assert.deepEqual(h.calls.activationIds, ['task-one']);
  assert.equal(h.calls.refresh, 0);
  assert.equal(h.observers.length, 0);
  assert.equal(h.intervals.size, 0);
});

test('a missing MAIN bridge after explicit bootstrap fails visibly instead of retrying or fabricating permissions', async t => {
  const h = nativeSessionHarness(t, { known: false });
  h.helper.init();
  await settleNativeSession();
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.calls.ensure, 0);
  assert.match(h.failures[0].reason, /subscription is unavailable/);
  h.emit('pageshow');
  h.emit('babel-helper:native-session-change');
  await settleNativeSession();
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.helper.runtime.isSessionInteractive(), false);
});

test('refused feature activation clears admitted session and reports the failure once', async t => {
  const h = nativeSessionHarness(t);
  h.helper.runtime.onLoaded = async () => false;
  h.helper.init();
  await settleNativeSession();
  assert.equal(h.helper.state.sessionActive, false);
  assert.match(h.failures[0].reason, /activation was refused/);
  h.emit('pageshow');
  await settleNativeSession();
  assert.equal(h.calls.ensure, 1);
  assert.equal(h.failures.length, 1);
});

test('same-URL native task admission reaches playback consumers before onLoaded despite a stale Gold task marker', async t => {
  const h = nativeSessionHarness(t);
  const subscriptions = [], retired = [], loaded = [];
  h.helper.subscribePlayback = () => {
    const admission = h.helper.state.nativeSessionAdmission;
    assert.ok(admission, 'subscriptions require the validated admission lease');
    assert.equal(admission.href, h.windowRef.location.href);
    assert.equal(admission.lifecycleRevision, h.helper.state.sessionLifecycleRevision);
    assert.equal(admission.reviewActionId, api.readNativeSessionState().reviewActionId);
    subscriptions.push(admission.reviewActionId);
    return () => retired.push(admission.reviewActionId);
  };
  h.helper.runtime.onLoaded = async () => {
    loaded.push({ task: h.helper.state.nativeSessionAdmission.reviewActionId, subscriptions: subscriptions.length });
    return true;
  };
  h.helper.init();
  await settleNativeSession();
  const gate = h.deferEnsure();
  h.setStatus({ ...h.writable, reviewActionId: 'task-two' });
  h.publish({ reviewActionId: 'task-two', readOnly: false });
  await settleNativeSession();
  assert.deepEqual(subscriptions, ['task-one'], 'replacement waits for native runtime readiness');
  assert.equal(h.helper.state.nativeSessionAdmission, null, 'retired admission cannot authorize replacement subscriptions');
  assert.deepEqual(retired, ['task-one']);
  gate.resolve(true);
  await settleNativeSession();
  assert.deepEqual(subscriptions, ['task-one', 'task-two']);
  assert.deepEqual(loaded, [{ task: 'task-one', subscriptions: 1 }, { task: 'task-two', subscriptions: 2 }]);
  assert.equal(h.root.getAttribute('data-babel-review-action-id'), 'task-one', 'Helper does not overwrite Gold-owned metadata');
  assert.equal(h.calls.refresh, 0, 'identity does not depend on a snapshot/network retry');
  assert.equal(h.failures.length, 0);
  h.helper.runtime.disposeLifecycle('test-dispose');
  assert.equal(h.helper.state.nativeSessionAdmission, null);
  assert.deepEqual(retired, ['task-one', 'task-two']);
});

test('marked Classic rows use native ownership, selection direction and recording guards', t => {
  const h = harness(t), row = h.turn('classic draft');
  row.tagName = 'tr';
  assert.equal(api.getEditorControl(row), null, 'a random table row is not a native editor');
  row.setAttribute('data-babel-classic-row', 'true');
  row.nativeElement.tagName = 'textarea';
  const input = api.getEditorControl(row);
  assert.ok(input);
  assert.equal(input.replaceValue('updated draft', { start: 2, end: 7, direction: 'backward' }), true);
  assert.deepEqual([input.value, input.selectionStart, input.selectionEnd, input.selectionDirection],
    ['updated draft', 2, 7, 'backward']);
  assert.equal(row.calls.at(-1).processedRecordingId, 'speaker-one');
  row.state.processedRecordingId = 'speaker-two';
  assert.equal(input.replaceValue('stale lane'), false);
  assert.equal(row.state.text, 'updated draft');
});
