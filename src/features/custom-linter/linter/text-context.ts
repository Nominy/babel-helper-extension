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
      while (index < text.length && isTokenWordCharacter(text[index])) {
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
