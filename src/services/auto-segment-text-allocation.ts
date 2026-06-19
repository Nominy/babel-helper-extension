export type AutoSegmentTextSegment = {
  id: string;
  speakerKey: string;
  startSeconds: number;
  endSeconds: number;
};

export type AutoSegmentTextGroup = {
  speakerKey: string;
  fullText: string;
  segments: AutoSegmentTextSegment[];
};

export type AutoSegmentTextAllocation = {
  id: string;
  text: string;
};

export type AutoSegmentTextReviewMove = {
  fromIndex: number;
  toIndex: number;
  sentenceCount: number;
};

export type AutoSegmentTextReview = {
  acceptDraft?: boolean;
  moves?: AutoSegmentTextReviewMove[];
  notes?: string;
};

type DraftResult =
  | {
      ok: true;
      fullText: string;
      allocations: AutoSegmentTextAllocation[];
      sentenceUnitCount: number;
    }
  | {
      ok: false;
      reason: string;
      allocations: AutoSegmentTextAllocation[];
    };

type ReviewResult =
  | {
      ok: true;
      allocations: AutoSegmentTextAllocation[];
      notes: string;
      acceptedDraft: boolean;
    }
  | {
      ok: false;
      reason: string;
      allocations: AutoSegmentTextAllocation[];
    };

export function normalizeAutoSegmentText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function compactText(value: unknown): string {
  return normalizeAutoSegmentText(value).replace(/\s+/g, '');
}

function segmentDuration(segment: AutoSegmentTextSegment): number {
  const duration = Number(segment.endSeconds) - Number(segment.startSeconds);
  return Number.isFinite(duration) && duration > 0 ? duration : 0.001;
}

function validateGroup(group: AutoSegmentTextGroup): { ok: true } | { ok: false; reason: string } {
  const speakerKey = typeof group?.speakerKey === 'string' ? group.speakerKey.trim() : '';
  if (!speakerKey) {
    return { ok: false, reason: 'missing-speaker-key' };
  }

  const segments = Array.isArray(group?.segments) ? group.segments : [];
  if (!segments.length) {
    return { ok: false, reason: 'missing-segments' };
  }

  for (const segment of segments) {
    if (!segment || segment.speakerKey !== speakerKey) {
      return { ok: false, reason: 'mixed-speaker-group' };
    }
    if (
      typeof segment.id !== 'string' ||
      !segment.id ||
      !Number.isFinite(Number(segment.startSeconds)) ||
      !Number.isFinite(Number(segment.endSeconds)) ||
      Number(segment.endSeconds) <= Number(segment.startSeconds)
    ) {
      return { ok: false, reason: 'invalid-segment' };
    }
  }

  return { ok: true };
}

export function splitAutoSegmentSentenceUnits(text: string): string[] {
  const source = normalizeAutoSegmentText(text);
  const units: string[] = [];
  const pattern = /[^.!?]+[.!?]+(?:\s*\{[^}]+\})?/gu;
  let match: RegExpExecArray | null = null;
  let consumedUntil = 0;

  while ((match = pattern.exec(source))) {
    units.push(normalizeAutoSegmentText(match[0]));
    consumedUntil = pattern.lastIndex;
  }

  const tail = normalizeAutoSegmentText(source.slice(consumedUntil));
  if (tail) {
    units.push(tail);
  }

  return units;
}

function prefixLengths(units: string[]): number[] {
  const lengths = [0];
  for (let index = 0; index < units.length; index += 1) {
    lengths[index + 1] = lengths[index] + units[index].length + (index > 0 ? 1 : 0);
  }
  return lengths;
}

function textLengthBetween(lengths: number[], start: number, end: number): number {
  return lengths[end] - lengths[start] - (start > 0 ? 1 : 0);
}

function durationCost(charCount: number, duration: number, charsPerSecond: number): number {
  const expected = duration * charsPerSecond;
  const normalized = (charCount - expected) / Math.max(12, expected);
  return normalized * normalized;
}

function nearestWordBoundary(text: string, index: number, minIndex: number, maxIndex: number): number {
  const clamped = Math.max(minIndex, Math.min(maxIndex, Math.round(index)));
  if (/\s/u.test(text[clamped] || '')) {
    return clamped;
  }

  for (let offset = 1; offset <= 80; offset += 1) {
    const left = clamped - offset;
    const right = clamped + offset;
    if (left >= minIndex && /\s/u.test(text[left] || '')) {
      return left;
    }
    if (right <= maxIndex && /\s/u.test(text[right] || '')) {
      return right;
    }
  }

  return clamped;
}

function splitByDurationFallback(fullText: string, segments: AutoSegmentTextSegment[]): string[] {
  const source = normalizeAutoSegmentText(fullText);
  const totalDuration = segments.reduce((sum, segment) => sum + segmentDuration(segment), 0);
  const chunks: string[] = [];
  let cursor = 0;
  let elapsed = 0;

  for (let index = 0; index < segments.length; index += 1) {
    if (index === segments.length - 1) {
      chunks.push(normalizeAutoSegmentText(source.slice(cursor)));
      break;
    }

    elapsed += segmentDuration(segments[index]);
    const ideal = (elapsed / Math.max(0.001, totalDuration)) * source.length;
    const minIndex = cursor;
    const maxIndex = source.length - (segments.length - index - 1);
    const boundary = nearestWordBoundary(source, ideal, minIndex, maxIndex);
    chunks.push(normalizeAutoSegmentText(source.slice(cursor, boundary)));
    cursor = boundary;
  }

  return chunks;
}

function chooseSentenceChunks(fullText: string, segments: AutoSegmentTextSegment[]): string[] {
  const units = splitAutoSegmentSentenceUnits(fullText);
  const segmentCount = segments.length;
  const unitCount = units.length;
  if (!segmentCount) {
    return [];
  }
  if (unitCount < segmentCount) {
    return splitByDurationFallback(fullText, segments);
  }

  const totalChars = units.join(' ').length;
  const totalDuration = segments.reduce((sum, segment) => sum + segmentDuration(segment), 0);
  const charsPerSecond = totalChars / Math.max(0.001, totalDuration);
  const lengths = prefixLengths(units);
  const infinite = 1e12;
  const table = Array.from({ length: segmentCount + 1 }, () => Array(unitCount + 1).fill(infinite));
  const previous = Array.from({ length: segmentCount + 1 }, () => Array(unitCount + 1).fill(-1));

  table[0][0] = 0;
  for (let segmentIndex = 1; segmentIndex <= segmentCount; segmentIndex += 1) {
    const minUnits = segmentIndex;
    const maxUnits = unitCount - (segmentCount - segmentIndex);
    for (let unitEnd = minUnits; unitEnd <= maxUnits; unitEnd += 1) {
      for (let unitStart = segmentIndex - 1; unitStart < unitEnd; unitStart += 1) {
        const charCount = textLengthBetween(lengths, unitStart, unitEnd);
        const cost =
          table[segmentIndex - 1][unitStart] +
          durationCost(charCount, segmentDuration(segments[segmentIndex - 1]), charsPerSecond);
        if (cost < table[segmentIndex][unitEnd]) {
          table[segmentIndex][unitEnd] = cost;
          previous[segmentIndex][unitEnd] = unitStart;
        }
      }
    }
  }

  if (!Number.isFinite(table[segmentCount][unitCount]) || previous[segmentCount][unitCount] < 0) {
    return splitByDurationFallback(fullText, segments);
  }

  const chunks: string[] = [];
  let cursor = unitCount;
  for (let segmentIndex = segmentCount; segmentIndex >= 1; segmentIndex -= 1) {
    const nextCursor = previous[segmentIndex][cursor];
    chunks.push(units.slice(nextCursor, cursor).join(' '));
    cursor = nextCursor;
  }

  return chunks.reverse();
}

export function validateAutoSegmentTextAllocationsPreserveText(
  group: AutoSegmentTextGroup,
  allocations: AutoSegmentTextAllocation[]
): boolean {
  if (!Array.isArray(allocations) || allocations.length !== group.segments.length) {
    return false;
  }

  for (let index = 0; index < group.segments.length; index += 1) {
    if (!allocations[index] || allocations[index].id !== group.segments[index].id) {
      return false;
    }
  }

  const originalText = compactText(group.fullText);
  const nextText = compactText(allocations.map((allocation) => allocation.text).join(' '));
  return originalText === nextText;
}

export function createAutoSegmentTextRedistributionDraft(group: AutoSegmentTextGroup): DraftResult {
  const validation = validateGroup(group);
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason,
      allocations: []
    };
  }

  const fullText = normalizeAutoSegmentText(group.fullText);
  if (!fullText) {
    return {
      ok: true,
      fullText,
      allocations: group.segments.map((segment) => ({ id: segment.id, text: '' })),
      sentenceUnitCount: 0
    };
  }

  const chunks = chooseSentenceChunks(fullText, group.segments);
  const allocations = group.segments.map((segment, index) => ({
    id: segment.id,
    text: normalizeAutoSegmentText(chunks[index] || '')
  }));

  if (!validateAutoSegmentTextAllocationsPreserveText({ ...group, fullText }, allocations)) {
    return {
      ok: false,
      reason: 'draft-text-mismatch',
      allocations: []
    };
  }

  return {
    ok: true,
    fullText,
    allocations,
    sentenceUnitCount: splitAutoSegmentSentenceUnits(fullText).length
  };
}

function applyReviewMove(chunks: string[], move: AutoSegmentTextReviewMove): boolean {
  const fromIndex = Math.round(Number(move && move.fromIndex)) - 1;
  const toIndex = Math.round(Number(move && move.toIndex)) - 1;
  const sentenceCount = Math.round(Number(move && move.sentenceCount));
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    Math.abs(fromIndex - toIndex) !== 1 ||
    !Number.isInteger(sentenceCount) ||
    sentenceCount < 1 ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= chunks.length ||
    toIndex >= chunks.length
  ) {
    return false;
  }

  const fromUnits = splitAutoSegmentSentenceUnits(chunks[fromIndex]);
  const toUnits = splitAutoSegmentSentenceUnits(chunks[toIndex]);
  if (sentenceCount > fromUnits.length) {
    return false;
  }

  if (toIndex > fromIndex) {
    const moved = fromUnits.splice(fromUnits.length - sentenceCount, sentenceCount);
    toUnits.unshift(...moved);
  } else {
    const moved = fromUnits.splice(0, sentenceCount);
    toUnits.push(...moved);
  }

  chunks[fromIndex] = normalizeAutoSegmentText(fromUnits.join(' '));
  chunks[toIndex] = normalizeAutoSegmentText(toUnits.join(' '));
  return true;
}

export function applyAutoSegmentTextReview(
  group: AutoSegmentTextGroup,
  draftAllocations: AutoSegmentTextAllocation[],
  review: AutoSegmentTextReview
): ReviewResult {
  if (!review || !Array.isArray(review.moves)) {
    return {
      ok: false,
      reason: 'invalid-review',
      allocations: draftAllocations
    };
  }

  if (!validateAutoSegmentTextAllocationsPreserveText(group, draftAllocations)) {
    return {
      ok: false,
      reason: 'invalid-draft',
      allocations: draftAllocations
    };
  }

  const chunks = draftAllocations.map((allocation) => normalizeAutoSegmentText(allocation.text));
  for (const move of review.moves) {
    if (!applyReviewMove(chunks, move)) {
      return {
        ok: false,
        reason: 'invalid-review-move',
        allocations: draftAllocations
      };
    }
  }

  const allocations = group.segments.map((segment, index) => ({
    id: segment.id,
    text: chunks[index]
  }));

  if (!validateAutoSegmentTextAllocationsPreserveText(group, allocations)) {
    return {
      ok: false,
      reason: 'review-text-mismatch',
      allocations: draftAllocations
    };
  }

  return {
    ok: true,
    allocations,
    notes: typeof review.notes === 'string' ? review.notes : '',
    acceptedDraft: Boolean(review.acceptDraft)
  };
}
