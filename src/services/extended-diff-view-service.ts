type SegmentRecord = {
  startTimeInSeconds?: unknown;
  endTimeInSeconds?: unknown;
  text?: unknown;
};

type SegmentMapping = {
  segmentsA?: unknown;
  segmentsB?: unknown;
  relationship?: unknown;
  referenceText?: unknown;
  hypothesisText?: unknown;
  substitutions?: unknown;
  insertions?: unknown;
  deletions?: unknown;
};

type SpeakerDiff = {
  processedRecordingId?: unknown;
  segmentMappings?: unknown;
};

type TimestampDetail = {
  refText?: unknown;
  hypStart?: unknown;
  hypEnd?: unknown;
  startShiftMs?: unknown;
  endShiftMs?: unknown;
  avgShiftMs?: unknown;
  quality?: unknown;
};

type DiffPayload = {
  referenceReviewActionId?: unknown;
  currentReviewActionId?: unknown;
  referenceLevel?: unknown;
  currentLevel?: unknown;
  speakerDiffs?: unknown;
  timestampMetrics?: unknown;
};

type ReviewActionCandidate = {
  id: string;
  level: number | null;
};

type DiffToken = {
  text: string;
  status: 'same' | 'added' | 'removed';
};

type TextPatch = {
  id: string;
  speakerLabel: string;
  anchorSegments: SegmentRecord[];
  relationship: string;
  before: string;
  after: string;
  tokens: DiffToken[];
};

type OverlayItem = {
  id: string;
  speakerLabel: string;
  speakerKeys: string[];
  kind: 'segment';
  side: 'reference' | 'current';
  changeKind: 'segmentation' | 'timestamp';
  level: number | null;
  startSeconds: number;
  endSeconds: number;
  label: string;
  title: string;
};

type TimestampAnchor = {
  speakerLabel: string;
  speakerKeys: string[];
  referenceText: string;
  hypothesisText: string;
  segmentsA: SegmentRecord[];
  segmentsB: SegmentRecord[];
};

type LoadedDiff = {
  url: string;
  source: 'native' | 'generated';
  referenceLevel: number | null;
  currentLevel: number | null;
  pageLevel: number | null;
  compareLevel: number | null;
  textPatches: TextPatch[];
  overlays: OverlayItem[];
};

type DiffUrlEntry = {
  url: string;
  startTime: number;
  source: 'native' | 'generated';
};

type TranscriptRow = {
  row: HTMLTableRowElement;
  speaker: string;
  startSeconds: number | null;
  endSeconds: number | null;
  textCell: HTMLElement;
};

type WaveformLane = {
  speakerLabel: string;
  speakerKeys: string[];
  container: HTMLElement;
  durationSeconds: number;
  pxPerSecond: number;
};

type ExtendedDiffState = {
  timer: number;
  routeKey: string;
  loading: boolean;
  lastLoadError: string;
  loadedUrls: Set<string>;
  loadedReviewActionUrls: Set<string>;
  generatedDiffUrls: Set<string>;
  activeNativeUrl: string | null;
  lastRenderedDiffKey: string;
  overlayMode: 'reference' | 'current' | 'fusion';
  diffs: LoadedDiff[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function getSegments(value: unknown): SegmentRecord[] {
  return asArray(value).map((item) => asRecord(item) || {});
}

function secondsClose(left: number | null, right: unknown, tolerance = 0.035): boolean {
  const rightNumber = asNumber(right);
  return left != null && rightNumber != null && Math.abs(left - rightNumber) <= tolerance;
}

function parseDisplayedTime(text: string): number | null {
  const match = text.match(/(\d+):(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function parseSecondsLabel(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;
  const explicit = trimmed.match(/(-?\d+(?:\.\d+)?)\s*s\b/);
  if (explicit) {
    const value = Number(explicit[1]);
    return Number.isFinite(value) ? value : null;
  }
  const timestamp = trimmed.match(/-?\d+(?::\d+)+(?:\.\d+)?/);
  if (timestamp) {
    const parts = timestamp[0].split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  const numeric = Number((trimmed.match(/-?\d+(?:\.\d+)?/) || [])[0]);
  return Number.isFinite(numeric) ? numeric : null;
}

function parsePixels(value: string): number | null {
  const match = value.match(/-?\d+(?:\.\d+)?/);
  const number = match ? Number(match[0]) : NaN;
  return Number.isFinite(number) ? number : null;
}

function getReactInternalValue(element: unknown, prefix: string): unknown {
  if (!(element instanceof HTMLElement)) return null;
  for (const name of Object.getOwnPropertyNames(element)) {
    if (typeof name === 'string' && name.startsWith(prefix)) {
      return (element as unknown as Record<string, unknown>)[name];
    }
  }
  return null;
}

function getReactFiber(element: unknown): unknown {
  return getReactInternalValue(element, '__reactFiber$');
}

function getWaveformHostFromContainer(container: HTMLElement): HTMLElement | null {
  const root = typeof container.getRootNode === 'function' ? container.getRootNode() : null;
  return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
}

function getTrackDetailsForHost(host: HTMLElement): Record<string, unknown> | null {
  let fiber = getReactFiber(host);
  if (!fiber && host.parentElement instanceof HTMLElement) {
    fiber = getReactFiber(host.parentElement);
  }

  let owner = asRecord(fiber);
  let ownerDepth = 0;
  while (owner && ownerDepth < 25) {
    const props = asRecord(owner.memoizedProps);
    const track = asRecord(props?.track);
    if (track) return track;
    owner = asRecord(owner.return);
    ownerDepth += 1;
  }
  return null;
}

function getDomSpeakerLabelForHost(host: HTMLElement): string {
  let current: HTMLElement | null = host;
  let depth = 0;
  while (current && depth < 8) {
    const text = normalizeText(current.innerText || current.textContent || '');
    const matches = Array.from(text.matchAll(/\bSpeaker\s*([0-9]+)/gi));
    const uniqueLabels = Array.from(new Set(matches.map((match) => `Speaker ${match[1]}`)));
    if (uniqueLabels.length === 1) return uniqueLabels[0];
    current = current.parentElement;
    depth += 1;
  }
  return '';
}

function formatMs(value: unknown): string {
  const number = asNumber(value) || 0;
  return `${number > 0 ? '+' : ''}${number}ms`;
}

function speakerIdToLabel(value: unknown, fallbackIndex: number): string {
  const match = asString(value).match(/speaker-(\d+)/i);
  return match ? `Speaker ${match[1]}` : `Speaker ${fallbackIndex + 1}`;
}

function normalizeSpeakerKey(value: unknown): string {
  return normalizeText(asString(value)).toLowerCase();
}

function collectSpeakerKeys(...values: unknown[]): string[] {
  const keys = new Set<string>();
  for (const value of values) {
    const key = normalizeSpeakerKey(value);
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

function speakerIdToKeys(value: unknown, label: string): string[] {
  const raw = asString(value);
  const numeric = raw.match(/speaker-(\d+)/i);
  return collectSpeakerKeys(raw, label, numeric ? `Speaker ${numeric[1]}` : '');
}

function hasMappingChange(mapping: SegmentMapping): boolean {
  const relationship = asString(mapping.relationship) || 'modified';
  const beforeCount = getSegments(mapping.segmentsA).length;
  const afterCount = getSegments(mapping.segmentsB).length;
  const edits =
    (asNumber(mapping.substitutions) || 0) +
    (asNumber(mapping.insertions) || 0) +
    (asNumber(mapping.deletions) || 0);
  return (
    relationship !== 'unchanged' ||
    beforeCount !== afterCount ||
    edits > 0 ||
    normalizeText(asString(mapping.referenceText)) !== normalizeText(asString(mapping.hypothesisText))
  );
}

function isStructuralMapping(mapping: SegmentMapping): boolean {
  const relationship = asString(mapping.relationship) || 'modified';
  const beforeCount = getSegments(mapping.segmentsA).length;
  const afterCount = getSegments(mapping.segmentsB).length;
  return relationship !== 'unchanged' && (relationship !== 'modified' || beforeCount !== afterCount);
}

function splitDiffUnits(text: string): string[] {
  return text.match(/\S+\s*/g) || [];
}

function buildTokenDiff(before: string, after: string): DiffToken[] {
  const left = splitDiffUnits(before);
  const right = splitDiffUnits(after);
  const dp: number[][] = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));

  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      tokens.push({ text: left[i], status: 'same' });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      tokens.push({ text: left[i], status: 'removed' });
      i += 1;
    } else {
      tokens.push({ text: right[j], status: 'added' });
      j += 1;
    }
  }
  while (i < left.length) {
    tokens.push({ text: left[i], status: 'removed' });
    i += 1;
  }
  while (j < right.length) {
    tokens.push({ text: right[j], status: 'added' });
    j += 1;
  }
  return tokens;
}

function countChangedTokens(tokens: DiffToken[]): number {
  return tokens.filter((token) => token.status !== 'same').length;
}

function getTimestampDetails(payload: DiffPayload): TimestampDetail[] {
  const metrics = asRecord(payload.timestampMetrics);
  const segments = asRecord(metrics?.segments);
  return asArray(segments?.details) as TimestampDetail[];
}

function shouldShowTimestamp(detail: TimestampDetail): boolean {
  return (
    (asNumber(detail.startShiftMs) || 0) !== 0 ||
    (asNumber(detail.endShiftMs) || 0) !== 0 ||
    (asNumber(detail.avgShiftMs) || 0) !== 0 ||
    (asString(detail.quality) !== '' && asString(detail.quality) !== 'high')
  );
}

function textMatchesTimestampDetail(detailText: string, candidateText: string): boolean {
  const detail = normalizeText(detailText);
  const candidate = normalizeText(candidateText);
  return Boolean(detail && candidate && (detail === candidate || detail.includes(candidate) || candidate.includes(detail)));
}

function segmentMatchesTimestampDetail(detail: TimestampDetail, segment: SegmentRecord): boolean {
  const start = asNumber(detail.hypStart);
  const end = asNumber(detail.hypEnd);
  const segmentStart = asNumber(segment.startTimeInSeconds);
  const segmentEnd = asNumber(segment.endTimeInSeconds);
  if (start == null || end == null || segmentStart == null || segmentEnd == null) return false;
  return Math.abs(start - segmentStart) <= 0.08 || Math.abs(end - segmentEnd) <= 0.08 || (start >= segmentStart && end <= segmentEnd);
}

function getTimestampSegmentDistance(segment: SegmentRecord, starts: number[], ends: number[]): number {
  const segmentStart = asNumber(segment.startTimeInSeconds);
  const segmentEnd = asNumber(segment.endTimeInSeconds);
  if (segmentStart == null || segmentEnd == null) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const start of starts) {
    for (const end of ends) {
      best = Math.min(best, Math.abs(segmentStart - start) + Math.abs(segmentEnd - end));
    }
  }
  return best;
}

function findBestTimestampSegment(segments: SegmentRecord[], starts: number[], ends: number[]): SegmentRecord | null {
  let bestSegment: SegmentRecord | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const segment of segments) {
    const distance = getTimestampSegmentDistance(segment, starts, ends);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSegment = segment;
    }
  }
  return bestDistance <= 0.25 ? bestSegment : null;
}

function resolveTimestampAnchor(detail: TimestampDetail, anchors: TimestampAnchor[]): TimestampAnchor | null {
  const start = asNumber(detail.hypStart);
  const end = asNumber(detail.hypEnd);
  if (start != null && end != null) {
    const shiftedStart = start - (asNumber(detail.startShiftMs) || 0) / 1000;
    const shiftedEnd = end - (asNumber(detail.endShiftMs) || 0) / 1000;
    const starts = [start, shiftedStart];
    const ends = [end, shiftedEnd];
    let bestAnchor: TimestampAnchor | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const anchor of anchors) {
      for (const segment of [...anchor.segmentsA, ...anchor.segmentsB]) {
        const distance = getTimestampSegmentDistance(segment, starts, ends);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestAnchor = anchor;
        }
      }
    }
    if (bestAnchor && bestDistance <= 0.25) return bestAnchor;
  }

  const detailText = asString(detail.refText);
  const textMatch = anchors.find(
    (anchor) => textMatchesTimestampDetail(detailText, anchor.referenceText) || textMatchesTimestampDetail(detailText, anchor.hypothesisText)
  );
  return textMatch || null;
}

function addSegmentOverlay(
  overlays: OverlayItem[],
  options: {
    id: string;
    speakerLabel: string;
    speakerKeys?: string[];
    side: OverlayItem['side'];
    changeKind: OverlayItem['changeKind'];
    level: number | null;
    startSeconds: number | null;
    endSeconds: number | null;
    label: string;
    title: string;
  }
) {
  const { startSeconds, endSeconds } = options;
  if (startSeconds == null || endSeconds == null || !(endSeconds > startSeconds)) return;
  overlays.push({
    id: options.id,
    speakerLabel: options.speakerLabel,
    speakerKeys: collectSpeakerKeys(options.speakerLabel, ...(options.speakerKeys || [])),
    kind: 'segment',
    side: options.side,
    changeKind: options.changeKind,
    level: options.level,
    startSeconds,
    endSeconds,
    label: options.label,
    title: options.title
  });
}

function getCurrentReviewActionId(): string {
  return new URLSearchParams(window.location.search || '').get('reviewActionId') || '';
}

function isFeedbackRoute(): boolean {
  const params = new URLSearchParams(window.location.search || '');
  return (
    /^\/transcription(?:\/|$)/.test(window.location.pathname || '') &&
    Boolean(params.get('reviewActionId')) &&
    params.get('displayFeedback') === 'true'
  );
}

function isDiffViewEnabled(): boolean {
  const switchElement = document.querySelector('[role="switch"]');
  return switchElement?.getAttribute('aria-checked') === 'true' || Boolean(document.body.innerText.match(/\bCompare:\b/));
}

function getVisibleCompareLevel(): number | null {
  for (const combo of Array.from(document.querySelectorAll('[role="combobox"]'))) {
    const match = normalizeText((combo as HTMLElement).innerText || combo.textContent || '').match(/^L(\d+)$/);
    if (match) return Number(match[1]);
  }
  return null;
}

function getRouteKey(): string {
  return `${window.location.pathname}?${window.location.search}`;
}

function diffUrlMentionsReviewAction(url: string, reviewActionId: string): boolean {
  if (!reviewActionId) return true;
  try {
    const parsed = new URL(url);
    const input = parsed.searchParams.get('input') || '';
    return decodeURIComponent(input).includes(reviewActionId);
  } catch (_error) {
    return url.includes(reviewActionId);
  }
}

function discoverDiffUrlEntries(): DiffUrlEntry[] {
  const reviewActionId = getCurrentReviewActionId();
  const urls = new Map<string, DiffUrlEntry>();
  for (const entry of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    const url = entry.name || '';
    if (url.includes('/api/trpc/transcriptions.getTranscriptionDiff') && diffUrlMentionsReviewAction(url, reviewActionId)) {
      urls.set(url, { url, startTime: entry.startTime, source: 'native' });
    }
  }
  return Array.from(urls.values()).sort((left, right) => left.startTime - right.startTime);
}

function discoverReviewActionUrls(): string[] {
  const reviewActionId = getCurrentReviewActionId();
  const urls = new Set<string>();
  for (const entry of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
    const url = entry.name || '';
    if (url.includes('/api/trpc/') && url.includes('getReviewActionsForChunk') && diffUrlMentionsReviewAction(url, reviewActionId)) {
      urls.add(url);
    }
  }
  return Array.from(urls);
}

function walkJson(value: unknown, visit: (record: Record<string, unknown>) => void) {
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  visit(record);
  for (const child of Object.values(record)) walkJson(child, visit);
}

function collectReviewActionsFromText(text: string): ReviewActionCandidate[] {
  const byId = new Map<string, ReviewActionCandidate>();
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const sources = lines.length > 1 ? lines : [text];

  for (const source of sources) {
    try {
      walkJson(JSON.parse(source), (record) => {
        const id = asString(record.id);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return;
        if (!('level' in record) && !('label' in record)) return;
        byId.set(id, { id, level: asNumber(record.level) });
      });
    } catch (_error) {
      // Ignore non-JSONL fragments.
    }
  }

  return Array.from(byId.values());
}

function inferCurrentLevel(actions: ReviewActionCandidate[]): number | null {
  const levels = actions
    .map((action) => action.level)
    .filter((level): level is number => level != null)
    .sort((left, right) => left - right);
  if (!levels.length) return null;
  for (let level = levels[0]; level <= levels[levels.length - 1]; level += 1) {
    if (!levels.includes(level)) return level;
  }
  return levels[0] > 0 ? levels[0] - 1 : levels[levels.length - 1] + 1;
}

function buildDiffUrl(referenceReviewActionId: string, currentReviewActionId: string): string {
  const url = new URL('/api/trpc/transcriptions.getTranscriptionDiff', window.location.origin);
  url.searchParams.set('batch', '1');
  url.searchParams.set('input', JSON.stringify({ 0: { json: { referenceReviewActionId, currentReviewActionId } } }));
  return url.toString();
}

async function discoverGeneratedDiffUrls(state: ExtendedDiffState): Promise<string[]> {
  const currentReviewActionId = getCurrentReviewActionId();
  if (!currentReviewActionId) return [];

  const urls: string[] = [];
  for (const actionUrl of discoverReviewActionUrls().filter((url) => !state.loadedReviewActionUrls.has(url))) {
    state.loadedReviewActionUrls.add(actionUrl);
    const response = await fetch(actionUrl, { credentials: 'include' });
    if (!response.ok) continue;

    const actions = collectReviewActionsFromText(await response.text()).filter((action) => action.id !== currentReviewActionId);
    const currentLevel = inferCurrentLevel(actions);
    for (const action of actions) {
      if (currentLevel != null && action.level != null && action.level <= currentLevel) continue;
      const url = buildDiffUrl(currentReviewActionId, action.id);
      if (!state.generatedDiffUrls.has(url)) {
        state.generatedDiffUrls.add(url);
        urls.push(url);
      }
    }
  }
  return urls;
}

function extractPayloadsFromTrpcJson(source: unknown): DiffPayload[] {
  const payloads: DiffPayload[] = [];
  for (const record of Array.isArray(source) ? source : [source]) {
    const root = asRecord(record);
    const result = asRecord(root?.result);
    const data = asRecord(result?.data);
    const json = asRecord(data?.json);
    if (json) payloads.push(json as DiffPayload);
  }
  return payloads;
}

function parseTrpcPayload(text: string): DiffPayload[] {
  try {
    return extractPayloadsFromTrpcJson(JSON.parse(text));
  } catch (_error) {
    const payloads: DiffPayload[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        payloads.push(...extractPayloadsFromTrpcJson(JSON.parse(trimmed)));
      } catch (_lineError) {
        // Ignore non-JSONL fragments.
      }
    }
    return payloads;
  }
}

async function fetchDiffUrl(url: string): Promise<DiffPayload[]> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error(`Diff fetch failed: HTTP ${response.status}`);
  return parseTrpcPayload(await response.text());
}

function payloadMentionsPageAction(payload: DiffPayload): boolean {
  const currentReviewActionId = getCurrentReviewActionId();
  return (
    Boolean(currentReviewActionId) &&
    (asString(payload.referenceReviewActionId) === currentReviewActionId ||
      asString(payload.currentReviewActionId) === currentReviewActionId)
  );
}

function buildLoadedDiff(url: string, payload: DiffPayload, source: LoadedDiff['source']): LoadedDiff {
  const textPatches: TextPatch[] = [];
  const overlays: OverlayItem[] = [];
  const timestampAnchors: TimestampAnchor[] = [];
  const referenceLevel = asNumber(payload.referenceLevel);
  const currentLevel = asNumber(payload.currentLevel);
  const levelLabel = `L${referenceLevel ?? '?'}->L${currentLevel ?? '?'}`;
  const pageReviewActionId = getCurrentReviewActionId();
  const anchorSide = asString(payload.currentReviewActionId) === pageReviewActionId ? 'current' : 'reference';
  const pageLevel = anchorSide === 'current' ? currentLevel : referenceLevel;
  const compareLevel = anchorSide === 'current' ? referenceLevel : currentLevel;
  const comparisonKey = `${asString(payload.referenceReviewActionId).slice(0, 8)}-${asString(payload.currentReviewActionId).slice(0, 8)}`;

  (asArray(payload.speakerDiffs) as SpeakerDiff[]).forEach((speaker, speakerIndex) => {
    const speakerLabel = speakerIdToLabel(speaker.processedRecordingId, speakerIndex);
    const speakerKeys = speakerIdToKeys(speaker.processedRecordingId, speakerLabel);
    (asArray(speaker.segmentMappings) as SegmentMapping[]).forEach((mapping, mappingIndex) => {
      const before = asString(mapping.referenceText);
      const after = asString(mapping.hypothesisText);
      const segmentsA = getSegments(mapping.segmentsA);
      const segmentsB = getSegments(mapping.segmentsB);
      const relationship = asString(mapping.relationship) || 'modified';
      timestampAnchors.push({
        speakerLabel,
        speakerKeys,
        referenceText: before,
        hypothesisText: after,
        segmentsA,
        segmentsB
      });
      if (!hasMappingChange(mapping)) return;

      const anchorSegments = anchorSide === 'current' ? segmentsB : segmentsA;
      const tokens = buildTokenDiff(before, after);
      textPatches.push({
        id: `patch-${comparisonKey}-${speakerIndex}-${mappingIndex}`,
        speakerLabel,
        anchorSegments,
        relationship,
        before,
        after,
        tokens
      });

      if (isStructuralMapping(mapping)) {
        segmentsA.forEach((segment, segmentIndex) => {
          addSegmentOverlay(overlays, {
            id: `seg-ref-${comparisonKey}-${speakerIndex}-${mappingIndex}-${segmentIndex}`,
            speakerLabel,
            speakerKeys,
            side: 'reference',
            changeKind: 'segmentation',
            level: referenceLevel,
            startSeconds: asNumber(segment.startTimeInSeconds),
            endSeconds: asNumber(segment.endTimeInSeconds),
            label: `L${referenceLevel ?? '?'} ${relationship}`,
            title: `${levelLabel} old segment ${relationship}: ${normalizeText(before)}`
          });
        });
        segmentsB.forEach((segment, segmentIndex) => {
          addSegmentOverlay(overlays, {
            id: `seg-cur-${comparisonKey}-${speakerIndex}-${mappingIndex}-${segmentIndex}`,
            speakerLabel,
            speakerKeys,
            side: 'current',
            changeKind: 'segmentation',
            level: currentLevel,
            startSeconds: asNumber(segment.startTimeInSeconds),
            endSeconds: asNumber(segment.endTimeInSeconds),
            label: `L${currentLevel ?? '?'} ${relationship}`,
            title: `${levelLabel} new segment ${relationship}: ${normalizeText(after)}`
          });
        });
      }
    });
  });

  getTimestampDetails(payload).filter(shouldShowTimestamp).forEach((detail, index) => {
    const metricStart = asNumber(detail.hypStart);
    const metricEnd = asNumber(detail.hypEnd);
    if (metricStart == null || metricEnd == null || !(metricEnd > metricStart)) return;
    const timestampAnchor = resolveTimestampAnchor(detail, timestampAnchors);
    const speakerLabel = timestampAnchor?.speakerLabel || '';
    const speakerKeys = timestampAnchor?.speakerKeys || [];
    const startShift = asNumber(detail.startShiftMs) || 0;
    const endShift = asNumber(detail.endShiftMs) || 0;
    const title = `${levelLabel} timestamp shift: start ${formatMs(detail.startShiftMs)}, end ${formatMs(detail.endShiftMs)}, ${asString(detail.quality) || 'unknown'}`;
    const shiftedStart = metricStart - startShift / 1000;
    const shiftedEnd = metricEnd - endShift / 1000;
    const candidateStarts = [metricStart, shiftedStart];
    const candidateEnds = [metricEnd, shiftedEnd];
    const referenceSegment = timestampAnchor
      ? findBestTimestampSegment(timestampAnchor.segmentsA, candidateStarts, candidateEnds)
      : null;
    const currentSegment = timestampAnchor
      ? findBestTimestampSegment(timestampAnchor.segmentsB, candidateStarts, candidateEnds)
      : null;
    const referenceStart = asNumber(referenceSegment?.startTimeInSeconds) ?? metricStart;
    const referenceEnd = asNumber(referenceSegment?.endTimeInSeconds) ?? metricEnd;
    const currentStart = asNumber(currentSegment?.startTimeInSeconds) ?? shiftedStart;
    const currentEnd = asNumber(currentSegment?.endTimeInSeconds) ?? shiftedEnd;
    const labelSuffix = `${formatMs(detail.startShiftMs)} / ${formatMs(detail.endShiftMs)}`;

    addSegmentOverlay(overlays, {
      id: `time-ref-${comparisonKey}-${index}`,
      speakerLabel,
      speakerKeys,
      side: 'reference',
      changeKind: 'timestamp',
      level: referenceLevel,
      startSeconds: referenceStart,
      endSeconds: referenceEnd,
      label: `L${referenceLevel ?? '?'} ${labelSuffix}`,
      title: `${title}; old segment ${referenceStart.toFixed(3)}s-${referenceEnd.toFixed(3)}s`
    });
    addSegmentOverlay(overlays, {
      id: `time-cur-${comparisonKey}-${index}`,
      speakerLabel,
      speakerKeys,
      side: 'current',
      changeKind: 'timestamp',
      level: currentLevel,
      startSeconds: currentStart,
      endSeconds: currentEnd,
      label: `L${currentLevel ?? '?'} ${labelSuffix}`,
      title: `${title}; new segment ${currentStart.toFixed(3)}s-${currentEnd.toFixed(3)}s`
    });
  });

  return { url, source, referenceLevel, currentLevel, pageLevel, compareLevel, textPatches, overlays };
}

function injectStyles() {
  if (document.getElementById('babel-helper-extended-diff-style')) return;
  const style = document.createElement('style');
  style.id = 'babel-helper-extended-diff-style';
  style.textContent = `
    .bh-native-diff-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 5.5rem; border: 1px solid #bfdbfe; border-radius: 999px; padding: 1px 10px; background: #eff6ff; color: #1d4ed8; font-size: 12px; font-weight: 700; flex-shrink: 0; }
    .bh-native-diff-text { font-size: 12px; line-height: 1.625; }
    .bh-native-diff-same { color: hsl(var(--foreground)); }
    .bh-native-diff-added { color: #15803d; background: #dcfce7; border-radius: 3px; padding: 0 2px; }
    .bh-native-diff-removed { color: #b91c1c; background: #fee2e2; text-decoration: line-through; border-radius: 3px; padding: 0 2px; }
    .bh-segmentation-mode-controls { display: inline-flex; align-items: center; gap: 2px; margin-left: 8px; padding: 2px; border: 1px solid rgba(148, 163, 184, 0.45); border-radius: 6px; background: rgba(255, 255, 255, 0.88); }
    .bh-segmentation-mode-controls button { border: 0; border-radius: 4px; padding: 2px 7px; background: transparent; color: #334155; font-size: 11px; font-weight: 700; cursor: pointer; }
    .bh-segmentation-mode-controls button[data-active="true"] { background: #0f172a; color: #f8fafc; }
  `;
  document.documentElement.appendChild(style);
}

function removeSegmentationModeControls() {
  document.getElementById('bh-segmentation-mode-controls')?.remove();
}

function renderSegmentationModeControls(state: ExtendedDiffState) {
  if (!isFeedbackRoute() || !isDiffViewEnabled()) {
    removeSegmentationModeControls();
    return;
  }
  const activeDiff = getRenderableDiffs(state)[0];
  if (!activeDiff) {
    removeSegmentationModeControls();
    return;
  }

  const switchElement = document.querySelector('[role="switch"]');
  const anchor = switchElement?.parentElement || switchElement;
  if (!(anchor instanceof HTMLElement)) return;

  let controls = document.getElementById('bh-segmentation-mode-controls') as HTMLElement | null;
  if (!controls) {
    controls = createElement('div', 'bh-segmentation-mode-controls');
    controls.id = 'bh-segmentation-mode-controls';
    anchor.insertAdjacentElement('afterend', controls);
  }

  const options: Array<{ mode: ExtendedDiffState['overlayMode']; label: string; title: string }> = [
    {
      mode: 'reference',
      label: `L${activeDiff.referenceLevel ?? '?'}`,
      title: 'Show only the reference-side segmentation for the active Babel comparison'
    },
    {
      mode: 'current',
      label: `L${activeDiff.currentLevel ?? '?'}`,
      title: 'Show only the current-side segmentation for the active Babel comparison'
    },
    {
      mode: 'fusion',
      label: 'Fusion',
      title: 'Show reference segmentation above current segmentation'
    }
  ];

  controls.replaceChildren(
    ...options.map((option) => {
      const button = createElement('button', '', option.label);
      button.type = 'button';
      button.title = option.title;
      button.dataset.mode = option.mode;
      button.dataset.active = String(state.overlayMode === option.mode);
      button.addEventListener('click', () => {
        state.overlayMode = option.mode;
        applyWaveformOverlays(state);
        renderSegmentationModeControls(state);
      });
      return button;
    })
  );
}

function getRenderableDiffs(state: ExtendedDiffState): LoadedDiff[] {
  const visibleCompareLevel = getVisibleCompareLevel();
  if (visibleCompareLevel != null) {
    const visibleNative = state.diffs.filter((diff) => diff.source === 'native' && diff.compareLevel === visibleCompareLevel);
    if (visibleNative.length) return visibleNative;
    return state.diffs.filter((diff) => diff.compareLevel === visibleCompareLevel);
  }
  if (state.activeNativeUrl) {
    return state.diffs.filter((diff) => diff.url === state.activeNativeUrl);
  }
  return state.diffs.filter((diff) => diff.source === 'generated');
}

function getRenderableDiffKey(state: ExtendedDiffState): string {
  return getRenderableDiffs(state)
    .map((diff) => diff.url)
    .join('|');
}

function getTranscriptRows(): TranscriptRow[] {
  return Array.from(document.querySelectorAll('tbody tr'))
    .filter((row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement)
    .map((row) => {
      const cells = Array.from(row.children) as HTMLElement[];
      if (cells.length < 5) return null;
      return {
        row,
        speaker: normalizeText(cells[1].innerText || ''),
        startSeconds: parseDisplayedTime(cells[2].innerText || ''),
        endSeconds: parseDisplayedTime(cells[3].innerText || ''),
        textCell: cells[4]
      };
    })
    .filter((row): row is TranscriptRow => Boolean(row && row.speaker && row.startSeconds != null));
}

function rowMatchesSegment(row: TranscriptRow, patch: TextPatch, segment: SegmentRecord): boolean {
  return (
    row.speaker === patch.speakerLabel &&
    secondsClose(row.startSeconds, segment.startTimeInSeconds) &&
    secondsClose(row.endSeconds, segment.endTimeInSeconds)
  );
}

function createElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function restoreNativeDiffCells() {
  document.querySelectorAll<HTMLElement>('[data-bh-native-diff-original]').forEach((cell) => {
    cell.innerHTML = cell.dataset.bhNativeDiffOriginal || '';
    delete cell.dataset.bhNativeDiffOriginal;
    delete cell.dataset.bhNativeDiffApplied;
  });
}

function renderPatchIntoCell(cell: HTMLElement, patch: TextPatch) {
  if (!cell.dataset.bhNativeDiffOriginal) {
    cell.dataset.bhNativeDiffOriginal = cell.innerHTML;
  }
  if (cell.dataset.bhNativeDiffApplied === patch.id) return;
  cell.dataset.bhNativeDiffApplied = patch.id;

  const wrapper = createElement('div', 'flex items-center gap-2 py-0.5');
  const changedCount = countChangedTokens(patch.tokens);
  wrapper.appendChild(createElement('div', 'bh-native-diff-badge', changedCount === 1 ? '1 change' : `${changedCount} changes`));
  const text = createElement('span', 'bh-native-diff-text');
  text.title = patch.relationship;
  for (const token of patch.tokens) {
    const span = createElement(
      'span',
      token.status === 'added'
        ? 'bh-native-diff-added'
        : token.status === 'removed'
          ? 'bh-native-diff-removed'
          : 'bh-native-diff-same',
      token.text
    );
    text.appendChild(span);
  }
  wrapper.appendChild(text);
  cell.replaceChildren(wrapper);
}

function applyTextDiffs(state: ExtendedDiffState) {
  if (!isFeedbackRoute() || !isDiffViewEnabled()) {
    restoreNativeDiffCells();
    state.lastRenderedDiffKey = '';
    return;
  }
  injectStyles();
  const diffKey = getRenderableDiffKey(state);
  if (state.lastRenderedDiffKey !== diffKey) {
    restoreNativeDiffCells();
    state.lastRenderedDiffKey = diffKey;
  }
  const rows = getTranscriptRows();
  const patches = getRenderableDiffs(state).flatMap((diff) => diff.textPatches);
  const usedCells = new Set<HTMLElement>();

  for (const patch of patches) {
    const row = rows.find((candidate) => patch.anchorSegments.some((segment) => rowMatchesSegment(candidate, patch, segment)));
    if (!row || usedCells.has(row.textCell)) continue;
    usedCells.add(row.textCell);
    renderPatchIntoCell(row.textCell, patch);
  }
}

function getWaveformOverlayContainer(root: ShadowRoot): HTMLElement | null {
  const regions =
    root.querySelector('[part="regions-container"]') ||
    (() => {
      const region = root.querySelector('[part~="region"]');
      return region instanceof HTMLElement ? region.parentElement : null;
    })();
  if (regions instanceof HTMLElement) return regions;
  const wrapper = root.querySelector('[part="wrapper"]');
  return wrapper instanceof HTMLElement ? wrapper : null;
}

function getTimelinePixelsPerSecond(root: ShadowRoot, container: HTMLElement): number {
  const collectPoints = (selector: string) =>
    Array.from(root.querySelectorAll(selector))
      .map((notch) => {
        if (!(notch instanceof HTMLElement)) return null;
        const seconds = parseSecondsLabel(notch.textContent || '');
        const leftPx = parsePixels(notch.style.left || '');
        if (seconds == null || leftPx == null) return null;
        return { seconds, leftPx };
      })
      .filter((point): point is { seconds: number; leftPx: number } => Boolean(point))
      .sort((left, right) => left.leftPx - right.leftPx);

  const getMedianPxPerSecond = (points: { seconds: number; leftPx: number }[]): number => {
    const ratios: number[] = [];
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const dt = current.seconds - previous.seconds;
      const dx = current.leftPx - previous.leftPx;
      if (dt > 0 && dx > 0) ratios.push(dx / dt);
    }
    ratios.sort((left, right) => left - right);
    if (!ratios.length) return 0;
    const middle = Math.floor(ratios.length / 2);
    return ratios.length % 2 === 1 ? ratios[middle] : (ratios[middle - 1] + ratios[middle]) / 2;
  };

  const primaryScale = getMedianPxPerSecond(collectPoints('[part~="timeline-notch-primary"]'));
  if (primaryScale > 0) return primaryScale;

  const allScale = getMedianPxPerSecond(collectPoints('[part~="timeline-notch-primary"], [part~="timeline-notch-secondary"]'));
  if (allScale > 0) return allScale;

  const points = Array.from(root.querySelectorAll('[part~="timeline-notch-primary"], [part~="timeline-notch-secondary"]'))
    .map((notch) => {
      if (!(notch instanceof HTMLElement)) return null;
      const seconds = parseSecondsLabel(notch.textContent || '');
      const leftPx = parsePixels(notch.style.left || '');
      if (seconds == null || leftPx == null) return null;
      return { seconds, leftPx };
    })
    .filter((point): point is { seconds: number; leftPx: number } => Boolean(point))
    .sort((left, right) => left.leftPx - right.leftPx);

  if (points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    const dx = last.leftPx - first.leftPx;
    const dt = last.seconds - first.seconds;
    if (dx > 0 && dt > 0) return dx / dt;
  }

  const wrapper = root.querySelector('[part="wrapper"]');
  const width =
    wrapper instanceof HTMLElement
      ? parsePixels(wrapper.style.width || '') || wrapper.scrollWidth || wrapper.getBoundingClientRect().width
      : container.scrollWidth || container.getBoundingClientRect().width;
  return width > 0 ? width / 120 : 0;
}

function getWaveformLanes(): WaveformLane[] {
  const hosts = Array.from(document.querySelectorAll('div')).filter(
    (node): node is HTMLDivElement => node instanceof HTMLDivElement && node.shadowRoot instanceof ShadowRoot
  );
  return hosts
    .map((host, index) => {
      const root = host.shadowRoot;
      if (!(root instanceof ShadowRoot)) return null;
      const container = getWaveformOverlayContainer(root);
      if (!(container instanceof HTMLElement)) return null;
      const pxPerSecond = getTimelinePixelsPerSecond(root, container);
      const waveformHost = getWaveformHostFromContainer(container);
      const track = waveformHost ? getTrackDetailsForHost(waveformHost) : null;
      const domLabel = waveformHost ? getDomSpeakerLabelForHost(waveformHost) : '';
      const trackLabel = asString(track?.label).trim();
      const fallbackLabel = `Speaker ${index + 1}`;
      const speakerLabel = domLabel || trackLabel || fallbackLabel;
      const speakerKeys = track
        ? collectSpeakerKeys(track.processedRecordingId, track.id, track.label, domLabel, speakerLabel)
        : collectSpeakerKeys(speakerLabel);
      return {
        speakerLabel,
        speakerKeys,
        container,
        durationSeconds: pxPerSecond > 0 ? (container.scrollWidth || container.getBoundingClientRect().width) / pxPerSecond : 0,
        pxPerSecond
      };
    })
    .filter((lane): lane is WaveformLane => Boolean(lane && lane.pxPerSecond > 0));
}

function clearWaveformOverlays() {
  document.querySelectorAll('.bh-waveform-overlay-layer').forEach((layer) => layer.remove());
  for (const host of Array.from(document.querySelectorAll('div'))) {
    if (!(host instanceof HTMLElement) || !(host.shadowRoot instanceof ShadowRoot)) continue;
    host.shadowRoot.querySelectorAll('.bh-waveform-overlay-layer').forEach((layer) => layer.remove());
  }
}

function getDirectOverlayLayers(container: HTMLElement): HTMLElement[] {
  return Array.from(container.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('bh-waveform-overlay-layer')
  );
}

function getLaneOverlayItems(lane: WaveformLane, overlays: OverlayItem[], mode: ExtendedDiffState['overlayMode']): OverlayItem[] {
  const laneKeys = new Set(lane.speakerKeys.length ? lane.speakerKeys : collectSpeakerKeys(lane.speakerLabel));
  return overlays.filter((item) => {
    const itemKeys = item.speakerKeys.length ? item.speakerKeys : collectSpeakerKeys(item.speakerLabel);
    const speakerMatches = !itemKeys.length || itemKeys.some((key) => laneKeys.has(key));
    return speakerMatches && (mode === 'fusion' || item.side === mode);
  });
}

function getOverlaySignature(lane: WaveformLane, items: OverlayItem[], mode: ExtendedDiffState['overlayMode']): string {
  return [
    lane.speakerLabel,
    lane.speakerKeys.join(','),
    mode,
    Math.round(lane.pxPerSecond * 100) / 100,
    ...items.map((item) =>
      [
        item.id,
        item.kind,
        item.side,
        item.changeKind,
        Math.round(item.startSeconds * 1000) / 1000,
        Math.round(item.endSeconds * 1000) / 1000,
        item.label,
        item.title
      ].join(':')
    )
  ].join('|');
}

function styleOverlayLayer(layer: HTMLElement) {
  layer.style.position = 'absolute';
  layer.style.inset = '0';
  layer.style.pointerEvents = 'none';
  layer.style.zIndex = '8';
}

function styleOverlayMarker(marker: HTMLElement, item: OverlayItem, leftPx: number, widthPx: number, mode: ExtendedDiffState['overlayMode']) {
  marker.style.position = 'absolute';
  marker.style.left = `${leftPx}px`;
  marker.style.width = `${Math.max(2, widthPx)}px`;
  if (mode === 'fusion') {
    marker.style.top = item.side === 'reference' ? '2px' : '52%';
    marker.style.height = '46%';
  } else {
    marker.style.top = '0';
    marker.style.height = '100%';
  }
  marker.style.minWidth = '2px';
  marker.style.borderRadius = '3px';
  marker.style.boxSizing = 'border-box';
  marker.style.opacity = item.changeKind === 'segmentation' ? '0.9' : '0.74';
  const isReference = item.side === 'reference';
  const referenceBackground =
    item.changeKind === 'segmentation'
      ? 'repeating-linear-gradient(135deg, rgba(248, 113, 113, 0.34) 0, rgba(248, 113, 113, 0.34) 7px, rgba(185, 28, 28, 0.20) 7px, rgba(185, 28, 28, 0.20) 14px)'
      : 'rgba(248, 113, 113, 0.22)';
  const currentBackground =
    item.changeKind === 'segmentation'
      ? 'repeating-linear-gradient(135deg, rgba(45, 212, 191, 0.32) 0, rgba(45, 212, 191, 0.32) 7px, rgba(13, 148, 136, 0.20) 7px, rgba(13, 148, 136, 0.20) 14px)'
      : 'rgba(45, 212, 191, 0.22)';
  marker.style.background = isReference ? referenceBackground : currentBackground;
  marker.style.border = isReference ? '2px solid rgba(185, 28, 28, 0.88)' : '2px solid rgba(13, 148, 136, 0.88)';
  marker.style.boxShadow = 'inset 0 0 0 1px rgba(255, 255, 255, 0.62)';
}

function styleOverlayLabel(label: HTMLElement, item: OverlayItem) {
  label.style.position = 'absolute';
  label.style.top = '2px';
  label.style.left = '3px';
  label.style.maxWidth = '180px';
  label.style.overflow = 'hidden';
  label.style.textOverflow = 'ellipsis';
  label.style.whiteSpace = 'nowrap';
  label.style.color = '#111827';
  label.style.font = '700 10px/1.2 Inter, ui-sans-serif, system-ui, sans-serif';
  label.style.background = item.side === 'reference' ? 'rgba(127, 29, 29, 0.92)' : 'rgba(15, 118, 110, 0.92)';
  label.style.color = '#f8fafc';
  label.style.borderRadius = '3px';
  label.style.padding = '1px 3px';
}

function applyWaveformOverlays(state: ExtendedDiffState) {
  if (!isFeedbackRoute() || !isDiffViewEnabled()) {
    clearWaveformOverlays();
    removeSegmentationModeControls();
    return;
  }

  const overlays = getRenderableDiffs(state).flatMap((diff) => diff.overlays);
  const lanes = getWaveformLanes();
  const currentContainers = new Set(lanes.map((lane) => lane.container));
  for (const host of Array.from(document.querySelectorAll('div'))) {
    if (!(host instanceof HTMLElement) || !(host.shadowRoot instanceof ShadowRoot)) continue;
    host.shadowRoot.querySelectorAll('.bh-waveform-overlay-layer').forEach((layer) => {
      if (!(layer.parentElement instanceof HTMLElement) || !currentContainers.has(layer.parentElement)) {
        layer.remove();
      }
    });
  }

  for (const lane of lanes) {
    const laneItems = getLaneOverlayItems(lane, overlays, state.overlayMode);
    const existingLayers = getDirectOverlayLayers(lane.container);
    if (!laneItems.length) {
      existingLayers.forEach((layer) => layer.remove());
      continue;
    }

    const signature = getOverlaySignature(lane, laneItems, state.overlayMode);
    const existing = existingLayers[0] || null;
    if (existing && existing.dataset.bhWaveformOverlaySignature === signature) {
      existingLayers.slice(1).forEach((layer) => layer.remove());
      continue;
    }

    const layer = createElement('div', 'bh-waveform-overlay-layer');
    layer.dataset.bhWaveformOverlaySignature = signature;
    styleOverlayLayer(layer);
    for (const item of laneItems) {
      const start = Math.max(0, item.startSeconds);
      const end = Math.max(start + 0.01, item.endSeconds);
      const marker = createElement('div', 'bh-waveform-overlay');
      marker.dataset.kind = item.kind;
      marker.dataset.side = item.side;
      marker.dataset.changeKind = item.changeKind;
      marker.title = item.title;
      styleOverlayMarker(marker, item, start * lane.pxPerSecond, (end - start) * lane.pxPerSecond, state.overlayMode);
      const label = createElement('div', 'bh-waveform-overlay-label', item.label);
      styleOverlayLabel(label, item);
      marker.appendChild(label);
      layer.appendChild(marker);
    }

    if (getComputedStyle(lane.container).position === 'static') {
      lane.container.style.position = 'relative';
    }
    if (existing) {
      existing.replaceWith(layer);
      existingLayers.slice(1).forEach((extraLayer) => extraLayer.remove());
    } else {
      lane.container.appendChild(layer);
    }
  }
}

function renderDiffAugmentations(state: ExtendedDiffState) {
  applyTextDiffs(state);
  applyWaveformOverlays(state);
  renderSegmentationModeControls(state);
  document.documentElement.dataset.bhExtendedDiffDebug = JSON.stringify({
    visibleCompareLevel: getVisibleCompareLevel(),
    activeNativeUrl: state.activeNativeUrl,
    loadedUrlCount: state.loadedUrls.size,
    diffCount: state.diffs.length,
    renderableCount: getRenderableDiffs(state).length,
    lanes: getWaveformLanes().map((lane) => ({
      speakerLabel: lane.speakerLabel,
      speakerKeys: lane.speakerKeys,
      pxPerSecond: Math.round(lane.pxPerSecond * 100) / 100
    })),
    diffs: state.diffs.map((diff) => ({
      source: diff.source,
      referenceLevel: diff.referenceLevel,
      currentLevel: diff.currentLevel,
      pageLevel: diff.pageLevel,
      compareLevel: diff.compareLevel,
      textPatchCount: diff.textPatches.length,
      overlayCount: diff.overlays.length
    })),
    lastLoadError: state.lastLoadError
  });
}

async function loadAvailableDiffs(state: ExtendedDiffState) {
  if (state.loading) return;
  state.loading = true;
  try {
    const nativeEntries = discoverDiffUrlEntries();
    state.activeNativeUrl = nativeEntries.length ? nativeEntries[nativeEntries.length - 1].url : state.activeNativeUrl;
    const generatedUrls = nativeEntries.length ? [] : await discoverGeneratedDiffUrls(state);
    const entries: DiffUrlEntry[] = [
      ...nativeEntries,
      ...generatedUrls.map((url): DiffUrlEntry => ({ url, startTime: Number.MAX_SAFE_INTEGER, source: 'generated' }))
    ].filter((entry) => !state.loadedUrls.has(entry.url));

    for (const entry of entries) {
      const { url } = entry;
      try {
        const payloads = await fetchDiffUrl(url);
        state.loadedUrls.add(url);
        state.lastLoadError = '';
        for (const payload of payloads) {
          if (!payloadMentionsPageAction(payload)) continue;
          state.diffs.push(buildLoadedDiff(url, payload, entry.source));
        }
      } catch (error) {
        state.lastLoadError = error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    state.loading = false;
    renderDiffAugmentations(state);
  }
}

function resetForRoute(state: ExtendedDiffState) {
  state.loadedUrls.clear();
  state.loadedReviewActionUrls.clear();
  state.generatedDiffUrls.clear();
  state.activeNativeUrl = null;
  state.lastRenderedDiffKey = '';
  state.lastLoadError = '';
  state.diffs = [];
  state.loading = false;
  restoreNativeDiffCells();
  clearWaveformOverlays();
  removeSegmentationModeControls();
}

function tick(state: ExtendedDiffState) {
  if (!isFeedbackRoute()) {
    resetForRoute(state);
    return;
  }
  const routeKey = getRouteKey();
  if (state.routeKey !== routeKey) {
    state.routeKey = routeKey;
    resetForRoute(state);
  }
  void loadAvailableDiffs(state);
}

export function registerExtendedDiffViewService(helper: any) {
  if (!helper || helper.__extendedDiffViewRegistered) return;
  helper.__extendedDiffViewRegistered = true;
  const state: ExtendedDiffState = {
    timer: 0,
    routeKey: '',
    loading: false,
    lastLoadError: '',
    loadedUrls: new Set<string>(),
    loadedReviewActionUrls: new Set<string>(),
    generatedDiffUrls: new Set<string>(),
    activeNativeUrl: null,
    lastRenderedDiffKey: '',
    overlayMode: 'fusion',
    diffs: []
  };

  tick(state);
  state.timer = window.setInterval(() => tick(state), 1500);
  helper.unbindExtendedDiffView = function unbindExtendedDiffView() {
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = 0;
    }
    restoreNativeDiffCells();
    clearWaveformOverlays();
    removeSegmentationModeControls();
    helper.__extendedDiffViewRegistered = false;
  };
}
