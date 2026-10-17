import { tokenizeTranscriptText } from '../features/custom-linter/linter/text-context';

export type L0WordTimingToken = {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type L0WordTimingTrack = {
  lane: string;
  tokens: readonly L0WordTimingToken[];
};

export type L0TimingIndex = {
  taskId: string;
  tracks: readonly L0WordTimingTrack[];
};

export type TimedOffsetRange = {
  startSeconds: number;
  endSeconds: number;
};

type TextWord = {
  normalized: string;
  start: number;
  end: number;
};

type TimedWord = L0WordTimingToken & {
  normalized: string;
};

type Anchor = {
  textWord: TextWord;
  timedWord: TimedWord;
};

type ControlPoint = {
  time: number;
  offset: number;
};


// Listener and consumers can be bundled separately. Only the listener's copied,
// deeply frozen publication may use identity as a timing revision.
const PUBLISHED_TOKENS = Symbol.for('babel-helper:published-l0-timing-tokens');

export function freezePublishedL0TimingIndex(index: L0TimingIndex): L0TimingIndex {
  for (const track of index.tracks) {
    for (const token of track.tokens) Object.freeze(token);
    Object.defineProperty(track.tokens, PUBLISHED_TOKENS, { value: true });
    Object.freeze(track.tokens);
    Object.freeze(track);
  }
  Object.defineProperty(index.tracks, PUBLISHED_TOKENS, { value: true });
  Object.freeze(index.tracks);
  return Object.freeze(index);
}

export function isPublishedL0TimingIndex(index: L0TimingIndex): boolean {
  return Object.isFrozen(index) && Object.isFrozen(index.tracks) &&
    (index.tracks as unknown as Record<symbol, unknown>)[PUBLISHED_TOKENS] === true;
}

type PreparedLane = {
  words: TimedWord[];
  maxEnds: number[];
};

export type PreparedL0TimingAlignment = {
  textLength: number;
  startSeconds: number;
  endSeconds: number;
  textWords: TextWord[];
  startsByWord: Map<TextWord, number>;
  playbackPoints: ControlPoint[];
  seekPoints: ControlPoint[];
};

function lowerBound(length: number, before: (index: number) => boolean, start = 0): number {
  let end = length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (before(middle)) start = middle + 1;
    else end = middle;
  }
  return start;
}

function prepareLane(tokens: readonly L0WordTimingToken[]): PreparedLane {
  const words = tokens
    .map((token) => ({ ...token, normalized: normalizeL0TimingWord(token.text) }))
    .filter((token) => token.normalized !== '')
    .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  let maxEnd = -Infinity;
  const maxEnds = words.map((word) => (maxEnd = Math.max(maxEnd, word.endSeconds)));
  return { words, maxEnds };
}

function wordsInRange(lane: PreparedLane, range: TimedOffsetRange): TimedWord[] {
  const end = lowerBound(lane.words.length, (index) => lane.words[index].startSeconds < range.endSeconds);
  const start = lowerBound(end, (index) => lane.maxEnds[index] <= range.startSeconds);
  const words: TimedWord[] = [];
  for (let index = start; index < end; index += 1) {
    const word = lane.words[index];
    if (word.endSeconds > range.startSeconds) words.push(word);
  }
  return words;
}

function prepareAlignment(
  text: string,
  timedWords: readonly TimedWord[],
  range: TimedOffsetRange
): PreparedL0TimingAlignment | null {
  if (typeof text !== 'string' || !text ||
      !Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds) ||
      range.endSeconds <= range.startSeconds) return null;
  const textWords = tokenizeL0TimingText(text);
  const anchors = findL0TimingAnchors(textWords, timedWords);
  if (!anchors.length) return null;
  const playbackPoints: ControlPoint[] = [{ time: range.startSeconds, offset: 0 }];
  // Published clocks share these points. Keep the legacy inverse mapping for
  // arbitrary callers with reversed clocks without doubling normal preparation.
  const seekPoints: ControlPoint[] = anchors.some(({ timedWord }) =>
    timedWord.endSeconds < timedWord.startSeconds)
    ? [{ time: range.startSeconds, offset: 0 }] : playbackPoints;
  const startsByWord = new Map<TextWord, number>();
  for (const anchor of anchors) {
    const start = Math.max(range.startSeconds, Math.min(range.endSeconds, anchor.timedWord.startSeconds));
    const end = Math.max(range.startSeconds, Math.min(range.endSeconds, anchor.timedWord.endSeconds));
    startsByWord.set(anchor.textWord, start);
    appendControlPoint(playbackPoints, start, anchor.textWord.start);
    appendControlPoint(playbackPoints, Math.max(start, end), anchor.textWord.end);
    if (seekPoints !== playbackPoints) {
      appendControlPoint(seekPoints, start, anchor.textWord.start);
      appendControlPoint(seekPoints, end, anchor.textWord.end);
    }
  }
  appendControlPoint(playbackPoints, range.endSeconds, text.length);
  if (seekPoints !== playbackPoints) appendControlPoint(seekPoints, range.endSeconds, text.length);
  return { textLength: text.length, startSeconds: range.startSeconds, endSeconds: range.endSeconds,
    textWords, startsByWord, playbackPoints, seekPoints };
}

/** Bounded to one active revision and the latest relevant row per lane. */
export function createL0TimingAlignmentCache() {
  type Entry = {
    lane: PreparedLane;
    rowKey: unknown;
    hasRow: boolean;
    text: string;
    startSeconds: number;
    endSeconds: number;
    alignment: PreparedL0TimingAlignment | null;
  };
  let currentIndex: L0TimingIndex | null = null;
  const entries = new Map<L0WordTimingTrack, Entry>();
  const statistics = { lanePreparations: 0, alignmentPreparations: 0, tokenVisits: 0 };
  return {
    clear() {
      currentIndex = null;
      entries.clear();
    },
    retainRows(isRelevant: (rowKey: unknown) => boolean) {
      for (const entry of entries.values()) {
        if (entry.hasRow && !isRelevant(entry.rowKey)) {
          entry.hasRow = false;
          entry.rowKey = null;
          entry.text = '';
          entry.alignment = null;
        }
      }
    },
    getStatistics() {
      let rows = 0;
      for (const entry of entries.values()) if (entry.hasRow) rows += 1;
      return { ...statistics, lanes: entries.size, rows };
    },
    get(index: L0TimingIndex, track: L0WordTimingTrack, rowKey: unknown, text: string, range: TimedOffsetRange) {
      if (currentIndex !== index) {
        entries.clear();
        currentIndex = index;
      }
      let entry = entries.get(track);
      if (entry?.hasRow && entry.rowKey === rowKey && entry.text === text &&
          entry.startSeconds === range.startSeconds && entry.endSeconds === range.endSeconds) {
        return entry.alignment;
      }
      const published = entry !== undefined || (isPublishedL0TimingIndex(index) && Object.isFrozen(track) &&
        Object.isFrozen(track.tokens) &&
        (track.tokens as unknown as Record<symbol, unknown>)[PUBLISHED_TOKENS] === true);
      // Unpublished arrays remain live inputs, including in-place edits. They
      // must never acquire an identity-based cache merely by being observed.
      if (!published) {
        entries.delete(track);
        statistics.lanePreparations += 1;
        statistics.tokenVisits += track.tokens.length;
        statistics.alignmentPreparations += 1;
        return prepareAlignment(text, getTimedWords(track.tokens, range), range);
      }
      if (!entry) {
        statistics.lanePreparations += 1;
        statistics.tokenVisits += track.tokens.length;
        entry = { lane: prepareLane(track.tokens), rowKey, hasRow: true, text,
          startSeconds: range.startSeconds, endSeconds: range.endSeconds, alignment: null };
      }
      statistics.alignmentPreparations += 1;
      entry.hasRow = true;
      entry.rowKey = rowKey;
      entry.text = text;
      entry.startSeconds = range.startSeconds;
      entry.endSeconds = range.endSeconds;
      entry.alignment = prepareAlignment(text, wordsInRange(entry.lane, range), range);
      entries.set(track, entry);
      return entry.alignment;
    }
  };
}

export function computePreparedL0TimestampAtCharacterOffset(
  alignment: PreparedL0TimingAlignment | null,
  characterOffset: number
): number | null {
  if (!alignment || !Number.isFinite(characterOffset)) return null;
  const { textLength, textWords, startsByWord, seekPoints: points, endSeconds } = alignment;
  const offset = Math.max(0, Math.min(textLength, Math.round(characterOffset)));
  const wordIndex = lowerBound(textWords.length, (index) => textWords[index].end < offset);
  const word = textWords[wordIndex];
  if (word && offset >= word.start) {
    const start = startsByWord.get(word);
    if (start !== undefined) return start;
  }
  const index = lowerBound(points.length, (index) => points[index].offset < offset, 1);
  if (index === points.length) return endSeconds;
  const right = points[index];
  const left = points[index - 1];
  if (right.offset <= left.offset) return right.time;
  const ratio = (offset - left.offset) / (right.offset - left.offset);
  return left.time + ratio * (right.time - left.time);
}

export function computePreparedL0TimedCharacterOffset(
  alignment: PreparedL0TimingAlignment | null,
  playbackTime: number
): number | null {
  if (!alignment || !Number.isFinite(playbackTime)) return null;
  const { textLength, playbackPoints: points, startSeconds, endSeconds } = alignment;
  const time = Math.max(startSeconds, Math.min(endSeconds, playbackTime));
  let index = 1;
  let end = points.length;
  while (index < end) {
    const middle = (index + end) >>> 1;
    if (points[middle].time < time) index = middle + 1;
    else end = middle;
  }
  if (index === points.length) return textLength;
  const right = points[index];
  const left = points[index - 1];
  if (right.time <= left.time) return Math.max(0, Math.min(textLength, right.offset));
  const ratio = (time - left.time) / (right.time - left.time);
  const offset = Math.round(left.offset + ratio * (right.offset - left.offset));
  return Math.max(0, Math.min(textLength, offset));
}

export function normalizeL0TimingWord(value: string): string {
  if (typeof value !== 'string' || !value) return '';
  const words = tokenizeTranscriptText(value).filter((token) => token.kind === 'word');
  if (words.length !== 1) return '';
  return words[0].text.toLocaleLowerCase().replace(/ё/g, 'е');
}

export function tokenizeL0TimingText(text: string): TextWord[] {
  if (typeof text !== 'string' || !text) return [];
  return tokenizeTranscriptText(text)
    .filter((token) => token.kind === 'word')
    .map((token) => ({
      normalized: token.text.toLocaleLowerCase().replace(/ё/g, 'е'),
      start: token.start,
      end: token.end
    }));
}

function getTimedWords(tokens: readonly L0WordTimingToken[], range: TimedOffsetRange): TimedWord[] {
  return tokens
    .filter(
      (token) =>
        token.startSeconds < range.endSeconds &&
        token.endSeconds > range.startSeconds
    )
    .map((token) => ({ ...token, normalized: normalizeL0TimingWord(token.text) }))
    .filter((token) => token.normalized !== '')
    .sort(
      (left, right) =>
        left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds
    );
}

/** Finds a maximum monotonic sequence of normalized exact-word matches. */
export function findL0TimingAnchors(
  textWords: readonly TextWord[],
  timedWords: readonly TimedWord[]
): Anchor[] {
  const textCount = textWords.length;
  const timedCount = timedWords.length;
  if (textCount === 0 || timedCount === 0) return [];

  const lengths = Array.from({ length: textCount + 1 }, () => new Uint32Array(timedCount + 1));
  for (let textIndex = 1; textIndex <= textCount; textIndex += 1) {
    for (let timedIndex = 1; timedIndex <= timedCount; timedIndex += 1) {
      lengths[textIndex][timedIndex] =
        textWords[textIndex - 1].normalized === timedWords[timedIndex - 1].normalized
          ? lengths[textIndex - 1][timedIndex - 1] + 1
          : Math.max(lengths[textIndex - 1][timedIndex], lengths[textIndex][timedIndex - 1]);
    }
  }

  const anchors: Anchor[] = [];
  let textIndex = textCount;
  let timedIndex = timedCount;
  while (textIndex > 0 && timedIndex > 0) {
    if (textWords[textIndex - 1].normalized === timedWords[timedIndex - 1].normalized) {
      anchors.push({
        textWord: textWords[textIndex - 1],
        timedWord: timedWords[timedIndex - 1]
      });
      textIndex -= 1;
      timedIndex -= 1;
    } else if (lengths[textIndex - 1][timedIndex] >= lengths[textIndex][timedIndex - 1]) {
      textIndex -= 1;
    } else {
      timedIndex -= 1;
    }
  }

  anchors.reverse();
  return anchors;
}


/**
 * Finds an exact boundary when maximum exact-word alignments agree locally.
 * Overlaps elsewhere in the segment do not invalidate this boundary. Callers
 * can use playback interpolation when the local exact evidence is ambiguous.
 */
export function computeL0CutBoundaryCharacterOffset(
  text: string,
  tokens: readonly L0WordTimingToken[],
  range: TimedOffsetRange,
  cutSeconds: number
): number | null {
  if (!text || !Number.isFinite(cutSeconds) ||
      !Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds) ||
      range.endSeconds <= range.startSeconds ||
      cutSeconds < range.startSeconds || cutSeconds > range.endSeconds) return null;

  const textTokens = tokenizeTranscriptText(text);
  const textWords = textTokens.filter((token) => token.kind === 'word').map((token) => ({
    normalized: token.text.toLocaleLowerCase().replace(/ё/g, 'е'),
    start: token.start,
    end: token.end
  }));
  // Keep unrecognized timed tokens: silently dropping one would invent adjacency.
  const timedWords = tokens.filter((token) =>
    token.startSeconds < range.endSeconds && token.endSeconds > range.startSeconds
  ).map((token) => ({ ...token, normalized: normalizeL0TimingWord(token.text) }))
    .sort((left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds);
  const n = textWords.length;
  const m = timedWords.length;
  if (!n || !m || timedWords.some(word =>
    !Number.isFinite(word.startSeconds) || !Number.isFinite(word.endSeconds) ||
    word.endSeconds <= word.startSeconds
  )) return null;

  const before = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  const after = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      before[i + 1][j + 1] = textWords[i].normalized === timedWords[j].normalized
        ? before[i][j] + 1 : Math.max(before[i][j + 1], before[i + 1][j]);
    }
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      after[i][j] = textWords[i].normalized === timedWords[j].normalized
        ? after[i + 1][j + 1] + 1 : Math.max(after[i + 1][j], after[i][j + 1]);
    }
  }
  const best = before[n][m];
  if (!best) return null;
  const requiredTextAnchor = (j: number): number | null => {
    let match: number | null = null;
    for (let i = 0; i <= n; i += 1) {
      // If an equally good alignment can omit this clock, it is not evidence.
      if (before[i][j] + after[i][j + 1] === best) return null;
      if (i < n && textWords[i].normalized === timedWords[j].normalized &&
          before[i][j] + 1 + after[i + 1][j + 1] === best) {
        if (match !== null) return null;
        match = i;
      }
    }
    return match;
  };

  // Inside a uniquely matched word, retain the completed-word convention:
  // the active word belongs on the right, never split its characters.
  const next = timedWords.findIndex((word) => word.endSeconds > cutSeconds);
  const right = next === -1 ? m : next;
  if (right > 0 && right < m && timedWords[right - 1].endSeconds > timedWords[right].startSeconds) return null;
  if (right + 1 < m && timedWords[right + 1].startSeconds <= cutSeconds) return null;
  const leftText = right > 0 ? requiredTextAnchor(right - 1) : null;
  const rightText = right < m ? requiredTextAnchor(right) : null;
  if (right === 0) return rightText === 0 ? 0 : null;
  if (right === m) return leftText === n - 1 ? text.length : null;
  if (leftText === null || rightText !== leftText + 1) return null;

  // The allocator floors to whitespace. Carry adjacent punctuation/whole tags
  // with the completed word, but never cross another word or cut inside a tag.
  let offset = textWords[leftText].end;
  for (const token of textTokens) {
    if (token.end <= offset) continue;
    if (token.kind === 'space') return offset;
    if (token.kind === 'word') return null;
    offset = token.end;
  }
  return offset;
}

export function computeL0TimestampAtCharacterOffset(
  text: string,
  tokens: readonly L0WordTimingToken[],
  range: TimedOffsetRange,
  characterOffset: number
): number | null {
  if (!Number.isFinite(characterOffset)) return null;
  return computePreparedL0TimestampAtCharacterOffset(
    prepareAlignment(text, getTimedWords(tokens, range), range), characterOffset);
}

function appendControlPoint(points: ControlPoint[], time: number, offset: number): void {
  const previous = points[points.length - 1];
  if (previous && time < previous.time) return;
  if (previous && time === previous.time) {
    previous.offset = Math.max(previous.offset, offset);
    return;
  }
  points.push({ time, offset });
}

/**
 * Maps absolute playback time to a current-text character offset. Exact matches
 * pin both ends of a spoken token; gaps are interpolated only between the
 * surrounding pins, so an edited or mismatched middle cannot drift past the
 * next known word.
 */
export function computeL0TimedCharacterOffset(
  text: string,
  tokens: readonly L0WordTimingToken[],
  range: TimedOffsetRange,
  playbackTime: number
): number | null {
  if (!Number.isFinite(playbackTime)) return null;
  return computePreparedL0TimedCharacterOffset(
    prepareAlignment(text, getTimedWords(tokens, range), range), playbackTime);
}
