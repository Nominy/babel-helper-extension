import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function importBundledTs(entryPoint) {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'babel-helper-settings-'));
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

const highlightedWordsSource = fs.readFileSync(
  new URL('../src/core/highlighted-words.ts', import.meta.url),
  'utf8'
);
const settingsSource = fs.readFileSync(
  new URL('../src/core/settings.ts', import.meta.url),
  'utf8'
);
const customLinterFeatureSource = fs.readFileSync(
  new URL('../src/features/custom-linter/feature.ts', import.meta.url),
  'utf8'
);
const entrySource = fs.readFileSync(
  new URL('../src/content/entry.ts', import.meta.url),
  'utf8'
);
const manifestSource = fs.readFileSync(
  new URL('../manifest.json', import.meta.url),
  'utf8'
);
const optionsSource = fs.readFileSync(
  new URL('../src/options/options.ts', import.meta.url),
  'utf8'
);
const optionsHtml = fs.readFileSync(
  new URL('../options.html', import.meta.url),
  'utf8'
);

test('highlighted words settings are stored as a customizable dictionary', () => {
  assert.match(highlightedWordsSource, /DEFAULT_HIGHLIGHTED_WORDS/);
  assert.match(settingsSource, /highlightedWordsEnabled:\s*boolean/);
  assert.match(settingsSource, /highlightedWordsEnabled:\s*true/);
  assert.match(settingsSource, /highlightedWords:\s*string\[\]/);
  assert.match(settingsSource, /highlightedWords:\s*normalizeHighlightedWords/);
  assert.match(optionsSource, /data-role="highlighted-words-enabled"/);
  assert.match(optionsSource, /data-role="highlighted-words"/);
  assert.match(optionsHtml, /data-role="highlighted-words-enabled"/);
  assert.match(optionsHtml, /data-role="highlighted-words"/);
});

test('custom linter rule disables are persisted and managed from settings', async () => {
  const {
    DEFAULT_EXTENSION_SETTINGS,
    CUSTOM_LINTER_RULE_SETTINGS,
    normalizeExtensionSettings
  } = await importBundledTs('src/core/settings.ts');

  const normalized = normalizeExtensionSettings({
    disabledCustomLinterRuleIds: ['period-spacing', 'unknown-rule', 'period-spacing']
  });

  assert.deepEqual(normalized.disabledCustomLinterRuleIds, ['period-spacing']);
  assert.deepEqual(DEFAULT_EXTENSION_SETTINGS.disabledCustomLinterRuleIds, []);
  assert.ok(
    CUSTOM_LINTER_RULE_SETTINGS.some((rule) => rule.id === 'period-spacing' && rule.enabledByDefault === true)
  );
  assert.match(optionsSource, /data-role="manage-custom-linter-rules"/);
  assert.match(optionsSource, /data-role="custom-linter-rule-page"/);
  assert.match(optionsHtml, /data-role="custom-linter-rule-page"/);
});

test('custom linter feature sends highlighted words into the page bridge', () => {
  assert.match(customLinterFeatureSource, /CONFIG_EVENT/);
  assert.match(customLinterFeatureSource, /highlightedWordsEnabled/);
  assert.match(customLinterFeatureSource, /highlightedWords/);
  assert.match(customLinterFeatureSource, /disabledCustomLinterRuleIds/);
  assert.match(customLinterFeatureSource, /setBridgeConfig/);
  assert.match(customLinterFeatureSource, /bootstrapCustomLinterBridge/);
  assert.match(entrySource, /bootstrapCustomLinterBridge/);
  assert.match(manifestSource, /"run_at": "document_start"/);
});

test('custom linter bridge preloads before kernel start for native lint patching', () => {
  assert.match(customLinterFeatureSource, /export function preloadCustomLinterBridge/);
  assert.match(customLinterFeatureSource, /bridgeLoadPromise/);
  assert.match(entrySource, /preloadCustomLinterBridge/);

  const preloadIndex = entrySource.indexOf('preloadCustomLinterBridge()');
  const kernelStartIndex = entrySource.indexOf('await kernel.start()');
  const bootstrapIndex = entrySource.indexOf('bootstrapCustomLinterBridge');

  assert.ok(preloadIndex > -1, 'entry should start linter bridge preload');
  assert.ok(kernelStartIndex > -1, 'entry should start the kernel');
  assert.ok(bootstrapIndex > -1, 'entry should still send config and enable after settings load');
  assert.ok(preloadIndex < kernelStartIndex, 'linter bridge should preload before kernel startup');
  assert.ok(/linterBridgePreload[\s\S]*?\.then\s*\([\s\S]*?bootstrapCustomLinterBridge[\s\S]*?,[\s\S]*?bootstrapCustomLinterBridge/s.test(entrySource), 'entry should call preload promise with fallback path');
});
