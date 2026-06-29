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

test('linter bridge delegates rule loops to the registry module', async () => {
  const bridgeSource = await fs.readFile('src/content/linter-bridge.ts', 'utf8');

  assert.match(bridgeSource, /from ['"]\.\.\/features\/custom-linter\/linter\/rule-registry['"]/);
  assert.match(bridgeSource, /from ['"]\.\.\/features\/custom-linter\/linter\/rules['"]/);
  assert.match(bridgeSource, /createCustomLinterRules/);
  assert.match(bridgeSource, /buildRegistryIssues/);
  assert.match(bridgeSource, /getVisibleTooltipEntries/);
  assert.match(bridgeSource, /applyRuleFixes/);

  const buildCustomIssuesStart = bridgeSource.indexOf('function buildCustomIssues');
  const buildCustomIssuesEnd = bridgeSource.indexOf('function isLintIssueLike', buildCustomIssuesStart);
  const buildCustomIssuesBody = bridgeSource.slice(buildCustomIssuesStart, buildCustomIssuesEnd);
  assert.doesNotMatch(buildCustomIssuesBody, /if \(has[A-Z]/);
  assert.match(buildCustomIssuesBody, /onRuleError/);
  assert.match(buildCustomIssuesBody, /recordCustomLinterRuleError/);

  const errorRecorderStart = bridgeSource.indexOf('function recordCustomLinterRuleError');
  const errorRecorderEnd = bridgeSource.indexOf('function buildCustomIssues', errorRecorderStart);
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
  assert.match(punctuationRulesSource, /id:\s*'comma-before-dash'/);
  assert.match(punctuationRulesSource, /deps\.reasons\.commaBeforeDash/);
  assert.match(punctuationRulesSource, /getCommaBeforeDashMatches/);
  assert.match(punctuationRulesSource, /fixCommaBeforeDash/);
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
  assert.match(punctuationRulesSource, /id:\s*'free-mid-sentence-double-dash'/);
  assert.match(punctuationRulesSource, /deps\.reasons\.freeMidSentenceDoubleDash/);
  assert.match(punctuationRulesSource, /getFreeMidSentenceDoubleDashMatches/);
  assert.match(punctuationRulesSource, /fixFreeMidSentenceDoubleDash/);
});
