import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/features/auto-insert-segment.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  plugins: [{
    name: 'task-guard',
    setup(build) {
      build.onResolve({ filter: /l0-timing-identity$/ }, () => ({ path: 'guard', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export const captureL0TaskGuard = () => globalThis.autoInsertTaskGuard;', loader: 'js'
      }));
    }
  }]
});
const { registerAutoInsertSegment } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function fixture(t, options = {}) {
  class Row { isConnected = true; }
  const oldElement = globalThis.HTMLElement;
  const oldGuard = globalThis.autoInsertTaskGuard;
  globalThis.HTMLElement = Row;
  let current = true;
  globalThis.autoInsertTaskGuard = () => current;
  t.after(() => {
    globalThis.HTMLElement = oldElement;
    globalThis.autoInsertTaskGuard = oldGuard;
  });
  const container = new Row();
  let row = new Row();
  const focusCalls = [];
  let createCount = 0;
  let labelLookups = 0;
  const identity = { annotationId: 'created', processedRecordingId: 'track', reviewActionId: 'task' };
  const helper = {
    state: {},
    createSegmentWithNativeAction: async () => {
      createCount++;
      return options.createFailure ? { ok: false, reason: 'native-commit-failed', changed: true } : { ok: true, ...identity };
    },
    findRowByIdentity: value => value.annotationId === 'created' && !options.missingRow ? row : null,
    getRowIdentity: () => identity,
    getRowSpeakerKey: () => 'speaker',
    getRowEditor: () => ({ value: '' }),
    getTranscriptRows: () => [row],
    getRowTextValue: () => '',
    mergeSegmentWithNativeAction: async () => { throw new Error('No adjacent rows'); },
    focusRow: (target, settings) => { focusCalls.push({ target, settings }); return true; },
    sleep: async () => {},
    waitFor: () => { throw new Error('Native commit must not be polled'); }
  };
  const api = {
    segmentation: {
      AUTO_SEGMENT_SPLIT_SETTLE_MS: 100,
      getAutoSegmentRowActionSnapshot: () => null
    },
    loop: { ensureSelectionHostMarker: () => 'host' },
    progress: { updateLongTaskProgress() {}, dismissLongTaskProgress() {} },
    site: {
      discoverWaveformContainers: () => [container],
      getWaveformHostFromContainer: () => container,
      isAutoInsertLaneSemanticallyVisible: () => true,
      callSelectionBridge: async operation => operation === 'resolve-visible-lane-targets'
        ? { targets: [{ hostMarker: 'host', hasWave: true, processedRecordingId: 'track', speakerKey: 'speaker' }] }
        : { ok: true, foundAudio: true, targetStartSeconds: 2, targetEndSeconds: 3 },
      getRowTimeLabels: () => options.missingLabels ? null : { startText: '2', endText: '3' },
      rememberTimelineSegmentTarget() {},
      findRowByTimeLabels: () => { labelLookups++; return new Row(); },
      findRowByTimeRange: () => { labelLookups++; return new Row(); },
      clamp: (value, min, max) => Math.min(max, Math.max(min, value))
    },
    trim: { trimSegmentTarget: async () => {
      if (options.replaceRow) { row.isConnected = false; row = new Row(); }
      if (options.stale) current = false;
      return options.trimFailure ? { ok: false, reason: 'trim-failed' } : { ok: true };
    } }
  };
  registerAutoInsertSegment(helper, api);
  return { run: () => helper.autoInsertSegmentAtCaret(), focusCalls,
    get row() { return row; }, get createCount() { return createCount; }, get labelLookups() { return labelLookups; } };
}

test('Alt+C focuses the committed blank row even when trimming fails', async t => {
  const f = fixture(t, { trimFailure: true, replaceRow: true });
  const result = await f.run();
  assert.equal(f.createCount, 1);
  assert.equal(result.createCount, 1);
  assert.equal(result.results[0].ok, false);
  assert.equal(result.results[0].trim.reason, 'trim-failed');
  assert.equal(result.results[0].focus.ok, true);
  assert.equal(f.focusCalls.length, 1);
  assert.equal(f.focusCalls[0].target, f.row);
  assert.deepEqual(f.focusCalls[0].settings, { activateRow: true, selectionStart: 0, selectionEnd: 0 });
});

test('Alt+C focuses a created row without timeline labels', async t => {
  const f = fixture(t, { missingLabels: true });
  const result = await f.run();
  assert.equal(result.results[0].trim.reason, 'created-row-not-found');
  assert.equal(result.results[0].focus.ok, true);
  assert.equal(f.focusCalls[0].target, f.row);
});

test('Alt+C never substitutes a time-matching row for the receipt identity', async t => {
  const f = fixture(t, { missingRow: true });
  const result = await f.run();
  assert.equal(result.createCount, 1);
  assert.equal(result.results[0].focus.ok, false);
  assert.equal(f.labelLookups, 0);
  assert.equal(f.focusCalls.length, 0);
});

test('Alt+C preserves stale-task guard after trimming', async t => {
  const f = fixture(t, { stale: true });
  const result = await f.run();
  assert.equal(result.reason, 'stale-task');
  assert.equal(result.createCount, 1);
  assert.equal(f.focusCalls.length, 0);
});

test('Alt+C does not focus or repeat a failed partial creation', async t => {
  const f = fixture(t, { createFailure: true });
  const result = await f.run();
  assert.equal(result.results[0].create.changed, true);
  assert.equal(result.results[0].reason, 'native-commit-failed');
  assert.equal(f.createCount, 1);
  assert.equal(f.focusCalls.length, 0);
});

test('Alt+C focuses once after successful trim and no adjacent merges', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.trimCount, 1);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].focus.ok, true);
  assert.equal(f.createCount, 1);
  assert.equal(f.focusCalls.length, 1);
});
