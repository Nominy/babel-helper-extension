import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

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
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.isConnected = false;
    this.className = '';
    this.textContent = '';
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }

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
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
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
  window.window = window;
  window.document = document;
  window.location = { pathname: '/transcription', search: '?id=fixture' };
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
    InputEvent: TestEvent,
    KeyboardEvent: TestEvent,
    MouseEvent: TestEvent,
    FocusEvent: TestEvent,
    Request: class Request {},
    Response: class Response {}
  };
  for (const [key, value] of Object.entries(values)) globalThis[key] = value;
  return { window, document };
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
    await import(`${pathToFileURL(outfile).href}?${Math.random()}`);
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
