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

const TAG_TRAILING_PUNCTUATION_RULE_IDS = [
  'curly-tag-trailing-punctuation',
  'angle-tag-trailing-punctuation',
  'square-bracket-tag-trailing-punctuation'
];

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

test('fresh custom linter defaults disable exactly the tag punctuation rules', async () => {
  const {
    CUSTOM_LINTER_DEFAULTS_VERSION,
    CUSTOM_LINTER_RULE_SETTINGS,
    DEFAULT_EXTENSION_SETTINGS
  } = await importBundledTs('src/core/settings.ts');

  assert.equal(CUSTOM_LINTER_DEFAULTS_VERSION, 1);
  assert.equal(
    DEFAULT_EXTENSION_SETTINGS.customLinterDefaultsVersion,
    CUSTOM_LINTER_DEFAULTS_VERSION
  );
  assert.deepEqual(
    DEFAULT_EXTENSION_SETTINGS.disabledCustomLinterRuleIds,
    TAG_TRAILING_PUNCTUATION_RULE_IDS
  );
  assert.deepEqual(
    CUSTOM_LINTER_RULE_SETTINGS.filter((rule) => !rule.enabledByDefault).map((rule) => rule.id),
    TAG_TRAILING_PUNCTUATION_RULE_IDS
  );
});

test('ghost cursor settings default safely and normalize every field', async () => {
  const {
    DEFAULT_GHOST_CURSOR_SETTINGS,
    decodeGhostCursorSettingsShare,
    encodeGhostCursorSettingsShare,
    normalizeExtensionSettings,
    normalizeGhostCursorSettings
  } = await importBundledTs('src/core/settings.ts');

  const legacy = normalizeExtensionSettings({
    highlightedWordsEnabled: false,
    ghostCursor: { theme: 'cyber-mint', style: 'dashed' }
  });
  assert.deepEqual(legacy.ghostCursor, DEFAULT_GHOST_CURSOR_SETTINGS);
  assert.deepEqual(DEFAULT_GHOST_CURSOR_SETTINGS, {
    color: '#f59e0b',
    gradientColor: '#fb7185',
    gradientEnabled: false,
    thickness: 2,
    motion: 'slow'
  });

  const normalized = normalizeGhostCursorSettings({
    theme: 'cyber-mint',
    style: 'dashed',
    color: '#ABCDEF',
    gradientColor: 'url(javascript:alert(1))',
    gradientEnabled: 'yes',
    thickness: 99,
    motion: 'snappy'
  });
  assert.deepEqual(normalized, {
    color: '#abcdef',
    gradientColor: DEFAULT_GHOST_CURSOR_SETTINGS.gradientColor,
    gradientEnabled: false,
    thickness: 8,
    motion: 'snappy'
  });
  assert.equal('theme' in normalized, false);
  assert.equal('style' in normalized, false);

  const share = encodeGhostCursorSettingsShare(normalized);
  assert.match(share, /^gc1\.[A-Za-z0-9_-]+$/);
  const sharePayload = JSON.parse(Buffer.from(share.slice('gc1.'.length), 'base64url').toString());
  assert.deepEqual(Object.keys(sharePayload), ['c', 'g', 'e', 'w', 'm']);
  assert.deepEqual(decodeGhostCursorSettingsShare(share), normalized);
  assert.deepEqual(decodeGhostCursorSettingsShare('nope'), null);

  const legacyShare =
    'gc1.' +
    Buffer.from(JSON.stringify({ t: 'cyber-mint', c: '#ABCDEF', x: 'legacy-key' })).toString('base64url');
  assert.deepEqual(decodeGhostCursorSettingsShare(legacyShare), {
    ...DEFAULT_GHOST_CURSOR_SETTINGS,
    color: '#abcdef'
  });
  const futureShare =
    'gc1.' +
    Buffer.from(
      JSON.stringify({
        c: '#123456',
        g: '#654321',
        e: true,
        w: 5,
        m: 'balanced',
        t: 'cyber-mint',
        x: 'future-key'
      })
    ).toString('base64url');
  assert.deepEqual(decodeGhostCursorSettingsShare(futureShare), {
    color: '#123456',
    gradientColor: '#654321',
    gradientEnabled: true,
    thickness: 5,
    motion: 'balanced'
  });

  const unsafe = normalizeGhostCursorSettings({
    theme: '<style>',
    style: 'background:url(x)',
    color: '#fff',
    gradientColor: 'red',
    thickness: -4,
    motion: 'fast'
  });
  assert.deepEqual(unsafe, {
    ...DEFAULT_GHOST_CURSOR_SETTINGS,
    thickness: 1
  });
});

test('ghost cursor options wire custom controls without themes or presets', () => {
  for (const field of ['ghostCursor', 'ghostCursorInputs']) {
    const pattern = new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.match(optionsSource, pattern);
  }
  for (const field of [
    'ghost-cursor-gradient-enabled',
    'ghost-cursor-color',
    'ghost-cursor-gradient-color',
    'ghost-cursor-thickness',
    'ghost-cursor-motion',
    'ghost-cursor-page',
    'ghost-cursor-copy-share',
    'ghost-cursor-import-share'
  ]) {
    const pattern = new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.match(optionsSource, pattern);
    assert.match(optionsHtml, pattern);
  }
  assert.doesNotMatch(
    optionsSource,
    /ghost-cursor-(?:theme|preset|style)|GHOST_CURSOR_PRESETS/i
  );
  assert.doesNotMatch(optionsHtml, /ghost-cursor-theme|Theme preset|Amber Pulse|Cyber Mint|data-role="ghost-cursor-style"/i);
  assert.doesNotMatch(settingsSource, /GhostCursorTheme|GHOST_CURSOR_PRESETS/);
  assert.match(optionsSource, /applyGhostCursorSettingsToInputs\(settings\.ghostCursor,/);
});


test('legacy custom linter settings migrate once and retain valid disables', async () => {
  const { CUSTOM_LINTER_DEFAULTS_VERSION, normalizeExtensionSettings } =
    await importBundledTs('src/core/settings.ts');

  const normalized = normalizeExtensionSettings({
    disabledCustomLinterRuleIds: [
      'period-spacing',
      'unknown-rule',
      'period-spacing',
      'curly-tag-trailing-punctuation'
    ]
  });

  assert.equal(normalized.customLinterDefaultsVersion, CUSTOM_LINTER_DEFAULTS_VERSION);
  assert.deepEqual(normalized.disabledCustomLinterRuleIds, [
    'period-spacing',
    ...TAG_TRAILING_PUNCTUATION_RULE_IDS
  ]);
});

test('current custom linter settings can re-enable every migrated rule', async () => {
  const { CUSTOM_LINTER_DEFAULTS_VERSION, normalizeExtensionSettings } =
    await importBundledTs('src/core/settings.ts');

  const normalized = normalizeExtensionSettings({
    customLinterDefaultsVersion: CUSTOM_LINTER_DEFAULTS_VERSION,
    disabledCustomLinterRuleIds: []
  });

  assert.equal(normalized.customLinterDefaultsVersion, CUSTOM_LINTER_DEFAULTS_VERSION);
  assert.deepEqual(normalized.disabledCustomLinterRuleIds, []);
});

test('options saves the current custom linter defaults version', () => {
  assert.match(
    optionsSource,
    /import\s*\{[^}]*\bCUSTOM_LINTER_DEFAULTS_VERSION\b[^}]*\}\s*from\s*['"]\.\.\/core\/settings['"]/
  );
  assert.match(
    optionsSource,
    /customLinterDefaultsVersion:\s*CUSTOM_LINTER_DEFAULTS_VERSION/
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
