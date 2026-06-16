import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

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

test('custom linter feature sends highlighted words into the page bridge', () => {
  assert.match(customLinterFeatureSource, /CONFIG_EVENT/);
  assert.match(customLinterFeatureSource, /highlightedWordsEnabled/);
  assert.match(customLinterFeatureSource, /highlightedWords/);
  assert.match(customLinterFeatureSource, /setBridgeConfig/);
  assert.match(customLinterFeatureSource, /bootstrapCustomLinterBridge/);
  assert.match(entrySource, /bootstrapCustomLinterBridge/);
  assert.match(manifestSource, /"run_at": "document_start"/);
});
