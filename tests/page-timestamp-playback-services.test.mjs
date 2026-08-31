import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function importBundledTs(relativePath, label) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `babel-helper-${label}-`));
  const outfile = path.join(tempDir, `${label}.mjs`);
  await build({
    entryPoints: [path.join(repoRoot, relativePath)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020'
  });

  try {
    return await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

class FakeCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

class FakeElement {}
class FakeHTMLElement extends FakeElement {}
class FakeHTMLDivElement extends FakeHTMLElement {}
class FakeHTMLMediaElement extends FakeHTMLElement {}
class FakeHTMLTableRowElement extends FakeHTMLElement {}
class FakeShadowRoot {}

function installPageGlobals(services) {
  const pageWindow = new EventTarget();
  const pageDocument = {
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  Object.assign(pageWindow, {
    BabelMods: { unsafe: { services } },
    document: pageDocument,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setTimeout,
    clearTimeout,
    window: pageWindow
  });
  Object.assign(globalThis, {
    CustomEvent: FakeCustomEvent,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    HTMLDivElement: FakeHTMLDivElement,
    HTMLMediaElement: FakeHTMLMediaElement,
    HTMLTableRowElement: FakeHTMLTableRowElement,
    ShadowRoot: FakeShadowRoot,
    document: pageDocument,
    window: pageWindow
  });

  return pageWindow;
}

function callEventFacade(pageWindow, requestType, responseType, operation, payload = {}) {
  const id = `${operation}-${Math.random()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pageWindow.removeEventListener(responseType, onResponse);
      reject(new Error(`Timed out waiting for ${responseType}`));
    }, 250);
    function onResponse(event) {
      if (event.detail?.id !== id) {
        return;
      }
      clearTimeout(timeout);
      pageWindow.removeEventListener(responseType, onResponse);
      resolve(event.detail.result);
    }

    pageWindow.addEventListener(responseType, onResponse);
    pageWindow.dispatchEvent(
      new FakeCustomEvent(requestType, {
        detail: { id, operation, payload }
      })
    );
  });
}

test('timestamp and playback facades stay late-bound across mod layers and teardown', async () => {
  const { createServiceRegistry } = await importBundledTs(
    'src/mod-platform/service-registry.ts',
    'page-service-registry'
  );
  const services = createServiceRegistry();
  const pageWindow = installPageGlobals(services);

  await importBundledTs('src/content/playback-bridge.ts', 'playback-bridge');
  await importBundledTs('src/content/timestamp-bridge.ts', 'timestamp-bridge');

  const playbackFacade = pageWindow.__babelHelperPlaybackBridge;
  const timestampFacade = pageWindow.__babelHelperTimestampBridge;
  assert.equal(playbackFacade.getPlaybackState().reason, 'playback-unavailable');
  assert.equal(
    (await timestampFacade.setBoundaryTime({ targetSeconds: Number.NaN })).reason,
    'invalid-target'
  );

  const playbackDecorator = services.decorate(
    'page.playback',
    (next) => ({
      ...next,
      getPlaybackState() {
        return { ...next.getPlaybackState(), decoratedBy: 'mod.playback' };
      }
    }),
    { owner: 'mod.playback' }
  );
  assert.equal(playbackFacade.getPlaybackState().decoratedBy, 'mod.playback');
  assert.equal(
    (
      await callEventFacade(
        pageWindow,
        'babel-helper-playback-request',
        'babel-helper-playback-response',
        'state'
      )
    ).decoratedBy,
    'mod.playback'
  );
  playbackDecorator.dispose();
  assert.equal(playbackFacade.getPlaybackState().decoratedBy, undefined);
  assert.equal(playbackFacade.getPlaybackState().reason, 'playback-unavailable');
  assert.equal(
    (
      await callEventFacade(
        pageWindow,
        'babel-helper-playback-request',
        'babel-helper-playback-response',
        'state'
      )
    ).reason,
    'playback-unavailable'
  );

  const timestampReplacement = services.replace(
    'page.timestamp',
    {
      setBoundaryTime(payload) {
        return { ok: true, replacedBy: 'mod.timestamp', payload };
      }
    },
    { owner: 'mod.timestamp' }
  );
  assert.equal(
    (await timestampFacade.setBoundaryTime({ targetSeconds: 12 })).replacedBy,
    'mod.timestamp'
  );
  assert.equal(
    (
      await callEventFacade(
        pageWindow,
        'babel-helper-timestamp-request',
        'babel-helper-timestamp-response',
        'set-boundary-time',
        { targetSeconds: 12 }
      )
    ).replacedBy,
    'mod.timestamp'
  );
  timestampReplacement.dispose();
  assert.equal(
    (await timestampFacade.setBoundaryTime({ targetSeconds: Number.NaN })).reason,
    'invalid-target'
  );
  assert.equal(
    (
      await callEventFacade(
        pageWindow,
        'babel-helper-timestamp-request',
        'babel-helper-timestamp-response',
        'set-boundary-time',
        { targetSeconds: Number.NaN }
      )
    ).reason,
    'invalid-target'
  );

  const survivingDecorator = services.decorate(
    'page.playback',
    (next) => ({
      ...next,
      getPlaybackState() {
        return { ...next.getPlaybackState(), decoratedAfterReprovide: true };
      }
    }),
    { owner: 'mod.survivor' }
  );
  pageWindow.dispatchEvent(new FakeCustomEvent('babel-helper-bridge-teardown'));
  assert.equal(pageWindow.__babelHelperPlaybackBridge, undefined);
  assert.equal(pageWindow.__babelHelperTimestampBridge, undefined);
  assert.throws(() => services.invoke('page.playback', 'getPlaybackState'));

  const replacementBase = services.provide(
    'page.playback',
    {
      getPlaybackState() {
        return { ok: true, source: 'replacement-base' };
      }
    },
    { owner: 'test:replacement-base' }
  );
  assert.deepEqual(services.invoke('page.playback', 'getPlaybackState'), {
    ok: true,
    source: 'replacement-base',
    decoratedAfterReprovide: true
  });
  replacementBase.dispose();
  survivingDecorator.dispose();
});

test('MAIN snapshot retains create binding for rollback after all rows are deleted', async () => {
  const { createServiceRegistry } = await importBundledTs(
    'src/mod-platform/service-registry.ts',
    'snapshot-service-registry'
  );
  const services = createServiceRegistry();
  const pageWindow = installPageGlobals(services);
  let transcriptRows = [];
  const createdAnnotations = [];
  const makeLiveRow = (annotation, text) => {
    const textarea = new FakeHTMLElement();
    textarea.value = text;
    const cells = ['', annotation.trackLabel, '00:00:00.840', '00:00:29.826'].map(
      (textContent) => {
        const cell = new FakeHTMLElement();
        cell.textContent = textContent;
        return cell;
      }
    );
    const row = new FakeHTMLTableRowElement();
    row.children = cells;
    row.querySelector = () => textarea;
    row.__reactFiber$live = {
      return: {
        memoizedProps: {
          annotation,
          onTimeChange() {},
          onCreateAnnotation(createdAnnotation) {
            createdAnnotations.push(createdAnnotation);
            transcriptRows = [makeLiveRow(createdAnnotation, createdAnnotation.content)];
          }
        },
        return: null
      }
    };
    return row;
  };
  const originalAnnotation = {
    id: 'f4ecee57-live',
    processedRecordingId: '01a03c7b-live',
    trackLabel: 'Speaker 2',
    startTimeInSeconds: 0.84,
    endTimeInSeconds: 29.826
  };
  transcriptRows = [makeLiveRow(originalAnnotation, 'Live transcript text')];
  pageWindow.document.querySelectorAll = (selector) =>
    selector === 'tbody tr' ? transcriptRows : [];

  await importBundledTs('src/content/timestamp-bridge.ts', 'snapshot-timestamp-bridge');
  const direct = pageWindow.__babelHelperTimestampBridge.snapshotTranscript();
  assert.deepEqual(direct, {
    ok: true,
    backend: 'page-react-transcript-snapshot',
    rows: [
      {
        index: 0,
        annotationId: 'f4ecee57-live',
        processedRecordingId: '01a03c7b-live',
        trackLabel: 'Speaker 2',
        speakerKey: '01a03c7b-live',
        lane: 'Speaker 2',
        startText: '00:00:00.840',
        endText: '00:00:29.826',
        startSeconds: 0.84,
        endSeconds: 29.826,
        text: 'Live transcript text'
      }
    ]
  });

  const { registerTimestampEditService } = await importBundledTs(
    'src/services/timestamp-edit-service.ts',
    'snapshot-timestamp-client'
  );
  const isolatedHelper = {};
  registerTimestampEditService(isolatedHelper);
  assert.deepEqual(await isolatedHelper.snapshotTranscriptWithNativeBridge(), direct);

  transcriptRows = [];
  const recreated = await isolatedHelper.createSegmentWithNativeAction({
    annotationId: originalAnnotation.id,
    processedRecordingId: originalAnnotation.processedRecordingId,
    speakerKey: originalAnnotation.processedRecordingId,
    startSeconds: originalAnnotation.startTimeInSeconds,
    endSeconds: originalAnnotation.endTimeInSeconds,
    text: 'Live transcript text'
  });
  assert.equal(recreated.ok, true);
  assert.equal(recreated.verification.annotationId, originalAnnotation.id);
  assert.equal(transcriptRows.length, 1);
  assert.equal(createdAnnotations.length, 1);
  assert.equal(createdAnnotations[0].content, 'Live transcript text');
  assert.equal(transcriptRows[0].querySelector().value, 'Live transcript text');

  pageWindow.dispatchEvent(new FakeCustomEvent('babel-helper-bridge-teardown'));
});

test('page timestamp mutations are idempotent by exact annotation ID', async () => {
  const { createServiceRegistry } = await importBundledTs(
    'src/mod-platform/service-registry.ts',
    'idempotent-mutation-service-registry'
  );
  const services = createServiceRegistry();
  const pageWindow = installPageGlobals(services);
  let transcriptRows = [];
  const createdAnnotations = [];
  const deletedAnnotationIds = [];

  const onCreateAnnotation = (annotation) => {
    createdAnnotations.push(annotation);
    transcriptRows.push(makeMutationRow(annotation));
  };
  const onDelete = (annotationId) => {
    deletedAnnotationIds.push(annotationId);
    transcriptRows = transcriptRows.filter((row) => row.annotation.id !== annotationId);
  };
  function makeMutationRow(annotation) {
    const textarea = new FakeHTMLElement();
    textarea.value = annotation.content || '';
    const cells = [
      '',
      annotation.trackLabel || 'Speaker 1',
      `00:00:${annotation.startTimeInSeconds.toFixed(3)}`,
      `00:00:${annotation.endTimeInSeconds.toFixed(3)}`
    ].map((textContent) => {
      const cell = new FakeHTMLElement();
      cell.textContent = textContent;
      return cell;
    });
    const row = new FakeHTMLTableRowElement();
    row.annotation = annotation;
    row.children = cells;
    row.querySelector = () => textarea;
    row.__reactFiber$mutation = {
      memoizedProps: {
        annotation,
        onCreateAnnotation,
        onDelete,
        onTimeChange() {}
      },
      return: null
    };
    return row;
  }

  transcriptRows = [
    makeMutationRow({
      id: 'existing-anchor',
      processedRecordingId: 'recording-main',
      trackLabel: 'Speaker 1',
      startTimeInSeconds: 0,
      endTimeInSeconds: 1
    })
  ];
  pageWindow.document.querySelectorAll = (selector) =>
    selector === 'tbody tr' ? transcriptRows : [];

  await importBundledTs('src/content/timestamp-bridge.ts', 'idempotent-mutation-timestamp-bridge');
  const timestampFacade = pageWindow.__babelHelperTimestampBridge;
  const createPayload = {
    annotationId: 'stable-create-id',
    processedRecordingId: 'recording-main',
    speakerKey: 'Speaker 1',
    startSeconds: 4,
    endSeconds: 8,
    text: 'Created once'
  };

  const firstCreate = await timestampFacade.createSegment(createPayload);
  const repeatedCreate = await timestampFacade.createSegment(createPayload);
  assert.equal(firstCreate.ok, true);
  assert.equal(repeatedCreate.ok, true);
  assert.equal(repeatedCreate.annotationId, createPayload.annotationId);
  assert.equal(createdAnnotations.length, 1);
  assert.equal(createdAnnotations[0].id, createPayload.annotationId);
  assert.equal(
    transcriptRows.filter((row) => row.annotation.id === createPayload.annotationId).length,
    1
  );

  const target = {
    id: 'delete-target',
    processedRecordingId: 'recording-main',
    trackLabel: 'Speaker 1',
    startTimeInSeconds: 12,
    endTimeInSeconds: 16
  };
  const equalRangeNeighbor = {
    ...target,
    id: 'equal-range-neighbor'
  };
  transcriptRows = [makeMutationRow(target), makeMutationRow(equalRangeNeighbor)];
  const deletePayload = {
    annotationId: target.id,
    speakerKey: target.trackLabel,
    startSeconds: target.startTimeInSeconds,
    endSeconds: target.endTimeInSeconds
  };

  const firstDelete = await timestampFacade.deleteSegment(deletePayload);
  const retriedDelete = await timestampFacade.deleteSegment({
    ...deletePayload,
    allowAlreadyAbsent: true
  });
  assert.equal(firstDelete.ok, true);
  assert.equal(retriedDelete.ok, true);
  assert.equal(retriedDelete.annotationId, target.id);
  assert.deepEqual(deletedAnnotationIds, [target.id]);
  assert.deepEqual(
    transcriptRows.map((row) => row.annotation.id),
    [equalRangeNeighbor.id]
  );

  pageWindow.dispatchEvent(new FakeCustomEvent('babel-helper-bridge-teardown'));
});

test('timestamp mutation wrappers preserve identities and mark delete retries', async () => {
  const pageWindow = installPageGlobals({});
  pageWindow.__babelHelperTimestampBridge = {};
  const createRequests = [];
  const deleteRequests = [];
  let remainingAnnotationIds = ['delete-target', 'equal-range-neighbor'];
  const equalRangeRows = ['lookup-target-a', 'lookup-neighbor-b'].map((annotationId) => {
    const row = new FakeHTMLTableRowElement();
    row.annotationId = annotationId;
    row.speakerKey = 'Speaker 1';
    row.children = ['', 'Speaker 1', '00:00:30.000', '00:00:34.000'].map((textContent) => {
      const cell = new FakeHTMLElement();
      cell.textContent = textContent;
      return cell;
    });
    return row;
  });
  pageWindow.addEventListener('babel-helper-timestamp-request', (event) => {
    if (event.detail?.operation !== 'create-segment') {
      return;
    }

    const payload = { ...event.detail.payload };
    createRequests.push(payload);
    const result =
      createRequests.length === 1
        ? {
            ok: false,
            backend: 'page-react-create-annotation',
            reason: 'verify-timeout',
            annotationId: payload.annotationId
          }
        : {
            ok: true,
            backend: 'page-react-create-annotation',
            annotationId: payload.annotationId
          };
    pageWindow.dispatchEvent(
      new FakeCustomEvent('babel-helper-timestamp-response', {
        detail: {
          id: event.detail.id,
          result
        }
      })
    );
  });
  pageWindow.addEventListener('babel-helper-timestamp-request', (event) => {
    if (event.detail?.operation !== 'delete-segment') {
      return;
    }

    const payload = { ...event.detail.payload };
    deleteRequests.push(payload);
    let result;
    if (deleteRequests.length === 1) {
      remainingAnnotationIds = remainingAnnotationIds.filter(
        (annotationId) => annotationId !== payload.annotationId
      );
      result = {
        ok: false,
        backend: 'page-react-row-action',
        reason: 'verify-timeout',
        annotationId: payload.annotationId
      };
    } else {
      result = {
        ok:
          payload.allowAlreadyAbsent === true &&
          !remainingAnnotationIds.includes(payload.annotationId),
        backend: 'page-react-row-action',
        annotationId: payload.annotationId
      };
    }
    pageWindow.dispatchEvent(
      new FakeCustomEvent('babel-helper-timestamp-response', {
        detail: {
          id: event.detail.id,
          result
        }
      })
    );
  });

  const { registerTimestampEditService } = await importBundledTs(
    'src/services/timestamp-edit-service.ts',
    'stable-create-id-timestamp-client'
  );
  const isolatedHelper = {
    async sleep() {},
    getTranscriptRows() {
      return equalRangeRows.filter((row) => remainingAnnotationIds.includes(row.annotationId));
    },
    getRowIdentity(row) {
      return { annotationId: row.annotationId };
    },
    getRowSpeakerKey(row) {
      return row.speakerKey;
    },
    normalizeText(element) {
      return element.textContent || '';
    }
  };
  registerTimestampEditService(isolatedHelper);
  const result = await isolatedHelper.createSegmentWithNativeAction({
    processedRecordingId: 'recording-main',
    speakerKey: 'Speaker 1',
    startSeconds: 20,
    endSeconds: 24,
    text: 'Retry me',
    attempts: 2
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(createRequests.length, 2);
  assert.equal(typeof createRequests[0].annotationId, 'string');
  assert.notEqual(createRequests[0].annotationId, '');
  assert.equal(createRequests[1].annotationId, createRequests[0].annotationId);
  assert.equal(result.verification.annotationId, createRequests[0].annotationId);

  const deleteResult = await isolatedHelper.deleteSegmentWithNativeAction({
    annotationId: 'delete-target',
    attempts: 2
  });
  assert.equal(deleteResult.ok, true);
  assert.equal(deleteResult.attempts, 2);
  assert.equal(deleteRequests.length, 2);
  assert.equal(deleteRequests[0].annotationId, 'delete-target');
  assert.equal(deleteRequests[0].allowAlreadyAbsent, false);
  assert.equal(deleteRequests[1].annotationId, 'delete-target');
  assert.equal(deleteRequests[1].allowAlreadyAbsent, true);
  assert.deepEqual(remainingAnnotationIds, ['equal-range-neighbor']);

  remainingAnnotationIds = equalRangeRows.map((row) => row.annotationId);
  deleteRequests.length = 0;
  const resolvedDeleteResult = await isolatedHelper.deleteSegmentWithNativeAction({
    speakerKey: 'Speaker 1',
    startSeconds: 30,
    endSeconds: 34,
    attempts: 2
  });
  assert.equal(resolvedDeleteResult.ok, true);
  assert.equal(resolvedDeleteResult.attempts, 2);
  assert.deepEqual(
    deleteRequests.map((payload) => payload.annotationId),
    ['lookup-target-a', 'lookup-target-a']
  );
  assert.equal(deleteRequests[0].allowAlreadyAbsent, false);
  assert.equal(deleteRequests[1].allowAlreadyAbsent, true);
  assert.equal(
    deleteRequests.some((payload) => payload.annotationId === 'lookup-neighbor-b'),
    false
  );
  assert.deepEqual(remainingAnnotationIds, ['lookup-neighbor-b']);
});

test('cached create callbacks do not treat stale annotation arrays as live existence', async () => {
  const { createServiceRegistry } = await importBundledTs(
    'src/mod-platform/service-registry.ts',
    'stale-create-annotation-service-registry'
  );
  const services = createServiceRegistry();
  const pageWindow = installPageGlobals(services);
  const staleAnnotation = {
    id: 'stale-create-id',
    processedRecordingId: 'recording-main',
    trackLabel: 'Speaker 1',
    startTimeInSeconds: 4,
    endTimeInSeconds: 8,
    content: 'Stale copy'
  };
  let transcriptRows = [];
  const createCalls = [];

  const onCreateAnnotation = (annotation) => {
    createCalls.push(annotation);
    transcriptRows.push(makeRow(annotation, [annotation]));
  };
  function makeRow(annotation, annotations) {
    const textarea = new FakeHTMLElement();
    textarea.value = annotation.content || '';
    const row = new FakeHTMLTableRowElement();
    row.children = ['', annotation.trackLabel, '00:00:04.000', '00:00:08.000'].map(
      (textContent) => {
        const cell = new FakeHTMLElement();
        cell.textContent = textContent;
        return cell;
      }
    );
    row.querySelector = () => textarea;
    row.__reactFiber$staleCreate = {
      memoizedProps: {
        annotation,
        annotations,
        onCreateAnnotation,
        onTimeChange() {}
      },
      return: null
    };
    return row;
  }

  transcriptRows = [makeRow(staleAnnotation, [staleAnnotation])];
  pageWindow.document.querySelectorAll = (selector) =>
    selector === 'tbody tr' ? transcriptRows : [];

  await importBundledTs(
    'src/content/timestamp-bridge.ts',
    'stale-create-annotation-timestamp-bridge'
  );
  const timestampFacade = pageWindow.__babelHelperTimestampBridge;
  timestampFacade.snapshotTranscript();
  transcriptRows = [];

  const result = await timestampFacade.createSegment({
    annotationId: staleAnnotation.id,
    processedRecordingId: staleAnnotation.processedRecordingId,
    speakerKey: staleAnnotation.trackLabel,
    startSeconds: 12,
    endSeconds: 16,
    text: 'Recreated'
  });

  assert.equal(result.ok, true);
  assert.equal(result.annotationId, staleAnnotation.id);
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0], {
    id: staleAnnotation.id,
    type: 'transcription',
    content: 'Recreated',
    processedRecordingId: staleAnnotation.processedRecordingId,
    startTimeInSeconds: 12,
    endTimeInSeconds: 16,
    intensity: null
  });
  assert.equal(transcriptRows.length, 1);
  pageWindow.dispatchEvent(new FakeCustomEvent('babel-helper-bridge-teardown'));
});

test('row-not-found delete retries stay fatal without allowing already-absent success', async () => {
  const pageWindow = installPageGlobals({});
  pageWindow.__babelHelperTimestampBridge = {};
  const deleteRequests = [];
  pageWindow.addEventListener('babel-helper-timestamp-request', (event) => {
    if (event.detail?.operation !== 'delete-segment') {
      return;
    }

    const payload = { ...event.detail.payload };
    deleteRequests.push(payload);
    pageWindow.dispatchEvent(
      new FakeCustomEvent('babel-helper-timestamp-response', {
        detail: {
          id: event.detail.id,
          result:
            payload.allowAlreadyAbsent === true
              ? {
                  ok: true,
                  backend: 'page-react-row-action',
                  annotationId: payload.annotationId
                }
              : {
                  ok: false,
                  backend: 'page-react-row-action',
                  reason: 'row-not-found',
                  annotationId: payload.annotationId
                }
        }
      })
    );
  });

  const { registerTimestampEditService } = await importBundledTs(
    'src/services/timestamp-edit-service.ts',
    'row-not-found-delete-timestamp-client'
  );
  const isolatedHelper = {
    async sleep() {}
  };
  registerTimestampEditService(isolatedHelper);
  const result = await isolatedHelper.deleteSegmentWithNativeAction({
    annotationId: 'missing-delete-target',
    attempts: 3
  });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.reason, 'row-not-found');
  assert.equal(result.verification.reason, 'row-not-found');
  assert.equal(deleteRequests.length, 3);
  assert.deepEqual(
    deleteRequests.map((payload) => ({
      annotationId: payload.annotationId,
      allowAlreadyAbsent: payload.allowAlreadyAbsent
    })),
    [
      { annotationId: 'missing-delete-target', allowAlreadyAbsent: false },
      { annotationId: 'missing-delete-target', allowAlreadyAbsent: false },
      { annotationId: 'missing-delete-target', allowAlreadyAbsent: false }
    ]
  );
});
