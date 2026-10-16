import { readAudioEnhancementState } from '@nominy/babel-babel-runtime';
import { themeRoot, applyComponent } from '@nominy/babel-extension-frontend';
import type {
  L0TimingIndex,
  L0WordTimingToken,
  L0WordTimingTrack
} from '../services/l0-word-timing-alignment';
import { freezePublishedL0TimingIndex } from '../services/l0-word-timing-alignment';
import { buildCurrentL0TimingTaskId } from '../services/l0-timing-identity';

export { buildL0TimingTaskId } from '../services/l0-timing-identity';

const UPDATE_TYPE = 'babel-gold-drafting:l0-timing-update';

type TimingState = {
  l0TimingIndex: L0TimingIndex | null;
  l0TimingPairKey?: string | null;
  l0TimingCache?: {
    scopeId: string;
    original: L0TimingIndex | null;
    enhanced: L0TimingIndex | null;
    enhancedPairKey?: string;
    playback?: L0TimingIndex;
  } | null;
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
  return freezePublishedL0TimingIndex({ taskId: message.taskId.trim(), tracks });
}

function timingIdentity(taskId: string): { scopeId: string; baseTaskId: string; variantKey: string } | null {
  try {
    const { audioVariantKey, ...scope } = JSON.parse(taskId) as Record<string, unknown>;
    if (scope.version !== 1 || typeof scope.baseTaskId !== 'string' ||
        !Array.isArray(scope.stableLaneIds) || !scope.stableLaneIds.every((lane) => typeof lane === 'string') ||
        (audioVariantKey !== undefined && (typeof audioVariantKey !== 'string' || !audioVariantKey))) return null;
    return { scopeId: JSON.stringify(scope), baseTaskId: scope.baseTaskId,
      variantKey: typeof audioVariantKey === 'string' ? audioVariantKey : '' };
  } catch {
    return null;
  }
}

function selectTimingIndex(state: TimingState, taskId: string): L0TimingIndex | null {
  const active = state.l0TimingIndex;
  const retained = state.l0TimingCache;
  if (active?.taskId === taskId && (retained?.original === active || retained?.enhanced === active)) return active;
  const selected = timingIdentity(taskId);
  if (!selected) {
    state.l0TimingIndex = null;
    state.l0TimingCache = null;
    state.l0TimingPairKey = null;
    return null;
  }
  // Shared across separately bundled listener/cursor modules. Retain Original
  // and one latest nonzero-strength timing set, bound to the verified full pair.
  let cache = state.l0TimingCache;
  if (!cache || cache.scopeId !== selected.scopeId) {
    cache = state.l0TimingCache = { scopeId: selected.scopeId, original: null, enhanced: null };
  }
  const audio = readAudioEnhancementState();
  const pairKey = audio?.taskId === selected.baseTaskId ? audio.pairedVariantKey : undefined;
  const previous = state.l0TimingIndex;
  if (previous) {
    const identity = timingIdentity(previous.taskId);
    if (identity?.scopeId === selected.scopeId) {
      const slot = identity.variantKey ? 'enhanced' : 'original';
      if (cache[slot] !== previous) delete cache.playback;
      cache[slot] = previous;
      if (identity.variantKey) {
        cache.enhancedPairKey = state.l0TimingPairKey || (identity.variantKey === pairKey ? pairKey : undefined);
      }
    }
  }
  if (selected.variantKey && cache.enhanced?.taskId !== taskId &&
      (!pairKey || cache.enhancedPairKey !== pairKey)) {
    cache.enhanced = null;
    delete cache.enhancedPairKey;
    delete cache.playback;
  }
  const index = cache[selected.variantKey ? 'enhanced' : 'original'];
  state.l0TimingIndex = index?.taskId === taskId ? index : null;
  state.l0TimingPairKey = state.l0TimingIndex && selected.variantKey ? cache.enhancedPairKey || null : null;
  return state.l0TimingIndex;
}

export function getCurrentL0TimingIndex(
  state: TimingState,
  helper: TimingIdentityHelper,
  suppliedLocation?: TaskLocation
): L0TimingIndex | null {
  return selectTimingIndex(state, buildCurrentL0TimingTaskId(helper, suppliedLocation));
}

/**
 * Verified clock view for playback and exact-boundary text allocation (including
 * smart split). ASR/inference lookup remains source-specific via getCurrentL0TimingIndex.
 * Reusing a paired clock never publishes donor tokens as selected-source inference.
 */
export function getCurrentL0PlaybackTimingIndex(
  state: TimingState,
  helper: TimingIdentityHelper,
  suppliedLocation?: TaskLocation
): L0TimingIndex | null {
  const taskId = buildCurrentL0TimingTaskId(helper, suppliedLocation);
  const own = selectTimingIndex(state, taskId);
  const audio = readAudioEnhancementState();
  const sourceIdentity = timingIdentity(taskId);
  if (audio && audio.taskId === sourceIdentity?.baseTaskId &&
      (audio.status === 'switching' ||
       audio.desiredStrength !== audio.strength && audio.status !== 'error')) return null;
  if (own) return own;
  const cache = state.l0TimingCache;
  if (!audio?.pairedVariantKey || audio.status !== 'ready' || !cache) return null;
  if (sourceIdentity?.baseTaskId !== audio.taskId) return null;
  const donor = cache.enhanced && cache.enhancedPairKey === audio.pairedVariantKey
    ? cache.enhanced : audio.strength > 0 ? cache.original : null;
  if (!donor) return null;
  // A clock-only view maps the same word clocks to the selected lane identity.
  // It never publishes or stores these pins as newly inferred timing for that source.
  if (cache.playback?.taskId !== taskId || cache.playback.tracks !== donor.tracks) {
    cache.playback = Object.freeze({ taskId, tracks: donor.tracks });
  }
  return cache.playback;
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
  themeRoot(notification, 'white');
  applyComponent(notification, 'toast', { tone: 'success' });
  notification.setAttribute('role', 'status');
  notification.setAttribute('aria-live', 'polite');
  notification.textContent = 'Timestamped transcription ready';
  notification.style.position = 'fixed';
  notification.style.right = '18px';
  notification.style.bottom = '18px';
  notification.style.padding = '7px 10px';


  notification.style.pointerEvents = 'none';
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
  selectTimingIndex(state, currentTaskId());

  let disposed = false;
  const onMessage = (event: MessageEvent) => {
    if (disposed || event.source !== protocolWindow) return;
    const update = parseL0TimingUpdate(event.data);
    if (!update) return;

    const expectedTaskId = currentTaskId();
    selectTimingIndex(state, expectedTaskId);
    if (update.taskId !== expectedTaskId) {
      const incoming = timingIdentity(update.taskId);
      const selected = timingIdentity(expectedTaskId);
      // Startup Original inference remains valid if Generate or a mix switch
      // finishes first. Retain its real source identity, even during processing;
      // only the clock lookup may share timings after pair verification.
      if (!incoming || incoming.variantKey || incoming.scopeId !== selected?.scopeId || !state.l0TimingCache) return;
      state.l0TimingCache.original = update;
      delete state.l0TimingCache.playback;
      return;
    }

    state.l0TimingIndex = update;
    const audio = readAudioEnhancementState();
    state.l0TimingPairKey = audio && audio.taskId === timingIdentity(update.taskId)?.baseTaskId
      ? audio.pairedVariantKey || null : null;
    selectTimingIndex(state, expectedTaskId);
    showL0TimingReadyNotification();
  };

  protocolWindow.addEventListener('message', onMessage as EventListener);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    protocolWindow.removeEventListener('message', onMessage as EventListener);
    state.l0TimingIndex = null;
    state.l0TimingPairKey = null;
    state.l0TimingCache = null;
    if (listeners.get(protocolWindow) === dispose) listeners.delete(protocolWindow);
  };
  listeners.set(protocolWindow, dispose);
  return dispose;
}
