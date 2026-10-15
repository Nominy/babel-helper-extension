import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/core/replacement-rules.ts'], bundle: true, format: 'esm',
  platform: 'browser', write: false, logLevel: 'silent'
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
const rule = (id, find, replace, options = {}) => ({ id, find, replace,
  regex: false, caseSensitive: true, wholeWord: false, enabled: true, ...options });
const replace = (text, rules) => api.replaceTextWithRules(text, api.compileReplacementRules(rules));

test('storage boundary validates every field and unique IDs, returns owned records and ignores extra fields', () => {
  const input = [rule('a', 'one', 'two', { extra: 'not stored' })];
  const parsed = api.parseReplacementRules(input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed[0], input[0]);
  assert.deepEqual(parsed, [rule('a', 'one', 'two')]);
  for (const value of [null, {}, 'rules', [null], [[]], [rule('', 'x', 'y')], [rule('a', '', 'y')],
    [rule('a', 'x', null)], [rule('a', 'x', 'y', { regex: 'true' })],
    [rule('a', 'x', 'y', { caseSensitive: 1 })], [rule('a', 'x', 'y', { wholeWord: null })],
    [rule('a', 'x', 'y', { enabled: undefined })], [rule('a', 'x', 'y'), rule('a', 'z', 'q')]]) {
    assert.throws(() => api.parseReplacementRules(value));
  }
});

test('saved order applies ordinary and exact raw tag replacements without DOM token boundaries', () => {
  const rules = [rule('tag', '[laugh]', '[laughter]'), rule('ordinary', 'hello', 'good day'),
    rule('ordered', 'good day [laughter]', '<speech>hi</speech>')];
  assert.deepEqual(replace('hello [laugh] | hello {laugh}', rules), {
    text: '<speech>hi</speech> | good day {laugh}', count: 4
  });
});

test('plain search escapes expressions, honors case and keeps dollar replacement text literal', () => {
  assert.deepEqual(replace('a.b A.B axb', [rule('literal', 'a.b', '$1$&$$')]), {
    text: '$1$&$$ A.B axb', count: 1
  });
  assert.deepEqual(replace('a.b A.B axb', [rule('literal', 'a.b', 'yes', { caseSensitive: false })]), {
    text: 'yes yes axb', count: 2
  });
});

test('Unicode whole-word rules reject neighboring letters, digits and underscores but allow raw tag delimiters', () => {
  assert.deepEqual(replace('кот котик скот кот_ кот2 КОТ [кот] <кот>',
    [rule('word', 'кот', 'cat', { wholeWord: true, caseSensitive: false })]), {
    text: 'cat котик скот кот_ кот2 cat [cat] <cat>', count: 4
  });
});

test('regex replacements expand complete matches, numbered and named groups, unmatched captures and dollar escapes', () => {
  assert.deepEqual(replace('ab a', [rule('captures', '(?<first>a)(b)?', '$2:$1:$0:$&:$$:$<first>:$<missing>', { regex: true })]), {
    text: 'b:a:ab:ab:$:a: :a:a:a:$:a:', count: 2
  });
  assert.deepEqual(replace('a', [rule('fallback', '(a)', '$12|$99|$01|$<name>', { regex: true })]), {
    text: 'a2|$99|a|$<name>', count: 1
  });
  assert.deepEqual(replace('abc', [rule('context', 'b', "$`|$&|$'", { regex: true })]), {
    text: 'aa|b|cc', count: 1
  });
});

test('zero-width Unicode expressions terminate and multiline matching uses native raw text', () => {
  assert.deepEqual(replace('a😀', [rule('empty-match', '(?:)', '|', { regex: true })]), {
    text: '|a|😀|', count: 3
  });
  assert.deepEqual(replace('one\ntwo', [rule('lines', '^', '>', { regex: true })]), {
    text: '>one\n>two', count: 2
  });
});

test('compile enabled expressions once per batch, reuse them across all segments, and ignore disabled expressions', () => {
  const NativeRegExp = globalThis.RegExp;
  let compilations = 0;
  globalThis.RegExp = class extends NativeRegExp {
    constructor(...args) { super(...args); compilations++; }
  };
  try {
    const compiled = api.compileReplacementRules([
      rule('first', 'a', 'b'), rule('second', 'b', 'c'), rule('disabled', '[', 'x', { regex: true, enabled: false })
    ]);
    assert.equal(compilations, 2);
    for (const text of ['a', 'aa', 'a<a>', 'a']) {
      assert.equal(api.replaceTextWithRules(text, compiled).text, text.replaceAll('a', 'c'));
    }
    assert.equal(compilations, 2);
  } finally { globalThis.RegExp = NativeRegExp; }
});

test('expression validation reports the offending rule before any batch can be used', () => {
  assert.throws(() => api.compileReplacementRule(rule('bad', '[', 'x', { regex: true })), /Invalid expression/);
  assert.throws(() => api.compileReplacementRules([
    rule('good', 'ab', 'changed'), rule('bad', '[', 'x', { regex: true })
  ]), /Invalid expression/);
  // Loading a disabled expression remains possible so its author can edit/delete it.
  assert.equal(api.parseReplacementRules([rule('bad', '[', 'x', { regex: true, enabled: false })]).length, 1);
});
