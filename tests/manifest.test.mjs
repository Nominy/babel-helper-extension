import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('manifest targets bundled dist assets', () => {
  const raw = fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '');
  const manifest = JSON.parse(raw);

  assert.equal(manifest.content_scripts[0].js[0], 'dist/content/entry.js');
  assert.equal(manifest.web_accessible_resources[0].resources[0], 'dist/content/magnifier-bridge.js');
  assert.equal(manifest.web_accessible_resources[0].resources.includes('dist/content/lazy-session.js'), true);
  assert.equal(manifest.web_accessible_resources[0].resources.includes('dist/content/timestamp-bridge.js'), true);
  assert.equal(manifest.web_accessible_resources[0].resources.includes('dist/content/linter-bridge.js'), true);
  assert.equal(manifest.options_page, 'options.html');
  assert.equal(manifest.permissions.includes('storage'), true);
});

test('package build bumps the version before syncing unpacked assets', () => {
  const raw = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '');
  const packageJson = JSON.parse(raw);

  assert.equal(packageJson.scripts.build, 'npm run version:patch && npm run build:core && npm run sync:unpacked');
  assert.equal(packageJson.scripts['build:reload'], 'npm run build');
});

test('all extension features remain enabled by default', () => {
  const raw = fs.readFileSync(new URL('../src/core/settings.ts', import.meta.url), 'utf8');
  const match = /DEFAULT_FEATURE_SETTINGS[\s\S]*?=\s*{([\s\S]*?)};/.exec(raw);

  assert.ok(match, 'DEFAULT_FEATURE_SETTINGS should be present');
  assert.doesNotMatch(match[1], /:\s*false[,}]/);
});
