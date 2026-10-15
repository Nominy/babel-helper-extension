import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function loadEntry(entryPoint) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

const { registerGhostCursor } = await loadEntry('src/features/ghost-cursor.ts');
const { createRowTimeApi } = await loadEntry('src/site/row-time.ts');
const { registerFocusToggle } = await loadEntry('src/features/focus-toggle-feature.ts');
const { registerSpeakerWorkflow } = await loadEntry('src/features/speaker-workflow.ts');
const { registerPlaybackRowTracking } = await loadEntry('src/features/playback-row-tracking.ts');
const { buildCurrentL0TimingTaskId } = await loadEntry('src/services/l0-timing-identity.ts');
const { createState } = await loadEntry('src/core/state-store.ts');
const { getCurrentL0TimingIndex } = await loadEntry('src/content/l0-timing-listener.ts');
const { registerAutoSegmentation } = await loadEntry('src/features/auto-segmentation.ts');
const SOURCE_EVENT = 'babel-audio-enhancement-state';

class ElementFixture {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = new Map();
    this.parentNode = null;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.offsetWidth = 300;
    this.offsetHeight = 24;
    this.textContent = '';
  }
  get parentElement() { return this.parentNode; }
  get ownerDocument() { return globalThis.document; }
  get isConnected() { return this.root === true || this.parentNode?.isConnected === true; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches?.(selector)) return child;
      const found = child.querySelector?.(selector);
      if (found) return found;
    }
    return null;
  }
  matches(selector) {
    return selector === this.tagName ||
      (selector === 'section[data-annotation-id]' && this.tagName === 'section' && Boolean(this.dataset.annotationId)) ||
      (selector.includes('[data-slate-editor') && this.getAttribute('data-slate-editor') === 'true');
  }
  getBoundingClientRect() {
    const preceding = this.tagName === 'span' ? this.parentNode.children.slice(0, this.parentNode.children.indexOf(this)) : [];
    const left = 10 + preceding.reduce((length, child) => length + (child.textContent?.length ?? 0), 0) * 5;
    return { top: 10, bottom: 34, left, right: left + 300, height: 24, width: 300 };
  }
}
class EditorControlFixture {
  constructor(row, value) {
    this.row = row;
    this.element = row.appendChild(new ElementFixture('div'));
    this.element.setAttribute('data-slate-editor', 'true');
    this.value = value;
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  get isConnected() { return this.row.isConnected; }
  getCaretRect(offset) { return { top: 10, left: 10 + offset * 5, height: 24 }; }
}
class RowFixture extends ElementFixture {
  constructor(annotationId, lane) {
    super('section');
    this.identity = { annotationId, processedRecordingId: `stable-${lane}`, speakerKey: `stable-${lane}`, trackLabel: `Speaker ${lane}`, startText: '0:00', endText: '0:20', startSeconds: 0, endSeconds: 20 };
    this.dataset.annotationId = annotationId;
    this.editor = new EditorControlFixture(this, 'alpha beta gamma delta');
  }
  dispatchEvent(event) {
    if (event.type !== 'babel-helper:editor-control') return true;
    const request = JSON.parse(event.detail);
    if (!['read', 'identity', 'offsetAtPoint', 'select'].includes(request.operation)) return false;
    if (request.operation === 'select') {
      this.editor.selectionStart = request.start;
      this.editor.selectionEnd = request.end;
    }
    const offset = request.operation === 'offsetAtPoint'
      ? Math.max(0, Math.min(this.editor.value.length, Math.floor((request.x - 10) / 5)))
      : this.editor.selectionStart;
    this.setAttribute('data-babel-helper-editor-result', JSON.stringify({
      ...this.identity,
      id: request.id, ok: true, annotationId: this.identity.annotationId,
      reviewActionId: document.documentElement.getAttribute('data-babel-review-action-id'),
      text: this.editor.value, start: offset, end: offset, direction: 'none', readOnly: false
    }));
    return true;
  }
}

async function flush() { for (let count = 0; count < 5; count += 1) await Promise.resolve(); }

function createHarness(t) {
  const descriptors = new Map();
  const install = (key, value) => {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const documentListeners = new Map();
  const sourceListeners = new Set();
  const intervals = new Map();
  const playbackListeners = new Set();
  const timers = new Map();
  let nextTimerId = 0;
  const root = new ElementFixture('html');
  root.root = true;
  const body = root.appendChild(new ElementFixture('body'));
  const head = root.appendChild(new ElementFixture('head'));
  const document = {
    documentElement: root, body, head, hidden: false, activeElement: body,
    get location() { return window.location; },
    createElement: (tagName) => new ElementFixture(tagName),
    createTextNode: (textContent) => ({ textContent, parentNode: null }),
    querySelector: (selector) => selector.startsWith('style[') ? head.children.find((child) => child.tagName === 'style') ?? null : body.querySelector(selector),
    addEventListener(type, callback) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { documentListeners.get(type)?.delete(callback); }
  };
  const window = {
    location: { pathname: '/transcription/shared', search: '', href: 'https://babel.test/transcription/shared' },
    devicePixelRatio: 1,
    getComputedStyle: () => ({ lineHeight: '24px', overflowY: 'visible' }),
    addEventListener(type, callback) { if (type === SOURCE_EVENT) sourceListeners.add(callback); },
    removeEventListener(type, callback) { if (type === SOURCE_EVENT) sourceListeners.delete(callback); },
    setTimeout(callback) { const id = ++nextTimerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  install('document', document);
  install('window', window);
  install('location', window.location);
  install('HTMLElement', ElementFixture);
  install('Element', ElementFixture);
  install('CustomEvent', class extends Event {
    constructor(type, options) { super(type); this.detail = options.detail; }
  });
  install('getComputedStyle', window.getComputedStyle);
  install('setInterval', (callback) => { const id = ++nextTimerId; intervals.set(id, callback); return id; });
  install('clearInterval', (id) => intervals.delete(id));
  root.setAttribute('data-babel-review-action-id', 'task-one');
  let source = { version: 2, taskId: 'task-one', status: 'ready', strength: 0, desiredStrength: 0, variantKey: '', revision: 1 };
  root.setAttribute('data-babel-audio-enhancement', JSON.stringify(source));
  const rows = [new RowFixture('annotation-one', 1), new RowFixture('annotation-two', 2)];
  rows.forEach((row) => body.appendChild(row));
  const pendingPlayback = [];
  let playbackCalls = 0;
  const harness = { playback: { ok: true, paused: false, currentTime: 1 }, bridge: async () => ({ ok: true }) };
  root.dispatchEvent = event => {
    if (event.type !== 'babel-helper:editor-control') return true;
    const request = JSON.parse(event.detail);
    if (request.operation !== 'session') return true;
    if (!window.location.pathname.startsWith('/transcription/')) return true;
    root.setAttribute('data-babel-helper-editor-result', JSON.stringify({
      id: request.id, ok: true,
      reviewActionId: harness.nativeTaskId || root.getAttribute('data-babel-review-action-id') || source.taskId,
      readOnly: false, routeKey: window.location.pathname + window.location.search
    }));
    return true;
  };
  const playbackSample = () => ({ ...harness.playback,
    recordingTracks: harness.recordingTracks || [...new Map(rows.map(row => [
      row.identity.processedRecordingId, { id: row.identity.processedRecordingId, label: row.identity.trackLabel }
    ])).values()]
  });
  const helper = {
    state: createState(), config: { features: { proportionalCursorRestore: true }, rowEditorSelector: '[data-slate-editor="true"]' },
    settings: { ghostCursor: { gradientEnabled: false } },
    runtime: { isSessionInteractive: () => window.location.pathname.startsWith('/transcription/') },
    isFeatureEnabled: () => true,
    getTranscriptRows: () => rows.filter((row) => row.isConnected),
    getRowIdentity: (row) => row?.identity ?? null,
    getRowSpeakerKey: (row) => row?.identity.speakerKey ?? '',
    normalizeText: (element) => element.textContent,
    rowMatchesIdentity: (row, identity) => row.identity.annotationId === identity.annotationId,
    findRowByIdentity: (identity) => rows.find((row) => row.isConnected && row.identity.annotationId === identity.annotationId) ?? null,
    getRowEditor: (row) => row?.editor ?? null,
    getActiveRowEditor: () => harness.focusedEditor ?? null,
    setCurrentRow(row) { this.state.currentRow = row; this.state.currentRowIdentity = row?.identity ?? null; },
    getCurrentRow() { return this.findRowByIdentity(this.state.currentRowIdentity ?? {}) ?? null; },
    getPlaybackState() { playbackCalls += 1; return pendingPlayback.shift()?.promise ?? Promise.resolve({ ...harness.playback }); },
    subscribePlayback(listener) {
      playbackListeners.add(listener);
      queueMicrotask(() => {
        if (playbackListeners.has(listener) && !document.hidden) listener(playbackSample());
      });
      return () => playbackListeners.delete(listener);
    },
    reportPlaybackFailure(result) { harness.failure = result; },
    focusRow(row, options = {}) {
      harness.focusedEditor = row.editor;
      document.activeElement = row.editor.element;
      row.editor.selectionStart = options.selectionStart ?? 0;
      row.editor.selectionEnd = options.selectionEnd ?? row.editor.selectionStart;
      helper.setCurrentRow(row);
      return true;
    }
  };
  helper.state.cursorBaseline = 6;
  helper.state.blurPlaybackTime = 1;
  helper.state.lastBlur = { row: rows[0], selectionStart: 6, selectionEnd: 6, direction: 'none' };
  helper.setCurrentRow(rows[0]);
  const api = { time: createRowTimeApi(helper), playback: { unavailablePlaybackState: () => ({ ok: false }), callPlaybackBridge: (...args) => harness.bridge(...args) } };
  api.cursor = registerGhostCursor(helper, api);
  api.speaker = registerSpeakerWorkflow(helper, api);
  registerFocusToggle(helper, api);
  registerPlaybackRowTracking(helper);
  Object.assign(harness, {
    helper, api, rows, body, root, window, sourceListeners, documentListeners, intervals, timers, playbackListeners,
    playbackCalls: () => playbackCalls,
    deferPlayback() { const request = Promise.withResolvers(); pendingPlayback.push(request); return request; },
    visibility(hidden) {
      document.hidden = hidden;
      for (const listener of [...documentListeners.get('visibilitychange') || []]) listener({ type: 'visibilitychange' });
      if (!hidden) queueMicrotask(() => {
        for (const listener of [...playbackListeners]) listener(playbackSample());
      });
    },
    publish(update) {
      source = { ...source, ...update, revision: source.revision + 1 };
      root.setAttribute('data-babel-audio-enhancement', JSON.stringify(source));
      for (const listener of [...sourceListeners]) listener({ type: SOURCE_EVENT });
    },
    installTiming(tracks) {
      helper.state.l0TimingIndex = { taskId: buildCurrentL0TimingTaskId(helper), tracks };
      helper.state.l0TimingPairKey = source.pairedVariantKey || null;
    },
    async tick() { for (const listener of [...playbackListeners]) listener(playbackSample()); await flush(); },
    async start(row = rows[0]) { api.cursor.startGhostCursor(row); await flush(); },
    replaceRow(row) {
      row.remove();
      const replacement = new RowFixture(row.identity.annotationId, row.identity.trackLabel.endsWith('1') ? 1 : 2);
      rows[rows.indexOf(row)] = replacement;
      body.appendChild(replacement);
      return replacement;
    }
  });
  t.after(() => {
    helper.unbindRowTracking();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return harness;
}

const words = (starts) => ['alpha', 'beta', 'gamma', 'delta'].map((text, index) => ({ id: text, text, startSeconds: starts[index], endSeconds: starts[index] + 1 }));

test('ghost restore scrolls only the native viewport and has no outer fallback', t => {
  const h = createHarness(t);
  const viewport = new ElementFixture();
  viewport.matches = selector => selector === '[data-transcript-scroll]';
  viewport.clientTop = 1;
  viewport.clientHeight = 200;
  viewport.scrollHeight = 500;
  viewport.scrollTop = 150;
  viewport.getBoundingClientRect = () => ({ top: 10, bottom: 212, height: 202 });
  h.body.appendChild(viewport);
  h.rows[0].remove();
  viewport.appendChild(h.rows[0]);
  h.body.scrollTop = 31;
  h.api.cursor.scrollToCaret(h.rows[0], 6);
  assert.equal(viewport.scrollTop, 61);
  assert.equal(h.body.scrollTop, 31);
  h.rows[0].remove();
  h.body.appendChild(h.rows[0]);
  h.api.cursor.scrollToCaret(h.rows[0], 6);
  assert.equal(h.body.scrollTop, 31, 'missing transcript viewport must not select an outer scrolling element');
});

test('paired source switching freezes one cursor, preserves baseline/lane, and uses only current-variant timing', async (t) => {
  const h = createHarness(t);
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 6, 12, 18]) }, { lane: 'stable-2', tokens: words([0, 2, 4, 6]) }]);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  assert.equal(h.playbackListeners.size, 1);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.helper.state.ghostCursorOffset, 6);
  h.publish({ status: 'switching', desiredStrength: 100 });
  assert.equal(h.intervals.size, 0, 'source publication suspends all cursor wakeups until ready');
  h.playback = { ok: true, paused: true, currentTime: 0 };
  h.root.removeAttribute('data-babel-review-action-id');
  const calls = h.playbackCalls();
  await h.tick();
  assert.equal(await h.helper.syncCurrentRowToPlayback(), null);
  assert.equal(h.playbackCalls(), calls, 'owned load does not query its temporarily paused transport');
  assert.equal(h.helper.state.ghostCursorElement, element);
  assert.equal(h.helper.state.ghostCursorOffset, 6);
  assert.equal(element.style.display, 'none');
  assert.equal(h.helper.toggleGhostCursorLane(), true, 'lane choice can change while projection is frozen');
  h.root.setAttribute('data-babel-review-action-id', 'task-one');
  h.publish({ status: 'ready', strength: 100, variantKey: 'enhanced-a' });
  h.playback = { ok: true, paused: false, currentTime: 3 };
  await h.tick();
  assert.equal(h.helper.state.l0TimingIndex, null, 'original word times are not reused for enhanced audio');
  assert.equal(h.helper.state.ghostCursorProjectionSpeakerKey, 'stable-2');
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 1, 3, 10]) }, { lane: 'stable-2', tokens: words([0, 1, 3, 10]) }]);
  await h.tick();
  assert.equal(h.helper.state.ghostCursorOffset, 11);
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[1], 12), 3);
  const projection = h.helper.state.ghostCursorLaneProjections['stable-2'];
  const rememberedTime = h.helper.state.ghostCursorPlaybackTime;
  h.publish({ message: 'Cache hit', progress: { phase: 'cache-hit', trackId: 'stable-2', trackIndex: 1, trackCount: 2, completedChunks: 0, totalChunks: 0 } });
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-2'], projection);
  assert.equal(h.helper.state.ghostCursorPlaybackTime, rememberedTime, 'progress revision does not churn transport');
  assert.notEqual(element.style.display, 'none');
  h.publish({ status: 'switching', desiredStrength: 0, progress: undefined });
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[1], 12), null);
  h.publish({ status: 'ready', strength: 0, variantKey: '' });
  await h.tick();
  assert.equal(h.helper.state.ghostCursorOffset, 11, 'source change retains the projected caret floor');
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 1, 3, 5]) }, { lane: 'stable-2', tokens: words([0, 1, 3, 5]) }]);
  h.playback.currentTime = 6;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorOffset, 22);
  assert.equal(h.helper.state.cursorBaseline, 6);
  assert.equal(h.helper.state.ghostCursorElement, element);
  assert.equal(h.playbackListeners.size, 1, 'ready retains exactly one native cursor subscription');
  h.playback.paused = true;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, null, 'a real pause after paired ready disposes normally');
  assert.equal(h.intervals.size, 0);
  assert.equal(h.sourceListeners.size, 0);
});

test('returning to Original restores its word pins and Escape caret without another timing publication', async (t) => {
  const h = createHarness(t);
  h.helper.state.blurRestorePending = true;
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 1, 2, 10]) }]);
  await h.start();
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), 2);
  const element = h.helper.state.ghostCursorElement;
  h.publish({ status: 'switching', desiredStrength: 100 });
  h.publish({ status: 'ready', strength: 100, variantKey: 'enhanced-a' });
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 6, 12, 18]) }]);
  await h.tick();
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), 12);
  h.publish({ status: 'switching', desiredStrength: 0 });
  h.publish({ status: 'ready', strength: 0, variantKey: '' });
  h.playback.currentTime = 4;
  await h.tick();
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), 2);
  assert.equal(h.helper.state.ghostCursorElement, element);
  assert.equal(h.helper.state.ghostCursorOffset, 16, 'the cursor reaches the timed end of gamma, not the proportional character');
  assert.equal(h.helper.toggleEditorFocus(), true);
  assert.equal(h.rows[0].editor.selectionStart, 16);
  assert.equal(h.rows[0].editor.selectionEnd, 16);
});

test('Enhanced-only word pins remain timed on its verified Original clock without becoming Original ASR results', async (t) => {
  const h = createHarness(t);
  const variant = 'b'.repeat(64);
  h.publish({ strength: 100, desiredStrength: 100, variantKey: variant, pairedVariantKey: variant });
  h.helper.state.blurRestorePending = true;
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 1, 2, 10]) }]);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  for (let cycle = 0; cycle < 3; cycle++) {
    h.publish({ status: 'switching', desiredStrength: 0 });
    h.publish({ status: 'ready', strength: 0, variantKey: '' });
    h.playback.currentTime = 4;
    await h.tick();
    assert.equal(getCurrentL0TimingIndex(h.helper.state, h.helper), null, 'ASR/segmentation lookup stays source-specific');
    assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), 2);
    assert.equal(h.helper.state.ghostCursorOffset, 16);
    assert.equal(h.helper.state.ghostCursorElement, element);
    h.publish({ status: 'switching', desiredStrength: 100 });
    h.publish({ status: 'ready', strength: 100, variantKey: variant });
    await h.tick();
    assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), 2);
  }
  h.publish({ status: 'ready', strength: 0, desiredStrength: 0, variantKey: '' });
  await h.tick();
  assert.equal(h.helper.toggleEditorFocus(), true);
  assert.equal(h.rows[0].editor.selectionStart, 16);
  h.publish({ pairedVariantKey: 'c'.repeat(64) });
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), null, 'another paired graph cannot borrow the old pins');
  h.publish({ pairedVariantKey: undefined });
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), null, 'no clock proof means no cross-source playback timing');
  h.publish({ pairedVariantKey: variant });
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 6, 12, 18]) }]);
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), 12, 'Original-specific timing takes precedence once available');
});

test('mixed strengths retain paired playback pins while recognition identities and timing ownership stay distinct', async (t) => {
  const h = createHarness(t);
  const fullPair = 'b'.repeat(64);
  h.publish({ strength: 100, desiredStrength: 100, variantKey: fullPair, pairedVariantKey: fullPair });
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 1, 2, 10]) }]);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  for (const strength of [65, 25, 0, 100]) {
    h.publish({ status: 'switching', desiredStrength: strength });
    assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), null);
    h.publish({ status: 'ready', strength, variantKey: strength === 0 ? '' : strength === 100 ? fullPair : `${strength}`.padEnd(64, 'a') });
    h.playback.currentTime = 4;
    await h.tick();
    assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), 2);
    assert.equal(h.helper.state.ghostCursorOffset, 16);
    assert.equal(h.helper.state.ghostCursorElement, element);
    assert.equal(Boolean(getCurrentL0TimingIndex(h.helper.state, h.helper)), strength === 100);
  }
  h.publish({ strength: 65, desiredStrength: 65, variantKey: 'c'.repeat(64) });
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 6, 12, 18]) }]);
  await h.tick();
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), 12);
  h.publish({ strength: 25, desiredStrength: 25, variantKey: 'd'.repeat(64) });
  await h.tick();
  assert.equal(getCurrentL0TimingIndex(h.helper.state, h.helper), null);
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), 12, 'latest paired mix pins may guide another playback strength');
  h.publish({ pairedVariantKey: 'e'.repeat(64), variantKey: 'f'.repeat(64) });
  await h.tick();
  assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), null, 'different full source/model pair cannot borrow the old mix pins');
});

function registerSegmentationWithoutAudio(h) {
  h.helper.trimAllSegmentsToAudio = async () => ({ ok: false, reason: 'missing-native-audio' });
  registerAutoSegmentation(h.helper, {
    site: {
      clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
      discoverWaveformContainers: () => [],
      getRowTimeLabels: row => ({ startText: row.identity.startText, endText: row.identity.endText })
    },
    progress: { updateLongTaskProgress() {}, dismissLongTaskProgress() {} },
    loop: {}, trim: {}, split: {}
  });
}

test('auto segmentation uses available exact or paired timestamps without requiring a timing provider', async t => {
  for (const strength of [0, 50, 100]) await t.test(`strength ${strength}`, async t => {
    const h = createHarness(t), pair = 'b'.repeat(64);
    h.publish({ strength: 100, desiredStrength: 100, variantKey: pair, pairedVariantKey: pair });
    h.installTiming([{ lane: 'stable-1', tokens: words([0, 1, 2, 10]) }]);
    assert.equal(h.helper.getL0TimestampForRowOffset(h.rows[0], 12), 2);
    h.publish({ strength, desiredStrength: strength, variantKey: strength === 0 ? '' : strength === 100 ? pair : 'c'.repeat(64) });
    registerSegmentationWithoutAudio(h);
    const result = await h.helper.autoSegmentVisibleSilences();
    assert.equal(result.reason, 'missing-native-audio', 'existing clocks reach waveform processing rather than provider admission/wait');
    assert.equal(h.helper.state.autoSegmentationPending, false);
  });
});

test('auto segmentation accepts timestamps arriving while broker admission is pending and releases that pending port', async t => {
  const h = createHarness(t), previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const messages = new Set(), disconnects = new Set();
  let disconnected = 0, requests = 0;
  const event = group => ({ addListener: listener => group.add(listener), removeListener: listener => group.delete(listener) });
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: {
    sendMessage() { throw new Error('Message transport must not be used'); },
    connect() { return { onMessage: event(messages), onDisconnect: event(disconnects),
      postMessage() { requests++; }, disconnect() { disconnected++; } }; }
  } } });
  t.after(() => previousChrome ? Object.defineProperty(globalThis, 'chrome', previousChrome) : delete globalThis.chrome);
  h.root.setAttribute('data-babel-gold-drafting-extension-id', 'a'.repeat(32));
  registerSegmentationWithoutAudio(h);
  h.helper.sleep = async () => { h.installTiming([{ lane: 'stable-1', tokens: words([0, 1, 2, 10]) }]); await flush(); };
  const result = await h.helper.autoSegmentVisibleSilences();
  assert.equal(result.reason, 'missing-native-audio');
  assert.equal(requests, 1);
  assert.equal(disconnected, 1);
  assert.equal(h.helper.state.autoSegmentationPending, false);
});

test('native source-ready samples resume the same cursor without command reads', async (t) => {
  const h = createHarness(t);
  h.helper.getPlaybackState = () => { throw new Error('automation must not query the clock'); };
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  h.publish({ status: 'switching', desiredStrength: 100 });
  h.playback = { ok: true, paused: true, currentTime: 0 };
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, element);
  assert.equal(element.style.display, 'none');
  h.publish({ status: 'ready', strength: 100, variantKey: 'enhanced-a' });
  h.playback = { ok: true, paused: false, currentTime: 8 };
  await h.tick();
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 8);
  assert.notEqual(element.style.display, 'none');
  h.publish({ message: 'Cache ready' });
  h.playback.currentTime = 14;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 14);
  assert.equal(h.intervals.size + h.timers.size, 0);
});

test('an explicit pause retained by the native paired load stops normally at ready', async (t) => {
  const h = createHarness(t);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  h.publish({ status: 'switching', desiredStrength: 100 });
  h.playback.paused = true;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, element);
  h.publish({ status: 'ready', strength: 100, variantKey: 'enhanced-a' });
  await h.tick();
  assert.equal(h.playback.paused, true, 'cursor does not force the native transport to resume');
  assert.equal(h.helper.state.ghostCursorElement, null);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.sourceListeners.size, 0);
});

test('row synchronization consumes native samples only and suspends owned source loads', async (t) => {
  const h = createHarness(t);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  h.helper.getPlaybackState = () => { throw new Error('row synchronization must not query'); };
  h.publish({ status: 'switching', desiredStrength: 100 });
  assert.equal(h.helper.syncCurrentRowToPlayback({ ok: true, paused: true, currentTime: 0 }), null);
  h.publish({ status: 'ready', strength: 100, variantKey: 'enhanced-a' });
  h.playback.currentTime = 5;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, element);
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 5);
});

test('speaker filtering retargets committed connected rows and repeated lane toggles own one subscription', async (t) => {
  const h = createHarness(t);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  const switchRequest = Promise.withResolvers();
  h.bridge = () => switchRequest.promise;
  const switching = h.helper.switchSpeakerWorkflow('Speaker 2');
  h.rows[0].remove();
  const secondRow = h.replaceRow(h.rows[1]);
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, element);
  assert.equal(element.style.display, 'none');
  switchRequest.resolve({ ok: true });
  assert.equal(await switching, true);
  h.playback.currentTime = 8;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorRow, secondRow);
  assert.equal(h.helper.state.lastBlur.row, secondRow);
  assert.equal(h.helper.state.ghostCursorLaneLock.speakerKey, 'stable-2');
  assert.equal(h.helper.state.ghostCursorElement, element);
  const firstRow = h.replaceRow(h.rows[0]);
  h.bridge = async () => ({ ok: true });
  assert.equal(await h.helper.switchSpeakerWorkflow('Speaker 1'), true);
  await h.tick();
  assert.equal(h.helper.state.ghostCursorRow, firstRow);
  assert.equal(await h.helper.resetSpeakerWorkflow(), true);
  await h.tick();
  for (let count = 0; count < 10; count += 1) {
    assert.equal(h.helper.toggleGhostCursorLane(), true);
    await h.tick();
    assert.equal(h.helper.state.ghostCursorRow.isConnected, true);
  }
  assert.equal(h.playbackListeners.size, 1);
  assert.equal(h.sourceListeners.size, 1);
  assert.equal(h.helper.state.ghostCursorElement, element);
});

test('same-annotation remount preserves baseline while same-route task navigation cannot reuse that identity', async (t) => {
  const h = createHarness(t);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  const replacement = h.replaceRow(h.rows[0]);
  h.playback.currentTime = 8;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorRow, replacement);
  assert.equal(h.helper.state.lastBlur.row, replacement);
  assert.equal(h.helper.getGhostCursorTarget().row, replacement);
  assert.equal(h.helper.state.cursorBaseline, 6);
  assert.equal(h.helper.state.ghostCursorElement, element);
  h.nativeTaskId = 'task-two';
  h.publish({ taskId: 'task-two', strength: 0, desiredStrength: 0, variantKey: '' });
  assert.equal(h.helper.getGhostCursorTarget(), null);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.sourceListeners.size, 0);
  assert.deepEqual(h.helper.state.ghostCursorLaneProjections, {});
  await h.start(replacement);
  const nextElement = h.helper.state.ghostCursorElement;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, nextElement, 'prior task completion cannot dispose the new task');
  h.window.location.pathname = '/projects';
  h.window.location.href = 'https://babel.test/projects';
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, null);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.sourceListeners.size, 0);
});

test('row tracking teardown cancels cursor ownership and late synchronization across repeated sessions', async (t) => {
  const h = createHarness(t);
  for (let count = 0; count < 3; count += 1) {
    h.helper.bindRowTracking();
    await h.start();
    const retired = [...h.playbackListeners];
    h.helper.unbindRowTracking();
    for (const listener of retired) listener({ ok: true, paused: false, currentTime: 10 });
    assert.equal(h.helper.state.ghostCursorRow, null);
    assert.equal(h.helper.state.ghostCursorElement, null);
    assert.equal(h.helper.state.ghostCursorLaneLock, null);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.sourceListeners.size, 0);
    assert.equal([...h.documentListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0);
  }
});

test('cancelled speaker work cannot change a new task lane or release its pending operation', async (t) => {
  const h = createHarness(t);
  await h.start();
  const previousRequest = Promise.withResolvers();
  h.bridge = () => previousRequest.promise;
  const previousSwitch = h.helper.switchSpeakerWorkflow('Speaker 2');
  h.helper.unbindRowTracking();
  h.root.setAttribute('data-babel-review-action-id', 'task-two');
  h.publish({ taskId: 'task-two' });
  await h.start();
  const currentRequest = Promise.withResolvers();
  h.bridge = () => currentRequest.promise;
  const currentSwitch = h.helper.switchSpeakerWorkflow('Speaker 1');
  previousRequest.resolve({ ok: true });
  assert.equal(await previousSwitch, false);
  assert.equal(h.helper.state.speakerSwitchPending, true);
  assert.notEqual(h.helper.state.ghostCursorLaneLock?.speakerKey, 'stable-2');
  currentRequest.resolve({ ok: true });
  assert.equal(await currentSwitch, true);
  assert.equal(h.helper.state.speakerSwitchPending, false);
  assert.equal(h.helper.state.ghostCursorLaneLock.speakerKey, 'stable-1');
  await h.tick();
  assert.equal(h.helper.state.ghostCursorRow.isConnected, true);
  assert.equal(h.playbackListeners.size, 1);
});

test('Escape teardown preserves valid same-task lane projections for focused Tab switching', async (t) => {
  const h = createHarness(t);
  h.playback.currentTime = 8;
  await h.start();
  const target = h.helper.getGhostCursorTarget();
  h.helper.state.blurRestorePending = true;
  assert.equal(h.helper.toggleEditorFocus(), true);
  assert.equal(h.helper.getActiveRowEditor(), h.rows[0].editor);
  assert.equal(h.rows[0].editor.selectionStart, target.offset);
  assert.equal(h.helper.state.ghostCursorElement, null);
  assert.equal(h.helper.toggleGhostCursorLane(), true);
  assert.equal(h.helper.getActiveRowEditor(), h.rows[1].editor);
  assert.equal(h.helper.toggleGhostCursorLane(), true);
  assert.equal(h.helper.getActiveRowEditor(), h.rows[0].editor);
  assert.equal(h.rows[0].editor.selectionStart >= target.offset, true);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.sourceListeners.size, 0);
});

test('native speaker filtering with equal row counts/ranges rebuilds the lane cache instead of retaining detached rows', async (t) => {
  const h = createHarness(t);
  h.rows[1].remove();
  await h.start(h.rows[0]);
  const element = h.helper.state.ghostCursorElement;
  h.playback.currentTime = 8;
  for (const lane of [1, 0, 1, 0]) {
    h.rows[1 - lane].remove();
    h.body.appendChild(h.rows[lane]);
    await h.tick();
    assert.equal(h.helper.state.ghostCursorRow, h.rows[lane]);
    assert.equal(h.helper.state.ghostCursorRow.isConnected, true);
    assert.equal(h.helper.state.ghostCursorElement, element);
    assert.notEqual(element.style.display, 'none');
    assert.equal(h.api.time.getRowTimeEntries()[0].row, h.rows[lane]);
  }
  assert.equal(h.playbackListeners.size, 1);
  assert.equal(h.sourceListeners.size, 1);
});

test('disabling proportional restore live removes its cursor and subscriptions', async (t) => {
  const h = createHarness(t);
  await h.start();
  assert.notEqual(h.helper.state.ghostCursorElement, null);
  h.helper.config.features.proportionalCursorRestore = false;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, null);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.sourceListeners.size, 0);
  assert.equal(h.helper.getGhostCursorTarget(), null);
});

test('shortening a native turn clamps a remembered proportional baseline to raw text length', (t) => {
  const h = createHarness(t);
  const result = h.api.cursor.computeRestoreOffset('short', { startSeconds: 0, endSeconds: 20 }, 10, 1, 200);
  assert.deepEqual(result, { offset: 5, clamped: true });
});

test('an Escape playback query cannot restore focus or resume audio in a replacement task', async (t) => {
  const h = createHarness(t);
  const changes = [];
  h.helper.setPlaybackPaused = async (paused) => { changes.push(paused); };
  const pending = h.deferPlayback();
  assert.equal(h.helper.handleEscapeWorkflow(), true);
  await flush();
  h.root.setAttribute('data-babel-review-action-id', 'task-replacement');
  pending.resolve({ ok: true, paused: false, currentTime: 7 });
  await flush();
  assert.deepEqual(changes, []);
  assert.equal(h.focusedEditor, undefined);
  assert.equal(h.helper.state.ghostCursorElement, null);
});

test('ghost lane switching uses native track IDs and includes a third custom-labeled speaker', async (t) => {
  const h = createHarness(t);
  const third = new RowFixture('annotation-three', 3);
  h.rows.push(third);
  h.body.appendChild(third);
  const labels = ['Interviewer', 'Guest', 'Interpreter'];
  h.rows.forEach((row, index) => { row.identity.trackLabel = labels[index]; });
  h.helper.getEditorSnapshot = () => assert.fail('lane cycling must use native recording metadata');
  await h.start();
  assert.equal(h.helper.toggleGhostCursorLane(), true);
  assert.equal(h.helper.getGhostCursorTarget()?.row, h.rows[1]);
  assert.equal(h.helper.toggleGhostCursorLane(), true);
  assert.equal(h.helper.getGhostCursorTarget()?.row, third);
});

test('exact word seek owns native mousedown/mouseup and never falls through on missing timing', async t => {
  const h = createHarness(t);
  h.helper.bindRowTracking();
  const sought = [];
  h.helper.seekPlaybackBySeconds = async seconds => { sought.push(seconds); return true; };
  let timestamp = null;
  h.helper.getL0TimestampForRowOffset = (_row, offset) => offset === 6 ? timestamp : null;
  const gesture = (type, target = h.rows[0].editor.element) => {
    const event = { type, target, button: 0, altKey: true, clientX: 40, clientY: 15,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const listener of h.documentListeners.get(type) || []) listener(event);
    return event;
  };
  for (const type of ['mousedown', 'mouseup', 'click']) {
    assert.equal(gesture(type).stopped, true, `${type} must not reach native approximate playback`);
    assert.equal(h.focusedEditor, undefined, 'activation must not remount Slate inside the mouse event');
  }
  await flush();
  assert.deepEqual(sought, []);
  assert.equal(h.focusedEditor, undefined, 'missing timing must not activate a native turn and seek its start');
  assert.equal(h.playbackCalls(), 0);
  timestamp = 4.5;
  for (const type of ['mousedown', 'mouseup', 'click']) gesture(type);
  await flush();
  assert.deepEqual(sought, [3.5], 'one exact seek from current time 1');
  const outside = new ElementFixture('input');
  h.body.appendChild(outside);
  assert.equal(gesture('mousedown', outside).stopped, undefined);
  h.helper.isFeatureEnabled = key => key !== 'rowActions';
  assert.equal(gesture('mousedown').stopped, undefined, 'disabled restores native gesture handling');
});

test('word seek rechecks exact timing after asynchronous playback state resolves', async t => {
  const h = createHarness(t);
  h.helper.bindRowTracking();
  const sought = [];
  h.helper.seekPlaybackBySeconds = async seconds => { sought.push(seconds); return true; };
  let timestamp = 4.5;
  h.helper.getL0TimestampForRowOffset = () => timestamp;
  const pending = h.deferPlayback();
  for (const type of ['mousedown', 'mouseup', 'click']) {
    for (const listener of h.documentListeners.get(type)) listener({
      type, target: h.rows[0].editor.element, button: 0, altKey: true, clientX: 40, clientY: 15,
      preventDefault() {}, stopImmediatePropagation() {}
    });
  }
  await flush();
  assert.equal(h.playbackCalls(), 1);
  timestamp = null;
  pending.resolve({ ok: true, currentTime: 1 });
  await flush();
  assert.deepEqual(sought, []);
});

test('ghost follows authoritative speed samples, rewinds within a row, and stops on pause', async t => {
  const h = createHarness(t);
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 6, 12, 18]) }]);
  await h.start();
  const initial = h.helper.state.ghostCursorOffset;
  h.playback = { ok: true, paused: false, currentTime: 14, playbackRate: 2 };
  await h.tick();
  const advanced = h.helper.state.ghostCursorOffset;
  assert.ok(advanced > initial);
  assert.equal(h.helper.state.ghostCursorElement.style.transition, 'transform 66ms linear');
  h.playback = { ok: true, paused: false, currentTime: 1, playbackRate: 0.5 };
  await h.tick();
  assert.ok(h.helper.state.ghostCursorOffset < advanced, 'rewind retires forward-only projection floor');
  assert.equal(h.helper.state.ghostCursorElement.style.transition, 'none');
  h.playback.paused = true;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, null);
  assert.equal(h.intervals.size, 0);
});

test('blurring snapshots the native caret instead of retaining a stale input baseline', async t => {
  const h = createHarness(t);
  const row = h.rows[0];
  Object.assign(row.identity, { startSeconds: 0.5, endSeconds: 8 });
  row.editor.value = 'Проверяем движение курсора вместе со звуком без задержки на каждом следующем слове.';
  h.helper.invalidateRowTimeCache();
  h.helper.state.cursorBaseline = row.editor.value.length;
  h.helper.focusRow(row, { selectionStart: 0, selectionEnd: 0 });
  h.helper.isEditable = element => element === row.editor.element;
  row.editor.element.blur = () => {
    h.focusedEditor = null;
    document.activeElement = h.body;
  };

  assert.equal(h.helper.toggleEditorFocus(), true);
  assert.equal(h.helper.state.lastBlur.selectionStart, 0);
  assert.equal(h.helper.state.cursorBaseline, 0, 'native selection changes need not emit an input or keyup event');
  h.helper.state.blurPlaybackTime = 0.5;
  h.playback.currentTime = 0.9013333333333334;
  await h.start();
  assert.equal(h.helper.state.ghostCursorOffset, 0, 'the first projection must use the just-blurred caret');
  h.playback.currentTime = 3.1013333333333333;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorOffset, 19, 'normal forward playback advances from that caret');
});

for (const { blurTime, beforeOffset, description } of [
  { blurTime: 0.5, beforeOffset: 44, description: 'a one-second rewind' },
  { blurTime: 5, beforeOffset: 48, description: 'a rewind before the original blur' }
]) {
  test(`untimed ghost preserves reaction compensation across ${description} and lane changes`, async t => {
    const h = createHarness(t);
    for (const row of h.rows) {
      Object.assign(row.identity, { startSeconds: 0.5, endSeconds: 8 });
      row.editor.value = 'Проверяем движение курсора вместе со звуком без задержки на каждом следующем слове.';
    }
    h.helper.invalidateRowTimeCache();
    h.helper.state.cursorBaseline = 0;
    h.helper.state.blurPlaybackTime = blurTime;
    h.helper.state.blurRestorePending = true;
    h.playback = { ok: true, paused: false, currentTime: blurTime, playbackRate: 2 };
    await h.start();
    h.playback.currentTime = 5.226666666666667;
    await h.tick();
    assert.equal(h.helper.state.ghostCursorOffset, beforeOffset);
    const element = h.helper.state.ghostCursorElement;
    const beforeLeft = h.rows[0].editor.getCaretRect(beforeOffset).left;

    h.playback.currentTime = 4.264000000000001;
    await h.tick();
    assert.equal(h.helper.state.ghostCursorOffset, 34, 'rewind projects compensated time, not the raw seek destination');
    const rewindLeft = h.rows[0].editor.getCaretRect(34).left;
    assert.ok(rewindLeft < beforeLeft);
    assert.equal(element.style.transform, `translate3d(${rewindLeft}px, 10px, 0)`);
    assert.equal(element.style.transition, 'none', 'the backward jump is immediate');
    assert.equal(h.helper.state.ghostCursorLaneProjections['stable-2'].offset, 34);
    assert.equal(h.helper.toggleGhostCursorLane(), true);
    assert.equal(h.helper.state.ghostCursorRow, h.rows[1]);
    assert.equal(h.helper.state.ghostCursorOffset, 34, 'Tab must not restore the retired blur-time floor');

    h.playback.currentTime = 4.482666666666667;
    await h.tick();
    assert.equal(h.helper.state.ghostCursorOffset, 37, 'forward samples resume from the compensated rewind position');
    assert.equal(h.helper.toggleEditorFocus(), true);
    assert.equal(h.rows[1].editor.selectionStart, 37, 'Escape restores the rendered lane and rewound position');
  });
}

test('ghost reads caret geometry before writing styles and snaps across row boundaries', async t => {
  const h = createHarness(t);
  Object.assign(h.rows[1].identity, {
    speakerKey: 'stable-1', processedRecordingId: 'stable-1', trackLabel: 'Speaker 1',
    startSeconds: 20, endSeconds: 40
  });
  h.helper.invalidateRowTimeCache();
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  const operations = [];
  element.style = new Proxy(element.style, {
    set(target, key, value) { operations.push(`write:${String(key)}`); target[key] = value; return true; }
  });
  const original = h.rows[1].editor.getCaretRect;
  h.rows[1].editor.getCaretRect = function(offset) {
    operations.push('caret');
    return original.call(this, offset);
  };
  h.playback.currentTime = 21;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorRow, h.rows[1]);
  assert.equal(h.helper.state.lastBlur.row, h.rows[1]);
  assert.equal(operations[0], 'caret');
  assert.equal(element.style.transition, 'none', 'do not animate diagonally from the previous turn');
});

test('retired row callbacks cannot affect the replacement session subscription', async t => {
  const h = createHarness(t);
  const samples = [];
  h.helper.syncCurrentRowToPlayback = sample => samples.push(sample.currentTime);
  h.helper.bindRowTracking();
  await flush();
  const [retired] = h.playbackListeners;
  h.helper.unbindRowTracking();
  h.helper.bindRowTracking();
  await flush();
  const before = samples.length;
  retired({ ok: true, currentTime: 99 });
  assert.equal(samples.length, before);
  h.playback.currentTime = 7;
  await h.tick();
  assert.equal(samples.at(-1), 7);
  assert.equal(h.playbackListeners.size, 1);
  assert.equal(h.timers.size, 0);
});

test('hidden playback owns no row or cursor timers and resumes from the current native clock', async t => {
  const h = createHarness(t);
  await h.start();
  h.helper.bindRowTracking();
  const element = h.helper.state.ghostCursorElement;
  assert.equal(h.playbackListeners.size, 2);
  assert.equal(h.intervals.size + h.timers.size, 0);
  h.visibility(true);
  const calls = h.playbackCalls();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timers.size, 0);
  for (let index = 0; index < 30; index++) await h.tick();
  assert.equal(await h.helper.syncCurrentRowToPlayback(), null);
  assert.equal(h.playbackCalls(), calls, 'hidden time performs no native clock discovery');
  assert.equal(element.style.display, 'none');
  h.playback.currentTime = 8;
  h.visibility(false);
  await flush();
  assert.equal(h.playbackCalls(), calls, 'visibility uses a native notification, not command reads');
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 8);
  assert.equal(h.helper.state.ghostCursorElement, element);
  assert.equal(h.playbackListeners.size, 2);
  assert.equal(h.intervals.size + h.timers.size, 0);
  h.helper.unbindRowTracking();
  h.visibility(true);
  h.visibility(false);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.documentListeners.get('visibilitychange').size, 0);
});

test('hidden native samples cannot render a cursor before a fresh visible event', async t => {
  const h = createHarness(t);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  h.visibility(true);
  h.playback.currentTime = 19;
  await h.tick();
  assert.equal(element.style.display, 'none');
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 1);
  h.playback.currentTime = 8;
  h.visibility(false);
  await flush();
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 8);
  assert.notEqual(element.style.display, 'none');
});

test('native subscription failure stops cursor automation without a timer fallback', async t => {
  const h = createHarness(t);
  h.helper.subscribePlayback = () => { throw new Error('unsupported WaveSurfer .on'); };
  await h.start();
  assert.equal(h.helper.state.ghostCursorElement, null);
  assert.match(h.failure.message, /unsupported WaveSurfer/);
  assert.equal(h.intervals.size + h.timers.size, 0);
  assert.equal(h.playbackCalls(), 0);
});

test('one foreground frame discovers all off-lane gaps once and reads active text once', async t => {
  const h = createHarness(t);
  h.rows[1].identity.endSeconds = 2;
  const third = new RowFixture('annotation-three', 3);
  third.identity.endSeconds = 3;
  h.rows.push(third);
  h.body.appendChild(third);
  h.playback.currentTime = 10;
  await h.start();
  const activeEditor = h.rows[0].editor;
  const text = activeEditor.value;
  let textReads = 0;
  Object.defineProperty(activeEditor, 'value', { configurable: true, get() { textReads++; return text; } });
  let collections = 0;
  const getRows = h.helper.getTranscriptRows;
  h.helper.getTranscriptRows = () => { collections++; return getRows(); };
  await h.tick();
  assert.equal(collections, 1, 'lane gaps share one fresh row/time signature pass');
  assert.equal(textReads, 1, 'the renderer reuses text sampled earlier in this same frame');
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-2'].row, h.rows[1]);
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-3'].row, third);
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-2'].offset, h.rows[1].editor.value.length);
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-3'].offset, third.editor.value.length);
});

test('one-pass lane projection preserves overlapping playback preference and fresh remounts', async t => {
  const h = createHarness(t);
  const overlapping = new RowFixture('overlapping-two', 2);
  overlapping.identity.startSeconds = 1;
  overlapping.identity.endSeconds = 6;
  h.rows.push(overlapping);
  h.body.appendChild(overlapping);
  h.helper.state.lastPlaybackRow = overlapping;
  h.helper.state.lastPlaybackRowIdentity = overlapping.identity;
  h.playback.currentTime = 4;
  await h.start();
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-2'].row, overlapping,
    'the previously selected overlapping turn wins while active');
  h.playback.currentTime = 8;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-2'].row, h.rows[1],
    'a still-active turn wins over the remembered ended turn');
  h.rows[1].identity.endSeconds = 5;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-2'].row, overlapping,
    'gaps project the latest ending turn');
  const replacement = h.replaceRow(overlapping);
  await h.tick();
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-2'].row, replacement,
    'every frame sees replacements without a timed row cache');
});

test('published timing identity skips row discovery but still reads every task and source change', t => {
  const h = createHarness(t);
  let collections = 0;
  const getRows = h.helper.getTranscriptRows;
  h.helper.getTranscriptRows = () => { collections++; return getRows(); };
  assert.equal(JSON.parse(buildCurrentL0TimingTaskId(h.helper)).baseTaskId, 'task-one');
  h.root.setAttribute('data-babel-review-action-id', 'task-two');
  assert.equal(JSON.parse(buildCurrentL0TimingTaskId(h.helper)).baseTaskId, 'task-two');
  h.publish({ taskId: 'task-two', strength: 100, variantKey: 'enhanced-two' });
  assert.equal(JSON.parse(buildCurrentL0TimingTaskId(h.helper)).audioVariantKey, 'enhanced-two');
  assert.equal(collections, 0, 'published ownership needs no transcript discovery');
  h.root.removeAttribute('data-babel-review-action-id');
  assert.deepEqual(JSON.parse(buildCurrentL0TimingTaskId(h.helper)).stableLaneIds, ['stable-1', 'stable-2']);
  assert.equal(collections, 1, 'unpublished tasks retain the live row-identity fallback');
});

test('real ghost frames share one collection across active turns, all-lane gaps and the next boundary', async t => {
  const h = createHarness(t);
  h.rows[0].identity.endSeconds = 2;
  h.rows[1].identity.endSeconds = 3;
  const next = new RowFixture('next-one', 1);
  next.identity.startSeconds = 8;
  next.identity.endSeconds = 12;
  h.rows.push(next);
  h.body.appendChild(next);
  await h.start();

  let collections = 0;
  let rebuilds = 0;
  const getRows = h.helper.getTranscriptRows;
  h.helper.getTranscriptRows = () => { collections++; return getRows(); };
  h.helper.perf = { count(name) { if (name === 'row-cache.rebuild') rebuilds++; } };
  for (const [currentTime, row] of [
    [1.5, h.rows[0]],
    [2, h.rows[1]],
    [3, h.rows[1]],
    [4, h.rows[1]],
    [7.999, h.rows[1]],
    [8, next],
    [9, next]
  ]) {
    collections = rebuilds = 0;
    h.playback.currentTime = currentTime;
    await h.tick();
    assert.equal(collections, 1, `one fresh collection at ${currentTime}, including active/lane/latest lookups`);
    assert.equal(rebuilds, 0, `a valid gap at ${currentTime} never forces a cache rebuild`);
    assert.equal(h.helper.state.ghostCursorRow, row, `the live turn wins immediately at ${currentTime}`);
    assert.notEqual(h.helper.state.ghostCursorElement.style.display, 'none');
  }
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-2'].row, h.rows[1]);
  assert.equal(h.helper.state.ghostCursorLaneProjections['stable-2'].offset, h.rows[1].editor.value.length);
});

test('gap frames observe in-place timing edits, same-identity remounts and rewinds without stale gap caching', async t => {
  const h = createHarness(t);
  h.rows.forEach(row => { row.identity.endSeconds = 2; });
  const next = new RowFixture('next-one', 1);
  next.identity.startSeconds = 8;
  next.identity.endSeconds = 12;
  h.rows.push(next);
  h.body.appendChild(next);
  h.playback.currentTime = 4;
  await h.start();
  assert.equal(h.helper.state.ghostCursorRow, h.rows[0], 'the locked lane owns its normal gap projection');

  let collections = 0;
  let rebuilds = 0;
  const getRows = h.helper.getTranscriptRows;
  h.helper.getTranscriptRows = () => { collections++; return getRows(); };
  h.helper.perf = { count(name) { if (name === 'row-cache.rebuild') rebuilds++; } };
  const frame = async (row, expectedRebuilds) => {
    collections = rebuilds = 0;
    await h.tick();
    assert.equal(collections, 1);
    assert.equal(rebuilds, expectedRebuilds, 'only changed row identities/times rebuild the collection');
    assert.equal(h.helper.state.ghostCursorRow, row);
  };
  await frame(h.rows[0], 0);
  next.identity.startSeconds = 4;
  await frame(next, 1);
  next.identity.startSeconds = 7;
  await frame(h.rows[0], 1);
  const previous = h.rows[0];
  const replacement = h.replaceRow(previous);
  replacement.identity = { ...previous.identity };
  await frame(replacement, 1);
  assert.equal(h.helper.state.lastBlur.row, replacement, 'restore follows the current native row');
  assert.equal(h.helper.state.ghostCursorOffset, replacement.editor.value.length);
  h.playback.currentTime = 1;
  await frame(replacement, 0);
  assert.ok(h.helper.state.ghostCursorOffset < replacement.editor.value.length, 'rewind retires the gap-end floor');
  h.playback.currentTime = 7;
  await frame(next, 0);
});

test('fresh row lookup preserves overlap preference and latest-end gaps after a reused row array remounts', t => {
  const h = createHarness(t);
  const overlap = new RowFixture('overlap-one', 1);
  overlap.identity.startSeconds = 1;
  overlap.identity.endSeconds = 6;
  h.rows[0].identity.endSeconds = 5;
  h.rows.push(overlap);
  h.body.appendChild(overlap);
  h.helper.getTranscriptRows = () => h.rows;
  h.api.time.rememberPlaybackRow(overlap);
  assert.equal(h.api.time.findRowEntryByPlaybackTime(4, { speakerKey: 'stable-1' }).row, overlap);
  assert.equal(h.api.time.findRowEntryByPlaybackTime(7, { speakerKey: 'stable-1' }), null);
  assert.equal(h.api.time.findLatestRowEntryBeforePlaybackTime(7, { speakerKey: 'stable-1' }).row, overlap);
  const replacement = h.replaceRow(overlap);
  replacement.identity = { ...overlap.identity };
  assert.equal(h.api.time.findRowEntryByPlaybackTime(4, { speakerKey: 'stable-1' }).row, replacement);
  assert.equal(h.api.time.findLatestRowEntryBeforePlaybackTime(7, { speakerKey: 'stable-1' }).row, replacement);
  h.rows.splice(h.rows.indexOf(replacement), 1);
  assert.equal(h.api.time.findRowEntryByPlaybackTime(4, { speakerKey: 'stable-1' }).row, h.rows[0],
    'a still-connected row excluded by the current filter cannot win through previous-row preference');
});

test('ghost transport follows native task identity while Gold publication remains stale', async t => {
  const h = createHarness(t);
  await h.start();
  h.nativeTaskId = 'task-two';
  h.publish({ taskId: 'task-two' });
  assert.equal(h.helper.state.ghostCursorElement, null);
  assert.equal(h.root.getAttribute('data-babel-review-action-id'), 'task-one');
  await h.start();
  const current = h.helper.state.ghostCursorElement;
  h.playback.currentTime = 7;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, current);
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 7);
  h.root.setAttribute('data-babel-review-action-id', 'task-two');
  h.playback.currentTime = 8;
  await h.tick();
  assert.equal(h.helper.state.ghostCursorElement, current, 'late Gold publication cannot retire native ownership');
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 8);
});

test('active ghost and row subscriber share one collection and preserve global history with a lane lock', async t => {
  const h = createHarness(t);
  h.helper.getEditorSnapshot = () => assert.fail('native playback must not request a transcript snapshot');
  await h.start();
  h.helper.bindRowTracking();
  await flush();
  let collections = 0;
  h.helper.getTranscriptRows = () => { collections++; return h.rows.filter(row => row.isConnected); };
  h.playback.currentTime = 7;
  await h.tick();
  assert.equal(collections, 1, 'row subscriber must not repeat the ghost-owned collection');
  assert.equal(h.helper.state.lastPlaybackRow, h.rows[0]);
  assert.equal(h.helper.toggleGhostCursorLane(), true);
  assert.equal(h.helper.state.currentRow, h.rows[1], 'Tab immediately publishes its rendered lane');
  collections = 0;
  h.playback.currentTime = 8;
  await h.tick();
  assert.equal(collections, 1);
  assert.equal(h.helper.state.currentRow, h.rows[1], 'manual native recording lane remains authoritative');
  assert.equal(h.helper.state.lastPlaybackRow, h.rows[0], 'global playback overlap preference is preserved');
  assert.equal(h.playbackCalls(), 0);
});

test('native recording metadata controls single-lane projections without snapshot refresh', async t => {
  const h = createHarness(t);
  h.recordingTracks = [{ id: 'stable-1', label: 'Only native lane' }];
  h.helper.getEditorSnapshot = () => assert.fail('recording metadata must come from the native playback sample');
  const readEditor = h.helper.getRowEditor;
  let offLaneReads = 0;
  h.helper.getRowEditor = row => { if (row === h.rows[1]) offLaneReads++; return readEditor(row); };
  await h.start();
  h.playback.currentTime = 8;
  await h.tick();
  assert.equal(offLaneReads, 0);
  assert.equal(h.helper.toggleGhostCursorLane(), false);
  h.recordingTracks = [
    { id: 'stable-1', label: 'Only native lane' }, { id: 'stable-2', label: 'New native lane' }
  ];
  await h.tick();
  assert.ok(offLaneReads > 0);
  assert.equal(h.helper.toggleGhostCursorLane(), true);
});
