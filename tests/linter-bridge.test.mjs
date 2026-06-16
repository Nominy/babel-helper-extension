import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const bridgePath = path.resolve('src/content/linter-bridge.ts');
const bridgeSource = fs.readFileSync(bridgePath, 'utf8');
const languageRulesPath = path.resolve('src/features/custom-linter/linter/rules/language-rules.ts');
const languageRulesSource = fs.readFileSync(languageRulesPath, 'utf8');
const DEFAULT_HIGHLIGHTED_WORDS = ['все', 'всё', 'всем', 'всём', 'нем', 'нём', 'берет', 'берёт', 'угу', 'м-м'];
const HIGHLIGHTED_WORD_RULE_REASON = 'Highlighted word requires clearance before use.';

function hasCommaSpacingViolation(text) {
  if (typeof text !== 'string' || text.indexOf(',') === -1) {
    return false;
  }

  return /\s+,/.test(text) || /(?<!\d),(?![\d ]|$)/.test(text) || /, {2,}/.test(text);
}

function isStandalonePeriodAt(text, index) {
  if (typeof text !== 'string' || text[index] !== '.') {
    return false;
  }

  const prevChar = index > 0 ? text[index - 1] : '';
  const nextChar = index + 1 < text.length ? text[index + 1] : '';
  if (prevChar === '.' || nextChar === '.') {
    return false;
  }

  if (/\d/.test(prevChar) && /\d/.test(nextChar)) {
    return false;
  }

  return !isRangeInsideGenericTag(text, index, index + 1);
}

function shouldPeriodHaveFollowingSpaceBefore(char) {
  return typeof char === 'string' && /[\p{L}\p{N}<{\[]/u.test(char);
}

function getPeriodSpacingParts(text) {
  if (typeof text !== 'string' || text.indexOf('.') === -1) {
    return [];
  }

  const parts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (!isStandalonePeriodAt(text, index)) {
      continue;
    }

    const hasSpaceBefore = index > 0 && /[ \t]/.test(text[index - 1]);
    let nextIndex = index + 1;
    while (nextIndex < text.length && /[ \t]/.test(text[nextIndex])) {
      nextIndex += 1;
    }

    const shouldHaveSpaceAfter = shouldPeriodHaveFollowingSpaceBefore(text[nextIndex]);
    const hasExactlyOneSpaceAfter = nextIndex === index + 2 && text[index + 1] === ' ';
    const hasBadSpaceAfter = shouldHaveSpaceAfter && !hasExactlyOneSpaceAfter;

    if (hasSpaceBefore || hasBadSpaceAfter) {
      parts.push({
        start: hasSpaceBefore ? index - 1 : index,
        end: hasBadSpaceAfter ? Math.max(index + 1, nextIndex) : index + 1
      });
    }
  }

  return parts;
}

function hasPeriodSpacingViolation(text) {
  return getPeriodSpacingParts(text).length > 0;
}

function getQuoteIndices(text) {
  const indices = [];
  if (typeof text !== 'string' || text.indexOf('"') === -1) {
    return indices;
  }

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      indices.push(index);
    }
  }

  return indices;
}

const UNICODE_DOUBLE_QUOTE_PATTERN =
  /[\u00AB\u00BB\u201C\u201D\u201E\u201F\u2039\u203A\u275D\u275E\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02]/gu;

function normalizeUnicodeDoubleQuoteVariants(text) {
  if (typeof text !== 'string') {
    return text;
  }

  UNICODE_DOUBLE_QUOTE_PATTERN.lastIndex = 0;
  if (!UNICODE_DOUBLE_QUOTE_PATTERN.test(text)) {
    return text;
  }

  UNICODE_DOUBLE_QUOTE_PATTERN.lastIndex = 0;
  return text.replace(UNICODE_DOUBLE_QUOTE_PATTERN, '"');
}

function hasUnicodeQuoteViolation(text) {
  return typeof text === 'string' && normalizeUnicodeDoubleQuoteVariants(text) !== text;
}

function hasUnbalancedDoubleQuotes(text) {
  return getQuoteIndices(normalizeUnicodeDoubleQuoteVariants(text)).length % 2 === 1;
}

function isWordCharacter(char) {
  return typeof char === 'string' && /[\p{L}\p{N}]/u.test(char);
}

const GENERIC_TAG_DELIMITERS = [
  ['<', '>'],
  ['{', '}'],
  ['[', ']']
];

function getEnclosingGenericTagRange(text, index) {
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
      end: closeIndex + 1
    };
  }

  return null;
}

function isRangeInsideGenericTag(text, start, end) {
  const tagRange = getEnclosingGenericTagRange(text, start);
  return Boolean(tagRange && end <= tagRange.end);
}

function normalizeHighlightedWords(value) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,;]+/g)
      : DEFAULT_HIGHLIGHTED_WORDS;
  const seen = new Set();
  const words = [];
  for (const item of rawItems) {
    const normalized = String(item || '').trim().replace(/\s+/g, ' ');
    const key = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }

    seen.add(key);
    words.push(normalized);
  }

  return words;
}

function getHighlightedWordPattern(word) {
  const escaped = escapeRegExp(word).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${escaped}(?![\\p{L}\\p{N}\\p{M}_])`, 'giu');
}

function getHighlightedWordMatches(text, words = DEFAULT_HIGHLIGHTED_WORDS) {
  if (typeof text !== 'string') {
    return [];
  }

  const matches = [];
  for (const word of normalizeHighlightedWords(words)) {
    const pattern = getHighlightedWordPattern(word);
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text))) {
      const start = match.index;
      const end = start + match[0].length;
      if (!isRangeInsideGenericTag(text, start, end)) {
        matches.push({ start, end, text: match[0] });
      }

      if (match[0] === '') {
        pattern.lastIndex += 1;
      }
    }
  }

  const seen = new Set();
  return matches.filter((match) => {
    const key = `${match.start}\u0000${match.end}\u0000${match.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function hasHighlightedWordViolation(text, words = DEFAULT_HIGHLIGHTED_WORDS) {
  return getHighlightedWordMatches(text, words).length > 0;
}

function getHighlightedWordClearanceKey({
  routeKey = '/transcription/RU-tx-gold',
  reviewActionId = '',
  annotationId = '',
  text = '',
  words = DEFAULT_HIGHLIGHTED_WORDS
} = {}) {
  const matchSignature = getHighlightedWordMatches(text, words)
    .map((match) => `${match.start}:${match.end}:${match.text.toLocaleLowerCase()}`)
    .join('|');

  return [
    routeKey,
    reviewActionId,
    annotationId,
    text,
    matchSignature
  ].join('\u0000');
}

function stripHelperAssertedWarningsFromPayload(payload) {
  let changed = false;
  const strippedReviewActionIds = new Set();

  function visit(value) {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const metadata = value.metadata;
    if (metadata && typeof metadata === 'object' && Array.isArray(metadata.assertedWarnings)) {
      const nextWarnings = metadata.assertedWarnings.filter(
        (warning) => warning !== HIGHLIGHTED_WORD_RULE_REASON
      );
      if (nextWarnings.length !== metadata.assertedWarnings.length) {
        changed = true;
        if (typeof value.reviewActionId === 'string') {
          strippedReviewActionIds.add(value.reviewActionId);
        }
        if (nextWarnings.length) {
          metadata.assertedWarnings = nextWarnings;
        } else {
          delete metadata.assertedWarnings;
        }
      }
    }

    Object.values(value).forEach(visit);
  }

  visit(payload);
  return { changed, strippedReviewActionIds: Array.from(strippedReviewActionIds) };
}

function hasCurlySpacingViolation(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const hasOpen = text.indexOf('{') !== -1;
  const hasClose = text.indexOf('}') !== -1;
  if (!hasOpen && !hasClose) {
    return false;
  }

  if (hasOpen !== hasClose) {
    return true;
  }

  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      stack.push(index);
      continue;
    }

    if (char !== '}') {
      continue;
    }

    if (!stack.length) {
      return true;
    }

    const openIndex = stack.pop();
    const prevChar = openIndex > 0 ? text[openIndex - 1] : '';
    const nextCharAfterOpen = openIndex + 1 < text.length ? text[openIndex + 1] : '';
    const prevCharBeforeClose = index > 0 ? text[index - 1] : '';
    const nextChar = index + 1 < text.length ? text[index + 1] : '';

    if (/\s/.test(nextCharAfterOpen) || /\s/.test(prevCharBeforeClose)) {
      return true;
    }

    if (isWordCharacter(prevChar) || isWordCharacter(nextChar)) {
      return true;
    }
  }

  return stack.length > 0;
}

function normalizeAngleTagText(text) {
  if (typeof text !== 'string' || text.length < 2) {
    return text;
  }

  const inner = text
    .slice(1, -1)
    .trim()
    .replace(/^\/\s+/u, '/');
  return `<${inner}>`;
}

function normalizeSquareBracketTagText(text) {
  if (typeof text !== 'string' || text.length < 2) {
    return text;
  }

  const inner = text
    .slice(1, -1)
    .trim()
    .replace(/^\/\s+/u, '/');
  return `[${inner}]`;
}

function getAngleTagSpacingParts(text) {
  if (typeof text !== 'string' || text.indexOf('<') === -1) {
    return [];
  }

  const parts = [];
  const tagPattern = /<[^<>\r\n]*>/gu;
  let match;
  while ((match = tagPattern.exec(text))) {
    const tag = match[0];
    const start = match.index;
    const end = tagPattern.lastIndex;
    const prevChar = start > 0 ? text[start - 1] : '';
    const nextChar = end < text.length ? text[end] : '';
    if (
      normalizeAngleTagText(tag) !== tag ||
      (prevChar && !/\s/.test(prevChar)) ||
      (nextChar && !/\s/.test(nextChar))
    ) {
      parts.push({ start, end });
    }
  }

  return parts;
}

function hasAngleTagSpacingViolation(text) {
  return getAngleTagSpacingParts(text).length > 0;
}

function getSquareBracketTagSpacingParts(text) {
  if (typeof text !== 'string' || text.indexOf('[') === -1) {
    return [];
  }

  const parts = [];
  const tagPattern = /\[[^[\]\r\n]*\]/gu;
  let match;
  while ((match = tagPattern.exec(text))) {
    const tag = match[0];
    const start = match.index;
    const end = tagPattern.lastIndex;
    const prevChar = start > 0 ? text[start - 1] : '';
    const nextChar = end < text.length ? text[end] : '';
    if (
      normalizeSquareBracketTagText(tag) !== tag ||
      (prevChar && !/\s/.test(prevChar)) ||
      (nextChar && !/\s/.test(nextChar))
    ) {
      parts.push({ start, end });
    }
  }

  return parts;
}

function hasSquareBracketTagSpacingViolation(text) {
  return getSquareBracketTagSpacingParts(text).length > 0;
}

function isCurlyTagTrailingPunctuationChar(char) {
  return typeof char === 'string' && /[.,?!:;"-]/.test(char);
}

function hasNonTagTextBeforeCurlyTag(text, openIndex) {
  if (typeof text !== 'string' || openIndex <= 0) {
    return false;
  }

  const visibleBefore = text
    .slice(0, openIndex)
    .replace(/\{[^{}\r\n]*\}|\[[^[\]\r\n]*\]|<[^<>\r\n]*>/gu, '');
  return /[\p{L}\p{N}]/u.test(visibleBefore);
}

function hasNonTagTextAfterAngleTag(text, tagEnd) {
  if (typeof text !== 'string' || tagEnd >= text.length) {
    return false;
  }

  const visibleAfter = text
    .slice(tagEnd)
    .replace(/\{[^{}\r\n]*\}|\[[^[\]\r\n]*\]|<[^<>\r\n]*>/gu, '');
  return /[\p{L}\p{N}]/u.test(visibleAfter);
}

function getCurlyTagTrailingPunctuationParts(text) {
  if (typeof text !== 'string' || text.indexOf('}') === -1) {
    return [];
  }

  const parts = [];
  const tagPattern = /\{[^{}\r\n]*\}/gu;
  let match;
  while ((match = tagPattern.exec(text))) {
    const openIndex = match.index;
    const tagEnd = tagPattern.lastIndex;
    if (!hasNonTagTextBeforeCurlyTag(text, openIndex)) {
      continue;
    }

    let punctuationStart = tagEnd;
    while (punctuationStart < text.length && /[ \t]/.test(text[punctuationStart])) {
      punctuationStart += 1;
    }

    let punctuationEnd = punctuationStart;
    while (
      punctuationEnd < text.length &&
      isCurlyTagTrailingPunctuationChar(text[punctuationEnd])
    ) {
      punctuationEnd += 1;
    }

    if (punctuationEnd > punctuationStart) {
      parts.push({
        openIndex,
        tagEnd,
        punctuationStart,
        punctuationEnd
      });
    }
  }

  return parts;
}

function getCurlyTagTrailingPunctuationMatches(text) {
  return getCurlyTagTrailingPunctuationParts(text).map((part) => ({
    start: part.punctuationStart,
    end: part.punctuationEnd,
    text: text.slice(part.punctuationStart, part.punctuationEnd)
  }));
}

function getSquareBracketTagTrailingPunctuationParts(text) {
  if (typeof text !== 'string' || text.indexOf(']') === -1) {
    return [];
  }

  const parts = [];
  const tagPattern = /\[[^[\]\r\n]*\]/gu;
  let match;
  while ((match = tagPattern.exec(text))) {
    const openIndex = match.index;
    const tagEnd = tagPattern.lastIndex;
    if (!hasNonTagTextBeforeCurlyTag(text, openIndex)) {
      continue;
    }

    let punctuationStart = tagEnd;
    while (punctuationStart < text.length && /[ \t]/.test(text[punctuationStart])) {
      punctuationStart += 1;
    }

    let punctuationEnd = punctuationStart;
    while (
      punctuationEnd < text.length &&
      isCurlyTagTrailingPunctuationChar(text[punctuationEnd])
    ) {
      punctuationEnd += 1;
    }

    if (punctuationEnd > punctuationStart) {
      parts.push({
        openIndex,
        tagEnd,
        punctuationStart,
        punctuationEnd
      });
    }
  }

  return parts;
}

function getSquareBracketTagTrailingPunctuationMatches(text) {
  return getSquareBracketTagTrailingPunctuationParts(text).map((part) => ({
    start: part.punctuationStart,
    end: part.punctuationEnd,
    text: text.slice(part.punctuationStart, part.punctuationEnd)
  }));
}

function getAngleTagTrailingPunctuationParts(text) {
  if (typeof text !== 'string' || text.indexOf('<') === -1) {
    return [];
  }

  const parts = [];
  const closingTagPattern = /<\/[^<>\r\n]*>/gu;
  let match;
  while ((match = closingTagPattern.exec(text))) {
    const tagStart = match.index;
    const tagEnd = closingTagPattern.lastIndex;
    if (!hasNonTagTextBeforeCurlyTag(text, tagStart)) {
      continue;
    }

    let punctuationStart = tagEnd;
    while (punctuationStart < text.length && /[ \t]/.test(text[punctuationStart])) {
      punctuationStart += 1;
    }

    let punctuationEnd = punctuationStart;
    while (
      punctuationEnd < text.length &&
      isCurlyTagTrailingPunctuationChar(text[punctuationEnd])
    ) {
      punctuationEnd += 1;
    }

    if (punctuationEnd > punctuationStart) {
      parts.push({
        kind: 'closing',
        tagStart,
        tagEnd,
        punctuationStart,
        punctuationEnd
      });
    }
  }

  const openingTagPattern = /<(?!\/)[^<>\r\n]*>/gu;
  while ((match = openingTagPattern.exec(text))) {
    const tagStart = match.index;
    const tagEnd = openingTagPattern.lastIndex;
    if (!hasNonTagTextAfterAngleTag(text, tagEnd)) {
      continue;
    }

    let punctuationEnd = tagStart;
    while (punctuationEnd > 0 && /[ \t]/.test(text[punctuationEnd - 1])) {
      punctuationEnd -= 1;
    }

    if (text[punctuationEnd - 1] !== '"') {
      continue;
    }

    let punctuationStart = punctuationEnd - 1;
    while (punctuationStart > 0 && text[punctuationStart - 1] === '"') {
      punctuationStart -= 1;
    }

    if (punctuationStart > 0 && !/[ \t]/.test(text[punctuationStart - 1])) {
      continue;
    }

    parts.push({
      kind: 'opening',
      tagStart,
      tagEnd,
      punctuationStart,
      punctuationEnd
    });
  }

  return parts.sort((left, right) => left.punctuationStart - right.punctuationStart);
}

function getAngleTagTrailingPunctuationMatches(text) {
  return getAngleTagTrailingPunctuationParts(text).map((part) => ({
    start: part.punctuationStart,
    end: part.punctuationEnd,
    text: text.slice(part.punctuationStart, part.punctuationEnd)
  }));
}

function hasCurlyTagTrailingPunctuationViolation(text) {
  return getCurlyTagTrailingPunctuationMatches(text).length > 0;
}

function hasSquareBracketTagTrailingPunctuationViolation(text) {
  return getSquareBracketTagTrailingPunctuationMatches(text).length > 0;
}

function hasAngleTagTrailingPunctuationViolation(text) {
  return getAngleTagTrailingPunctuationMatches(text).length > 0;
}

function hasDoubleDashPunctuationViolation(text) {
  if (typeof text !== 'string' || text.indexOf('--') === -1) {
    return false;
  }

  const pattern = /--[.,?!:;]/gu;
  let match;
  while ((match = pattern.exec(text))) {
    if (!isRangeInsideGenericTag(text, match.index, match.index + match[0].length)) {
      return true;
    }
  }

  return false;
}

function getCommaBeforeDashParts(text) {
  if (typeof text !== 'string' || text.indexOf(',') === -1 || text.indexOf('-') === -1) {
    return [];
  }

  const parts = [];
  for (
    let commaStart = text.indexOf(',');
    commaStart !== -1;
    commaStart = text.indexOf(',', commaStart + 1)
  ) {
    if (!hasNonTagTextBeforeCurlyTag(text, commaStart)) {
      continue;
    }

    let dashStart = commaStart + 1;
    while (dashStart < text.length && /[ \t]/.test(text[dashStart])) {
      dashStart += 1;
    }

    if (text[dashStart] !== '-') {
      continue;
    }

    const dashEnd = text[dashStart + 1] === '-' ? dashStart + 2 : dashStart + 1;
    if (text[dashEnd] === '-' || !/[ \t]/.test(text[dashEnd] || '')) {
      continue;
    }

    let nextIndex = dashEnd;
    while (nextIndex < text.length && /[ \t]/.test(text[nextIndex])) {
      nextIndex += 1;
    }

    if (nextIndex >= text.length || isRangeInsideGenericTag(text, commaStart, dashEnd)) {
      continue;
    }

    parts.push({ commaStart, dashStart });
  }

  return parts;
}

function getCommaBeforeDashMatches(text) {
  return getCommaBeforeDashParts(text).map((part) => ({
    start: part.commaStart,
    end: part.dashStart,
    text: text.slice(part.commaStart, part.dashStart)
  }));
}

function hasCommaBeforeDashViolation(text) {
  return getCommaBeforeDashMatches(text).length > 0;
}

function getFreeMidSentenceDoubleDashParts(text) {
  if (typeof text !== 'string' || text.indexOf('--') === -1) {
    return [];
  }

  const parts = [];
  for (let index = text.indexOf('--'); index !== -1; index = text.indexOf('--', index + 2)) {
    if (text[index - 1] === '-' || text[index + 2] === '-') {
      continue;
    }

    if (
      isRangeInsideGenericTag(text, index, index + 2) ||
      isInsideOpenQuoteAt(text, index)
    ) {
      continue;
    }

    if (!/[ \t]/.test(text[index - 1] || '') || !/[ \t]/.test(text[index + 2] || '')) {
      continue;
    }

    let start = index - 1;
    while (start > 0 && /[ \t]/.test(text[start - 1])) {
      start -= 1;
    }

    let end = index + 3;
    while (end < text.length && /[ \t]/.test(text[end])) {
      end += 1;
    }

    if (start === 0 || end >= text.length) {
      continue;
    }

    parts.push({
      start,
      end,
      dashStart: index,
      dashEnd: index + 2
    });
  }

  return parts;
}

function hasFreeMidSentenceDoubleDashViolation(text) {
  return getFreeMidSentenceDoubleDashParts(text).length > 0;
}

const UNICODE_DASH_PATTERN = /[\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/gu;
const POLITE_PRONOUN_PATTERN =
  /(^|[^\p{L}\p{N}\p{M}])(вы|вас|вам|вами|ваш(?:а|е|и|его|ему|им|ем|у|ей|ею|их|ими)?)(?=$|[^\p{L}\p{N}\p{M}])/giu;

function hasUnicodeDashViolation(text) {
  if (typeof text !== 'string') {
    return false;
  }

  UNICODE_DASH_PATTERN.lastIndex = 0;
  return UNICODE_DASH_PATTERN.test(text);
}

function hasSingleDashPunctuationViolation(text) {
  if (typeof text !== 'string' || text.indexOf('-') === -1) {
    return false;
  }

  const pattern = /(?<!-)-[.,?!:;]/gu;
  let match;
  while ((match = pattern.exec(text))) {
    if (!isRangeInsideGenericTag(text, match.index, match.index + match[0].length)) {
      return true;
    }
  }

  return false;
}

const INTERJECTION_CORRECTION_SPECS = [
  { canonical: 'а', variants: ['аа', 'а-а', 'а-а-а'] },
  { canonical: 'ага', variants: ['ага-а', 'агаа'] },
  { canonical: 'Ам', variants: ['А-м', 'а-ам'] },
  { canonical: 'ах', variants: ['ахх', 'а-а-ах'] },
  { canonical: 'блин', variants: ['бли-ин'] },
  { canonical: 'Вау', variants: ['уау'] },
  { canonical: 'вот', variants: ['вооот'] },
  { canonical: 'ей-богу', variants: ['ейбогу', 'ей богу'] },
  { canonical: 'м-да', variants: ['мда', 'мдя'] },
  { canonical: 'мгм', variants: ['мм-гм', 'мхм'] },
  { canonical: 'м', variants: ['мм', 'Ммм', 'м-м-м'] },
  { canonical: 'Н-да', variants: ['Нда'] },
  { canonical: 'ну', variants: ['нууу', 'ну-у'] },
  { canonical: 'Ну да', variants: ['Ну, да'] },
  { canonical: 'о да', variants: ['о, да'] },
  { canonical: 'о нет', variants: ['о, нет'] },
  { canonical: 'ой', variants: ['оой', 'ойй'] },
  { canonical: 'окей', variants: ["о'кей"] },
  { canonical: 'ох', variants: ['охх'] },
  { canonical: 'у', variants: ['у-у'] },
  { canonical: 'угу', variants: ['у-г-у', 'угуу'] },
  { canonical: 'ух', variants: ['ухх'] },
  { canonical: 'фу', variants: ['фу-у'] },
  { canonical: 'ха-ха', variants: ['хахаха'] },
  { canonical: 'ха', variants: ['ха-а', 'хаха'] },
  { canonical: 'хм', variants: ['хмм', 'гм'] },
  { canonical: 'чёрт', variants: ['чорт'] },
  { canonical: 'э', variants: ['э-э', 'эээ', 'э…э'] },
  { canonical: 'эх', variants: ['э-эх', 'эхх'] }
];

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLetterCaseShape(text) {
  if (typeof text !== 'string' || !text) {
    return 'mixed';
  }

  const letters = Array.from(text).filter((char) => /[\p{L}]/u.test(char));
  if (!letters.length) {
    return 'mixed';
  }

  const allUpper = letters.every((char) => char === char.toLocaleUpperCase());
  if (allUpper) {
    return 'upper';
  }

  const allLower = letters.every((char) => char === char.toLocaleLowerCase());
  if (allLower) {
    return 'lower';
  }

  const [first, ...rest] = letters;
  if (
    first === first.toLocaleUpperCase() &&
    rest.every((char) => char === char.toLocaleLowerCase())
  ) {
    return 'title';
  }

  return 'mixed';
}

function applyLetterCaseShape(text, shape) {
  if (typeof text !== 'string' || !text) {
    return text;
  }

  if (shape === 'upper') {
    return text.toLocaleUpperCase();
  }

  if (shape === 'lower') {
    return text.toLocaleLowerCase();
  }

  if (shape === 'title') {
    let applied = false;
    let result = '';
    for (const char of text) {
      if (!/[\p{L}]/u.test(char)) {
        result += char;
        continue;
      }

      if (!applied) {
        result += char.toLocaleUpperCase();
        applied = true;
      } else {
        result += char.toLocaleLowerCase();
      }
    }

    return result;
  }

  return text;
}

const INTERJECTION_CORRECTIONS = INTERJECTION_CORRECTION_SPECS
  .flatMap((entry) =>
    entry.variants.map((variant) => ({
      canonical: entry.canonical,
      variant
    }))
  )
  .sort((left, right) => right.variant.length - left.variant.length)
  .map((entry) => ({
    canonical: entry.canonical,
    pattern: new RegExp(
      `(^|[^\\p{L}\\p{N}\\p{M}])(${escapeRegExp(entry.variant)})(?=$|[^\\p{L}\\p{N}\\p{M}])`,
      'giu'
    )
  }));

function normalizeIncorrectInterjectionForms(text) {
  if (typeof text !== 'string' || !text) {
    return text;
  }

  let result = text;
  for (const correction of INTERJECTION_CORRECTIONS) {
    correction.pattern.lastIndex = 0;
    result = result.replace(correction.pattern, (_match, prefix, matchedVariant) => {
      const caseShape = getLetterCaseShape(matchedVariant);
      return prefix + applyLetterCaseShape(correction.canonical, caseShape);
    });
  }

  return result;
}

function hasIncorrectInterjectionFormsViolation(text) {
  return typeof text === 'string' && normalizeIncorrectInterjectionForms(text) !== text;
}

function hasTerminalPunctuationViolation(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const trimmed = normalizeUnicodeDoubleQuoteVariants(stripTrailingTagTokens(text));
  if (!trimmed) {
    return false;
  }

  return !/(?:\.\.\.|--|[.,?!:;"-])$/.test(trimmed);
}

function isUppercaseLetter(char) {
  return (
    typeof char === 'string' &&
    /[\p{L}]/u.test(char) &&
    char === char.toLocaleUpperCase() &&
    char !== char.toLocaleLowerCase()
  );
}

function isLowercaseLetter(char) {
  return (
    typeof char === 'string' &&
    /[\p{L}]/u.test(char) &&
    char === char.toLocaleLowerCase() &&
    char !== char.toLocaleUpperCase()
  );
}

function findFirstLetterIndex(text, startIndex = 0) {
  if (typeof text !== 'string') {
    return -1;
  }

  for (let index = Math.max(0, startIndex); index < text.length; index += 1) {
    if (/[\p{L}]/u.test(text[index])) {
      return index;
    }
  }

  return -1;
}

function skipLeadingCapitalizationTokens(text, startIndex = 0) {
  if (typeof text !== 'string') {
    return startIndex;
  }

  let index = Math.max(0, startIndex);
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '[' || char === '{') {
      const closeChar = char === '[' ? ']' : '}';
      const closeIndex = text.indexOf(closeChar, index + 1);
      if (closeIndex === -1) {
        break;
      }

      index = closeIndex + 1;
      continue;
    }

    if (char === '<') {
      const closeIndex = text.indexOf('>', index + 1);
      if (closeIndex === -1) {
        break;
      }

      index = closeIndex + 1;
      continue;
    }

    break;
  }

  return index;
}

function getCapitalizationContentStart(text, startIndex = 0) {
  return skipLeadingCapitalizationTokens(text, startIndex);
}

function startsWithNumericToken(text, startIndex = 0) {
  if (typeof text !== 'string') {
    return false;
  }

  let index = Math.max(0, startIndex);
  while (index < text.length) {
    const nextIndex = skipLeadingCapitalizationTokens(text, index);
    if (nextIndex !== index) {
      index = nextIndex;
      continue;
    }

    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    return /\p{N}/u.test(char);
  }

  return false;
}

function skipSentenceBoundaryTokens(text, startIndex = 0) {
  if (typeof text !== 'string') {
    return startIndex;
  }

  let index = Math.max(0, startIndex);
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/["'“”«»„‟‘’()\u00BB\u201D\u2019]/u.test(char)) {
      index += 1;
      continue;
    }

    const nextIndex = skipLeadingCapitalizationTokens(text, index);
    if (nextIndex !== index) {
      index = nextIndex;
      continue;
    }

    break;
  }

  return index;
}

function stripTrailingTagTokens(text) {
  if (typeof text !== 'string') {
    return '';
  }

  let result = text.trimEnd();
  while (result) {
    const lastChar = result[result.length - 1];
    if (lastChar === ']') {
      const openIndex = result.lastIndexOf('[');
      if (openIndex === -1) {
        break;
      }

      result = result.slice(0, openIndex).trimEnd();
      continue;
    }

    if (lastChar === '}') {
      const openIndex = result.lastIndexOf('{');
      if (openIndex === -1) {
        break;
      }

      result = result.slice(0, openIndex).trimEnd();
      continue;
    }

    if (lastChar === '>') {
      const openIndex = result.lastIndexOf('<');
      if (openIndex === -1) {
        break;
      }

      result = result.slice(0, openIndex).trimEnd();
      continue;
    }

    break;
  }

  return result;
}

function stripTrailingContinuationClosers(text) {
  if (typeof text !== 'string') {
    return '';
  }

  let result = stripTrailingTagTokens(text);
  while (result) {
    const lastChar = result[result.length - 1];
    if (!/[\s"')\]\}\u00BB\u201D\u2019]/u.test(lastChar)) {
      break;
    }

    result = result.slice(0, -1).trimEnd();
  }

  return result;
}

function endsWithLowercaseContinuationMarker(text) {
  return /(?:\.\.\.|--)$/.test(stripTrailingContinuationClosers(text));
}

function previousSameSpeakerAllowsLowercase(annotationEntries, index) {
  const current = annotationEntries[index];
  if (!current || !current.speakerKey) {
    return false;
  }

  for (let pointer = index - 1; pointer >= 0; pointer -= 1) {
    const candidate = annotationEntries[pointer];
    if (!candidate || candidate.speakerKey !== current.speakerKey) {
      continue;
    }

    return endsWithLowercaseContinuationMarker(candidate.text);
  }

  return false;
}

function findSentenceBoundaryLowercaseIndices(text) {
  if (typeof text !== 'string' || !text) {
    return [];
  }

  const indices = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!/[.?!]/.test(char)) {
      continue;
    }

    if (char === '.' && (text[index - 1] === '.' || text[index + 1] === '.')) {
      continue;
    }

    const directSpeechAuthorIndex = getRussianDirectSpeechAuthorContinuationLetterIndex(text, index);
    if (directSpeechAuthorIndex !== -1 && isLowercaseLetter(text[directSpeechAuthorIndex])) {
      continue;
    }

    const letterIndex = findFirstLetterIndex(
      text,
      skipSentenceBoundaryTokens(text, index + 1)
    );
    if (letterIndex === -1) {
      continue;
    }

    if (isLowercaseLetter(text[letterIndex])) {
      indices.push(letterIndex);
    }
  }

  return indices;
}

function getRussianDirectSpeechAuthorContinuationLetterIndex(text, boundaryIndex) {
  if (typeof text !== 'string' || boundaryIndex < 0) {
    return -1;
  }

  if (!/[?!]/.test(text[boundaryIndex])) {
    return -1;
  }

  let index = boundaryIndex + 1;
  while (index < text.length && /[?!]/.test(text[index])) {
    index += 1;
  }

  const insideOpenQuote = isInsideOpenQuoteAt(text, boundaryIndex);
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (/["\u00BB\u201D]/u.test(char)) {
      index += 1;
      break;
    }

    if (insideOpenQuote && char === '-') {
      break;
    }

    return -1;
  }

  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }

  if (text[index] !== '-') {
    return -1;
  }

  const authorStartIndex = skipLeadingCapitalizationTokens(text, index + 1);

  return findFirstLetterIndex(text, authorStartIndex);
}

function isInsideOpenQuoteAt(text, index) {
  if (typeof text !== 'string' || index < 0) {
    return false;
  }

  const normalizedText = normalizeUnicodeDoubleQuoteVariants(text);
  let quoteCount = 0;
  for (let pointer = 0; pointer < index; pointer += 1) {
    if (normalizedText[pointer] === '"') {
      quoteCount += 1;
    }
  }

  return quoteCount % 2 === 1;
}

function hasDoubleDashOutsideQuoteOrGenericTagViolation(text) {
  if (typeof text !== 'string' || text.indexOf('--') === -1) {
    return false;
  }

  let index = text.indexOf('--');
  while (index !== -1) {
    if (!isRangeInsideGenericTag(text, index, index + 2) && !isInsideOpenQuoteAt(text, index)) {
      return true;
    }

    index = text.indexOf('--', index + 2);
  }

  return false;
}

function hasSentenceBoundaryCapitalizationViolation(text) {
  return findSentenceBoundaryLowercaseIndices(text).length > 0;
}

function getEnclosingInlineTagRange(text, index) {
  return getEnclosingGenericTagRange(text, index);
}

function isInsideInlineTag(text, index) {
  return getEnclosingInlineTagRange(text, index) !== null;
}

function isInsidePairedInlineTagContent(text, index) {
  if (typeof text !== 'string' || index < 0 || index >= text.length) {
    return false;
  }

  const before = text.slice(0, index);
  const openMatch = before.match(/<([A-Za-zА-Яа-яЁё0-9_-]+)>[^<>]*$/u);
  if (!openMatch) {
    return false;
  }

  const tagName = openMatch[1];
  const closePattern = new RegExp(
    `^([^<>]*?)<\\/${escapeRegExp(tagName)}>`,
    'u'
  );
  return closePattern.test(text.slice(index));
}

function skipBackwardIgnorableTokens(text, pointer) {
  let current = pointer;
  while (current >= 0) {
    while (current >= 0 && /\s/.test(text[current])) {
      current -= 1;
    }

    const tagRange = getEnclosingInlineTagRange(text, current);
    if (tagRange) {
      current = tagRange.start - 1;
      continue;
    }

    while (current >= 0 && /["')\]\}\u00BB\u201D\u2019]/u.test(text[current])) {
      current -= 1;
      while (current >= 0 && /\s/.test(text[current])) {
        current -= 1;
      }
    }

    const closingTagMatch = text.slice(0, current + 1).match(/<\/[^>]+>$/u);
    if (closingTagMatch) {
      current -= closingTagMatch[0].length;
      continue;
    }

    break;
  }

  return current;
}

function getPolitePronounCaseExpectation(text, tokenIndex) {
  if (typeof text !== 'string' || tokenIndex < 0) {
    return 'neutral';
  }

  if (isInsideInlineTag(text, tokenIndex) || isInsidePairedInlineTagContent(text, tokenIndex)) {
    return 'neutral';
  }

  const firstLetterIndex = findFirstLetterIndex(text, skipLeadingCapitalizationTokens(text));
  if (firstLetterIndex !== -1 && tokenIndex === firstLetterIndex) {
    return 'neutral';
  }

  let pointer = skipBackwardIgnorableTokens(text, tokenIndex - 1);

  if (pointer < 0) {
    return 'neutral';
  }

  if (text.slice(0, pointer + 1).endsWith('...')) {
    return 'neutral';
  }

  if (pointer >= 1 && text[pointer] === '-' && text[pointer - 1] === '-') {
    return 'neutral';
  }

  if (text[pointer] === '-') {
    return 'neutral';
  }

  if (/[.?!:]/.test(text[pointer])) {
    return 'neutral';
  }

  return 'lower';
}

function getPolitePronounTargetToken(text, tokenIndex, token) {
  const normalizedToken = (token || '').toLocaleLowerCase();
  const expectation = getPolitePronounCaseExpectation(text, tokenIndex);

  if (expectation === 'lower') {
    return normalizedToken;
  }

  return token;
}

function hasPolitePronounCaseViolation(text) {
  if (typeof text !== 'string' || !text) {
    return false;
  }

  POLITE_PRONOUN_PATTERN.lastIndex = 0;
  let match;
  while ((match = POLITE_PRONOUN_PATTERN.exec(text))) {
    const prefix = match[1] || '';
    const token = match[2] || '';
    const tokenIndex = match.index + prefix.length;
    const targetToken = getPolitePronounTargetToken(text, tokenIndex, token);
    if (token && targetToken && token !== targetToken) {
      return true;
    }
  }

  return false;
}

function hasSegmentStartCapitalizationViolation(entry, annotationEntries, index) {
  if (!entry || typeof entry.text !== 'string') {
    return false;
  }

  const trimmed = entry.text.trim();
  if (!trimmed) {
    return false;
  }

  const contentStartIndex = getCapitalizationContentStart(trimmed);
  if (trimmed.startsWith('...', contentStartIndex)) {
    if (startsWithNumericToken(trimmed, contentStartIndex + 3)) {
      return false;
    }

    const ellipsisLetterIndex = findFirstLetterIndex(
      trimmed,
      getCapitalizationContentStart(trimmed, contentStartIndex + 3)
    );
    if (ellipsisLetterIndex === -1) {
      return false;
    }

    return isUppercaseLetter(trimmed[ellipsisLetterIndex]);
  }

  const firstLetterIndex = findFirstLetterIndex(trimmed, contentStartIndex);
  if (firstLetterIndex === -1) {
    return false;
  }

  if (!isLowercaseLetter(trimmed[firstLetterIndex])) {
    return false;
  }

  return !previousSameSpeakerAllowsLowercase(annotationEntries, index);
}

function fixLeadingTrailingSpaces(text) {
  if (typeof text !== 'string' || !text) {
    return text;
  }

  return text.replace(/^[ \t]+|[ \t]+$/g, '');
}

function fixDoubleSpaces(text) {
  if (typeof text !== 'string' || text.indexOf('  ') === -1) {
    return text;
  }

  return text.replace(/(\S) {2,}(?=\S)/g, '$1 ');
}

function fixCommaSpacing(text) {
  if (typeof text !== 'string' || text.indexOf(',') === -1) {
    return text;
  }

  let result = text;
  result = result.replace(/\s+,/g, ',');
  result = result.replace(/,(?![\d ]|$)/g, ', ');
  result = result.replace(/, {2,}/g, ', ');
  return result;
}

function fixPeriodSpacing(text) {
  if (typeof text !== 'string' || text.indexOf('.') === -1) {
    return text;
  }

  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    if (!isStandalonePeriodAt(text, index)) {
      result += text[index];
      continue;
    }

    result = result.replace(/[ \t]+$/u, '');
    result += '.';

    let nextIndex = index + 1;
    while (nextIndex < text.length && /[ \t]/.test(text[nextIndex])) {
      nextIndex += 1;
    }

    if (shouldPeriodHaveFollowingSpaceBefore(text[nextIndex])) {
      result += ' ';
      index = nextIndex - 1;
    }
  }

  return result;
}

function fixUnicodeQuotes(text) {
  return normalizeUnicodeDoubleQuoteVariants(text);
}

function fixCurlySpacing(text) {
  if (typeof text !== 'string') {
    return text;
  }

  const hasOpen = text.indexOf('{') !== -1;
  const hasClose = text.indexOf('}') !== -1;
  if (!hasOpen || !hasClose) {
    return text;
  }

  let result = text.replace(/\{\s+/g, '{').replace(/\s+\}/g, '}');
  result = result.replace(/([\p{L}\p{N}])\{/gu, '$1 {');
  result = result.replace(/\}([\p{L}\p{N}])/gu, '} $1');
  return result;
}

function fixAngleTagSpacing(text) {
  if (typeof text !== 'string' || text.indexOf('<') === -1) {
    return text;
  }

  const tagPattern = /<[^<>\r\n]*>/gu;
  let result = '';
  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(text))) {
    const tagStart = match.index;
    const tagEnd = tagPattern.lastIndex;
    result += text.slice(cursor, tagStart);

    const hasContentBefore = result.trimEnd().length > 0;
    result = result.replace(/[ \t]+$/u, '');
    if (hasContentBefore) {
      result += ' ';
    }

    result += normalizeAngleTagText(match[0]);

    cursor = tagEnd;
    while (cursor < text.length && /[ \t]/.test(text[cursor])) {
      cursor += 1;
    }

    if (cursor < text.length) {
      result += ' ';
    }
  }

  return result + text.slice(cursor);
}

function fixSquareBracketTagSpacing(text) {
  if (typeof text !== 'string' || text.indexOf('[') === -1) {
    return text;
  }

  const tagPattern = /\[[^[\]\r\n]*\]/gu;
  let result = '';
  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(text))) {
    const tagStart = match.index;
    const tagEnd = tagPattern.lastIndex;
    result += text.slice(cursor, tagStart);

    const hasContentBefore = result.trimEnd().length > 0;
    result = result.replace(/[ \t]+$/u, '');
    if (hasContentBefore) {
      result += ' ';
    }

    result += normalizeSquareBracketTagText(match[0]);

    cursor = tagEnd;
    while (cursor < text.length && /[ \t]/.test(text[cursor])) {
      cursor += 1;
    }

    if (cursor < text.length) {
      result += ' ';
    }
  }

  return result + text.slice(cursor);
}

function fixUnicodeDashes(text) {
  if (typeof text !== 'string') {
    return text;
  }

  UNICODE_DASH_PATTERN.lastIndex = 0;
  if (!UNICODE_DASH_PATTERN.test(text)) {
    return text;
  }

  UNICODE_DASH_PATTERN.lastIndex = 0;
  return text.replace(UNICODE_DASH_PATTERN, '-');
}

function fixCurlyTagTrailingPunctuation(text) {
  const parts = getCurlyTagTrailingPunctuationParts(text);
  if (!parts.length) {
    return text;
  }

  let result = '';
  let cursor = 0;
  for (const part of parts) {
    if (part.openIndex < cursor) {
      continue;
    }

    result += text.slice(cursor, part.openIndex);
    result = result.replace(/[ \t]+$/u, '');
    result +=
      text.slice(part.punctuationStart, part.punctuationEnd) +
      ' ' +
      text.slice(part.openIndex, part.tagEnd);
    cursor = part.punctuationEnd;
  }

  return result + text.slice(cursor);
}

function fixSquareBracketTagTrailingPunctuation(text) {
  const parts = getSquareBracketTagTrailingPunctuationParts(text);
  if (!parts.length) {
    return text;
  }

  let result = '';
  let cursor = 0;
  for (const part of parts) {
    if (part.openIndex < cursor) {
      continue;
    }

    result += text.slice(cursor, part.openIndex);
    result = result.replace(/[ \t]+$/u, '');
    result +=
      text.slice(part.punctuationStart, part.punctuationEnd) +
      ' ' +
      text.slice(part.openIndex, part.tagEnd);
    cursor = part.punctuationEnd;
    while (cursor < text.length && /[ \t]/.test(text[cursor])) {
      cursor += 1;
    }
    if (cursor < text.length) {
      result += ' ';
    }
  }

  return result + text.slice(cursor);
}

function fixAngleTagTrailingPunctuation(text) {
  const parts = getAngleTagTrailingPunctuationParts(text);
  if (!parts.length) {
    return text;
  }

  let result = '';
  let cursor = 0;
  for (const part of parts) {
    const partStart = part.kind === 'opening' ? part.punctuationStart : part.tagStart;
    if (partStart < cursor) {
      continue;
    }

    if (part.kind === 'opening') {
      result += text.slice(cursor, part.punctuationStart);
      result = result.replace(/[ \t]+$/u, '');
      if (result.trimEnd().length > 0) {
        result += ' ';
      }
      result +=
        text.slice(part.tagStart, part.tagEnd) +
        ' ' +
        text.slice(part.punctuationStart, part.punctuationEnd);
      cursor = part.tagEnd;
      while (cursor < text.length && /[ \t]/.test(text[cursor])) {
        cursor += 1;
      }
    } else {
      result += text.slice(cursor, part.tagStart);
      result = result.replace(/[ \t]+$/u, '');
      result +=
        text.slice(part.punctuationStart, part.punctuationEnd) +
        ' ' +
        text.slice(part.tagStart, part.tagEnd);
      cursor = part.punctuationEnd;
    }
  }

  return result + text.slice(cursor);
}

function fixCommaBeforeDash(text) {
  const parts = getCommaBeforeDashParts(text);
  if (!parts.length) {
    return text;
  }

  let result = '';
  let cursor = 0;
  for (const part of parts) {
    if (part.commaStart < cursor) {
      continue;
    }

    result += text.slice(cursor, part.commaStart);
    result = result.replace(/[ \t]+$/u, '');
    if (result.trimEnd().length > 0) {
      result += ' ';
    }
    cursor = part.dashStart;
  }

  return result + text.slice(cursor);
}

function fixFreeMidSentenceDoubleDash(text) {
  const parts = getFreeMidSentenceDoubleDashParts(text);
  if (!parts.length) {
    return text;
  }

  let result = '';
  let cursor = 0;
  for (const part of parts) {
    if (part.start < cursor) {
      continue;
    }

    result += text.slice(cursor, part.start) + ' - ';
    cursor = part.end;
  }

  return result + text.slice(cursor);
}

function fixDoubleDashPunctuation(text) {
  if (typeof text !== 'string' || text.indexOf('--') === -1) {
    return text;
  }

  // Remove punctuation immediately after double dash
  return text.replace(/--[.,?!:;]+/g, (match, offset) =>
    isRangeInsideGenericTag(text, offset, offset + match.length) ? match : '--'
  );
}

function fixSingleDashPunctuation(text) {
  if (typeof text !== 'string' || text.indexOf('-') === -1) {
    return text;
  }

  // Remove punctuation immediately after single dash
  // A single dash is a '-' not preceded by '-' and not followed by '-'
  return text.replace(/(?<!-)-(?!-)[.,?!:;]+/g, (match, offset) =>
    isRangeInsideGenericTag(text, offset, offset + match.length) ? match : '-'
  );
}

function fixTerminalPunctuation(text) {
  if (typeof text !== 'string') {
    return text;
  }

  const trimmed = stripTrailingTagTokens(text);
  if (!trimmed || /(?:\.\.\.|--|[.,?!:;"-])$/.test(trimmed)) {
    return text;
  }

  const insertionIndex = trimmed.length;
  return text.slice(0, insertionIndex) + '.' + text.slice(insertionIndex);
}

function fixSentenceBoundaryCapitalization(text) {
  if (typeof text !== 'string' || !text) {
    return text;
  }

  const indices = findSentenceBoundaryLowercaseIndices(text);
  if (!indices.length) {
    return text;
  }

  let result = text;
  for (let index = indices.length - 1; index >= 0; index -= 1) {
    const letterIndex = indices[index];
    result = replaceCharAt(result, letterIndex, result[letterIndex].toLocaleUpperCase());
  }

  return result;
}

function fixPolitePronounCase(text) {
  if (typeof text !== 'string' || !text) {
    return text;
  }

  POLITE_PRONOUN_PATTERN.lastIndex = 0;
  return text.replace(
    POLITE_PRONOUN_PATTERN,
    (_match, prefix, token, offset) =>
      `${prefix || ''}${getPolitePronounTargetToken(
        text,
        offset + (prefix || '').length,
        token || ''
      )}`
  );
}

function replaceCharAt(text, index, nextChar) {
  if (typeof text !== 'string' || index < 0 || index >= text.length || typeof nextChar !== 'string') {
    return text;
  }

  return text.slice(0, index) + nextChar + text.slice(index + 1);
}

function fixSegmentStartCapitalization(text, previousSameSpeakerText) {
  if (typeof text !== 'string') {
    return text;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  const contentStartIndex = getCapitalizationContentStart(text);
  if (text.startsWith('...', contentStartIndex)) {
    const ellipsisContentStartIndex = getCapitalizationContentStart(
      text,
      contentStartIndex + 3
    );
    if (startsWithNumericToken(text, ellipsisContentStartIndex)) {
      return text;
    }

    const letterIndex = findFirstLetterIndex(text, ellipsisContentStartIndex);
    if (letterIndex === -1 || !isUppercaseLetter(text[letterIndex])) {
      return text;
    }

    return replaceCharAt(text, letterIndex, text[letterIndex].toLocaleLowerCase());
  }

  const letterIndex = findFirstLetterIndex(text, contentStartIndex);
  if (letterIndex === -1 || !isLowercaseLetter(text[letterIndex])) {
    return text;
  }

  if (endsWithLowercaseContinuationMarker(previousSameSpeakerText)) {
    return text;
  }

  return replaceCharAt(text, letterIndex, text[letterIndex].toLocaleUpperCase());
}

function applyAllFixes(text) {
  if (typeof text !== 'string') {
    return text;
  }

  let result = text;
  result = fixLeadingTrailingSpaces(result);
  result = fixDoubleSpaces(result);
  result = fixCommaSpacing(result);
  result = fixPeriodSpacing(result);
  result = fixUnicodeQuotes(result);
  result = fixCurlySpacing(result);
  result = fixAngleTagSpacing(result);
  result = fixSquareBracketTagSpacing(result);
  result = fixUnicodeDashes(result);
  result = fixCurlyTagTrailingPunctuation(result);
  result = fixSquareBracketTagTrailingPunctuation(result);
  result = fixAngleTagTrailingPunctuation(result);
  result = fixCommaBeforeDash(result);
  result = fixFreeMidSentenceDoubleDash(result);
  result = fixDoubleDashPunctuation(result);
  result = fixSingleDashPunctuation(result);
  result = normalizeIncorrectInterjectionForms(result);
  result = fixTerminalPunctuation(result);
  result = fixSentenceBoundaryCapitalization(result);
  return result;
}

function normalizeIssueHighlightRange(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const start = Number(value.start);
  const end = Number(value.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  const range = {
    start,
    end
  };
  if (typeof value.text === 'string' && value.text) {
    range.text = value.text;
  }

  return range;
}

function compactHighlightRanges(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) {
    return [];
  }

  const seen = new Set();
  const compacted = [];
  for (const range of ranges) {
    const normalized = normalizeIssueHighlightRange(range);
    if (!normalized) {
      continue;
    }

    const key = `${normalized.start}\u0000${normalized.end}\u0000${normalized.text || ''}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    compacted.push(normalized);
  }

  return compacted.slice(0, 8);
}

function getIssueRangeCandidates(issue) {
  if (!issue || typeof issue !== 'object') {
    return [];
  }

  const helper = issue.babelHelper && typeof issue.babelHelper === 'object' ? issue.babelHelper : {};
  const candidates = [];
  for (const source of [
    helper.matches,
    helper.ranges,
    issue.matches,
    issue.ranges
  ]) {
    if (Array.isArray(source)) {
      candidates.push(...source);
    }
  }

  candidates.push(issue);
  return candidates;
}

function getIssueSourceText(issue) {
  const helper =
    issue && issue.babelHelper && typeof issue.babelHelper === 'object'
      ? issue.babelHelper
      : null;
  return helper && typeof helper.sourceText === 'string' ? helper.sourceText : '';
}

function getIssueHighlightEntries(issues, rowText = '') {
  if (!Array.isArray(issues)) {
    return [];
  }

  return issues
    .map((issue) => {
      const sourceText = getIssueSourceText(issue);
      if (rowText && sourceText && sourceText !== rowText) {
        return null;
      }

      const ranges = compactHighlightRanges(getIssueRangeCandidates(issue));
      return {
        reason: issue && typeof issue.reason === 'string' ? issue.reason : '',
        matches: ranges.map((range) => range.text || '').filter(Boolean),
        ranges
      };
    })
    .filter((entry) => entry && entry.reason && (entry.matches.length || entry.ranges.length));
}

test('custom lint highlight entries preserve exact ranges for the hovered row', () => {
  const issues = [
    {
      annotationId: 'a',
      reason: 'Incorrect interjection forms must use dictionary spelling.',
      severity: 'error',
      babelHelper: {
        sourceText: '\u043c\u043c, \u0434\u0430.',
        matches: [{ start: 0, end: 2, text: '\u043c\u043c' }]
      }
    },
    {
      annotationId: 'b',
      reason: 'Use ASCII hyphen "-" instead of typographic or Unicode dash variants.',
      severity: 'error',
      babelHelper: {
        sourceText: 'wait--',
        matches: [{ start: 4, end: 5, text: '\u2014' }]
      }
    }
  ];

  assert.deepEqual(getIssueHighlightEntries(issues, '\u043c\u043c, \u0434\u0430.'), [
    {
      reason: 'Incorrect interjection forms must use dictionary spelling.',
      matches: ['\u043c\u043c'],
      ranges: [{ start: 0, end: 2, text: '\u043c\u043c' }]
    }
  ]);
});

test('linter bridge carries source text and range extraction into highlight overlay', () => {
  assert.match(bridgeSource, /sourceText: typeof entry\.text === "string" \? entry\.text : ""/);
  assert.match(bridgeSource, /getIssueHighlightEntries\(currentHighlightIssues, rowText\)/);
  assert.match(bridgeSource, /getNativeTooltipHighlightEntries\(rowText\)/);
});

test('highlighted words flag exact built-in and custom dictionary terms only', () => {
  assert.equal(hasHighlightedWordViolation('Каждый раз всё новое, да?'), true);
  assert.equal(hasHighlightedWordViolation('Он берет новый билет.'), true);
  assert.equal(hasHighlightedWordViolation('Угу, понятно.'), true);
  assert.equal(hasHighlightedWordViolation('Совсем другой случай.'), false);
  assert.equal(hasHighlightedWordViolation('The skill check should not match partials.', ['kill']), false);
  assert.equal(hasHighlightedWordViolation('A red   flag appears here.', ['red flag']), true);
  assert.equal(hasHighlightedWordViolation('{всё} is a tag, not transcript wording.'), false);
});

test('highlighted word matches keep exact ranges for overlay coloring', () => {
  assert.deepEqual(
    getHighlightedWordMatches('Всё, угу.', ['всё', 'угу']),
    [
      { start: 0, end: 3, text: 'Всё' },
      { start: 5, end: 8, text: 'угу' }
    ]
  );
});

test('highlighted word clearance keys are annotation-local and reset when text changes', () => {
  const base = {
    reviewActionId: 'review-1',
    annotationId: 'annotation-7',
    text: 'Каждый раз всё новое.',
    words: ['всё']
  };

  assert.equal(
    getHighlightedWordClearanceKey(base),
    getHighlightedWordClearanceKey({ ...base })
  );
  assert.notEqual(
    getHighlightedWordClearanceKey(base),
    getHighlightedWordClearanceKey({
      ...base,
      text: 'Каждый раз всё новое. Edited.'
    })
  );
});

test('helper warning scrubber strips only highlighted-word asserted warnings', () => {
  const payload = {
    0: {
      json: {
        annotations: [
          {
            id: 'annotation-1',
            reviewActionId: 'review-1',
            content: 'Каждый раз всё новое.',
            metadata: {
              assertedWarnings: [
                HIGHLIGHTED_WORD_RULE_REASON,
                'Native warning must remain.'
              ],
              lowConfidenceResolved: true
            }
          },
          {
            id: 'annotation-2',
            reviewActionId: 'review-1',
            content: 'Clean text.',
            metadata: {
              assertedWarnings: ['Native warning must remain.']
            }
          }
        ]
      }
    }
  };

  const result = stripHelperAssertedWarningsFromPayload(payload);

  assert.equal(result.changed, true);
  assert.deepEqual(result.strippedReviewActionIds, ['review-1']);
  assert.deepEqual(payload[0].json.annotations[0].metadata.assertedWarnings, [
    'Native warning must remain.'
  ]);
  assert.deepEqual(payload[0].json.annotations[1].metadata.assertedWarnings, [
    'Native warning must remain.'
  ]);
});

test('linter bridge routes highlighted word clearance through Babel warning state', () => {
  assert.match(bridgeSource, /HIGHLIGHTED_WORD_RULE_REASON/);
  assert.match(bridgeSource, /getHighlightedWordMatches/);
  assert.match(bridgeSource, /hasHighlightedWordViolation/);
  assert.match(bridgeSource, /highlightedWordsEnabled\s*=\s*true/);
  assert.match(bridgeSource, /detail\.highlightedWordsEnabled\s*!==\s*false/);
  assert.match(bridgeSource, /if \(!highlightedWordsEnabled \|\| !highlightedWords\.length\)/);
  assert.match(bridgeSource, /highlightedWords/);
  assert.match(bridgeSource, /handleConfig/);
  assert.match(bridgeSource, /HIGHLIGHTED_WORD_RULE_SEVERITY = "warning"/);
  assert.match(bridgeSource, /getHighlightedWordClearanceKey/);
  assert.match(bridgeSource, /getHighlightedWordClearanceTaskKey/);
  assert.match(bridgeSource, /highlightedWordClearanceTaskKey/);
  assert.match(bridgeSource, /SAVE_ANNOTATIONS_PATH/);
  assert.match(bridgeSource, /stripHelperAssertedWarningsFromPayload/);
  assert.match(bridgeSource, /applyHighlightedWordClearancesToPayload/);
  assert.match(bridgeSource, /ensureHelperAssertedWarning/);
  assert.match(bridgeSource, /maybeAugmentHighlightedWordClearanceResponse/);
  assert.match(bridgeSource, /isNativeLintStatusTrigger/);
  assert.match(bridgeSource, /isNativeLintSuccessTrigger/);
  assert.match(bridgeSource, /observeNativeHighlightedWordWarningClick/);
  assert.match(bridgeSource, /markHighlightedWordCleared/);
  assert.match(bridgeSource, /unmarkHighlightedWordCleared/);
  assert.match(bridgeSource, /taskKey:\s*highlightedWordClearanceTaskKey/);
  assert.match(bridgeSource, /sanitizeHelperAssertedWarningsRequest\(\s*input,\s*init,\s*\{\s*recordClearance: true,\s*\}/);
  assert.match(bridgeSource, new RegExp(escapeRegExp(HIGHLIGHTED_WORD_RULE_REASON)));
  assert.match(bridgeSource, /highlightedWord:\s*HIGHLIGHTED_WORD_RULE_REASON/);
  assert.match(bridgeSource, /highlightedWordRuleSeverity:\s*HIGHLIGHTED_WORD_RULE_SEVERITY/);
  assert.match(languageRulesSource, /id:\s*'highlighted-words'/);
  assert.match(languageRulesSource, /reason:\s*deps\.reasons\.highlightedWord/);
  assert.match(languageRulesSource, /severity:\s*deps\.highlightedWordRuleSeverity/);
  assert.doesNotMatch(bridgeSource, /HIGHLIGHTED_WORD_MARKER_ATTR/);
  assert.doesNotMatch(bridgeSource, /body > div/);
  assert.doesNotMatch(bridgeSource, /stopNativeHighlightedWordWarningEvent/);
  assert.doesNotMatch(bridgeSource, /stopImmediatePropagation/);
  assert.doesNotMatch(bridgeSource, /applyNativeClearedWarningState/);
  assert.doesNotMatch(bridgeSource, /removeNativeLintTooltipNodes/);
  assert.doesNotMatch(bridgeSource, /decrementVisibleWarningCount/);
  assert.doesNotMatch(bridgeSource, /triggerNativeLintRefresh/);
  assert.doesNotMatch(bridgeSource, /makeSuppressedMutationResponse/);
  assert.doesNotMatch(bridgeSource, /scheduleInitialNativeLintTrigger\("config-highlighted-words"\)/);
  assert.doesNotMatch(bridgeSource, /fixHighlightedWords/);
});

test('does not flag decimal comma numbers', () => {
  assert.equal(hasCommaSpacingViolation('Это стоит 1,5 евро.'), false);
  assert.equal(hasCommaSpacingViolation('Диапазон 0,25 и 10,7 допустим.'), false);
});

test('still flags missing space after non-decimal comma', () => {
  assert.equal(hasCommaSpacingViolation('Привет,мир'), true);
  assert.equal(hasCommaSpacingViolation('Да,нет'), true);
});

test('still flags stray space before comma and double spaces after comma', () => {
  assert.equal(hasCommaSpacingViolation('Привет , мир'), true);
  assert.equal(hasCommaSpacingViolation('Привет,  мир'), true);
});

test('flags and fixes spacing around standalone periods', () => {
  assert.equal(hasPeriodSpacingViolation('Hello . world'), true);
  assert.equal(hasPeriodSpacingViolation('Hello.world'), true);
  assert.equal(hasPeriodSpacingViolation('Hello.  world'), true);
  assert.equal(hasPeriodSpacingViolation('Hello .world'), true);
  assert.equal(hasPeriodSpacingViolation('Hello. World'), false);
  assert.equal(hasPeriodSpacingViolation('Hello... world'), false);
  assert.equal(hasPeriodSpacingViolation('Value 1.5 is fine'), false);
  assert.equal(hasPeriodSpacingViolation('<TAG.>'), false);

  assert.equal(fixPeriodSpacing('Hello . world'), 'Hello. world');
  assert.equal(fixPeriodSpacing('Hello.world'), 'Hello. world');
  assert.equal(fixPeriodSpacing('Hello.  world'), 'Hello. world');
  assert.equal(fixPeriodSpacing('Hello .world'), 'Hello. world');
  assert.equal(fixPeriodSpacing('Value 1.5 is fine'), 'Value 1.5 is fine');
  assert.equal(fixPeriodSpacing('Hello... world'), 'Hello... world');
});

test('flags unbalanced double quotes', () => {
  assert.equal(hasUnbalancedDoubleQuotes('Он сказал "привет.'), true);
  assert.equal(hasUnbalancedDoubleQuotes('Он сказал "привет".'), false);
});

test('linter bridge no longer carries quote placement spacing rule', () => {
  assert.doesNotMatch(bridgeSource, /QUOTE_PLACEMENT_RULE_REASON/);
  assert.doesNotMatch(bridgeSource, /hasQuotePlacementViolation/);
  assert.doesNotMatch(bridgeSource, /getQuotePlacementMatches/);
  assert.doesNotMatch(bridgeSource, /fixQuotePlacement/);
});

test('treats unicode quote variants as quote characters in analysis', () => {
  assert.equal(hasUnbalancedDoubleQuotes('\u00abhello.'), true);
});

test('flags non-ascii quote variants', () => {
  assert.equal(hasUnicodeQuoteViolation('\u00abhello\u00bb'), true);
  assert.equal(hasUnicodeQuoteViolation('\u201chello\u201d'), true);
  assert.equal(hasUnicodeQuoteViolation('\u300chello\u300d'), true);
  assert.equal(hasUnicodeQuoteViolation('"hello"'), false);
});

test('flags bad curly tag spacing and imbalance', () => {
  assert.equal(hasCurlySpacingViolation('TEXT {TAG: OTHER}'), false);
  assert.equal(hasCurlySpacingViolation('TEXT{TAG: OTHER}'), true);
  assert.equal(hasCurlySpacingViolation('TEXT { TAG: OTHER}'), true);
  assert.equal(hasCurlySpacingViolation('TEXT {TAG: OTHER }'), true);
  assert.equal(hasCurlySpacingViolation('TEXT {TAG: OTHER}suffix'), true);
  assert.equal(hasCurlySpacingViolation('TEXT {TAG: OTHER'), true);
  assert.equal(hasCurlySpacingViolation('TEXT TAG: OTHER}'), true);
});

test('flags and fixes spaces around angle tags as standalone transcript tags', () => {
  assert.equal(hasAngleTagSpacingViolation('TEXT <TAG> OTHER'), false);
  assert.equal(hasAngleTagSpacingViolation('TEXT<TAG>OTHER'), true);
  assert.equal(hasAngleTagSpacingViolation('TEXT < TAG > OTHER'), true);
  assert.equal(hasAngleTagSpacingViolation('TEXT</TAG>OTHER'), true);
  assert.equal(hasAngleTagSpacingViolation('<TAG>TEXT'), true);
  assert.equal(hasAngleTagSpacingViolation('TEXT<TAG'), false);

  assert.equal(fixAngleTagSpacing('TEXT<TAG>OTHER'), 'TEXT <TAG> OTHER');
  assert.equal(fixAngleTagSpacing('TEXT < TAG > OTHER'), 'TEXT <TAG> OTHER');
  assert.equal(fixAngleTagSpacing('TEXT</TAG>OTHER'), 'TEXT </TAG> OTHER');
  assert.equal(fixAngleTagSpacing('<TAG>TEXT'), '<TAG> TEXT');
  assert.equal(fixAngleTagSpacing('TEXT<TAG'), 'TEXT<TAG');
});

test('flags and fixes spaces around square bracket tags as standalone transcript tags', () => {
  assert.equal(hasSquareBracketTagSpacingViolation('TEXT [laugh] OTHER'), false);
  assert.equal(hasSquareBracketTagSpacingViolation('TEXT[laugh]OTHER'), true);
  assert.equal(hasSquareBracketTagSpacingViolation('TEXT [ laugh ] OTHER'), true);
  assert.equal(hasSquareBracketTagSpacingViolation('TEXT[/laugh]OTHER'), true);
  assert.equal(hasSquareBracketTagSpacingViolation('[laugh]TEXT'), true);
  assert.equal(hasSquareBracketTagSpacingViolation('TEXT[laugh'), false);

  assert.equal(fixSquareBracketTagSpacing('TEXT[laugh]OTHER'), 'TEXT [laugh] OTHER');
  assert.equal(fixSquareBracketTagSpacing('TEXT [ laugh ] OTHER'), 'TEXT [laugh] OTHER');
  assert.equal(fixSquareBracketTagSpacing('TEXT[/laugh]OTHER'), 'TEXT [/laugh] OTHER');
  assert.equal(fixSquareBracketTagSpacing('[laugh]TEXT'), '[laugh] TEXT');
  assert.equal(fixSquareBracketTagSpacing('TEXT[laugh'), 'TEXT[laugh');
});

test('flags punctuation that appears outside closing angle tags', () => {
  assert.equal(hasAngleTagTrailingPunctuationViolation('Да </TAG>.'), true);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Да </TAG>:'), true);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Да </TAG>".'), true);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Да </TAG>--'), true);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Да. </TAG>'), false);
  assert.equal(hasAngleTagTrailingPunctuationViolation('<TAG> Да </TAG>'), false);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Да <TAG>.'), false);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Да </TAG'), false);
});

test('flags standalone opening quotes before opening angle tags', () => {
  assert.equal(hasAngleTagTrailingPunctuationViolation('Da " <TAG> text'), true);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Da "<TAG> text'), true);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Da. <TAG> text'), false);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Da?! <TAG> text'), false);
  assert.equal(hasAngleTagTrailingPunctuationViolation('. <TAG> text'), false);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Da." <TAG> text'), false);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Da <TAG>. text'), false);
  assert.equal(hasAngleTagTrailingPunctuationViolation('Da. </TAG>'), false);
});

test('flags punctuation that appears after a curly tag for preceding text', () => {
  assert.equal(hasCurlyTagTrailingPunctuationViolation('3 {SKAZ: three}".'), true);
  assert.equal(hasCurlyTagTrailingPunctuationViolation('3 {SKAZ: three}.'), true);
  assert.equal(hasCurlyTagTrailingPunctuationViolation('3 {SKAZ: three}, next'), true);
  assert.equal(hasCurlyTagTrailingPunctuationViolation('3 {SKAZ: three}--'), true);
  assert.equal(hasCurlyTagTrailingPunctuationViolation('3 {SKAZ: three}-'), true);
  assert.equal(hasCurlyTagTrailingPunctuationViolation('3". {SKAZ: three}'), false);
  assert.equal(hasCurlyTagTrailingPunctuationViolation('3 {SKAZ: three}'), false);
  assert.equal(hasCurlyTagTrailingPunctuationViolation('{SKAZ: three}".'), false);
  assert.equal(hasCurlyTagTrailingPunctuationViolation('3 {SKAZ: three'), false);
});

test('flags punctuation that appears after square bracket tags for preceding text', () => {
  assert.equal(hasSquareBracketTagTrailingPunctuationViolation('workers [laugh], who'), true);
  assert.equal(hasSquareBracketTagTrailingPunctuationViolation('workers [laugh].'), true);
  assert.equal(hasSquareBracketTagTrailingPunctuationViolation('workers [laugh]--'), true);
  assert.equal(hasSquareBracketTagTrailingPunctuationViolation('workers, [laugh] who'), false);
  assert.equal(hasSquareBracketTagTrailingPunctuationViolation('[laugh], who'), false);
  assert.equal(hasSquareBracketTagTrailingPunctuationViolation('workers [laugh'), false);
});

test('flags missing terminal punctuation and accepts allowed endings', () => {
  assert.equal(hasTerminalPunctuationViolation('hello world'), true);
  assert.equal(hasTerminalPunctuationViolation('hello world.'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world!'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world?'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world...'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world--'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world"'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world.</i>'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world</i>'), true);
  assert.equal(hasTerminalPunctuationViolation('hello world [laughs]'), true);
  assert.equal(hasTerminalPunctuationViolation('hello world. [laughs]'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world" [laughs]'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world {TAG: X}'), true);
  assert.equal(hasTerminalPunctuationViolation('hello world. {TAG: X}'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world: </TAG>'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world, {TAG: X}'), false);
  assert.equal(hasTerminalPunctuationViolation('   '), false);
});

test('flags lowercase words after clear sentence boundaries inside a segment', () => {
  assert.equal(hasSentenceBoundaryCapitalizationViolation('Hello. world'), true);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('Hello? world'), true);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('Hello! world'), true);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('Hello... world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('Hello -- world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('Hello - world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('Hello. "world"'), true);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('Hello. [laughs] world'), true);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello?" - world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello?"- world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello!"- world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello?!" - world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('\u00abHello?\u00bb - world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello?" - [tag] world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello?" - {tag} world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello?" - <tag> world'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello? - asked he. - What next?"'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello! - shouted he. - Go."'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello?! - asked he. - Really?"'), false);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello."- world'), true);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('Hello? - world'), true);
  assert.equal(hasSentenceBoundaryCapitalizationViolation('"Hello? - asked he. - what next?"'), true);
  assert.equal(
    hasSentenceBoundaryCapitalizationViolation('"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u0441 \u0432\u043e\u043f\u0440\u043e\u0441\u043e\u043c?"- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'),
    false
  );
  assert.equal(
    hasSentenceBoundaryCapitalizationViolation('"\u0427\u0442\u043e? - \u0441\u043f\u0440\u043e\u0441\u0438\u043b \u043e\u043d. - \u0427\u0442\u043e \u0434\u0430\u043b\u044c\u0448\u0435?"'),
    false
  );
  assert.equal(
    hasSentenceBoundaryCapitalizationViolation('"\u0427\u0442\u043e? - \u0441\u043f\u0440\u043e\u0441\u0438\u043b \u043e\u043d. - \u0447\u0442\u043e \u0434\u0430\u043b\u044c\u0448\u0435?"'),
    true
  );
  assert.equal(
    hasSentenceBoundaryCapitalizationViolation('"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u043a\u043e\u043d\u0447\u0438\u043b\u0430\u0441\u044c."- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'),
    true
  );
});

test('flags lowercase starts unless same-speaker continuation allows them', () => {
  const entries = [
    { annotationId: 'a', speakerKey: 'speaker-1', text: 'Hello there.' },
    { annotationId: 'b', speakerKey: 'speaker-1', text: 'lowercase start.' },
    { annotationId: 'c', speakerKey: 'speaker-1', text: 'carry on...' },
    { annotationId: 'd', speakerKey: 'speaker-1', text: 'lowercase continuation.' },
    { annotationId: 'e', speakerKey: 'speaker-2', text: 'other speaker...' },
    { annotationId: 'f', speakerKey: 'speaker-1', text: 'still wrong.' },
    { annotationId: 'g', speakerKey: 'speaker-1', text: '...Upper after ellipsis.' },
    { annotationId: 'h', speakerKey: 'speaker-1', text: '...lower after ellipsis.' },
    { annotationId: 'i', speakerKey: 'speaker-1', text: 'quoted continuation--"' },
    { annotationId: 'j', speakerKey: 'speaker-1', text: '"lowercase after quote.' },
    { annotationId: 'k', speakerKey: 'speaker-1', text: 'quoted ellipsis..."' },
    { annotationId: 'l', speakerKey: 'speaker-1', text: '"still lowercase after quote.' },
    { annotationId: 'm', speakerKey: 'speaker-1', text: '... 123 Upper after number.' },
    { annotationId: 'n', speakerKey: 'speaker-1', text: '... [laughs] 123 Upper after number.' }
  ];

  assert.equal(hasSegmentStartCapitalizationViolation(entries[0], entries, 0), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[1], entries, 1), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[3], entries, 3), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[5], entries, 5), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[6], entries, 6), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[7], entries, 7), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[9], entries, 9), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[11], entries, 11), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[12], entries, 12), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[13], entries, 13), false);
});

test('capitalization rule ignores leading tags before the real text start', () => {
  const entries = [
    { annotationId: 'a', speakerKey: 'speaker-1', text: '[laughs] lowercase start.' },
    { annotationId: 'b', speakerKey: 'speaker-1', text: '{TAG: X} Lowercase start.' },
    { annotationId: 'c', speakerKey: 'speaker-1', text: '<i>lowercase start.</i>' },
    { annotationId: 'd', speakerKey: 'speaker-1', text: '...[laughs] Upper after ellipsis.' },
    { annotationId: 'e', speakerKey: 'speaker-1', text: '...<i>lower after ellipsis.</i>' },
    { annotationId: 'f', speakerKey: 'speaker-1', text: '[laughs] ...Upper after tagged ellipsis.' },
    { annotationId: 'g', speakerKey: 'speaker-1', text: '{TAG: X} ...lower after tagged ellipsis.' }
  ];

  assert.equal(hasSegmentStartCapitalizationViolation(entries[0], entries, 0), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[1], entries, 1), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[2], entries, 2), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[3], entries, 3), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[4], entries, 4), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[5], entries, 5), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[6], entries, 6), false);
});

test('flags polite Russian pronouns only when sentence context requires a different case', () => {
  assert.equal(hasPolitePronounCaseViolation('\u0412\u044b \u043f\u0440\u0430\u0432\u044b.'), false);
  assert.equal(hasPolitePronounCaseViolation('\u0432\u044b \u043f\u0440\u0430\u0432\u044b.'), false);
  assert.equal(hasPolitePronounCaseViolation('\u0414\u0430, <\u0441\u043c\u0435\u0445-\u0432-\u0440\u0435\u0447\u0438> \u0412\u044b </\u0441\u043c\u0435\u0445-\u0432-\u0440\u0435\u0447\u0438> \u0433\u043e\u0432\u043e\u0440\u0438\u043b\u0438.'), false);
  assert.equal(hasPolitePronounCaseViolation('\u0414\u0430, </\u0441\u043c\u0435\u0445-\u0432-\u0440\u0435\u0447\u0438> \u0412\u044b \u0433\u043e\u0432\u043e\u0440\u0438\u043b\u0438.'), true);
  assert.equal(
    hasPolitePronounCaseViolation('\u0421\u043f\u0430\u0441\u0438\u0431\u043e, \u0412\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.'),
    true
  );
  assert.equal(
    hasPolitePronounCaseViolation('\u0421\u043f\u0430\u0441\u0438\u0431\u043e. \u0432\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.'),
    false
  );
  assert.equal(
    hasPolitePronounCaseViolation('\u0414\u0430. --\u0412\u0430\u043c\u0438 \u044d\u0442\u043e \u0441\u0434\u0435\u043b\u0430\u043d\u043e.'),
    false
  );
  assert.equal(
    hasPolitePronounCaseViolation('\u0418 ...\u0412\u0430\u0448\u0435\u043c\u0443 \u043f\u0440\u0438\u043c\u0435\u0440\u0443 \u0441\u043b\u0435\u0434\u0443\u044e\u0442.'),
    false
  );
  assert.equal(
    hasPolitePronounCaseViolation('\u041c\u043d\u0435 \u043d\u0443\u0436\u043d\u043e \u0441\u043a\u0430\u0437\u0430\u0442\u044c: "\u0412\u044b \u0437\u043d\u0430\u0435\u0442\u0435, \u0440\u0435\u0431\u044f\u0442".'),
    false
  );
});

test('segment capitalization rule uses sentence-start case for polite pronouns', () => {
  const entries = [
    { annotationId: 'a', speakerKey: 'speaker-1', text: '\u0432\u044b \u043f\u0440\u0430\u0432\u044b.' },
    { annotationId: 'b', speakerKey: 'speaker-1', text: '[laughs] \u0432\u0430\u0448\u0430 \u0432\u0435\u0440\u0441\u0438\u044f \u043b\u0443\u0447\u0448\u0435.' }
  ];

  assert.equal(hasSegmentStartCapitalizationViolation(entries[0], entries, 0), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[1], entries, 1), true);
});

test('fixes native Babel-style leading and trailing spaces', () => {
  assert.equal(fixLeadingTrailingSpaces('  hello world  '), 'hello world');
  assert.equal(fixLeadingTrailingSpaces('\thello world\t'), 'hello world');
});

test('fixes native Babel-style repeated internal spaces only', () => {
  assert.equal(fixDoubleSpaces('hello  world'), 'hello world');
  assert.equal(fixDoubleSpaces('hello   brave   world'), 'hello brave world');
  assert.equal(fixDoubleSpaces('  hello world  '), '  hello world  ');
});

test('applyAllFixes combines native and helper autofixes conservatively', () => {
  assert.equal(
    applyAllFixes('  hello  ,world  '),
    'hello, world.'
  );
  assert.equal(
    applyAllFixes('foo" bar "baz'),
    'foo" bar "baz.'
  );
  assert.equal(
    applyAllFixes('He said, "Hello"'),
    'He said, "Hello"'
  );
  assert.equal(
    applyAllFixes('already done!'),
    'already done!'
  );
  assert.equal(
    applyAllFixes('pause--'),
    'pause--'
  );
  assert.equal(
    applyAllFixes('hello world</i>'),
    'hello world. </i>'
  );
  assert.equal(
    applyAllFixes('hello world [laughs]'),
    'hello world. [laughs]'
  );
  assert.equal(
    applyAllFixes('hello. world'),
    'hello. World.'
  );
  assert.equal(
    applyAllFixes('"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u0441 \u0432\u043e\u043f\u0440\u043e\u0441\u043e\u043c?"- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430'),
    '"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u0441 \u0432\u043e\u043f\u0440\u043e\u0441\u043e\u043c?"- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'
  );
});

test('applyAllFixes normalizes unicode quote variants without changing quote spacing', () => {
  assert.equal(
    applyAllFixes('foo\u00ab bar \u00bbbaz'),
    'foo" bar "baz.'
  );
  assert.equal(
    applyAllFixes('\u300chello\u300d'),
    '"hello"'
  );
});

test('applyAllFixes includes period and angle tag spacing fixes', () => {
  assert.equal(applyAllFixes('hello .world'), 'hello. World.');
  assert.equal(applyAllFixes('hello<TAG>world'), 'hello <TAG> world.');
  assert.equal(applyAllFixes('<TAG>hello world</TAG>'), '<TAG> hello world. </TAG>');
});

test('moves punctuation before closing angle tags', () => {
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>.'), 'Да. </TAG>');
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>:'), 'Да: </TAG>');
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>".'), 'Да". </TAG>');
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>--'), 'Да-- </TAG>');
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>   ?! next'), 'Да?! </TAG> next');
  assert.equal(fixAngleTagTrailingPunctuation('Да. </TAG>'), 'Да. </TAG>');
  assert.equal(fixAngleTagTrailingPunctuation('Да <TAG>.'), 'Да <TAG>.');
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG'), 'Да </TAG');
});

test('applyAllFixes moves punctuation before closing angle tags', () => {
  assert.equal(applyAllFixes('Да </TAG>.'), 'Да. </TAG>');
  assert.equal(applyAllFixes('Да </TAG>:'), 'Да: </TAG>');
  assert.equal(applyAllFixes('Да </TAG>".'), 'Да". </TAG>');
});

test('moves standalone opening quotes after opening angle tags', () => {
  assert.equal(fixAngleTagTrailingPunctuation('Da " <TAG> text'), 'Da <TAG> "text');
  assert.equal(fixAngleTagTrailingPunctuation('Da "<TAG> text'), 'Da <TAG> "text');
  assert.equal(fixAngleTagTrailingPunctuation('Da. <TAG> text'), 'Da. <TAG> text');
  assert.equal(fixAngleTagTrailingPunctuation('Da?! <TAG> text'), 'Da?! <TAG> text');
  assert.equal(fixAngleTagTrailingPunctuation('. <TAG> text'), '. <TAG> text');
  assert.equal(fixAngleTagTrailingPunctuation('Da." <TAG> text'), 'Da." <TAG> text');
  assert.equal(fixAngleTagTrailingPunctuation('Da <TAG>. text'), 'Da <TAG>. text');
  assert.equal(applyAllFixes('Da "<TAG>text'), 'Da <TAG> "text.');
});

test('moves punctuation before curly tags that annotate preceding text', () => {
  assert.equal(fixCurlyTagTrailingPunctuation('3 {SKAZ: three}".'), '3". {SKAZ: three}');
  assert.equal(fixCurlyTagTrailingPunctuation('3 {SKAZ: three}.'), '3. {SKAZ: three}');
  assert.equal(fixCurlyTagTrailingPunctuation('3 {SKAZ: three}, next'), '3, {SKAZ: three} next');
  assert.equal(fixCurlyTagTrailingPunctuation('3 {SKAZ: three}--'), '3-- {SKAZ: three}');
  assert.equal(fixCurlyTagTrailingPunctuation('3 {SKAZ: three}-'), '3- {SKAZ: three}');
  assert.equal(fixCurlyTagTrailingPunctuation('3 {SKAZ: three}   ?! next'), '3?! {SKAZ: three} next');
  assert.equal(fixCurlyTagTrailingPunctuation('3". {SKAZ: three}'), '3". {SKAZ: three}');
  assert.equal(fixCurlyTagTrailingPunctuation('{SKAZ: three}".'), '{SKAZ: three}".');
  assert.equal(fixCurlyTagTrailingPunctuation('3 {SKAZ: three'), '3 {SKAZ: three');
});

test('applyAllFixes moves punctuation before curly tags before terminal checks', () => {
  assert.equal(applyAllFixes('3 {SKAZ: three}".'), '3". {SKAZ: three}');
  assert.equal(applyAllFixes('3 {SKAZ: three}--'), '3-- {SKAZ: three}');
  assert.equal(applyAllFixes('3 {SKAZ: three}, next'), '3, {SKAZ: three} next.');
});

test('moves punctuation before square bracket tags that annotate preceding text', () => {
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh], who'), 'workers, [laugh] who');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh].'), 'workers. [laugh]');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh]--'), 'workers-- [laugh]');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh]   ?! who'), 'workers?! [laugh] who');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers, [laugh] who'), 'workers, [laugh] who');
  assert.equal(fixSquareBracketTagTrailingPunctuation('[laugh], who'), '[laugh], who');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh'), 'workers [laugh');
});

test('applyAllFixes spaces bracket tags and moves punctuation before them', () => {
  assert.equal(applyAllFixes('workers[laugh],who'), 'workers, [laugh] who.');
  assert.equal(applyAllFixes('workers [laugh], who'), 'workers, [laugh] who.');
  assert.equal(applyAllFixes('workers [ laugh ] .'), 'workers. [laugh]');
});

test('fixSegmentStartCapitalization respects same-speaker continuations and ellipsis starts', () => {
  assert.equal(fixSegmentStartCapitalization('lowercase start.', 'Previous sentence.'), 'Lowercase start.');
  assert.equal(fixSegmentStartCapitalization('lowercase continuation.', 'carry on...'), 'lowercase continuation.');
  assert.equal(fixSegmentStartCapitalization('lowercase continuation.', 'carry on--'), 'lowercase continuation.');
  assert.equal(fixSegmentStartCapitalization('"lowercase continuation."', 'carry on--"'), '"lowercase continuation."');
  assert.equal(fixSegmentStartCapitalization('"lowercase continuation."', 'carry on..."'), '"lowercase continuation."');
  assert.equal(fixSegmentStartCapitalization('\u0432\u044b \u043f\u0440\u0430\u0432\u044b.', 'Previous sentence.'), '\u0412\u044b \u043f\u0440\u0430\u0432\u044b.');
  assert.equal(fixSegmentStartCapitalization('[laughs] \u0432\u0430\u0448\u0430 \u0432\u0435\u0440\u0441\u0438\u044f.', 'Previous sentence.'), '[laughs] \u0412\u0430\u0448\u0430 \u0432\u0435\u0440\u0441\u0438\u044f.');
  assert.equal(fixSegmentStartCapitalization('\u0412\u044b \u043f\u0440\u0430\u0432\u044b.', 'carry on...'), '\u0412\u044b \u043f\u0440\u0430\u0432\u044b.');
  assert.equal(fixSegmentStartCapitalization('...Upper after ellipsis.', 'Previous sentence.'), '...upper after ellipsis.');
  assert.equal(fixSegmentStartCapitalization('...lower after ellipsis.', 'Previous sentence.'), '...lower after ellipsis.');
  assert.equal(fixSegmentStartCapitalization('... 123 Upper after number.', 'Previous sentence.'), '... 123 Upper after number.');
  assert.equal(
    fixSegmentStartCapitalization('... [laughs] 123 Upper after number.', 'Previous sentence.'),
    '... [laughs] 123 Upper after number.'
  );
  assert.equal(fixSegmentStartCapitalization('[laughs] lowercase start.', 'Previous sentence.'), '[laughs] Lowercase start.');
  assert.equal(fixSegmentStartCapitalization('<i>lowercase start.</i>', 'Previous sentence.'), '<i>Lowercase start.</i>');
  assert.equal(fixSegmentStartCapitalization('...[laughs] Upper after ellipsis.', 'Previous sentence.'), '...[laughs] upper after ellipsis.');
  assert.equal(fixSegmentStartCapitalization('[laughs] ...Upper after ellipsis.', 'Previous sentence.'), '[laughs] ...upper after ellipsis.');
});


test('flags double dash punctuation violation', () => {
  assert.equal(hasDoubleDashPunctuationViolation('wait--.'), true);
  assert.equal(hasDoubleDashPunctuationViolation('wait--,'), true);
  assert.equal(hasDoubleDashPunctuationViolation('wait--?'), true);
  assert.equal(hasDoubleDashPunctuationViolation('wait--!'), true);
  assert.equal(hasDoubleDashPunctuationViolation('wait-- '), false);
  assert.equal(hasDoubleDashPunctuationViolation('wait.--'), false);
  assert.equal(hasDoubleDashPunctuationViolation('<wait--.>'), false);
  assert.equal(hasDoubleDashPunctuationViolation('{wait--.}'), false);
  assert.equal(hasDoubleDashPunctuationViolation('[wait--.]'), false);
});

test('flags and fixes commas before dash separators', () => {
  assert.equal(hasCommaBeforeDashViolation('TEXT, - TEXT'), true);
  assert.equal(hasCommaBeforeDashViolation('TEXT,  - TEXT'), true);
  assert.equal(hasCommaBeforeDashViolation('TEXT,- TEXT'), true);
  assert.equal(hasCommaBeforeDashViolation('TEXT, -- TEXT'), true);
  assert.equal(hasCommaBeforeDashViolation('TEXT - TEXT'), false);
  assert.equal(hasCommaBeforeDashViolation('TEXT, next'), false);
  assert.equal(hasCommaBeforeDashViolation('TEXT, -2'), false);
  assert.equal(hasCommaBeforeDashViolation('<TEXT, - TEXT>'), false);
  assert.equal(hasCommaBeforeDashViolation('{TEXT, - TEXT}'), false);
  assert.equal(hasCommaBeforeDashViolation('[TEXT, - TEXT]'), false);

  assert.equal(fixCommaBeforeDash('TEXT, - TEXT'), 'TEXT - TEXT');
  assert.equal(fixCommaBeforeDash('TEXT,  - TEXT'), 'TEXT - TEXT');
  assert.equal(fixCommaBeforeDash('TEXT,- TEXT'), 'TEXT - TEXT');
  assert.equal(fixCommaBeforeDash('TEXT, -- TEXT'), 'TEXT -- TEXT');
  assert.equal(fixCommaBeforeDash('<TEXT, - TEXT> {TEXT, - TEXT} [TEXT, - TEXT]'), '<TEXT, - TEXT> {TEXT, - TEXT} [TEXT, - TEXT]');
});

test('applyAllFixes removes commas before dash separators', () => {
  assert.equal(applyAllFixes('TEXT, - TEXT'), 'TEXT - TEXT.');
  assert.equal(applyAllFixes('TEXT, -- TEXT'), 'TEXT - TEXT.');
});

test('flags and fixes free-floating mid-sentence double dashes', () => {
  assert.equal(hasFreeMidSentenceDoubleDashViolation('hello -- world'), true);
  assert.equal(hasFreeMidSentenceDoubleDashViolation('hello  --   world'), true);
  assert.equal(hasFreeMidSentenceDoubleDashViolation('hello--world'), false);
  assert.equal(hasFreeMidSentenceDoubleDashViolation('hello --'), false);
  assert.equal(hasFreeMidSentenceDoubleDashViolation('-- hello'), false);
  assert.equal(hasFreeMidSentenceDoubleDashViolation('"hello -- world"'), false);
  assert.equal(hasFreeMidSentenceDoubleDashViolation('<hello -- world>'), false);
  assert.equal(hasFreeMidSentenceDoubleDashViolation('{hello -- world}'), false);

  assert.equal(fixFreeMidSentenceDoubleDash('hello -- world'), 'hello - world');
  assert.equal(fixFreeMidSentenceDoubleDash('hello  --   world'), 'hello - world');
  assert.equal(fixFreeMidSentenceDoubleDash('"hello -- world"'), '"hello -- world"');
  assert.equal(fixFreeMidSentenceDoubleDash('<hello -- world>'), '<hello -- world>');
});

test('applyAllFixes replaces free-floating mid-sentence double dashes', () => {
  assert.equal(applyAllFixes('hello -- world'), 'hello - world.');
});

test('fixes double dash punctuation', () => {
  assert.equal(fixDoubleDashPunctuation('wait--.'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--,'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--?'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--!'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--...'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--?!'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('<wait--.> {wait--?} [wait--!]'), '<wait--.> {wait--?} [wait--!]');
});

test('applyAllFixes includes double dash punctuation fix', () => {
  assert.equal(applyAllFixes('wait--.'), 'wait--');
});

test('treats generic bracket, curly, and angle tokens as tags for double dash placement', () => {
  assert.equal(hasDoubleDashOutsideQuoteOrGenericTagViolation('wait -- outside'), true);
  assert.equal(hasDoubleDashOutsideQuoteOrGenericTagViolation('"wait -- quoted"'), false);
  assert.equal(hasDoubleDashOutsideQuoteOrGenericTagViolation('<wait -- tagged>'), false);
  assert.equal(hasDoubleDashOutsideQuoteOrGenericTagViolation('{wait -- tagged}'), false);
  assert.equal(hasDoubleDashOutsideQuoteOrGenericTagViolation('[wait -- tagged]'), false);
  assert.equal(hasDoubleDashOutsideQuoteOrGenericTagViolation('[wait -- tagged] then -- outside'), true);
});

test('flags unicode dash variants', () => {
  assert.equal(hasUnicodeDashViolation('wait—what'), true);
  assert.equal(hasUnicodeDashViolation('wait–what'), true);
  assert.equal(hasUnicodeDashViolation('wait−what'), true);
  assert.equal(hasUnicodeDashViolation('wait-what'), false);
});

test('fixes unicode dash variants to ascii hyphen', () => {
  assert.equal(fixUnicodeDashes('wait—what'), 'wait-what');
  assert.equal(fixUnicodeDashes('wait–what'), 'wait-what');
  assert.equal(fixUnicodeDashes('wait−what'), 'wait-what');
  assert.equal(fixUnicodeDashes('wait――what'), 'wait--what');
});

test('fixes unicode quote variants to ascii double quotes', () => {
  assert.equal(fixUnicodeQuotes('\u00abhello\u00bb'), '"hello"');
  assert.equal(fixUnicodeQuotes('\u201chello\u201d'), '"hello"');
  assert.equal(fixUnicodeQuotes('\u300chello\u300d'), '"hello"');
  assert.equal(fixUnicodeQuotes('\u301dhello\u301f'), '"hello"');
});

test('applyAllFixes normalizes unicode dashes before other dash rules', () => {
  assert.equal(applyAllFixes('wait—.'), 'wait-');
  assert.equal(applyAllFixes('pause――'), 'pause--');
});

test('flags single dash punctuation violation', () => {
  assert.equal(hasSingleDashPunctuationViolation('wait-.'), true);
  assert.equal(hasSingleDashPunctuationViolation('wait-,'), true);
  assert.equal(hasSingleDashPunctuationViolation('wait-?'), true);
  assert.equal(hasSingleDashPunctuationViolation('wait-!'), true);
  assert.equal(hasSingleDashPunctuationViolation('wait- '), false);
  assert.equal(hasSingleDashPunctuationViolation('wait.-'), false);
  assert.equal(hasSingleDashPunctuationViolation('wait--.'), false); // Handled by double dash rule
  assert.equal(hasSingleDashPunctuationViolation('<wait-.>'), false);
  assert.equal(hasSingleDashPunctuationViolation('{wait-.}'), false);
  assert.equal(hasSingleDashPunctuationViolation('[wait-.]'), false);
});

test('fixes single dash punctuation', () => {
  assert.equal(fixSingleDashPunctuation('wait-.'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait-,'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait-?'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait-!'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait--.'), 'wait--.'); // Should not touch double dash
  assert.equal(fixSingleDashPunctuation('<wait-.> {wait-?} [wait-!]'), '<wait-.> {wait-?} [wait-!]');
});

test('applyAllFixes includes single dash punctuation fix', () => {
  assert.equal(applyAllFixes('wait-.'), 'wait-');
});

test('flags incorrect interjection forms at token boundaries only', () => {
  assert.equal(hasIncorrectInterjectionFormsViolation('аа, я понял.'), true);
  assert.equal(hasIncorrectInterjectionFormsViolation('ей богу, это так.'), true);
  assert.equal(hasIncorrectInterjectionFormsViolation('э-э, секунду.'), true);
  assert.equal(hasIncorrectInterjectionFormsViolation('мм, да.'), true);
  assert.equal(hasIncorrectInterjectionFormsViolation('схммм'), false);
  assert.equal(hasIncorrectInterjectionFormsViolation('подруга'), false);
});

test('normalizes incorrect interjection forms conservatively', () => {
  assert.equal(normalizeIncorrectInterjectionForms('аа, я понял.'), 'а, я понял.');
  assert.equal(normalizeIncorrectInterjectionForms('а-а, я понял.'), 'а, я понял.');
  assert.equal(normalizeIncorrectInterjectionForms('ей богу, это так.'), 'ей-богу, это так.');
  assert.equal(normalizeIncorrectInterjectionForms('Ну, да.'), 'Ну да.');
  assert.equal(normalizeIncorrectInterjectionForms('о, нет!'), 'о нет!');
  assert.equal(normalizeIncorrectInterjectionForms('у-у, ясно.'), 'у, ясно.');
  assert.equal(normalizeIncorrectInterjectionForms('э-э, секунду.'), 'э, секунду.');
  assert.equal(normalizeIncorrectInterjectionForms('мм, да.'), 'м, да.');
  assert.equal(normalizeIncorrectInterjectionForms('ОК, хмм.'), 'ОК, хм.');
  assert.equal(normalizeIncorrectInterjectionForms('хахаха!'), 'ха-ха!');
});

test('preserves case shape when normalizing incorrect interjection forms', () => {
  assert.equal(normalizeIncorrectInterjectionForms('ОК, ХММ.'), 'ОК, ХМ.');
  assert.equal(normalizeIncorrectInterjectionForms('Ей богу, это так.'), 'Ей-богу, это так.');
  assert.equal(normalizeIncorrectInterjectionForms('А-м, ну ладно.'), 'Ам, ну ладно.');
  assert.equal(normalizeIncorrectInterjectionForms('А-М, ну ладно.'), 'АМ, ну ладно.');
});

test('applyAllFixes includes incorrect interjection normalization', () => {
  assert.equal(applyAllFixes('ей богу'), 'ей-богу.');
  assert.equal(applyAllFixes('ОК, хмм'), 'ОК, хм.');
});
test('fixes polite Russian pronouns according to sentence context', () => {
  assert.equal(fixPolitePronounCase('\u0432\u044b \u043f\u0440\u0430\u0432\u044b.'), '\u0432\u044b \u043f\u0440\u0430\u0432\u044b.');
  assert.equal(fixPolitePronounCase('\u0421\u043f\u0430\u0441\u0438\u0431\u043e, \u0412\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.'), '\u0421\u043f\u0430\u0441\u0438\u0431\u043e, \u0432\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.');
  assert.equal(fixPolitePronounCase('\u0421\u043f\u0430\u0441\u0438\u0431\u043e. \u0432\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.'), '\u0421\u043f\u0430\u0441\u0438\u0431\u043e. \u0432\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.');
  assert.equal(fixPolitePronounCase('\u0414\u0430. --\u0412\u0430\u043c\u0438 \u044d\u0442\u043e \u0441\u0434\u0435\u043b\u0430\u043d\u043e.'), '\u0414\u0430. --\u0412\u0430\u043c\u0438 \u044d\u0442\u043e \u0441\u0434\u0435\u043b\u0430\u043d\u043e.');
  assert.equal(fixPolitePronounCase('\u0418 ...\u0412\u0430\u0448\u0435\u043c\u0443 \u043f\u0440\u0438\u043c\u0435\u0440\u0443 \u0441\u043b\u0435\u0434\u0443\u044e\u0442.'), '\u0418 ...\u0412\u0430\u0448\u0435\u043c\u0443 \u043f\u0440\u0438\u043c\u0435\u0440\u0443 \u0441\u043b\u0435\u0434\u0443\u044e\u0442.');
  assert.equal(fixPolitePronounCase('\u041c\u043d\u0435 \u043d\u0443\u0436\u043d\u043e \u0441\u043a\u0430\u0437\u0430\u0442\u044c: "\u0412\u044b \u0437\u043d\u0430\u0435\u0442\u0435".'), '\u041c\u043d\u0435 \u043d\u0443\u0436\u043d\u043e \u0441\u043a\u0430\u0437\u0430\u0442\u044c: "\u0412\u044b \u0437\u043d\u0430\u0435\u0442\u0435".');
});

test('applyAllFixes includes polite Russian pronoun normalization', () => {
  assert.equal(fixPolitePronounCase(applyAllFixes('\u0432\u044b \u043f\u0440\u0430\u0432\u044b')), '\u0432\u044b \u043f\u0440\u0430\u0432\u044b.');
  assert.equal(fixPolitePronounCase(applyAllFixes('\u0421\u043f\u0430\u0441\u0438\u0431\u043e. \u0432\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.')), '\u0421\u043f\u0430\u0441\u0438\u0431\u043e. \u0412\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.');
});

test('fixes lowercase words after clear sentence boundaries inside a segment', () => {
  assert.equal(fixSentenceBoundaryCapitalization('Hello. world'), 'Hello. World');
  assert.equal(fixSentenceBoundaryCapitalization('Hello? world'), 'Hello? World');
  assert.equal(fixSentenceBoundaryCapitalization('Hello! world'), 'Hello! World');
  assert.equal(fixSentenceBoundaryCapitalization('Hello... world'), 'Hello... world');
  assert.equal(fixSentenceBoundaryCapitalization('Hello -- world'), 'Hello -- world');
  assert.equal(fixSentenceBoundaryCapitalization('Hello - world'), 'Hello - world');
  assert.equal(fixSentenceBoundaryCapitalization('Hello. "world"'), 'Hello. "World"');
  assert.equal(fixSentenceBoundaryCapitalization('Hello. [laughs] world'), 'Hello. [laughs] World');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello?" - world'), '"Hello?" - world');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello?"- world'), '"Hello?"- world');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello!"- world'), '"Hello!"- world');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello?!" - world'), '"Hello?!" - world');
  assert.equal(fixSentenceBoundaryCapitalization('\u00abHello?\u00bb - world'), '\u00abHello?\u00bb - world');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello?" - [tag] world'), '"Hello?" - [tag] world');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello? - asked he. - What next?"'), '"Hello? - asked he. - What next?"');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello! - shouted he. - Go."'), '"Hello! - shouted he. - Go."');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello?! - asked he. - Really?"'), '"Hello?! - asked he. - Really?"');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello."- world'), '"Hello."- World');
  assert.equal(fixSentenceBoundaryCapitalization('Hello? - world'), 'Hello? - World');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello? - asked he. - what next?"'), '"Hello? - asked he. - What next?"');
  assert.equal(
    fixSentenceBoundaryCapitalization('"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u0441 \u0432\u043e\u043f\u0440\u043e\u0441\u043e\u043c?"- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'),
    '"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u0441 \u0432\u043e\u043f\u0440\u043e\u0441\u043e\u043c?"- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'
  );
  assert.equal(
    fixSentenceBoundaryCapitalization('"\u0427\u0442\u043e? - \u0441\u043f\u0440\u043e\u0441\u0438\u043b \u043e\u043d. - \u0427\u0442\u043e \u0434\u0430\u043b\u044c\u0448\u0435?"'),
    '"\u0427\u0442\u043e? - \u0441\u043f\u0440\u043e\u0441\u0438\u043b \u043e\u043d. - \u0427\u0442\u043e \u0434\u0430\u043b\u044c\u0448\u0435?"'
  );
  assert.equal(
    fixSentenceBoundaryCapitalization('"\u0427\u0442\u043e? - \u0441\u043f\u0440\u043e\u0441\u0438\u043b \u043e\u043d. - \u0447\u0442\u043e \u0434\u0430\u043b\u044c\u0448\u0435?"'),
    '"\u0427\u0442\u043e? - \u0441\u043f\u0440\u043e\u0441\u0438\u043b \u043e\u043d. - \u0427\u0442\u043e \u0434\u0430\u043b\u044c\u0448\u0435?"'
  );
  assert.equal(
    fixSentenceBoundaryCapitalization('"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u043a\u043e\u043d\u0447\u0438\u043b\u0430\u0441\u044c."- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'),
    '"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u043a\u043e\u043d\u0447\u0438\u043b\u0430\u0441\u044c."- \u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'
  );
});
