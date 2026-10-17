import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function loadEntry(entryPoint) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

const { createBaselineResetFeature } = await loadEntry('src/features/baseline-reset-feature.ts');
const settle = () => new Promise(resolve => setImmediate(resolve));
const plan = (overrides = {}) => ({ ok: true, token: 'plan-1', level: 1, segmentCount: 3,
  reviewActionId: 'task-1', baselineReviewActionId: 'baseline-1', ...overrides });

class Events {
  listeners = new Map();
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    if (!event.target) Object.defineProperty(event, 'target', { configurable: true, value: this });
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
    return !event.defaultPrevented;
  }
  dispatch(type, extra = {}) {
    const event = { type, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...extra };
    this.dispatchEvent(event);
    return event;
  }
}

class ElementFixture extends Events {
  constructor(doc, tagName) {
    super();
    this.ownerDocument = doc;
    this.tagName = tagName;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
    this.classes = new Set();
    this.classList = { add: (...names) => names.forEach(name => this.classes.add(name)) };
    this.disabled = false;
    this.text = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get isConnected() { return this === this.ownerDocument.documentElement || Boolean(this.parentElement?.isConnected); }
  get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
  append(...children) { for (const child of children) this.appendChild(child); }
  appendChild(child) { return this.insertBefore(child, null); }
  insertBefore(child, before) {
    child.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.notEqual(index, -1);
    child.parentElement = this;
    this.children.splice(index, 0, child);
    return child;
  }
  remove() {
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
  contains(node) { return Boolean(node && this.all().includes(node)); }
  matches(selector) {
    if (selector.startsWith('#')) return (this.id ?? this.getAttribute('id')) === selector.slice(1);
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1)) || (this.className ?? '').split(' ').includes(selector.slice(1));
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) return this.attributes.has(attribute[1]) && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]);
    return this.tagName === selector;
  }
  querySelector(selector) { return this.all().slice(1).find(node => selector.split(',').some(part => node.matches(part.trim()))) ?? null; }
  focus() { if (!this.disabled && this.isConnected) this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
}

function installGlobals(values) {
  const restore = [];
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restore.push(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  return () => { for (const reset of restore) reset(); };
}

function harness(t, options = {}) {
  const window = new Events();
  window.location = new URL('https://babel.test/transcription?reviewActionId=task-1');
  window.navigation = new Events();
  const document = new Events();
  document.createElement = tag => new ElementFixture(document, tag);
  document.documentElement = document.createElement('html');
  document.head = document.createElement('head');
  document.body = document.createElement('body');
  document.documentElement.append(document.head, document.body);
  document.activeElement = document.body;
  document.querySelector = selector => document.documentElement.querySelector(selector);
  Object.defineProperty(document, 'location', { get: () => window.location });
  const observers = new Set();
  const restoreGlobals = installGlobals({ window, document, HTMLElement: ElementFixture,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }
  });
  let native = { reviewActionId: 'task-1', readOnly: options.readOnly ?? false };
  document.documentElement.addEventListener('babel-helper:editor-control', event => {
    const request = JSON.parse(event.detail);
    assert.equal(request.operation, 'session', 'The UI reads native task identity, never transcript content');
    if (!native) return;
    document.documentElement.setAttribute('data-babel-helper-editor-result', JSON.stringify({
      id: request.id, ok: true, ...native, routeKey: window.location.pathname + window.location.search
    }));
  });
  const toolbar = document.createElement('div');
  const play = document.createElement('button');
  play.setAttribute('aria-label', 'Play all tracks');
  toolbar.append(play);
  const appearance = document.createElement('button');
  appearance.setAttribute('data-babel-helper-appearance-button', '');
  if (options.appearance !== false) toolbar.append(appearance);
  const other = document.createElement('button');
  toolbar.append(other);
  const surface = document.createElement('div');
  surface.setAttribute('data-transcript-scroll', '');
  if (options.classic) surface.setAttribute('data-babel-classic-editor', 'true');
  document.body.append(toolbar, surface);
  const calls = { prepare: [], apply: [], discard: [] };
  const helper = {
    settings: { features: { baselineReset: true } },
    state: { sessionLifecycleRevision: 1, nativeSessionAdmission: { reviewActionId: 'task-1', href: window.location.href } },
    runtime: { isSessionInteractive: () => Boolean(native && !native.readOnly) },
    async prepareBaselineReset(payload) { calls.prepare.push(payload); return options.prepare ? options.prepare(payload) : plan(); },
    async applyBaselineReset(payload) { calls.apply.push(payload); return options.apply ? options.apply(payload) : { ok: true }; },
    async discardBaselineReset(payload) { calls.discard.push(payload); return { ok: true }; }
  };
  const context = { helper };
  const feature = createBaselineResetFeature();
  feature.start(context);
  feature.activate(context);
  t.after(() => { try { feature.stop(); } finally { restoreGlobals(); } });
  const h = { window, document, toolbar, play, appearance, surface, context, feature, calls, observers,
    node: selector => document.querySelector(selector),
    get button() { return document.querySelector('[data-baseline-reset-button]'); },
    get host() { return document.querySelector('[data-babel-helper-baseline-reset]'); },
    get dialog() { return document.querySelector('dialog'); },
    get status() { return document.querySelector('[data-baseline-reset-status]'); },
    click() { h.button.focus(); h.button.dispatch('click'); },
    respond(confirmed) { h.dialog.querySelector('.bui-footer').children[confirmed ? 1 : 0].dispatch('click'); },
    mutate() { for (const observer of [...observers]) observer.callback([]); },
    setNative(value, publish = true) { native = value; if (publish) window.dispatch('babel-helper:native-session-change'); },
    switchTask(id, route = false) {
      native = { reviewActionId: id, readOnly: false };
      if (route) window.location = new URL(`https://babel.test/transcription?reviewActionId=${id}`);
      helper.state.sessionLifecycleRevision += 1;
      helper.state.nativeSessionAdmission = { reviewActionId: id, href: window.location.href };
      window.dispatch(route ? 'babel-helper:native-route-change' : 'babel-helper:native-session-change');
    }
  };
  return h;
}


test('reset control keeps keyboard events local and follows toolbar replacement', t => {
  const h = harness(t);
  assert.equal(h.appearance.nextSibling, h.host);
  assert.equal(h.button.dispatch('keydown', { key: 'Enter' }).stopped, true);
  assert.equal(h.button.dispatch('keyup', { key: 'Enter' }).stopped, true);
  const replacement = h.document.createElement('div');
  h.toolbar.remove();
  replacement.append(h.play, h.appearance);
  h.document.body.append(replacement);
  h.mutate();
  assert.equal(h.host.parentElement, replacement);
  assert.equal(h.appearance.nextSibling, h.host);
  assert.equal(h.calls.prepare.length, 0);
});

test('native toolbar fallback mounts without another extension and follows a late Theme control', t => {
  const h = harness(t, { appearance: false });
  assert.equal(h.host.parentElement, h.toolbar);
  h.toolbar.append(h.appearance);
  h.mutate();
  assert.equal(h.appearance.nextSibling, h.host);
});

test('preparation is authoritative and read-only; duplicate clicks and cancel cannot apply', async t => {
  const preparation = Promise.withResolvers();
  const h = harness(t, { prepare: () => preparation.promise });
  h.click();
  h.click();
  assert.equal(h.calls.prepare.length, 1);
  assert.deepEqual(h.calls.prepare[0], { expectedReviewActionId: 'task-1' });
  assert.equal(h.button.disabled, true);
  assert.equal(h.button.getAttribute('aria-busy'), 'true');
  assert.equal(h.dialog, null);
  preparation.resolve(plan({ level: 0, segmentCount: 1 }));
  await settle();
  assert.match(h.dialog.textContent, /Reset to L0/);
  assert.match(h.dialog.textContent, /1 segment from L0/);
  assert.match(h.dialog.textContent, /all current segments/);
  assert.match(h.dialog.textContent, /Undo/);
  assert.match(h.dialog.textContent, /does not save or submit/);
  assert.match(h.dialog.textContent, /normal listening and submission rules/);
  assert.equal(h.document.activeElement.textContent, 'Cancel');
  assert.equal(h.calls.apply.length, 0);
  h.respond(false);
  await settle();
  assert.equal(h.dialog, null);
  assert.equal(h.calls.apply.length, 0);
  assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
  assert.equal(h.button.disabled, false);
  assert.equal(h.document.activeElement, h.button);
  assert.equal(h.status, null);
});

for (const classic of [false, true]) {
  test(`${classic ? 'Classic' : 'native'} empty transcript applies once and reports success only after native commit`, async t => {
    const application = Promise.withResolvers();
    const h = harness(t, { classic, apply: () => application.promise });
    assert.equal(h.surface.children.length, 0, 'No surviving rows are required');
    h.click();
    await settle();
    assert.match(h.dialog.textContent, /3 segments from L1/);
    h.respond(true);
    await settle();
    assert.deepEqual(h.calls.apply, [{ token: 'plan-1', expectedReviewActionId: 'task-1' }]);
    assert.equal(h.button.disabled, true);
    assert.doesNotMatch(h.status.textContent, /Restored/);
    h.click();
    assert.equal(h.calls.prepare.length, 1);
    application.resolve({ ok: true });
    await settle();
    assert.match(h.status.textContent, /Restored 3 segments from L1/);
    assert.match(h.status.textContent, /Undo/);
    assert.match(h.status.textContent, /Not saved or submitted/);
    assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
    assert.equal(h.button.disabled, false);
    assert.equal(h.button.getAttribute('aria-busy'), 'false');
    h.node('[data-baseline-reset-dismiss]').dispatch('click');
    assert.equal(h.status, null);
    assert.equal(h.document.activeElement, h.button);
  });
}

for (const missing of ['prepareBaselineReset', 'applyBaselineReset', 'discardBaselineReset']) {
  test(`missing ${missing} produces a dismissible failure, not a mock reset`, t => {
    const h = harness(t);
    delete h.context.helper[missing];
    h.click();
    assert.match(h.status.textContent, /unavailable/);
    assert.equal(h.status.getAttribute('data-tone'), 'danger');
    assert.equal(h.calls.prepare.length, 0);
    assert.equal(h.calls.apply.length, 0);
    h.node('[data-baseline-reset-dismiss]').dispatch('click');
    assert.equal(h.status, null);
  });
}

for (const [name, prepare] of [
  ['unavailable baseline', () => ({ ok: false, reason: 'baseline-unavailable', message: 'No L1 or L0 baseline is available.' })],
  ['L1 network failure', () => { throw new Error('L1 could not be loaded.'); }],
  ['invalid level', () => plan({ level: 2 })],
  ['wrong task', () => plan({ reviewActionId: 'task-other' })],
  ['current action as source', () => plan({ baselineReviewActionId: 'task-1' })],
  ['invalid count', () => plan({ segmentCount: -1 })],
  ['missing bridge result', () => null]
]) {
  test(`${name} remains a visible failure with no L0 retry`, async t => {
    const h = harness(t, { prepare });
    h.click();
    await settle();
    assert.equal(h.dialog, null);
    assert.equal(h.calls.prepare.length, 1);
    assert.equal(h.calls.apply.length, 0);
    assert.equal(h.status.getAttribute('data-tone'), 'danger');
    assert.doesNotMatch(h.status.textContent, /Restored/);
    assert.equal(h.button.disabled, false);
    if (['invalid level', 'wrong task', 'current action as source', 'invalid count'].includes(name)) {
      assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
    }
  });
}

test('apply failure releases the prepared plan and never reports success', async t => {
  const h = harness(t, { apply: () => ({ ok: false, reason: 'source-changed', message: 'The transcript changed. Prepare the reset again.' }) });
  h.click();
  await settle();
  h.respond(true);
  await settle();
  assert.match(h.status.textContent, /transcript changed/);
  assert.equal(h.status.getAttribute('data-tone'), 'danger');
  assert.doesNotMatch(h.status.textContent, /Restored/);
  assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
});

for (const outcome of ['route', 'same-url-task', 'readonly', 'missing-native', 'disable', 'pagehide', 'bridge-teardown', 'stop', 'revision', 'root-admission']) {
  test(`${outcome} aborts an open confirmation and discards exactly once`, async t => {
    const h = harness(t);
    h.click();
    await settle();
    const dialog = h.dialog;
    assert.ok(dialog);
    if (outcome === 'route') h.switchTask('task-2', true);
    if (outcome === 'same-url-task') h.switchTask('task-2');
    if (outcome === 'readonly') h.setNative({ reviewActionId: 'task-1', readOnly: true });
    if (outcome === 'missing-native') h.setNative(null);
    if (outcome === 'disable') { h.context.helper.settings.features.baselineReset = false; h.window.dispatch('babel-mods:controller'); }
    if (outcome === 'pagehide') h.window.dispatch('pagehide');
    if (outcome === 'bridge-teardown') h.window.dispatch('babel-helper-bridge-teardown');
    if (outcome === 'stop') h.feature.stop();
    if (outcome === 'revision') { h.context.helper.state.sessionLifecycleRevision += 1; h.window.dispatch('babel-helper:native-session-change'); }
    if (outcome === 'root-admission') {
      h.context.helper.state.nativeSessionAdmission = { ...h.context.helper.state.nativeSessionAdmission };
      h.window.dispatch('babel-helper:native-session-change');
    }
    assert.equal(h.dialog, null, 'Cancellation closes the modal synchronously');
    dialog.querySelector('.bui-footer').children[1].dispatch('click');
    await settle();
    assert.equal(h.calls.apply.length, 0);
    assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
    assert.equal(h.status, null);
  });
}

test('task identity is checked again after dialog acceptance even without a lifecycle event', async t => {
  const h = harness(t);
  h.click();
  await settle();
  h.setNative({ reviewActionId: 'task-2', readOnly: false }, false);
  h.respond(true);
  await settle();
  assert.equal(h.calls.apply.length, 0);
  assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
  assert.equal(h.button.disabled, true);
});

test('late preparation from an abandoned task is discarded without touching the next task modal', async t => {
  const preparation = Promise.withResolvers();
  let first = true;
  const h = harness(t, { prepare: payload => {
    if (first) { first = false; return preparation.promise; }
    return plan({ reviewActionId: payload.expectedReviewActionId, token: 'plan-2' });
  } });
  h.click();
  h.switchTask('task-2');
  h.click();
  await settle();
  const nextDialog = h.dialog;
  assert.ok(nextDialog);
  preparation.resolve(plan());
  await settle();
  assert.equal(h.dialog, nextDialog);
  assert.equal(h.button.disabled, true);
  assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
  h.respond(false);
  await settle();
  assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }, { token: 'plan-2' }]);
  assert.equal(h.calls.apply.length, 0);
});

test('feature stop during preparation releases its late plan without creating UI', async t => {
  const preparation = Promise.withResolvers();
  const h = harness(t, { prepare: () => preparation.promise });
  h.click();
  h.feature.stop();
  assert.equal(h.observers.size, 0);
  assert.equal(h.host, null);
  assert.equal(h.status, null);
  preparation.resolve(plan());
  await settle();
  assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
  assert.equal(h.dialog, null);
  assert.equal(h.calls.apply.length, 0);
  for (const listeners of h.window.listeners.values()) assert.equal(listeners.size, 0);
  assert.equal(h.window.navigation.listeners.get('currententrychange').size, 0);
});

test('task switch during native apply discards the plan and suppresses late success', async t => {
  const application = Promise.withResolvers();
  const h = harness(t, { apply: () => application.promise });
  h.click();
  await settle();
  h.respond(true);
  await settle();
  h.switchTask('task-2');
  assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
  application.resolve({ ok: true });
  await settle();
  assert.equal(h.status, null);
  assert.equal(h.button.disabled, false);
  assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
});

test('readonly and unadmitted tasks cannot prepare, and teardown can reactivate cleanly', t => {
  const h = harness(t, { readOnly: true });
  h.click();
  assert.equal(h.button.disabled, true);
  assert.equal(h.calls.prepare.length, 0);
  h.setNative({ reviewActionId: 'task-1', readOnly: false });
  h.context.helper.state.nativeSessionAdmission = null;
  h.click();
  assert.equal(h.calls.prepare.length, 0);
  h.feature.deactivate();
  assert.equal(h.host, null);
  h.context.helper.state.nativeSessionAdmission = { reviewActionId: 'task-1', href: h.window.location.href };
  h.feature.activate(h.context);
  assert.equal(h.button.disabled, false);
  assert.equal(h.observers.size, 1);
  assert.equal(h.appearance.nextSibling, h.host);
});

test('Escape cancellation uses the shared dialog and releases the native plan', async t => {
  const h = harness(t);
  h.click();
  await settle();
  assert.equal(h.dialog.dispatch('cancel').defaultPrevented, true);
  await settle();
  assert.equal(h.dialog, null);
  assert.equal(h.calls.apply.length, 0);
  assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
  assert.equal(h.document.activeElement, h.button);
});

for (const event of ['popstate', 'hashchange', 'currententrychange']) {
  test(`${event} cancels confirmation before route re-admission`, async t => {
    const h = harness(t);
    h.click();
    await settle();
    h.window.location = new URL('https://babel.test/transcription?reviewActionId=task-2');
    (event === 'currententrychange' ? h.window.navigation : h.window).dispatch(event);
    assert.equal(h.dialog, null);
    await settle();
    assert.equal(h.calls.apply.length, 0);
    assert.deepEqual(h.calls.discard, [{ token: 'plan-1' }]);
    assert.equal(h.button.disabled, true);
  });
}

test('a failed native discard is visible and dismissible without automatic retry', async t => {
  const h = harness(t);
  h.context.helper.discardBaselineReset = async payload => {
    h.calls.discard.push(payload);
    return { ok: false, reason: 'baseline-service-unavailable' };
  };
  h.click();
  await settle();
  h.respond(false);
  await settle();
  assert.equal(h.calls.discard.length, 1);
  assert.match(h.status.textContent, /could not be released/);
  assert.equal(h.status.getAttribute('data-tone'), 'danger');
  h.node('[data-baseline-reset-dismiss]').dispatch('click');
  assert.equal(h.status, null);
});
