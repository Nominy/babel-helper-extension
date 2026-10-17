import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function loadEntry(entryPoint) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

const { createRowTimeApi } = await loadEntry('src/site/row-time.ts');
const { createTimelineSiteApi } = await loadEntry('src/site/timeline.ts');
const { registerSmartSplit } = await loadEntry('src/features/smart-split.ts');
const { registerSelectionLoop } = await loadEntry('src/features/selection-loop.ts');
const { registerSegmentTranscription } = await loadEntry('src/features/segment-transcription.ts');

const { registerAutoSegmentation } = await loadEntry('src/features/auto-segmentation.ts');
const { registerTimelineEdgeAdjustment } = await loadEntry('src/features/timeline-edge-adjustment.ts');
class Section {
  constructor(annotationId, speakerKey, startSeconds, endSeconds) {
    this.isConnected = true;
    this.dataset = { annotationId };
    this.identity = { annotationId, speakerKey, reviewActionId: 'task-one', startSeconds, endSeconds, startText: `00:00:${startSeconds.toFixed(3)}`, endText: `00:00:${endSeconds.toFixed(3)}` };
  }
}

function harness(t, rows) {
  let taskId = 'task-one';
  for (const [name, value] of Object.entries({
    HTMLElement: Section,
    window: { devicePixelRatio: 1 },
    document: { documentElement: { getAttribute: name => name === 'data-babel-audio-enhancement' ? null : taskId } },
    location: { pathname: '/tasks/one' }
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => old ? Object.defineProperty(globalThis, name, old) : delete globalThis[name]);
  }
  const helper = {
    state: { nativeSessionAdmission: { reviewActionId: taskId }, sessionLifecycleRevision: 1 },
    getTranscriptRows: () => rows,
    getRowIdentity: row => row?.identity || null,
    getRowSpeakerKey: row => row?.identity.speakerKey || '',
    rowMatchesIdentity: (row, identity) => row.identity.annotationId === identity.annotationId && row.identity.reviewActionId === identity.reviewActionId,
    findRowByIdentity: identity => rows.find(row => row.isConnected && row.identity.annotationId === identity.annotationId && row.identity.reviewActionId === identity.reviewActionId) || null,
    getRowTextValue: () => 'alpha beta gamma',
    setTask: value => {
      taskId = value;
      helper.state.nativeSessionAdmission = { reviewActionId: value };
      helper.state.sessionLifecycleRevision++;
    }
  };
  return helper;
}

test('readonly native turns supply exact numeric timing without columns or textboxes', t => {
  const row = new Section('one', 'track-1', 1.234567, 2.345678);
  const helper = harness(t, [row]);
  const time = createRowTimeApi(helper);
  const timeline = createTimelineSiteApi(helper);
  assert.deepEqual(time.getRowTimeRange(row), { startSeconds: 1.234567, endSeconds: 2.345678 });
  assert.deepEqual(timeline.getRowTimeRange(row), time.getRowTimeRange(row));
  assert.equal(timeline.findRowByTimeRange(1.3, 2, { speakerKey: 'track-1' }), row);
  assert.equal(timeline.findRowByTimeRange(1.3, 2, { speakerKey: 'track-2' }), null);
  assert.equal(helper.getTranscriptRows()[0], row);
});

test('middle-turn timing changes invalidate playback cache while lane filtering remains exact', t => {
  const rows = [new Section('one', 'track-1', 0, 2), new Section('two', 'track-1', 3, 4), new Section('three', 'track-2', 3, 8)];
  const helper = harness(t, rows);
  const time = createRowTimeApi(helper);
  assert.equal(time.findRowEntryByPlaybackTime(5, { speakerKey: 'track-1' }), null);
  rows[1].identity.endSeconds = 6;
  helper.invalidateRowTimeCache(); // Native commit invalidation is supplied by the row-site layer.
  assert.equal(time.findRowEntryByPlaybackTime(5, { speakerKey: 'track-1' }).row, rows[1]);
  assert.equal(time.findRowEntryByPlaybackTime(5, { speakerKey: 'track-2' }).row, rows[2]);
  assert.equal(time.findRowEntryByPlaybackTime(6, { speakerKey: 'track-1' }), null);
});

test('empty native tasks stay empty without a secondary DOM scan', t => {
  const helper = harness(t, []);
  const getRows = helper.getTranscriptRows;
  createRowTimeApi(helper);
  const timeline = createTimelineSiteApi(helper);
  assert.equal(helper.getTranscriptRows, getRows);
  assert.deepEqual(helper.getTranscriptRows(), []);
  assert.equal(timeline.findRowByTimeRange(1, 2), null);
});

test('smart split preserves raw native text and estimates missing clocks without using a stale caret', t => {
  const row = new Section('one', 'track-1', 0, 10);
  const helper = harness(t, [row]);
  const editor = { row, element: {}, value: ' [смех] alpha beta ', selectionStart: 8, readOnly: false };
  helper.getRowTextValue = () => editor.value;
  helper.getActiveRowEditor = () => { assert.fail('caret state is not timing evidence'); };
  helper.getGhostCursorTarget = () => { assert.fail('ghost state is not cut timing evidence'); };
  createRowTimeApi(helper);
  const split = registerSmartSplit(helper, {
    site: { getRowTimeRange: helper.getRowTimeRange, clamp: (value, min, max) => Math.max(min, Math.min(max, value)) },
    segmentation: { AUTO_SEGMENT_SPLIT_EDGE_GUARD_SECONDS: 0.01, getL0TimingLaneAliases: () => ({ stableId: 'track-1' }) }
  });
  const plan = split.buildSmartSplitPlanForRow(row, 5);
  assert.equal(split.getSmartSplitTextParts(plan).firstText, '[смех] alpha');
  assert.equal(split.getSmartSplitTextParts(plan).secondText, 'beta');
  assert.equal(plan.sourceText, editor.value, 'native split precondition retains exact unsaved raw text');
  helper.setTask('another-task');
  assert.equal(split.getSmartSplitTextParts(plan), null, 'a retired source plan still cannot mutate another task');
});

test('transcription refuses readonly native EditorControls before requesting AI', async t => {
  const row = new Section('one', 'track-1', 0, 10);
  const helper = harness(t, [row]);
  helper.getRowEditor = () => ({ row, readOnly: true });
  registerSegmentTranscription(helper, { site: { findCurrentSegmentTarget: () => ({ row }) } });
  assert.deepEqual(await helper.transcribeCurrentSegmentWithL0(), { ok: false, reason: 'read-only' });
});

test('selection loop does not restart after task navigation during native time resolution', async t => {
  const helper = harness(t, []);
  let resolveRange;
  let starts = 0;
  const preview = {};
  const api = {
    site: { callSelectionBridge: () => { starts++; }, getWaveformHostFromContainer: () => { throw new Error('stale task reached waveform'); } },
    selection: { ensurePreviewTimeRange: () => new Promise(resolve => { resolveRange = resolve; }) }
  };
  registerSelectionLoop(helper, api);
  helper.state.cutPreview = preview;
  const pending = helper.startSelectionLoop();
  helper.setTask('task-two');
  resolveRange({ startSeconds: 1, endSeconds: 2 });
  assert.equal(await pending, false);
  assert.equal(starts, 0);
  assert.equal(helper.state.selectionLoop, null);
});

test('auto segmentation resolves lanes from native metadata without speaker columns', t => {
  const row = new Section('one', 'recording-id', 0, 10);
  row.identity.processedRecordingId = 'recording-id';
  row.identity.trackLabel = 'Speaker 1';
  const helper = harness(t, [row]);
  const segmentation = registerAutoSegmentation(helper, {});
  const aliases = segmentation.getL0TimingLaneAliases(row, 'Speaker 1');
  assert.equal(aliases.stableId, 'recording-id');
  assert.ok(aliases.fallbackAliases.includes('Speaker 1'));
});

test('Alt-click timing response cannot move a boundary after task navigation', async t => {
  const helper = harness(t, []);
  const container = new Section('wave', 'track-1', 0, 10);
  container.getBoundingClientRect = () => ({ left: 0, width: 100 });
  registerTimelineEdgeAdjustment(helper, {
    site: {
      isVisibleWaveformContainer: () => true,
      clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
      callSelectionBridge: async () => {
        helper.setTask('task-two');
        return { ok: true, startSeconds: 2 };
      }
    },
    loop: { ensureSelectionHostMarker: () => 'old-wave' }
  });
  assert.deepEqual(
    await helper.adjustNearestTimelineSegmentEdgeFromAltClick({ container }, { clientX: 20 }),
    { ok: false, reason: 'stale-task' }
  );
});
