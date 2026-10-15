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

test('native review action identity separates same-route tasks and rejects stale timing', () => {
  const location = { pathname: '/label', search: '?jobId=same-route-job' };

  function createHelper(reviewActionId) {
    const row = { lane: 'shared-lane' };

    return {
      getTranscriptRows: () => [row],
      getRowIdentity: () => ({
        reviewActionId,
        processedRecordingId: 'shared-lane',
        speakerKey: 'Speaker 1'
      })
    };
  }

  const firstHelper = createHelper('review-action-first');
  const secondHelper = createHelper('review-action-second');
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
    reviewActionId: 'review-action-second',
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

test('task guard fails open: only a different published review action or pathname ends the task', (t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const taskLocation = { href: 'https://babel.test/label?jobId=shared', pathname: '/label', search: '?jobId=shared', hash: '' };
  let publishedId = 'task-one';
  let readAttribute = () => publishedId;
  Object.defineProperty(globalThis, 'location', { configurable: true, value: taskLocation });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { getAttribute: () => readAttribute() } }
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  });
  const isOriginalTask = identity.captureL0TaskGuard();

  publishedId = '';
  assert.equal(isOriginalTask(), true, 'Gold removing its publication is not a task change');
  publishedId = '  ';
  assert.equal(isOriginalTask(), true, 'a blank publication is unknown, not different');
  readAttribute = () => { throw new Error('detached document'); };
  assert.equal(isOriginalTask(), true, 'an unreadable publication is not a task change');
  readAttribute = () => publishedId;
  publishedId = 'task-one';
  taskLocation.search = '?jobId=refetched';
  taskLocation.hash = '#row-2';
  taskLocation.href = 'https://babel.test/label?jobId=refetched#row-2';
  assert.equal(isOriginalTask(), true, 'search and hash changes on the same route are not a task change');

  publishedId = 'task-two';
  assert.equal(isOriginalTask(), false, 'a different published review action ends the task');
  publishedId = 'task-one';
  taskLocation.pathname = '/projects';
  assert.equal(isOriginalTask(), false, 'a pathname change ends the task');
  taskLocation.pathname = '/label';
  assert.equal(isOriginalTask(), true);
});

test('task guard captured without a publication only ends on a pathname change', (t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const taskLocation = { pathname: '/label', search: '' };
  let publishedId = '';
  Object.defineProperty(globalThis, 'location', { configurable: true, value: taskLocation });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { getAttribute: () => publishedId } }
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
  });
  const isTask = identity.captureL0TaskGuard();
  const strictTask = identity.captureL0TaskGuard({ requireIdentity: true });
  assert.equal(strictTask(), false, 'bulk replacement requires a known starting identity');
  assert.equal(isTask(), true, 'an unidentified editor is trusted rather than refused');
  publishedId = 'task-late';
  assert.equal(strictTask(), false, 'a later identity cannot retroactively identify the starting task');
  assert.equal(isTask(), true, 'an identity appearing later cannot contradict an unknown start');
  taskLocation.pathname = '/projects';
  assert.equal(isTask(), false);
});

function installSourceDocument(t, source) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = {
    documentElement: {
      getAttribute: (name) => name === 'data-babel-review-action-id' ? source.taskId :
        name === 'data-babel-audio-enhancement' ? JSON.stringify(source) : null,
      appendChild() {}
    },
    querySelector: () => null,
    createElement: () => ({
      ownerDocument: document,
      classList: { add() {} },
      style: { removeProperty(name) { delete this[name]; }, setProperty(name, value) { this[name] = value; } },
      setAttribute() {},
      remove() {}
    })
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
}

test('word timing retains a late Original update without replacing selected-source inference', (t) => {
  const source = { version: 2, taskId: 'current-pair', status: 'ready', strength: 0, desiredStrength: 0, variantKey: '', revision: 1 };
  installSourceDocument(t, source);
  const helper = { getTranscriptRows: () => [] };
  const location = { pathname: '/label', search: '' };
  const state = { l0TimingIndex: null };
  const protocolWindow = createProtocolWindow();
  const dispose = listener.registerL0TimingListener(state, helper, protocolWindow, location);
  t.after(dispose);
  const originalId = identity.buildCurrentL0TimingTaskId(helper, location);
  protocolWindow.emit(validUpdate(originalId));
  Object.assign(source, { strength: 100, desiredStrength: 100, variantKey: 'graph-a' });
  const enhancedId = identity.buildCurrentL0TimingTaskId(helper, location);
  const enhanced = validUpdate(enhancedId);
  enhanced.tracks[0].tokens = [token('enhanced-alpha', 'alpha', 10, 11), token('enhanced-beta', 'beta', 14, 15)];
  protocolWindow.emit(enhanced);
  const read = () => listener.getCurrentL0TimingIndex(state, helper, location);
  const lateOriginal = validUpdate(originalId);
  lateOriginal.tracks[0].tokens = [token('late-alpha', 'alpha', 99, 100)];
  protocolWindow.emit(lateOriginal);
  for (let cycle = 0; cycle < 4; cycle++) {
    assert.equal(read().tracks[0].tokens[0].startSeconds, 10);
    Object.assign(source, { strength: 0, desiredStrength: 0, variantKey: '' });
    assert.equal(read().tracks[0].tokens[0].startSeconds, 99);
    Object.assign(source, { strength: 100, desiredStrength: 100, variantKey: 'graph-a' });
  }
  dispose();
  assert.equal(read(), null, 'kernel teardown cannot restore disposed timing');
});

for (const status of ['processing', 'switching', 'ready']) {
  test(`late Original timing during ${status} is shared for playback only after clock verification`, (t) => {
    const source = { version: 2, taskId: 'current-pair', status: 'idle', strength: 0,
      desiredStrength: 0, variantKey: '', revision: 1 };
    installSourceDocument(t, source);
    const helper = { getTranscriptRows: () => [] };
    const location = { pathname: '/label', search: '' };
    const state = { l0TimingIndex: null };
    const protocolWindow = createProtocolWindow();
    const dispose = listener.registerL0TimingListener(state, helper, protocolWindow, location);
    t.after(dispose);
    const originalId = identity.buildCurrentL0TimingTaskId(helper, location);
    Object.assign(source, { status, strength: 90, desiredStrength: 90, variantKey: 'mix-90' });
    const selectedId = identity.buildCurrentL0TimingTaskId(helper, location);
    protocolWindow.emit(validUpdate(originalId));
    assert.equal(listener.getCurrentL0TimingIndex(state, helper, location), null,
      'Original inference must not be labeled as selected-source ASR');
    assert.equal(state.l0TimingCache.original.taskId, originalId);
    assert.equal(listener.getCurrentL0PlaybackTimingIndex(state, helper, location), null);
    source.pairedVariantKey = 'a'.repeat(64);
    if (status !== 'ready') {
      assert.equal(listener.getCurrentL0PlaybackTimingIndex(state, helper, location), null,
        'pair clocks are not usable until native audio is ready');
    }
    source.status = 'ready';
    const playback = listener.getCurrentL0PlaybackTimingIndex(state, helper, location);
    assert.equal(playback.taskId, selectedId);
    assert.equal(playback.tracks, state.l0TimingCache.original.tracks);
    assert.equal(listener.getCurrentL0TimingIndex(state, helper, location), null);
    assert.equal(state.l0TimingCache.original.taskId, originalId);
    assert.equal(state.l0TimingCache.enhanced, null);
    Object.assign(source, { strength: 35, desiredStrength: 35, variantKey: 'mix-35' });
    assert.equal(listener.getCurrentL0PlaybackTimingIndex(state, helper, location).tracks, playback.tracks);
    source.taskId = 'another-task';
    assert.equal(listener.getCurrentL0PlaybackTimingIndex(state, helper, location), null);
  });
}

test('timing memory evicts replaced enhancement graphs and foreign recording tasks rather than keeping history', (t) => {
  const source = { version: 2, taskId: 'current-pair', status: 'ready', strength: 0, desiredStrength: 0, variantKey: '', revision: 1 };
  installSourceDocument(t, source);
  const helper = { getTranscriptRows: () => [] };
  const location = { pathname: '/label', search: '' };
  const state = { l0TimingIndex: null };
  const protocolWindow = createProtocolWindow();
  const dispose = listener.registerL0TimingListener(state, helper, protocolWindow, location);
  t.after(dispose);
  const read = () => listener.getCurrentL0TimingIndex(state, helper, location);
  const publish = () => protocolWindow.emit(validUpdate(identity.buildCurrentL0TimingTaskId(helper, location)));
  publish();
  Object.assign(source, { strength: 100, desiredStrength: 100, variantKey: 'graph-a' });
  publish();
  source.variantKey = 'graph-b';
  assert.equal(read(), null, 'an unseen graph must not inherit graph-a pins');
  publish();
  source.variantKey = 'graph-a';
  assert.equal(read(), null, 'only the selected enhancement graph is retained');
  Object.assign(source, { strength: 0, desiredStrength: 0, variantKey: '' });
  assert.equal(read().tracks[0].tokens[0].startSeconds, 1);
  source.taskId = 'another-pair';
  assert.equal(read(), null);
  publish();
  source.taskId = 'current-pair';
  assert.equal(read(), null, 'returning to an evicted task cannot revive its old word timing');
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

function installPublishedLanes(t, reviewActionId, tracks) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const attributes = new Map([
    ['data-babel-review-action-id', reviewActionId],
    ['data-babel-recording-lanes', JSON.stringify({ reviewActionId, tracks })]
  ]);
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { getAttribute: (name) => attributes.get(name) ?? null } }
  });
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  });
  return attributes;
}

test('published recording metadata maps visible labels to absolute word timestamps', (t) => {
  const reviewActionId = 'word-timing-task';
  const recordingId = '22222222-3333-4444-8555-666666666666';
  installPublishedLanes(t, reviewActionId, [{ id: recordingId, label: 'Speaker 1' }]);
  const track = {
    lane: recordingId,
    tokens: [token('a', 'alpha', 1, 2), token('b', 'beta', 8, 9)]
  };
  const index = {
    taskId: JSON.stringify({ version: 1, baseTaskId: reviewActionId, stableLaneIds: [] }),
    tracks: [track]
  };
  const matched = identity.resolveL0TimingTrack(
    index, identity.buildL0TimingLaneAliases({ speakerKey: 'Speaker 1' })
  );
  assert.equal(matched, track);
  assert.equal(alignment.computeL0TimedCharacterOffset(
    'alpha beta', matched.tokens, { startSeconds: 0, endSeconds: 10 }, 8
  ), 6);
  assert.equal(alignment.computeL0TimestampAtCharacterOffset(
    'alpha beta', matched.tokens, { startSeconds: 0, endSeconds: 10 }, 7
  ), 8);
});

test('published lane changes invalidate the old mapping without changing the task ID', (t) => {
  const reviewActionId = 'changing-lane-task';
  const attributes = installPublishedLanes(t, reviewActionId, [{ id: 'recording-a', label: 'Speaker 1' }]);
  const first = { lane: 'recording-a', tokens: [token('a', 'first', 1, 2)] };
  const second = { lane: 'recording-b', tokens: [token('b', 'second', 7, 8)] };
  const index = {
    taskId: JSON.stringify({ version: 1, baseTaskId: reviewActionId, stableLaneIds: [] }),
    tracks: [first, second]
  };
  const aliases = identity.buildL0TimingLaneAliases({ speakerKey: 'Speaker 1' });
  assert.equal(identity.resolveL0TimingTrack(index, aliases), first);
  attributes.set('data-babel-recording-lanes', JSON.stringify({
    reviewActionId, tracks: [{ id: 'recording-b', label: 'Speaker 1' }]
  }));
  assert.equal(identity.resolveL0TimingTrack(index, aliases), second);
});

for (const boundary of ['stale-publication', 'stale-timing', 'duplicate-label', 'conflicting-aliases']) {
  test(`published lane metadata cannot attach timestamps across ${boundary}`, (t) => {
    const reviewActionId = 'current-task';
    const attributes = installPublishedLanes(t, reviewActionId, [
      { id: 'recording-a', label: 'Speaker 1' },
      { id: 'recording-b', label: boundary === 'duplicate-label' ? 'Speaker 1' : 'Speaker 2' }
    ]);
    if (boundary === 'stale-publication') attributes.set('data-babel-review-action-id', 'next-task');
    const index = {
      taskId: JSON.stringify({
        version: 1, baseTaskId: boundary === 'stale-timing' ? 'old-task' : reviewActionId, stableLaneIds: []
      }),
      tracks: [{ lane: 'recording-a', tokens: [] }, { lane: 'recording-b', tokens: [] }]
    };
    const aliases = identity.buildL0TimingLaneAliases(
      { speakerKey: 'Speaker 1' }, boundary === 'conflicting-aliases' ? ['Speaker 2'] : []
    );
    assert.equal(identity.resolveL0TimingTrack(index, aliases), null);
  });
}

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
        ownerDocument: fakeDocument,
        classList: { add() {} },
        attributes: {},
        style: { removeProperty(name) { delete this[name]; }, setProperty(name, value) { this[name] = value; } },
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
  assert.equal(notification.attributes.role, 'status');
  assert.deepEqual(scheduled.map(({ delayMs }) => delayMs), [630, 750]);
  scheduled[0].callback();
  assert.equal(notification.style.opacity, '0');
  scheduled[1].callback();
  assert.equal(notification.removed, true);
});

test('missing anchors return null', () => {
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

});
