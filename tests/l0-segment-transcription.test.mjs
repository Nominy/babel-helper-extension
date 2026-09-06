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
      request: async (request) =>
        request.operation === 'ping'
          ? { ok: true, capabilities: { transcribeSegmentL0: true } }
          : { ok: true, result: { text: 'привет, мир.' } },
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
  const requests = [];
  const setup = createOptions({
    request: async (value) => {
      requests.push(value);
      return value.operation === 'ping'
        ? { ok: true, capabilities: { transcribeSegmentL0: true } }
        : { ok: true, provider: 'local-l0', result: { text: 'привет, мир.' } };
    }
  });
  const result = await service.transcribeEmptySegmentWithL0(setup.options);

  assert.deepEqual(requests, [
    { operation: 'ping' },
    {
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
    }
  ]);
  assert.deepEqual(result, { ok: true, changed: true, textLength: 12 });
  assert.deepEqual(setup.writes, [{ current: setup.row, text: 'Привет, мир.' }]);
});

test('task, row, and emptiness are revalidated after waiting for L0', async () => {
  for (const scenario of ['task', 'row', 'nonempty']) {
    let finish;
    const response = new Promise((resolve) => { finish = resolve; });
    const setup = createOptions({
      request: (request) =>
        request.operation === 'ping'
          ? Promise.resolve({ ok: true, capabilities: { transcribeSegmentL0: true } })
          : response
    });
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

test('false L0 capability stops after ping and forbids legacy fallback', async () => {
  const requests = [];
  const setup = createOptions({
    request: async (request) => {
      requests.push(request);
      return { ok: true, capabilities: { transcribeSegmentL0: false } };
    }
  });

  const result = await service.transcribeEmptySegmentWithL0(setup.options);

  assert.deepEqual(requests, [{ operation: 'ping' }]);
  assert.deepEqual(result, {
    ok: false,
    reason: 'l0-provider-unavailable',
    fallbackAllowed: false,
    broker: { ok: true, capabilities: { transcribeSegmentL0: false } }
  });
  assert.equal(setup.writes.length, 0);
});

test('timeline selection returns unavailable capability before timing wait or legacy mutation', () => {
  const source = readFileSync('src/services/timeline-selection-service.ts', 'utf8');
  const waitStart = source.indexOf('async function waitForAutoSegmentL0Timing()');
  const waitEnd = source.indexOf('helper.autoSegmentVisibleSilences = async function', waitStart);
  const waitBlock = source.slice(waitStart, waitEnd);
  const autoStart = waitEnd;
  const preTrim = source.indexOf('const preTrimResult = await helper.trimAllSegmentsToAudio', autoStart);
  const autoPrepareBlock = source.slice(autoStart, preTrim);

  assert.ok(waitStart >= 0 && waitEnd > waitStart && preTrim > autoStart);
  assert.ok(
    waitBlock.indexOf('hasL0SegmentBrokerCapability(brokerAvailability)') <
      waitBlock.indexOf('while (Date.now() - startedAt')
  );
  assert.match(autoPrepareBlock, /reason === 'timing-provider-unavailable'/);
  assert.match(autoPrepareBlock, /return \{ ok: false, reason: 'timing-provider-unavailable', splitCount: 0 \}/);
  assert.doesNotMatch(waitBlock, /useLegacy: true/);
});

