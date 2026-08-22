import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function importBundledTs(entryPoint) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-helper-mod-platform-'));
  const outfile = path.join(tempDir, path.basename(entryPoint).replace(/\.ts$/, '.mjs'));
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent'
  });
  return import(`${pathToFileURL(outfile).href}?${Date.now()}-${Math.random()}`);
}

test('owned scopes abort synchronously and dispose asynchronously in LIFO order once', async () => {
  const { createScope, ScopeDisposalError } = await importBundledTs('src/mod-platform/scope.ts');
  const scope = createScope('mod.example');
  const order = [];

  scope.defer(() => order.push('first'));
  scope.add({
    async dispose() {
      await Promise.resolve();
      order.push('second');
    }
  });
  scope.defer(() => {
    order.push('third');
    throw new Error('third failed');
  });

  let aborts = 0;
  scope.signal.addEventListener('abort', () => {
    aborts += 1;
    order.push('abort');
  });

  const firstDisposal = scope.dispose('test complete');
  const secondDisposal = scope.dispose('ignored duplicate');
  assert.strictEqual(firstDisposal, secondDisposal);
  assert.equal(scope.signal.aborted, true);
  assert.equal(scope.signal.reason, 'test complete');

  await assert.rejects(firstDisposal, (error) => {
    assert.ok(error instanceof ScopeDisposalError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].message, 'third failed');
    return true;
  });
  assert.deepEqual(order, ['abort', 'third', 'second', 'first']);
  assert.equal(aborts, 1);
  await assert.rejects(scope.dispose(), ScopeDisposalError);
  assert.deepEqual(order, ['abort', 'third', 'second', 'first']);
  assert.throws(() => scope.defer(() => undefined), /disposed scope/);
});

test('child scopes and disposable handles are enrolled in parent LIFO ownership', async () => {
  const { createDisposableHandle, createScope } = await importBundledTs('src/mod-platform/scope.ts');
  const root = createScope('root');
  const child = root.child('child');
  const order = [];
  const handle = createDisposableHandle(() => order.push('handle'));

  child.add(handle);
  root.defer(() => order.push('after-child'));
  await root.dispose();
  handle.dispose();

  assert.equal(child.signal.aborted, true);
  assert.deepEqual(order, ['after-child', 'handle']);
});

test('event bus has deterministic priority order, disposable once listeners, and serial async emission', async () => {
  const { createEventBus } = await importBundledTs('src/mod-platform/event-bus.ts');
  const bus = createEventBus();
  const order = [];

  const low = bus.on('change', () => order.push('low'), { priority: -1 });
  bus.on('change', () => order.push('first-high'), { priority: 5 });
  bus.once('change', () => {
    order.push('once');
    bus.emit('change', null);
  }, { priority: 5 });

  const synchronous = bus.emit('change', null);
  assert.equal(synchronous, undefined);
  assert.deepEqual(order, [
    'first-high',
    'once',
    'first-high',
    'low',
    'low'
  ]);

  low.dispose();
  order.length = 0;
  bus.on('async', async () => {
    order.push('async:start');
    await Promise.resolve();
    order.push('async:end');
  });
  bus.on('async', () => order.push('after'));
  await bus.emit('async', null);
  assert.deepEqual(order, ['async:start', 'async:end', 'after']);
});

test('contribution registry orders deterministically and removes only the owning registrations', async () => {
  const { createContributionRegistry } = await importBundledTs(
    'src/mod-platform/contribution-registry.ts'
  );
  const { createScope } = await importBundledTs('src/mod-platform/scope.ts');
  const registry = createContributionRegistry();
  const ownerA = { id: 'a' };
  const ownerB = { id: 'b' };
  const scopeA = createScope(ownerA);

  const a1 = registry.add('linter.rules', {
    owner: ownerA,
    id: 'a-first',
    value: 'a1',
    priority: 1,
    scope: scopeA
  });
  registry.add('linter.rules', {
    owner: ownerB,
    id: 'b-high',
    value: 'b',
    priority: 10
  });
  registry.add('linter.rules', {
    owner: ownerA,
    id: 'a-second',
    value: 'a2',
    priority: 1,
    scope: scopeA
  });

  assert.deepEqual(registry.values('linter.rules'), ['b', 'a1', 'a2']);
  assert.deepEqual(
    registry.snapshot('linter.rules').map(({ id }) => id),
    ['b-high', 'a-first', 'a-second']
  );
  assert.throws(
    () => registry.add('linter.rules', { owner: ownerA, id: 'a-first', value: 'duplicate' }),
    /already registered/
  );

  a1.dispose();
  assert.deepEqual(registry.values('linter.rules'), ['b', 'a2']);
  await scopeA.dispose();
  assert.deepEqual(registry.values('linter.rules'), ['b']);
  registry.removeOwner({ id: 'b' });
  assert.deepEqual(registry.values('linter.rules'), ['b']);
  registry.removeOwner(ownerB);
  assert.deepEqual(registry.values('linter.rules'), []);
});

test('service handles remain late-bound across provider and replacement lifetimes', async () => {
  const { createServiceRegistry } = await importBundledTs('src/mod-platform/service-registry.ts');
  const registry = createServiceRegistry();
  const service = registry.get('math');

  assert.throws(() => service.label, /not available/);
  const base = registry.provide('math', {
    label: 'base',
    calculate(value) {
      return value + 1;
    }
  }, { owner: 'base' });
  assert.equal(service.label, 'base');
  assert.equal(service.calculate(2), 3);

  const firstReplacement = registry.replace('math', {
    label: 'first',
    calculate(value) {
      return value + 10;
    }
  }, { owner: 'first' });
  const secondReplacement = registry.replace('math', {
    label: 'second',
    calculate(value) {
      return value + 100;
    }
  }, { owner: 'second' });

  assert.equal(service.label, 'second');
  firstReplacement.dispose();
  assert.equal(service.label, 'second');
  secondReplacement.dispose();
  assert.equal(service.label, 'base');
  base.dispose();
  assert.equal(registry.optional('math'), undefined);
  assert.throws(() => service.calculate(1), /not available/);

  registry.provide('math', { label: 'new', calculate: (value) => value * 2 });
  assert.equal(service.calculate(4), 8);
});

test('service decorators and interceptors rebuild in deterministic order without making calls async', async () => {
  const { createServiceRegistry } = await importBundledTs('src/mod-platform/service-registry.ts');
  const registry = createServiceRegistry();
  const order = [];
  registry.provide('math', {
    calculate(value) {
      order.push(`base:${value}`);
      return value;
    }
  });
  const service = registry.get('math');

  const inner = registry.decorate('math', (next) => ({
    calculate(value) {
      order.push('decorate:first');
      return next.calculate(value) + 1;
    }
  }));
  const outer = registry.decorate('math', (next) => ({
    calculate(value) {
      order.push('decorate:second');
      return next.calculate(value) * 2;
    }
  }));
  const firstInterceptor = registry.intercept('math', 'calculate', ({ args, next }) => {
    order.push('intercept:first');
    return next(args[0] + 1);
  });
  const secondInterceptor = registry.intercept('math', 'calculate', ({ args, next }) => {
    order.push('intercept:second');
    return next(args[0]) + 3;
  });

  const result = service.calculate(2);
  assert.equal(result instanceof Promise, false);
  assert.equal(result, 10);
  assert.deepEqual(order, [
    'intercept:first',
    'intercept:second',
    'decorate:first',
    'decorate:second',
    'base:3'
  ]);

  order.length = 0;
  inner.dispose();
  assert.equal(service.calculate(2), 9);
  assert.deepEqual(order, [
    'intercept:first',
    'intercept:second',
    'decorate:second',
    'base:3'
  ]);

  outer.dispose();
  firstInterceptor.dispose();
  secondInterceptor.dispose();
  assert.equal(service.calculate(5), 5);
});

test('service provision cleanup runs before its layer disappears', async () => {
  const { createServiceRegistry } = await importBundledTs('src/mod-platform/service-registry.ts');
  const registry = createServiceRegistry();
  const observed = [];
  const handle = registry.provide('stateful', () => ({
    value: { read: () => 'available' },
    dispose: async () => {
      observed.push(registry.optional('stateful')?.read());
      await Promise.resolve();
      observed.push(registry.optional('stateful')?.read());
    }
  }));

  assert.equal(registry.get('stateful').read(), 'available');
  await handle.dispose();
  assert.deepEqual(observed, ['available', 'available']);
  assert.equal(registry.optional('stateful'), undefined);
});

test('patch stack rebuilds around out-of-order removals and restores the exact descriptor', async () => {
  const { createPatchStack } = await importBundledTs('src/mod-platform/patch-stack.ts');
  const patches = createPatchStack();
  const calls = [];
  const target = {};
  const original = function (value) {
    calls.push(`base:${this.name}:${value}`);
    return value;
  };
  Object.defineProperty(target, 'run', {
    configurable: true,
    enumerable: false,
    writable: true,
    value: original
  });
  target.name = 'target';
  const originalDescriptor = Object.getOwnPropertyDescriptor(target, 'run');

  const first = patches.patch(target, 'run', (next) => function (value) {
    calls.push('first');
    return Reflect.apply(next, this, [value]) + 1;
  }, { owner: 'first' });
  const second = patches.patch(target, 'run', (next) => function (value) {
    calls.push('second');
    return Reflect.apply(next, this, [value]) * 2;
  }, { owner: 'second' });

  assert.equal(target.run(3), 8);
  assert.deepEqual(calls, ['second', 'first', 'base:target:3']);
  calls.length = 0;

  first.dispose();
  assert.equal(target.run(3), 6);
  assert.deepEqual(calls, ['second', 'base:target:3']);
  second.dispose();

  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'run'), originalDescriptor);
  assert.strictEqual(target.run, original);
  assert.equal(patches.layerCount(), 0);
});

test('accessor patch and replace layers preserve accessors and restore getter/setter identities', async () => {
  const { createPatchStack } = await importBundledTs('src/mod-platform/patch-stack.ts');
  const patches = createPatchStack();
  let stored = 4;
  const get = () => stored;
  const set = (value) => {
    stored = value;
  };
  const target = {};
  Object.defineProperty(target, 'value', {
    configurable: true,
    enumerable: false,
    get,
    set
  });
  const originalDescriptor = Object.getOwnPropertyDescriptor(target, 'value');

  const doubled = patches.patch(target, 'value', (value) => value * 2);
  const replaced = patches.replace(target, 'value', 9);
  assert.equal(target.value, 9);
  assert.strictEqual(Object.getOwnPropertyDescriptor(target, 'value').set, set);

  doubled.dispose();
  assert.equal(target.value, 9);
  replaced.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, 'value'), originalDescriptor);
  target.value = 7;
  assert.equal(target.value, 7);
});

test('controller protocol accepts only complete current-version data transitions', async () => {
  const {
    CONTROLLER_PROTOCOL_VERSION,
    isControllerTransition
  } = await importBundledTs('src/mod-platform/protocol.ts');
  const transition = {
    protocolVersion: CONTROLLER_PROTOCOL_VERSION,
    generation: 3,
    revision: 8,
    settingsRevision: 2,
    type: 'settings:update',
    reason: 'storage changed',
    href: 'https://dashboard.babel.audio/transcription?id=1',
    settings: { enabled: true }
  };

  assert.equal(isControllerTransition(transition), true);
  assert.equal(isControllerTransition({ ...transition, revision: -1 }), false);
  assert.equal(isControllerTransition({ ...transition, protocolVersion: 2 }), false);
  assert.equal(isControllerTransition({ ...transition, type: 'session:unknown' }), false);
});
