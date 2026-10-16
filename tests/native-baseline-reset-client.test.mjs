import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/services/native-baseline-reset-client.ts'], bundle: true,
  format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { createNativeBaselineResetClient } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
const summary = { ok: true, level: 1, segmentCount: 0, reviewActionId: 'current', baselineReviewActionId: 'previous' };

test('prepare/apply use isolated async bridge deadlines without retries or content exposure', async () => {
  const calls = [];
  const client = createNativeBaselineResetClient(async (operation, payload, timeout) => {
    calls.push({ operation, payload, timeout });
    return operation === 'discard-baseline-reset' ? { ok: true } : { ...summary, token: 'private-token', annotations: [{ content: 'never expose' }] };
  });
  const prepared = await client.prepareBaselineReset({ expectedReviewActionId: 'current' });
  assert.deepEqual(prepared, { ...summary, token: 'private-token' });
  assert.equal(calls[0].operation, 'prepare-baseline-reset'); assert.equal(calls[0].timeout, 25000);
  assert.equal(calls[0].payload.expectedReviewActionId, 'current'); assert.ok(calls[0].payload.deadlineAt > Date.now());
  assert.deepEqual(await client.applyBaselineReset({ token: prepared.token, expectedReviewActionId: 'current' }), summary);
  assert.equal(calls[1].operation, 'apply-baseline-reset'); assert.equal(calls[1].timeout, 9000);
  assert.deepEqual(await client.discardBaselineReset({ token: prepared.token }), { ok: true });
  assert.equal(calls.length, 3);
});

test('unavailable and rejected services cannot fabricate success or retry', async () => {
  for (const response of [null, undefined, { ok: false, reason: 'baseline-unavailable' }]) {
    let calls = 0;
    const client = createNativeBaselineResetClient(async () => { calls++; return response; });
    assert.equal((await client.prepareBaselineReset({ expectedReviewActionId: 'current' })).ok, false);
    assert.equal(calls, 1);
  }
});

test('malformed or stale summaries fail closed and release any returned token', async () => {
  for (const value of [{ ...summary, level: 2 }, { ...summary, segmentCount: -1 }, { ...summary, segmentCount: 1.5 },
    { ...summary, reviewActionId: 'different' }, { ...summary, baselineReviewActionId: 'current' }]) {
    const calls = [];
    const client = createNativeBaselineResetClient(async (operation, payload) => {
      calls.push([operation, payload]); return operation === 'discard-baseline-reset' ? { ok: true } : { ...value, token: 'discard-me' };
    });
    assert.equal((await client.prepareBaselineReset({ expectedReviewActionId: 'current' })).ok, false);
    assert.deepEqual(calls[1], ['discard-baseline-reset', { token: 'discard-me' }]);
  }
});
