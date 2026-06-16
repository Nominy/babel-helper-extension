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
  const registry = fs.readFileSync(new URL('../src/features/registry.ts', import.meta.url), 'utf8');
  const settings = fs.readFileSync(new URL('../src/core/settings.ts', import.meta.url), 'utf8');

  assert.match(settings, /DEFAULT_FEATURE_SETTINGS:\s*FeatureSettings\s*=\s*buildFeatureSettings\(\)/);
  assert.doesNotMatch(registry, /defaultEnabled:\s*false/);
});

test('native timeline double-click blocker is a default-on feature toggle', () => {
  const registry = fs.readFileSync(new URL('../src/features/registry.ts', import.meta.url), 'utf8');
  const settings = fs.readFileSync(new URL('../src/core/settings.ts', import.meta.url), 'utf8');
  const registration = /id:\s*'disable-native-timeline-double-click'[\s\S]*?\}\),/.exec(registry);

  assert.ok(registration, 'disable native timeline double-click should be registered');
  assert.match(settings, /FeatureSettingKey = \(typeof FEATURE_REGISTRATIONS\)\[number\]\['setting'\]\['key'\]/);
  assert.match(registration[0], /key:\s*'disableNativeTimelineDoubleClick'/);
  assert.match(registration[0], /defaultEnabled:\s*true/);
  assert.match(registration[0], /label:\s*'Disable Native Timeline Double Click'/);
});
