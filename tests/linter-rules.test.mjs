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

test('normalized stutter rule is an error rule without autocorrection', async () => {
  const { createLanguageRules } = await importBundledTs(
    'src/features/custom-linter/linter/rules/language-rules.ts'
  );
  const sentinel = [{ start: 2, end: 3, text: 'x' }];
  const accessed = [];
  const deps = new Proxy(
    {
      ruleSeverity: 'error',
      highlightedWordRuleSeverity: 'warning',
      reasons: new Proxy({}, { get: (_target, key) => String(key) })
    },
    {
      get: (_target, key) => {
        if (typeof key === 'string') {
          accessed.push(key);
        }
        if (key === 'ruleSeverity') {
          return 'error';
        }
        if (key === 'highlightedWordRuleSeverity') {
          return 'warning';
        }
        if (key === 'reasons') {
          return new Proxy({}, { get: (_reasons, reasonKey) => String(reasonKey) });
        }
        return typeof key === 'string' && /stutter/i.test(key)
          ? () => sentinel
          : typeof key === 'string'
            ? () => []
            : undefined;
      }
    }
  );

  const rule = createLanguageRules(deps).find(({ id }) => id === 'normalized-stutters');
  assert.ok(rule);
  assert.equal(rule.severity, 'error');
  assert.match(rule.reason.toLocaleLowerCase(), /stutter/);
  assert.equal('fix' in rule, false);
  assert.deepEqual(rule.getMatches({ text: 'sample' }), sentinel);
  assert.ok(accessed.includes('getNormalizedStutterMatches'));
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

test('linter bridge delegates rule loops to the registry module', async () => {
  const bridgeSource = await fs.readFile('src/content/linter-bridge.ts', 'utf8');

  assert.match(bridgeSource, /from ['"]\.\.\/features\/custom-linter\/linter\/rule-registry['"]/);
  assert.match(bridgeSource, /from ['"]\.\.\/features\/custom-linter\/linter\/rules['"]/);
  assert.match(bridgeSource, /createCustomLinterRules/);
  assert.match(bridgeSource, /createLateBoundLinterRuleResolver/);
  assert.match(bridgeSource, /buildRegistryIssues/);
  assert.match(bridgeSource, /getVisibleTooltipEntries/);
  assert.match(bridgeSource, /applyRuleFixes/);
  assert.match(bridgeSource, /registries\?\.get\?\.\("linter\.rules"\)/);
  assert.match(bridgeSource, /provide\(\s*"page\.linter"/);
  assert.match(bridgeSource, /services\.invoke\("page\.linter", method, \.\.\.args\)/);

  const buildCustomIssuesStart = bridgeSource.indexOf('function buildBuiltInCustomIssues');
  const buildCustomIssuesEnd = bridgeSource.indexOf('function isLintIssueLike', buildCustomIssuesStart);
  const buildCustomIssuesBody = bridgeSource.slice(buildCustomIssuesStart, buildCustomIssuesEnd);
  assert.doesNotMatch(buildCustomIssuesBody, /if \(has[A-Z]/);
  assert.match(buildCustomIssuesBody, /onRuleError/);
  assert.match(buildCustomIssuesBody, /recordCustomLinterRuleError/);

  const errorRecorderStart = bridgeSource.indexOf('function recordCustomLinterRuleError');
  const errorRecorderEnd = bridgeSource.indexOf('function buildBuiltInCustomIssues', errorRecorderStart);
  assert.notEqual(errorRecorderStart, -1);
  assert.notEqual(errorRecorderEnd, -1);
  const errorRecorderBody = bridgeSource.slice(errorRecorderStart, errorRecorderEnd);
  assert.match(errorRecorderBody, /console\.error/);
  assert.match(errorRecorderBody, /Custom linter rule failed/);
  assert.match(errorRecorderBody, /ruleId/);
  assert.match(errorRecorderBody, /annotationId/);
  assert.match(errorRecorderBody, /\berror\b/);

  const tooltipStart = bridgeSource.indexOf('function getNativeTooltipHighlightEntries');
  const tooltipEnd = bridgeSource.indexOf('function findReasonTextNode', tooltipStart);
  const tooltipBody = bridgeSource.slice(tooltipStart, tooltipEnd);
  assert.doesNotMatch(tooltipBody, /const tooltipRules = \[/);
});

test('custom linter rule files live under the custom-linter feature folder', async () => {
  await assert.rejects(
    fs.access('src/content/linter-rule-registry.ts'),
    /ENOENT/
  );
  await assert.rejects(
    fs.access('src/content/linter-text-context.ts'),
    /ENOENT/
  );

  for (const path of [
    'src/features/custom-linter/linter/rule-registry.ts',
    'src/features/custom-linter/linter/text-context.ts',
    'src/features/custom-linter/linter/rules/index.ts',
    'src/features/custom-linter/linter/rules/spacing-rules.ts',
    'src/features/custom-linter/linter/rules/punctuation-rules.ts',
    'src/features/custom-linter/linter/rules/language-rules.ts'
  ]) {
    await fs.access(path);
  }
});

test('curly tag trailing punctuation rule lives in punctuation rules', async () => {
  const punctuationRulesSource = await fs.readFile(
    'src/features/custom-linter/linter/rules/punctuation-rules.ts',
    'utf8'
  );

  assert.match(punctuationRulesSource, /id:\s*'curly-tag-trailing-punctuation'/);
  assert.match(punctuationRulesSource, /deps\.reasons\.curlyTagTrailingPunctuation/);
  assert.match(punctuationRulesSource, /getCurlyTagTrailingPunctuationMatches/);
  assert.match(punctuationRulesSource, /fixCurlyTagTrailingPunctuation/);
  assert.match(punctuationRulesSource, /id:\s*'angle-tag-trailing-punctuation'/);
  assert.match(punctuationRulesSource, /deps\.reasons\.angleTagTrailingPunctuation/);
  assert.match(punctuationRulesSource, /getAngleTagTrailingPunctuationMatches/);
  assert.match(punctuationRulesSource, /fixAngleTagTrailingPunctuation/);
  assert.match(punctuationRulesSource, /id:\s*'square-bracket-tag-trailing-punctuation'/);
  assert.match(punctuationRulesSource, /deps\.reasons\.squareBracketTagTrailingPunctuation/);
  assert.match(punctuationRulesSource, /getSquareBracketTagTrailingPunctuationMatches/);
  assert.match(punctuationRulesSource, /fixSquareBracketTagTrailingPunctuation/);
});

test('period, angle tag, and free double dash rules live in co-located rule files', async () => {
  const spacingRulesSource = await fs.readFile(
    'src/features/custom-linter/linter/rules/spacing-rules.ts',
    'utf8'
  );
  const punctuationRulesSource = await fs.readFile(
    'src/features/custom-linter/linter/rules/punctuation-rules.ts',
    'utf8'
  );

  assert.match(spacingRulesSource, /id:\s*'period-spacing'/);
  assert.match(spacingRulesSource, /deps\.reasons\.periodSpacing/);
  assert.match(spacingRulesSource, /getPeriodSpacingMatches/);
  assert.match(spacingRulesSource, /fixPeriodSpacing/);
  assert.match(spacingRulesSource, /id:\s*'angle-tag-spacing'/);
  assert.match(spacingRulesSource, /deps\.reasons\.angleTagSpacing/);
  assert.match(spacingRulesSource, /getAngleTagSpacingMatches/);
  assert.match(spacingRulesSource, /fixAngleTagSpacing/);
  assert.match(spacingRulesSource, /id:\s*'square-bracket-tag-spacing'/);
  assert.match(spacingRulesSource, /deps\.reasons\.squareBracketTagSpacing/);
  assert.match(spacingRulesSource, /getSquareBracketTagSpacingMatches/);
  assert.match(spacingRulesSource, /fixSquareBracketTagSpacing/);
  assert.match(spacingRulesSource, /id:\s*'curly-tag-spacing'/);
  assert.match(spacingRulesSource, /deps\.reasons\.curlyTagSpacing/);
  assert.match(spacingRulesSource, /getCurlyTagSpacingMatches/);
  assert.match(spacingRulesSource, /fixCurlyTagSpacing/);
  assert.match(punctuationRulesSource, /id:\s*'free-mid-sentence-double-dash'/);
  assert.match(punctuationRulesSource, /deps\.reasons\.freeMidSentenceDoubleDash/);
  assert.match(punctuationRulesSource, /getFreeMidSentenceDoubleDashMatches/);
  assert.match(punctuationRulesSource, /fixFreeMidSentenceDoubleDash/);
});
