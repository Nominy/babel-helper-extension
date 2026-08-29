import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

async function loadEntry(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'silent'
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64');
  return import(`data:text/javascript;base64,${source}`);
}

const service = await loadEntry('src/services/l0-segment-transcription.ts');

function createOptions(overrides = {}) {
  const row = { empty: true };
  const writes = [];
  return {
    row,
    writes,
    options: {
      taskId: 'canonical-task',
      rowIdentity: { annotationId: 'row-1' },
      rowId: 'row-1',
      speakerKey: 'recording-a',
      startSeconds: 2,
      endSeconds: 4,
      index: 3,
      request: async () => ({ ok: true, result: { text: 'привет, мир.' } }),
      getCurrentTaskId: () => 'canonical-task',
      resolveCurrentRow: () => row,
      isRowEmpty: (current) => current.empty,
      writeRowText: (current, text) => {
        writes.push({ current, text });
        return true;
      },
      ...overrides
    }
  };
}

test('free L0 segment transcription sends the canonical row request and writes once', async () => {
  let request = null;
  const setup = createOptions({
    request: async (value) => {
      request = value;
      return { ok: true, provider: 'local-l0', result: { text: 'привет, мир.' } };
    }
  });
  const result = await service.transcribeEmptySegmentWithL0(setup.options);

  assert.deepEqual(request, {
    operation: 'transcribeSegmentL0',
    taskId: 'canonical-task',
    row: {
      rowId: 'row-1',
      speakerKey: 'recording-a',
      startSeconds: 2,
      endSeconds: 4,
      text: '',
      index: 3
    }
  });
  assert.deepEqual(result, { ok: true, changed: true, textLength: 12 });
  assert.deepEqual(setup.writes, [{ current: setup.row, text: 'Привет, мир.' }]);
});

test('task, row, and emptiness are revalidated after waiting for L0', async () => {
  for (const scenario of ['task', 'row', 'nonempty']) {
    let finish;
    const response = new Promise((resolve) => { finish = resolve; });
    const setup = createOptions({ request: () => response });
    const pending = service.transcribeEmptySegmentWithL0(setup.options);
    if (scenario === 'task') setup.options.getCurrentTaskId = () => 'another-task';
    if (scenario === 'row') setup.options.resolveCurrentRow = () => null;
    if (scenario === 'nonempty') setup.row.empty = false;
    finish({ ok: true, result: { text: 'late text.' } });
    const result = await pending;
    assert.equal(result.ok, false, scenario);
    assert.equal(setup.writes.length, 0, scenario);
  }
});

test('Alt+Shift+G prefers transcribeSegmentL0 and keeps legacy fallback outside the L0 request module', () => {
  const source = readFileSync('src/services/timeline-selection-service.ts', 'utf8');
  const segmentSource = readFileSync('src/services/l0-segment-transcription.ts', 'utf8');
  const start = source.indexOf('helper.transcribeCurrentSegmentWithL0 = async function transcribeCurrentSegmentWithL0()');
  const end = source.indexOf('helper.trimCurrentSegmentToAudio = async function trimCurrentSegmentToAudio', start);
  const block = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(segmentSource, /operation: 'transcribeSegmentL0'/);
  assert.match(block, /buildCurrentL0TimingTaskId\(helper\)/);
  assert.match(block, /transcribeEmptySegmentWithL0/);
  assert.match(block, /transcribeCurrentSegmentWithLegacyModel\(\)/);
  assert.doesNotMatch(block, /operation: 'transcribeSegment'/);
  assert.doesNotMatch(block, /transcribe-segment-audio|callSelectionBridge|OpenRouter|Gemini|Prompt/);
});
