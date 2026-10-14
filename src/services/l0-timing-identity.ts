import { readAudioEnhancementState } from '@nominy/babel-babel-runtime';
import type { L0TimingIndex, L0WordTimingTrack } from './l0-word-timing-alignment';

const QUERY_TASK_ID_KEYS = ['jobId', 'transcriptionChunkId', 'annotationId', 'id'] as const;
const PAGE_TASK_ID_ATTRIBUTE = 'data-babel-review-action-id';

type TaskLocation = Pick<Location, 'pathname' | 'search'>;

export type L0TimingRowIdentity = {
  reviewActionId?: unknown;
  processedRecordingId?: unknown;
  speakerKey?: unknown;
  trackLabel?: unknown;
  speakerLabel?: unknown;
  lane?: unknown;
};

export type L0TimingLaneAliases = {
  stableId: string;
  fallbackAliases: string[];
};

type TimingIdentityHelper = {
  getTranscriptRows?: () => unknown[];
  getRowIdentity?: (row: unknown) => L0TimingRowIdentity | null | undefined;
  getRowSpeakerKey?: (row: unknown) => unknown;
};

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getPublishedReviewActionId(): string {
  if (typeof document === 'undefined') return '';
  try {
    return trimmedString(document.documentElement?.getAttribute(PAGE_TASK_ID_ATTRIBUTE));
  } catch {
    return '';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}


function getReviewActionIdFromRows(helper: TimingIdentityHelper, rows: readonly unknown[]): string {
  for (const row of rows) {
    const reviewActionId = trimmedString(helper.getRowIdentity?.(row)?.reviewActionId);
    if (reviewActionId) return reviewActionId;
  }
  return '';
}

export function buildL0TimingBaseTaskId(location: TaskLocation): string {
  const search = typeof location.search === 'string' ? location.search : '';
  const params = new URLSearchParams(search);
  for (const key of QUERY_TASK_ID_KEYS) {
    const value = trimmedString(params.get(key));
    if (value) return value;
  }
  const pathname = typeof location.pathname === 'string' ? location.pathname : '';
  return `${pathname}${search}`;
}

export function collectL0TimingStableLaneIds(
  rowIdentities: readonly L0TimingRowIdentity[]
): string[] {
  const identities = Array.isArray(rowIdentities) ? rowIdentities : [];
  const processedRecordingIds = new Set<string>();
  for (const identity of identities) {
    const value = trimmedString(identity?.processedRecordingId);
    if (value) processedRecordingIds.add(value);
  }

  const stableLaneIds = processedRecordingIds.size
    ? processedRecordingIds
    : new Set(
        identities
          .map((identity) => trimmedString(identity?.speakerKey))
          .filter(Boolean)
      );
  return Array.from(stableLaneIds).sort();
}

function getAudioVariantKey(baseTaskId: string): string {
  const state = readAudioEnhancementState();
  return state?.taskId === baseTaskId && state.strength > 0 ? state.variantKey : '';
}

function serializeL0TimingTaskId(
  baseTaskId: string,
  rowIdentities: readonly L0TimingRowIdentity[]
): string {
  const audioVariantKey = getAudioVariantKey(baseTaskId);
  return JSON.stringify({
    version: 1,
    baseTaskId,
    stableLaneIds: collectL0TimingStableLaneIds(rowIdentities),
    ...(audioVariantKey ? { audioVariantKey } : {})
  });
}

export function buildL0TimingTaskId(
  location: TaskLocation,
  rowIdentities: readonly L0TimingRowIdentity[] = []
): string {
  return serializeL0TimingTaskId(buildL0TimingBaseTaskId(location), rowIdentities);
}

function getCurrentL0TimingRows(
  helper: TimingIdentityHelper | null | undefined
): unknown[] {
  if (!helper || typeof helper.getTranscriptRows !== 'function') return [];
  const rows = helper.getTranscriptRows();
  return Array.isArray(rows) ? rows : [];
}

function getL0TimingRowIdentities(
  helper: TimingIdentityHelper,
  rows: readonly unknown[]
): L0TimingRowIdentity[] {
  return rows.map((row) => {
    const identity =
      typeof helper.getRowIdentity === 'function' ? helper.getRowIdentity(row) || {} : {};
    const speakerKey =
      trimmedString(identity.speakerKey) ||
      (typeof helper.getRowSpeakerKey === 'function'
        ? trimmedString(helper.getRowSpeakerKey(row))
        : '');
    return {
      ...identity,
      processedRecordingId: trimmedString(identity.processedRecordingId),
      speakerKey
    };
  });
}

export function getCurrentL0TimingRowIdentities(
  helper: TimingIdentityHelper | null | undefined
): L0TimingRowIdentity[] {
  if (!helper) return [];
  return getL0TimingRowIdentities(helper, getCurrentL0TimingRows(helper));
}

export function buildCurrentL0TimingTaskId(
  helper: TimingIdentityHelper | null | undefined,
  suppliedLocation?: TaskLocation
): string {
  const currentLocation =
    suppliedLocation ?? (typeof location === 'undefined' ? { pathname: '', search: '' } : location);
  const rows = getCurrentL0TimingRows(helper);
  const scopedTaskId =
    getPublishedReviewActionId()
    || (helper && getReviewActionIdFromRows(helper, rows))
    || '';
  const baseTaskId = scopedTaskId || buildL0TimingBaseTaskId(currentLocation);
  const rowIdentities = scopedTaskId || !helper ? [] : getL0TimingRowIdentities(helper, rows);
  return serializeL0TimingTaskId(baseTaskId, rowIdentities);
}

/**
 * Captures the task identity that a mutation sequence starts on and returns a
 * predicate that can require a known starting review action for bulk replacement.
 * Single-row bridge retries also work without Gold's publication. Once captured, a
 * temporarily absent publication is allowed while rows remount, but a new
 * review action or pathname stops all further mutations.
 *
 * World boundary: this runs in the isolated content-script world, where page
 * React's `__reactFiber$` expandos are invisible, so the only identity sources
 * are `location.pathname` and Gold's published `data-babel-review-action-id`.
 */
export function captureL0TaskGuard({ requireIdentity = false, includeAudioVariant = false } = {}): () => boolean {
  const pathname = typeof location === 'undefined' ? '' : trimmedString(location.pathname);
  const reviewActionId = getPublishedReviewActionId();
  const audioVariantKey = includeAudioVariant ? getAudioVariantKey(reviewActionId) : '';
  return () => {
    const currentPathname =
      typeof location === 'undefined' ? '' : trimmedString(location.pathname);
    if (currentPathname !== pathname) return false;
    if (!reviewActionId) return !requireIdentity;
    const current = getPublishedReviewActionId();
    if (current && current !== reviewActionId) return false;
    if (includeAudioVariant) {
      const state = readAudioEnhancementState();
      if (getAudioVariantKey(reviewActionId) !== audioVariantKey) return false;
      if (state?.taskId === reviewActionId && (state.status === 'switching' ||
          state.desiredStrength !== state.strength && state.status !== 'error')) return false;
    }
    return true;
  };
}

export function buildL0TimingLaneAliases(
  identity: L0TimingRowIdentity | null | undefined,
  displayAliases: readonly unknown[] = []
): L0TimingLaneAliases {
  const stableId = trimmedString(identity?.processedRecordingId);
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [
    identity?.speakerKey,
    identity?.trackLabel,
    identity?.speakerLabel,
    identity?.lane,
    ...displayAliases
  ]) {
    const alias = trimmedString(candidate);
    const key = alias.toLocaleLowerCase();
    if (!alias || alias === stableId || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return { stableId, fallbackAliases: aliases };
}

function getLaneMatchKeys(value: unknown): string[] {
  const lane = trimmedString(value);
  if (!lane) return [];
  const keys = [lane.toLocaleLowerCase()];
  const speakerMatch = lane.match(/\bspeaker\s*(\d+)\b/i);
  if (speakerMatch) keys.push(`speaker:${speakerMatch[1]}`);
  return keys;
}

function matchingTracks(
  timingIndex: L0TimingIndex,
  predicate: (track: L0WordTimingTrack) => boolean
): L0WordTimingTrack[] {
  if (!timingIndex || !Array.isArray(timingIndex.tracks)) return [];
  return timingIndex.tracks.filter(
    (track): track is L0WordTimingTrack =>
      Boolean(track && typeof track.lane === 'string' && track.lane.trim()) && predicate(track)
  );
}

let publishedLaneJson: string | null = null;
let publishedLanes: {
  reviewActionId: string;
  taskId: string;
  audioVariantKey: string;
  idsByLabel: Map<string, string | null>;
} | null = null;

function getPublishedTimingLaneId(timingIndex: L0TimingIndex, aliases: L0TimingLaneAliases): string {
  const raw = typeof document === 'undefined'
    ? null
    : document.documentElement?.getAttribute('data-babel-recording-lanes') ?? null;
  // The cursor reads this every frame; parse only when Gold changes the snapshot.
  if (raw !== publishedLaneJson) {
    publishedLaneJson = raw;
    publishedLanes = null;
    if (raw) {
      try {
        const snapshot = asRecord(JSON.parse(raw));
        const reviewActionId = trimmedString(snapshot?.reviewActionId);
        if (reviewActionId && Array.isArray(snapshot?.tracks)) {
          const idsByLabel = new Map<string, string | null>();
          for (const value of snapshot.tracks) {
            const track = asRecord(value);
            const id = trimmedString(track?.id);
            const label = trimmedString(track?.label).replace(/\s+/g, ' ').toLocaleLowerCase();
            if (!id || !label) continue;
            idsByLabel.set(label, idsByLabel.has(label) && idsByLabel.get(label) !== id ? null : id);
          }
          publishedLanes = {
            reviewActionId,
            taskId: serializeL0TimingTaskId(reviewActionId, []),
            audioVariantKey: getAudioVariantKey(reviewActionId),
            idsByLabel
          };
        }
      } catch {
        // Invalid page metadata cannot establish a recording identity.
      }
    }
  }
  if (publishedLanes) {
    const audioVariantKey = getAudioVariantKey(publishedLanes.reviewActionId);
    if (publishedLanes.audioVariantKey !== audioVariantKey) {
      publishedLanes.audioVariantKey = audioVariantKey;
      publishedLanes.taskId = serializeL0TimingTaskId(publishedLanes.reviewActionId, []);
    }
  }
  if (!publishedLanes || publishedLanes.reviewActionId !== getPublishedReviewActionId() ||
      publishedLanes.taskId !== timingIndex.taskId) return '';

  let recordingId = '';
  for (const alias of Array.isArray(aliases.fallbackAliases) ? aliases.fallbackAliases : []) {
    const label = trimmedString(alias).replace(/\s+/g, ' ').toLocaleLowerCase();
    const id = publishedLanes.idsByLabel.get(label);
    if (id === null || (id && recordingId && id !== recordingId)) return '';
    if (id) recordingId = id;
  }
  return recordingId;
}

export function resolveL0TimingTrack(
  timingIndex: L0TimingIndex | null | undefined,
  aliases: L0TimingLaneAliases
): L0WordTimingTrack | null {
  if (!timingIndex || !aliases) return null;

  const stableKey = (
    trimmedString(aliases.stableId) || getPublishedTimingLaneId(timingIndex, aliases)
  ).toLocaleLowerCase();
  if (stableKey) {
    const stableMatches = matchingTracks(
      timingIndex,
      (track) => track.lane.trim().toLocaleLowerCase() === stableKey
    );
    if (stableMatches.length === 1) return stableMatches[0];
    if (stableMatches.length > 1) return null;
  }

  const fallbackKeys = new Set(
    (Array.isArray(aliases.fallbackAliases) ? aliases.fallbackAliases : []).flatMap(
      getLaneMatchKeys
    )
  );
  if (!fallbackKeys.size) return null;
  const fallbackMatches = matchingTracks(timingIndex, (track) =>
    getLaneMatchKeys(track.lane).some((key) => fallbackKeys.has(key))
  );
  return fallbackMatches.length === 1 ? fallbackMatches[0] : null;
}

export function getPreferredL0TimingLaneKey(aliases: L0TimingLaneAliases): string {
  return trimmedString(aliases?.stableId) || trimmedString(aliases?.fallbackAliases?.[0]);
}
