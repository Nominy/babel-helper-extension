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
    'hello, world'
  );
  assert.equal(
    applyAllFixes('foo" bar "baz'),
    'foo "bar" baz'
  );
});
