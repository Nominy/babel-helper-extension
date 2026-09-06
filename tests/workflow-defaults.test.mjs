import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/core/workflow-defaults.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  write: false,
  logLevel: 'silent'
});
const defaults = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

test('unset workflow preferences survive normalization and storage round trips without becoming minimum values', async () => {
  const originalChrome = globalThis.chrome;
  let stored;
  globalThis.chrome = {
    storage: {
      local: {
        get(_key, callback) { callback(stored); },
        set(items, callback) { stored = items; callback(); }
      }
    }
  };
  try {
    const empty = { lastZoomValue: null, waveformScales: {} };
    assert.deepEqual(await defaults.loadWorkflowDefaults(), empty);
    assert.deepEqual(await defaults.saveWorkflowDefaults(empty), empty);
    assert.deepEqual(await defaults.loadWorkflowDefaults(), empty);
    const mixed = { lastZoomValue: null, waveformScales: { unset: null, saved: 33 } };
    await defaults.saveWorkflowDefaults(mixed);
    assert.deepEqual(await defaults.loadWorkflowDefaults(), mixed);
    assert.equal(defaults.normalizeWaveformScaleValue(undefined), null);
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
  }
});

test('saved numeric preferences retain normalization and range handling', () => {
  assert.deepEqual(defaults.normalizeWorkflowDefaults({
    lastZoomValue: '240.6',
    waveformScales: { saved: '33.1254' }
  }), { lastZoomValue: 241, waveformScales: { saved: 33.125 } });
  assert.equal(defaults.normalizeZoomValue(0), 10);
  assert.equal(defaults.normalizeZoomValue(3000), 2000);
  assert.equal(defaults.normalizeWaveformScaleValue(0), 0.3);
  assert.equal(defaults.normalizeWaveformScaleValue(1500), 1000);
});
