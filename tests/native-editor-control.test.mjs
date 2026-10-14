import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  stdin: { contents: `
    export * from './src/site/editor-control';
    export * from './src/site/rows';
    export * from './src/hooks/selected-number-to-skaz';
    export * from './src/features/text-move-feature';
    export * from './src/features/selected-number-feature';
    export * from './src/services/recovered-editor-snapshot-service';
    export * from './src/features/row-actions-feature';
    export * from './src/features/editor-input';
    export * from './src/hooks/dom';
    export * from './src/core/lifecycle';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent'
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
    return this.tagName === 'section' ? selector === 'section[data-annotation-id]' : Boolean(this.editor && selector.includes('data-slate-editor'));
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
    installed.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const rows = [];
  const doc = { location: { href: 'https://babel.test/transcription/job' }, activeElement: null, querySelectorAll: () => rows };
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
  return { doc, rows, turn, install, cleanup };
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
  assert.equal(helper.rowMatchesIdentity(row, oldIdentity), false);
  assert.equal(helper.findRowByIdentity(oldIdentity), null);
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
  const helper = { state: { sessionLifecycleRevision: 0 } };
  api.registerRecoveredEditorSnapshotService(helper);
  const refresh = helper.refreshEditorSnapshot('test');
  await Promise.resolve();
  const request = requests[0];
  assert.ok(request);
  root.setAttribute('data-babel-review-action-id', 'task-two');
  listeners.get('babel-helper-recovered-editor-response')({ detail: {
    id: request.id, result: { ok: true, snapshot: {
      contractVersion: 'native-36978-2026-10-13', capturedAt: Date.now(),
      routeKey: '/transcription/job', reviewActionId: 'task-one', readOnly: false, rows: []
    } }
  } });
  assert.equal(await refresh, null);
  assert.equal(helper.state.editorSnapshot, undefined);
});

test('accept-all processes native issue buttons individually and stops on a same-route task replacement', async (t) => {
  const h = harness(t), row = h.turn('unchanged transcript');
  const root = new ElementFixture('html');
  root.setAttribute('data-babel-review-action-id', 'task-one');
  h.doc.documentElement = root;
  const transcript = new ElementFixture();
  transcript.contains = (element) => element === row;
  row.parentElement = transcript;
  const frames = [];
  h.install('window', { location: h.doc.location, requestAnimationFrame: (callback) => frames.push(callback) });
  const buttons = [new ElementFixture('button'), new ElementFixture('button')];
  let clicked = 0;
  for (const button of buttons) {
    button.textContent = 'My transcription is correct';
    button.click = () => { clicked++; button.acknowledged = true; };
  }
  row.querySelectorAll = () => buttons.filter((button) => !button.acknowledged);
  const helper = {
    state: { sessionLifecycleRevision: 0 }, config: {},
    runtime: { isSessionInteractive: () => true },
    getTranscriptRows: () => [row], getRowEditor: api.getEditorControl
  };
  let accept;
  api.registerRowActionInput(helper, { on(_phase, handler, order) { if (order === 94) accept = handler; } },
    { isFeatureEnabled: () => true, isTypingInTextControl: () => false });
  assert.equal(accept({ key: 'A', code: 'KeyA', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
    preventDefault() {}, stopPropagation() {} }), true);
  assert.equal(clicked, 1);
  root.setAttribute('data-babel-review-action-id', 'task-two');
  frames.shift()();
  await Promise.resolve();
  assert.equal(clicked, 1, 'the next task never inherits the pending acknowledgement loop');
  assert.equal(row.state.text, 'unchanged transcript');
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
  root.ownerDocument = h.doc;
  h.doc.documentElement = root;
  h.doc.body = body;
  root.setAttribute('data-babel-review-action-id', 'task-one');
  h.doc.querySelector = selector => selector === '[data-transcript-scroll]' ? surface : null;
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
  const windowRef = {
    location: h.doc.location, history: { pushState() {}, replaceState() {} },
    addEventListener() {}, removeEventListener() {},
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
  let ensureGate = null;
  const helper = {
    state: { routeRefreshAttempts: 0, routeRefreshWindowStartedAt: 0, sessionActive: false, sessionBindRetryCount: 0 },
    config: { features: {} }, isFeatureEnabled: () => false,
    refreshEditorSnapshot: async () => { calls.refresh++; return null; },
    runtime: {
      clearRuntimeTimer() { windowRef.clearTimeout(helper.state.routeRefreshTimer); helper.state.routeRefreshTimer = 0; },
      async ensureSessionRuntime() { calls.ensure++; const gate = ensureGate; ensureGate = null; return gate ? await gate : true; },
      async onLoaded() { calls.activationIds.push(api.readNativeSessionState().reviewActionId); return true; },
      deactivateFeature() { calls.deactivate++; }
    }
  };
  api.registerLifecycle(helper);
  h.cleanup.push(() => helper.runtime.disposeLifecycle('test-end'));
  return {
    ...h, root, surface, helper, calls, timers, intervals, observers, writable, windowRef,
    get status() { return status; },
    setStatus(next) { status = next; },
    deferEnsure() { const deferred = Promise.withResolvers(); ensureGate = deferred.promise; return deferred; },
    runNextTimer() { const entry = timers.entries().next().value; assert.ok(entry, 'expected a lifecycle continuation'); timers.delete(entry[0]); entry[1](); }
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
  assert.equal(h.observers.at(-1).options.attributeFilter.includes('data-babel-helper-editor-result'), false);
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
  h.runNextTimer();
  await settleNativeSession();
  assert.equal(h.helper.state.sessionActive, true);
  assert.deepEqual(h.calls.activationIds, ['task-one']);
});

test('native session identity and route mismatches remain unknown instead of granting write access', t => {
  const h = nativeSessionHarness(t);
  h.setStatus({ ...h.writable, reviewActionId: 'old-task' });
  assert.equal(h.helper.runtime.isSessionInteractive(), false);
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
  h.helper.runtime.refreshRouteSession('first-task');
  await settleNativeSession();
  h.root.setAttribute('data-babel-review-action-id', 'task-two');
  h.setStatus({ ...h.writable, reviewActionId: 'task-two' });
  h.helper.runtime.refreshRouteSession('replacement-task');
  gate.resolve(true);
  await settleNativeSession();
  assert.deepEqual(h.calls.activationIds, []);
  h.runNextTimer();
  await settleNativeSession();
  assert.deepEqual(h.calls.activationIds, ['task-two']);
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

test('unchanged readonly DOM updates do not restart session recovery; writability still activates', async t => {
  const h = nativeSessionHarness(t);
  h.setStatus({ ...h.writable, readOnly: true });
  h.helper.runtime.refreshRouteSession('readonly');
  const observer = h.observers.at(-1);
  for (let index = 0; index < 30; index++) observer.callback([]);
  assert.equal(h.timers.size, 0, 'unrelated readonly rendering schedules no rebinds');
  assert.equal(h.observers.length, 1);
  assert.equal(h.calls.ensure, 0);
  h.setStatus({ ...h.writable });
  observer.callback([]);
  assert.equal(h.timers.size, 1);
  h.runNextTimer();
  await settleNativeSession();
  assert.equal(h.helper.state.sessionActive, true);
  assert.deepEqual(h.calls.activationIds, ['task-one']);
});

test('unknown-session DOM updates do not extend the bounded bootstrap retry window', async t => {
  const h = nativeSessionHarness(t, { known: false });
  h.helper.runtime.refreshRouteSession('unknown');
  await settleNativeSession();
  const attempts = h.helper.state.routeRefreshAttempts;
  const startedAt = h.helper.state.routeRefreshWindowStartedAt;
  const scheduled = h.helper.state.routeRefreshTimer;
  for (let index = 0; index < 30; index++) h.observers.at(-1).callback([]);
  assert.equal(h.helper.state.routeRefreshAttempts, attempts);
  assert.equal(h.helper.state.routeRefreshWindowStartedAt, startedAt);
  assert.equal(h.helper.state.routeRefreshTimer, scheduled);
  assert.equal(h.calls.refresh, 1);
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
  assert.equal(h.observers.length, 1);
  assert.equal(h.helper.state.hotkeysObserver, observer);
  assert.notEqual(observer.disconnected, true);
  h.helper.isFeatureEnabled = () => false;
  h.helper.runtime.reconcileSessionSettings();
  assert.equal(observer.disconnected, true);
  assert.equal(h.helper.state.hotkeysObserver, null);
});

test('URL fallback repairs external history replacements and still retires changed routes', async t => {
  const h = nativeSessionHarness(t);
  h.helper.init();
  await settleNativeSession();
  const revision = h.helper.state.sessionLifecycleRevision;
  const external = function () { return 'external-result'; };
  h.windowRef.history.replaceState = external;
  h.doc.location.pathname = '/transcription/replaced';
  h.setStatus({ ...h.writable, routeKey: `${h.doc.location.pathname}${h.doc.location.search}` });
  [...h.intervals.values()][0]();
  assert.notEqual(h.windowRef.history.replaceState, external);
  assert.ok(h.helper.state.sessionLifecycleRevision > revision);
  const timer = h.helper.state.routeRefreshTimer;
  const callback = h.timers.get(timer);
  h.timers.delete(timer);
  callback();
  await settleNativeSession();
  assert.deepEqual(h.calls.activationIds, ['task-one', 'task-one']);
  assert.equal(h.windowRef.history.replaceState(), 'external-result');
  h.helper.runtime.disposeLifecycle('test-dispose');
  h.helper.runtime.scheduleRouteRefresh('late-completion');
  assert.equal(h.timers.size, 0, 'disposed continuations cannot leave a retry behind');
  assert.equal(h.intervals.size, 0);
  assert.equal(h.windowRef.history.replaceState, external);
});
