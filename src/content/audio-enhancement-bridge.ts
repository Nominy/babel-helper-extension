import {
  AUDIO_ENHANCEMENT_ACTIVE_REQUEST, AUDIO_ENHANCEMENT_ACTIVE_RESPONSE,
  AUDIO_ENHANCEMENT_PROTOCOL_VERSION, AUDIO_ENHANCEMENT_STATE_ATTRIBUTE, AUDIO_ENHANCEMENT_STATE_EVENT,
  findBabelEditorFiber, isAudioEnhancementProgress, isAudioEnhancementStrength, parseBabelRoute, readBabelEditorState, readAudioEnhancementState,
  type ActiveAudioResponse, type AudioEnhancementState
} from '@nominy/babel-babel-runtime';
import type { BabelModsHost } from '../mod-platform/page-host';
import type { ServiceRegistry } from '../mod-platform/service-registry';
import {
  AUDIO_ENHANCEMENT_COMMAND_SOURCE, AUDIO_ENHANCEMENT_EVENT_SOURCE, audioSha256,
  validateEnhancementWav, isEnhancementInstalledTrack, isEnhancementCacheMetadata,
  type EnhancementCacheMetadata, type EnhancementSourceTrack
} from '../services/audio-enhancement-stream';
import { mixEnhancementWav, readSourceWavHeader } from './audio-enhancement-mix';

interface NativeRegionOptions {
  id: string;
  start: number;
  end: number;
  content?: string | HTMLElement;
  color?: string;
  drag?: boolean;
  resize?: boolean;
  resizeStart?: boolean;
  resizeEnd?: boolean;
  contentEditable?: boolean;
  channelIdx?: number;
  minLength?: number;
  maxLength?: number;
  data?: unknown;
}
interface NativeRegion extends NativeRegionOptions {
  setOptions(options: NativeRegionOptions): void;
  remove(): void;
  element?: HTMLElement | null;
}
interface NativeRegionsPlugin {
  getRegions(): NativeRegion[];
  addRegion(options: NativeRegionOptions): NativeRegion;
}
interface NativeWave {
  load(url: string, peaks?: (Float32Array | number[])[], duration?: number): Promise<void> | void;
  loadBlob(blob: Blob, peaks?: (Float32Array | number[])[], duration?: number): Promise<void> | void;
  getDecodedData(): AudioBuffer | null;
  getCurrentTime(): number;
  getPlaybackRate(): number;
  isPlaying(): boolean;
  pause(): void;
  play(): Promise<void> | void;
  setTime(seconds: number): void;
  setPlaybackRate(rate: number): void;
  getMediaElement?(): HTMLMediaElement;
  getActivePlugins?(): unknown[];
  getVolume?(): number;
  getMuted?(): boolean;
  getScroll?(): number;
  setVolume?(volume: number): void;
  setMuted?(muted: boolean): void;
  setScroll?(scroll: number): void;
  on?(event: string, listener: (...args: unknown[]) => void): (() => void) | void;
  once?(event: string, listener: (...args: unknown[]) => void): (() => void) | void;
  abortController?: AbortController;
}
interface NativeEditorHook {
  memoizedState?: unknown;
  next?: unknown;
  queue?: { dispatch?: unknown } | null;
}
interface NativeEditorFiber {
  memoizedState?: unknown;
}
interface AudioEnhancementFacade {
  getState(): AudioEnhancementState;
  getActiveAudio(requestId: string, taskId: string, selection?: string): ActiveAudioResponse;
  selectStrength(strength: number): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  dispose(): Promise<void>;
}
declare global {
  interface Window {
    __babelHelperAudioEnhancementBridge?: AudioEnhancementFacade;
    __babelHelperAudioEnhancementRevision?: number;
  }
}
interface EnhancementBridgeMessage {
  type?: unknown;
  source?: unknown;
  version?: unknown;
  requestId?: unknown;
  taskId?: unknown;
  sessionId?: unknown;
  selection?: unknown;
  strength?: unknown;
  message?: unknown;
  tracks?: unknown;
  variantKey?: unknown;
  model?: unknown;
  progress?: unknown;
  cacheStatus?: unknown;
  cacheMessage?: unknown;
}

function isNativeWave(value: unknown): value is NativeWave {
  if (typeof value !== 'object' || value === null) return false;
  const wave = value as Partial<NativeWave>;
  return typeof wave.load === 'function' && typeof wave.loadBlob === 'function' &&
    typeof wave.getDecodedData === 'function' && typeof wave.getCurrentTime === 'function' &&
    typeof wave.getPlaybackRate === 'function' && typeof wave.isPlaying === 'function' &&
    typeof wave.pause === 'function' && typeof wave.play === 'function' &&
    typeof wave.setTime === 'function' && typeof wave.setPlaybackRate === 'function';
}

function isRegionsPlugin(value: unknown): value is NativeRegionsPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const plugin = value as Partial<NativeRegionsPlugin>;
  return typeof plugin.getRegions === 'function' && typeof plugin.addRegion === 'function';
}
type NativeSelectionState = Record<string, { activeRegionId: string | null; [key: string]: unknown }>;
type NativeSnapshot = {
  taskId: string; key: string;
  tracks: { id: string; label: string; audioUrl: string; wave: NativeWave | null }[];
  selection?: { state: NativeSelectionState; dispatch: (update: (prior: NativeSelectionState) => NativeSelectionState) => void };
};
type RetainedTrack = EnhancementSourceTrack & {
  audioUrl: string; original: ArrayBuffer; originalBlob: Blob;
  enhanced?: ArrayBuffer; enhancedBlob?: Blob;
};
type WavePatch = {
  wave: NativeWave; trackId: string; load: NativeWave['load']; loadBlob: NativeWave['loadBlob'];
  wrappedLoad: NativeWave['load']; wrappedLoadBlob: NativeWave['loadBlob'];
  decoded: AudioBuffer | null; strength: number | null; unbind: (() => void)[];
  activeAbort: AbortController | null;
};
type SourcePair = {
  strength: number; variantKey: string; tracks: { bytes: ArrayBuffer; blob: Blob }[];
};
type Session = {
  id: string; key: string; taskId: string; tracks: RetainedTrack[]; capturing: boolean; captureAbort: AbortController;
  model: string; variantKey: string; sourceNotice: string; patches: Map<NativeWave, WavePatch>; switching: boolean;
  selected?: SourcePair;
  cache?: EnhancementCacheMetadata;
  regionAddPatches: Map<NativeRegionsPlugin, { add: NativeRegionsPlugin['addRegion']; wrapped: NativeRegionsPlugin['addRegion'] }>;
};

function nativeSnapshot(): NativeSnapshot | null {
  const route = parseBabelRoute();
  if (!route.isTranscriptionRoute || route.isReadOnlyFeedbackRoute) return null;
  const state = readBabelEditorState();
  if (!state?.reviewActionId || state.tracks.length !== 2 ||
      (route.reviewActionId && route.reviewActionId !== state.reviewActionId) ||
      state.tracks.some(track => !track.id || !track.audioUrl) || new Set(state.tracks.map(track => track.id)).size !== 2) return null;
  const fiber = findBabelEditorFiber() as NativeEditorFiber | null;
  const waves = new Map<string, NativeWave>();
  let selection: NativeSnapshot['selection'];
  for (let value: unknown = fiber?.memoizedState; typeof value === 'object' && value !== null;) {
    const hook = value as NativeEditorHook;
    const hookState = hook.memoizedState;
    const registry = typeof hookState === 'object' && hookState !== null && 'current' in hookState ? hookState.current : null;
    if (typeof registry === 'object' && registry !== null) {
      for (const track of state.tracks) {
        if (!(track.id in registry)) continue;
        const entry: unknown = Reflect.get(registry, track.id);
        if (typeof entry !== 'object' || entry === null || !('wavesurfer' in entry)) continue;
        if (isNativeWave(entry.wavesurfer)) waves.set(track.id, entry.wavesurfer);
      }
    }
    const selected = hook.memoizedState;
    if (typeof selected === 'object' && selected !== null && typeof hook.queue?.dispatch === 'function' &&
        state.tracks.every(track => {
          const entry: unknown = Reflect.get(selected, track.id);
          return typeof entry === 'object' && entry !== null && 'activeRegionId' in entry &&
            (entry.activeRegionId === null || typeof entry.activeRegionId === 'string');
        })) {
      selection = {
        state: selected as NativeSelectionState,
        dispatch: hook.queue.dispatch as NonNullable<NativeSnapshot['selection']>['dispatch']
      };
    }
    value = hook.next;
  }
  return {
    taskId: state.reviewActionId,
    key: JSON.stringify([state.reviewActionId, state.tracks.map(track => [track.id, track.audioUrl])]),
    tracks: state.tracks.map(track => ({ ...track, wave: waves.get(track.id) ?? null })),
    selection
  };
}

/** Used only for a non-WAV/unreadable native source; preserve decoded float precision. */
function decodedSourceWav(audio: AudioBuffer): ArrayBuffer {
  const channels = audio.numberOfChannels;
  const frames = audio.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 4);
  const view = new DataView(bytes);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  }
  view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true); view.setUint32(28, audio.sampleRate * channels * 4, true);
  view.setUint16(32, channels * 4, true); view.setUint16(34, 32, true); view.setUint32(40, frames * channels * 4, true);
  const samples = Array.from({ length: channels }, (_, channel) => audio.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      view.setFloat32(offset, samples[channel][frame], true);
      offset += 4;
    }
  }
  return bytes;
}

function sourceWavTiming(bytes: ArrayBuffer): { sampleRate: number; frameCount: number } {
  const { sampleRate, frameCount } = readSourceWavHeader(bytes);
  return { sampleRate, frameCount };
}

export function initAudioEnhancementBridge(): void {
  const page = window;
  if (page.__babelHelperAudioEnhancementBridge) return;
  let enabled = false;
  let disposed = false;
  let disposing = false;
  let disposal: Promise<void> | null = null;
  let session: Session | null = null;
  let tail: Promise<void> = Promise.resolve();
  let revision = Number(page.__babelHelperAudioEnhancementRevision) || 0;
  revision = Math.max(revision, readAudioEnhancementState()?.revision || 0);
  let state: AudioEnhancementState = {
    version: AUDIO_ENHANCEMENT_PROTOCOL_VERSION, taskId: '', status: 'idle',
    strength: 0, desiredStrength: 100, revision, variantKey: ''
  };
  const nativeFetch = window.fetch;
  let fetchInstalled = false;
  let poll: number | null = null;

  function publish(changes: Partial<AudioEnhancementState> = {}): void {
    state = { ...state, ...changes, revision: ++revision };
    if (session?.variantKey && session.taskId === state.taskId) state.pairedVariantKey = session.variantKey;
    else delete state.pairedVariantKey;
    if (state.status === 'idle' || state.status === 'ready' || state.status === 'error') delete state.progress;
    if (!disposing && !disposed) {
      page.__babelHelperAudioEnhancementRevision = revision;
      document.documentElement.setAttribute(AUDIO_ENHANCEMENT_STATE_ATTRIBUTE, JSON.stringify(state));
      window.dispatchEvent(new CustomEvent(AUDIO_ENHANCEMENT_STATE_EVENT, { detail: state }));
      window.postMessage({ source: AUDIO_ENHANCEMENT_EVENT_SOURCE, type: 'state', state, sessionId: session?.id || '' }, window.location.origin);
    }
  }

  function current(target: Session, snapshot = nativeSnapshot()): boolean {
    return !disposed && session === target && snapshot?.key === target.key;
  }

  function selectionNotice(target: Session, strength: number): string {
    let selection = strength === 100 ? 'Enhanced audio selected.' : strength === 0
      ? 'Original audio selected.' : `${strength}% Enhanced / ${100 - strength}% Original audio selected.`;
    if (strength > 0 && target.cache?.cacheStatus === 'hit') {
      selection += ' Reusing the locally cached pair.';
    } else if (strength > 0 && target.cache?.cacheStatus === 'stored') {
      selection += ' Pair saved in the local cache.';
    }
    const warning = target.cache?.cacheStatus === 'unavailable'
      ? `Local audio cache unavailable: ${target.cache.cacheMessage || 'The enhanced pair could not be retained for reuse.'}` : '';
    return [selection, target.sourceNotice, warning].filter(Boolean).join(' ');
  }

  function release(target: Session): void {
    target.captureAbort.abort();
    for (const [plugin, patch] of target.regionAddPatches) {
      if (plugin.addRegion === patch.wrapped) plugin.addRegion = patch.add;
    }
    target.regionAddPatches.clear();
    for (const patch of target.patches.values()) {
      if (patch.activeAbort && patch.wave.abortController === patch.activeAbort) patch.activeAbort.abort();
      if (patch.wave.load === patch.wrappedLoad) patch.wave.load = patch.load;
      if (patch.wave.loadBlob === patch.wrappedLoadBlob) patch.wave.loadBlob = patch.loadBlob;
      for (const unbind of patch.unbind) unbind();
    }
    target.patches.clear();
    target.selected = undefined;
    target.tracks.length = 0;
  }

  const selectedFetch: typeof fetch = async (input, init) => {
    const target = session;
    const url = input instanceof Request ? input.url : new URL(String(input), window.location.href).href;
    const track = target && current(target)
      ? target.tracks.find(item => new URL(item.audioUrl, window.location.href).href === url) : null;
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    if (track && method.toUpperCase() === 'GET') {
      if (target?.switching) await tail;
      if (!target || !current(target)) return nativeFetch.call(window, input, init);
      if (init?.signal?.aborted || (input instanceof Request && input.signal.aborted)) throw new DOMException('Aborted', 'AbortError');
      const bytes = target.selected?.tracks[target.tracks.indexOf(track)]?.bytes;
      if (bytes) return new Response(bytes, { status: 200, headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(bytes.byteLength) } });
    }
    return nativeFetch.call(window, input, init);
  };

  function patchWave(target: Session, track: RetainedTrack, wave: NativeWave): WavePatch {
    const existing = target.patches.get(wave);
    if (existing) return existing;
    if (typeof wave.load !== 'function' || typeof wave.loadBlob !== 'function') throw new Error('Native audio player does not support source replacement.');
    const patch: WavePatch = {
      wave, trackId: track.trackId, load: wave.load, loadBlob: wave.loadBlob,
      wrappedLoad: wave.load, wrappedLoadBlob: wave.loadBlob,
      decoded: null, strength: null, unbind: [], activeAbort: null
    };
    // A native rerender may replay its old URL/peaks. Keep all native loaders on
    // the selected WAV instead of supplying stale precomputed renderer peaks.
    patch.wrappedLoad = (...args: Parameters<NativeWave['load']>) => {
      if (!current(target)) return patch.load.apply(wave, args);
      patch.strength = null;
      return queueSwitch(target, true);
    };
    patch.wrappedLoadBlob = (...args: Parameters<NativeWave['loadBlob']>) => {
      if (!current(target)) return patch.loadBlob.apply(wave, args);
      patch.strength = null;
      return queueSwitch(target, true);
    };
    wave.load = patch.wrappedLoad;
    wave.loadBlob = patch.wrappedLoadBlob;
    if (typeof wave.on === 'function') {
      const unbind = wave.on('ready', () => {
        if (current(target) && !target.switching) void queueSwitch(target, true);
      });
      if (typeof unbind === 'function') patch.unbind.push(unbind);
    }
    target.patches.set(wave, patch);
    return patch;
  }

  function requestedStrength(target: Session): number {
    return enabled && target.variantKey ? state.desiredStrength : 0;
  }

  async function sourcePair(target: Session, strength: number, latest: () => number): Promise<SourcePair> {
    if (target.selected?.strength === strength) return target.selected;
    const variantKey = strength === 0 ? '' : strength === 100 ? target.variantKey
      : await audioSha256(new TextEncoder().encode(JSON.stringify(['zip-linear-pcm16-v1', target.variantKey, strength])).buffer);
    // Hashing yields: discard an obsolete request before allocating either mix.
    if (!current(target) || strength !== latest()) throw new Error('Audio strength request was superseded.');
    return {
      strength, variantKey, tracks: target.tracks.map(track => {
        if (strength === 0) return { bytes: track.original, blob: track.originalBlob };
        if (!track.enhanced || !track.enhancedBlob) throw new Error('Enhanced audio is unavailable.');
        if (strength === 100) return { bytes: track.enhanced, blob: track.enhancedBlob };
        const bytes = mixEnhancementWav(track.original, track.enhanced, strength);
        return { bytes, blob: new Blob([bytes], { type: 'audio/wav' }) };
      })
    };
  }

  async function replaceSources(target: Session, strength: number, originalUrl = false, followDesired = true): Promise<void> {
    const snapshot = nativeSnapshot();
    if (!current(target, snapshot) || !snapshot?.tracks.every(track => track.wave)) return;
    const latestStrength = () => followDesired ? requestedStrength(target) : strength;
    const entries = target.tracks.map(track => {
      const wave = snapshot.tracks.find(item => item.id === track.trackId)?.wave;
      if (!wave) throw new Error('A native audio player was replaced before source switching.');
      const patch = patchWave(target, track, wave);
      return { track, patch, wave };
    });
    if (entries.every(entry => entry.patch.strength === strength && entry.patch.decoded === entry.wave.getDecodedData())) {
      if (target.variantKey && state.status === 'processing') publish({
        strength, variantKey: target.selected?.variantKey || '', status: 'ready', message: selectionNotice(target, strength)
      });
      return;
    }
    if (strength > 0 && entries.some(entry => !entry.track.enhancedBlob)) return;
    const priorPair = target.selected;
    if (!priorPair) return;
    const priorStatus = state.status;
    const priorMessage = state.message || '';
    const transport = entries.map(({ wave }) => {
      const media = wave.getMediaElement?.();
      const plugins = (wave.getActivePlugins?.() || []).filter(isRegionsPlugin);
      return {
        time: wave.getCurrentTime(), playing: wave.isPlaying(), rate: wave.getPlaybackRate(),
        volume: wave.getVolume?.() ?? media?.volume ?? 1, muted: wave.getMuted?.() ?? media?.muted ?? false,
        scroll: wave.getScroll?.(),
        // Native ready callbacks rebuild annotation regions. Let those callbacks
        // register real DOM/editing listeners, but retain the current annotation
        // membership, metadata and options rather than an old ready closure.
        plugins: plugins.map(plugin => ({ plugin, regions: plugin.getRegions().map(region => ({ options: {
          id: region.id, start: region.start, end: region.end, content: region.content,
          color: region.color, drag: region.drag, resize: region.resize,
          resizeStart: region.resizeStart, resizeEnd: region.resizeEnd, contentEditable: region.contentEditable,
          channelIdx: region.channelIdx, minLength: region.minLength, maxLength: region.maxLength, data: region.data
        } })) }))
      };
    });
    if (transport.some((saved, index) => saved.plugins.length && typeof entries[index].wave.once !== 'function')) {
      throw new Error('Native region editing requires ready notifications for audio source replacement.');
    }
    target.switching = true;
    for (const saved of transport) {
      for (const savedPlugin of saved.plugins) {
        const { plugin } = savedPlugin;
        const optionsById = new Map(savedPlugin.regions.map(item => [item.options.id, item.options]));
        const add = plugin.addRegion;
        const wrapped: NativeRegionsPlugin['addRegion'] = options => add.call(plugin, optionsById.get(options.id) ?? options);
        target.regionAddPatches.set(plugin, { add, wrapped });
        plugin.addRegion = wrapped;
      }
    }
    const stillSameWaves = () => {
      const fresh = nativeSnapshot();
      return current(target, fresh) && entries.every(entry => fresh?.tracks.find(track => track.id === entry.track.trackId)?.wave === entry.wave);
    };
    function restoreRegions(): void {
      if (!stillSameWaves()) return;
      for (const saved of transport) {
        for (const { plugin, regions } of saved.plugins) {
          const retained = new Map(regions.map(item => [item.options.id, item.options]));
          const present = new Map<string, NativeRegion>();
          for (const region of plugin.getRegions()) {
            if (!retained.has(region.id) || present.has(region.id)) region.remove();
            else present.set(region.id, region);
          }
          for (const [id, options] of retained) {
            const region = present.get(id) ?? plugin.addRegion(options);
            region.setOptions(options);
            region.data = options.data;
          }
        }
      }
    }
    async function load(pair: SourcePair, followDesired = false): Promise<boolean> {
      // Native ready callbacks synchronize zoom across lanes. Keep the other
      // lane decoded until this load finishes; a failed lane is restored first.
      const missingIndex = entries.findIndex(({ wave }) => !wave.getDecodedData());
      const firstIndex = Math.max(0, missingIndex);
      for (let index = 0; index < entries.length; index += 1) {
        const entryIndex = (firstIndex + index) % entries.length;
        const { track, patch, wave } = entries[entryIndex];
        if (!stillSameWaves()) throw new Error('The native task or audio players changed during source switching.');
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        let settled = false;
        const unbind: (() => void)[] = [];
        let completion: Promise<void> | null = null;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          for (const cleanup of unbind) cleanup();
          patch.activeAbort = null;
          if (error) reject(error); else resolve();
        };
        const timeout = window.setTimeout(() => {
          if (wave.abortController === patch.activeAbort) patch.activeAbort?.abort();
          finish(new Error('Native audio source loading timed out.'));
        }, 120000);
        try {
          if (typeof wave.once === 'function') {
            // Run synchronously after native ready/rebuild handlers, while their
            // annotation-sync guard is still active. Never suppress region-created:
            // it owns native split, selection, tooltip and edit registration.
            const ready = wave.once('ready', () => { restoreRegions(); finish(); });
            const failed = wave.once('error', (error: unknown) => finish(error || new Error('Native audio decoding failed.')));
            if (typeof ready === 'function') unbind.push(ready);
            if (typeof failed === 'function') unbind.push(failed);
          }
          const blob = pair.tracks[entryIndex]?.blob;
          if (!blob) throw new Error('The requested native audio source is unavailable.');
          const pending = originalUrl && pair.strength === 0
            ? patch.load.call(wave, track.audioUrl) : patch.loadBlob.call(wave, blob);
          patch.activeAbort = wave.abortController instanceof AbortController ? wave.abortController : null;
          if (pending && typeof pending.then === 'function') {
            completion = pending;
            pending.then(() => finish(), finish);
          }
          else if (typeof wave.once !== 'function') finish(new Error('Native audio player does not expose load completion.'));
        } catch (error) { finish(error); }
        await promise;
        if (completion) await completion;
        if (typeof wave.once !== 'function') restoreRegions();
        if (followDesired && latestStrength() !== pair.strength) return false;
      }
      if (!stillSameWaves()) throw new Error('The native task or audio players changed during source switching.');
      entries.forEach(({ wave, track, patch }) => {
        const audio = wave.getDecodedData();
        if (!audio || Math.abs(audio.duration - track.frameCount / track.sampleRate) > 1 / audio.sampleRate + 0.000001) {
          throw new Error('Native player decoded an incorrectly timed audio source.');
        }
        patch.decoded = audio;
        patch.strength = pair.strength;
      });
      return true;
    }
    async function restoreTransport(): Promise<void> {
      if (!stillSameWaves()) return;
      for (let index = 0; index < entries.length; index += 1) {
        const { wave } = entries[index];
        const saved = transport[index];
        // Regions have already been reconciled by native ready registration.
        wave.setPlaybackRate(saved.rate);
        wave.setVolume?.(saved.volume); wave.setMuted?.(saved.muted);
        wave.setTime(saved.time);
        if (typeof saved.scroll === 'number' && Number.isFinite(saved.scroll)) wave.setScroll?.(saved.scroll);
      }
      const selected = snapshot?.selection;
      if (selected) {
        const activeByTrack: Record<string, string | null> = {};
        for (let index = 0; index < entries.length; index += 1) {
          const trackId = entries[index].track.trackId;
          const id = selected.state[trackId]?.activeRegionId;
          if (id === undefined) continue;
          const plugins = transport[index].plugins;
          const activeRegionId = id === null || plugins.some(({ plugin }) => plugin.getRegions().some(region => region.id === id)) ? id : null;
          activeByTrack[trackId] = activeRegionId;
          for (const { plugin } of plugins) for (const region of plugin.getRegions()) {
            if (region.element) region.element.style.filter = region.id === activeRegionId ? 'brightness(0.8)' : '';
          }
        }
        selected.dispatch(prior => {
          let next = prior;
          for (const { track } of entries) {
            const activeRegionId = activeByTrack[track.trackId];
            if (activeRegionId !== undefined && prior[track.trackId] && prior[track.trackId].activeRegionId !== activeRegionId) {
              if (next === prior) next = { ...prior };
              next[track.trackId] = { ...prior[track.trackId], activeRegionId };
            }
          }
          return next;
        });
      }
      await Promise.all(entries.map(({ wave }, index) => transport[index].playing ? Promise.resolve(wave.play()) : Promise.resolve()));
    }
    try {
      publish({ status: 'switching', message: strength > 0 ? 'Preparing selected audio for native players…' : 'Restoring original audio…' });
      for (const entry of entries) entry.wave.pause();
      let appliedPair: SourcePair | undefined;
      while (stillSameWaves()) {
        const requested = latestStrength();
        try {
          appliedPair = await sourcePair(target, requested, latestStrength);
        } catch (error) {
          if (!stillSameWaves()) return;
          if (requested !== latestStrength()) continue;
          throw error;
        }
        if (!stillSameWaves()) return;
        if (appliedPair.strength !== latestStrength()) continue;
        if (!await load(appliedPair, true)) continue;
        await restoreTransport();
        if (latestStrength() === appliedPair.strength) break;
        for (const entry of entries) entry.wave.pause();
      }
      if (stillSameWaves() && appliedPair) {
        target.selected = appliedPair;
        publish({
          strength: appliedPair.strength, variantKey: appliedPair.variantKey,
          status: !followDesired && priorStatus === 'error' ? 'error' : target.variantKey ? 'ready'
            : state.status === 'error' || priorStatus === 'error' ? 'error' : 'processing',
          message: !followDesired && priorStatus === 'error' ? priorMessage : target.variantKey
            ? selectionNotice(target, appliedPair.strength) : state.status === 'error' ? state.message : priorMessage || target.sourceNotice
        });
      }
    } catch (error) {
      if (stillSameWaves()) {
        try {
          await load(priorPair);
          await restoreTransport();
          publish({ strength: priorPair.strength, variantKey: priorPair.variantKey, status: 'error',
            message: `Audio switch failed; previous source restored. ${error instanceof Error ? error.message : String(error)}` });
        } catch (rollbackError) {
          // Playback stays paused; mismatched decoded buffers remain unavailable.
          for (const entry of entries) entry.wave.pause();
          publish({ strength: priorPair.strength, variantKey: priorPair.variantKey, status: 'error',
            message: `Native audio restoration failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}` });
        }
      }
    } finally {
      for (const [plugin, patch] of target.regionAddPatches) {
        if (plugin.addRegion === patch.wrapped) plugin.addRegion = patch.add;
      }
      target.regionAddPatches.clear();
      target.switching = false;
    }
  }

  function queueSwitch(target: Session, nativeReplay = false): Promise<void> {
    const operation = tail.then(async () => {
      if (!current(target) || !target.tracks.length) return;
      const retainCommitted = nativeReplay && enabled && state.status === 'error';
      await replaceSources(target, retainCommitted ? state.strength : requestedStrength(target), false, !retainCommitted);
    });
    tail = operation.catch(error => {
      if (current(target)) publish({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return tail;
  }

  async function capture(target: Session, snapshot: NativeSnapshot): Promise<void> {
    if (target.capturing || target.tracks.length || !snapshot.tracks.every(track => (track.wave?.getDecodedData()?.length || 0) > 0)) return;
    target.capturing = true;
    try {
      const tracks = await Promise.all(snapshot.tracks.map(async (native): Promise<RetainedTrack> => {
        const audio = native.wave?.getDecodedData();
        if (!audio) throw new Error('The native source audio was replaced during capture.');
        let bytes: ArrayBuffer;
        let timing: { sampleRate: number; frameCount: number };
        try {
          const response = await nativeFetch.call(window, native.audioUrl, { signal: target.captureAbort.signal });
          if (!response.ok) throw new Error(`Source download returned HTTP ${response.status}.`);
          bytes = await response.arrayBuffer();
          timing = sourceWavTiming(bytes);
        } catch (error) {
          if (target.captureAbort.signal.aborted || !current(target)) throw error;
          bytes = decodedSourceWav(audio);
          timing = { sampleRate: audio.sampleRate, frameCount: audio.length };
          target.sourceNotice = 'Original source WAV could not be read; preserving the native decoded audio as float32 WAV.';
        }
        if (Math.abs(timing.frameCount / timing.sampleRate - audio.duration) > 1 / audio.sampleRate + 0.000001) {
          throw new Error('Source WAV duration does not match the loaded native player.');
        }
        return {
          trackId: native.id, speakerKey: native.id, trackLabel: native.label, audioUrl: native.audioUrl,
          ...timing, sourceSha256: await audioSha256(bytes),
          original: bytes, originalBlob: new Blob([bytes], { type: 'audio/wav' })
        };
      }));
      if (!enabled || !current(target)) return;
      target.tracks = tracks;
      target.selected = { strength: 0, variantKey: '', tracks: tracks.map(track => ({ bytes: track.original, blob: track.originalBlob })) };
      for (const track of tracks) {
        const wave = snapshot.tracks.find(item => item.id === track.trackId)?.wave;
        if (!wave) throw new Error('The native source player was replaced during capture.');
        const patch = patchWave(target, track, wave);
        patch.strength = 0; patch.decoded = wave.getDecodedData();
      }
      publish({ status: 'processing', message: `Preparing ZipEnhancer for both tracks… ${target.sourceNotice}`.trim() });
      window.postMessage({ source: AUDIO_ENHANCEMENT_EVENT_SOURCE, type: 'sources-ready',
        sessionId: target.id, taskId: target.taskId,
        tracks: tracks.map(({ trackId, speakerKey, trackLabel, sourceSha256, sampleRate, frameCount }) =>
          ({ trackId, speakerKey, trackLabel, sourceSha256, sampleRate, frameCount })) }, window.location.origin);
    } catch (error) {
      if (current(target)) publish({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      target.capturing = false;
    }
  }

  function tick(): void {
    if (disposed || !enabled) return;
    const snapshot = nativeSnapshot();
    if (!snapshot) {
      if (session) { release(session); session = null; publish({ taskId: '', strength: 0, desiredStrength: 100, status: 'idle', variantKey: '', message: '' }); }
      return;
    }
    if (!session || session.key !== snapshot.key) {
      if (session) release(session);
      session = { id: crypto.randomUUID(), key: snapshot.key, taskId: snapshot.taskId,
        tracks: [], capturing: false, captureAbort: new AbortController(), model: '', variantKey: '', sourceNotice: '',
        patches: new Map(), regionAddPatches: new Map(), switching: false };
      publish({ taskId: session.taskId, strength: 0, desiredStrength: 100, status: 'idle', variantKey: '', model: '', message: 'Waiting for both source tracks…' });
    }
    const target = session;
    if (!target.tracks.length && state.status !== 'error') { void capture(target, snapshot); return; }
    if (target.switching || !target.tracks.length) return;
    const live = new Set(snapshot.tracks.map(track => track.wave));
    for (const [wave, patch] of target.patches) {
      if (!live.has(wave)) {
        if (wave.load === patch.wrappedLoad) wave.load = patch.load;
        if (wave.loadBlob === patch.wrappedLoadBlob) wave.loadBlob = patch.loadBlob;
        for (const unbind of patch.unbind) unbind();
        target.patches.delete(wave);
      }
    }
    for (const track of target.tracks) {
      const wave = snapshot.tracks.find(item => item.id === track.trackId)?.wave;
      if (!wave) continue;
      const patch = patchWave(target, track, wave);
      if (wave.getDecodedData()?.length && (patch.strength !== state.strength || patch.decoded !== wave.getDecodedData())) {
        // Retained originals are never replaced by a remounted enhanced buffer.
        void queueSwitch(target, true);
        break;
      }
    }
  }

  async function setEnabled(value: boolean): Promise<void> {
    if (disposed || value && disposing) return;
    enabled = value;
    if (value) {
      if (!fetchInstalled) { window.fetch = selectedFetch; fetchInstalled = true; }
      if (poll === null) poll = window.setInterval(tick, 350);
      tick();
      return;
    }
    if (poll !== null) { window.clearInterval(poll); poll = null; }
    const target = session;
    target?.captureAbort.abort();
    if (window.fetch === selectedFetch) window.fetch = nativeFetch;
    fetchInstalled = false;
    if (target && current(target)) {
      publish({ desiredStrength: 0, progress: undefined });
      await queueSwitch(target);
    }
    if (target && current(target)) {
      const snapshot = nativeSnapshot();
      const restored = state.strength === 0 && snapshot?.tracks.every(native => {
        const patch = native.wave ? target.patches.get(native.wave) : undefined;
        return patch?.strength === 0 && patch.decoded === native.wave?.getDecodedData();
      });
      if (!restored && target.tracks.length) await replaceSources(target, 0, true);
      const finalSnapshot = nativeSnapshot();
      const originalLoaded = state.strength === 0 && finalSnapshot?.tracks.every(native => {
        const patch = native.wave ? target.patches.get(native.wave) : undefined;
        return patch?.strength === 0 && patch.decoded === native.wave?.getDecodedData();
      });
      if (target.tracks.length && !originalLoaded) {
        for (const native of finalSnapshot?.tracks || []) native.wave?.pause?.();
        publish({ status: 'error', desiredStrength: 0, message: 'Original audio restoration failed. Playback remains paused and the last committed selection is retained.' });
        return;
      }
    }
    if (session === target) {
      if (target) release(target);
      session = null;
      publish({ taskId: nativeSnapshot()?.taskId || '', strength: 0, desiredStrength: 0, status: 'idle', variantKey: '', message: '' });
    }
  }

  function selectStrength(strength: number): Promise<void> {
    if (!enabled || disposing || disposed) return Promise.resolve();
    if (!isAudioEnhancementStrength(strength)) return Promise.reject(new Error('Invalid audio strength.'));
    publish({ desiredStrength: strength });
    return session ? queueSwitch(session) : Promise.resolve();
  }

  function getActiveAudio(requestId: string, taskId: string, selection = 'active'): ActiveAudioResponse {
    const target = session;
    const strength = selection === 'original' ? 0 : state.strength;
    const snapshot = nativeSnapshot();
    const available = Boolean(!disposing && !disposed && target && current(target, snapshot) && target.taskId === taskId && target.tracks.length === 2 &&
      (selection === 'original' || (!target.switching && (state.desiredStrength === state.strength || state.status === 'error') &&
        target.selected?.strength === state.strength && snapshot?.tracks.every(native => {
          const patch = native.wave ? target.patches.get(native.wave) : undefined;
          return patch?.strength === state.strength && patch.decoded === native.wave?.getDecodedData();
        }))));
    return {
      type: AUDIO_ENHANCEMENT_ACTIVE_RESPONSE, version: AUDIO_ENHANCEMENT_PROTOCOL_VERSION,
      requestId, taskId, available, strength, variantKey: selection === 'original' ? '' : state.variantKey,
      tracks: available && target ? target.tracks.map((track, index) => ({ trackId: track.trackId, speakerKey: track.speakerKey,
        trackLabel: track.trackLabel, mimeType: 'audio/wav', bytes: (selection === 'original' ? track.original : target.selected!.tracks[index].bytes).slice(0) })) : []
    };
  }

  async function handleCommand(event: MessageEvent<unknown>): Promise<void> {
    if (disposing || disposed) return;
    if (event.source !== window || event.origin !== window.location.origin || typeof event.data !== 'object' || event.data === null) return;
    const data = event.data as EnhancementBridgeMessage;
    if (data.type === AUDIO_ENHANCEMENT_ACTIVE_REQUEST && data.version === AUDIO_ENHANCEMENT_PROTOCOL_VERSION &&
        typeof data.requestId === 'string' && typeof data.taskId === 'string') {
      const response = getActiveAudio(data.requestId, data.taskId, data.selection === 'original' ? 'original' : 'active');
      window.postMessage(response, window.location.origin, response.tracks.map(track => track.bytes));
      return;
    }
    if (data.source !== AUDIO_ENHANCEMENT_COMMAND_SOURCE) return;
    if (data.type === 'enable') { await setEnabled(true); return; }
    if (data.type === 'dispose') {
      try { await dispose(); }
      finally {
        window.postMessage({ source: AUDIO_ENHANCEMENT_EVENT_SOURCE, type: 'disabled', requestId: data.requestId }, window.location.origin);
      }
      return;
    }
    const target = session;
    if (!target || data.sessionId !== target.id || data.taskId !== target.taskId || !current(target)) return;
    if (data.type === 'select-strength' && isAudioEnhancementStrength(data.strength)) { await selectStrength(data.strength); return; }
    if (!enabled) return;
    if (data.type === 'progress' && !target.variantKey && state.status !== 'error') {
      if ((data.message !== undefined && typeof data.message !== 'string') ||
          (data.progress !== undefined && (!isAudioEnhancementProgress(data.progress) ||
            data.progress.trackCount !== target.tracks.length ||
            target.tracks[data.progress.trackIndex]?.trackId !== data.progress.trackId))) {
        publish({ status: 'error', message: 'Gold Drafting returned invalid native enhancement progress.' });
        return;
      }
      publish({ status: target.switching ? 'switching' : 'processing',
        ...(data.progress !== undefined ? { progress: data.progress } : {}),
        message: data.message || 'Enhancing audio locally…' });
      return;
    }
    if (data.type === 'error' && !target.variantKey) {
      publish({ status: 'error', message: typeof data.message === 'string' && data.message
        ? data.message : 'Audio enhancement failed; original audio remains selected.' });
      return;
    }
    if (state.status === 'error' || target.variantKey || data.type !== 'install' || !Array.isArray(data.tracks) || data.tracks.length !== 2 ||
        typeof data.variantKey !== 'string' || !/^[a-f0-9]{64}$/.test(data.variantKey)) return;
    publish({ status: 'processing', message: 'Verifying transferred enhanced audio before native loading…' });
    try {
      if (!isEnhancementCacheMetadata(data)) throw new Error('Enhanced output cache metadata is invalid.');
      const tracks: unknown[] = data.tracks;
      if (!tracks.every(isEnhancementInstalledTrack)) throw new Error('Enhanced output metadata is invalid.');
      if (new Set(tracks.map(track => track.trackId)).size !== 2) throw new Error('Enhanced track IDs are duplicated.');
      for (const source of target.tracks) {
        const output = tracks.find(track => track.trackId === source.trackId);
        if (!output || !(output.bytes instanceof ArrayBuffer) || output.sourceSha256 !== source.sourceSha256 ||
            output.sampleRate !== source.sampleRate || output.frameCount !== source.frameCount) throw new Error('Enhanced output does not match the native source tracks.');
        validateEnhancementWav(output.bytes, source.sampleRate, source.frameCount);
        if (await audioSha256(output.bytes) !== output.wavSha256) throw new Error('Enhanced output checksum mismatch.');
      }
      if (!enabled || !current(target)) return;
      for (const source of target.tracks) {
        const output = tracks.find(track => track.trackId === source.trackId)!;
        source.enhanced = output.bytes; source.enhancedBlob = new Blob([output.bytes], { type: 'audio/wav' });
      }
      target.variantKey = data.variantKey; target.model = String(data.model || 'ZipEnhancer');
      target.cache = { cacheStatus: data.cacheStatus, cacheMessage: data.cacheMessage };
      publish({ status: 'processing', model: target.model, message: state.desiredStrength > 0
        ? 'Preparing selected audio for native players…' : 'Enhanced audio available; retaining original selection…' });
      await queueSwitch(target);
    } catch (error) {
      if (current(target)) publish({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  // BabelMods is installed by the MAIN-world host before this service is injected.
  const hostPage = page as Window & { BabelMods?: BabelModsHost };
  const serviceValue = hostPage.BabelMods?.unsafe?.services;
  if (!serviceValue || typeof serviceValue !== 'object' || !('provide' in serviceValue) ||
      typeof serviceValue.provide !== 'function') throw new Error('BabelMods page service registry is unavailable');
  // The host exposes its concrete service registry through a generic unsafe namespace.
  const registry = serviceValue as ServiceRegistry<Record<string, object>>;
  const registrationOptions: { owner: string; priority?: number } = { owner: 'builtin:audio-enhancement' };
  const provider = registry.provide('page.audio-enhancement', {
    getState: () => ({ ...state }), getActiveAudio, selectStrength, setEnabled
  }, registrationOptions);
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposing = true;
    window.removeEventListener('message', listener);
    window.removeEventListener('babel-helper-bridge-teardown', teardown);
    provider.dispose();
    if (page.__babelHelperAudioEnhancementBridge === facade) delete page.__babelHelperAudioEnhancementBridge;
    delete page.__babelHelperAudioEnhancementRevision;
    document.documentElement.removeAttribute(AUDIO_ENHANCEMENT_STATE_ATTRIBUTE);
    disposal = (async () => {
      try {
        await setEnabled(false);
      } finally {
        if (session) release(session);
        session = null;
        disposed = true;
        if (window.fetch === selectedFetch) window.fetch = nativeFetch;
      }
    })();
    return disposal;
  }
  const listener = (event: MessageEvent<unknown>) => { void handleCommand(event).catch(error => {
    if (session) publish({ status: 'error', message: error instanceof Error ? error.message : String(error) });
  }); };
  const teardown = () => { void dispose(); };
  const facade = { getState: () => ({ ...state }), getActiveAudio, selectStrength, setEnabled, dispose };
  page.__babelHelperAudioEnhancementBridge = facade;
  window.addEventListener('message', listener);
  window.addEventListener('babel-helper-bridge-teardown', teardown);
}

// A revoked, removed injection must not leave a late MAIN-world bridge behind.
if (document.currentScript?.isConnected) initAudioEnhancementBridge();
