import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';

let bundle;
async function loadBoot() {
  bundle ||= build({
    entryPoints: [path.resolve('src/content/entry.ts')], bundle: true, write: false,
    format: 'iife', platform: 'browser', target: 'chrome114', logLevel: 'silent',
    plugins: [{ name: 'entry-lifecycle-boundaries', setup(builder) {
      builder.onResolve({ filter: /^\.\.\/(core\/kernel|features\/custom-linter)$/ }, args => ({
        path: args.path, namespace: 'entry-boundary'
      }));
      builder.onLoad({ filter: /.*/, namespace: 'entry-boundary' }, args => ({
        contents: args.path.endsWith('/kernel')
          ? 'export function createHelperKernel() { window.probe.calls.push("new-kernel"); return window.probe.nextKernel; }'
          : 'export function preloadCustomLinterBridge() { window.probe.calls.push("preload"); return Promise.resolve(); } export function bootstrapCustomLinterBridge() { window.probe.calls.push("bootstrap"); }',
        loader: 'js'
      }));
    } }]
  }).then(result => result.outputFiles[0].text);
  return bundle;
}

async function bootFixture() {
  const calls = [], retries = [];
  const drain = Promise.withResolvers();
  const window = new EventTarget();
  const oldKernel = { generation: 1, async stop(reason) {
    calls.push(`stop:${reason}`);
    await drain.promise;
    calls.push('native-disabled-ack');
  } };
  const nextKernel = { generation: 2, helper: { isFeatureEnabled: () => false },
    async start() { calls.push('new-start'); }, async stop() { calls.push('new-stop'); } };
  window.__babelHelperKernel = oldKernel;
  window.probe = { calls, nextKernel };
  window.setTimeout = (callback, delay) => retries.push({ callback, delay });
  let nativeListenerAlive = true;
  window.addEventListener('babel-helper-bridge-teardown', () => {
    nativeListenerAlive = false;
    calls.push('bridge-teardown');
  });
  const document = { querySelectorAll() {
    calls.push('find-old-scripts');
    return [{ remove() { calls.push('remove-old-script'); } }];
  } };
  new Function('window', 'document', 'CustomEvent', await loadBoot())(window, document, CustomEvent);
  return { window, oldKernel, nextKernel, calls, retries, drain, listenerAlive: () => nativeListenerAlive };
}

test('entry waits for correlated native restoration drain before teardown or replacement injection', async () => {
  const fixture = await bootFixture();
  assert.deepEqual(fixture.calls, ['stop:kernel-replaced']);
  assert.equal(fixture.listenerAlive(), true, 'the old producer must still receive its dispose request and acknowledge it');
  assert.equal(fixture.window.__babelHelperKernel, fixture.oldKernel);
  fixture.drain.resolve();
  const settled = Promise.withResolvers();
  setImmediate(settled.resolve);
  await settled.promise;
  assert.deepEqual(fixture.calls, ['stop:kernel-replaced', 'native-disabled-ack', 'bridge-teardown',
    'find-old-scripts', 'remove-old-script', 'preload', 'new-kernel', 'new-start', 'bootstrap']);
  assert.equal(fixture.window.__babelHelperKernel, fixture.nextKernel);
  assert.equal(fixture.retries.length, 0);
});

test('entry retains the prior owner and listeners when its stop rejects', async () => {
  const fixture = await bootFixture();
  fixture.drain.reject(new Error('Native Original restoration remains unavailable'));
  const settled = Promise.withResolvers();
  setImmediate(settled.resolve);
  await settled.promise;
  assert.deepEqual(fixture.calls, ['stop:kernel-replaced']);
  assert.equal(fixture.listenerAlive(), true);
  assert.equal(fixture.window.__babelHelperKernel, fixture.oldKernel);
  assert.equal(fixture.retries.length, 1, 'failure reaches the existing boot retry path instead of falling through');
  assert.equal(fixture.retries[0].delay, 1000);
});
