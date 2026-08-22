import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function importServiceRuntime() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-helper-service-registry-'));
  const outfile = path.join(tempDir, 'service-runtime.mjs');
  await build({
    stdin: {
      contents: [
        "export { createBuiltinServiceRegistry } from './src/core/service-registry.ts';",
        "export { installLegacyServiceProvider } from './src/core/legacy-service-provider.ts';",
        "export { createScope } from './src/mod-platform/scope.ts';"
      ].join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'service-runtime-entry.ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent'
  });
  return import(pathToFileURL(outfile).href);
}

const runtime = await importServiceRuntime();

test('built-in property handles remain late-bound through replace, decorate, and intercept', () => {
  const services = runtime.createBuiltinServiceRegistry();
  const capturedSession = services.session;

  const disposeBase = services.provide('session', { isInteractive: () => false }, { owner: 'base' });
  assert.equal(capturedSession.isInteractive(), false);

  const disposeReplacement = services.replace(
    'session',
    { isInteractive: () => true },
    { owner: 'replacement' }
  );
  assert.equal(capturedSession.isInteractive(), true);

  const disposeDecorator = services.decorate(
    'session',
    (next) => ({ isInteractive: () => !next.isInteractive() }),
    { owner: 'decorator' }
  );
  assert.equal(capturedSession.isInteractive(), false);

  let intercepted = 0;
  const disposeInterceptor = services.intercept(
    'session',
    'isInteractive',
    ({ next }) => {
      intercepted += 1;
      return next();
    },
    { owner: 'interceptor' }
  );
  assert.equal(capturedSession.isInteractive(), false);
  assert.equal(intercepted, 1);

  disposeInterceptor.dispose();
  disposeInterceptor.dispose();
  disposeDecorator.dispose();
  disposeReplacement.dispose();
  assert.equal(capturedSession.isInteractive(), false);
  disposeBase.dispose();
  assert.throws(() => capturedSession.isInteractive(), /service|provider/i);
});

test('legacy providers and unbind cleanup are owned and disposed idempotently', async () => {
  const rootScope = runtime.createScope('test:kernel');
  const services = runtime.createBuiltinServiceRegistry();
  const capturedSession = services.session;
  let registrations = 0;
  let cleanups = 0;
  let interactive = true;
  const helper = {
    unbindSession() {
      cleanups += 1;
      interactive = false;
    }
  };
  const context = {
    helper,
    services,
    scope: rootScope,
    state: {},
    config: {},
    runtime: {},
    onDispose() {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {}
    }
  };

  const providerScope = runtime.installLegacyServiceProvider(
    context,
    'session',
    () => {
      registrations += 1;
    },
    () => ({ isInteractive: () => interactive }),
    ['unbindSession']
  );

  assert.equal(registrations, 1);
  assert.equal(capturedSession.isInteractive(), true);
  await providerScope.dispose('test-stop');
  await providerScope.dispose('test-stop-again');
  assert.equal(cleanups, 1);
  assert.throws(() => capturedSession.isInteractive(), /service|provider/i);

  await rootScope.dispose('kernel-stop');
  assert.equal(cleanups, 1);
});
