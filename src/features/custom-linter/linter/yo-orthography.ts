import dictionary from './data/yo-exceptions.json';
import { tokenizeTranscriptText, type TextRange, type TranscriptTextContext } from './text-context';

const yoExceptions = new Set(dictionary.words);
const hasYo = /[ёЁ]|[еЕ]\u0308/u;
const yoLetters = /[ёЁ]|[еЕ]\u0308/gu;
const startsWithCapital = /^[\p{Lu}\p{Lt}]/u;

export function getUnnecessaryYoMatches(text: string, textContext?: TranscriptTextContext): TextRange[] {
  if (!hasYo.test(text)) {
    return [];
  }
  const tokens = textContext?.text === text ? textContext.tokens : tokenizeTranscriptText(text);
  const matches: TextRange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'word') {
      continue;
    }
    let end = token.end;
    // The shared tokenizer joins ASCII hyphens; also recognize typographic
    // hyphens before the separate dash-normalization rule has been applied.
    while (/^[\u2010\u2011]$/u.test(tokens[index + 1]?.text ?? '') && tokens[index + 2]?.kind === 'word') {
      index += 2;
      end = tokens[index].end;
    }
    const word = end === token.end ? token.text : text.slice(token.start, end);
    if (!hasYo.test(word) || startsWithCapital.test(word) || yoExceptions.has(word.normalize('NFC').toLowerCase().replace(/[\u2010\u2011]/gu, '-'))) {
      continue;
    }
    // Preserve exact compounds and exception components followed by particles.
    // Match complete components, never substrings of a larger word.
    for (const part of word.matchAll(/[^-\u2010\u2011]+/gu)) {
      if (!hasYo.test(part[0]) || startsWithCapital.test(part[0]) || yoExceptions.has(part[0].normalize('NFC').toLowerCase())) {
        continue;
      }
      const start = token.start + part.index!;
      matches.push({ start, end: start + part[0].length, text: part[0] });
    }
  }
  return matches;
}

export function fixUnnecessaryYo(text: string): string {
  const matches = getUnnecessaryYoMatches(text);
  if (!matches.length) {
    return text;
  }
  const chunks: string[] = [];
  let offset = 0;
  for (const match of matches) {
    chunks.push(text.slice(offset, match.start));
    chunks.push(match.text.replace(yoLetters, (letter) => letter[0] === 'Ё' || letter[0] === 'Е' ? 'Е' : 'е'));
    offset = match.end;
  }
  chunks.push(text.slice(offset));
  return chunks.join('');
}
