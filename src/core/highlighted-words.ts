export const DEFAULT_HIGHLIGHTED_WORDS = [
  'все',
  'всё',
  'всем',
  'всём',
  'нем',
  'нём',
  'берет',
  'берёт',
  'угу',
  'м-м'
];

const HIGHLIGHTED_WORD_LIMIT = 500;

export function normalizeHighlightedWords(source: unknown): string[] {
  const rawItems = Array.isArray(source)
    ? source
    : typeof source === 'string'
      ? source.split(/[\n,;]+/g)
      : DEFAULT_HIGHLIGHTED_WORDS;

  const seen = new Set<string>();
  const words: string[] = [];
  for (const item of rawItems) {
    const word = String(item || '').trim().replace(/\s+/g, ' ');
    const key = word.toLocaleLowerCase();
    if (!word || seen.has(key)) {
      continue;
    }

    seen.add(key);
    words.push(word);
    if (words.length >= HIGHLIGHTED_WORD_LIMIT) {
      break;
    }
  }

  return words;
}

export function formatHighlightedWordsForTextarea(words: readonly string[]): string {
  return normalizeHighlightedWords(words).join('\n');
}
