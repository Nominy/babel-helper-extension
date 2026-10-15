export interface MixedAudioTrack {
  bytes: ArrayBuffer;
  blob: Blob;
}

export type AudioWorkerRequest =
  | { id: number; type: 'mix'; strength: number; tracks: { original: Blob; enhanced: Blob }[] }
  | { id: number; type: 'encode'; sampleRate: number; channels: Float32Array[] };

export type AudioWorkerResponse =
  | { id: number; type: 'mix'; tracks: MixedAudioTrack[] }
  | { id: number; type: 'encode'; bytes: ArrayBuffer }
  | { id: number; type: 'error'; message: string };
