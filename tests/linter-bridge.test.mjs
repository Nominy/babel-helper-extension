import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const bridgePath = path.resolve('src/content/linter-bridge.ts');
fs.readFileSync(bridgePath, 'utf8');

function hasCommaSpacingViolation(text) {
  if (typeof text !== 'string' || text.indexOf(',') === -1) {
    return false;
  }

  return /\s+,/.test(text) || /(?<!\d),(?![\d ]|$)/.test(text) || /, {2,}/.test(text);
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

function hasQuotePlacementViolation(text) {
  const normalizedText = normalizeUnicodeDoubleQuoteVariants(text);
  const quoteIndices = getQuoteIndices(normalizedText);
  if (!quoteIndices.length || quoteIndices.length % 2 === 1) {
    return false;
  }

  for (let index = 0; index < quoteIndices.length; index += 2) {
    const openIndex = quoteIndices[index];
    const closeIndex = quoteIndices[index + 1];
    const prevChar = openIndex > 0 ? normalizedText[openIndex - 1] : '';
    const nextCharAfterOpen = openIndex + 1 < normalizedText.length ? normalizedText[openIndex + 1] : '';
    const prevCharBeforeClose = closeIndex > 0 ? normalizedText[closeIndex - 1] : '';
    const nextChar = closeIndex + 1 < normalizedText.length ? normalizedText[closeIndex + 1] : '';

    if (/\s/.test(nextCharAfterOpen) || /\s/.test(prevCharBeforeClose)) {
      return true;
    }

    if (isWordCharacter(prevChar) || isWordCharacter(nextChar)) {
      return true;
    }
  }

  return false;
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

function hasDoubleDashPunctuationViolation(text) {
  if (typeof text !== 'string' || text.indexOf('--') === -1) {
    return false;
  }

  return /--[.,?!:;]/.test(text);
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

  return /(?<!-)-[.,?!:;]/.test(text);
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
  { canonical: 'окей', variants: ["о'кей", 'ОК'] },
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

  return !/(?:\.\.\.|--|[?!."])$/.test(trimmed);
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

function hasSentenceBoundaryCapitalizationViolation(text) {
  return findSentenceBoundaryLowercaseIndices(text).length > 0;
}

function getPolitePronounCaseExpectation(text, tokenIndex) {
  if (typeof text !== 'string' || tokenIndex < 0) {
    return 'neutral';
  }

  const firstLetterIndex = findFirstLetterIndex(text, skipLeadingCapitalizationTokens(text));
  if (firstLetterIndex !== -1 && tokenIndex === firstLetterIndex) {
    return 'neutral';
  }

  let pointer = tokenIndex - 1;
  while (pointer >= 0 && /\s/.test(text[pointer])) {
    pointer -= 1;
  }

  while (pointer >= 0 && /["')\]\}\u00BB\u201D\u2019]/u.test(text[pointer])) {
    pointer -= 1;
    while (pointer >= 0 && /\s/.test(text[pointer])) {
      pointer -= 1;
    }
  }

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

  if (trimmed.startsWith('...')) {
    if (startsWithNumericToken(trimmed, 3)) {
      return false;
    }

    const ellipsisLetterIndex = findFirstLetterIndex(
      trimmed,
      skipLeadingCapitalizationTokens(trimmed, 3)
    );
    if (ellipsisLetterIndex === -1) {
      return false;
    }

    return isUppercaseLetter(trimmed[ellipsisLetterIndex]);
  }

  const firstLetterIndex = findFirstLetterIndex(trimmed, skipLeadingCapitalizationTokens(trimmed));
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

function fixQuotePlacement(text) {
  const quoteIndices = getQuoteIndices(text);
  if (!quoteIndices.length || quoteIndices.length % 2 === 1) {
    return text;
  }

  let result = text;
  for (let index = quoteIndices.length - 2; index >= 0; index -= 2) {
    const openIndex = quoteIndices[index];
    const closeIndex = quoteIndices[index + 1];
    const inner = result.substring(openIndex + 1, closeIndex);
    const trimmedInner = inner.replace(/^\s+/, '').replace(/\s+$/, '');
    const before = result.substring(0, openIndex);
    const after = result.substring(closeIndex + 1);

    let prefix = before;
    if (prefix.length > 0 && isWordCharacter(prefix[prefix.length - 1])) {
      prefix = prefix + ' ';
    }

    let suffix = after;
    if (suffix.length > 0 && isWordCharacter(suffix[0])) {
      suffix = ' ' + suffix;
    }

    result = prefix + '"' + trimmedInner + '"' + suffix;
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

function fixDoubleDashPunctuation(text) {
  if (typeof text !== 'string' || text.indexOf('--') === -1) {
    return text;
  }

  // Remove punctuation immediately after double dash
  return text.replace(/--[.,?!:;]+/g, '--');
}

function fixSingleDashPunctuation(text) {
  if (typeof text !== 'string' || text.indexOf('-') === -1) {
    return text;
  }

  // Remove punctuation immediately after single dash
  // A single dash is a '-' not preceded by '-' and not followed by '-'
  return text.replace(/(?<!-)-(?!-)[.,?!:;]+/g, '-');
}

function fixTerminalPunctuation(text) {
  if (typeof text !== 'string') {
    return text;
  }

  const trimmed = stripTrailingTagTokens(text);
  if (!trimmed || /(?:\.\.\.|--|[?!."-])$/.test(trimmed)) {
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

  if (trimmed.startsWith('...')) {
    const sourceIndex = text.indexOf('...');
    const contentStartIndex = skipLeadingCapitalizationTokens(
      text,
      sourceIndex === -1 ? 0 : sourceIndex + 3
    );
    if (startsWithNumericToken(text, contentStartIndex)) {
      return text;
    }

    const letterIndex = findFirstLetterIndex(text, contentStartIndex);
    if (letterIndex === -1 || !isUppercaseLetter(text[letterIndex])) {
      return text;
    }

    return replaceCharAt(text, letterIndex, text[letterIndex].toLocaleLowerCase());
  }

  const letterIndex = findFirstLetterIndex(text, skipLeadingCapitalizationTokens(text));
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
  result = fixUnicodeQuotes(result);
  result = fixQuotePlacement(result);
  result = fixCurlySpacing(result);
  result = fixUnicodeDashes(result);
  result = fixDoubleDashPunctuation(result);
  result = fixSingleDashPunctuation(result);
  result = normalizeIncorrectInterjectionForms(result);
  result = fixTerminalPunctuation(result);
  result = fixSentenceBoundaryCapitalization(result);
  return result;
}

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

test('flags unbalanced double quotes', () => {
  assert.equal(hasUnbalancedDoubleQuotes('Он сказал "привет.'), true);
  assert.equal(hasUnbalancedDoubleQuotes('Он сказал "привет".'), false);
});

test('flags bad quote placement', () => {
  assert.equal(hasQuotePlacementViolation('foo"bar"'), true);
  assert.equal(hasQuotePlacementViolation('" bar"'), true);
  assert.equal(hasQuotePlacementViolation('"bar "'), true);
  assert.equal(hasQuotePlacementViolation('foo "bar" baz'), false);
  assert.equal(hasQuotePlacementViolation('foo "bar", baz'), false);
});

test('treats unicode quote variants as quote characters in analysis', () => {
  assert.equal(hasUnbalancedDoubleQuotes('\u00abhello.'), true);
  assert.equal(hasQuotePlacementViolation('foo\u00abbar\u00bbbaz'), true);
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
    { annotationId: 'e', speakerKey: 'speaker-1', text: '...<i>lower after ellipsis.</i>' }
  ];

  assert.equal(hasSegmentStartCapitalizationViolation(entries[0], entries, 0), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[1], entries, 1), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[2], entries, 2), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[3], entries, 3), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[4], entries, 4), false);
});

test('flags polite Russian pronouns only when sentence context requires a different case', () => {
  assert.equal(hasPolitePronounCaseViolation('\u0412\u044b \u043f\u0440\u0430\u0432\u044b.'), false);
  assert.equal(hasPolitePronounCaseViolation('\u0432\u044b \u043f\u0440\u0430\u0432\u044b.'), false);
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
    'foo "bar" baz.'
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
    'hello world.</i>'
  );
  assert.equal(
    applyAllFixes('hello world [laughs]'),
    'hello world. [laughs]'
  );
  assert.equal(
    applyAllFixes('hello. world'),
    'hello. World.'
  );
});

test('applyAllFixes normalizes unicode quote variants before quote spacing', () => {
  assert.equal(
    applyAllFixes('foo\u00ab bar \u00bbbaz'),
    'foo "bar" baz.'
  );
  assert.equal(
    applyAllFixes('\u300chello\u300d'),
    '"hello"'
  );
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
});


test('flags double dash punctuation violation', () => {
  assert.equal(hasDoubleDashPunctuationViolation('wait--.'), true);
  assert.equal(hasDoubleDashPunctuationViolation('wait--,'), true);
  assert.equal(hasDoubleDashPunctuationViolation('wait--?'), true);
  assert.equal(hasDoubleDashPunctuationViolation('wait--!'), true);
  assert.equal(hasDoubleDashPunctuationViolation('wait-- '), false);
  assert.equal(hasDoubleDashPunctuationViolation('wait.--'), false);
});

test('fixes double dash punctuation', () => {
  assert.equal(fixDoubleDashPunctuation('wait--.'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--,'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--?'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--!'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--...'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--?!'), 'wait--');
});

test('applyAllFixes includes double dash punctuation fix', () => {
  assert.equal(applyAllFixes('wait--.'), 'wait--');
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
});

test('fixes single dash punctuation', () => {
  assert.equal(fixSingleDashPunctuation('wait-.'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait-,'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait-?'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait-!'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait--.'), 'wait--.'); // Should not touch double dash
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
  assert.equal(normalizeIncorrectInterjectionForms('ОК, хмм.'), 'ОКЕЙ, хм.');
  assert.equal(normalizeIncorrectInterjectionForms('хахаха!'), 'ха-ха!');
});

test('preserves case shape when normalizing incorrect interjection forms', () => {
  assert.equal(normalizeIncorrectInterjectionForms('ОК, ХММ.'), 'ОКЕЙ, ХМ.');
  assert.equal(normalizeIncorrectInterjectionForms('Ей богу, это так.'), 'Ей-богу, это так.');
  assert.equal(normalizeIncorrectInterjectionForms('А-м, ну ладно.'), 'Ам, ну ладно.');
  assert.equal(normalizeIncorrectInterjectionForms('А-М, ну ладно.'), 'АМ, ну ладно.');
});

test('applyAllFixes includes incorrect interjection normalization', () => {
  assert.equal(applyAllFixes('ей богу'), 'ей-богу.');
  assert.equal(applyAllFixes('ОК, хмм'), 'ОКЕЙ, хм.');
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
});
