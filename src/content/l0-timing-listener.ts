import type {
  L0TimingIndex,
  L0WordTimingToken,
  L0WordTimingTrack
} from '../services/l0-word-timing-alignment';
import { buildCurrentL0TimingTaskId } from '../services/l0-timing-identity';

export { buildL0TimingTaskId } from '../services/l0-timing-identity';

const UPDATE_TYPE = 'babel-gold-drafting:l0-timing-update';

type TimingState = {
  l0TimingIndex: L0TimingIndex | null;
};

type ProtocolWindow = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type TaskLocation = Pick<Location, 'pathname' | 'search'>;
type TimingIdentityHelper = Parameters<typeof buildCurrentL0TimingTaskId>[0];

const listeners = new WeakMap<ProtocolWindow, () => void>();


function parseTimingToken(value: unknown): L0WordTimingToken | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const token = value as Record<string, unknown>;
  if (
    typeof token.id !== 'string' ||
    !token.id.trim() ||
    typeof token.text !== 'string' ||
    !token.text.trim() ||
    typeof token.startSeconds !== 'number' ||
    !Number.isFinite(token.startSeconds) ||
    token.startSeconds < 0 ||
    typeof token.endSeconds !== 'number' ||
    !Number.isFinite(token.endSeconds) ||
    token.endSeconds <= token.startSeconds
  ) {
    return null;
  }
  return {
    id: token.id.trim(),
    text: token.text,
    startSeconds: token.startSeconds,
    endSeconds: token.endSeconds
  };
}

function parseTimingTrack(value: unknown): L0WordTimingTrack | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const track = value as Record<string, unknown>;
  if (typeof track.lane !== 'string' || !track.lane.trim() || !Array.isArray(track.tokens)) return null;
  const tokens: L0WordTimingToken[] = [];
  for (const value of track.tokens) {
    const token = parseTimingToken(value);
    if (!token) return null;
    tokens.push(token);
  }
  return { lane: track.lane.trim(), tokens };
}

export function parseL0TimingUpdate(value: unknown): L0TimingIndex | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (
    message.type !== UPDATE_TYPE ||
    message.version !== 1 ||
    typeof message.taskId !== 'string' ||
    !message.taskId.trim() ||
    !Array.isArray(message.tracks) ||
    message.tracks.length < 1
  ) {
    return null;
  }

  const tracks: L0WordTimingTrack[] = [];
  const lanes = new Set<string>();
  for (const value of message.tracks) {
    const track = parseTimingTrack(value);
    const laneKey = track?.lane.toLocaleLowerCase();
    if (!track || !laneKey || lanes.has(laneKey)) return null;
    lanes.add(laneKey);
    tracks.push(track);
  }
  return { taskId: message.taskId.trim(), tracks };
}

export function getCurrentL0TimingIndex(
  state: TimingState,
  helper: TimingIdentityHelper,
  suppliedLocation?: TaskLocation
): L0TimingIndex | null {
  const index = state.l0TimingIndex;
  if (!index) return null;
  const currentTaskId = buildCurrentL0TimingTaskId(helper, suppliedLocation);
  if (index.taskId !== currentTaskId) {
    state.l0TimingIndex = null;
    return null;
  }
  return index;
}

export function showL0TimingReadyNotification(
  suppliedDocument?: Document,
  schedule: (callback: () => void, delayMs: number) => unknown = setTimeout
): HTMLElement | null {
  const targetDocument =
    suppliedDocument ?? (typeof document === 'undefined' ? null : document);
  const parent = targetDocument?.body ?? targetDocument?.documentElement;
  if (!targetDocument || !parent) return null;

  targetDocument
    .querySelector('[data-babel-helper-l0-timing-ready]')
    ?.remove();
  const notification = targetDocument.createElement('div');
  notification.setAttribute('data-babel-helper-l0-timing-ready', '');
  notification.setAttribute('role', 'status');
  notification.setAttribute('aria-live', 'polite');
  notification.textContent = 'Timestamped transcription ready';
  notification.style.position = 'fixed';
  notification.style.right = '18px';
  notification.style.bottom = '18px';
  notification.style.padding = '7px 10px';
  notification.style.borderRadius = '7px';
  notification.style.background = 'rgba(15, 23, 42, 0.92)';
  notification.style.color = '#f8fafc';
  notification.style.font = '600 12px/1.3 system-ui, sans-serif';
  notification.style.boxShadow = '0 6px 18px rgba(15, 23, 42, 0.2)';
  notification.style.pointerEvents = 'none';
  notification.style.zIndex = '2147483647';
  notification.style.opacity = '1';
  notification.style.transition = 'opacity 120ms ease';
  parent.appendChild(notification);

  schedule(() => {
    notification.style.opacity = '0';
  }, 630);
  schedule(() => {
    notification.remove();
  }, 750);
  return notification;
}

export function registerL0TimingListener(
  state: TimingState,
  helper: TimingIdentityHelper,
  suppliedWindow?: ProtocolWindow,
  suppliedLocation?: TaskLocation
): () => void {
  const protocolWindow =
    suppliedWindow ?? (typeof window === 'undefined' ? null : window);
  if (!protocolWindow) return () => undefined;
  listeners.get(protocolWindow)?.();

  const currentTaskId = () => buildCurrentL0TimingTaskId(helper, suppliedLocation);
  if (state.l0TimingIndex && state.l0TimingIndex.taskId !== currentTaskId()) {
    state.l0TimingIndex = null;
  }

  let disposed = false;
  const onMessage = (event: MessageEvent) => {
    if (disposed || event.source !== protocolWindow) return;
    const update = parseL0TimingUpdate(event.data);
    if (!update) return;

    const expectedTaskId = currentTaskId();
    if (state.l0TimingIndex && state.l0TimingIndex.taskId !== expectedTaskId) {
      state.l0TimingIndex = null;
    }
    if (update.taskId !== expectedTaskId) return;

    state.l0TimingIndex = update;
    showL0TimingReadyNotification();
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
