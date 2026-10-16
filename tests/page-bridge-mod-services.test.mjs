import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { registerBabelClassicInput } from '../../shared/babel-extension-platform/packages/babel-babel-runtime/src/index.mjs';

class TestEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
    this.target = init.target ?? null;
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }
}

class TestEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener)
    );
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      if (typeof listener === 'function') listener.call(this, event);
      else listener.handleEvent(event);
    }
    return !event.defaultPrevented;
  }
}

class TestElement extends TestEventTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.style = { removeProperty(name) { delete this[name]; }, setProperty(name, value) { this[name] = value; } };
    this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(" "); } };
    this.dataset = {};
    this.children = [];
    this.isConnected = false;
    this.className = '';
    this.textContent = '';
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }

  getAttribute(name) { return this[name] ?? null; }
  removeAttribute(name) { delete this[name]; }

  appendChild(child) {
    this.children.push(child);
    child.isConnected = true;
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  remove() {
    this.isConnected = false;
    this.removed = true;
  }

  matches() {
    return false;
  }

  closest() {
    return null;
  }

  querySelector() {
    return null;
  }

  focus() {}
}

class TestTextArea extends TestElement {
  constructor() {
    super('textarea');
    this.value = '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.selectionDirection = 'none';
  }

  setSelectionRange(start, end, direction = 'none') {
    this.selectionEnd = Math.min(end, this.value.length);
    this.selectionStart = Math.min(start, this.selectionEnd);
    this.selectionDirection = direction;
  }
}

class TestTableRow extends TestElement {}

class TestDocument extends TestEventTarget {
  constructor() {
    super();
    this.body = new TestElement('body');
    this.body.isConnected = true;
    this.documentElement = new TestElement('html');
    this.activeElement = null;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  createElement(tagName) {
    return tagName === 'textarea' ? new TestTextArea() : new TestElement(tagName);
  }

  createDocumentFragment() {
    return new TestElement('fragment');
  }

  execCommand() {
    return true;
  }
}

function createServiceHarness() {
  const providers = new Map();
  const replacements = new Map();
  const decorators = new Map();
  const provided = [];
  const invocations = [];

  const services = {
    provide(id, implementation, options) {
      if (providers.has(id)) throw new Error(`duplicate provider: ${id}`);
      const record = { id, implementation, options, disposed: false };
      providers.set(id, implementation);
      provided.push(record);
      return {
        dispose() {
          if (record.disposed) return;
          record.disposed = true;
          if (providers.get(id) === implementation) providers.delete(id);
        }
      };
    },
    replace(id, implementation) {
      replacements.set(id, implementation);
      return {
        dispose() {
          if (replacements.get(id) === implementation) replacements.delete(id);
        }
      };
    },
    decorate(id, decorator) {
      const entries = decorators.get(id) ?? [];
      entries.push(decorator);
      decorators.set(id, entries);
      return {
        dispose() {
          decorators.set(
            id,
            (decorators.get(id) ?? []).filter((entry) => entry !== decorator)
          );
        }
      };
    },
    invoke(id, method, ...args) {
      invocations.push({ id, method, args });
      let service = replacements.get(id) ?? providers.get(id);
      if (!service) throw new Error(`missing service: ${id}`);
      for (const decorator of decorators.get(id) ?? []) service = decorator(service);
      const operation = service[method];
      if (typeof operation !== 'function') throw new TypeError(`missing operation: ${id}.${method}`);
      return operation.apply(service, args);
    }
  };

  return { services, provided, invocations };
}

function installPageEnvironment() {
  const window = new TestEventTarget();
  const document = new TestDocument();
  const observers = [];
  window.window = window;
  window.document = document;
  window.location = { href: 'https://babel.test/transcription?id=fixture', pathname: '/transcription', search: '?id=fixture' };
  window.navigation = new TestEventTarget();
  window.history = { pushState() {}, replaceState() {} };
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;

  const values = {
    window,
    document,
    Element: TestElement,
    HTMLElement: TestElement,
    HTMLTextAreaElement: TestTextArea,
    HTMLTableRowElement: TestTableRow,
    Event: TestEvent,
    CustomEvent: TestEvent,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
    InputEvent: TestEvent,
    KeyboardEvent: TestEvent,
    MouseEvent: TestEvent,
    FocusEvent: TestEvent,
    Request: class Request {},
    Response: class Response {}
  };
  for (const [key, value] of Object.entries(values)) globalThis[key] = value;
  return { window, document, observers };
}

async function importBundledBridge(relativeEntry) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-helper-page-bridge-'));
  const outfile = path.join(tempDir, `${path.basename(relativeEntry, '.ts')}-${Date.now()}.mjs`);
  await build({
    entryPoints: [path.resolve(relativeEntry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent'
  });
  try {
    return await import(`${pathToFileURL(outfile).href}?${Math.random()}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('recovered editor legacy calls resolve the live mod service and dispose its provider', async () => {
  const { window } = installPageEnvironment();
  const harness = createServiceHarness();
  window.BabelMods = { unsafe: { services: harness.services } };

  await importBundledBridge('src/content/recovered-editor-bridge.ts');

  assert.equal(harness.provided.length, 1);
  const provider = harness.provided[0];
  assert.equal(provider.id, 'page.recoveredEditor');
  assert.equal(provider.options.owner, 'builtin:recovered-editor');
  assert.equal(Object.isFrozen(provider.implementation), false);
  assert.equal(Object.isFrozen(provider.implementation.raw), false);
  assert.equal(window.__babelHelperRecoveredEditorBridge.implementation, provider.implementation.raw);

  const replacement = {
    ...provider.implementation,
    getEditorSnapshot() {
      return { source: 'replacement' };
    },
    applyExtendedDiffState(payload) {
      return { ok: true, source: 'replacement', payload };
    }
  };
  const replacementHandle = harness.services.replace('page.recoveredEditor', replacement);
  const decoratedCalls = [];
  const decoratorHandle = harness.services.decorate('page.recoveredEditor', (next) => ({
    ...next,
    getEditorSnapshot() {
      decoratedCalls.push(this);
      return { ...next.getEditorSnapshot(), decorated: true };
    }
  }));

  assert.deepEqual(window.__babelHelperRecoveredEditorBridge.getEditorSnapshot(), {
    source: 'replacement',
    decorated: true
  });
  const payload = { textMode: 'reference' };
  assert.deepEqual(window.__babelHelperRecoveredEditorBridge.applyExtendedDiffState(payload), {
    ok: true,
    source: 'replacement',
    payload
  });

  let response = null;
  window.addEventListener('babel-helper-recovered-editor-response', (event) => {
    response = event.detail;
  });
  window.dispatchEvent(
    new TestEvent('babel-helper-recovered-editor-request', {
      detail: { id: 'request-1', operation: 'snapshot' }
    })
  );
  assert.deepEqual(response, {
    id: 'request-1',
    result: { ok: true, snapshot: { source: 'replacement', decorated: true } }
  });
  assert.equal(decoratedCalls.length, 2);

  decoratorHandle.dispose();
  replacementHandle.dispose();
  window.__babelHelperRecoveredEditorBridge.dispose();
  assert.equal(provider.disposed, true);
  assert.equal(window.__babelHelperRecoveredEditorBridge, undefined);
});

test('quick autocomplete toggle and bound DOM handlers resolve the live mod service', async () => {
  const { window, document } = installPageEnvironment();
  const harness = createServiceHarness();
  window.BabelMods = { unsafe: { services: harness.services } };

  await importBundledBridge('src/content/quick-region-autocomplete-bridge.ts');

  assert.equal(harness.provided.length, 1);
  const provider = harness.provided[0];
  assert.equal(provider.id, 'page.quickRegionAutocomplete');
  assert.equal(provider.options.owner, 'builtin:quick-region-autocomplete');
  assert.equal(Object.isFrozen(provider.implementation), false);
  assert.equal(Object.isFrozen(provider.implementation.raw), false);
  assert.equal(window.__babelHelperQuickRegionAutocompleteBridge.implementation, provider.implementation.raw);

  const keyEvents = [];
  const decoratorHandle = harness.services.decorate('page.quickRegionAutocomplete', (next) => ({
    ...next,
    handleKeyDown(event) {
      keyEvents.push(event);
      return 'decorated-keydown';
    }
  }));

  assert.equal(window.__babelHelperQuickRegionAutocompleteBridge.setEnabled(true), true);
  const keyEvent = new TestEvent('keydown', { key: 'Enter' });
  document.dispatchEvent(keyEvent);
  assert.deepEqual(keyEvents, [keyEvent]);

  const replacementCalls = [];
  const replacementHandle = harness.services.replace('page.quickRegionAutocomplete', {
    ...provider.implementation,
    setEnabled(value) {
      replacementCalls.push(value);
      return `replacement:${value}`;
    }
  });
  window.dispatchEvent(
    new TestEvent('babel-helper-quick-region-autocomplete-toggle', {
      detail: { enabled: false }
    })
  );
  assert.deepEqual(replacementCalls, [false]);
  assert.equal(window.__babelHelperQuickRegionAutocompleteBridge.setEnabled(true), 'replacement:true');
  assert.deepEqual(replacementCalls, [false, true]);

  replacementHandle.dispose();
  decoratorHandle.dispose();
  const listbox = document.body.children[0];
  window.__babelHelperQuickRegionAutocompleteBridge.dispose();
  assert.equal(provider.disposed, true);
  assert.equal(listbox.removed, true);
  assert.equal(window.__babelHelperQuickRegionAutocompleteBridge, undefined);
});

async function createAutocompleteRestoreHarness(t) {
  const { window, document } = installPageEnvironment();
  const frames = new Map();
  let nextFrame = 0;
  window.requestAnimationFrame = (callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  await importBundledBridge('src/content/quick-region-autocomplete-bridge.ts');
  const bridge = window.__babelHelperQuickRegionAutocompleteBridge;
  t.after(() => bridge.dispose());
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  textarea.focus = () => { document.activeElement = textarea; };
  textarea.focus();
  const expectedValue = '<emphasis> word </emphasis> tail';
  const expectedCaret = '<emphasis> word </emphasis>'.length;
  return {
    window, document, textarea, expectedValue, expectedCaret, frames,
    wrap() {
      textarea.value = 'word tail';
      textarea.setSelectionRange(0, 4);
      const raw = bridge.implementation;
      raw.state.suggestions = [{ label: 'emphasis', insertText: '<emphasis> </emphasis>', type: 'style' }];
      raw.contextState.current = {
        owner: textarea,
        route: window.location.pathname + window.location.search,
        context: { type: 'style', open: '<', close: '>' },
        partial: '',
        triggerIndex: 0,
        cursorPosition: 0,
        fullText: textarea.value,
        wrapSelection: {
          textarea, fullText: textarea.value, selectionStart: 0, selectionEnd: 4, selectedText: 'word'
        }
      };
      assert.equal(raw.insertSuggestion(textarea, 0), true);
    },
    runFrames() {
      while (frames.size) {
        const pending = [...frames];
        frames.clear();
        for (const [, callback] of pending) callback();
      }
    }
  };
}

test('autocomplete restoration leaves a subsequent select-all intact before selection events arrive', async (t) => {
  const harness = await createAutocompleteRestoreHarness(t);
  const { textarea, expectedValue, expectedCaret } = harness;
  harness.wrap();
  assert.equal(textarea.value, expectedValue);
  assert.equal(textarea.selectionStart, expectedCaret);
  textarea.setSelectionRange(0, textarea.value.length);
  harness.runFrames();
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, expectedValue.length);
  textarea.value = textarea.value.slice(0, textarea.selectionStart) + textarea.value.slice(textarea.selectionEnd);
  assert.equal(textarea.value, '', 'the following replacement consumes the entire wrapped value');
});

test('autocomplete restoration cancels queued work on new editing and focus intent', async (t) => {
  const harness = await createAutocompleteRestoreHarness(t);
  const { document, textarea, expectedValue, frames } = harness;
  textarea.addEventListener('input', () => {
    textarea.value = 'word tail';
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  for (const type of ['keydown', 'pointerdown', 'beforeinput', 'input', 'focusout']) {
    harness.wrap();
    const staleCallbacks = [...frames.values()];
    document.dispatchEvent(new TestEvent(type, { target: textarea, key: 'ArrowLeft' }));
    textarea.value = expectedValue;
    textarea.setSelectionRange(expectedValue.length, expectedValue.length);
    const nextFocus = type === 'focusout' ? document.createElement('button') : textarea;
    document.activeElement = nextFocus;
    assert.equal(frames.size, 0, `${type} cancels the scheduled frame`);
    for (const callback of staleCallbacks) callback();
    assert.equal(document.activeElement, nextFocus, `${type} cannot steal focus`);
    assert.equal(textarea.selectionStart, expectedValue.length, `${type} cannot overwrite the next caret`);
  }
});

test('deferred autocomplete repair yields to selection intent before its queued event', async (t) => {
  const harness = await createAutocompleteRestoreHarness(t);
  const { textarea, expectedValue, frames } = harness;
  textarea.addEventListener('input', () => {
    textarea.value = 'word tail';
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  harness.wrap();
  const staleCallbacks = [...frames.values()];
  textarea.setSelectionRange(0, textarea.value.length);
  harness.runFrames();
  assert.equal(textarea.selectionStart, 0);
  assert.equal(textarea.selectionEnd, 'word tail'.length);
  textarea.value = expectedValue;
  textarea.setSelectionRange(expectedValue.length, expectedValue.length);
  for (const callback of staleCallbacks) callback();
  assert.equal(textarea.selectionStart, expectedValue.length, 'a later commit cannot revive the cancelled restore');
});

test('autocomplete ignores its queued selection events and repairs a deferred controlled commit', async (t) => {
  const harness = await createAutocompleteRestoreHarness(t);
  const { document, textarea, expectedValue, expectedCaret, frames } = harness;
  // A controlled input can first restore its old value during input dispatch,
  // then commit the intended value on the next render, resetting the caret.
  textarea.addEventListener('input', () => {
    textarea.value = 'word tail';
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  });
  harness.wrap();
  assert.equal(textarea.value, 'word tail');
  document.dispatchEvent(new TestEvent('select', { target: textarea }));
  document.dispatchEvent(new TestEvent('selectionchange'));
  textarea.value = expectedValue;
  textarea.setSelectionRange(expectedValue.length, expectedValue.length);
  document.dispatchEvent(new TestEvent('selectionchange'));
  harness.runFrames();
  assert.equal(textarea.value, expectedValue);
  assert.equal(textarea.selectionStart, expectedCaret);
  assert.equal(textarea.selectionEnd, expectedCaret);
  assert.equal(frames.size, 0);
});

for (const [entry, factory, toggle] of [
  ['src/features/quick-region-autocomplete-feature.ts', 'createQuickRegionAutocompleteFeature', 'babel-helper-quick-region-autocomplete-toggle'],
  ['src/features/custom-linter/feature.ts', 'createCustomLinterFeature', 'babel-helper-linter-bridge-toggle']
]) {
  test(`${factory}: disabling during script load cannot resurrect the feature`, async () => {
    const { window, document } = installPageEnvironment();
    globalThis.chrome = { runtime: { getURL: (value) => `chrome-extension://test/${value}` } };
    const module = await importBundledBridge(entry);
    const feature = module[factory]();
    const context = { helper: { settings: {} }, logger: { warn() {} } };
    const toggles = [];
    window.addEventListener(toggle, (event) => toggles.push(event.detail.enabled));
    feature.start?.(context);
    const loading = feature.onLoaded(context);
    const script = document.documentElement.children.at(-1);
    assert.equal(typeof script.onload, 'function', 'the actual injection is still pending');
    feature.deactivate(context);
    script.onload();
    await loading;
    assert.deepEqual(toggles, [false]);
    await feature.activate(context, 'settings');
    assert.deepEqual(toggles, [false, true]);
    feature.stop(context);
    assert.deepEqual(toggles, [false, true, false]);
  });
}

test('quick autocomplete refuses a stale suggestion after text, task, ownership, or readonly changes', async (t) => {
  const { window, document } = installPageEnvironment();
  await importBundledBridge('src/content/quick-region-autocomplete-bridge.ts');
  const bridge = window.__babelHelperQuickRegionAutocompleteBridge;
  t.after(() => bridge.dispose());
  const owner = document.createElement('textarea');
  const other = document.createElement('textarea');
  document.body.appendChild(owner);
  document.body.appendChild(other);
  const raw = bridge.implementation;
  for (const boundary of ['text', 'route', 'owner', 'readonly', 'disconnected']) {
    owner.isConnected = true;
    owner.readOnly = false;
    owner.value = other.value = '<em';
    window.location.search = '?id=first';
    raw.state.suggestions = [{ label: 'emphasis', insertText: '<emphasis> </emphasis>', type: 'style' }];
    raw.contextState.current = {
      owner, route: window.location.pathname + window.location.search,
      context: { type: 'style', open: '<', close: '>' },
      fullText: owner.value, triggerIndex: 0, cursorPosition: owner.value.length, wrapSelection: null
    };
    if (boundary === 'text') owner.value = 'newer text';
    if (boundary === 'route') window.location.search = '?id=second';
    if (boundary === 'readonly') owner.readOnly = true;
    if (boundary === 'disconnected') owner.isConnected = false;
    const target = boundary === 'owner' ? other : owner;
    const before = target.value;
    assert.equal(raw.insertSuggestion(target, 0), false, boundary);
    assert.equal(target.value, before, boundary);
  }
});

test('extended diff reads the native comparison switch, never reviewer visibility or stale body text', async () => {
  const { document } = installPageEnvironment();
  const { isDiffViewEnabled } = await importBundledBridge('src/features/extended-diff-view-feature.ts');
  const reviewers = { getAttribute: () => 'true' };
  let checked = 'false';
  const comparison = { getAttribute: () => checked };
  document.body.innerText = 'Show Reviewers Compare: L1';
  document.querySelector = (selector) => selector.includes('#diff-mode') ? comparison : reviewers;
  assert.equal(isDiffViewEnabled(), false);
  checked = 'true';
  assert.equal(isDiffViewEnabled(), true);
  document.querySelector = (selector) => selector === '[role=\"switch\"]' ? reviewers : null;
  assert.equal(isDiffViewEnabled(), false, 'unmounted task controls do not inherit another switch');
});

function nativeSessionTree(task = 'task-a') {
  const transcript = { memoizedProps: { turns: [], editingId: null,
    handlers: { onActivate() {}, onDeactivate() {}, onSelect() {}, onChangeText() {} }, readOnly: false } };
  const panel = { memoizedProps: { annotations: [], saveState: {}, renderTranscript() {}, onSave() {} }, child: transcript };
  const editor = { memoizedProps: { reviewActionId: task, transcriptionChunkProcessedRecordings: [] }, child: panel };
  const root = { child: editor };
  const host = { current: root };
  root.stateNode = host;
  editor.return = root;
  panel.return = editor;
  transcript.return = panel;
  const surface = new TestElement();
  surface.isConnected = true;
  surface.__reactFiber$test = editor;
  surface.matches = selector => selector.includes('[data-transcript-scroll]');
  return { editor, panel, root, host, transcript, seed: surface, surface };
}

test('native commit publisher observes unchanged DOM task/permission transitions and owns root replacement lifetime', async () => {
  const { window, document, observers } = installPageEnvironment();
  let tree = nativeSessionTree();
  document.querySelector = () => tree.surface;
  document.querySelectorAll = () => [tree.seed];
  const events = [];
  window.addEventListener('babel-helper:native-session-change', event => events.push(JSON.parse(event.detail)));
  await importBundledBridge('src/content/recovered-editor-bridge.ts');
  assert.equal(events.at(-1).status, 'ready');
  assert.equal(events.at(-1).reviewActionId, 'task-a');
  tree.editor.memoizedProps.reviewActionId = 'task-b';
  tree.transcript.memoizedProps.readOnly = true;
  tree.host.current = tree.root;
  await Promise.resolve();
  assert.equal(events.at(-1).reviewActionId, 'task-b');
  assert.equal(events.at(-1).readOnly, true);
  const old = tree, generation = events.at(-1).generation;
  tree = nativeSessionTree('task-b');
  tree.transcript.memoizedProps.readOnly = true;
  old.surface.isConnected = false;
  observers[0].callback([{ type: 'childList', addedNodes: [tree.surface], removedNodes: [old.surface] }]);
  await Promise.resolve();
  assert.ok(events.at(-1).generation > generation, 'same-task root replacement publishes a new binding identity');
  assert.equal(Object.getOwnPropertyDescriptor(old.host, 'current').value, old.root);
  const count = events.length;
  old.editor.memoizedProps.reviewActionId = 'stale-task';
  old.host.current = old.root;
  await Promise.resolve();
  assert.equal(events.length, count, 'detached root callbacks cannot publish stale task authority');
  tree.transcript.memoizedProps.readOnly = false;
  tree.host.current = tree.root;
  await Promise.resolve();
  assert.equal(events.at(-1).readOnly, false);
  window.__babelHelperRecoveredEditorBridge.dispose();
  assert.equal(observers[0].disconnected, true);
  assert.equal(Object.getOwnPropertyDescriptor(tree.host, 'current').value, tree.root);
  assert.equal(document.documentElement.getAttribute('data-babel-helper-native-session'), null,
    'teardown removes the publication owned by this bridge');
});

test('Classic identity and batched row reads do not touch owned text or selection and commits publish semantic revisions', async t => {
  const { window, document } = installPageEnvironment(), tree = nativeSessionTree();
  const annotation = { id: 'classic-one', processedRecordingId: 'a', startTimeInSeconds: 1,
    endTimeInSeconds: 4, content: 'Committed', type: 'transcription' };
  tree.panel.memoizedProps.annotations = [annotation];
  tree.panel.memoizedProps.tracks = [{ id: 'a', label: 'First' }];
  tree.transcript.memoizedProps.turns = [annotation];
  document.querySelector = () => tree.surface;
  document.querySelectorAll = () => [tree.seed];
  const commits = [];
  window.addEventListener('babel-helper:native-editor-commit', event => commits.push(JSON.parse(event.detail)));
  await importBundledBridge('src/content/recovered-editor-bridge.ts');
  t.after(() => window.__babelHelperRecoveredEditorBridge?.dispose());
  const row = new TestTableRow();
  row.ownerDocument = document;
  row.isConnected = true;
  row.setAttribute('data-annotation-id', annotation.id);
  row.setAttribute('data-babel-classic-row', 'true');
  row.closest = () => row;
  const handlers = tree.transcript.memoizedProps.handlers;
  tree.transcript.child = { memoizedProps: { turn: annotation, handlers },
    child: { memoizedProps: {}, stateNode: row } };
  const release = registerBabelClassicInput(row, { annotation, reviewActionId: 'task-a', handlers,
    readOnly: false, read() { assert.fail('Identity cannot read Classic pending text or selection'); } });
  t.after(release);
  const request = (target, operation) => {
    window.dispatchEvent(new TestEvent('babel-helper:editor-control', { target,
      detail: JSON.stringify({ id: operation, operation, annotationId: annotation.id }) }));
    return JSON.parse(target.getAttribute('data-babel-helper-editor-result'));
  };
  const identity = request(row, 'identity');
  assert.equal(identity.ok, true);
  assert.equal(identity.startSeconds, 1);
  for (const field of ['text', 'start', 'end', 'direction']) assert.equal(field in identity, false);
  const initial = request(document.documentElement, 'identities');
  assert.equal(initial.identities.length, 1);
  tree.transcript.memoizedProps.activeIds = new Set([annotation.id]);
  tree.transcript.memoizedProps.editingId = annotation.id;
  tree.host.current = tree.root;
  await Promise.resolve();
  assert.equal(commits.at(-1).annotationRevision, initial.annotationRevision);
  assert.deepEqual(commits.at(-1).activeIds, [annotation.id]);
  annotation.startTimeInSeconds = 2;
  tree.host.current = tree.root;
  await Promise.resolve();
  const edited = request(document.documentElement, 'identities');
  assert.ok(edited.annotationRevision > initial.annotationRevision);
  assert.equal(edited.identities[0].startSeconds, 2);
});

test('native session publisher waits for DOM mount but reports an unsupported mounted hook explicitly', async () => {
  const { window, document, observers } = installPageEnvironment();
  let tree = null;
  document.querySelector = () => tree?.surface || null;
  document.querySelectorAll = () => tree ? [tree.seed] : [];
  const events = [];
  window.addEventListener('babel-helper:native-session-change', event => events.push(JSON.parse(event.detail)));
  await importBundledBridge('src/content/recovered-editor-bridge.ts');
  assert.equal(events.at(-1).status, 'unmounted');
  tree = nativeSessionTree();
  Object.defineProperty(tree.host, 'current', { configurable: false });
  observers[0].callback([{ type: 'childList', addedNodes: [tree.surface], removedNodes: [] }]);
  await Promise.resolve();
  assert.equal(events.at(-1).status, 'error');
  assert.match(events.at(-1).error, /configurable writable/);
  const count = events.length;
  const unrelated = new TestElement();
  for (let index = 0; index < 10; index++) {
    observers[0].callback([{ type: 'childList', addedNodes: [unrelated], removedNodes: [] }]);
  }
  await Promise.resolve();
  assert.equal(events.length, count, 'unrelated DOM cannot restart failed hook installation');
  window.__babelHelperRecoveredEditorBridge.dispose();
});

test('unrelated childList churn does not rediscover or republish native sessions; native commits still publish', async t => {
  const { window, document, observers } = installPageEnvironment();
  const tree = nativeSessionTree();
  let surfaceReads = 0, fiberSearches = 0;
  document.querySelector = () => { surfaceReads++; return tree.surface; };
  document.querySelectorAll = () => { fiberSearches++; return [tree.seed]; };
  const sessions = [], commits = [];
  window.addEventListener('babel-helper:native-session-change', event => sessions.push(event.detail));
  window.addEventListener('babel-helper:native-editor-commit', event => commits.push(event.detail));
  await importBundledBridge('src/content/recovered-editor-bridge.ts');
  t.after(() => window.__babelHelperRecoveredEditorBridge?.dispose());
  const before = { surfaceReads, fiberSearches, sessions: sessions.length, commits: commits.length };
  const unrelated = new TestElement();
  for (let index = 0; index < 30; index++) {
    observers[0].callback([{ type: 'childList', target: tree.surface,
      addedNodes: [unrelated], removedNodes: [unrelated] }]);
    await Promise.resolve();
  }
  assert.equal(surfaceReads, before.surfaceReads, 'highlight/overlay text churn does not query the document');
  assert.equal(fiberSearches, before.fiberSearches, 'unrelated DOM does not rediscover native task authority');
  assert.equal(sessions.length, before.sessions);
  assert.equal(commits.length, before.commits);
  tree.host.current = tree.root;
  await Promise.resolve();
  assert.equal(sessions.length, before.sessions, 'unchanged native access is not republished');
  assert.equal(commits.length, before.commits + 1, 'editing consumers still receive every committed update');
  assert.equal(commits.at(-1), commits.at(-2));
});

test('same-surface same-URL React root replacement is coalesced and detached commits lose authority', async t => {
  const { window, document, observers } = installPageEnvironment();
  let tree = nativeSessionTree();
  const surface = tree.surface;
  let surfaceReads = 0;
  document.querySelector = () => { surfaceReads++; return surface; };
  document.querySelectorAll = () => [surface];
  const sessions = [];
  window.addEventListener('babel-helper:native-session-change', event => sessions.push(JSON.parse(event.detail)));
  await importBundledBridge('src/content/recovered-editor-bridge.ts');
  t.after(() => window.__babelHelperRecoveredEditorBridge?.dispose());
  const old = tree, generation = sessions.at(-1).generation, beforeReads = surfaceReads;
  tree = nativeSessionTree();
  surface.__reactFiber$test = tree.editor;
  const unrelated = new TestElement();
  const records = [{ type: 'childList', addedNodes: [unrelated], removedNodes: [] }];
  for (let index = 0; index < 20; index++) observers[0].callback(records);
  assert.equal(surfaceReads, beforeReads, 'mount deliveries do not synchronously rescan the native session');
  await Promise.resolve();
  assert.equal(surfaceReads, beforeReads + 1, 'one reconciliation covers the burst');
  assert.equal(sessions.length, 2);
  assert.ok(sessions.at(-1).generation > generation);
  assert.equal(sessions.at(-1).reviewActionId, 'task-a');
  assert.equal(Object.getOwnPropertyDescriptor(old.host, 'current').value, old.root);
  old.editor.memoizedProps.reviewActionId = 'detached-task';
  old.host.current = old.root;
  await Promise.resolve();
  assert.equal(sessions.length, 2);
  tree.editor.memoizedProps.reviewActionId = 'task-b';
  tree.host.current = tree.root;
  await Promise.resolve();
  assert.equal(sessions.at(-1).reviewActionId, 'task-b', 'new root commits own the unchanged surface');
  surface.isConnected = false;
  observers[0].callback(records);
  document.documentElement.setAttribute('data-babel-helper-native-session', 'new-owner');
  window.__babelHelperRecoveredEditorBridge.dispose();
  const count = sessions.length;
  await Promise.resolve();
  assert.equal(sessions.length, count, 'queued mount work cannot revive a disposed bridge');
  assert.equal(Object.getOwnPropertyDescriptor(tree.host, 'current').value, tree.root);
  assert.equal(document.documentElement.getAttribute('data-babel-helper-native-session'), 'new-owner',
    'teardown never removes a newer publication owner');
});

test('MAIN history signals work without Navigation API and cleanup never restores over foreign wrappers', async () => {
  const { window } = installPageEnvironment();
  delete window.navigation;
  const originalPush = function (_state, _title, href) { window.location.href = href; return 'native-result'; };
  const originalReplace = function () {};
  window.history.pushState = originalPush;
  window.history.replaceState = originalReplace;
  const routes = [];
  window.addEventListener('babel-helper:native-route-change', event => routes.push(event.detail));
  await importBundledBridge('src/content/recovered-editor-bridge.ts');
  assert.equal(window.history.pushState({}, '', 'https://babel.test/projects'), 'native-result');
  assert.deepEqual(routes, ['https://babel.test/projects']);
  const foreign = function () {};
  window.history.replaceState = foreign;
  window.__babelHelperRecoveredEditorBridge.dispose();
  assert.equal(window.history.pushState, originalPush);
  assert.equal(window.history.replaceState, foreign);
});

test('native text selection preserves lane clocks while editing and explicit seeking remain native', async (t) => {
  const { window, document } = installPageEnvironment();
  const tree = nativeSessionTree();
  const times = [8, 9];
  const waves = times.map((_, index) => ({
    getCurrentTime: () => times[index],
    seekTo(position) { times[index] = position * 100; }
  }));
  const seek = turn => waves.forEach(wave => wave.seekTo(turn.startTimeInSeconds / 100));
  let selected = null, editing = null;
  const handlers = tree.transcript.memoizedProps.handlers;
  handlers.onSelect = turn => {
    const time = waves[0].getCurrentTime();
    if (!(time >= turn.startTimeInSeconds && time < turn.endTimeInSeconds)) seek(turn);
    selected = turn.id;
  };
  const activate = id => { editing = id; };
  const deactivate = id => { if (editing === id) editing = null; };
  handlers.onActivate = activate;
  handlers.onDeactivate = deactivate;
  handlers.onSeek = seek;
  tree.editor.memoizedState = { memoizedState: { current: {
    first: { wavesurfer: waves[0] }, second: { wavesurfer: waves[1] }
  } }, next: null };
  document.querySelector = () => tree.surface;
  document.querySelectorAll = () => [tree.seed];
  document.documentElement.setAttribute('data-babel-helper-disable-segment-click-seek', 'true');
  const target = new TestElement();
  target.closest = () => tree.surface;
  await importBundledBridge('src/content/recovered-editor-bridge.ts');
  t.after(() => window.__babelHelperRecoveredEditorBridge?.dispose());
  const turn = { id: 'selected-turn', startTimeInSeconds: 1, endTimeInSeconds: 2 };
  window.dispatchEvent(new TestEvent('mousedown', { target }));
  assert.equal(handlers.onActivate, activate, 'the native editingId setter must not be wrapped');
  assert.equal(handlers.onDeactivate, deactivate, 'native conditional leave ownership must remain intact');
  handlers.onSelect(turn);
  handlers.onActivate(turn.id);
  assert.deepEqual(times, [8, 9]);
  assert.equal(selected, turn.id);
  assert.equal(editing, turn.id);
  handlers.onDeactivate('different-turn');
  assert.equal(editing, turn.id);
  handlers.onDeactivate(turn.id);
  assert.equal(editing, null);
  handlers.onSeek(turn);
  assert.deepEqual(times, [1, 1]);
  times[0] = 8; times[1] = 9;
  document.documentElement.removeAttribute('data-babel-helper-disable-segment-click-seek');
  window.dispatchEvent(new TestEvent('mousedown', { target }));
  handlers.onSelect(turn);
  assert.deepEqual(times, [1, 1]);
});
