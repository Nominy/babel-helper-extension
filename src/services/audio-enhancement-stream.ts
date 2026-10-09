import { AUDIO_ENHANCEMENT_PROTOCOL_VERSION, isAudioEnhancementProgress, isAudioEnhancementStrength } from '@nominy/babel-babel-runtime';
import type {
  AudioEnhancementChunk, AudioEnhancementTrackMetadata, AudioEnhancementResult, AudioEnhancementState
} from '@nominy/babel-babel-runtime';

export const AUDIO_ENHANCEMENT_COMMAND_SOURCE = 'babel-helper-audio-enhancement-command';
export const AUDIO_ENHANCEMENT_EVENT_SOURCE = 'babel-helper-audio-enhancement-event';
const CHUNK_BYTES = 512 * 1024;
const MAX_TRACK_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface EnhancementSourceTrack {
  trackId: string;
  speakerKey: string;
  trackLabel: string;
  sourceSha256: string;
  sampleRate: number;
  frameCount: number;
}
export interface EnhancementInstalledTrack extends AudioEnhancementTrackMetadata {
  bytes: ArrayBuffer;
}

export type EnhancementCacheMetadata = Pick<AudioEnhancementResult, 'cacheStatus' | 'cacheMessage'>;

export function isEnhancementCacheMetadata<Value>(value: Value): value is Value & EnhancementCacheMetadata {
  if (typeof value !== 'object' || value === null) return false;
  const metadata = value as { cacheStatus?: unknown; cacheMessage?: unknown };
  return (metadata.cacheStatus === undefined || metadata.cacheStatus === 'hit' ||
    metadata.cacheStatus === 'stored' || metadata.cacheStatus === 'unavailable') &&
    (metadata.cacheMessage === undefined || typeof metadata.cacheMessage === 'string');
}

export function isEnhancementSourceTrack(value: unknown): value is EnhancementSourceTrack {
  if (typeof value !== 'object' || value === null) return false;
  const track = value as Partial<EnhancementSourceTrack>;
  return typeof track.trackId === 'string' && track.trackId.length > 0 &&
    typeof track.speakerKey === 'string' && typeof track.trackLabel === 'string' &&
    typeof track.sourceSha256 === 'string' && SHA256.test(track.sourceSha256) &&
    typeof track.sampleRate === 'number' && Number.isSafeInteger(track.sampleRate) && track.sampleRate > 0 &&
    typeof track.frameCount === 'number' && Number.isSafeInteger(track.frameCount) && track.frameCount > 0;
}

function isTrackMetadata(value: unknown): value is AudioEnhancementTrackMetadata {
  if (!isEnhancementSourceTrack(value)) return false;
  const track = value as Partial<AudioEnhancementTrackMetadata>;
  return track.mimeType === 'audio/wav' && typeof track.wavSha256 === 'string' && SHA256.test(track.wavSha256) &&
    typeof track.totalBytes === 'number' && Number.isSafeInteger(track.totalBytes) &&
    track.totalBytes >= 44 && track.totalBytes <= MAX_TRACK_BYTES &&
    typeof track.chunkCount === 'number' && track.chunkCount === Math.ceil(track.totalBytes / CHUNK_BYTES);
}

export function isEnhancementInstalledTrack(value: unknown): value is EnhancementInstalledTrack {
  if (!isTrackMetadata(value)) return false;
  const track = value as Partial<EnhancementInstalledTrack>;
  return track.bytes instanceof ArrayBuffer && track.bytes.byteLength === track.totalBytes;
}

export function isAudioEnhancementState(value: unknown): value is AudioEnhancementState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<AudioEnhancementState>;
  return state.version === AUDIO_ENHANCEMENT_PROTOCOL_VERSION && typeof state.taskId === 'string' &&
    typeof state.status === 'string' && ['idle', 'processing', 'ready', 'switching', 'error'].includes(state.status) &&
    isAudioEnhancementStrength(state.strength) &&
    isAudioEnhancementStrength(state.desiredStrength) &&
    typeof state.revision === 'number' && Number.isSafeInteger(state.revision) && state.revision >= 0 &&
    typeof state.variantKey === 'string' && (state.strength === 0 ? state.variantKey === '' : SHA256.test(state.variantKey)) &&
    (state.pairedVariantKey === undefined || typeof state.pairedVariantKey === 'string' && SHA256.test(state.pairedVariantKey)) &&
    (state.message === undefined || typeof state.message === 'string') &&
    (state.model === undefined || typeof state.model === 'string') &&
    (state.progress === undefined || isAudioEnhancementProgress(state.progress));
}

function isEnhancementResult(value: unknown): value is AudioEnhancementResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<AudioEnhancementResult>;
  if (result.ok !== true || (result.provider !== 'browser-local' && result.provider !== 'swarm') ||
      typeof result.taskId !== 'string' || typeof result.model !== 'string' || !result.model ||
      typeof result.modelSha256 !== 'string' || !SHA256.test(result.modelSha256) || !Array.isArray(result.tracks) ||
      !isEnhancementCacheMetadata(result)) return false;
  const tracks: unknown[] = result.tracks;
  return tracks.every(isTrackMetadata);
}

export async function audioSha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

/** Only accepts sequential, bounded chunks for the native source IDs. */
export class AudioEnhancementStreamAssembler {
  private streams = new Map<string, { bytes: Uint8Array; next: number; count: number; written: number }>();
  constructor(private readonly sources: EnhancementSourceTrack[]) {}

  accept(value: unknown): void {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid audio enhancement chunk.');
    const chunk = value as Partial<AudioEnhancementChunk>;
    if (chunk.type !== 'audio-chunk' || typeof chunk.trackId !== 'string' ||
        !this.sources.some(source => source.trackId === chunk.trackId) ||
        typeof chunk.totalBytes !== 'number' || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes < 44 || chunk.totalBytes > MAX_TRACK_BYTES ||
        typeof chunk.chunkCount !== 'number' || !Number.isSafeInteger(chunk.chunkCount) || chunk.chunkCount !== Math.ceil(chunk.totalBytes / CHUNK_BYTES) ||
        typeof chunk.chunkIndex !== 'number' || !Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex >= chunk.chunkCount ||
        typeof chunk.dataBase64 !== 'string') {
      throw new Error('Invalid audio enhancement chunk metadata.');
    }
    let stream = this.streams.get(chunk.trackId);
    if (!stream) {
      if (chunk.chunkIndex !== 0) throw new Error('Audio enhancement stream does not start at chunk zero.');
      stream = { bytes: new Uint8Array(chunk.totalBytes), next: 0, count: chunk.chunkCount, written: 0 };
      this.streams.set(chunk.trackId, stream);
    }
    if (stream.next !== chunk.chunkIndex || stream.count !== chunk.chunkCount || stream.bytes.length !== chunk.totalBytes) {
      throw new Error('Audio enhancement chunks are duplicated, reordered, or inconsistent.');
    }
    const expected = Math.min(CHUNK_BYTES, chunk.totalBytes - stream.written);
    if (chunk.dataBase64.length !== 4 * Math.ceil(expected / 3) ||
        !BASE64.test(chunk.dataBase64)) {
      throw new Error('Audio enhancement chunk encoding or size is invalid.');
    }
    const binary = atob(chunk.dataBase64);
    if (binary.length !== expected) throw new Error('Audio enhancement chunk has an incorrect decoded size.');
    for (let index = 0; index < binary.length; index += 1) stream.bytes[stream.written + index] = binary.charCodeAt(index);
    stream.written += binary.length;
    stream.next += 1;
  }

  async finish(result: unknown, taskId: string): Promise<{
    tracks: EnhancementInstalledTrack[]; variantKey: string;
  } & EnhancementCacheMetadata> {
    if (!isEnhancementResult(result) || result.taskId !== taskId || result.tracks.length !== this.sources.length ||
        new Set(result.tracks.map(track => track.trackId)).size !== this.sources.length) {
      throw new Error('Gold Drafting returned invalid audio enhancement result metadata.');
    }
    const tracks: EnhancementInstalledTrack[] = [];
    for (const source of this.sources) {
      const metadata = result.tracks.find(track => track.trackId === source.trackId);
      const stream = this.streams.get(source.trackId);
      if (!metadata || !stream || stream.next !== stream.count || stream.written !== stream.bytes.length ||
          metadata.chunkCount !== stream.count || metadata.totalBytes !== stream.bytes.length ||
          metadata.mimeType !== 'audio/wav' || metadata.sourceSha256 !== source.sourceSha256 ||
          metadata.sampleRate !== source.sampleRate || metadata.frameCount !== source.frameCount ||
          !SHA256.test(metadata.wavSha256)) {
        throw new Error(`Audio enhancement output is incomplete or does not match source ${source.trackLabel}.`);
      }
      const bytes = stream.bytes.buffer as ArrayBuffer;
      validateEnhancementWav(bytes, metadata.sampleRate, metadata.frameCount);
      if (await audioSha256(bytes) !== metadata.wavSha256) throw new Error('Audio enhancement WAV checksum mismatch.');
      tracks.push({ ...metadata, speakerKey: source.speakerKey, trackLabel: source.trackLabel, bytes });
    }
    const fingerprint = JSON.stringify({
      model: result.modelSha256,
      sources: this.sources.map(source => [source.trackId, source.sourceSha256]).sort((a, b) => a[0].localeCompare(b[0]))
    });
    const variantKey = await audioSha256(new TextEncoder().encode(fingerprint).buffer as ArrayBuffer);
    this.streams.clear();
    return { tracks, variantKey, cacheStatus: result.cacheStatus, cacheMessage: result.cacheMessage };
  }

  dispose(): void {
    this.streams.clear();
  }
}

export function validateEnhancementWav(bytes: ArrayBuffer, sampleRate: number, frameCount: number): void {
  if (bytes.byteLength < 44) throw new Error('Audio enhancement WAV is truncated.');
  const view = new DataView(bytes);
  const text = (offset: number, size: number) => String.fromCharCode(...new Uint8Array(bytes, offset, size));
  if (text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.byteLength) {
    throw new Error('Audio enhancement output is not a complete WAV.');
  }
  let format = false;
  let data = false;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset + 4, true);
    if (offset + 8 + size > bytes.byteLength) throw new Error('Audio enhancement WAV chunk is truncated.');
    const id = text(offset, 4);
    if (id === 'fmt ') {
      if (size < 16 || view.getUint16(offset + 8, true) !== 1 || view.getUint16(offset + 10, true) !== 1 ||
          view.getUint32(offset + 12, true) !== sampleRate || view.getUint16(offset + 20, true) !== 2 ||
          view.getUint16(offset + 22, true) !== 16) throw new Error('Audio enhancement output must preserve source timing as mono PCM16 WAV.');
      format = true;
    }
    if (id === 'data') {
      if (data || size !== frameCount * 2) throw new Error('Audio enhancement WAV frame count mismatch.');
      data = true;
    }
    offset += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error('Audio enhancement WAV is missing audio data or format.');
}
