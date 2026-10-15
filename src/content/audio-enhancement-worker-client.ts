import type { AudioWorkerRequest, AudioWorkerResponse, MixedAudioTrack } from './audio-enhancement-worker-protocol';

type PendingRequest = {
  type: 'mix' | 'encode';
  resolve: (response: AudioWorkerResponse) => void;
  reject: (error: Error) => void;
};

/** One native source session owns this worker and every transferable it returns. */
export class AudioEnhancementWorkerClient {
  private worker: Worker | null = null;
  private bootstrapUrl: string | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private failure: Error | null = null;
  private closed = false;

  constructor(private readonly scriptUrl: string) {}

  private revokeBootstrap(): void {
    if (this.bootstrapUrl) URL.revokeObjectURL(this.bootstrapUrl);
    this.bootstrapUrl = null;
  }

  private stop(error: Error): void {
    if (this.worker) {
      this.worker.removeEventListener('message', this.onMessage);
      this.worker.removeEventListener('error', this.onError);
      this.worker.removeEventListener('messageerror', this.onMessageError);
      this.worker.terminate();
      this.worker = null;
    }
    this.revokeBootstrap();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private fail(error: Error): void {
    this.failure = error;
    this.stop(error);
  }

  private readonly onMessage = (event: MessageEvent<AudioWorkerResponse>): void => {
    const response = event.data;
    const pending = response && this.pending.get(response.id);
    if (!pending) { this.fail(new Error('Audio worker returned an unowned response.')); return; }
    this.revokeBootstrap();
    if (response.type === 'error') {
      this.fail(new Error(response.message));
      return;
    }
    if (response.type !== pending.type ||
        response.type === 'encode' && !(response.bytes instanceof ArrayBuffer) ||
        response.type === 'mix' && (!Array.isArray(response.tracks) || response.tracks.length !== 2 ||
          response.tracks.some(track => !(track.bytes instanceof ArrayBuffer) || !(track.blob instanceof Blob) ||
            track.bytes.byteLength !== track.blob.size))) {
      this.fail(new Error('Audio worker returned invalid source bytes.'));
      return;
    }
    this.pending.delete(response.id);
    pending.resolve(response);
  };

  private readonly onError = (event: ErrorEvent): void => {
    this.fail(new Error(`Audio processing worker failed: ${event.message || 'packaged worker could not start'}`));
  };

  private readonly onMessageError = (): void => {
    this.fail(new Error('Audio processing worker could not transfer its result.'));
  };

  private request(request: AudioWorkerRequest, transfer: ArrayBuffer[] = []): Promise<AudioWorkerResponse> {
    if (this.closed || this.failure) return Promise.reject(this.failure ?? new Error('Audio source session was released.'));
    const { promise, resolve, reject } = Promise.withResolvers<AudioWorkerResponse>();
    this.pending.set(request.id, { type: request.type, resolve, reject });
    try {
      if (!this.worker) {
        if (!this.scriptUrl) throw new Error('Helper cannot locate its packaged audio processing worker.');
        // A page cannot construct a Worker directly from a chrome-extension URL.
        // The owned same-origin bootstrap imports only our packaged WAR script.
        this.bootstrapUrl = URL.createObjectURL(new Blob([`importScripts(${JSON.stringify(this.scriptUrl)});`], { type: 'text/javascript' }));
        this.worker = new Worker(this.bootstrapUrl, { name: 'babel-helper-audio-mix' });
        this.worker.addEventListener('message', this.onMessage);
        this.worker.addEventListener('error', this.onError);
        this.worker.addEventListener('messageerror', this.onMessageError);
      }
      this.worker.postMessage(request, transfer);
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    return promise;
  }

  async mix(tracks: { original: Blob; enhanced: Blob }[], strength: number): Promise<MixedAudioTrack[]> {
    const response = await this.request({ id: ++this.nextId, type: 'mix', strength, tracks });
    if (response.type !== 'mix') throw new Error('Audio worker did not return a paired mix.');
    return response.tracks;
  }

  async encode(audio: AudioBuffer): Promise<ArrayBuffer> {
    // Native WebAudio owns its channel memory: never detach or modify it.
    const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel).slice());
    const response = await this.request({ id: ++this.nextId, type: 'encode', sampleRate: audio.sampleRate, channels },
      channels.map(channel => channel.buffer));
    if (response.type !== 'encode') throw new Error('Audio worker did not serialize the native source.');
    return response.bytes;
  }

  cancelMix(): void {
    for (const request of this.pending.values()) {
      if (request.type !== 'mix') continue;
      // Termination interrupts the CPU loop; an obsolete strength never queues
      // another full WAV behind it. A later explicit selection owns a new worker.
      this.stop(new Error('Audio strength request was superseded.'));
      return;
    }
  }

  dispose(): void {
    this.closed = true;
    this.stop(new Error('Audio source session was released.'));
  }
}
