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
class FakeHTMLTextAreaElement extends FakeHTMLElement {}
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
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    CustomEvent: FakeCustomEvent,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    HTMLDivElement: FakeHTMLDivElement,
    HTMLMediaElement: FakeHTMLMediaElement,
    HTMLTableRowElement: FakeHTMLTableRowElement,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
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
  const workbench = { memoizedProps: {
    reviewActionId: 'review-action-live',
    transcriptionChunkProcessedRecordings: [{ processedRecordingId: 'empty-recording', speaker: 1, processedRecordingUrl: '' }]
  } };
  const root = { child: workbench };
  root.stateNode = { current: root };
  workbench.return = root;
  const main = new FakeHTMLElement();
  main.__reactFiber$live = workbench;
  pageWindow.document.querySelectorAll = (selector) => {
    if (selector === 'tbody tr') return transcriptRows;
    if (selector === 'tbody, table, main' || selector === 'main, table') return [main];
    return [];
  };

  await importBundledTs('src/content/timestamp-bridge.ts', 'snapshot-timestamp-bridge');
  const direct = pageWindow.__babelHelperTimestampBridge.snapshotTranscript();
  assert.deepEqual(direct, {
    ok: true,
    backend: 'page-react-transcript-snapshot',
    lanes: [{ processedRecordingId: 'empty-recording', speakerKey: 'empty-recording', trackLabel: 'Speaker 1', lane: 'Speaker 1' }],
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
    'src/features/timestamp-edit-feature.ts',
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

  transcriptRows = [];
  const empty = await isolatedHelper.createSegmentWithNativeAction({
    annotationId: 'empty-transcript',
    processedRecordingId: originalAnnotation.processedRecordingId,
    startSeconds: 1,
    endSeconds: 2
  });
  assert.equal(empty.ok, true);
  assert.equal(transcriptRows[0].querySelector().value, '');
  assert.equal(createdAnnotations[1].type, 'transcription');
  assert.equal(createdAnnotations[1].startTimeInSeconds, 1);
  assert.equal(createdAnnotations[1].endTimeInSeconds, 2);

  pageWindow.dispatchEvent(new FakeCustomEvent('babel-helper-bridge-teardown'));
});

function installTimestampMutationHarness(t, respond) {
  const keys = [
    'CustomEvent', 'Element', 'HTMLElement', 'HTMLDivElement', 'HTMLMediaElement',
    'HTMLTableRowElement', 'HTMLTextAreaElement', 'ShadowRoot', 'document', 'window'
  ];
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const pageWindow = installPageGlobals({});
  // Gold publishes the review action on <html>; the returned task object lets a
  // test move to another action (or blank the publication) mid-mutation.
  const task = { reviewActionId: 'task-one' };
  pageWindow.document.documentElement = {
    getAttribute: (name) => (name === 'data-babel-review-action-id' ? task.reviewActionId : null)
  };
  pageWindow.__babelHelperTimestampBridge = {};
  pageWindow.addEventListener('babel-helper-timestamp-request', (event) => {
    Promise.resolve(respond(event.detail)).then((result) => {
      pageWindow.dispatchEvent(new FakeCustomEvent('babel-helper-timestamp-response', {
        detail: { id: event.detail.id, result }
      }));
    });
  });
  return task;
}

function mutationRow(annotationId, speakerKey, startText, endText) {
  const row = new FakeHTMLTableRowElement();
  row.children = ['', speakerKey, startText, endText].map((textContent) => ({ textContent }));
  row.__reactFiber$test = { memoizedProps: { annotation: { id: annotationId } } };
  row.speakerKey = speakerKey;
  row.text = 'current';
  return row;
}

function rowHelper(getRows) {
  return {
    normalizeText: (element) => element.textContent.trim(),
    getTranscriptRows: getRows,
    getRowSpeakerKey: (row) => row.speakerKey,
    getRowIdentity: (row) => ({
      annotationId: row.__reactFiber$test.memoizedProps.annotation.id
    }),
    findRowByIdentity(identity) {
      return getRows().find(
        (row) => row.__reactFiber$test.memoizedProps.annotation.id === identity.annotationId
      );
    },
    sleep: async () => {}
  };
}

test('timestamp retries mutate the replacement React row, never a stale identity or another speaker', async (t) => {
  const { registerTimestampEditService } = await importBundledTs(
    'src/features/timestamp-edit-feature.ts', 'timestamp-row-retry'
  );
  const cases = [
    {
      method: 'setSegmentBoundaryTime',
      options: { targetSeconds: 18 },
      operation: 'set-boundary-time',
      backend: 'page-react-row-time-change',
      apply(row) { row.endSeconds = 18; },
      verify(row) { assert.equal(row.endSeconds, 18); }
    },
    {
      method: 'splitSegmentAtTime',
      options: { splitSeconds: 14 },
      operation: 'split-segment-at-time',
      backend: 'page-react-split-annotation',
      apply(row) { row.segments = [[10.5, 14], [14, 20.5]]; },
      verify(row) { assert.deepEqual(row.segments, [[10.5, 14], [14, 20.5]]); }
    },
    {
      method: 'mergeSegmentWithNativeAction',
      options: { direction: 'below' },
      operation: 'merge-segment',
      backend: 'page-react-row-action',
      apply(row) { row.text += ' next'; },
      verify(row) { assert.equal(row.text, 'current next'); }
    },
    {
      method: 'deleteSegmentWithNativeAction',
      options: {},
      operation: 'delete-segment',
      backend: 'page-react-row-action',
      apply(row) { row.deleted = true; },
      verify(row) { assert.equal(row.deleted, true); }
    }
  ];
  for (const scenario of cases) {
    await t.test(scenario.operation, async (t) => {
      const stale = mutationRow('old', 'speaker-a', '00:10', '00:20');
      const replacement = mutationRow('new', 'speaker-a', '00:10.5', '00:20.5');
      const decoy = mutationRow('other-speaker', 'speaker-b', '00:10', '00:20');
      let rows = [decoy, stale];
      let attempts = 0;
      installTimestampMutationHarness(t, ({ operation, payload }) => {
        if (operation !== scenario.operation) return { ok: false };
        attempts += 1;
        if (attempts === 1) {
          rows = [decoy, replacement];
          return { ok: false, reason: 'react-row-replaced' };
        }
        const target = rows.find(
          (row) => row.__reactFiber$test.memoizedProps.annotation.id === payload.annotationId
        );
        if (target !== replacement) return { ok: false, reason: 'stale-row' };
        scenario.apply(target);
        return { ok: true };
      });
      const helper = rowHelper(() => rows);
      helper.state = { sessionLifecycleRevision: 1 };
      helper.sleep = async () => { helper.state.sessionLifecycleRevision += 1; };
      registerTimestampEditService(helper);
      const result = await helper[scenario.method]({
        rowIdentity: { annotationId: 'old' },
        speakerKey: 'speaker-a',
        startText: '00:10',
        endText: '00:20',
        startSeconds: 10,
        endSeconds: 20,
        ...scenario.options
      });
      assert.equal(result.ok, true);
      assert.equal(result.attempts, 2);
      assert.equal(result.backend, scenario.backend);
      scenario.verify(replacement);
      assert.equal(stale.text, 'current');
      assert.equal(decoy.text, 'current');
      assert.equal(stale.endSeconds, undefined);
      assert.equal(decoy.deleted, undefined);
    });
  }
});

test('timestamp retry exhaustion stops at the cap and success preserves the page backend', async (t) => {
  const { registerTimestampEditService } = await importBundledTs(
    'src/features/timestamp-edit-feature.ts', 'timestamp-retry-exhaustion'
  );
  let requests = 0;
  let succeeds = false;
  installTimestampMutationHarness(t, () => {
    requests += 1;
    return succeeds ? { ok: true, backend: 'custom-page-backend' } : null;
  });
  const helper = rowHelper(() => []);
  registerTimestampEditService(helper);
  const result = await helper.deleteSegmentWithNativeAction({
    annotationId: 'missing', attempts: 100
  });
  assert.deepEqual(result, {
    ok: false, attempts: 4, backend: 'page-react-row-action', verification: null
  });
  assert.equal(requests, 4);
  succeeds = true;
  const recovered = await helper.deleteSegmentWithNativeAction({ annotationId: 'present' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.attempts, 1);
  assert.equal(recovered.backend, 'custom-page-backend');
  assert.equal(requests, 5);
});

test('native timestamp mutations stop at awaited boundaries only for a confirmed task change', async (t) => {
  const { registerTimestampEditService } = await importBundledTs(
    'src/features/timestamp-edit-feature.ts', 'timestamp-task-retry'
  );
  const changes = {
    'a different review action': { reviewActionId: 'task-two', stale: true },
    'a lost publication': { reviewActionId: '', stale: false }
  };
  for (const [change, { reviewActionId, stale }] of Object.entries(changes)) {
    for (const boundary of ['bridge response', 'retry delay', 'bridge load']) {
      await t.test(`${boundary} with ${change}`, async (t) => {
        let announcePause;
        let resume;
        const paused = new Promise((resolve) => { announcePause = resolve; });
        const resumed = new Promise((resolve) => { resume = resolve; });
        let rows = ['old task row'];
        let requests = 0;
        const task = installTimestampMutationHarness(t, async () => {
          requests += 1;
          if (requests === 1 && boundary !== 'bridge load') {
            if (boundary === 'bridge response') {
              announcePause();
              await resumed;
            }
            return { ok: false };
          }
          rows.push('created annotation');
          return { ok: true, annotationId: 'created' };
        });
        const helper = rowHelper(() => []);
        helper.state = { sessionLifecycleRevision: 1 };
        helper.sleep = async () => {
          announcePause();
          await resumed;
        };
        let bridgeScript;
        if (boundary === 'bridge load') {
          delete window.__babelHelperTimestampBridge;
          const published = document.documentElement;
          document.documentElement = {
            getAttribute: (name) => published.getAttribute(name),
            appendChild(script) {
              bridgeScript = script;
              announcePause();
            }
          };
          document.createElement = () => ({ remove() {} });
          const previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
          Object.defineProperty(globalThis, 'chrome', {
            configurable: true,
            value: { runtime: { getURL: (path) => path } }
          });
          t.after(() => {
            if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
            else delete globalThis.chrome;
          });
        }
        registerTimestampEditService(helper);
        const mutation = helper.createSegmentWithNativeAction({
          processedRecordingId: 'recording', startSeconds: 1, endSeconds: 2, text: 'requested text'
        });
        await paused;
        helper.state.sessionLifecycleRevision += 1;
        task.reviewActionId = reviewActionId;
        if (stale) rows = ['new task row'];
        resume();
        bridgeScript?.onload();

        const result = await mutation;
        if (stale) {
          assert.equal(result.ok, false);
          assert.equal(result.reason, 'stale-task');
          assert.deepEqual(rows, ['new task row']);
          assert.equal(requests, boundary === 'bridge load' ? 0 : 1);
        } else {
          assert.equal(result.ok, true);
          assert.deepEqual(rows, ['old task row', 'created annotation']);
          assert.equal(requests, boundary === 'bridge load' ? 1 : 2);
        }
      });
    }
  }
});

test('invalid timestamp mutations never reach the page or schedule a retry', async (t) => {
  const { registerTimestampEditService } = await importBundledTs(
    'src/features/timestamp-edit-feature.ts', 'timestamp-invalid-input'
  );
  let requests = 0;
  let sleeps = 0;
  installTimestampMutationHarness(t, () => { requests += 1; return { ok: true }; });
  const helper = rowHelper(() => []);
  helper.sleep = async () => { sleeps += 1; };
  registerTimestampEditService(helper);
  const invalid = [
    ['setSegmentBoundaryTime', { targetSeconds: 'not a time' }, 'invalid-target'],
    ['splitSegmentAtTime', { splitSeconds: Infinity }, 'invalid-split'],
    ['createSegmentWithNativeAction', { startSeconds: 1, endSeconds: 2 }, 'invalid-segment'],
    ['createSegmentWithNativeAction', {
      processedRecordingId: 'recording', startSeconds: 2, endSeconds: 2
    }, 'invalid-segment']
  ];
  for (const [method, options, reason] of invalid) {
    const result = await helper[method](options);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  }
  assert.equal(requests, 0);
  assert.equal(sleeps, 0);
});

test('timestamp parser tolerates embedded colon, unit and numeric labels without tightening syntax', async () => {
  const { registerTimestampEditService } = await importBundledTs(
    'src/features/timestamp-edit-feature.ts', 'timestamp-parser'
  );
  const helper = {};
  registerTimestampEditService(helper);
  for (const [input, expected] of [
    [' Start 1:75.5 remaining ', 135.5],
    ['-1:30', -30],
    ['1:02:03:04.5', 223384.5],
    ['1H 2m -3.5S', 3716.5],
    ['offset -2.75 seconds', -2.75],
    ['1e3', 1],
    [' ', null],
    ['unavailable', null],
    [42, null]
  ]) {
    assert.equal(helper.parseTimestampEditTimeValue(input), expected, String(input));
  }
});

test('boundary edits without usable labels choose the nearby boundary in the requested speaker lane', async (t) => {
  const { registerTimestampEditService } = await importBundledTs(
    'src/features/timestamp-edit-feature.ts', 'timestamp-nearest-boundary'
  );
  const distant = mutationRow('distant', 'speaker-a', '01:40', '01:50');
  const nearest = mutationRow('nearest', 'speaker-a', '00:10', '00:20');
  const otherSpeaker = mutationRow('other', 'speaker-b', '00:10', '00:18');
  const rows = [otherSpeaker, distant, nearest];
  installTimestampMutationHarness(t, ({ payload }) => {
    const row = rows.find(
      (candidate) => candidate.__reactFiber$test.memoizedProps.annotation.id === payload.annotationId
    );
    if (!row) return { ok: false };
    row.endSeconds = payload.targetSeconds;
    return { ok: true };
  });
  const helper = rowHelper(() => rows);
  registerTimestampEditService(helper);
  const result = await helper.setSegmentBoundaryTime({
    rowIdentity: { annotationId: 'removed' },
    speakerKey: 'speaker-a',
    targetSeconds: 18,
    startSeconds: 100,
    endSeconds: 110
  });
  assert.equal(result.ok, true);
  assert.equal(nearest.endSeconds, 18);
  assert.equal(distant.endSeconds, undefined);
  assert.equal(otherSpeaker.endSeconds, undefined);
});

function liveRow(annotation, textarea) {
  const row = new FakeHTMLTableRowElement();
  row.children = ['', annotation.trackLabel, '00:00:01.000', '00:00:02.000'].map((textContent) => ({
    textContent
  }));
  row.querySelector = () => textarea;
  return row;
}

async function loadTimestampBridge(t, label) {
  const { createServiceRegistry } = await importBundledTs(
    'src/mod-platform/service-registry.ts',
    `${label}-registry`
  );
  const pageWindow = installPageGlobals(createServiceRegistry());
  t.after(() => pageWindow.dispatchEvent(new FakeCustomEvent('babel-helper-bridge-teardown')));
  await importBundledTs('src/content/timestamp-bridge.ts', label);
  return pageWindow;
}

test('row action binding prefers the committed fiber path and falls back to the return walk on a miss', async (t) => {
  const pageWindow = await loadTimestampBridge(t, 'binding-fallback-bridge');
  const deleted = [];
  const annotation = { id: 'ann-live', trackLabel: 'Speaker 1', startTimeInSeconds: 1, endTimeInSeconds: 2 };
  const row = liveRow(annotation, new FakeHTMLElement());
  let rows = [row];
  // The host node keeps its original fiber whose `.return` reaches the stale
  // alternate; the committed tree holds the fresh alternate with new callbacks.
  const hostFiber = { memoizedProps: {} };
  const staleRowFiber = {
    memoizedProps: { annotation, onTimeChange() {}, onDelete: (id) => { deleted.push('stale:' + id); rows = []; } }
  };
  const committedRowFiber = {
    memoizedProps: { annotation, onTimeChange() {}, onDelete: (id) => { deleted.push('committed:' + id); rows = []; } },
    alternate: staleRowFiber,
    child: hostFiber
  };
  staleRowFiber.alternate = committedRowFiber;
  const root = { child: committedRowFiber };
  root.stateNode = { current: root };
  hostFiber.return = staleRowFiber;
  staleRowFiber.return = root;
  committedRowFiber.return = root;
  row.__reactFiber$live = hostFiber;
  pageWindow.document.querySelectorAll = (selector) => (selector === 'tbody tr' ? rows : []);
  const bridge = pageWindow.__babelHelperTimestampBridge;

  const viaCommitted = await bridge.deleteSegment({ annotationId: annotation.id });
  assert.equal(viaCommitted.ok, true, JSON.stringify(viaCommitted));
  assert.deepEqual(deleted, ['committed:ann-live']);

  // A committed tree that no longer contains the row's fiber pair (portal,
  // remount, deep Next.js root) must not strip the binding: use `.return`.
  rows = [row];
  root.child = { memoizedProps: {}, sibling: null };
  const viaReturn = await bridge.deleteSegment({ annotationId: annotation.id });
  assert.equal(viaReturn.ok, true, JSON.stringify(viaReturn));
  assert.deepEqual(deleted, ['committed:ann-live', 'stale:ann-live']);

  // No fiber root reachable at all (the ancestry never ends in a HostRoot).
  rows = [row];
  staleRowFiber.return = { memoizedProps: {} };
  const viaOrphan = await bridge.deleteSegment({ annotationId: annotation.id });
  assert.equal(viaOrphan.ok, true, JSON.stringify(viaOrphan));
  assert.equal(deleted.length, 3);
});

test('merge supports non-textarea rows but preserves edits when a commit times out', async (t) => {
  const pageWindow = await loadTimestampBridge(t, 'merge-fail-open-bridge');
  const merged = [];
  let rows = [];
  const makeRow = (id, textarea, content) => {
    const annotation = { id, trackLabel: 'Speaker 1', startTimeInSeconds: 1, endTimeInSeconds: 2, content };
    const row = liveRow(annotation, textarea);
    row.__reactFiber$live = {
      memoizedProps: {
        annotation,
        onTimeChange() {},
        canMergeBelow: true,
        canMergeAbove: true,
        onMergeBelow: (mergedId) => { merged.push(mergedId); rows = rows.slice(0, 1); },
        onMergeAbove() {}
      },
      return: null
    };
    return { row, annotation };
  };
  pageWindow.document.querySelectorAll = (selector) => (selector === 'tbody tr' ? rows : []);
  const bridge = pageWindow.__babelHelperTimestampBridge;

  // Low-confidence / TTS rows render an editor that is not a plain textarea.
  const ttsEditor = new FakeHTMLElement();
  ttsEditor.value = 'not a textarea';
  const committing = new FakeHTMLTextAreaElement();
  committing.value = 'edited below';
  const below = makeRow('below-commits', committing, 'saved below');
  committing.focus = () => {};
  committing.blur = () => { below.annotation.content = committing.value; };
  rows = [makeRow('tts-top', ttsEditor, 'saved top').row, below.row];
  const clean = await bridge.mergeSegment({ annotationId: 'tts-top', direction: 'below' });
  assert.equal(clean.ok, true, JSON.stringify(clean));
  assert.equal('warning' in clean, false);
  assert.deepEqual(merged, ['tts-top']);

  // A textarea whose debounced label update never lands within the budget
  // must block the merge so the pending text remains available for retry.
  const stuck = new FakeHTMLTextAreaElement();
  stuck.value = 'edited but never committed';
  let blurred = 0;
  stuck.focus = () => {};
  stuck.blur = () => { blurred += 1; };
  rows = [makeRow('tts-top', ttsEditor, 'saved top').row, makeRow('below-stuck', stuck, 'saved below').row];
  const warned = await bridge.mergeSegment({ annotationId: 'tts-top', direction: 'below' });
  assert.equal(warned.ok, false, JSON.stringify(warned));
  assert.equal(warned.reason, 'pending-edit-commit-timeout');
  assert.equal(warned.warning, 'pending-edit-commit-timeout:below-stuck');
  assert.equal(blurred, 1);
  assert.deepEqual(merged, ['tts-top']);
  assert.equal(rows.length, 2);
  assert.equal(stuck.value, 'edited but never committed');
});
