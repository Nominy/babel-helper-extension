import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function importControllerModule() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-helper-mod-controller-'));
  const outfile = path.join(tempDir, 'mod-controller.mjs');
  await build({
    entryPoints: [path.resolve('src/content/mod-controller.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20'
  });
  return import(pathToFileURL(outfile).href);
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function captureControllerEvents(target) {
  const events = [];
  target.addEventListener('babel-mods:controller', (event) => {
    events.push(event.detail);
  });
  return events;
}

test('controller publishes each lifecycle transition once with monotonic revisions', async () => {
  const { createModController } = await importControllerModule();
  const target = new EventTarget();
  const events = captureControllerEvents(target);
  const initialSettings = { features: { customLinter: true } };
  const controller = createModController({
    target,
    generation: 41,
    initialSettings,
    getHref: () => 'https://example.test/transcription/one'
  });

  assert.equal(controller.start('entry'), true);
  assert.equal(controller.start('duplicate'), false);
  initialSettings.features.customLinter = false;
  assert.equal(
    controller.updateSettings({ features: { customLinter: false } }, 'storage-change'),
    true
  );
  assert.equal(controller.ready('settings-loaded'), true);
  assert.equal(await controller.activateSession('route-ready', () => true), true);
  assert.equal(await controller.activateSession('duplicate-route-ready', () => true), true);
  assert.equal(await controller.deactivateSession('route-exit', () => true), true);
  assert.equal(await controller.deactivateSession('duplicate-route-exit', () => true), true);
  await controller.stop('extension-reload');
  await controller.stop('duplicate-stop');

  assert.deepEqual(
    events.map(({ type, reason }) => [type, reason]),
    [
      ['extension:start', 'entry'],
      ['settings:update', 'storage-change'],
      ['extension:ready', 'settings-loaded'],
      ['session:activate', 'route-ready'],
      ['session:deactivate', 'route-exit'],
      ['extension:stop', 'extension-reload']
    ]
  );
  assert.deepEqual(
    events.map(({ revision }) => revision),
    [1, 2, 3, 4, 5, 6]
  );
  assert.deepEqual(
    events.map(({ settingsRevision }) => settingsRevision),
    [1, 2, 2, 2, 2, 2]
  );
  assert.equal(events[0].settings.features.customLinter, true);
  assert.equal(events.at(-1).generation, 41);
  assert.equal(events.at(-1).href, 'https://example.test/transcription/one');
});

test('late host readiness replays the current lifecycle after a settings update', async () => {
  const { createModController } = await importControllerModule();
  const target = new EventTarget();
  const events = captureControllerEvents(target);
  const controller = createModController({ target, generation: 44 });

  controller.start();
  controller.ready();
  await controller.activateSession('route-ready', () => true);
  controller.updateSettings({ features: { customLinter: false } });
  const hostReady = new Event('babel-mods:host-ready');
  hostReady.detail = {
    protocolVersion: 1,
    apiVersion: 1,
    generation: 0,
    internalsVersion: 'test'
  };
  target.dispatchEvent(hostReady);

  assert.deepEqual(
    events.slice(-2).map(({ type, reason }) => [type, reason]),
    [
      ['settings:update', 'settings-update'],
      ['session:activate', 'host-ready-replay']
    ]
  );
  assert.equal(events.at(-1).revision, controller.revision);
});

test('a newer session request prevents stale async activation from publishing', async () => {
  const { createModController } = await importControllerModule();
  const target = new EventTarget();
  const events = captureControllerEvents(target);
  const activation = deferred();
  const controller = createModController({ target, generation: 42 });

  controller.start();
  controller.ready();
  const activating = controller.activateSession('old-route', () => activation.promise);
  const deactivating = controller.deactivateSession('new-route', () => true);
  activation.resolve(true);

  assert.equal(await activating, false);
  assert.equal(await deactivating, true);
  assert.deepEqual(
    events.map(({ type }) => type),
    ['extension:start', 'extension:ready']
  );
});

test('new kernel generations make older asynchronous transitions stale', async () => {
  const { createModController } = await importControllerModule();
  const firstTarget = new EventTarget();
  const secondTarget = new EventTarget();
  const firstEvents = captureControllerEvents(firstTarget);
  const secondEvents = captureControllerEvents(secondTarget);
  const activation = deferred();
  const first = createModController({ target: firstTarget });

  first.start('first-start');
  first.ready('first-ready');
  const activating = first.activateSession('first-route', () => activation.promise);

  const second = createModController({ target: secondTarget });
  second.start('second-start');
  second.ready('second-ready');
  activation.resolve(true);

  assert.equal(await activating, false);
  assert.ok(second.generation > first.generation);
  assert.deepEqual(
    firstEvents.map(({ type }) => type),
    ['extension:start', 'extension:ready']
  );
  assert.deepEqual(
    secondEvents.map(({ type }) => type),
    ['extension:start', 'extension:ready']
  );
});

test('stop invalidates in-flight activation and executes teardown idempotently', async () => {
  const { createModController } = await importControllerModule();
  const target = new EventTarget();
  const events = captureControllerEvents(target);
  const activation = deferred();
  const teardown = deferred();
  const controller = createModController({ target, generation: 43 });
  let teardownCalls = 0;

  controller.start();
  controller.ready();
  const activating = controller.activateSession('slow-route', () => activation.promise);
  const stopping = controller.stop('reload', () => {
    teardownCalls += 1;
    return teardown.promise;
  });
  const duplicateStop = controller.stop('duplicate-reload', () => {
    teardownCalls += 1;
  });
  activation.resolve(true);
  teardown.resolve();

  assert.equal(await activating, false);
  await Promise.all([stopping, duplicateStop]);
  assert.equal(teardownCalls, 1);
  assert.deepEqual(
    events.map(({ type, reason }) => [type, reason]),
    [
      ['extension:start', 'kernel-start'],
      ['extension:ready', 'kernel-ready'],
      ['extension:stop', 'reload']
    ]
  );
});
