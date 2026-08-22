import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

class TestCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

class TestWindow extends EventTarget {
  constructor() {
    super();
    this.location = { href: 'https://dashboard.babel.audio/transcription?id=test' };
    this.window = this;
  }
}

if (typeof globalThis.CustomEvent === 'undefined') globalThis.CustomEvent = TestCustomEvent;

let modulePromise;
async function loadHostModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-helper-mod-host-'));
      const outfile = path.join(tempDir, 'page-host.mjs');
      await build({
        entryPoints: [path.resolve('src/mod-platform/page-host.ts')],
        outfile,
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2020',
        define: { __BABEL_MOD_INTERNALS_VERSION__: JSON.stringify('test-version') },
        logLevel: 'silent'
      });
      return import(`${pathToFileURL(outfile).href}?${Date.now()}`);
    })();
  }
  return modulePromise;
}

function transition(generation, revision, type, reason = type) {
  return {
    protocolVersion: 1,
    generation,
    revision,
    settingsRevision: 0,
    type,
    reason,
    href: 'https://dashboard.babel.audio/transcription?id=test'
  };
}

function lifecycle(host) {
  return host.unsafe.lifecycle;
}
test('MAIN-world host has no extension API dependency', async () => {
  const source = await fs.readFile(path.resolve('src/mod-platform/page-host.ts'), 'utf8');
  assert.doesNotMatch(source, /\bchrome\s*\./);
});


test('mod-first queue and host-first registration resolve to dependency metadata order', async () => {
  const { installPageHost } = await loadHostModule();
  const calls = [];
  const modFirstWindow = new TestWindow();
  modFirstWindow.__BABEL_MOD_QUEUE__ = [
    { id: 'example.after', apiVersion: 1, after: ['example.base'], setup() { calls.push('after'); } },
    { id: 'example.base', apiVersion: 1, setup() { calls.push('base'); } },
    { id: 'example.required', apiVersion: 1, requires: ['example.after'], setup() { calls.push('required'); } }
  ];
  const modFirstHost = installPageHost(modFirstWindow);
  assert.equal(modFirstWindow.__BABEL_MOD_QUEUE__.length, 0);
  await lifecycle(modFirstHost).apply(transition(1, 1, 'extension:start'));
  assert.deepEqual(calls, ['base', 'after', 'required']);

  calls.length = 0;
  const hostFirstWindow = new TestWindow();
  const hostFirstHost = installPageHost(hostFirstWindow);
  hostFirstHost.register({
    id: 'example.required', apiVersion: 1, requires: ['example.after'], setup() { calls.push('required'); }
  });
  hostFirstHost.register({
    id: 'example.after', apiVersion: 1, after: ['example.base'], setup() { calls.push('after'); }
  });
  hostFirstHost.register({ id: 'example.base', apiVersion: 1, setup() { calls.push('base'); } });
  await lifecycle(hostFirstHost).apply(transition(1, 1, 'extension:start'));
  assert.deepEqual(calls, ['base', 'after', 'required']);
});

test('trusted userscript examples execute against the real high- and low-level host APIs', async () => {
  const { installPageHost } = await loadHostModule();
  const pageWindow = new TestWindow();
  const host = installPageHost(pageWindow);
  const services = host.unsafe.services;
  const playbackCalls = [];
  const playbackProvider = services.provide('page.playback', {
    setPaused(paused) {
      playbackCalls.push(paused);
      return paused ? 'paused' : 'playing';
    }
  });
  const indicator = {
    dataset: {},
    style: {},
    textContent: '',
    removed: false,
    remove() {
      this.removed = true;
    }
  };
  const document = {
    createElement() {
      return indicator;
    },
    documentElement: {
      append(node) {
        assert.equal(node, indicator);
      }
    }
  };
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => logs.push(args);

  try {
    for (const path of [
      'examples/tampermonkey/native-registration.user.js',
      'examples/tampermonkey/coremod-decoration.user.js'
    ]) {
      const source = await fs.readFile(path, 'utf8');
      Function('window', 'document', source)(pageWindow, document);
    }

    await lifecycle(host).apply(transition(3, 1, 'extension:start'));
    await lifecycle(host).apply(transition(3, 2, 'session:activate'));
    assert.deepEqual(host.diagnostics.list(), []);
    assert.deepEqual(
      lifecycle(host).snapshot().mods.map((mod) => ({ id: mod.id, status: mod.status })),
      [
        { id: 'example.session-indicator', status: 'active' },
        { id: 'example.playback-observer', status: 'active' }
      ]
    );
    assert.equal(indicator.textContent, 'Babel Mods active');
    assert.equal(services.invoke('page.playback', 'setPaused', true), 'paused');
    assert.deepEqual(playbackCalls, [true]);
    assert.ok(logs.some((entry) => entry.some((value) => String(value).includes('setPaused'))));

    await lifecycle(host).apply(transition(3, 3, 'session:deactivate'));
    assert.equal(indicator.removed, true);
    await lifecycle(host).apply(transition(3, 4, 'extension:stop'));
    const logCount = logs.length;
    assert.equal(services.invoke('page.playback', 'setPaused', false), 'playing');
    assert.equal(logs.length, logCount);
  } finally {
    console.info = originalInfo;
    playbackProvider.dispose();
  }
});

test('activation scopes are fresh per session and generation disposal is deterministic LIFO', async () => {
  const { installPageHost } = await loadHostModule();
  const host = installPageHost(new TestWindow());
  const calls = [];
  let firstSignal;
  let secondSignal;

  host.register({
    id: 'example.lifecycle',
    apiVersion: 1,
    setup({ scope }) {
      calls.push('setup');
      scope.add(() => calls.push('setup-cleanup-1'));
      scope.add(() => calls.push('setup-cleanup-2'));
    },
    activate({ scope, signal }) {
      calls.push('activate');
      if (!firstSignal) firstSignal = signal;
      else secondSignal = signal;
      scope.add(() => calls.push('activation-cleanup-1'));
      scope.add(() => calls.push('activation-cleanup-2'));
    },
    deactivate() {
      calls.push('deactivate');
    },
    dispose() {
      calls.push('dispose');
    }
  });

  await lifecycle(host).apply(transition(4, 1, 'extension:start'));
  await lifecycle(host).apply(transition(4, 2, 'session:activate'));
  await lifecycle(host).apply(transition(4, 3, 'session:deactivate'));
  assert.equal(firstSignal.aborted, true);
  await lifecycle(host).apply(transition(4, 4, 'session:activate'));
  assert.notEqual(firstSignal, secondSignal);
  assert.equal(secondSignal.aborted, false);
  await lifecycle(host).apply(transition(4, 5, 'extension:stop'));
  assert.equal(secondSignal.aborted, true);
  assert.deepEqual(calls, [
    'setup',
    'activate',
    'deactivate',
    'activation-cleanup-2',
    'activation-cleanup-1',
    'activate',
    'deactivate',
    'activation-cleanup-2',
    'activation-cleanup-1',
    'dispose',
    'setup-cleanup-2',
    'setup-cleanup-1'
  ]);
});

test('service handles are late-bound while synchronous callback identity, receiver, return, and throw survive layers', async () => {
  const { installPageHost } = await loadHostModule();
  const host = installPageHost(new TestWindow());
  const services = host.unsafe.services;
  const seen = [];
  const base = {
    offset: 3,
    run(callback, value) {
      seen.push(['base-this', this]);
      return callback.call(this, value + this.offset);
    }
  };
  const provider = services.provide('example.sync', base);
  const captured = services.get('example.sync');
  const callback = function (value) {
    seen.push(['callback', this, value]);
    return value * 2;
  };
  const interceptor = services.intercept('example.sync', 'run', (call) => {
    seen.push(['interceptor-callback-identity', call.args[0] === callback]);
    return call.next(...call.args) + 1;
  });

  assert.equal(captured.run(callback, 4), 15);
  assert.deepEqual(seen[0], ['interceptor-callback-identity', true]);
  assert.equal(seen[1][1], base);
  assert.equal(seen[2][1], base);

  const replacementObject = {
    offset: 10,
    run(received, value) {
      assert.equal(received, callback);
      return received.call(this, value + this.offset);
    }
  };
  const replacement = services.replace('example.sync', replacementObject);
  assert.equal(captured.run(callback, 2), 25);
  replacement.dispose();
  assert.equal(captured.run(callback, 1), 9);

  const expected = new Error('callback failure');
  const throwing = () => { throw expected; };
  assert.throws(() => captured.run(throwing, 0), (error) => error === expected);
  interceptor.dispose();
  provider.dispose();
  assert.throws(() => captured.run(callback, 0), /not available/i);
});

test('automatic ownership removes events, contributions, service layers, and patches on registration disposal', async () => {
  const { installPageHost } = await loadHostModule();
  const host = installPageHost(new TestWindow());
  const target = { value: 1 };
  let eventCalls = 0;
  const registration = host.register({
    id: 'example.owned',
    apiVersion: 1,
    setup({ events, registries, services, unsafe }) {
      events.on('example:event', () => { eventCalls += 1; });
      registries.add('example.rows', { label: 'Owned row' }, { id: 'owned-row' });
      services.provide('example.owned-service', { value() { return 42; } });
      unsafe.patches.replace(target, 'value', 9);
    }
  });
  await lifecycle(host).apply(transition(2, 1, 'extension:start'));
  await host.unsafe.events.emitAsync('example:event', undefined);
  assert.equal(eventCalls, 1);
  assert.deepEqual(host.registries.get('example.rows'), [{ label: 'Owned row' }]);
  assert.equal(host.unsafe.services.invoke('example.owned-service', 'value'), 42);
  assert.equal(target.value, 9);

  await registration.dispose();
  await host.unsafe.events.emitAsync('example:event', undefined);
  assert.equal(eventCalls, 1);
  assert.deepEqual(host.registries.get('example.rows'), []);
  assert.equal(host.unsafe.services.optional('example.owned-service'), undefined);
  assert.equal(target.value, 1);
});

test('missing requirements, dependency cycles, duplicate ids, and stale transitions are observable and isolated', async () => {
  const { installPageHost } = await loadHostModule();
  const host = installPageHost(new TestWindow());
  let setupCount = 0;
  host.register({ id: 'example.missing', apiVersion: 1, requires: ['example.absent'], setup() { setupCount += 1; } });
  host.register({ id: 'example.cycle-a', apiVersion: 1, after: ['example.cycle-b'], setup() { setupCount += 1; } });
  host.register({ id: 'example.cycle-b', apiVersion: 1, after: ['example.cycle-a'], setup() { setupCount += 1; } });
  host.register({ id: 'example.healthy', apiVersion: 1, setup() { setupCount += 1; } });
  assert.throws(() => host.register({ id: 'example.healthy', apiVersion: 1 }), /duplicate/i);

  await lifecycle(host).apply(transition(8, 2, 'extension:start'));
  await lifecycle(host).apply(transition(8, 1, 'session:activate'));
  assert.equal(setupCount, 1);
  assert.equal(lifecycle(host).snapshot().sessionActive, false);
  const codes = host.diagnostics.list().map((entry) => entry.code);
  assert.ok(codes.includes('required-dependency-unavailable'));
  assert.ok(codes.includes('dependency-cycle'));
  assert.ok(codes.includes('duplicate-mod-id'));
});

test('generation replacement disposes old ownership before setting up the new generation exactly once', async () => {
  const { installPageHost } = await loadHostModule();
  const host = installPageHost(new TestWindow());
  const calls = [];
  host.register({
    id: 'example.generation',
    apiVersion: 1,
    setup({ scope }) {
      calls.push(`setup:${lifecycle(host).snapshot().generation}`);
      scope.add(() => calls.push('cleanup'));
    },
    dispose() {
      calls.push('dispose');
    }
  });
  await lifecycle(host).apply(transition(1, 1, 'extension:start'));
  await lifecycle(host).apply(transition(1, 1, 'extension:start'));
  await lifecycle(host).apply(transition(2, 1, 'extension:start'));
  assert.deepEqual(calls, ['setup:1', 'dispose', 'cleanup', 'setup:2']);
});
