import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build, transform } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultSnapshotDir } from '@nominy/babel-extension-e2e/recreation-snapshot';

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
    location: { pathname: '/transcription/test/review-action-live', search: '', href: 'https://babel.test/transcription/test/review-action-live' },
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
    ShadowRoot: FakeShadowRoot,
    document: pageDocument,
    window: pageWindow,
    location: pageWindow.location
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

function installNativeTranscriptModel(pageWindow, initial = []) {
  const state = { annotations: initial, readOnly: false, rows: [], mutations: [] };
  const tracks = [{ id: 'recording-a', label: 'Speaker 1' }, { id: 'recording-b', label: 'Speaker 2' }];
  const history = { undoStack: [], redoStack: [],
    executeAndPush(command) { command.do(); this.undoStack.push(command); this.redoStack = []; },
    undo() { const command = this.undoStack.pop(); command.undo(); this.redoStack.push(command); commit(); },
    redo() { const command = this.redoStack.pop(); command.do(); this.undoStack.push(command); commit(); }
  };
  const change = (name, next) => {
    const previous = state.annotations;
    state.mutations.push(name);
    history.executeAndPush({ do() { state.annotations = next; commit(); }, undo() { state.annotations = previous; commit(); } });
  };
  const panel = { memoizedProps: { annotations: initial, tracks, saveState: {}, renderTranscript() {}, onSave() {},
    onCreateAnnotation(annotation) { change('create', [...state.annotations, annotation]); },
    onDeleteAnnotation(id) { change('delete', state.annotations.filter(turn => turn.id !== id)); },
    onChangeAnnotationTime(id, range) {
      change('time', state.annotations.map(turn => turn.id === id
        ? { ...turn, startTimeInSeconds: range.start, endTimeInSeconds: range.end } : turn));
    },
    onMergeAnnotations(id, direction) {
      const lane = state.annotations.filter(turn => turn.processedRecordingId === state.annotations.find(turn => turn.id === id).processedRecordingId);
      const index = lane.findIndex(turn => turn.id === id), adjacent = lane[index + (direction === 'below' ? 1 : -1)];
      change('merge', state.annotations.filter(turn => turn.id !== adjacent.id).map(turn => turn.id === id
        ? { ...turn, content: direction === 'below' ? `${turn.content} ${adjacent.content}` : `${adjacent.content} ${turn.content}` } : turn));
    }
  }, memoizedState: { memoizedState: history, queue: { getSnapshot: () => history } } };
  const controller = { selectTurn() {}, updateText() {}, updateTime() {},
    split(id, time, texts) {
      const original = state.annotations.find(turn => turn.id === id);
      const left = { ...original, id: `${id}-left`, content: texts ? texts[0] : original.content, endTimeInSeconds: time - 0.05 };
      const right = { ...original, id: `${id}-right`, content: texts ? texts[1] : original.content, startTimeInSeconds: time + 0.05 };
      change('split', [...state.annotations.filter(turn => turn.id !== id), left, right]);
      return [left.id, right.id];
    },
    remove() {}, toggleWarningAssertion() {} };
  const transcript = { memoizedProps: { turns: initial, handlers: { onChangeText() {} }, activeIds: new Set() } };
  const workbench = { memoizedProps: { reviewActionId: 'review-action-live',
    transcriptionChunkProcessedRecordings: tracks.map((track, index) => ({
      processedRecordingId: track.id, speaker: index + 1, processedRecordingUrl: ''
    })) }, memoizedState: { memoizedState: [controller, []] }, child: panel };
  const root = { child: workbench };
  root.stateNode = { current: root };
  workbench.return = root; panel.return = workbench; panel.child = transcript; transcript.return = panel;
  const main = new FakeHTMLElement();
  main.__reactFiber$native = workbench;
  pageWindow.document.querySelectorAll = selector => selector === 'section[data-annotation-id]' ? state.rows : [main];
  function commit() {
    panel.memoizedProps.annotations = state.annotations;
    panel.memoizedProps.readOnly = state.readOnly;
    transcript.memoizedProps.turns = state.annotations;
  }
  return { state, tracks, panel, transcript, workbench, root, main, history, commit };
}

test('MAIN snapshots retain empty lanes and native create works without mounted turn rows', async (t) => {
  const pageWindow = await loadTimestampBridge(t, 'empty-transcript-bridge');
  const original = { id: 'original', type: 'transcription', processedRecordingId: 'recording-a',
    startTimeInSeconds: 0.84, endTimeInSeconds: 29.826, content: 'Live transcript text', metadata: { keep: true } };
  const model = installNativeTranscriptModel(pageWindow, [original]);
  const bridge = pageWindow.__babelHelperTimestampBridge;
  const snapshot = bridge.snapshotTranscript();
  assert.equal(snapshot.reviewActionId, 'review-action-live');
  assert.equal(snapshot.historyRevision, 0);
  assert.equal(typeof snapshot.historyToken, 'string');
  assert.equal(snapshot.rows[0].text, original.content);
  assert.equal(snapshot.rows[0].startSeconds, 0.84);
  assert.deepEqual(snapshot.lanes.map(lane => lane.processedRecordingId), ['recording-a', 'recording-b']);

  const removed = await bridge.deleteSegment({ annotationId: original.id, expectedHistoryRevision: 0, expectedHistoryToken: snapshot.historyToken });
  assert.equal(removed.ok, true);
  assert.equal(removed.previousHistoryRevision, 0);
  assert.equal(removed.historyRevision, 1);
  assert.equal(removed.previousHistoryToken, snapshot.historyToken);
  assert.notEqual(removed.historyToken, snapshot.historyToken);
  assert.deepEqual(bridge.snapshotTranscript().rows, []);
  assert.equal(bridge.snapshotTranscript().lanes.length, 2);
  const created = await bridge.createSegment({ annotationId: 'empty-lane', processedRecordingId: 'recording-b',
    startSeconds: 1, endSeconds: 2, text: '', expectedHistoryRevision: 1, expectedHistoryToken: removed.historyToken });
  assert.equal(created.ok, true);
  assert.equal(created.historyRevision, 2);
  assert.equal(model.state.annotations[0].content, '');
  assert.equal(model.state.annotations[0].processedRecordingId, 'recording-b');
  const undoCreate = await bridge.undoTranscript({ expectedHistoryRevision: 2, expectedHistoryToken: created.historyToken });
  assert.equal(undoCreate.ok, true);
  assert.equal(undoCreate.historyToken, removed.historyToken);
  const undoDelete = await bridge.undoTranscript({ expectedHistoryRevision: 1, expectedHistoryToken: undoCreate.historyToken });
  assert.equal(undoDelete.ok, true);
  assert.equal(undoDelete.historyToken, snapshot.historyToken);
  assert.equal(model.state.annotations[0], original, 'undo restores original annotation object and metadata');
});

function installTimestampMutationHarness(t, respond) {
  const keys = [
    'CustomEvent', 'Element', 'HTMLElement', 'HTMLDivElement', 'HTMLMediaElement',
    'ShadowRoot', 'document', 'window', 'location'
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
  const row = new FakeHTMLElement();
  row.annotationId = annotationId;
  row.startText = startText; row.endText = endText;
  row.speakerKey = speakerKey;
  row.text = 'current';
  return row;
}

function rowHelper(getRows) {
  return {
    normalizeText: (element) => element.textContent.trim(),
    getTranscriptRows: getRows,
    getRowSpeakerKey: (row) => row.speakerKey,
    getRowIdentity: row => ({ annotationId: row.annotationId, startText: row.startText, endText: row.endText }),
    getRowTimeRange(row) {
      const parse = text => text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
      return { startSeconds: parse(row.startText), endSeconds: parse(row.endText) };
    },
    findRowByIdentity(identity) {
      return getRows().find(row => row.annotationId === identity.annotationId);
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
          (row) => row.annotationId === payload.annotationId
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
      (candidate) => candidate.annotationId === payload.annotationId
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

test('mutations use the committed task and reject stale roots, readonly, IDs and history revisions', async (t) => {
  const pageWindow = await loadTimestampBridge(t, 'committed-native-bridge');
  const original = { id: 'ann-live', type: 'transcription', processedRecordingId: 'recording-a',
    startTimeInSeconds: 1, endTimeInSeconds: 2, content: 'Native turn' };
  const model = installNativeTranscriptModel(pageWindow, [original]);
  const staleWorkbench = { memoizedProps: { ...model.workbench.memoizedProps }, return: model.root };
  model.main.__reactFiber$native = staleWorkbench;
  const bridge = pageWindow.__babelHelperTimestampBridge;
  const staleTask = await bridge.deleteSegment({ annotationId: original.id, expectedReviewActionId: 'old-task' });
  assert.equal(staleTask.reason, 'stale-task');
  const staleHistory = await bridge.deleteSegment({ annotationId: original.id, expectedHistoryRevision: 99,
    expectedHistoryToken: bridge.snapshotTranscript().historyToken });
  assert.equal(staleHistory.reason, 'history-conflict');
  assert.equal(staleHistory.previousHistoryRevision, 0);
  assert.equal(staleHistory.historyRevision, 0);
  assert.equal((await bridge.deleteSegment({ annotationId: 'removed', startSeconds: 1, endSeconds: 2 })).reason, 'row-not-found');
  model.state.readOnly = true; model.commit();
  for (const [method, payload] of [
    ['createSegment', { processedRecordingId: 'recording-a', startSeconds: 2, endSeconds: 3 }],
    ['deleteSegment', { annotationId: original.id }],
    ['mergeSegment', { annotationId: original.id }],
    ['setBoundaryTime', { annotationId: original.id, targetSeconds: 3 }],
    ['splitSegmentAtTime', { annotationId: original.id, splitSeconds: 1.5 }],
    ['undoTranscript', { expectedHistoryRevision: 0 }]
  ]) assert.equal((await bridge[method](payload)).reason, 'read-only', method);
  assert.deepEqual(model.state.mutations, []);
  model.state.readOnly = false; model.commit();
  assert.equal((await bridge.deleteSegment({ annotationId: original.id })).ok, true);
  assert.deepEqual(model.state.mutations, ['delete']);
  model.root.stateNode.current = { child: null };
  assert.equal((await bridge.createSegment({ processedRecordingId: 'recording-a', startSeconds: 2, endSeconds: 3 })).reason,
    'binding-not-found', 'an orphaned old return path must never remain a mutation target');
});

test('native merge flushes Slate text and refuses an uncommitted edit instead of discarding it', async (t) => {
  const pageWindow = await loadTimestampBridge(t, 'native-pending-merge');
  const above = { id: 'above', type: 'transcription', processedRecordingId: 'recording-a',
    startTimeInSeconds: 1, endTimeInSeconds: 2, content: 'Saved above' };
  const below = { ...above, id: 'below', startTimeInSeconds: 3, endTimeInSeconds: 4, content: 'Saved below' };
  const model = installNativeTranscriptModel(pageWindow, [above, below]);
  const editor = { children: [{ children: [{ text: 'Edited below' }] }], apply() {}, insertData() {} };
  const row = new FakeHTMLElement();
  row.getAttribute = name => name === 'data-annotation-id' ? below.id : null;
  row.querySelector = () => ({ blur() { assert.fail('Awaiting debounce must preserve native focus and selection'); } });
  model.state.rows = [row];
  model.transcript.child = { memoizedProps: { turn: below, handlers: {} },
    child: { memoizedProps: { editor } } };
  const bridge = pageWindow.__babelHelperTimestampBridge;
  setTimeout(() => {
    model.state.annotations = model.state.annotations.map(turn =>
      turn.id === below.id ? { ...turn, content: 'Edited below' } : turn);
    model.commit();
  }, 20);
  assert.equal((await bridge.mergeSegment({ annotationId: above.id, direction: 'below' })).ok, true);
  assert.equal(model.state.annotations[0].content, 'Saved above Edited below');
  model.state.annotations = [above, below]; model.commit();
  const result = await bridge.mergeSegment({ annotationId: above.id, direction: 'below' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verify-timeout');
  assert.deepEqual(model.state.annotations, [above, below]);
  assert.equal(editor.children[0].children[0].text, 'Edited below');
  assert.deepEqual(model.state.mutations, ['merge']);
});

test('pending transcript snapshot rejects further typing and navigation without issuing native mutations', async (t) => {
  const pageWindow = await loadTimestampBridge(t, 'pending-native-task');
  const original = { id: 'pending', type: 'transcription', processedRecordingId: 'recording-a',
    startTimeInSeconds: 1, endTimeInSeconds: 3, content: 'Original' };
  const model = installNativeTranscriptModel(pageWindow, [original]);
  const editor = { children: [{ children: [{ text: 'First pending edit' }] }], apply() {}, insertData() {} };
  model.transcript.child = { memoizedProps: { turn: original, handlers: {} },
    child: { memoizedProps: { editor } } };
  const bridge = pageWindow.__babelHelperTimestampBridge;
  assert.equal(bridge.snapshotTranscript().rows[0].text, 'First pending edit');
  const changed = bridge.flushTranscript();
  editor.children[0].children[0].text = 'Further user typing';
  assert.equal((await changed).reason, 'stale-transcript');
  const navigated = bridge.deleteSegment({ annotationId: original.id });
  model.workbench.memoizedProps.reviewActionId = 'new-task';
  assert.equal((await navigated).reason, 'stale-task');
  assert.deepEqual(model.state.mutations, []);
  assert.equal(model.state.annotations[0], original);
  assert.equal(editor.children[0].children[0].text, 'Further user typing');
});

test('native undo rejects depth-only, same-depth forks, and local-only Slate edits', async t => {
  const pageWindow = await loadTimestampBridge(t, 'native-history-identity');
  const original = { id: 'guarded', type: 'transcription', processedRecordingId: 'recording-a',
    startTimeInSeconds: 1, endTimeInSeconds: 3, content: 'Original', metadata: { preserve: true } };
  const model = installNativeTranscriptModel(pageWindow, [original]);
  const bridge = pageWindow.__babelHelperTimestampBridge;
  const receipt = await bridge.setBoundaryTime({ annotationId: original.id, targetSeconds: 4 });
  assert.equal(receipt.ok, true);
  assert.equal((await bridge.undoTranscript({ expectedHistoryRevision: receipt.historyRevision })).reason, 'history-conflict');
  const editor = { children: [{ children: [{ text: 'Pending manual text' }] }], apply() {}, insertData() {} };
  model.transcript.child = { memoizedProps: { turn: original, handlers: {} }, child: { memoizedProps: { editor } } };
  assert.equal((await bridge.undoTranscript({ expectedHistoryRevision: receipt.historyRevision,
    expectedHistoryToken: receipt.historyToken })).reason, 'history-conflict');
  assert.equal(model.history.undoStack.length, receipt.historyRevision);
  assert.equal(editor.children[0].children[0].text, 'Pending manual text');
  model.transcript.child = null;
  model.history.undo();
  const manual = { ...original, content: 'Manual replacement command' };
  model.history.executeAndPush({ do() { model.state.annotations = [manual]; model.commit(); },
    undo() { model.state.annotations = [original]; model.commit(); } });
  const fork = bridge.snapshotTranscript();
  assert.equal(fork.historyRevision, receipt.historyRevision);
  assert.notEqual(fork.historyToken, receipt.historyToken);
  const rejected = await bridge.undoTranscript({ expectedHistoryRevision: receipt.historyRevision,
    expectedHistoryToken: receipt.historyToken });
  assert.equal(rejected.reason, 'history-conflict');
  assert.equal(model.state.annotations[0], manual);
});

test('a commit-wait history fork cannot replace the native command identity in its receipt', async t => {
  const pageWindow = await loadTimestampBridge(t, 'native-history-receipt');
  const original = { id: 'delayed', type: 'transcription', processedRecordingId: 'recording-a',
    startTimeInSeconds: 1, endTimeInSeconds: 3, content: 'Original' };
  const model = installNativeTranscriptModel(pageWindow, [original]);
  let pendingAnnotations = model.state.annotations;
  const applied = Promise.withResolvers();
  model.panel.memoizedProps.onChangeAnnotationTime = (id, range) => {
    const previous = pendingAnnotations;
    const next = previous.map(turn => turn.id === id ? { ...turn, endTimeInSeconds: range.end } : turn);
    model.history.executeAndPush({ do() { pendingAnnotations = next; }, undo() { pendingAnnotations = previous; } });
    applied.resolve();
  };
  const bridge = pageWindow.__babelHelperTimestampBridge;
  const mutation = bridge.setBoundaryTime({ annotationId: original.id, targetSeconds: 4 });
  await applied.promise;
  const owned = bridge.snapshotTranscript();
  model.history.undo();
  const manual = [{ ...original, content: 'Keep the newer user edit' }];
  model.history.executeAndPush({ do() { pendingAnnotations = manual; }, undo() { pendingAnnotations = [original]; } });
  model.state.annotations = pendingAnnotations;
  model.commit();
  const fork = bridge.snapshotTranscript();
  assert.equal(fork.historyRevision, owned.historyRevision);
  assert.notEqual(fork.historyToken, owned.historyToken);
  const result = await mutation;
  assert.equal(result.reason, 'history-conflict');
  assert.equal(result.historyToken, owned.historyToken, 'receipt identifies the invoked command, never the newest unrelated head');
  assert.equal(model.state.annotations[0].content, 'Keep the newer user edit');
});

test('isolated timestamp commands forward opaque guards and never retry a same-depth identity conflict', async t => {
  const { registerTimestampEditService } = await importBundledTs(
    'src/features/timestamp-edit-feature.ts', 'timestamp-opaque-guards');
  const seen = [];
  installTimestampMutationHarness(t, ({ operation, payload }) => {
    seen.push(operation);
    assert.equal(payload.expectedReviewActionId, 'task-one', operation);
    assert.equal(payload.expectedHistoryRevision, 1, operation);
    assert.equal(payload.expectedHistoryToken, 'owned-command', operation);
    return { ok: false, reason: 'history-conflict', previousHistoryRevision: 1, historyRevision: 1,
      previousHistoryToken: 'different-native-command', historyToken: 'different-native-command' };
  });
  const helper = rowHelper(() => []);
  registerTimestampEditService(helper);
  for (const [method, values] of [
    ['createSegmentWithNativeAction', { processedRecordingId: 'recording', startSeconds: 1, endSeconds: 2 }],
    ['deleteSegmentWithNativeAction', {}],
    ['mergeSegmentWithNativeAction', { direction: 'below' }],
    ['setSegmentBoundaryTime', { targetSeconds: 3 }],
    ['splitSegmentAtTime', { splitSeconds: 1.5 }],
    ['undoTranscriptWithNativeBridge', {}]
  ]) {
    const count = seen.length;
    const result = await helper[method]({ annotationId: 'annotation', attempts: 4,
      expectedReviewActionId: 'task-one', expectedHistoryRevision: 1, expectedHistoryToken: 'owned-command', ...values });
    assert.equal(result.reason, 'history-conflict', method);
    assert.equal(seen.length, count + 1, 'a history identity conflict is not a retryable row remount');
    assert.equal((result.verification || result).historyToken, 'different-native-command');
  }
});

test('native controller without private refs splits exact pending text atomically and undoes once', async t => {
  const pageWindow = await loadTimestampBridge(t, 'native-split-texts');
  const original = { id: 'split', type: 'transcription', processedRecordingId: 'recording-a',
    startTimeInSeconds: 1, endTimeInSeconds: 5, content: 'Saved text', metadata: { preserve: true } };
  const model = installNativeTranscriptModel(pageWindow, [original]);
  const bridge = pageWindow.__babelHelperTimestampBridge;
  const sourceText = '<soft>Pending raw text</soft>';
  const editor = { children: [{ children: [{ raw: '<soft>' }, { text: 'Pending raw text' }, { raw: '</soft>' }] }],
    apply() {}, insertData() {} };
  model.transcript.child = { memoizedProps: { turn: original, handlers: {} }, child: { memoizedProps: { editor } } };
  const split = bridge.splitSegmentAtTime({ annotationId: original.id, splitSeconds: 3,
    texts: ['', sourceText], sourceText });
  assert.deepEqual(model.state.mutations, [], 'the pending raw text must commit before native split');
  const committed = { ...original, content: sourceText };
  model.state.annotations = [committed];
  model.commit();
  const receipt = await split;
  assert.equal(receipt.ok, true);
  assert.deepEqual(model.state.mutations, ['split']);
  assert.equal(receipt.historyRevision, 1, 'both text parts belong to one native split command');
  assert.deepEqual(model.state.annotations.map(turn => turn.content), ['', sourceText]);
  assert.deepEqual(model.state.annotations.map(turn => [turn.startTimeInSeconds, turn.endTimeInSeconds]), [[1, 2.95], [3.05, 5]]);
  model.transcript.child = null;
  const undone = await bridge.undoTranscript({ expectedHistoryRevision: receipt.historyRevision,
    expectedHistoryToken: receipt.historyToken });
  assert.equal(undone.ok, true);
  assert.equal(model.state.annotations[0], committed, 'exact native undo retains the committed source and metadata');
});

test('native split refuses malformed text parts and stale raw plans before native mutation', async t => {
  const pageWindow = await loadTimestampBridge(t, 'native-split-text-guards');
  const original = { id: 'split-guarded', type: 'transcription', processedRecordingId: 'recording-a',
    startTimeInSeconds: 1, endTimeInSeconds: 5, content: 'Source text' };
  const model = installNativeTranscriptModel(pageWindow, [original]);
  const bridge = pageWindow.__babelHelperTimestampBridge;
  for (const texts of [null, [], ['left'], ['left', 'right', 'extra'], ['left', null], Array(2)]) {
    assert.equal((await bridge.splitSegmentAtTime({ annotationId: original.id, splitSeconds: 3,
      texts, sourceText: original.content })).reason, 'invalid-split');
  }
  assert.equal((await bridge.splitSegmentAtTime({ annotationId: original.id, splitSeconds: 3,
    texts: ['left', 'right'] })).reason, 'invalid-split');
  assert.equal((await bridge.splitSegmentAtTime({ annotationId: original.id, splitSeconds: 3,
    texts: ['left', 'right'], sourceText: 'Obsolete source' })).reason, 'stale-transcript');
  const editor = { children: [{ children: [{ text: 'Planned pending text' }] }], apply() {}, insertData() {} };
  model.transcript.child = { memoizedProps: { turn: original, handlers: {} }, child: { memoizedProps: { editor } } };
  const split = bridge.splitSegmentAtTime({ annotationId: original.id, splitSeconds: 3,
    texts: ['Planned', ' pending text'], sourceText: 'Planned pending text' });
  editor.children[0].children[0].text = 'Newer user text';
  model.state.annotations = [{ ...original, content: 'Newer user text' }];
  model.commit();
  assert.equal((await split).reason, 'stale-transcript');
  assert.deepEqual(model.state.mutations, []);
  assert.equal(model.history.undoStack.length, 0);
  assert.equal(model.state.annotations[0].content, 'Newer user text');
});

test('native split rechecks the raw source after a successful flush before issuing its command', async t => {
  const pageWindow = await loadTimestampBridge(t, 'native-split-after-flush');
  const original = { id: 'split-race', type: 'transcription', processedRecordingId: 'recording-a',
    startTimeInSeconds: 1, endTimeInSeconds: 5, content: 'Source text' };
  const model = installNativeTranscriptModel(pageWindow, [original]);
  const editor = { children: [{ children: [{ text: original.content }] }], apply() {}, insertData() {} };
  model.transcript.child = { memoizedProps: { turn: original, handlers: {} }, child: { memoizedProps: { editor } } };
  const split = pageWindow.__babelHelperTimestampBridge.splitSegmentAtTime({
    annotationId: original.id, splitSeconds: 3, texts: ['Source', ' text'], sourceText: original.content,
  });
  // The already-committed flush resolves first; this edit lands before the
  // awaiting split continuation, without relying on a debounce duration.
  queueMicrotask(() => { editor.children[0].children[0].text = 'New local edit'; });
  assert.equal((await split).reason, 'stale-transcript');
  assert.deepEqual(model.state.mutations, []);
  assert.equal(model.history.undoStack.length, 0);
  assert.equal(model.state.annotations[0], original);
  assert.equal(editor.children[0].children[0].text, 'New local edit');
});

test('native split rejects moved or relaned source identities before and after pending text flush', async t => {
  const pageWindow = await loadTimestampBridge(t, 'native-split-identity-guards');
  const original = { id: 'identity-split', type: 'transcription', processedRecordingId: 'recording-a',
    startTimeInSeconds: 1, endTimeInSeconds: 5, content: 'Source text' };
  const model = installNativeTranscriptModel(pageWindow, [original]);
  const bridge = pageWindow.__babelHelperTimestampBridge;
  const payload = { annotationId: original.id, splitSeconds: 3, startSeconds: 1, endSeconds: 5,
    rowIdentity: { processedRecordingId: 'recording-a' }, sourceText: original.content };
  for (const invalid of [{ startSeconds: 0 }, { endSeconds: 6 },
    { rowIdentity: { processedRecordingId: 'recording-b' } }, { sourceText: 'old text' }]) {
    assert.equal((await bridge.splitSegmentAtTime({ ...payload, ...invalid })).reason, 'stale-transcript');
  }
  for (const changed of [{ startTimeInSeconds: 2 }, { endTimeInSeconds: 4 }, { processedRecordingId: 'recording-b' }]) {
    model.state.annotations = [original];
    model.commit();
    const pending = bridge.splitSegmentAtTime(payload);
    queueMicrotask(() => { model.state.annotations = [{ ...original, ...changed }]; model.commit(); });
    assert.equal((await pending).reason, 'stale-transcript');
  }
  assert.deepEqual(model.state.mutations, []);
  assert.equal(model.history.undoStack.length, 0);
});

test('native seek preserves the exact partially-playing lane subset while synchronizing both clocks', async t => {
  const { createServiceRegistry } = await importBundledTs('src/mod-platform/service-registry.ts', 'partial-play-seek-registry');
  const pageWindow = installPageGlobals(createServiceRegistry());
  const model = installNativeTranscriptModel(pageWindow);
  const sourceModule = await importBundledTs(path.relative(repoRoot,
    path.join(defaultSnapshotDir, 'app/src/recovered/generated/moduleSources.ts')), 'native-seek-source');
  const nativeSource = (await transform(`(${sourceModule.recoveredModuleSources[sourceModule.recoveredEditorModuleId]})`,
    { loader: 'js', minify: false })).code;
  function callback(name, scope) {
    const marker = `${name} = (0, a.useCallback)(`;
    const start = nativeSource.indexOf(marker);
    const end = nativeSource.indexOf('}, [', start + marker.length);
    assert.notEqual(start, -1, `Captured native ${name} callback must be present`);
    assert.notEqual(end, -1);
    return new Function(...Object.keys(scope), `return (${nativeSource.slice(start + marker.length, end + 1)});`)(...Object.values(scope));
  }
  const seekCalls = [];
  const waves = [false, true].map((paused, index) => ({
    paused, time: 3.25,
    getCurrentTime() { return this.time; }, getDuration() { return 12; },
    getPlaybackRate() { return 1; }, isPlaying() { return !this.paused; },
    seekTo(fraction) { this.time = fraction * 12; seekCalls.push([index, this.time, this.paused]); },
    play() { assert.fail('Seeking must not start a paused lane'); },
    pause() { assert.fail('Seeking must not pause an active lane'); }
  }));
  const registry = { 'recording-a': { wavesurfer: waves[0] }, 'recording-b': { wavesurfer: waves[1] } };
  const seekSyncRef = { current: false };
  const nativeSeek = callback('k3', { g3: seekSyncRef, f2: registry });
  model.panel.memoizedProps.onSeekToAnnotation = callback('ro2', {
    t_2: { seekAllTracksToTime: nativeSeek },
    eA2() { assert.fail('Pure clock seek must preserve the active annotation'); }
  });
  model.panel.memoizedProps.onPlayPause = () => assert.fail('Pure seek must not toggle the transport');
  model.workbench.memoizedState.next = { memoizedState: { current: registry } };
  await importBundledTs('src/content/playback-bridge.ts', 'partial-play-seek-bridge');
  t.after(() => pageWindow.__babelHelperPlaybackBridge?.dispose());
  const result = pageWindow.__babelHelperPlaybackBridge.seekPlaybackBySeconds(-1);
  assert.equal(result.ok, true);
  assert.deepEqual(seekCalls, [[0, 2.25, false], [1, 2.25, true]]);
  assert.deepEqual(waves.map(wave => wave.paused), [false, true]);
  assert.equal(result.paused, false);
  assert.equal(seekSyncRef.current, false);
  assert.equal(pageWindow.__babelHelperPlaybackBridge.seekPlaybackBySeconds(-100).ok, true);
  assert.deepEqual(waves.map(wave => [wave.time, wave.paused]), [[0, false], [0, true]]);
});

test('isolated atomic split forwards exact raw source and empty text parts without altering ordinary splits', async t => {
  const { registerTimestampEditService } = await importBundledTs(
    'src/features/timestamp-edit-feature.ts', 'atomic-split-client');
  const payloads = [];
  installTimestampMutationHarness(t, ({ operation, payload }) => {
    assert.equal(operation, 'split-segment-at-time');
    payloads.push(payload);
    return { ok: true, leftAnnotationId: 'left', rightAnnotationId: 'right' };
  });
  const helper = rowHelper(() => []);
  registerTimestampEditService(helper);
  const sourceText = '  Pending raw text. ';
  const texts = ['', sourceText];
  assert.equal((await helper.splitSegmentAtTime({ annotationId: 'turn', splitSeconds: 1.5,
    sourceText, texts })).ok, true);
  assert.equal(payloads[0].sourceText, sourceText);
  assert.deepEqual(payloads[0].texts, texts);
  assert.equal((await helper.splitSegmentAtTime({ annotationId: 'turn', splitSeconds: 1.5 })).ok, true);
  assert.equal(Object.hasOwn(payloads[1], 'texts'), false);
  assert.equal(Object.hasOwn(payloads[1], 'sourceText'), false);
  assert.equal((await helper.splitSegmentAtTime({ annotationId: 'turn', splitSeconds: 1.5, sourceText })).ok, true);
  assert.equal(Object.hasOwn(payloads[2], 'texts'), false, 'Shift+S retains native duplicate-text semantics');
  assert.equal(payloads[2].sourceText, sourceText, 'native-text split still binds the source snapshot');
});

test('native asynchronous play reads current clocks and cancels on task or source replacement without replay', async t => {
  const { createServiceRegistry } = await importBundledTs('src/mod-platform/service-registry.ts', 'pending-play-registry');
  const pageWindow = installPageGlobals(createServiceRegistry());
  const model = installNativeTranscriptModel(pageWindow);
  let toggles = 0;
  const createWave = () => ({
    time: 2, playing: false,
    getCurrentTime() { return this.time; }, getDuration() { return 12; },
    getPlaybackRate() { return 1; }, isPlaying() { return this.playing; }
  });
  const registry = { recording: { wavesurfer: createWave() } };
  model.workbench.memoizedState.next = { memoizedState: { current: registry } };
  model.panel.memoizedProps.onSeekToAnnotation = () => {};
  model.panel.memoizedProps.onPlayPause = () => { toggles++; };
  await importBundledTs('src/content/playback-bridge.ts', 'pending-play-bridge');
  t.after(() => pageWindow.__babelHelperPlaybackBridge?.dispose());
  let resume;
  pageWindow.setTimeout = callback => { resume = callback; return 1; };
  for (const transition of ['playing', 'source', 'task']) {
    registry.recording.wavesurfer = createWave();
    model.workbench.memoizedProps.reviewActionId = 'review-action-live';
    toggles = 0;
    const pending = pageWindow.__babelHelperPlaybackBridge.setPlaybackPaused(false);
    assert.equal(toggles, 1);
    if (transition === 'source') registry.recording.wavesurfer = createWave();
    if (transition === 'task') model.workbench.memoizedProps.reviewActionId = 'new-task';
    registry.recording.wavesurfer.playing = true;
    registry.recording.wavesurfer.time = 4;
    resume();
    const result = await pending;
    assert.equal(toggles, 1, 'a delayed play must never toggle a replacement source');
    if (transition === 'playing') {
      assert.equal(result.ok, true);
      assert.equal(result.currentTime, 4);
    } else {
      assert.equal(result.ok, false);
      assert.equal(result.reason, transition === 'task' ? 'stale-task' : 'playback-unavailable');
    }
  }
});
