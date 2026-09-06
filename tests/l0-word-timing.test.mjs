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

const alignment = await loadEntry('src/services/l0-word-timing-alignment.ts');
const listener = await loadEntry('src/content/l0-timing-listener.ts');
const identity = await loadEntry('src/services/l0-timing-identity.ts');

function token(id, text, startSeconds, endSeconds) {
  return { id, text, startSeconds, endSeconds };
}

function validUpdate(taskId = 'task-1') {
  return {
    type: 'babel-gold-drafting:l0-timing-update',
    version: 1,
    taskId,
    tracks: [
      {
        lane: 'Speaker 1',
        tokens: [token('a', 'alpha', 1, 2), token('b', 'beta', 4, 5)]
      },
      {
        lane: 'Speaker 2',
        tokens: []
      }
    ]
  };
}

function createProtocolWindow() {
  const listeners = new Set();
  const protocolWindow = {
    addEventListener(type, callback) {
      if (type === 'message') listeners.add(callback);
    },
    removeEventListener(type, callback) {
      if (type === 'message') listeners.delete(callback);
    },
    emit(data, source = protocolWindow) {
      for (const callback of [...listeners]) callback({ data, source });
    },
    listenerCount() {
      return listeners.size;
    }
  };
  return protocolWindow;
}

test('exact text words are pinned to their absolute token timings', () => {
  const tokens = [token('a', 'alpha', 1, 2), token('b', 'beta', 4, 5)];
  const range = { startSeconds: 0, endSeconds: 6 };

  assert.equal(alignment.computeL0TimedCharacterOffset('alpha beta', tokens, range, 1), 0);

  assert.equal(alignment.computeL0TimedCharacterOffset('alpha beta', tokens, range, 2), 5);
  assert.equal(alignment.computeL0TimedCharacterOffset('alpha beta', tokens, range, 4), 6);
  assert.equal(alignment.computeL0TimedCharacterOffset('alpha beta', tokens, range, 5), 10);
});

test('completed-word floor excludes unmatched and in-progress words', () => {
  const text = 'я стараюсь не есть. Так и мучного';
  const tokens = [
    token('ya', 'я', 0, 0.2),
    token('try', 'стараюсь', 0.3, 0.8),
    token('not', 'не', 0.9, 1),
    token('eat', 'есть', 1.1, 1.5),
    token('so', 'так', 2, 2.3),
    token('and', 'и', 2.4, 2.5),
    token('flour', 'мучного', 2.6, 3)
  ];
  const offset = alignment.computeL0CompletedWordCharacterOffset(
    text,
    tokens,
    { startSeconds: 0, endSeconds: 3 },
    2.2
  );

  assert.equal(text.slice(0, offset), 'я стараюсь не есть.');
});

test('character clicks resolve exact and interpolated playback timestamps', () => {
  const exactText = 'alpha beta';
  const exactTokens = [
    token('alpha', 'alpha', 1, 2),
    token('beta', 'beta', 4, 5)
  ];
  assert.equal(
    alignment.computeL0TimestampAtCharacterOffset(
      exactText,
      exactTokens,
      { startSeconds: 0, endSeconds: 6 },
      2
    ),
    1
  );

  const fuzzyTime = alignment.computeL0TimestampAtCharacterOffset(
    'one inserted three',
    [
      token('one', 'one', 0, 1),
      token('three', 'three', 9, 10)
    ],
    { startSeconds: 0, endSeconds: 10 },
    7
  );
  assert.equal(fuzzyTime > 1 && fuzzyTime < 9, true);
  assert.equal(
    alignment.computeL0TimestampAtCharacterOffset(
      'alpha',
      [token('alpha', 'alpha', 1, 2)],
      { startSeconds: 1.5, endSeconds: 3 },
      2
    ),
    1.5
  );
});

test('a mismatched middle interpolates locally and snaps back at a later anchor', () => {
  const text = 'one inserted words three';
  const tokens = [
    token('one', 'one', 0, 1),
    token('different', 'different', 3, 7),
    token('three', 'three', 9, 10)
  ];
  const range = { startSeconds: 0, endSeconds: 10 };

  assert.equal(alignment.computeL0TimedCharacterOffset(text, tokens, range, 5), 11);
  assert.equal(alignment.computeL0TimedCharacterOffset(text, tokens, range, 8.9) <= 19, true);
  assert.equal(alignment.computeL0TimedCharacterOffset(text, tokens, range, 9), 19);
});

test('punctuation and markup are not words while case and ё normalize', () => {
  const text = '<noise> Ёж, [meta] ЕЛ.';
  const words = alignment.tokenizeL0TimingText(text);
  assert.deepEqual(
    words.map(({ normalized, start, end }) => ({ normalized, start, end })),
    [
      { normalized: 'еж', start: 8, end: 10 },
      { normalized: 'ел', start: 19, end: 21 }
    ]
  );

  const tokens = [token('hedgehog', 'еж', 1, 2), token('ate', 'ел.', 3, 4)];
  const range = { startSeconds: 0, endSeconds: 5 };
  assert.equal(alignment.computeL0TimedCharacterOffset(text, tokens, range, 1), 8);
  assert.equal(alignment.computeL0TimedCharacterOffset(text, tokens, range, 3), 19);
  assert.equal(alignment.normalizeL0TimingWord('[meta]'), '');
  assert.equal(alignment.normalizeL0TimingWord('...'), '');
});

test('alignment re-tokenizes live edited text on every call', () => {
  const tokens = [token('a', 'alpha', 1, 2), token('b', 'beta', 4, 5)];
  const range = { startSeconds: 0, endSeconds: 6 };

  assert.equal(alignment.computeL0TimedCharacterOffset('alpha beta', tokens, range, 4), 6);
  assert.equal(alignment.computeL0TimedCharacterOffset('alpha newly beta', tokens, range, 4), 12);
});

test('canonical task identity uses stable helper lanes and rejects stale updates before replacement', () => {
  const location = {
    pathname: '/label',
    search: '?id=fourth&annotationId=third&jobId=%20first%20&transcriptionChunkId=second'
  };
  const rows = [{ lane: 'b' }, { lane: 'a' }, { lane: 'b' }];
  const helper = {
    getTranscriptRows: () => rows,
    getRowIdentity: (row) => ({
      processedRecordingId: row.lane,
      speakerKey: row.lane === 'a' ? 'Speaker 1' : 'Speaker 2'
    })
  };
  const taskId = identity.buildCurrentL0TimingTaskId(helper, location);
  assert.equal(
    taskId,
    JSON.stringify({ version: 1, baseTaskId: 'first', stableLaneIds: ['a', 'b'] })
  );
  assert.equal(
    identity.buildL0TimingTaskId(
      { pathname: '/label', search: '?view=all' },
      [{ speakerKey: ' Speaker 2 ' }, { speakerKey: 'Speaker 1' }]
    ),
    JSON.stringify({
      version: 1,
      baseTaskId: '/label?view=all',
      stableLaneIds: ['Speaker 1', 'Speaker 2']
    })
  );
  assert.deepEqual(
    identity.collectL0TimingStableLaneIds([
      { processedRecordingId: 'stable-only', speakerKey: 'Speaker 1' },
      { speakerKey: 'Speaker 2' }
    ]),
    ['stable-only'],
    'speaker aliases are used only when no processed recording id exists'
  );

  const state = { l0TimingIndex: null };
  const protocolWindow = createProtocolWindow();
  const dispose = listener.registerL0TimingListener(state, helper, protocolWindow, location);
  protocolWindow.emit(validUpdate(taskId));
  assert.equal(listener.getCurrentL0TimingIndex(state, helper, location)?.taskId, taskId);

  protocolWindow.emit(validUpdate('stale-task'));
  assert.equal(state.l0TimingIndex.taskId, taskId, 'stale message must not evict current timing');
  rows[0].lane = 'new-lane';
  assert.equal(listener.getCurrentL0TimingIndex(state, helper, location), null);
  assert.equal(state.l0TimingIndex, null, 'task identity change invalidates old cache');

  const malformed = [
    { ...validUpdate(taskId), version: 2 },
    { ...validUpdate(taskId), tracks: null },
    {
      ...validUpdate(taskId),
      tracks: [{ lane: 'a', tokens: [token('bad', 'bad', 2, 2)] }]
    }
  ];
  for (const message of malformed) protocolWindow.emit(message);
  protocolWindow.emit(validUpdate(taskId), {});
  assert.equal(state.l0TimingIndex, null);
  dispose();
});

test('React review action identity separates same-route tasks and rejects stale timing', () => {
  const location = { pathname: '/label', search: '?jobId=same-route-job' };

  function createHelper(reviewActionId, fiberPlacement) {
    const textarea = {};
    const row = {
      lane: 'shared-lane',
      querySelector: (selector) => (selector === 'textarea' ? textarea : null)
    };
    const reviewActionFiber = {
      memoizedProps: {
        reviewActionId,
        projectId: 'shared-project',
        queueId: 'shared-queue'
      },
      return: null
    };
    const hostFiber = {
      memoizedProps: {},
      return: { memoizedProps: {}, return: reviewActionFiber }
    };
    const fiberHost = fiberPlacement === 'row' ? row : textarea;
    fiberHost.__reactFiber$timingTest = hostFiber;

    return {
      getTranscriptRows: () => [row],
      getRowIdentity: () => ({
        processedRecordingId: 'shared-lane',
        speakerKey: 'Speaker 1'
      })
    };
  }

  const firstHelper = createHelper('review-action-first', 'row');
  const secondHelper = createHelper('review-action-second', 'textarea');
  const firstTaskId = identity.buildCurrentL0TimingTaskId(firstHelper, location);
  const secondTaskId = identity.buildCurrentL0TimingTaskId(secondHelper, location);

  assert.equal(
    firstTaskId,
    JSON.stringify({
      version: 1,
      baseTaskId: 'review-action-first',
      stableLaneIds: []
    })
  );
  assert.equal(
    secondTaskId,
    JSON.stringify({
      version: 1,
      baseTaskId: 'review-action-second',
      stableLaneIds: []
    })
  );
  assert.notEqual(firstTaskId, secondTaskId);
  secondHelper.getRowIdentity = () => ({
    processedRecordingId: 'lane-hidden-by-switch',
    speakerKey: 'Speaker 2'
  });
  assert.equal(
    identity.buildCurrentL0TimingTaskId(secondHelper, location),
    secondTaskId,
    'lane switching must not change a review-scoped task identity'
  );

  const state = { l0TimingIndex: null };
  const protocolWindow = createProtocolWindow();
  const dispose = listener.registerL0TimingListener(
    state,
    secondHelper,
    protocolWindow,
    location
  );
  protocolWindow.emit(validUpdate(firstTaskId));
  assert.equal(state.l0TimingIndex, null, 'timing from the previous review action is stale');
  protocolWindow.emit(validUpdate(secondTaskId));
  assert.equal(state.l0TimingIndex?.taskId, secondTaskId);
  dispose();
});

test('published main-world review action overrides the shared route in Helper', () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    documentElement: {
      getAttribute: (name) =>
        name === 'data-babel-review-action-id' ? 'review-action-bridged' : null
    }
  };
  try {
    const helper = {
      getTranscriptRows: () => [{ lane: 'shared-lane' }],
      getRowIdentity: () => ({
        processedRecordingId: 'shared-lane',
        speakerKey: 'Speaker 1'
      })
    };
    assert.equal(
      identity.buildCurrentL0TimingTaskId(helper, {
        pathname: '/label',
        search: '?jobId=shared-route'
      }),
      JSON.stringify({
        version: 1,
        baseTaskId: 'review-action-bridged',
        stableLaneIds: []
      })
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('listener replacement and disposal prevent leaks across kernel restarts', () => {
  const protocolWindow = createProtocolWindow();
  const location = { pathname: '/label', search: '?id=second' };
  const helper = { getTranscriptRows: () => [], getRowIdentity: () => null };
  const taskId = identity.buildCurrentL0TimingTaskId(helper, location);
  const firstState = { l0TimingIndex: null };
  const secondState = { l0TimingIndex: null };
  const disposeFirst = listener.registerL0TimingListener(firstState, helper, protocolWindow, location);
  assert.equal(protocolWindow.listenerCount(), 1);

  const disposeSecond = listener.registerL0TimingListener(secondState, helper, protocolWindow, location);
  assert.equal(protocolWindow.listenerCount(), 1);
  protocolWindow.emit(validUpdate(taskId));
  assert.equal(firstState.l0TimingIndex, null);
  assert.equal(secondState.l0TimingIndex.taskId, taskId);

  disposeFirst();
  assert.equal(protocolWindow.listenerCount(), 1);
  disposeSecond();
  assert.equal(protocolWindow.listenerCount(), 0);

  const kernelSource = readFileSync('src/core/kernel.ts', 'utf8');
  assert.match(kernelSource, /registerL0TimingListener\(helper\.state, helper\)/);
  assert.match(kernelSource, /kernelScope\.defer\(disposeL0TimingListener\)/);
});

test('one visible lane is valid and ambiguous display aliases resolve to no timing track', () => {
  const oneLane = listener.parseL0TimingUpdate({
    ...validUpdate('one-lane'),
    tracks: [{ lane: 'stable-a', tokens: [] }]
  });
  assert.equal(oneLane?.tracks.length, 1);

  const aliases = identity.buildL0TimingLaneAliases(
    { speakerKey: 'Speaker 1', trackLabel: 'Speaker 1' },
    ['speaker1']
  );
  assert.equal(
    identity.resolveL0TimingTrack(
      {
        taskId: 'task',
        tracks: [
          { lane: 'Speaker 1', tokens: [] },
          { lane: 'speaker1 audio', tokens: [] }
        ]
      },
      aliases
    ),
    null
  );
  const stableTrack = { lane: 'stable-a', tokens: [] };
  assert.equal(
    identity.resolveL0TimingTrack(
      { taskId: 'task', tracks: [stableTrack, { lane: 'Speaker 1', tokens: [] }] },
      identity.buildL0TimingLaneAliases({
        processedRecordingId: 'stable-a',
        speakerKey: 'Speaker 1'
      })
    ),
    stableTrack
  );
});

test('timing-ready notification lasts 750ms and replaces an older notice', () => {
  let attached = null;
  let removedOld = false;
  const scheduled = [];
  const oldNotice = { remove() { removedOld = true; } };
  const fakeDocument = {
    body: {
      appendChild(element) {
        attached = element;
      }
    },
    documentElement: null,
    querySelector() {
      return oldNotice;
    },
    createElement() {
      return {
        attributes: {},
        style: {},
        textContent: '',
        removed: false,
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        remove() {
          this.removed = true;
        }
      };
    }
  };

  const notification = listener.showL0TimingReadyNotification(
    fakeDocument,
    (callback, delayMs) => scheduled.push({ callback, delayMs })
  );

  assert.equal(removedOld, true);
  assert.equal(attached, notification);
  assert.equal(notification.textContent, 'Timestamped transcription ready');
  assert.equal(notification.attributes.role, 'status');
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [630, 750]);
  scheduled[0].callback();
  assert.equal(notification.style.opacity, '0');
  scheduled[1].callback();
  assert.equal(notification.removed, true);
});

test('missing anchors return null and ghost projections retain proportional fallback', () => {
  assert.equal(
    alignment.computeL0TimedCharacterOffset(
      'edited text',
      [token('unrelated', 'something', 1, 2)],
      { startSeconds: 0, endSeconds: 3 },
      1.5
    ),
    null
  );
  assert.equal(
    alignment.computeL0CompletedWordCharacterOffset(
      'edited text',
      [token('unrelated', 'something', 1, 2)],
      { startSeconds: 0, endSeconds: 3 },
      1.5
    ),
    null
  );

  const rowServiceSource = readFileSync('src/services/row-service.ts', 'utf8');
  assert.match(
    rowServiceSource,
    /return computeRestoreOffset\(text, timeRange, currentTime, blurTime, baseline\)/
  );
  assert.equal((rowServiceSource.match(/computeGhostCursorOffset\(/g) || []).length, 3);
});

test('Alt-click on a transcript word seeks playback through the timestamp index', () => {
  const lifecycleSource = readFileSync('src/core/lifecycle.ts', 'utf8');
  const rowSource = readFileSync('src/services/row-service.ts', 'utf8');
  const registrySource = readFileSync('src/features/registry.ts', 'utf8');
  const handlerStart = lifecycleSource.indexOf('function handleTimestampWordSeekClick(event)');
  const handlerEnd = lifecycleSource.indexOf('function clearPlaybackRowSyncTimer', handlerStart);
  const handler = lifecycleSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'expected Alt-click seek handler');
  assert.match(handler, /event\.altKey/);
  assert.match(handler, /event\.ctrlKey/);
  assert.match(handler, /event\.metaKey/);
  assert.match(handler, /event\.shiftKey/);
  assert.match(handler, /textarea\.selectionStart/);
  assert.match(handler, /helper\.getL0TimestampForRowOffset\(row, offset\)/);
  assert.match(handler, /helper\.seekPlaybackBySeconds\(targetSeconds - playback\.currentTime\)/);
  assert.match(lifecycleSource, /addEventListener\('click', handleTimestampWordSeekClick\)/);
  assert.match(lifecycleSource, /removeEventListener\('click', handleTimestampWordSeekClick\)/);
  assert.match(rowSource, /computeL0TimestampAtCharacterOffset/);
  assert.match(registrySource, /Alt \+ Click word/);
});

test('escape restoration lands on the last visible ghost cursor position', () => {
  const rowServiceSource = readFileSync('src/services/row-service.ts', 'utf8');
  assert.match(
    rowServiceSource,
    /if \(preservedGhostTarget && preservedGhostTarget\.row === rememberedRow\) \{[\s\S]*?selectionStart = preservedGhostTarget\.offset;[\s\S]*?selectionEnd = preservedGhostTarget\.offset;[\s\S]*?\} else if \(helper\.config\.features\.proportionalCursorRestore\)/
  );
});
