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
  ...(await loadEntry('src/features/transcript-replacement.ts')),
  ...(await loadEntry('src/content/l0-replace-listener.ts'))
};

// The guard runs in the isolated content-script world: page React fibers are
// invisible there, so the only task identity is Gold's publication on <html>.
let publishedReviewActionId;
test.beforeEach((t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  publishedReviewActionId = 'task-one';
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: { getAttribute: () => publishedReviewActionId }
    }
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
});

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
    state: { sessionLifecycleRevision: 1 },
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
        lanes: Object.entries(laneByTrack).map(([id, label]) => ({ processedRecordingId: id, trackLabel: label })),
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
      mutations.push([
        'create',
        restoring || null,
        call.startSeconds,
        call.processedRecordingId,
        call.text
      ]);
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
          text: call.text
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

test('replacement without a starting task identity performs no snapshot or mutation', async () => {
  publishedReviewActionId = '';
  const helper = createHelper();
  let snapshots = 0;
  helper.snapshotTranscriptWithNativeBridge = async () => {
    snapshots += 1;
    publishedReviewActionId = 'task-two';
    throw new Error('An unidentified task must not reach the bridge');
  };
  const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-task');
  assert.equal(snapshots, 0);
  assert.deepEqual(helper.mutations, []);
  assert.deepEqual(helper.rows.map(row => row.textarea.value), ['Original one', 'Original two']);
});

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
    [[0, 'track-1', 'First text'], [3, 'track-2', 'Later text']]
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

test('replacement creates segments on a waveform lane with no existing annotations', async () => {
  const helper = createHelper();
  helper.rows.splice(1, 1);
  const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(helper.mutations.filter(([kind]) => kind === 'delete'), [['delete', 'original-1']]);
  assert.deepEqual(helper.rows.map((row) => row.identity.processedRecordingId), ['track-1', 'track-2']);
});

test('replacement populates an empty transcript using native waveform lane identities', async () => {
  const helper = createHelper();
  helper.rows.splice(0);
  const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(helper.mutations.filter(([kind]) => kind === 'delete'), []);
  assert.deepEqual(helper.rows.map(row => row.textarea.value).sort(), requestedRows.map(row => row.text).sort());
  assert.deepEqual(helper.rows.map(row => row.identity.processedRecordingId), ['track-1', 'track-2']);
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
  assert.deepEqual(
    helper.mutations.filter(([kind]) => kind === 'create'),
    [['create', 'original-2', 4, 'track-2', 'Original two']]
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
  assert.deepEqual(
    helper.mutations
      .filter(([kind, annotationId]) => kind === 'create' && annotationId)
      .map((entry) => entry.slice(1)),
    [
      ['original-1', 0, 'track-1', 'Original one'],
      ['original-2', 4, 'track-2', 'Original two']
    ]
  );
});

function rowSummary(row) {
  return [row.identity.annotationId, row.textarea.value];
}

test('navigation during replacement or rollback leaves the new task untouched', async (t) => {
  const scenarios = [
    {
      name: 'original deletion',
      method: 'deleteSegmentWithNativeAction',
      pause: (call) => call.annotationId === 'original-2'
    },
    {
      name: 'requested creation',
      method: 'createSegmentWithNativeAction',
      pause: (call) => !call.annotationId
    },
    {
      name: 'empty new task on the same route',
      method: 'createSegmentWithNativeAction',
      pause: (call) => !call.annotationId,
      emptyNewTask: true
    },
    {
      name: 'failed mutation before rollback',
      options: { failRequestedCreateNumber: 1 },
      method: 'createSegmentWithNativeAction',
      pause: (call) => !call.annotationId
    },
    {
      name: 'rollback cleanup',
      options: { failRequestedCreateNumber: 2 },
      method: 'deleteSegmentWithNativeAction',
      pause: (call) => call.annotationId === 'created-1'
    },
    {
      name: 'rollback snapshot',
      options: { failDeleteAnnotationId: 'original-1' },
      method: 'snapshotTranscriptWithNativeBridge',
      pause: (_call, count) => count === 2
    },
    {
      name: 'rollback recreation before text restoration',
      options: { failRequestedCreateNumber: 2 },
      method: 'createSegmentWithNativeAction',
      pause: (call) => call.annotationId === 'original-1'
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const helper = createHelper(scenario.options);
      const nativeOperation = helper[scenario.method].bind(helper);
      let announcePause;
      let resume;
      const paused = new Promise((resolve) => { announcePause = resolve; });
      const resumed = new Promise((resolve) => { resume = resolve; });
      let callCount = 0;
      helper[scenario.method] = async (call) => {
        const result = await nativeOperation(call);
        if (scenario.pause(call, ++callCount)) {
          announcePause();
          await resumed;
        }
        return result;
      };

      const replacement = runtime.replaceTranscriptSegmentation(helper, request(requestedRows));
      await paused;
      helper.state.sessionLifecycleRevision += 1;
      publishedReviewActionId = 'task-two';
      // Reuse an original annotation identity to expose accidental text restoration,
      // and keep a distinct row to expose stray-annotation cleanup on a foreign task.
      helper.rows.splice(0, helper.rows.length,
        makeRow({
          annotationId: 'original-1',
          processedRecordingId: 'track-1',
          lane: 'Speaker 1',
          startSeconds: 0,
          endSeconds: 4,
          text: 'New task text'
        }),
        makeRow({
          annotationId: 'new-task-row',
          processedRecordingId: 'track-2',
          lane: 'Speaker 2',
          startSeconds: 4,
          endSeconds: 8,
          text: 'Keep this new task row'
        })
      );
      if (scenario.emptyNewTask) helper.rows.length = 0;
      const newTaskRows = helper.rows.map(rowSummary);
      const mutationsBeforeResume = helper.mutations.length;
      resume();

      const result = await replacement;
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'stale-task');
      assert.match(result.message, /rollback stopped/i);
      assert.doesNotMatch(result.message, /Original transcript restored/);
      const finalRows = helper.rows.map(rowSummary);
      assert.deepEqual(finalRows, newTaskRows, 'the new task is untouched');
      const afterResume = helper.mutations.slice(mutationsBeforeResume);
      assert.deepEqual(afterResume, [], 'no mutations are issued after navigation');
    });
  }
});

test('a task change before the first mutation reports stale-task without touching the transcript', async () => {
  const helper = createHelper();
  const snapshot = await helper.snapshotTranscriptWithNativeBridge();
  let finishSnapshot;
  helper.snapshotTranscriptWithNativeBridge = () => new Promise((resolve) => { finishSnapshot = resolve; });
  const replacement = runtime.replaceTranscriptSegmentation(helper, request(requestedRows));
  publishedReviewActionId = 'task-two';
  finishSnapshot(snapshot);

  const result = await replacement;
  assert.equal(result.reason, 'stale-task');
  assert.match(result.message, /No transcript changes were made/);
  assert.deepEqual(helper.mutations, []);
});

test('same-task empty rebuild and lifecycle refresh preserve replacement and rollback', async (t) => {
  for (const failCreation of [false, true]) {
    await t.test(failCreation ? 'rollback' : 'replacement', async () => {
      const helper = createHelper(failCreation ? { failRequestedCreateNumber: 2 } : {});
      const nativeDelete = helper.deleteSegmentWithNativeAction.bind(helper);
      let emptied = false;
      helper.deleteSegmentWithNativeAction = async (call) => {
        const result = await nativeDelete(call);
        if (!helper.rows.length) {
          emptied = true;
          helper.state.sessionLifecycleRevision += 1;
          // Gold's row-based publication can disappear while the native
          // workbench remains on the same action with no transcript rows.
          publishedReviewActionId = '';
        }
        return result;
      };
      publishedReviewActionId = 'task-one';
      const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));
      assert.equal(emptied, true);
      if (failCreation) {
        assert.equal(result.reason, 'create-failed');
        assert.deepEqual(
          helper.rows.map(rowSummary).sort(),
          [['original-1', 'Original one'], ['original-2', 'Original two']]
        );
      } else {
        assert.equal(result.ok, true);
        assert.deepEqual(helper.rows.map((row) => row.textarea.value), ['First text', 'Later text']);
      }
    });
  }
});

test('a lost publication, remounted rows, or a same-route URL change mid-replacement never aborts', async (t) => {
  const churn = {
    'Gold removes the publication while rows are gone': () => {
      publishedReviewActionId = '';
    },
    'the publication is unreadable': () => {
      document.documentElement.getAttribute = () => { throw new Error('detached document'); };
    },
    'rows remount as fresh objects': (helper) => {
      helper.rows.splice(0, helper.rows.length, ...helper.rows.map((row) => structuredClone(row)));
    },
    'the URL search and hash change on the same route': () => {
      globalThis.location.search = '?jobId=refetched';
      globalThis.location.hash = '#row-3';
      globalThis.location.href = 'https://babel.test/transcription?jobId=refetched#row-3';
    }
  };
  for (const [name, disturb] of Object.entries(churn)) {
    await t.test(name, async (t) => {
      const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { href: 'https://babel.test/transcription?jobId=one', pathname: '/transcription', search: '?jobId=one', hash: '' }
      });
      t.after(() => {
        if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
        else delete globalThis.location;
      });
      const helper = createHelper();
      const nativeCreate = helper.createSegmentWithNativeAction.bind(helper);
      let disturbed = false;
      helper.createSegmentWithNativeAction = async (call) => {
        const result = await nativeCreate(call);
        if (!disturbed) {
          disturbed = true;
          disturb(helper);
        }
        return result;
      };
      const result = await runtime.replaceTranscriptSegmentation(helper, request(requestedRows));
      assert.equal(disturbed, true);
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(helper.rows.map((row) => row.textarea.value), ['First text', 'Later text']);
    });
  }
});

test('a pathname change aborts before lifecycle state catches up', async (t) => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const taskLocation = { href: 'https://babel.test/transcription?jobId=one', pathname: '/transcription', search: '?jobId=one' };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: taskLocation });
  t.after(() => {
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete globalThis.location;
  });
  const helper = createHelper();
  const snapshot = await helper.snapshotTranscriptWithNativeBridge();
  let finishSnapshot;
  helper.snapshotTranscriptWithNativeBridge = () => new Promise((resolve) => { finishSnapshot = resolve; });
  const replacement = runtime.replaceTranscriptSegmentation(helper, request(requestedRows));
  taskLocation.href = 'https://babel.test/projects';
  taskLocation.pathname = '/projects';
  taskLocation.search = '';
  const untouchedRows = helper.rows.map(rowSummary);
  finishSnapshot(snapshot);

  const result = await replacement;
  assert.equal(result.reason, 'stale-task');
  assert.deepEqual(helper.rows.map(rowSummary), untouchedRows);
  assert.deepEqual(helper.mutations, []);
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
