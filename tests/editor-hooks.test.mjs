import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/core/editor-hooks.ts'], bundle: true, write: false, format: 'esm' });
const { createEditorHooks } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('input hooks preserve feature priority, event ownership, and independent disposal', () => {
  const hooks = createEditorHooks();
  const calls = [];
  hooks.on('keydown', () => { calls.push('last'); }, 30);
  const removeOwner = hooks.on('keydown', () => { calls.push('owner'); return true; }, 20);
  hooks.on('keydown', () => { calls.push('first'); }, 10);
  hooks.on('keyup', () => { calls.push('keyup'); });

  assert.equal(hooks.dispatch('keydown', {}), true);
  assert.deepEqual(calls, ['first', 'owner']);
  removeOwner();
  removeOwner();
  calls.length = 0;
  assert.equal(hooks.dispatch('keydown', {}), false);
  assert.deepEqual(calls, ['first', 'last']);
  calls.length = 0;
  hooks.dispatch('keyup', {});
  assert.deepEqual(calls, ['keyup']);
});
