import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/content/recovered-editor-bridge.ts'],
  bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent'
});
const source = bundled.outputFiles[0].text;
const facadeBundle = await build({
  entryPoints: ['../shared/babel-extension-platform/packages/babel-extension-e2e/fixtures/recreation/app/src/recovered/scenario-client.ts'],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', '@tanstack/react-query']
});

function recoveredFacade(client = {}) {
  const module = { exports: {} };
  vm.runInNewContext(facadeBundle.outputFiles[0].text, {
    module, exports: module.exports,
    require(name) {
      if (name === 'react') return { createContext: value => ({ Provider: Symbol('fixture-provider'), value }) };
      if (name === '@tanstack/react-query') return { useQuery: options => options, useMutation: options => options };
      throw new Error(`Unexpected facade import: ${name}`);
    }
  });
  return module.exports.createTrpcFacade(client, {}).h;
}

function payload() {
  return {
    referenceReviewActionId: 'comparison', currentReviewActionId: 'task',
    timestampMetrics: { segments: { details: [{ startShiftMs: 300, endShiftMs: -300 }] } },
    speakerDiffs: [{ processedRecordingId: 'speaker', segmentMappings: [
      {
        relationship: 'modified', referenceText: 'old [laugh] words', hypothesisText: 'new words',
        segmentsA: [{ annotationId: 'reference', text: 'old [laugh] words', wordRange: [0, 2], startTimeInSeconds: 0.2, endTimeInSeconds: 2.8 }],
        segmentsB: [{ annotationId: 'row', text: 'new words', wordRange: [0, 2], startTimeInSeconds: 0.5, endTimeInSeconds: 2.5 }],
        wordDiffs: [{ value: 'old', status: 'removed' }, { value: 'new', status: 'added' }, { value: 'words', status: 'unchanged' }],
        substitutions: 1, insertions: 0, deletions: 0
      },
      {
        relationship: 'deleted', referenceText: 'deleted words', hypothesisText: '',
        segmentsA: [{ annotationId: 'deleted', text: 'deleted words', wordRange: [2, 4], startTimeInSeconds: 3, endTimeInSeconds: 4 }], segmentsB: [],
        wordDiffs: [{ value: 'deleted', status: 'removed' }, { value: 'words', status: 'removed' }],
        substitutions: 0, insertions: 0, deletions: 2
      }
    ] }]
  };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function harness({ data = payload(), isDiffMode = true, selected = 'comparison', fetch,
  queryKey = [['transcriptions', 'getTranscriptionDiff'], { input: { referenceReviewActionId: 'comparison', currentReviewActionId: 'task' }, type: 'query' }] } = {}) {
  const timers = [], writes = [], selections = [], toggles = [];
  const window = new EventTarget();
  Object.assign(window, {
    location: { pathname: '/transcription/task', search: '?reviewActionId=task&readOnly=true',
      href: 'https://babel.test/transcription/task?reviewActionId=task&readOnly=true' },
    history: { pushState() {}, replaceState() {} },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    fetch: fetch || (async () => new Response(JSON.stringify(data)))
  });
  const query = {
    state: { data: freeze(structuredClone(data)) },
    setData(next, options) {
      assert.equal(options.manual, true);
      // Query's structural sharing retains the old root when the new payload equals it.
      if (JSON.stringify(next) !== JSON.stringify(this.state.data)) this.state.data = next;
      writes.push(this.state.data);
      return this.state.data;
    }
  };
  const observer = {
    options: { queryKey },
    getCurrentResult: () => ({ data: query.state.data, status: query.state.status || (query.state.data ? 'success' : 'pending'),
      error: query.state.error, refetch: observer.refetch }),
    getCurrentQuery: () => query,
    refetch() { throw new Error('Mode changes must not need an extra network request'); }
  };
  const toolbar = {
    isDiffMode, selectedCompareActionId: selected, availableReviewActions: [{ id: 'comparison', level: 1 }],
    get diffResult() { return query.state.data; },
    onToggleDiffMode(value) { toggles.push(value); toolbar.isDiffMode = value; },
    onSelectCompareAction(value) { selections.push(value); toolbar.selectedCompareActionId = value; }
  };
  const root = { stateNode: {} };
  root.stateNode.current = root;
  function mount(reviewActionId) {
    const editor = { return: root, memoizedProps: { reviewActionId, readOnly: true, transcriptionChunkProcessedRecordings: [] }, memoizedState: { memoizedState: observer } };
    const panel = { return: editor, memoizedProps: { annotations: [], tracks: [], saveState: {}, onSave() {}, renderTranscript() {} } };
    const transcript = { return: editor, memoizedProps: { turns: [], editingId: null, handlers: { onActivate() {}, onDeactivate() {}, onSelect() {}, onChangeText() {} }, readOnly: true } };
    const controls = { return: editor, memoizedProps: toolbar };
    root.child = editor; editor.child = panel; panel.sibling = transcript; transcript.sibling = controls;
    return editor;
  }
  mount('task');
  const attributes = new Map(), surface = { '__reactFiber$test': root };
  const document = Object.assign(new EventTarget(), {
    documentElement: {
      getAttribute: name => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name)
    },
    querySelector: selector => selector === '[data-transcript-scroll]' ? surface : null,
    querySelectorAll: () => [surface]
  });
  class CustomEvent extends Event {
    constructor(type, options) { super(type); this.detail = options?.detail; }
  }
  class MutationObserver { observe() {} disconnect() {} }
  vm.runInNewContext(source, { window, document, URL, Request, Response, structuredClone, console,
    MutationObserver, CustomEvent, queueMicrotask });
  const bridge = window.__babelHelperRecoveredEditorBridge;
  let memoizedData, rendered;
  return {
    window, query, toolbar, bridge, writes, selections, toggles, mount, timers,
    commit() { root.stateNode.current = root; },
    apply: (textMode) => bridge.applyExtendedDiffState({ selectedCompareActionId: 'comparison', textMode }),
    flush: () => { for (const callback of timers.splice(0)) callback(); },
    render() {
      // Native nh2/ng2 memoize their word maps by the diff root, not by nested word arrays.
      if (query.state.data !== memoizedData) {
        memoizedData = query.state.data;
        rendered = memoizedData.speakerDiffs.flatMap(speaker => speaker.segmentMappings)
          .map(mapping => mapping.wordDiffs.map(word => word.value).join(' ')).join(' | ').replace(/\s+/g, ' ').trim();
      }
      return rendered;
    }
  };
}

test('native query notifications repaint every mode without mutating memoized data, and disable restores the original', () => {
  const h = harness(), original = h.query.state.data;
  const nativeText = h.render();
  assert.equal(h.apply('fusion').patchedCurrentDiffResult, true);
  assert.match(h.render(), /old \[laugh\]/);
  assert.match(h.render(), /new/);
  assert.notEqual(h.query.state.data, original);
  for (const mode of ['reference', 'current', 'fusion', 'current', 'reference']) {
    assert.equal(h.apply(mode).ok, true);
    const rendered = h.render();
    if (mode === 'reference') {
      assert.match(rendered, /old \[laugh\] words/);
      assert.doesNotMatch(rendered, /new/);
      assert.match(rendered, /deleted words/);
    } else if (mode === 'current') {
      assert.match(rendered, /new words/);
      assert.doesNotMatch(rendered, /old|laugh|deleted/);
    } else {
      assert.match(rendered, /old \[laugh\]/);
      assert.match(rendered, /new/);
    }
    assert.deepEqual(h.query.state.data.timestampMetrics, original.timestampMetrics);
    const mapping = h.query.state.data.speakerDiffs[0].segmentMappings[0];
    assert.equal(mapping.segmentsA[0].startTimeInSeconds, 0.2);
    assert.equal(mapping.segmentsB[0].endTimeInSeconds, 2.5);
    assert.deepEqual(Array.from(mapping.segmentsA[0].wordRange), [0, 3]);
    assert.equal(h.query.state.data.speakerDiffs[0].segmentMappings[1].relationship, 'deleted');
  }
  assert.deepEqual(original, payload(), 'original native metrics/ranges/words are untouched');
  assert.deepEqual(h.selections, [], 'mode changes never bounce the native selection through null');
  assert.equal(h.bridge.clearExtendedDiffState().restored, true);
  assert.deepEqual(h.query.state.data, original);
  assert.equal(h.render(), nativeText);
  const writes = h.writes.length;
  h.flush();
  assert.equal(h.writes.length, writes, 'disabled callbacks cannot reapply the projection');
});

test('reference/current are relative to the open task, not the query side ordering', () => {
  const data = payload();
  data.referenceReviewActionId = 'task'; data.currentReviewActionId = 'comparison';
  const h = harness({ data });
  h.apply('current');
  assert.match(h.render(), /old \[laugh\] words/);
  assert.doesNotMatch(h.render(), /new/);
  h.apply('reference');
  assert.match(h.render(), /new words/);
  assert.doesNotMatch(h.render(), /old|laugh|deleted/);
  h.bridge.clearExtendedDiffState();
});

test('disable restores an initially inactive native comparison without speculative repaint timers', () => {
  const h = harness({ isDiffMode: false, selected: null });
  h.apply('reference'); h.apply('current');
  const writes = h.writes.length;
  h.flush();
  assert.equal(h.writes.length, writes, 'native projection never schedules a timer retry');
  assert.equal(h.timers.length, 0);
  assert.deepEqual(h.selections, ['comparison']);
  h.bridge.clearExtendedDiffState();
  assert.deepEqual(h.toggles, [true, false]);
});

test('in-flight native responses use the latest mode and disable restores the unmodified fetched payload', async () => {
  let resolve;
  const h = harness({ fetch: () => new Promise(done => { resolve = done; }) });
  h.apply('reference');
  const pending = h.window.fetch('/api/trpc/transcriptions.getTranscriptionDiff');
  h.apply('current');
  const fresh = payload();
  fresh.speakerDiffs[0].segmentMappings[0].hypothesisText = 'updated words';
  resolve(new Response(JSON.stringify(fresh)));
  const response = await pending;
  h.query.setData(await response.json(), { manual: true });
  assert.match(h.render(), /updated words/);
  assert.doesNotMatch(h.render(), /old|laugh|deleted/);
  h.bridge.clearExtendedDiffState();
  assert.deepEqual(h.query.state.data, fresh);
});

test('pending responses and timers cannot repaint a replaced task, including a same-route ABA remount', async () => {
  for (const replacement of ['other-task', 'task']) {
    let resolve;
    const h = harness({ fetch: () => new Promise(done => { resolve = done; }) });
    h.apply('reference');
    const pending = h.window.fetch('/api/trpc/transcriptions.getTranscriptionDiff');
    const writes = h.writes.length;
    h.mount(replacement);
    h.flush();
    assert.equal(h.writes.length, writes);
    resolve(new Response(JSON.stringify(payload())));
    assert.deepEqual(await (await pending).json(), payload(), 'stale response passes through without projection');
    assert.equal(h.bridge.clearExtendedDiffState().reason, 'stale-task');
    assert.equal(h.writes.length, writes);
  }
});

test('unrelated comparisons and responses completing after disable are never rewritten', async () => {
  let resolve;
  const h = harness({ fetch: () => new Promise(done => { resolve = done; }) });
  h.apply('reference');
  const unrelated = payload(); unrelated.currentReviewActionId = 'another-task';
  const first = h.window.fetch('/api/trpc/transcriptions.getTranscriptionDiff');
  resolve(new Response(JSON.stringify(unrelated)));
  assert.deepEqual(await (await first).json(), unrelated);
  const second = h.window.fetch('/api/trpc/transcriptions.getTranscriptionDiff');
  h.bridge.clearExtendedDiffState();
  resolve(new Response(JSON.stringify(payload())));
  assert.deepEqual(await (await second).json(), payload());
});

test('side projection keeps native split-turn alignment and tag metadata without dropping reference words', () => {
  const data = payload();
  const mapping = data.speakerDiffs[0].segmentMappings[0];
  mapping.relationship = 'split';
  mapping.segmentsB = [
    { annotationId: 'row-one', text: 'new', wordRange: [0, 1], startTimeInSeconds: 0.5, endTimeInSeconds: 1.5 },
    { annotationId: 'row-two', text: 'words', wordRange: [1, 2], startTimeInSeconds: 1.5, endTimeInSeconds: 2.5 }
  ];
  mapping.wordDiffs.splice(1, 0, { value: '[laugh]', status: 'removed', kind: 'tag', tagKey: 'laugh' });
  const h = harness({ data });
  for (const [mode, expected] of [['reference', ['old [laugh]', 'words']], ['current', ['new', 'words']]]) {
    h.apply(mode);
    const projected = h.query.state.data.speakerDiffs[0].segmentMappings[0];
    // Native diff rendering slices by current-side word positions; removed tokens wait
    // for the next current token instead of consuming a current-side position.
    const turns = projected.segmentsB.map(segment => {
      const [start, end] = segment.wordRange;
      const words = [];
      let position = 0, pending = [];
      for (const word of projected.wordDiffs) {
        if (word.status === 'removed') { pending.push(word.value); continue; }
        if (position >= start && position < end) { words.push(...pending, word.value); pending = []; }
        else if (position < start) pending = [];
        else break;
        position += 1;
      }
      if (pending.length && position === end) words.push(...pending);
      return words.join(' ').replace(/\s+/g, ' ').trim();
    });
    assert.deepEqual(turns, expected);
    const tag = projected.wordDiffs.find(word => word.kind === 'tag');
    assert.equal(tag.tagKey, 'laugh');
    assert.equal(tag.value, mode === 'reference' ? '[laugh]' : '');
    assert.equal(projected.relationship, 'split');
  }
  h.bridge.clearExtendedDiffState();
  assert.deepEqual(h.query.state.data, data);
});

test('native diff readiness comes from the matching query, including cache-only arrivals and errors', () => {
  const h = harness({ data: null });
  assert.equal(h.bridge.readExtendedDiffState().status, 'loading');
  assert.equal(h.timers.length, 0);
  h.query.state.data = payload();
  const ready = h.bridge.readExtendedDiffState();
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.payload, payload());
  h.apply('reference');
  assert.deepEqual(h.bridge.readExtendedDiffState().payload, payload(), 'snapshot exposes the original rather than the owned projection');
  const fresh = payload();
  fresh.speakerDiffs[0].segmentMappings[0].hypothesisText = 'cached edit';
  h.query.state.data = fresh;
  assert.deepEqual(h.bridge.readExtendedDiffState().payload, fresh);
  h.query.state.status = 'error';
  h.query.state.error = new Error('native query rejected');
  assert.equal(h.bridge.readExtendedDiffState().reason, 'native query rejected');
  h.bridge.dispose();
});

test('recovered pending query is admitted before payload arrival and drives all readonly diff modes', () => {
  const input = { referenceReviewActionId: 'comparison', currentReviewActionId: 'task' };
  const native = recoveredFacade().transcriptions.getTranscriptionDiff.useQuery(input, { enabled: true });
  assert.deepEqual(structuredClone(native.queryKey), [['transcriptions', 'getTranscriptionDiff'], { input, type: 'query' }]);
  const h = harness({ data: null, queryKey: native.queryKey });
  const pending = h.bridge.readExtendedDiffState();
  assert.equal(pending.ok, true);
  assert.equal(pending.status, 'loading', 'an actual pending facade query is not a missing native contract');
  assert.equal(h.timers.length, 0);
  h.query.state.data = payload();
  assert.equal(h.bridge.readExtendedDiffState().status, 'ready');
  for (const mode of ['reference', 'current', 'fusion']) {
    assert.equal(h.apply(mode).patchedCurrentDiffResult, true);
    const text = h.render();
    if (mode !== 'current') assert.match(text, /old \[laugh\]/);
    if (mode !== 'reference') assert.match(text, /new/);
    if (mode === 'reference') assert.doesNotMatch(text, /new/);
    if (mode === 'current') assert.doesNotMatch(text, /old|laugh|deleted/);
  }
  assert.equal(h.timers.length, 0);
  h.bridge.dispose();
});


test('an unsupported pending query contract still fails instead of waiting or polling', () => {
  const h = harness({ data: null, queryKey: ['transcriptions.getTranscriptionDiff',
    { referenceReviewActionId: 'comparison', currentReviewActionId: 'task' }] });
  const state = h.bridge.readExtendedDiffState();
  assert.equal(state.ok, false);
  assert.equal(state.reason, 'transcription-diff-query-not-found');
  assert.equal(h.timers.length, 0);
  h.bridge.dispose();
});

test('native commit notification announces cached updates without requiring a resource or DOM mutation', async () => {
  const h = harness();
  let commits = 0;
  h.window.addEventListener('babel-helper:native-editor-commit', () => { commits++; });
  h.commit();
  await Promise.resolve();
  assert.equal(commits, 1);
  h.bridge.dispose();
  h.commit();
  await Promise.resolve();
  assert.equal(commits, 1, 'teardown restores the native commit descriptor and listener');
});

test('native read identity rejects a same-route same-task remount before projection', () => {
  const h = harness();
  const snapshot = h.bridge.readExtendedDiffState();
  h.mount('task');
  const result = h.bridge.applyExtendedDiffState({ routeKey: snapshot.routeKey,
    nativeSessionGeneration: snapshot.generation, editorGeneration: snapshot.editorGeneration,
    selectedCompareActionId: 'comparison', textMode: 'reference' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale-task');
  assert.equal(h.writes.length, 0);
  h.bridge.dispose();
});

test('cache-only replacement supersedes earlier fetched originals without losing native edits on disable', async () => {
  const h = harness();
  h.apply('reference');
  const sharedProjection = h.query.state.data;
  const response = await h.window.fetch('/api/trpc/transcriptions.getTranscriptionDiff');
  h.query.setData(await response.json(), { manual: true });
  assert.equal(h.query.state.data, sharedProjection, 'an equal fetched projection retains the older query root');
  h.apply('reference');
  const fresh = payload();
  fresh.speakerDiffs[0].segmentMappings[0].hypothesisText = 'cached words';
  h.query.state.data = fresh;
  assert.deepEqual(h.bridge.readExtendedDiffState().payload, fresh);
  h.apply('current');
  assert.match(h.render(), /cached words/);
  const later = payload();
  later.speakerDiffs[0].segmentMappings[0].hypothesisText = 'later cache edit';
  h.query.state.data = later;
  h.bridge.clearExtendedDiffState();
  assert.deepEqual(h.query.state.data, later, 'cleanup does not restore over an unowned native update');
  h.bridge.dispose();
});

test('an unconsumed fetched projection cannot claim a later cache-only value by action IDs', async () => {
  const h = harness();
  h.apply('reference');
  const response = await h.window.fetch('/api/trpc/transcriptions.getTranscriptionDiff');
  h.query.setData(await response.json(), { manual: true });
  const fresh = payload();
  fresh.speakerDiffs[0].segmentMappings[0].hypothesisText = 'native cache replacement';
  h.query.state.data = fresh;
  assert.deepEqual(h.bridge.readExtendedDiffState().payload, fresh);
  h.bridge.clearExtendedDiffState();
  assert.deepEqual(h.query.state.data, fresh);
  h.bridge.dispose();
});
