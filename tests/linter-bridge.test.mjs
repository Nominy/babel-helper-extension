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

function hasUnbalancedDoubleQuotes(text) {
  return getQuoteIndices(text).length % 2 === 1;
}

function isWordCharacter(char) {
  return typeof char === 'string' && /[\p{L}\p{N}]/u.test(char);
}

function hasQuotePlacementViolation(text) {
  const quoteIndices = getQuoteIndices(text);
  if (!quoteIndices.length || quoteIndices.length % 2 === 1) {
    return false;
  }

  for (let index = 0; index < quoteIndices.length; index += 2) {
    const openIndex = quoteIndices[index];
    const closeIndex = quoteIndices[index + 1];
    const prevChar = openIndex > 0 ? text[openIndex - 1] : '';
    const nextCharAfterOpen = openIndex + 1 < text.length ? text[openIndex + 1] : '';
    const prevCharBeforeClose = closeIndex > 0 ? text[closeIndex - 1] : '';
    const nextChar = closeIndex + 1 < text.length ? text[closeIndex + 1] : '';

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

function hasTerminalPunctuationViolation(text) {
  if (typeof text !== 'string') {
    return false;
  }

  const trimmed = stripTrailingTagTokens(text);
  if (!trimmed) {
    return false;
  }

  return !/(?:\.\.\.|--|[?!.])$/.test(trimmed);
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

function endsWithLowercaseContinuationMarker(text) {
  return typeof text === 'string' && /(?:\.\.\.|--)\s*$/.test(text);
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

function hasSegmentStartCapitalizationViolation(entry, annotationEntries, index) {
  if (!entry || typeof entry.text !== 'string') {
    return false;
  }

  const trimmed = entry.text.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.startsWith('...')) {
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

function fixTerminalPunctuation(text) {
  if (typeof text !== 'string') {
    return text;
  }

  const trimmed = stripTrailingTagTokens(text);
  if (!trimmed || /(?:\.\.\.|--|[?!.])$/.test(trimmed)) {
    return text;
  }

  const insertionIndex = trimmed.length;
  return text.slice(0, insertionIndex) + '.' + text.slice(insertionIndex);
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
    const letterIndex = findFirstLetterIndex(
      text,
      skipLeadingCapitalizationTokens(text, sourceIndex === -1 ? 0 : sourceIndex + 3)
    );
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
  result = fixQuotePlacement(result);
  result = fixCurlySpacing(result);
  result = fixTerminalPunctuation(result);
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
  assert.equal(hasTerminalPunctuationViolation('hello world.</i>'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world</i>'), true);
  assert.equal(hasTerminalPunctuationViolation('hello world [laughs]'), true);
  assert.equal(hasTerminalPunctuationViolation('hello world. [laughs]'), false);
  assert.equal(hasTerminalPunctuationViolation('hello world {TAG: X}'), true);
  assert.equal(hasTerminalPunctuationViolation('hello world. {TAG: X}'), false);
  assert.equal(hasTerminalPunctuationViolation('   '), false);
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
    { annotationId: 'h', speakerKey: 'speaker-1', text: '...lower after ellipsis.' }
  ];

  assert.equal(hasSegmentStartCapitalizationViolation(entries[0], entries, 0), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[1], entries, 1), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[3], entries, 3), false);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[5], entries, 5), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[6], entries, 6), true);
  assert.equal(hasSegmentStartCapitalizationViolation(entries[7], entries, 7), false);
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
});

test('fixSegmentStartCapitalization respects same-speaker continuations and ellipsis starts', () => {
  assert.equal(fixSegmentStartCapitalization('lowercase start.', 'Previous sentence.'), 'Lowercase start.');
  assert.equal(fixSegmentStartCapitalization('lowercase continuation.', 'carry on...'), 'lowercase continuation.');
  assert.equal(fixSegmentStartCapitalization('lowercase continuation.', 'carry on--'), 'lowercase continuation.');
  assert.equal(fixSegmentStartCapitalization('...Upper after ellipsis.', 'Previous sentence.'), '...upper after ellipsis.');
  assert.equal(fixSegmentStartCapitalization('...lower after ellipsis.', 'Previous sentence.'), '...lower after ellipsis.');
  assert.equal(fixSegmentStartCapitalization('[laughs] lowercase start.', 'Previous sentence.'), '[laughs] Lowercase start.');
  assert.equal(fixSegmentStartCapitalization('<i>lowercase start.</i>', 'Previous sentence.'), '<i>Lowercase start.</i>');
  assert.equal(fixSegmentStartCapitalization('...[laughs] Upper after ellipsis.', 'Previous sentence.'), '...[laughs] upper after ellipsis.');
});
