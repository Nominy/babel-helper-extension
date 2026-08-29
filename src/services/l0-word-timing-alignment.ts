import { tokenizeTranscriptText } from '../features/custom-linter/linter/text-context';

export type L0WordTimingToken = {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type L0WordTimingTrack = {
  lane: string;
  tokens: L0WordTimingToken[];
};

export type L0TimingIndex = {
  taskId: string;
  tracks: L0WordTimingTrack[];
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

export function computeL0CompletedWordCharacterOffset(
  text: string,
  tokens: readonly L0WordTimingToken[],
  range: TimedOffsetRange,
  playbackTime: number
): number | null {
  if (
    typeof text !== 'string' ||
    !text ||
    !Number.isFinite(playbackTime) ||
    !Number.isFinite(range.startSeconds) ||
    !Number.isFinite(range.endSeconds) ||
    range.endSeconds <= range.startSeconds
  ) {
    return null;
  }
  const anchors = findL0TimingAnchors(
    tokenizeL0TimingText(text),
    getTimedWords(tokens, range)
  );
  if (!anchors.length) {
    return null;
  }
  let completedOffset: number | null = null;
  for (const anchor of anchors) {
    if (anchor.timedWord.endSeconds > playbackTime) {
      break;
    }
    completedOffset = anchor.textWord.end;
  }
  if (completedOffset === null) {
    return 0;
  }
  while (
    completedOffset < text.length &&
    !/\s/u.test(text[completedOffset]) &&
    !/[\p{L}\p{N}]/u.test(text[completedOffset])
  ) {
    completedOffset += 1;
  }
  return completedOffset;
}

export function computeL0TimestampAtCharacterOffset(
  text: string,
  tokens: readonly L0WordTimingToken[],
  range: TimedOffsetRange,
  characterOffset: number
): number | null {
  if (
    typeof text !== 'string' ||
    !text ||
    !Number.isFinite(characterOffset) ||
    !Number.isFinite(range.startSeconds) ||
    !Number.isFinite(range.endSeconds) ||
    range.endSeconds <= range.startSeconds
  ) {
    return null;
  }
  const textWords = tokenizeL0TimingText(text);
  const anchors = findL0TimingAnchors(textWords, getTimedWords(tokens, range));
  if (!anchors.length) {
    return null;
  }
  const offset = Math.max(0, Math.min(text.length, Math.round(characterOffset)));
  const clickedWord = textWords.find(
    (word) => offset >= word.start && offset <= word.end
  );
  if (clickedWord) {
    const exactAnchor = anchors.find((anchor) => anchor.textWord === clickedWord);
    if (exactAnchor) {
      return Math.max(
        range.startSeconds,
        Math.min(range.endSeconds, exactAnchor.timedWord.startSeconds)
      );
    }
  }

  const points: ControlPoint[] = [{ time: range.startSeconds, offset: 0 }];
  for (const anchor of anchors) {
    appendControlPoint(
      points,
      Math.max(range.startSeconds, Math.min(range.endSeconds, anchor.timedWord.startSeconds)),
      anchor.textWord.start
    );
    appendControlPoint(
      points,
      Math.max(range.startSeconds, Math.min(range.endSeconds, anchor.timedWord.endSeconds)),
      anchor.textWord.end
    );
  }
  appendControlPoint(points, range.endSeconds, text.length);
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (offset > right.offset) continue;
    const left = points[index - 1];
    if (right.offset <= left.offset) {
      return right.time;
    }
    const ratio = (offset - left.offset) / (right.offset - left.offset);
    return left.time + ratio * (right.time - left.time);
  }
  return range.endSeconds;
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
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    !Number.isFinite(playbackTime) ||
    !Number.isFinite(range.startSeconds) ||
    !Number.isFinite(range.endSeconds) ||
    range.endSeconds <= range.startSeconds
  ) {
    return null;
  }

  const textWords = tokenizeL0TimingText(text);
  const timedWords = getTimedWords(tokens, range);
  const anchors = findL0TimingAnchors(textWords, timedWords);
  if (anchors.length === 0) return null;

  const points: ControlPoint[] = [{ time: range.startSeconds, offset: 0 }];
  for (const anchor of anchors) {
    const start = Math.max(range.startSeconds, Math.min(range.endSeconds, anchor.timedWord.startSeconds));
    const end = Math.max(start, Math.min(range.endSeconds, anchor.timedWord.endSeconds));
    appendControlPoint(points, start, anchor.textWord.start);
    appendControlPoint(points, end, anchor.textWord.end);
  }
  appendControlPoint(points, range.endSeconds, text.length);

  const time = Math.max(range.startSeconds, Math.min(range.endSeconds, playbackTime));
  for (let index = 1; index < points.length; index += 1) {
    const right = points[index];
    if (time > right.time) continue;
    const left = points[index - 1];
    if (right.time <= left.time) return Math.max(0, Math.min(text.length, right.offset));
    const ratio = (time - left.time) / (right.time - left.time);
    const offset = Math.round(left.offset + ratio * (right.offset - left.offset));
    return Math.max(0, Math.min(text.length, offset));
  }

  return text.length;
}
