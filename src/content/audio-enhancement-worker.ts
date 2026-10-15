import { mixEnhancementWav } from './audio-enhancement-mix';
import type { AudioWorkerRequest, AudioWorkerResponse, MixedAudioTrack } from './audio-enhancement-worker-protocol';

const scope = globalThis as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<AudioWorkerRequest>) => void): void;
  postMessage(message: AudioWorkerResponse, transfer: ArrayBuffer[]): void;
};

/** Only native decoded channel copies enter here; native AudioBuffers never transfer. */
function encodeDecodedWav(sampleRate: number, channels: Float32Array[]): ArrayBuffer {
  const frames = channels[0]?.length ?? 0;
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || !frames ||
      channels.length > 65535 || channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames)) {
    throw new Error('Native decoded audio has an invalid source clock or channels.');
  }
  const bytes = new ArrayBuffer(44 + frames * channels.length * 4);
  const view = new DataView(bytes);
  view.setUint32(0, 0x52494646, false); view.setUint32(4, bytes.byteLength - 8, true);
  view.setUint32(8, 0x57415645, false); view.setUint32(12, 0x666d7420, false); view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channels.length * 4, true);
  view.setUint16(32, channels.length * 4, true); view.setUint16(34, 32, true);
  view.setUint32(36, 0x64617461, false); view.setUint32(40, frames * channels.length * 4, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of channels) {
      view.setFloat32(offset, channel[frame], true);
      offset += 4;
    }
  }
  return bytes;
}

async function handle(request: AudioWorkerRequest): Promise<void> {
  try {
    if (request.type === 'encode') {
      const bytes = encodeDecodedWav(request.sampleRate, request.channels);
      scope.postMessage({ id: request.id, type: 'encode', bytes }, [bytes]);
      return;
    }
    if (request.type !== 'mix' || request.tracks.length !== 2 ||
        !Number.isInteger(request.strength) || request.strength <= 0 || request.strength >= 100) {
      throw new Error('Audio worker received an invalid paired mix request.');
    }
    const tracks: MixedAudioTrack[] = [];
    // Blobs are immutable structured-clone references. Read one lane at a time
    // here, not on the UI thread, and retain no extra endpoint cache afterwards.
    for (const track of request.tracks) {
      const [original, enhanced] = await Promise.all([track.original.arrayBuffer(), track.enhanced.arrayBuffer()]);
      const bytes = mixEnhancementWav(original, enhanced, request.strength);
      tracks.push({ bytes, blob: new Blob([bytes], { type: 'audio/wav' }) });
    }
    scope.postMessage({ id: request.id, type: 'mix', tracks }, tracks.map(track => track.bytes));
  } catch (error) {
    scope.postMessage({ id: request.id, type: 'error', message: error instanceof Error ? error.message : String(error) }, []);
  }
}

scope.addEventListener('message', event => { void handle(event.data); });
