import type { L0TimingIndex, L0WordTimingTrack } from './l0-word-timing-alignment';

const QUERY_TASK_ID_KEYS = ['jobId', 'transcriptionChunkId', 'annotationId', 'id'] as const;
const PAGE_TASK_ID_ATTRIBUTE = 'data-babel-review-action-id';

type TaskLocation = Pick<Location, 'pathname' | 'search'>;

export type L0TimingRowIdentity = {
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
  getRowTextarea?: (row: unknown) => unknown;
};

function trimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getPublishedReviewActionId(): string {
  if (typeof document === 'undefined') return '';
  return trimmedString(document.documentElement?.getAttribute(PAGE_TASK_ID_ATTRIBUTE));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getReactFiber(element: unknown): Record<string, unknown> | null {
  const record = asRecord(element);
  if (!record) return null;

  try {
    const fiberKey = Object.getOwnPropertyNames(record).find((name) =>
      name.startsWith('__reactFiber$')
    );
    return fiberKey ? asRecord(record[fiberKey]) : null;
  } catch {
    return null;
  }
}

function getRowTextarea(helper: TimingIdentityHelper, row: unknown): unknown {
  if (typeof helper.getRowTextarea === 'function') {
    const textarea = helper.getRowTextarea(row);
    if (textarea) return textarea;
  }

  const querySelector = asRecord(row)?.querySelector;
  if (typeof querySelector !== 'function') return null;
  try {
    return querySelector.call(row, 'textarea');
  } catch {
    return null;
  }
}

function getReviewActionIdFromFiber(element: unknown): string {
  let fiber = getReactFiber(element);
  const seen = new Set<Record<string, unknown>>();
  for (let ancestorDepth = 0; fiber && ancestorDepth <= 30; ancestorDepth += 1) {
    if (seen.has(fiber)) return '';
    seen.add(fiber);
    const reviewActionId = trimmedString(asRecord(fiber.memoizedProps)?.reviewActionId);
    if (reviewActionId) return reviewActionId;
    fiber = asRecord(fiber.return);
  }
  return '';
}

function getReviewActionIdFromRows(
  helper: TimingIdentityHelper,
  rows: readonly unknown[]
): string {
  for (const row of rows) {
    const rowReviewActionId = getReviewActionIdFromFiber(row);
    if (rowReviewActionId) return rowReviewActionId;
    const textareaReviewActionId = getReviewActionIdFromFiber(getRowTextarea(helper, row));
    if (textareaReviewActionId) return textareaReviewActionId;
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

function serializeL0TimingTaskId(
  baseTaskId: string,
  rowIdentities: readonly L0TimingRowIdentity[]
): string {
  return JSON.stringify({
    version: 1,
    baseTaskId,
    stableLaneIds: collectL0TimingStableLaneIds(rowIdentities)
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
  const baseTaskId =
    getPublishedReviewActionId()
    || (helper && getReviewActionIdFromRows(helper, rows))
    || buildL0TimingBaseTaskId(currentLocation);
  const rowIdentities = helper ? getL0TimingRowIdentities(helper, rows) : [];
  return serializeL0TimingTaskId(baseTaskId, rowIdentities);
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

export function resolveL0TimingTrack(
  timingIndex: L0TimingIndex | null | undefined,
  aliases: L0TimingLaneAliases
): L0WordTimingTrack | null {
  if (!timingIndex || !aliases) return null;

  const stableKey = trimmedString(aliases.stableId).toLocaleLowerCase();
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
