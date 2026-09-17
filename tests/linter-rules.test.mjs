import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function importBundledTs(entryPoint) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-helper-linter-rules-'));
  const outfile = path.join(tempDir, path.basename(entryPoint).replace(/\.ts$/, '.mjs'));
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent'
  });
  return import(pathToFileURL(outfile).href);
}

test('transcript text context tokenizes inline tags and answers range queries', async () => {
  const { createTranscriptTextContext } = await importBundledTs(
    'src/features/custom-linter/linter/text-context.ts'
  );

  const context = createTranscriptTextContext('Alpha {TAG: value} beta');

  assert.deepEqual(
    context.tokens.map((token) => [token.kind, token.text]),
    [
      ['word', 'Alpha'],
      ['space', ' '],
      ['tag', '{TAG: value}'],
      ['space', ' '],
      ['word', 'beta']
    ]
  );
  assert.equal(context.isRangeInsideGenericTag(8, 11), true);
  assert.equal(context.isRangeInsideGenericTag(19, 23), false);
});
test('normalized stutter matcher reports only invalid letter fragments', async () => {
  const { getNormalizedStutterMatches } = await importBundledTs(
    'src/features/custom-linter/linter/text-context.ts'
  );

  const matches = (text) =>
    getNormalizedStutterMatches(text).map(({ start, end, text: fragment }) => ({
      start,
      end,
      text: fragment
    }));

  assert.deepEqual(matches('нь- нет'), [{ start: 0, end: 2, text: 'нь' }]);
  assert.deepEqual(matches('н- нет'), []);
  assert.deepEqual(matches('не- нет'), []);
  assert.deepEqual(matches('н- не- нет'), []);
  assert.deepEqual(matches('к- никто'), [{ start: 0, end: 1, text: 'к' }]);
  assert.deepEqual(matches('Ни- ник- никто'), []);
  assert.deepEqual(matches('н- к- никто'), [{ start: 3, end: 4, text: 'к' }]);
  assert.deepEqual(matches('а- а- один'), [
    { start: 0, end: 1, text: 'а' },
    { start: 3, end: 4, text: 'а' }
  ]);
  assert.deepEqual(matches('что-то- что-то'), []);
  assert.deepEqual(matches('что-же- что-то'), [{ start: 0, end: 6, text: 'что-же' }]);
  assert.deepEqual(matches('на- н- на'), [{ start: 0, end: 2, text: 'на' }]);
  assert.deepEqual(matches('на- на'), []);
});

test('normalized stutter matcher excludes generic tags and non-stutter hyphens', async () => {
  const { getNormalizedStutterMatches } = await importBundledTs(
    'src/features/custom-linter/linter/text-context.ts'
  );

  assert.deepEqual(getNormalizedStutterMatches('{TAG: нь- нет} нь- нет'), [
    { start: 15, end: 17, text: 'нь' }
  ]);
  assert.deepEqual(getNormalizedStutterMatches('слово-тест foo - bar 12- test'), []);
});

test('ё lint ranges and fixes agree across case, decomposition, compounds, and protected tags', async () => {
  const { getUnnecessaryYoMatches, fixUnnecessaryYo } = await importBundledTs(
    'src/features/custom-linter/linter/yo-orthography.ts'
  );
  const text = 'Е\u0308ЛКА всё-таки всём-то берёт берёте нём ещё-ёлка [шёпот] <шёпот> ещё </шёпот> {СКАЗ: трёх}';
  const matches = getUnnecessaryYoMatches(text);
  assert.deepEqual(matches.map(match => match.text), ['ещё', 'ёлка', 'ещё']);
  for (const match of matches) assert.equal(text.slice(match.start, match.end), match.text);
  const fixed = fixUnnecessaryYo(text);
  assert.equal(fixed, 'Е\u0308ЛКА всё-таки всём-то берёт берёте нём еще-елка [шёпот] <шёпот> еще </шёпот> {СКАЗ: трёх}');
  assert.deepEqual(getUnnecessaryYoMatches(fixed), []);
  assert.equal(fixUnnecessaryYo('Все всем берет нем. Всё\u2011таки ещё\u2010ёлка сверхвсё.'),
    'Все всем берет нем. Всё\u2011таки еще\u2010елка сверхвсе.');
});

test('ё lint exempts capitalized words and name components at any sentence position', async () => {
  const { getUnnecessaryYoMatches, fixUnnecessaryYo } = await importBundledTs(
    'src/features/custom-linter/linter/yo-orthography.ts'
  );
  const text = 'Ёлка ещё. Встречаем «Алёшу», Фёдора и мини-Ёлку. Е\u0308ЛКА ёлка.';
  assert.deepEqual(getUnnecessaryYoMatches(text).map(match => match.text), ['ещё', 'ёлка']);
  assert.equal(fixUnnecessaryYo(text), 'Ёлка еще. Встречаем «Алёшу», Фёдора и мини-Ёлку. Е\u0308ЛКА елка.');
});


test('linter rule registry builds issues, filters visible tooltip entries, and applies fixes in rule order', async () => {
  const {
    applyRuleFixes,
    buildRegistryIssues,
    getVisibleTooltipEntries
  } = await importBundledTs('src/features/custom-linter/linter/rule-registry.ts');

  const rules = [
    {
      id: 'trim-start',
      reason: 'Trim start',
      severity: 'error',
      markers: ['Trim start'],
      getMatches(entry) {
        return entry.text.startsWith(' ')
          ? [{ start: 0, end: 1, text: ' ' }]
          : [];
      },
      fix(text) {
        return text.trimStart();
      }
    },
    {
      id: 'terminal-period',
      reason: 'Needs period',
      severity: 'warning',
      markers: ['Needs period'],
      getMatches(entry) {
        return entry.text.endsWith('.')
          ? []
          : [{ start: Math.max(0, entry.text.length - 1), end: entry.text.length, text: entry.text.slice(-1) }];
      },
      fix(text) {
        return text.endsWith('.') ? text : `${text}.`;
      }
    }
  ];
  const annotationEntries = [{ annotationId: 'a1', reviewActionId: 'r1', text: ' hello' }];

  const issues = buildRegistryIssues(annotationEntries, rules, (entry, rule, matches) => ({
    annotationId: entry.annotationId,
    reviewActionId: entry.reviewActionId,
    reason: rule.reason,
    severity: rule.severity,
    matches
  }));

  assert.deepEqual(
    issues.map((issue) => [issue.reason, issue.severity, issue.matches[0].text]),
    [
      ['Trim start', 'error', ' '],
      ['Needs period', 'warning', 'o']
    ]
  );
  assert.deepEqual(getVisibleTooltipEntries(' hello', 'Needs period', rules), [
    {
      reason: 'Needs period',
      matches: ['o'],
      ranges: [{ start: 5, end: 6, text: 'o' }]
    }
  ]);
  assert.equal(applyRuleFixes(' hello', rules), 'hello.');
});

test('linter rule registry keeps later custom issues when one rule throws', async () => {
  const { buildRegistryIssues } = await importBundledTs(
    'src/features/custom-linter/linter/rule-registry.ts'
  );
  const ruleErrors = [];
  const rules = [
    {
      id: 'broken-rule',
      reason: 'Broken rule',
      severity: 'error',
      markers: ['Broken rule'],
      getMatches() {
        throw new Error('bad row shape');
      }
    },
    {
      id: 'working-rule',
      reason: 'Working rule',
      severity: 'warning',
      markers: ['Working rule'],
      getMatches(entry) {
        return [{ start: 0, end: 1, text: entry.text.slice(0, 1) }];
      }
    }
  ];

  const issues = buildRegistryIssues(
    [{ annotationId: 'a1', text: 'hello' }],
    rules,
    (entry, rule, matches) => ({
      annotationId: entry.annotationId,
      reason: rule.reason,
      severity: rule.severity,
      matches
    }),
    {
      onRuleError(error, rule, entry) {
        ruleErrors.push({
          message: error.message,
          ruleId: rule.id,
          annotationId: entry.annotationId
        });
      }
    }
  );

  assert.deepEqual(issues.map((issue) => issue.reason), ['Working rule']);
  assert.deepEqual(ruleErrors, [
    {
      message: 'bad row shape',
      ruleId: 'broken-rule',
      annotationId: 'a1'
    }
  ]);
});

test('linter rule registry skips disabled rule ids for issues, tooltips, and fixes', async () => {
  const {
    applyRuleFixes,
    buildRegistryIssues,
    getVisibleTooltipEntries
  } = await importBundledTs('src/features/custom-linter/linter/rule-registry.ts');

  const rules = [
    {
      id: 'trim-start',
      reason: 'Trim start',
      severity: 'error',
      markers: ['Trim start'],
      getMatches(entry) {
        return entry.text.startsWith(' ')
          ? [{ start: 0, end: 1, text: ' ' }]
          : [];
      },
      fix(text) {
        return text.trimStart();
      }
    },
    {
      id: 'terminal-period',
      reason: 'Needs period',
      severity: 'warning',
      markers: ['Needs period'],
      getMatches(entry) {
        return entry.text.endsWith('.')
          ? []
          : [{ start: Math.max(0, entry.text.length - 1), end: entry.text.length, text: entry.text.slice(-1) }];
      },
      fix(text) {
        return text.endsWith('.') ? text : `${text}.`;
      }
    }
  ];
  const disabledRuleIds = ['terminal-period'];

  const issues = buildRegistryIssues(
    [{ annotationId: 'a1', text: ' hello' }],
    rules,
    (entry, rule, matches) => ({
      annotationId: entry.annotationId,
      reason: rule.reason,
      matches
    }),
    { disabledRuleIds }
  );

  assert.deepEqual(issues.map((issue) => issue.reason), ['Trim start']);
  assert.deepEqual(getVisibleTooltipEntries(' hello', 'Needs period', rules, { disabledRuleIds }), []);
  assert.equal(applyRuleFixes(' hello', rules, {}, { disabledRuleIds }), 'hello');
});

test('late-bound community linter rules affect issues, tooltips, and fixes until disposed', async () => {
  const {
    applyRuleFixes,
    buildRegistryIssues,
    createLateBoundLinterRuleResolver,
    getVisibleTooltipEntries
  } = await importBundledTs('src/features/custom-linter/linter/rule-registry.ts');

  const builtInRule = {
    id: 'built-in-period',
    reason: 'Built-in period',
    severity: 'error',
    markers: ['Built-in period'],
    getMatches(entry) {
      return entry.text.endsWith('.')
        ? []
        : [{ start: entry.text.length - 1, end: entry.text.length, text: entry.text.slice(-1) }];
    },
    fix(text) {
      return text.endsWith('.') ? text : `${text}.`;
    }
  };
  const beforeInitRule = {
    id: 'community-uppercase',
    reason: 'Community uppercase',
    severity: 'warning',
    markers: ['Community uppercase'],
    getMatches(entry) {
      return /^[a-z]/.test(entry.text)
        ? [{ start: 0, end: 1, text: entry.text.slice(0, 1) }]
        : [];
    },
    fix(text) {
      return text ? text[0].toUpperCase() + text.slice(1) : text;
    }
  };
  const contributions = [];
  const contribute = (rule) => {
    contributions.push(rule);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      contributions.splice(contributions.indexOf(rule), 1);
    };
  };
  const disposeBeforeInitRule = contribute(beforeInitRule);
  const resolveRules = createLateBoundLinterRuleResolver(
    () => [builtInRule],
    () => contributions
  );
  const makeIssue = (entry, rule, matches) => ({
    annotationId: entry.annotationId,
    reviewActionId: entry.reviewActionId || '',
    reason: rule.reason,
    severity: rule.severity,
    babelHelper: { sourceText: entry.text, matches }
  });
  const lint = (text) =>
    buildRegistryIssues(
      [{ annotationId: 'a1', reviewActionId: 'r1', text }],
      resolveRules(),
      makeIssue
    );

  assert.deepEqual(
    lint('hello').map(({ reason }) => reason),
    ['Built-in period', 'Community uppercase']
  );
  assert.deepEqual(
    getVisibleTooltipEntries(
      'hello',
      'Built-in period Community uppercase',
      resolveRules()
    ).map(({ reason }) => reason),
    ['Built-in period', 'Community uppercase']
  );
  assert.equal(applyRuleFixes('hello', resolveRules()), 'Hello.');

  const afterInitRule = {
    id: 'community-exclamation',
    reason: 'Community exclamation',
    severity: 'error',
    markers: ['Community exclamation'],
    getMatches(entry) {
      return entry.text.includes('!')
        ? []
        : [{ start: entry.text.length, end: entry.text.length, text: '' }];
    },
    fix(text) {
      return text.includes('!') ? text : `${text}!`;
    }
  };
  const disposeAfterInitRule = contribute(afterInitRule);
  assert.deepEqual(
    lint('hello').map(({ reason }) => reason),
    ['Built-in period', 'Community uppercase', 'Community exclamation']
  );
  assert.equal(applyRuleFixes('hello', resolveRules()), 'Hello.!');
  assert.deepEqual(
    getVisibleTooltipEntries(
      'hello',
      'Built-in period Community uppercase Community exclamation',
      resolveRules()
    ).map(({ reason }) => reason),
    ['Built-in period', 'Community uppercase', 'Community exclamation']
  );

  disposeBeforeInitRule();
  assert.deepEqual(
    lint('hello').map(({ reason }) => reason),
    ['Built-in period', 'Community exclamation']
  );
  assert.equal(applyRuleFixes('hello', resolveRules()), 'hello.!');
  assert.deepEqual(
    getVisibleTooltipEntries(
      'hello',
      'Built-in period Community uppercase Community exclamation',
      resolveRules()
    ).map(({ reason }) => reason),
    ['Built-in period', 'Community exclamation']
  );

  disposeAfterInitRule();
  assert.deepEqual(lint('hello').map(({ reason }) => reason), ['Built-in period']);
  assert.equal(applyRuleFixes('hello', resolveRules()), 'hello.');
  assert.deepEqual(
    getVisibleTooltipEntries(
      'hello',
      'Built-in period Community uppercase Community exclamation',
      resolveRules()
    ).map(({ reason }) => reason),
    ['Built-in period']
  );
});
