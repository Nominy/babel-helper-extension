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
    helper, api, rows, body, root, window, sourceListeners, documentListeners, intervals, timers,
    playbackCalls: () => playbackCalls,
    deferPlayback() { const request = Promise.withResolvers(); pendingPlayback.push(request); return request; },
    publish(update) {
      source = { ...source, ...update, revision: source.revision + 1 };
      root.setAttribute('data-babel-audio-enhancement', JSON.stringify(source));
      for (const listener of [...sourceListeners]) listener({ type: SOURCE_EVENT });
    },
    installTiming(tracks) {
      helper.state.l0TimingIndex = { taskId: buildCurrentL0TimingTaskId(helper), tracks };
      helper.state.l0TimingPairKey = source.pairedVariantKey || null;
    },
    async tick() { for (const callback of [...intervals.values()]) callback(); await flush(); },
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

test('paired source switching freezes one cursor, preserves baseline/lane, and uses only current-variant timing', async (t) => {
  const h = createHarness(t);
  h.installTiming([{ lane: 'stable-1', tokens: words([0, 6, 12, 18]) }, { lane: 'stable-2', tokens: words([0, 2, 4, 6]) }]);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  const interval = h.helper.state.ghostCursorIntervalId;
  assert.equal(h.helper.state.ghostCursorOffset, 6);
  h.publish({ status: 'switching', desiredStrength: 100 });
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
  assert.equal(h.helper.state.ghostCursorIntervalId, interval);
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

test('late paused or rejected old-source reads cannot stop, move, or hide a committed cursor', async (t) => {
  const h = createHarness(t);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  const oldRead = h.deferPlayback();
  await h.tick();
  h.publish({ status: 'switching', desiredStrength: 100 });
  h.publish({ status: 'ready', strength: 100, variantKey: 'enhanced-a' });
  h.playback.currentTime = 8;
  await h.tick();
  const committedOffset = h.helper.state.ghostCursorOffset;
  oldRead.resolve({ ok: true, paused: true, currentTime: 999 });
  await flush();
  assert.equal(h.helper.state.ghostCursorElement, element);
  assert.equal(h.helper.state.ghostCursorOffset, committedOffset);
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 8);
  assert.notEqual(element.style.display, 'none');
  const oldError = h.deferPlayback();
  await h.tick();
  h.publish({ status: 'switching', desiredStrength: 0 });
  h.publish({ status: 'ready', strength: 0, variantKey: '' });
  h.playback.currentTime = 12;
  await h.tick();
  oldError.reject(new Error('old player was replaced'));
  await flush();
  assert.equal(h.helper.state.ghostCursorElement, element);
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 12);
  assert.notEqual(element.style.display, 'none');
  const progressRead = h.deferPlayback();
  await h.tick();
  h.publish({ message: 'Cache ready' });
  progressRead.resolve({ ok: true, paused: false, currentTime: 14 });
  await flush();
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 14, 'progress-only revision preserves in-flight ownership');
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

test('background row sync discards a paused snapshot requested before the source commit', async (t) => {
  const h = createHarness(t);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  const oldRead = h.deferPlayback();
  const oldSync = h.helper.syncCurrentRowToPlayback();
  h.publish({ status: 'switching', desiredStrength: 100 });
  h.publish({ status: 'ready', strength: 100, variantKey: 'enhanced-a' });
  h.playback.currentTime = 5;
  await h.tick();
  oldRead.resolve({ ok: true, paused: true, currentTime: 1 });
  assert.equal(await oldSync, null);
  assert.equal(h.helper.state.ghostCursorElement, element);
  assert.equal(h.helper.state.ghostCursorPlaybackTime, 5);
});

test('speaker filtering retargets committed connected rows and repeated lane toggles own one timer/listener', async (t) => {
  const h = createHarness(t);
  await h.start();
  const element = h.helper.state.ghostCursorElement;
  const oldRead = h.deferPlayback();
  await h.tick();
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
  oldRead.resolve({ ok: true, paused: true, currentTime: 0 });
  await flush();
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
  assert.equal(h.intervals.size, 1);
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
  const pending = h.deferPlayback();
  await h.tick();
  h.root.setAttribute('data-babel-review-action-id', 'task-two');
  h.publish({ taskId: 'task-two', strength: 0, desiredStrength: 0, variantKey: '' });
  assert.equal(h.helper.getGhostCursorTarget(), null);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.sourceListeners.size, 0);
  assert.deepEqual(h.helper.state.ghostCursorLaneProjections, {});
  await h.start(replacement);
  const nextElement = h.helper.state.ghostCursorElement;
  pending.resolve({ ok: true, paused: true, currentTime: 999 });
  await flush();
  assert.equal(h.helper.state.ghostCursorElement, nextElement, 'prior task completion cannot dispose the new task');
  h.window.location.pathname = '/projects';
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
    const pending = h.deferPlayback();
    const sync = h.helper.syncCurrentRowToPlayback();
    h.helper.unbindRowTracking();
    pending.resolve({ ok: true, paused: false, currentTime: 10 });
    assert.equal(await sync, null);
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
  assert.equal(h.intervals.size, 1);
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
  assert.equal(h.intervals.size, 1);
  assert.equal(h.sourceListeners.size, 1);
});

test('disabling proportional restore live removes its cursor, listeners and interval', async (t) => {
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
  h.helper.getEditorSnapshot = () => ({
    tracks: h.rows.map((row) => ({ id: row.identity.processedRecordingId, label: row.identity.trackLabel }))
  });
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

test('retired row-sync completion cannot clear the replacement session flight', async t => {
  const h = createHarness(t);
  const old = Promise.withResolvers();
  const next = Promise.withResolvers();
  let calls = 0;
  h.helper.syncCurrentRowToPlayback = () => ++calls === 1 ? old.promise : next.promise;
  const runTimer = () => {
    const [id, callback] = h.timers.entries().next().value;
    h.timers.delete(id);
    callback();
  };
  h.helper.bindRowTracking();
  runTimer();
  h.helper.unbindRowTracking();
  h.helper.bindRowTracking();
  runTimer();
  assert.equal(h.helper.state.playbackRowSyncInFlight, true);
  old.resolve({ playback: { paused: false } });
  await flush();
  assert.equal(h.helper.state.playbackRowSyncInFlight, true);
  assert.equal(h.timers.size, 0);
  next.resolve({ playback: { paused: false } });
  await flush();
  assert.equal(h.helper.state.playbackRowSyncInFlight, false);
  assert.equal(h.timers.size, 1);
});
