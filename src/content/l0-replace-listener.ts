import {
  replaceTranscriptSegmentation,
  type ReplacementResponse
} from '../services/l0-transcript-replacement-service';

type TranscriptHelper = Parameters<typeof replaceTranscriptSegmentation>[0];
type ProtocolWindow = Pick<Window, 'addEventListener' | 'removeEventListener' | 'postMessage'>;

const REQUEST_TYPE = 'babel-gold-drafting:l0-replace-request';
const listeners = new WeakMap<ProtocolWindow, () => void>();

export function registerL0ReplaceListener(
  helper: TranscriptHelper,
  suppliedWindow?: ProtocolWindow
): () => void {
  const protocolWindow =
    suppliedWindow ?? (typeof window === 'undefined' ? null : window);
  if (!protocolWindow) return () => undefined;
  listeners.get(protocolWindow)?.();

  let disposed = false;
  let mutationQueue: Promise<unknown> = Promise.resolve();
  const onMessage = (event: MessageEvent) => {
    if (disposed || event.source !== protocolWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.type !== REQUEST_TYPE) return;

    mutationQueue = mutationQueue
      .catch(() => undefined)
      .then(async () => {
        let result: ReplacementResponse;
        try {
          result = await replaceTranscriptSegmentation(helper, data);
        } catch (error) {
          result = {
            type: 'babel-gold-drafting:l0-replace-response',
            version: 1,
            requestId: typeof data.requestId === 'string' ? data.requestId : '',
            ok: false,
            reason: 'internal-error',
            message: error instanceof Error ? error.message : 'Unexpected transcript replacement failure.'
          };
        }
        protocolWindow.postMessage(result, '*');
      });
  };

  protocolWindow.addEventListener('message', onMessage as EventListener);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    protocolWindow.removeEventListener('message', onMessage as EventListener);
    if (listeners.get(protocolWindow) === dispose) listeners.delete(protocolWindow);
  };
  listeners.set(protocolWindow, dispose);
  return dispose;
}
