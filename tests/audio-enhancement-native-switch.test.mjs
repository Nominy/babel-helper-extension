import test from 'node:test';
import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { join } from 'node:path';
import { defaultSnapshotDir } from '@nominy/babel-extension-e2e/recreation-snapshot';

const { recoveredModuleSources, recoveredEditorModuleId } = await loadEntry(
  join(defaultSnapshotDir, 'app/src/recovered/generated/moduleSources.ts')
);
const recoveredEditor = (await transform(`(${recoveredModuleSources[recoveredEditorModuleId]})`, { loader: 'js', minify: false })).code;

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
    this.splitAnnotation = nativeCallback('Q3', {
      x3: this.annotations, crypto,
      L3: command => command.do(),
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
    const bind = nativeCallback('nk2', {
      nr2: null, Z2: { current: () => ({ region: '#ccc', regionBorder: '#999' }) },
      W2: () => ({}), eu2: () => {}, es2: { refs: { current: refs } },
      tb2: {}, eb2: (id, selected) => this.select(id, selected), tI2: { current: new Set() },
      g2: 'transcription', ek2: this.annotations.current, L2: false, tN2: false,
      tq2: this.splitAnnotation, tM2: { current: false }, t6: { SHORT: 1 }, setTimeout,
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
    this.loads = [];
    this.media = { volume: this.volume, muted: this.muted };
    this.regions = new NativeRegionPluginFixture(this, editor);
    this.onLoading = onLoading;
    // Recovered native editor module 73681 invokes zoom on ready, synchronizing
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
  once(type, listener) {
    const cleanup = this.on(type, (...args) => { cleanup(); listener(...args); });
    return cleanup;
  }
  emit(type, ...args) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener(...args); }
  zoom() { if (!this.decoded) throw new Error('No audio loaded'); }
  async loadBlob(blob) {
    this.decoded = null;
    this.onLoading(this);
    try {
      const bytes = await blob.arrayBuffer();
      const marker = new DataView(bytes).getInt16(44, true);
      this.loads.push(marker);
      this.loadedBytes = bytes;
      const beforeDecode = this.beforeDecode;
      this.beforeDecode = undefined;
      await beforeDecode?.(marker);
      if (this.failNextOriginal && marker === 100) {
        this.failNextOriginal = false;
        throw new Error('Native second lane decoder failed');
      }
      this.decoded = decoded(marker);
      // Recovered loadBlob itself does not clear the regions plugin.
      this.emit('ready');
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }
  async load(url) { const response = await fetch(url); return this.loadBlob(await response.blob()); }
  getDecodedData() { return this.decoded; }
  getCurrentTime() { return this.time; }
  getPlaybackRate() { return this.rate; }
  isPlaying() { return this.playing; }
  pause() { this.playing = false; }
  play() { this.playing = true; }
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
  const attributes = new Map();
  const listeners = new Map();
  const publications = [];
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
    location: { origin: 'https://babel.test', href: 'https://babel.test/transcription?reviewActionId=task-native' },
    fetch: async () => new Response(sourceWav(100), { headers: { 'Content-Type': 'audio/wav' } }),
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval() {},
    addEventListener(type, listener) { const group = listeners.get(type) ?? new Set(); group.add(listener); listeners.set(type, group); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatchEvent() {},
    postMessage(data) {
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
  for (const id of ['lane-1', 'lane-2']) waves.push(new NativeWaveFixture(id, () => originalWaves, wave => {
    loading.push({ id: wave.id, state: facade.getState(), active: facade.getActiveAudio('capture', 'task-native').available,
      counterpartDecoded: originalWaves.filter(candidate => candidate !== wave).every(candidate => candidate.getDecodedData() !== null) });
  }, originalEditor));
  editor.selectionHook = { memoizedState: editor.selected, queue: { dispatch: update => {
    originalEditor.selected = update(originalEditor.selected);
    originalEditor.selectionHook.memoizedState = originalEditor.selected;
  } } };
  editor.rebuild(editor.annotations.current);
  const fiber = {
    memoizedProps: { reviewActionId: 'task-native', mode: 'annotation', transcriptionChunkProcessedRecordings: waves.map(wave => ({
      processedRecordingId: wave.id, processedRecordingUrl: `https://babel.test/${wave.id}.wav`, speaker: wave.id
    })) },
    memoizedState: { memoizedState: { current: Object.fromEntries(waves.map(wave => [wave.id, { wavesurfer: wave }])) }, next: editor.selectionHook }
  };
  const root = { stateNode: { current: fiber } };
  const seed = { __reactFiber$fixture: { return: root } };
  install('window', window);
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
  bridge.initAudioEnhancementBridge();
  const { registerSmartSplit } = await loadEntry('src/features/smart-split.ts');
  const splitConsumer = registerSmartSplit({ state: {} }, {});
  facade = window.__babelHelperAudioEnhancementBridge;
  try {
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
      splitConsumer.dispatchSplitClick(target.element, midpoint * 100, 50);
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
    await splitCurrent();
    await facade.selectStrength(60);
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
    const finalAnnotations = structuredClone(editor.annotations.current);
    const finalWrites = editor.writes;
    await facade.dispose();
    assert.deepEqual(waves.map(wave => wave.getDecodedData().marker), [100, 100]);
    assert.equal(editor.writes, finalWrites, 'Teardown restores Original without annotation mutations');
    assert.deepEqual(editor.annotations.current, finalAnnotations);
    assert.equal(window.__babelHelperAudioEnhancementBridge, undefined);
    assert.equal(window.__babelHelperAudioEnhancementRevision, undefined);
    assert.equal(attributes.has('data-babel-audio-enhancement'), false);
    assert.equal(enhancementProviders, 0);
    assert.equal(window.fetch, nativeFetch);
    await facade.setEnabled(true);
    assert.equal(enhancementProviders, 0, 'A retained revoked facade cannot reactivate');
    for (const wave of waves) {
      assert.equal(wave.load, NativeWaveFixture.prototype.load);
      assert.equal(wave.loadBlob, NativeWaveFixture.prototype.loadBlob);
      assert.equal(wave.regions.addRegion, NativeRegionPluginFixture.prototype.addRegion);
    }
    await splitCurrent();
  } finally {
    await facade.dispose();
  }
});
}
