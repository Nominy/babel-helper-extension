import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createNativeRenderFactories } from '../src/content/native-render-factories.generated.js';
import { AUDIO_ENHANCEMENT_ACTIVE_REQUEST, AUDIO_ENHANCEMENT_PROTOCOL_VERSION, readAudioEnhancementState } from '@nominy/babel-babel-runtime';
import { AudioWorkerFixture } from './fixtures/audio-enhancement-worker.mjs';

const recoveredEditor = createNativeRenderFactories({}).find(entry => entry.id === 59327)
  .originals.find(source => source.includes('class tV {'));
assert.ok(recoveredEditor, 'The current native editor oracle must be available');
const createNativeHistory = new Function('ib',
  recoveredEditor.slice(recoveredEditor.indexOf('function iR('), recoveredEditor.indexOf('function iM(')) +
  recoveredEditor.slice(recoveredEditor.indexOf('function ob('), recoveredEditor.indexOf('let ow =')) +
  '; return ob;'
)({ xv: { isText: node => typeof node.text === 'string' } });

function nativeCallback(name, scope) {
  const marker = `${name} = (0, a.useCallback)(`;
  const start = recoveredEditor.indexOf(marker);
  assert.notEqual(start, -1, `Recovered native callback ${name} must exist`);
  const end = recoveredEditor.indexOf('}, [', start + marker.length);
  assert.notEqual(end, -1);
  return new Function(...Object.keys(scope), `return (${recoveredEditor.slice(start + marker.length, end + 1)});`)(...Object.values(scope));
}

class NativeElementFixture extends EventTarget {
  constructor(region) { super(); this.region = region; this.style = {}; this.isConnected = true; }
  getBoundingClientRect() {
    return { left: this.region.start * 100, top: 0, width: this.offsetWidth, height: 100, bottom: 100 };
  }
  get offsetWidth() { return (this.region.end - this.region.start) * 100; }
}

class NativeMouseEventFixture extends Event {
  constructor(type, options) {
    super(type, options);
    const { bubbles: _bubbles, cancelable: _cancelable, composed: _composed, ...mouse } = options;
    Object.assign(this, mouse);
  }
}

class NativeRegionPluginFixture {
  constructor(wave, editor) { this.wave = wave; this.editor = editor; this.regions = []; }
  getRegions() { return this.regions; }
  addRegion(options) {
    const plugin = this;
    const { data: _data, ...nativeOptions } = options;
    const region = {
      ...nativeOptions,
      setOptions(next) { Object.assign(this, next); },
      remove() {
        plugin.regions = plugin.regions.filter(candidate => candidate !== this);
        this.element.isConnected = false;
        this.element = null;
        plugin.emit('region-removed', this);
      }
    };
    region.element = new NativeElementFixture(region);
    this.regions.push(region);
    this.emit('region-created', region);
    return region;
  }
  emit(type, region) {
    if (type === 'region-created') this.editor.register(this.wave, region);
    if (this.editor.syncing) return;
    if (type === 'region-removed') this.editor.annotations.current = this.editor.annotations.current.filter(annotation => annotation.id !== region.id);
    if (type === 'region-updated') {
      this.editor.annotations.current = this.editor.annotations.current.map(annotation => annotation.id === region.id
        ? { ...annotation, startTimeInSeconds: region.start, endTimeInSeconds: region.end, content: region.data.label } : annotation);
    }
    this.editor.writes += 1;
  }
}

class NativeEditorFixture {
  constructor(waves) {
    this.waves = waves;
    this.writes = 0;
    this.syncing = true;
    this.selected = Object.fromEntries(['lane-1', 'lane-2'].map(id => [id, { activeRegionId: `region-${id}` }]));
    this.annotations = { current: ['lane-1', 'lane-2'].map(id => ({
      id: `region-${id}`, processedRecordingId: id, content: 'retained annotation', startTimeInSeconds: 0.2, endTimeInSeconds: 1.8
    })) };
    this.initial = structuredClone(this.annotations.current);
    // Execute the recovered annotation command, not an imitation split or event echo.
    this.commands = [];
    this.splitAnnotation = nativeCallback('Q3', {
      x3: this.annotations, crypto,
      D2: command => { this.commands.push(command); command.do(); },
      C2: update => {
        this.annotations.current = update(this.annotations.current);
        this.writes += 1;
        this.rebuild(this.annotations.current);
      }
    });
  }
  select(trackId, regionId) { this.selected = { ...this.selected, [trackId]: { activeRegionId: regionId } }; this.selectionHook.memoizedState = this.selected; }
  register(wave, region) {
    const refs = { [region.id]: { start: {}, end: {}, text: {}, label: { style: {} } } };
    const bind = nativeCallback('n72', {
      nB2: null, et2: { current: () => ({ region: '#ccc', regionBorder: '#999' }) },
      ey2: () => {}, ex2: { refs: { current: refs } },
      tb2: {}, eR2: (id, selected) => this.select(id, selected), nl2: { current: new Set() },
      b2: 'transcription', U2: false, tA2: false,
      nC2: this.splitAnnotation, nh2: { current: false }, af: { SHORT: 1 }, setTimeout,
      MouseEvent: NativeMouseEventFixture
    });
    bind({ id: wave.id }, region, false);
  }
  rebuild(annotations) {
    this.syncing = true;
    for (const wave of this.waves) {
      if (!wave.getDecodedData()) continue;
      // Native ready uses its original annotation closure on EVERY decoded lane.
      for (const region of wave.regions.getRegions()) region.remove();
      for (const annotation of annotations.filter(item => item.processedRecordingId === wave.id)) {
        const region = wave.regions.addRegion({
          id: annotation.id, start: annotation.startTimeInSeconds, end: annotation.endTimeInSeconds, color: '#ccc', drag: false,
          data: { trackId: wave.id, label: annotation.content }
        });
        region.data = { trackId: wave.id, label: annotation.content };
      }
    }
    queueMicrotask(() => { this.syncing = false; });
  }
}

async function loadEntry(entryPoint) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

function sourceWav(sample) {
  const frames = 96000;
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  }
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 96000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, frames * 2, true);
  for (let index = 0; index < frames; index += 1) view.setInt16(44 + index * 2, sample, true);
  return bytes;
}

function decoded(sample) {
  return { marker: sample, length: 96000, sampleRate: 48000, numberOfChannels: 1, duration: 2,
    getChannelData: () => new Float32Array(96000).fill(sample / 32768) };
}

class NativeWaveFixture {
  constructor(id, otherWaves, onLoading, editor) {
    this.id = id;
    this.decoded = decoded(100);
    this.listeners = new Map();
    this.time = 0.4;
    this.rate = 1.25;
    this.volume = 0.4;
    this.muted = true;
    this.scroll = 31;
    this.playing = true;
    this.playingMarker = 100;
    this.loads = [];
    this.media = { volume: this.volume, muted: this.muted, decodedMarker: 100 };
    this.regions = new NativeRegionPluginFixture(this, editor);
    this.onLoading = onLoading;
    // Current native editor module 59327 invokes zoom on ready, synchronizing
    // it to the other lane. Module 99407 zoom rejects a missing decoded buffer.
    this.on('ready', () => {
      for (const other of otherWaves()) if (other !== this) other.zoom(100);
      editor.rebuild(editor.initial);
    });
    this.on('timeupdate', time => {
      const region = this.regions.getRegions().find(candidate => time >= candidate.start && time < candidate.end);
      editor.select(this.id, region?.id ?? null);
    });
  }
  on(type, listener) {
    const group = this.listeners.get(type) ?? new Set();
    group.add(listener);
    this.listeners.set(type, group);
    return () => group.delete(listener);
  }
  un(type, listener) { this.listeners.get(type)?.delete(listener); }
  once(type, listener) {
    const cleanup = this.on(type, (...args) => { cleanup(); listener(...args); });
    return cleanup;
  }
  emit(type, ...args) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(...args); }
  zoom() { if (!this.decoded) throw new Error('No audio loaded'); }
  async loadAudio(url, blob) {
    this.emit('load', url);
    if (this.isPlaying()) this.pause();
    this.decoded = null;
    this.onLoading(this);
    try {
      const source = blob ?? await (await fetch(url)).blob();
      const bytes = await source.arrayBuffer();
      const marker = new DataView(bytes).getInt16(44, true);
      this.loads.push(marker);
      this.loadedBytes = bytes;
      const beforeDecode = this.beforeDecode;
      this.beforeDecode = undefined;
      await beforeDecode?.(marker);
      if ((this.failNextOriginal || this.failAllOriginal) && marker === 100) {
        this.failNextOriginal = false;
        throw new Error('Native second lane decoder failed');
      }
      this.decoded = decoded(marker);
      this.media.decodedMarker = marker;
      // Recovered loadBlob itself does not clear the regions plugin.
      this.emit('ready');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  // Captured WaveSurfer9794:1091-1105 delegates both public methods to
  // loadAudio; load(url) must not call the Helper-wrapped public loadBlob.
  async loadBlob(blob) { return this.loadAudio('', blob); }
  async load(url) { return this.loadAudio(url); }
  getDecodedData() { return this.decoded; }
  getCurrentTime() { return this.time; }
  getPlaybackRate() { return this.rate; }
  isPlaying() { return this.playing; }
  pause() { this.playing = false; }
  play() {
    if (!this.playing) {
      this.playing = true;
      this.playingMarker = this.media.decodedMarker;
    }
    return this.beforePlay?.();
  }
  setTime(value) { this.time = value; this.emit('timeupdate', value); }
  setPlaybackRate(value) { this.rate = value; }
  getMediaElement() { return this.media; }
  getActivePlugins() { return [this.regions]; }
  getVolume() { return this.volume; }
  getMuted() { return this.muted; }
  getScroll() { return this.scroll; }
  setVolume(value) { this.volume = value; }
  setMuted(value) { this.muted = value; }
  setScroll(value) { this.scroll = value; }
}

for (const scenario of [
  { name: 'ordinary result', cache: {} },
  { name: 'Original selected before model result', cache: {}, originalBefore: true },
  { name: 'persistent cache hit', cache: { cacheStatus: 'hit' } },
  { name: 'stored pair', cache: { cacheStatus: 'stored' } },
  { name: 'unavailable cache', cache: { cacheStatus: 'unavailable', cacheMessage: 'Storage quota exhausted for the current pair.' } },
  { name: 'deferred disposal restoration', cache: {}, disposal: 'deferred' },
  { name: 'failed disposal restoration and explicit retry', cache: {}, disposal: 'failure' },
  { name: 'newer transport intent during native decoding', cache: {}, transportIntent: true },
  { name: 'authoritative native editability on a feedback route', cache: {}, nativeAdmission: true },
  { name: 'unknown cache status', cache: { cacheStatus: 'future-status' }, invalid: true },
  { name: 'non-string cache status', cache: { cacheStatus: null }, invalid: true },
  { name: 'non-string cache message', cache: { cacheStatus: 'hit', cacheMessage: {} }, invalid: true }
]) {
test(`real native split and paired selection remain correct with ${scenario.name}`, { timeout: 10000 }, async t => {
  const saved = new Map();
  function install(name, value) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => { for (const [name, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  AudioWorkerFixture.instances = [];
  AudioWorkerFixture.onRequest = null;
  install('Worker', AudioWorkerFixture);
  t.after(() => {
    AudioWorkerFixture.onRequest = null;
    for (const worker of AudioWorkerFixture.instances) worker.terminate();
  });
  const attributes = new Map();
  const listeners = new Map();
  const publications = [];
  const messages = [];
  const loading = [];
  let waves = [];
  let editor = new NativeEditorFixture(waves);
  const originalWaves = waves, originalEditor = editor;
  let facade;
  const { promise: captured, resolve: resolveCaptured } = Promise.withResolvers();
  let resolveCommitted;
  let onSources;
  let enhancementProviders = 0;
  const window = {
    location: { origin: 'https://babel.test', href: 'https://babel.test/transcription?reviewActionId=task-native' +
      (scenario.nativeAdmission ? '&displayFeedback=true' : '') },
    fetch: async () => new Response(sourceWav(100), { headers: { 'Content-Type': 'audio/wav' } }),
    setTimeout, clearTimeout,
    setInterval() { throw new Error('Native enhancement must not poll'); },
    clearInterval() {},
    addEventListener(type, listener) { const group = listeners.get(type) ?? new Set(); group.add(listener); listeners.set(type, group); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent() {},
    postMessage(data) {
      messages.push(data);
      if (data.type === 'sources-ready') { resolveCaptured(data); onSources?.(data); }
      if (data.type === 'state') {
        publications.push(structuredClone(data.state));
        if (data.state.status === 'error' || data.state.status === 'ready') resolveCommitted?.();
      }
    },
    BabelMods: { unsafe: { services: { provide: () => {
      enhancementProviders += 1;
      return { dispose() { enhancementProviders -= 1; } };
    } } } }
  };
  const nativeFetch = window.fetch;
  let expectedFetchAfterDispose = nativeFetch;
  for (const id of ['lane-1', 'lane-2']) waves.push(new NativeWaveFixture(id, () => originalWaves, wave => {
    loading.push({ id: wave.id, state: facade.getState(), active: facade.getActiveAudio('capture', 'task-native').available,
      counterpartDecoded: originalWaves.filter(candidate => candidate !== wave).every(candidate => candidate.getDecodedData() !== null) });
  }, originalEditor));
  editor.selectionHook = { memoizedState: editor.selected, queue: { dispatch: update => {
    originalEditor.selected = update(originalEditor.selected);
    originalEditor.selectionHook.memoizedState = originalEditor.selected;
  } } };
  editor.rebuild(editor.annotations.current);
  const unexpectedTranscriptWrite = () => { throw new Error('Audio work must not invoke transcript mutation callbacks'); };
  const transcript = { memoizedProps: {
    get turns() { return editor.annotations.current; },
    editingId: 'region-lane-1',
    localEdits: false,
    highlightCjkSpaces: true,
    diffOtherSide: 'submitted',
    onCopy: unexpectedTranscriptWrite,
    handlers: {
      onActivate: unexpectedTranscriptWrite, onDeactivate: unexpectedTranscriptWrite,
      onSelect: unexpectedTranscriptWrite, onChangeText: unexpectedTranscriptWrite
    }, readOnly: false
  }, memoizedState: { memoizedState: createNativeHistory() },
  child: { memoizedProps: { history: null } } };
  transcript.child.memoizedProps.history = transcript.memoizedState.memoizedState;
  const panel = { memoizedProps: {
    get annotations() { return editor.annotations.current; },
    saveState: {}, renderTranscript: unexpectedTranscriptWrite, onSave: unexpectedTranscriptWrite,
    tracks: waves.map(wave => ({ id: wave.id, label: wave.id })), readOnly: false
  }, child: transcript };
  const fiber = {
    child: panel,
    memoizedProps: { reviewActionId: 'task-native', mode: 'annotation', transcriptionChunkProcessedRecordings: waves.map(wave => ({
      processedRecordingId: wave.id, processedRecordingUrl: `https://babel.test/${wave.id}.wav`, speaker: wave.id
    })) },
    memoizedState: { memoizedState: { current: Object.fromEntries(waves.map(wave => [wave.id, { wavesurfer: wave }])) }, next: editor.selectionHook }
  };
  const root = { stateNode: { current: fiber } };
  const seed = { __reactFiber$fixture: { return: root } };
  install('window', window);
  install('fetch', (...args) => window.fetch(...args));
  install('document', {
    documentElement: { getAttribute: name => attributes.get(name) ?? null, setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) },
    querySelectorAll: () => [seed]
  });
  install('CustomEvent', class { constructor(type, init) { this.type = type; this.detail = init.detail; } });
  install('HTMLElement', NativeElementFixture);
  install('MouseEvent', NativeMouseEventFixture);
  install('navigator', { platform: 'Win32' });
  const stream = await loadEntry('src/services/audio-enhancement-stream.ts');
  const bridge = await loadEntry('src/content/audio-enhancement-bridge.ts');
  bridge.initAudioEnhancementBridge('chrome-extension://helper/dist/content/audio-enhancement-worker.js');
  facade = window.__babelHelperAudioEnhancementBridge;
  try {
    if (scenario.nativeAdmission) {
      fiber.child = null;
      const beforeUnknown = facade.getState();
      await facade.setEnabled(true);
      assert.deepEqual(facade.getState(), beforeUnknown, 'Missing committed transcript bindings cannot start source capture');
      assert.equal(messages.some(message => message.type === 'sources-ready'), false);
      assert.deepEqual(waves.map(wave => wave.loads), [[], []]);
      await facade.setEnabled(false);
      fiber.child = panel;
      panel.memoizedProps.readOnly = true;
      const beforeReadonly = facade.getState();
      await facade.setEnabled(true);
      assert.deepEqual(facade.getState(), beforeReadonly, 'Native readonly denies work even without a readonly URL flag');
      assert.equal(messages.some(message => message.type === 'sources-ready'), false);
      assert.deepEqual(waves.map(wave => wave.loads), [[], []]);
      await facade.setEnabled(false);
      panel.memoizedProps.readOnly = false;
    }
    await facade.setEnabled(true);
    const sources = await captured;
    assert.equal(facade.getState().desiredStrength, 90, 'Every new task starts with the safe 90/10 mix');
    if (scenario.originalBefore) await facade.selectStrength(0);
    const enhanced = sourceWav(200);
    // Change the current annotation state after the native ready closure was
    // captured. Source reloads must not revive its stale times/text/membership.
    editor.annotations.current = editor.annotations.current.map(annotation => ({ ...annotation, content: 'edited before enhancement',
      startTimeInSeconds: 0.25, endTimeInSeconds: 1.75 }));
    editor.annotations.current.push({ id: 'new-region', processedRecordingId: 'lane-1', content: 'new annotation', startTimeInSeconds: 0.01, endTimeInSeconds: 0.1 });
    editor.rebuild(editor.annotations.current);
    editor.select('lane-1', 'new-region');
    const annotationsBefore = structuredClone(editor.annotations.current);
    const writesBefore = editor.writes;
    const wavSha256 = await stream.audioSha256(enhanced);
    const committed = Promise.withResolvers();
    resolveCommitted = committed.resolve;
    const initialRevision = facade.getState().revision;
    for (const listener of listeners.get('message')) listener({ source: window, origin: window.location.origin, data: {
      source: stream.AUDIO_ENHANCEMENT_COMMAND_SOURCE, type: 'install', sessionId: `${sources.sessionId}-stale`, taskId: 'task-native',
      model: 'zipr1', variantKey: 'b'.repeat(64), cacheStatus: 'unavailable', cacheMessage: 'Stale cache failure',
      tracks: sources.tracks.map(source => ({ ...source, bytes: enhanced.slice(0),
        mimeType: 'audio/wav', wavSha256, totalBytes: enhanced.byteLength, chunkCount: 1 }))
    } });
    assert.equal(facade.getState().revision, initialRevision, 'A stale cache result cannot publish or install');
    assert.equal(loading.length, 0);
    for (const listener of listeners.get('message')) listener({ source: window, origin: window.location.origin, data: {
      source: stream.AUDIO_ENHANCEMENT_COMMAND_SOURCE, type: 'install', sessionId: sources.sessionId, taskId: 'task-native',
      model: 'zipr1', variantKey: 'b'.repeat(64), ...scenario.cache, tracks: sources.tracks.map(source => ({ ...source, bytes: enhanced.slice(0),
        mimeType: 'audio/wav', wavSha256, totalBytes: enhanced.byteLength, chunkCount: 1 }))
    } });
    await committed.promise;
    if (scenario.invalid) {
      assert.equal(facade.getState().status, 'error');
      assert.equal(facade.getState().strength, 0);
      assert.equal(facade.getState().variantKey, '');
      assert.equal(loading.length, 0, 'Invalid cache metadata must fail before either native lane is loaded');
      assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [100, 100]);
      assert.equal(editor.writes, writesBefore);
      assert.deepEqual(editor.annotations.current, annotationsBefore);
      return;
    }
    if (scenario.originalBefore) {
      assert.equal(facade.getState().strength, 0);
      assert.equal(facade.getState().desiredStrength, 0);
      assert.equal(facade.getState().variantKey, '');
      assert.equal(facade.getState().status, 'ready');
      assert.equal(loading.length, 0, 'Choosing Original before model completion prevents automatic Enhanced loading');
      assert.deepEqual(facade.getActiveAudio('chosen-original', 'task-native').tracks.map(track => track.bytes), [sourceWav(100), sourceWav(100)]);
      await facade.selectStrength(90);
    }
    assert.equal(facade.getState().strength, 90);
    assert.equal(facade.getState().status, 'ready');
    const enhancedNotice = facade.getState().message;
    assert.ok(enhancedNotice, 'The committed selection retains a terminal status notice');
    if (scenario.cache.cacheStatus === 'unavailable') {
      assert.ok(enhancedNotice.includes(scenario.cache.cacheMessage), 'Cache failure remains visible while valid Enhanced is usable');
    }
    assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [190, 190], 'Inference and cached pairs both load real 90/10 samples');
    const defaultCapture = facade.getActiveAudio('default-mix', 'task-native');
    assert.equal(defaultCapture.available, true);
    assert.equal(defaultCapture.strength, 90);
    assert.equal(defaultCapture.variantKey, await stream.audioSha256(new TextEncoder().encode(
      JSON.stringify(['zip-linear-pcm16-v1', 'b'.repeat(64), 90])).buffer));
    assert.equal(facade.getState().pairedVariantKey, 'b'.repeat(64));
    assert.deepEqual(defaultCapture.tracks.map(track => track.bytes), [sourceWav(190), sourceWav(190)]);
    assert.deepEqual(waves.map(wave => wave.loadedBytes), defaultCapture.tracks.map(track => track.bytes));
    assert.deepEqual(await (await window.fetch('https://babel.test/lane-1.wav')).arrayBuffer(), sourceWav(190));
    assert.deepEqual(facade.getActiveAudio('default-original', 'task-native', 'original').tracks.map(track => track.bytes),
      [sourceWav(100), sourceWav(100)], 'Default mixing never overwrites byte-exact Original');
    assert.deepEqual(loading.map(value => value.id), ['lane-1', 'lane-2']);
    const duplicateLoads = waves.map(wave => wave.loads.length);
    const workerRequests = AudioWorkerFixture.instances.flatMap(worker => worker.requests).length;
    await facade.selectStrength(90);
    await waves[0].load('https://babel.test/lane-1.wav', [[999]], 999);
    assert.deepEqual(waves.map(wave => wave.loads.length), duplicateLoads, 'Same selection and same-source native replay do not decode again');
    assert.equal(AudioWorkerFixture.instances.flatMap(worker => worker.requests).length, workerRequests, 'Same-source replays never allocate another mix');
    assert.ok(loading.every(value => value.counterpartDecoded), 'Native cross-lane zoom must always have decoded audio');
    assert.ok(loading.every(value => !value.active && value.state.strength === 0 && value.state.status === 'switching'), 'Paired strength is unavailable and uncommitted while either lane loads');
    if (!scenario.originalBefore) assert.ok(publications.filter(value => value.status === 'ready').every(value => value.strength === 90), 'Ready cannot precede the initial paired native commit');
    for (const wave of waves) {
      assert.equal(wave.time, 0.4);
      assert.equal(wave.rate, 1.25);
      assert.equal(wave.volume, 0.4);
      assert.equal(wave.muted, true);
      assert.equal(wave.scroll, 31);
      assert.equal(wave.playing, true);
      assert.equal(wave.regions.getRegions()[0].id, `region-${wave.id}`);
      assert.equal(wave.regions.getRegions()[0].start, 0.25);
      assert.equal(wave.regions.getRegions()[0].end, 1.75);
    }
    assert.equal(editor.writes, writesBefore, 'Audio-only replacement cannot write native annotations');
    assert.deepEqual(editor.annotations.current, annotationsBefore);
    assert.equal(editor.selected['lane-1'].activeRegionId, 'new-region', 'Selection is restored onto its current same-ID region');
    for (const wave of waves) for (const region of wave.regions.getRegions()) {
      assert.equal(region.data.label, annotationsBefore.find(annotation => annotation.id === region.id).content);
    }
    const splitCurrent = async () => {
      for (const lane of waves) {
        assert.deepEqual(lane.regions.getRegions().map(region => region.id).sort(),
          editor.annotations.current.filter(annotation => annotation.processedRecordingId === lane.id).map(annotation => annotation.id).sort(),
          'Native region membership must match current annotations without stale IDs or duplicates');
      }
      const wave = waves[0];
      const target = wave.regions.getRegions().filter(region => region.end - region.start > 0.2)
        .sort((left, right) => (right.end - right.start) - (left.end - left.start))[0];
      assert.ok(target, 'There must be a valid native split target');
      const before = structuredClone(editor.annotations.current);
      const writes = editor.writes;
      const midpoint = (target.start + target.end) / 2;
      target.element.dispatchEvent(new NativeMouseEventFixture('click', {
        bubbles: true, cancelable: true, composed: true, clientX: midpoint * 100, clientY: 50,
        button: 0, buttons: 0, detail: 1, shiftKey: false, ctrlKey: true, metaKey: false
      }));
      await Promise.resolve(); // Let the native rebuild release its annotation-sync guard.
      assert.equal(editor.writes, writes + 1, 'One consumer gesture executes exactly one native annotation command');
      assert.equal(editor.annotations.current.length, before.length + 1);
      assert.equal(editor.annotations.current.some(annotation => annotation.id === target.id), false);
      const created = editor.annotations.current.filter(annotation => !before.some(prior => prior.id === annotation.id));
      assert.equal(created.length, 2);
      assert.deepEqual(created.map(annotation => [annotation.processedRecordingId, annotation.content]), [['lane-1', target.data.label], ['lane-1', target.data.label]]);
      assert.ok(Math.abs(created[0].endTimeInSeconds - (midpoint - 0.05)) < 1e-12);
      assert.ok(Math.abs(created[1].startTimeInSeconds - (midpoint + 0.05)) < 1e-12);
      for (const annotation of created) {
        const region = wave.regions.getRegions().find(candidate => candidate.id === annotation.id);
        assert.equal(region.start, annotation.startTimeInSeconds);
        assert.equal(region.end, annotation.endTimeInSeconds);
        region.element.dispatchEvent(new NativeMouseEventFixture('click', { clientX: region.start * 100, clientY: 50 }));
        assert.equal(editor.selected['lane-1'].activeRegionId, annotation.id);
      }
    };
    const preparing = Promise.withResolvers();
    AudioWorkerFixture.onRequest = request => { if (request.type === 'mix') preparing.resolve(); };
    const preparingLoads = waves.map(wave => wave.loads.length);
    const selecting = facade.selectStrength(60);
    await preparing.promise;
    AudioWorkerFixture.onRequest = null;
    assert.ok(waves.every(wave => wave.isPlaying()), 'Worker preparation does not pause the committed native pair');
    assert.deepEqual(waves.map(wave => wave.loads.length), preparingLoads);
    assert.equal(facade.getActiveAudio('preparing', 'task-native').available, false);
    assert.equal(facade.getActiveAudio('original-preparing', 'task-native', 'original').available, true);
    const beforePreparationSplit = structuredClone(editor.annotations.current);
    await splitCurrent();
    const editedDuringPreparation = structuredClone(editor.annotations.current);
    await selecting;
    assert.deepEqual(editor.annotations.current, editedDuringPreparation, 'A split during worker preparation survives native source replacement');
    const splitCommand = editor.commands.at(-1);
    splitCommand.undo();
    await Promise.resolve();
    assert.deepEqual([...editor.annotations.current].sort((a, b) => a.id.localeCompare(b.id)),
      [...beforePreparationSplit].sort((a, b) => a.id.localeCompare(b.id)),
      'The real native history command survives source replacement and restores the prior annotation');
    splitCommand.do();
    await Promise.resolve();
    const priorMix = facade.getActiveAudio('prior-mix', 'task-native');
    assert.equal(priorMix.strength, 60);
    assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [160, 160]);
    await splitCurrent();
    loading.length = 0;
    waves[1].failNextOriginal = true;
    const annotationsBeforeFailure = structuredClone(editor.annotations.current);
    const writesBeforeFailure = editor.writes;
    await facade.selectStrength(0);
    assert.equal(facade.getState().status, 'error');
    assert.match(facade.getState().message, /Native second lane decoder failed/);
    assert.equal(facade.getState().strength, 60);
    assert.equal(facade.getState().variantKey, priorMix.variantKey);
    assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [160, 160]);
    const rolledBack = facade.getActiveAudio('rollback', 'task-native');
    assert.equal(rolledBack.available, true, 'A terminal failure exposes the settled prior committed mix despite pending desired strength');
    assert.deepEqual(rolledBack.tracks.map(track => track.bytes), priorMix.tracks.map(track => track.bytes));
    assert.deepEqual(waves.map(wave => wave.loadedBytes), priorMix.tracks.map(track => track.bytes));
    assert.deepEqual(await (await window.fetch('https://babel.test/lane-1.wav')).arrayBuffer(), priorMix.tracks[0].bytes);
    assert.deepEqual(loading.map(value => value.id), ['lane-1', 'lane-2', 'lane-2', 'lane-1'], 'Restore the failed undecoded lane before callbacks touch it');
    assert.ok(loading.every(value => value.counterpartDecoded));
    assert.equal(editor.writes, writesBeforeFailure);
    assert.deepEqual(editor.annotations.current, annotationsBeforeFailure);
    await splitCurrent();
    await waves[0].loadBlob(new Blob([sourceWav(999)]));
    assert.equal(facade.getState().status, 'error');
    assert.equal(facade.getState().strength, 60, 'Native renderer replay after rollback retains the settled prior mix');
    assert.equal(facade.getActiveAudio('replayed-rollback', 'task-native').available, true);
    assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [160, 160]);
    await facade.selectStrength(0);
    assert.equal(facade.getState().strength, 0);
    assert.equal(facade.getState().status, 'ready');
    assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [100, 100]);
    assert.notEqual(facade.getState().message, enhancedNotice, 'Original selection cannot retain the Enhanced-playing notice');
    if (scenario.cache.cacheStatus === 'unavailable') assert.ok(facade.getState().message.includes(scenario.cache.cacheMessage));
    const originalCapture = facade.getActiveAudio('original-capture', 'task-native');
    assert.equal(originalCapture.available, true);
    assert.equal(originalCapture.strength, 0);
    assert.equal(originalCapture.variantKey, '');
    assert.deepEqual(originalCapture.tracks.map(track => track.bytes), [sourceWav(100), sourceWav(100)]);
    assert.deepEqual(waves.map(wave => wave.loadedBytes), [sourceWav(100), sourceWav(100)]);
    await splitCurrent();
    await facade.selectStrength(90);
    assert.equal(facade.getState().message, enhancedNotice, 'Re-selecting the default mix restores its cache notice');
    await facade.selectStrength(100);
    assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [200, 200]);
    assert.equal(facade.getState().strength, 100);
    await splitCurrent();
    const fullCapture = facade.getActiveAudio('enhanced-capture', 'task-native');
    assert.deepEqual(fullCapture.tracks.map(track => track.bytes), [enhanced, enhanced]);
    assert.deepEqual(waves.map(wave => wave.loadedBytes), [enhanced, enhanced]);
    if (scenario.name === 'ordinary result') {
      const keys = new Set();
      for (let strength = 1; strength < 100; strength += 1) {
        await facade.selectStrength(strength);
        assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [100 + strength, 100 + strength]);
        const active = facade.getActiveAudio('all-strengths', 'task-native');
        assert.equal(active.available, true);
        assert.equal(active.strength, strength);
        assert.equal(active.variantKey, await stream.audioSha256(new TextEncoder().encode(
          JSON.stringify(['zip-linear-pcm16-v1', 'b'.repeat(64), strength])).buffer));
        assert.equal(facade.getState().pairedVariantKey, 'b'.repeat(64));
        keys.add(active.variantKey);
        assert.deepEqual(waves.map(wave => wave.loadedBytes), active.tracks.map(track => track.bytes));
        if (strength === 25 || strength === 99) {
          assert.deepEqual(await (await window.fetch('https://babel.test/lane-1.wav')).arrayBuffer(), active.tracks[0].bytes);
          const original = facade.getActiveAudio('retained-original', 'task-native', 'original');
          assert.equal(original.strength, 0);
          assert.equal(original.variantKey, '');
          assert.deepEqual(original.tracks.map(track => track.bytes), [sourceWav(100), sourceWav(100)]);
        }
      }
      assert.equal(keys.size, 99, 'Every committed intermediate has its own stable identity');
      const supersededLoads = waves.map(wave => wave.loads.length);
      const mixEntered = Promise.withResolvers();
      AudioWorkerFixture.onRequest = (request, worker) => { if (request.type === 'mix') mixEntered.resolve(worker); };
      const obsolete = facade.selectStrength(70);
      const obsoleteWorker = await mixEntered.promise;
      AudioWorkerFixture.onRequest = null;
      const originalSelection = facade.selectStrength(0);
      assert.equal(obsoleteWorker.terminated, true, 'A superseded CPU mix is terminated instead of blocking the latest selection');
      await Promise.all([obsolete, originalSelection]);
      assert.deepEqual(waves.map(wave => wave.loads.slice(supersededLoads[waves.indexOf(wave)])), [[100], [100]], 'An obsolete worker result never reaches native loading');
      assert.equal(facade.getState().strength, 0);
      assert.deepEqual(facade.getActiveAudio('restored-after-cancellation', 'task-native').tracks.map(track => track.bytes),
        [sourceWav(100), sourceWav(100)]);
      await facade.selectStrength(99);
      const unchangedLoads = waves.map(wave => wave.loads.length);
      const returning = Promise.withResolvers();
      AudioWorkerFixture.onRequest = request => { if (request.type === 'mix') returning.resolve(); };
      const cancelledAgain = facade.selectStrength(70);
      await returning.promise;
      AudioWorkerFixture.onRequest = null;
      const unchangedSelection = facade.selectStrength(99);
      await Promise.all([cancelledAgain, unchangedSelection]);
      assert.deepEqual(waves.map(wave => wave.loads.length), unchangedLoads, 'Returning to the committed strength during preparation does not reload either source');
      assert.equal(facade.getState().status, 'ready');
      await waves[0].load('https://babel.test/lane-1.wav', [[999]], 999);
      await waves[1].loadBlob(new Blob([sourceWav(999)]), [[999]], 999);
      assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [199, 199], 'Native renderer replays use the committed mix, not stale URL/blob/peaks');
      await splitCurrent();
      loading.length = 0;
      const races = [];
      waves[0].beforeDecode = marker => {
        assert.equal(marker, 180);
        assert.equal(facade.getActiveAudio('during-load', 'task-native').available, false);
        assert.equal(facade.getActiveAudio('original-during-load', 'task-native', 'original').available, true);
        races.push(facade.selectStrength(10), facade.selectStrength(20), facade.selectStrength(30));
      };
      await facade.selectStrength(80);
      await Promise.all(races);
      assert.equal(facade.getState().strength, 30);
      assert.equal(facade.getState().desiredStrength, 30);
      assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [130, 130]);
      assert.deepEqual(waves[1].loads.slice(-1), [130], 'Second lane never decodes the superseded 80% source');
      assert.deepEqual(loading.map(item => item.id), ['lane-1', 'lane-1', 'lane-2']);
      assert.ok(loading.every(item => item.counterpartDecoded && !item.active));
      await splitCurrent();
      const beforeInvalid = facade.getState();
      for (const invalid of [-1, 101, 50.5, NaN, '50']) await assert.rejects(facade.selectStrength(invalid), /Invalid audio strength/);
      assert.deepEqual(facade.getState(), beforeInvalid);
      await facade.selectStrength(100);
    }
    if (scenario.transportIntent) {
      for (const playIntent of [false, true]) {
        const entered = Promise.withResolvers(), finishDecode = Promise.withResolvers();
        const originalMethods = waves.map(wave => ({ play: wave.play, pause: wave.pause }));
        const annotations = structuredClone(editor.annotations.current);
        const writes = editor.writes;
        waves[playIntent ? 0 : 1].beforeDecode = async () => {
          entered.resolve();
          await finishDecode.promise;
        };
        const switching = facade.selectStrength(playIntent ? 72 : 71);
        await entered.promise;
        assert.equal(facade.getState().status, 'switching');
        for (let index = 0; index < waves.length; index += 1) {
          const wave = waves[index];
          wave.setVolume(index);
          wave.setMuted(index === 0);
          wave.setPlaybackRate(1.75);
          wave.setTime(index === 0 ? 0.05 : 1.23);
          wave.setScroll(67 + index);
          if (playIntent) await wave.play();
          else wave.pause(); // Already temporarily paused: the explicit command still wins.
        }
        editor.select('lane-1', 'new-region');
        editor.select('lane-2', null);
        const selection = structuredClone(editor.selected);
        const activeTurn = editor.annotations.current.find(annotation => annotation.processedRecordingId === 'lane-2');
        transcript.memoizedProps.editingId = playIntent ? activeTurn.id : null;
        const turnHistory = { undos: [[{ type: 'insert_text', text: 'local edit' }]], redos: [] };
        const history = transcript.child.memoizedProps.history;
        history.save(activeTurn.id, {
          value: [{ type: 'paragraph', children: [{ text: activeTurn.content }] }], history: turnHistory
        });
        const transcriptProps = transcript.memoizedProps;
        const handlers = transcriptProps.handlers;
        finishDecode.resolve();
        await switching;
        assert.equal(facade.getState().status, 'ready');
        assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [playIntent ? 172 : 171, playIntent ? 172 : 171]);
        assert.deepEqual(waves.map(wave => wave.getVolume()), [0, 1], 'Decode completion cannot restore the previously isolated speaker');
        assert.deepEqual(waves.map(wave => wave.getMuted()), [true, false]);
        assert.deepEqual(waves.map(wave => wave.getPlaybackRate()), [1.75, 1.75]);
        assert.deepEqual(waves.map(wave => wave.getCurrentTime()), [0.05, 1.23]);
        assert.deepEqual(waves.map(wave => wave.getScroll()), [67, 68]);
        assert.deepEqual(waves.map(wave => wave.isPlaying()), [playIntent, playIntent]);
        if (playIntent) assert.deepEqual(waves.map(wave => wave.playingMarker), [172, 172],
          'Playback started during decode must resume from the new pair, not its old WebAudio buffer nodes');
        assert.deepEqual(editor.selected, selection, 'New native selection survives source reload without a captured React state replay');
        assert.equal(editor.writes, writes);
        assert.deepEqual(editor.annotations.current, annotations);
        assert.equal(transcript.memoizedProps, transcriptProps, 'Audio replacement never replaces native turn props');
        assert.equal(transcriptProps.editingId, playIntent ? activeTurn.id : null, 'Current editing intent survives decoding');
        assert.equal(transcript.child.memoizedProps.history, history, 'The native turn history owner is retained');
        assert.equal(history.restore(activeTurn.id, activeTurn.content).history, turnHistory,
          'The real native history store still restores the turn undo stack after source replacement');
        assert.equal(transcriptProps.handlers, handlers, 'Native activation/deactivation callbacks are not replayed or wrapped');
        for (let index = 0; index < waves.length; index += 1) {
          assert.equal(waves[index].play, originalMethods[index].play);
          assert.equal(waves[index].pause, originalMethods[index].pause);
          for (const region of waves[index].regions.getRegions()) {
            assert.equal(region.element.style.filter, region.id === selection[waves[index].id].activeRegionId ? 'brightness(0.8)' : '');
          }
        }
      }
      const playing = Promise.withResolvers(), finishPlay = Promise.withResolvers();
      waves[1].beforePlay = () => {
        waves[1].beforePlay = undefined;
        playing.resolve();
        return finishPlay.promise;
      };
      let settled = false;
      const switching = facade.selectStrength(73).then(() => { settled = true; });
      await playing.promise;
      assert.equal(settled, false, 'The source transaction must await the actual deferred native play result');
      assert.equal(facade.getState().status, 'switching');
      assert.equal(facade.getActiveAudio('during-resume', 'task-native').available, false);
      for (const wave of waves) wave.pause();
      finishPlay.resolve();
      await switching;
      assert.deepEqual(waves.map(wave => wave.isPlaying()), [false, false], 'A pause during asynchronous resume must not be replayed away');
    }
    const editable = waves[0].regions.getRegions()[0];
    editable.data.label = 'text edited after toggles';
    editable.start += 0.005;
    waves[0].regions.emit('region-updated', editable);
    assert.equal(editor.annotations.current.find(annotation => annotation.id === editable.id).content, 'text edited after toggles');
    if (scenario.name === 'ordinary result') {
      const entered = Promise.withResolvers(), finishLoad = Promise.withResolvers(), nextSources = Promise.withResolvers();
      waves[0].beforeDecode = async () => { entered.resolve(); await finishLoad.promise; };
      const staleSwitch = facade.selectStrength(88);
      await entered.promise;
      window.location.href = 'https://babel.test/transcription?reviewActionId=task-next';
      fiber.memoizedProps.reviewActionId = 'task-next';
      // Native callbacks belong to the abandoned task's component/refs. Give
      // the next task independent editor and lane refs rather than mutating
      // the abandoned callback's scene into the new task.
      const nextWaves = [], nextEditor = new NativeEditorFixture(nextWaves);
      for (const id of ['lane-1', 'lane-2']) {
        nextWaves.push(new NativeWaveFixture(id, () => nextWaves, () => {}, nextEditor));
      }
      nextEditor.selectionHook = { memoizedState: nextEditor.selected, queue: { dispatch: update => {
        nextEditor.selected = update(nextEditor.selected);
        nextEditor.selectionHook.memoizedState = nextEditor.selected;
      } } };
      waves = nextWaves; editor = nextEditor;
      fiber.memoizedState.memoizedState.current = Object.fromEntries(waves.map(wave => [wave.id, { wavesurfer: wave }]));
      fiber.memoizedState.next = editor.selectionHook;
      editor.rebuild(editor.annotations.current);
      const nextAnnotations = structuredClone(editor.annotations.current);
      const nextRegionIds = waves.map(wave => wave.regions.getRegions().map(region => region.id));
      onSources = nextSources.resolve;
      await facade.setEnabled(true);
      const next = await nextSources.promise;
      finishLoad.resolve();
      await staleSwitch;
      assert.equal(facade.getState().taskId, 'task-next');
      assert.equal(facade.getState().strength, 0);
      assert.equal(facade.getState().desiredStrength, 90);
      assert.equal(facade.getState().variantKey, '', 'Old-task mixed results cannot commit into the new task');
      assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [100, 100]);
      assert.deepEqual(editor.annotations.current, nextAnnotations, 'Abandoned native task callbacks cannot change the next task annotations');
      assert.deepEqual(waves.map(wave => wave.regions.getRegions().map(region => region.id)), nextRegionIds);
      assert.equal(facade.getActiveAudio('stale-task-capture', 'task-native').available, false);
      assert.notEqual(next.sessionId, sources.sessionId);
      const nextRevision = facade.getState().revision;
      for (const listener of listeners.get('message')) listener({ source: window, origin: window.location.origin, data: {
        source: stream.AUDIO_ENHANCEMENT_COMMAND_SOURCE, type: 'select-strength', sessionId: sources.sessionId,
        taskId: 'task-native', strength: 15
      } });
      assert.equal(facade.getState().revision, nextRevision, 'Old-session selection cannot alter the new task');
    }
    if (scenario.disposal === 'failure') {
      const failedOwner = facade;
      const selectedFetch = window.fetch;
      let foreignCalls = 0;
      const foreignFetch = async (...args) => { foreignCalls += 1; return selectedFetch(...args); };
      window.fetch = foreignFetch;
      expectedFetchAfterDispose = foreignFetch;
      const retained = facade.getActiveAudio('retained-before-dispose', 'task-native');
      waves[1].failAllOriginal = true;
      let replayQueued = false, replayCompleted = false;
      const stopReplayWatch = waves[0].on('load', url => {
        if (!url || replayQueued) return;
        replayQueued = true;
        void waves[1].loadBlob(new Blob([sourceWav(999)])).then(() => { replayCompleted = true; });
      });
      const beforeDrain = publications.length;
      await facade.dispose();
      stopReplayWatch();
      assert.equal(replayQueued, true, 'A real native load event enqueues a renderer replay during URL fallback');
      assert.equal(replayCompleted, true, 'Disposal drains replays queued during fallback before acknowledging completion');
      for (const wave of waves) assert.equal(wave.regions.addRegion, NativeRegionPluginFixture.prototype.addRegion,
        'Failed restoration releases every temporary region wrapper before retaining its error owner');
      assert.equal(window.__babelHelperAudioEnhancementBridge, failedOwner);
      assert.equal(enhancementProviders, 1, 'Failed restoration retains its owner and Original resources');
      assert.ok(foreignCalls > 0, 'Original URL restoration traverses a foreign wrapper without waiting on its own drain');
      assert.equal(readAudioEnhancementState().status, 'error');
      assert.equal(readAudioEnhancementState().desiredStrength, 0);
      assert.equal(readAudioEnhancementState().strength, retained.strength, 'Failure cannot claim Original is ready');
      const drainStates = publications.slice(beforeDrain);
      assert.ok(drainStates.slice(0, -1).every(state => state.status === 'switching' && state.desiredStrength === 0),
        'Intermediate rollback attempts remain pending until the entire restoration drain fails');
      assert.equal(drainStates.at(-1).status, 'error');
      assert.deepEqual(facade.getActiveAudio('retained-original', 'task-native', 'original').tracks.map(track => track.bytes),
        [sourceWav(100), sourceWav(100)]);
      bridge.initAudioEnhancementBridge();
      assert.equal(window.__babelHelperAudioEnhancementBridge, failedOwner, 'A duplicate injection cannot replace a failed restoration owner');
      const retrySources = Promise.withResolvers();
      onSources = retrySources.resolve;
      waves[1].failAllOriginal = false;
      await facade.setEnabled(true);
      await retrySources.promise;
      facade = window.__babelHelperAudioEnhancementBridge;
      assert.notEqual(facade, failedOwner);
      assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [100, 100]);
      const newState = attributes.get('data-babel-audio-enhancement');
      const newRevision = window.__babelHelperAudioEnhancementRevision;
      await failedOwner.dispose();
      assert.equal(window.__babelHelperAudioEnhancementBridge, facade);
      assert.equal(attributes.get('data-babel-audio-enhancement'), newState);
      assert.equal(window.__babelHelperAudioEnhancementRevision, newRevision);
    }
    const finalAnnotations = structuredClone(editor.annotations.current);
    const finalWrites = editor.writes;
    if (scenario.disposal === 'deferred') {
      const entered = Promise.withResolvers(), releaseLoad = Promise.withResolvers();
      const secondEntered = Promise.withResolvers(), releaseSecond = Promise.withResolvers();
      waves[0].beforeDecode = async marker => {
        assert.equal(marker, 100);
        entered.resolve();
        await releaseLoad.promise;
      };
      waves[1].beforeDecode = async marker => {
        assert.equal(marker, 100);
        secondEntered.resolve();
        await releaseSecond.promise;
      };
      window.location.href = 'https://babel.test/transcription?reviewActionId=task-native&displayFeedback=true';
      panel.memoizedProps.readOnly = true;
      root.stateNode.current = fiber;
      await entered.promise;
      assert.equal(readAudioEnhancementState().status, 'switching',
        'Confirmed native readonly starts Original restoration without waiting for UI disposal');
      const retiring = facade;
      const dispatchEvent = window.dispatchEvent;
      let announced = false, reenteredDisposal;
      window.dispatchEvent = event => {
        if (!announced && event.detail?.status === 'switching') {
          announced = true;
          reenteredDisposal = facade.dispose();
        }
      };
      const disposal = facade.dispose();
      window.dispatchEvent = dispatchEvent;
      assert.equal(reenteredDisposal, disposal, 'Synchronous state observers share the same disposal fence');
      assert.equal(window.__babelHelperAudioEnhancementBridge, retiring);
      assert.equal(enhancementProviders, 1);
      assert.equal(readAudioEnhancementState().status, 'switching');
      assert.equal(readAudioEnhancementState().desiredStrength, 0);
      assert.equal(readAudioEnhancementState().strength, 100);
      assert.equal(facade.getActiveAudio('during-dispose', 'task-native').available, false);
      bridge.initAudioEnhancementBridge();
      assert.equal(window.__babelHelperAudioEnhancementBridge, retiring, 'A new injection remains fenced behind the real native drain');
      assert.equal(enhancementProviders, 1);
      for (const requestId of ['disable-one', 'disable-two']) {
        for (const listener of [...listeners.get('message')]) listener({ source: window, origin: window.location.origin, data: {
          source: stream.AUDIO_ENHANCEMENT_COMMAND_SOURCE, type: 'dispose', requestId
        } });
      }
      for (const listener of [...listeners.get('message')]) listener({ source: window, origin: window.location.origin, data: {
        type: AUDIO_ENHANCEMENT_ACTIVE_REQUEST, version: AUDIO_ENHANCEMENT_PROTOCOL_VERSION,
        requestId: 'pending-consumer', taskId: 'task-native'
      } });
      await Promise.resolve();
      assert.equal(messages.find(message => message.requestId === 'pending-consumer').available, false);
      assert.equal(messages.filter(message => message.type === 'disabled').length, 0, 'No acknowledgement before Original decoding finishes');
      releaseLoad.resolve();
      await secondEntered.promise;
      assert.equal(waves[0].getDecodedData().marker, 100);
      assert.equal(waves[1].getDecodedData(), null);
      assert.equal(readAudioEnhancementState().status, 'switching');
      assert.equal(readAudioEnhancementState().desiredStrength, 0);
      assert.equal(facade.getActiveAudio('half-restored', 'task-native').available, false);
      assert.equal(messages.filter(message => message.type === 'disabled').length, 0, 'The second Original buffer must finish too');
      releaseSecond.resolve();
      await disposal;
      await Promise.resolve();
      assert.deepEqual(messages.filter(message => message.type === 'disabled').map(message => message.requestId).sort(),
        ['disable-one', 'disable-two']);
    } else {
      if (scenario.nativeAdmission) {
        const owner = window.__babelHelperAudioEnhancementBridge;
        const before = facade.getState();
        const beforeLoads = waves.map(wave => wave.loads.length);
        const sourcesCount = messages.filter(message => message.type === 'sources-ready').length;
        fiber.child = null;
        assert.equal(facade.getActiveAudio('unknown-native-view', 'task-native').available, false);
        root.stateNode.current = fiber;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(window.__babelHelperAudioEnhancementBridge, owner);
        assert.equal(enhancementProviders, 1);
        assert.deepEqual(waves.map(wave => wave.loads.length), beforeLoads, 'Unknown metadata cannot start new source work');
        assert.deepEqual(facade.getState(), before, 'Transient missing metadata retains the enabled owner and selected pair');
        fiber.child = panel;
        root.stateNode.current = fiber;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(facade.getActiveAudio('view-returned', 'task-native').available, true,
          'The still-enabled preference recovers without a manual toggle');
        assert.equal(messages.filter(message => message.type === 'sources-ready').length, sourcesCount,
          'Returning metadata reuses retained Originals instead of recapturing Enhanced buffers');
        fiber.child = null;
      }
      await facade.dispose();
      if (scenario.nativeAdmission) fiber.child = panel;
    }
    assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [100, 100]);
    assert.equal(editor.writes, finalWrites, 'Teardown restores Original without annotation mutations');
    assert.deepEqual(editor.annotations.current, finalAnnotations);
    assert.equal(window.__babelHelperAudioEnhancementBridge, undefined);
    assert.equal(window.__babelHelperAudioEnhancementRevision, undefined);
    assert.equal(attributes.has('data-babel-audio-enhancement'), false);
    assert.equal(enhancementProviders, 0);
    assert.equal(window.fetch, expectedFetchAfterDispose);
    await facade.setEnabled(true);
    assert.equal(enhancementProviders, 0, 'A retained revoked facade cannot reactivate');
    for (const wave of waves) {
      assert.equal(wave.load, NativeWaveFixture.prototype.load);
      assert.equal(wave.loadBlob, NativeWaveFixture.prototype.loadBlob);
      assert.equal(wave.regions.addRegion, NativeRegionPluginFixture.prototype.addRegion);
    }
    if (scenario.disposal === 'deferred') {
      window.location.href = 'https://babel.test/transcription?reviewActionId=task-native';
      panel.memoizedProps.readOnly = false;
    }
    await splitCurrent();
    if (scenario.disposal === 'deferred') {
      const retired = facade;
      const nextSources = Promise.withResolvers();
      onSources = nextSources.resolve;
      bridge.initAudioEnhancementBridge('chrome-extension://helper/dist/content/audio-enhancement-worker.js');
      facade = window.__babelHelperAudioEnhancementBridge;
      await facade.setEnabled(true);
      await nextSources.promise;
      const nextState = attributes.get('data-babel-audio-enhancement');
      const nextRevision = window.__babelHelperAudioEnhancementRevision;
      await retired.dispose();
      assert.equal(window.__babelHelperAudioEnhancementBridge, facade);
      assert.equal(attributes.get('data-babel-audio-enhancement'), nextState, 'An old disposal cannot clear its successor state');
      assert.equal(window.__babelHelperAudioEnhancementRevision, nextRevision);
      assert.equal(enhancementProviders, 1);
    }
  } finally {
    await facade.dispose();
  }
});
}
