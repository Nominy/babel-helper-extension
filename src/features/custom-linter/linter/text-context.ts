export type TextRange = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptTokenKind = 'word' | 'space' | 'tag' | 'punctuation' | 'symbol';

export type TranscriptToken = TextRange & {
  kind: TranscriptTokenKind;
};

export type TranscriptTextContext = {
  text: string;
  tokens: TranscriptToken[];
  getEnclosingGenericTagRange(index: number): TextRange | null;
  isRangeInsideGenericTag(start: number, end: number): boolean;
};

const GENERIC_TAG_DELIMITERS: ReadonlyArray<readonly [string, string]> = [
  ['<', '>'],
  ['{', '}'],
  ['[', ']']
];

export function isWordCharacter(char: string): boolean {
  return typeof char === 'string' && /[\p{L}\p{N}]/u.test(char);
}

export function isTokenWordCharacter(char: string): boolean {
  return typeof char === 'string' && /[\p{L}\p{N}\p{M}_]/u.test(char);
}

export function getEnclosingGenericTagRange(text: string, index: number): TextRange | null {
  if (typeof text !== 'string' || index < 0 || index >= text.length) {
    return null;
  }

  for (const [openChar, closeChar] of GENERIC_TAG_DELIMITERS) {
    const openIndex = text.lastIndexOf(openChar, index);
    const closeBeforeIndex = text.lastIndexOf(closeChar, index);
    if (openIndex === -1 || closeBeforeIndex > openIndex) {
      continue;
    }

    const closeIndex = text.indexOf(closeChar, index);
    if (closeIndex === -1) {
      continue;
    }

    return {
      start: openIndex,
      end: closeIndex + 1,
      text: text.slice(openIndex, closeIndex + 1)
    };
  }

  return null;
}

export function isRangeInsideGenericTag(text: string, start: number, end: number): boolean {
  const tagRange = getEnclosingGenericTagRange(text, start);
  return Boolean(tagRange && end <= tagRange.end);
}

function getGenericTagAtStart(text: string, index: number): TextRange | null {
  const delimiter = GENERIC_TAG_DELIMITERS.find(([openChar]) => text[index] === openChar);
  if (!delimiter) {
    return null;
  }

  const [, closeChar] = delimiter;
  const closeIndex = text.indexOf(closeChar, index + 1);
  if (closeIndex === -1) {
    return null;
  }

  return {
    start: index,
    end: closeIndex + 1,
    text: text.slice(index, closeIndex + 1)
  };
}

function isWordTokenContinuation(text: string, index: number): boolean {
  const char = text[index];
  return (
    isTokenWordCharacter(char) ||
    (
      char === '-' &&
      isTokenWordCharacter(text[index - 1]) &&
      isTokenWordCharacter(text[index + 1])
    )
  );
}

export function tokenizeTranscriptText(text: string): TranscriptToken[] {
  if (typeof text !== 'string' || !text) {
    return [];
  }

  const tokens: TranscriptToken[] = [];
  let index = 0;

  while (index < text.length) {
    const tag = getGenericTagAtStart(text, index);
    if (tag) {
      tokens.push({ ...tag, kind: 'tag' });
      index = tag.end;
      continue;
    }

    const char = text[index];
    const start = index;
    let kind: TranscriptTokenKind;

    if (/\s/u.test(char)) {
      kind = 'space';
      while (index < text.length && /\s/u.test(text[index])) {
        index += 1;
      }
    } else if (isTokenWordCharacter(char)) {
      kind = 'word';
      while (index < text.length && isWordTokenContinuation(text, index)) {
        index += 1;
      }

    } else if (/[.,?!:;"'()-]/u.test(char)) {
      kind = 'punctuation';
      index += 1;
    } else {
      kind = 'symbol';
      index += 1;
    }

    tokens.push({
      kind,
      start,
      end: index,
      text: text.slice(start, index)
    });
  }

  return tokens;
}
function isWordToken(token: TranscriptToken | undefined): token is TranscriptToken {
  return Boolean(token && token.kind === 'word');
}

function isLetterOnlyWordToken(token: TranscriptToken | undefined): token is TranscriptToken {
  return Boolean(token && token.kind === 'word' && /^\p{L}+(?:-\p{L}+)*$/u.test(token.text));
}

export function getNormalizedStutterMatches(text: string): TextRange[] {
  const tokens = tokenizeTranscriptText(text);
  const invalidFragmentIndexes = new Set<number>();

  for (let index = 0; index < tokens.length; index += 1) {
    let cursor = index;
    const fragmentIndexes: number[] = [];
    let terminalWord: TranscriptToken | undefined;

    while (true) {
      const fragment = tokens[cursor];
      const dash = tokens[cursor + 1];
      const whitespace = tokens[cursor + 2];
      const followingWord = tokens[cursor + 3];
      if (
        !isLetterOnlyWordToken(fragment) ||
        dash?.kind !== 'punctuation' ||
        dash.text !== '-' ||
        whitespace?.kind !== 'space' ||
        !isWordToken(followingWord)
      ) {
        fragmentIndexes.length = 0;
        break;
      }

      fragmentIndexes.push(cursor);
      if (fragment.text.length > followingWord.text.length) {
        invalidFragmentIndexes.add(cursor);
      }
      const nextDash = tokens[cursor + 4];
      const nextWhitespace = tokens[cursor + 5];
      if (
        isLetterOnlyWordToken(followingWord) &&
        nextDash?.kind === 'punctuation' &&
        nextDash.text === '-' &&
        nextWhitespace?.kind === 'space'
      ) {
        cursor += 3;
        continue;
      }

      terminalWord = followingWord;
      break;
    }

    if (!terminalWord) {
      continue;
    }
    const normalizedTerminalWord = terminalWord.text.toLowerCase();
    for (const fragmentIndex of fragmentIndexes) {
      const fragmentText = tokens[fragmentIndex].text;
      if (!normalizedTerminalWord.includes(fragmentText.toLowerCase())) {
        invalidFragmentIndexes.add(fragmentIndex);
      }
    }
  }

  return [...invalidFragmentIndexes]
    .sort((left, right) => left - right)
    .map((index) => {
      const { start, end, text: fragmentText } = tokens[index];
      return { start, end, text: fragmentText };
    });
}

export function createTranscriptTextContext(text: string): TranscriptTextContext {
  const sourceText = typeof text === 'string' ? text : '';

  return {
    text: sourceText,
    tokens: tokenizeTranscriptText(sourceText),
    getEnclosingGenericTagRange(index: number) {
      return getEnclosingGenericTagRange(sourceText, index);
    },
    isRangeInsideGenericTag(start: number, end: number) {
      return isRangeInsideGenericTag(sourceText, start, end);
    }
  };
}
