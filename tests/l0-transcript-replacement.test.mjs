import test from 'node:test';
import assert from 'node:assert/strict';
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

const runtime = {
  ...(await loadEntry('src/services/l0-transcript-replacement-service.ts')),
  ...(await loadEntry('src/content/l0-replace-listener.ts'))
};

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds - minutes * 60).toFixed(3).padStart(6, '0');
  return `00:${String(minutes).padStart(2, '0')}:${remainder}`;
}

function makeRow({ annotationId, processedRecordingId, lane, startSeconds, endSeconds, text }) {
  return {
    children: ['', lane, formatTime(startSeconds), formatTime(endSeconds)],
    textarea: { value: text },
    identity: {
      annotationId,
      processedRecordingId,
      speakerKey: processedRecordingId,
      trackLabel: lane,
      startText: formatTime(startSeconds),
      endText: formatTime(endSeconds)
    }
  };
}

function nativeSnapshotRow(row, index) {
  return {
    index,
    annotationId: row.identity.annotationId,
    processedRecordingId: row.identity.processedRecordingId,
    speakerKey: row.identity.speakerKey,
    trackLabel: row.identity.trackLabel,
    lane: row.children[1],
    startText: row.identity.startText,
    endText: row.identity.endText,
    startSeconds: Number(row.identity.startText.split(':').at(-1)),
    endSeconds: Number(row.identity.endText.split(':').at(-1)),
    text: row.textarea.value
  };
}

function createHelper(options = {}) {
  const rows = [
    makeRow({
      annotationId: 'original-1',
      processedRecordingId: 'track-1',
      lane: 'Speaker 1',
      startSeconds: 0,
      endSeconds: 4,
      text: 'Original one'
    }),
    makeRow({
      annotationId: 'original-2',
      processedRecordingId: 'track-2',
      lane: 'Speaker 2',
      startSeconds: 4,
      endSeconds: 8,
      text: 'Original two'
    })
  ];
  const mutations = [];
  let generatedId = 0;
  let requestedCreateCount = 0;
  const laneByTrack = { 'track-1': 'Speaker 1', 'track-2': 'Speaker 2' };

  return {
    rows,
    mutations,
    async snapshotTranscriptWithNativeBridge() {
      if (options.bridgeFailure) {
        throw new Error('fake bridge failure');
      }
      if (Object.hasOwn(options, 'bridgeResult')) {
        return options.bridgeResult;
      }
      return {
        ok: true,
        backend: 'page-react-transcript-snapshot',
        rows: rows.map(nativeSnapshotRow)
      };
    },
    getTranscriptRows() {
      return rows;
    },
    getRowIdentity(row) {
      if (options.isolatedIdentityIncomplete) {
        return {
          speakerKey: row.identity.trackLabel,
          startText: row.identity.startText,
          endText: row.identity.endText
        };
      }
      return row.identity;
    },
    getRowTextarea(row) {
      return row.textarea;
    },
    findRowByIdentity(identity) {
      return rows.find((row) => row.identity.annotationId === identity.annotationId) || null;
    },
    normalizeText(value) {
      return typeof value === 'string' ? value : '';
    },
    setEditableValue(textarea, text) {
      textarea.value = text;
      mutations.push(['text', text]);
      return true;
    },
    async deleteSegmentWithNativeAction(call) {
      mutations.push(['delete', call.annotationId]);
      const index = rows.findIndex((row) => row.identity.annotationId === call.annotationId);
      if (call.annotationId === options.failDeleteAnnotationId) {
        return { ok: false, reason: 'fake-delete-failure' };
      }
      if (index < 0) return { ok: false, reason: 'not-found' };
      rows.splice(index, 1);
      return { ok: true };
    },
    async createSegmentWithNativeAction(call) {
      const restoring = typeof call.annotationId === 'string' && call.annotationId;
      if (!restoring) requestedCreateCount += 1;
      mutations.push(['create', restoring || null, call.startSeconds, call.processedRecordingId]);
      const shouldFail = !restoring && requestedCreateCount === options.failRequestedCreateNumber;
      if (shouldFail && !options.failCreateAfterMutation) {
        return { ok: false, reason: 'fake-create-failure' };
      }
      const annotationId = restoring || `created-${++generatedId}`;
      rows.push(
        makeRow({
          annotationId,
          processedRecordingId: call.processedRecordingId,
          lane: laneByTrack[call.processedRecordingId],
          startSeconds: call.startSeconds,
          endSeconds: call.endSeconds,
          text: ''
        })
      );
      if (shouldFail) return { ok: false, reason: 'fake-create-failure-after-mutation' };
      return { ok: true, verification: { annotationId } };
    }
  };
}

function request(rows) {
  return {
    type: 'babel-gold-drafting:l0-replace-request',
    version: 1,
    requestId: 'request-1',
    rows
  };
}

const requestedRows = [
  { id: 'later', lane: 'Speaker 2', startSeconds: 3, endSeconds: 7, text: 'Later text' },
  { id: 'first', lane: 'Speaker 1', startSeconds: 0, endSeconds: 3, text: 'First text' }
];

test('valid replacement deletes in reverse order, creates deterministically, and maps identities', async () => {
  const helper = createHelper();
  const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));

  assert.equal(result.ok, true);
  assert.deepEqual(
    helper.mutations.filter(([kind]) => kind === 'delete'),
    [['delete', 'original-2'], ['delete', 'original-1']]
  );
  assert.deepEqual(
    helper.mutations.filter(([kind]) => kind === 'create').map((entry) => entry.slice(2)),
    [[0, 'track-1'], [3, 'track-2']]
  );
  assert.deepEqual(result.created, [
    { id: 'later', annotationId: 'created-2', lane: 'Speaker 2', startSeconds: 3, endSeconds: 7 },
    { id: 'first', annotationId: 'created-1', lane: 'Speaker 1', startSeconds: 0, endSeconds: 3 }
  ]);
  assert.deepEqual(helper.rows.map((row) => row.identity.annotationId), ['created-1', 'created-2']);
});

test('authoritative bridge snapshot replaces despite incomplete isolated React identity', async () => {
  const helper = createHelper({ isolatedIdentityIncomplete: true });
  const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));

  assert.equal(result.ok, true);
  assert.deepEqual(
    helper.mutations.filter(([kind]) => kind === 'delete'),
    [['delete', 'original-2'], ['delete', 'original-1']]
  );
});

test('bridge failure performs zero transcript mutation', async () => {
  const helper = createHelper({ bridgeFailure: true, isolatedIdentityIncomplete: true });
  const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'snapshot-invalid');
  assert.match(result.message, /fake bridge failure/);
  assert.deepEqual(helper.mutations, []);
});

test('malformed bridge snapshot performs zero transcript mutation', async () => {
  const helper = createHelper({
    bridgeResult: {
      ok: true,
      rows: [
        {
          annotationId: 'original-1',
          processedRecordingId: '',
          speakerKey: 'track-1',
          trackLabel: 'Speaker 1',
          lane: 'Speaker 1',
          startText: '00:00:00.000',
          endText: '00:00:04.000',
          startSeconds: 0,
          endSeconds: 4,
          text: 'Original one'
        }
      ]
    }
  });
  const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'snapshot-invalid');
  assert.match(result.message, /incomplete annotation or speaker identity/);
  assert.deepEqual(helper.mutations, []);
});

test('request and lane validation finish before the first native mutation', async () => {
  const helper = createHelper();
  const duplicate = request([
    requestedRows[0],
    { ...requestedRows[1], id: requestedRows[0].id }
  ]);
  const duplicateResult = await runtime.replaceTranscriptSegmentation(helper, duplicate);
  assert.equal(duplicateResult.reason, 'duplicate-row-id');
  assert.deepEqual(helper.mutations, []);

  const missingLaneResult = await runtime.replaceTranscriptSegmentation(
    helper,
    request([{ ...requestedRows[0], lane: 'Speaker 3' }])
  );
  assert.equal(missingLaneResult.reason, 'lane-not-found');
  assert.deepEqual(helper.mutations, []);
});

test('partial deletion failure recreates the deleted original row and text before failing', async () => {
  const helper = createHelper({ failDeleteAnnotationId: 'original-1' });
  const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'delete-failed');
  assert.match(result.message, /Original transcript restored/);
  assert.deepEqual(
    helper.rows.map((row) => [row.identity.annotationId, row.textarea.value]).sort(),
    [['original-1', 'Original one'], ['original-2', 'Original two']]
  );
});

test('creation failure removes new rows and restores every original identity and text', async () => {
  const helper = createHelper({ failRequestedCreateNumber: 2, failCreateAfterMutation: true });
  const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'create-failed');
  assert.match(result.message, /Original transcript restored/);
  assert.deepEqual(
    helper.rows.map((row) => [row.identity.annotationId, row.textarea.value]).sort(),
    [['original-1', 'Original one'], ['original-2', 'Original two']]
  );
  assert.ok(helper.mutations.some(([kind, id]) => kind === 'delete' && id === 'created-1'));
  assert.ok(helper.mutations.some(([kind, id]) => kind === 'delete' && id === 'created-2'));
});

class FakeWindow extends EventTarget {
  constructor() {
    super();
    this.responses = [];
  }

  postMessage(value) {
    this.responses.push(value);
  }

  send(data, source = this) {
    const event = new Event('message');
    Object.defineProperties(event, {
      data: { value: data },
      source: { value: source }
    });
    this.dispatchEvent(event);
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('listener replacement and disposal prevent duplicate boot handlers', async () => {
  const protocolWindow = new FakeWindow();
  const staleHelper = createHelper();
  const activeHelper = createHelper();

  const disposeStale = runtime.registerL0ReplaceListener(staleHelper, protocolWindow);
  const disposeActive = runtime.registerL0ReplaceListener(activeHelper, protocolWindow);
  protocolWindow.send(request(requestedRows), {});
  await settle();
  assert.equal(protocolWindow.responses.length, 0);
  assert.deepEqual(activeHelper.mutations, []);

  protocolWindow.send(request(requestedRows));
  await settle();
  assert.equal(protocolWindow.responses.length, 1);
  assert.deepEqual(staleHelper.mutations, []);
  assert.notDeepEqual(activeHelper.mutations, []);

  disposeStale();
  disposeActive();
  protocolWindow.send({ ...request(requestedRows), requestId: 'request-after-stop' });
  await settle();
  assert.equal(protocolWindow.responses.length, 1);
});
