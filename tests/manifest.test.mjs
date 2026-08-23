import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('manifest targets bundled dist assets', () => {
  const raw = fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '');
  const manifest = JSON.parse(raw);

  const mainHost = manifest.content_scripts.find((script) => script.world === 'MAIN');
  const isolatedEntry = manifest.content_scripts.find((script) => script.world !== 'MAIN');

  assert.deepEqual(mainHost.js, ['dist/content/mod-host.js']);
  assert.equal(mainHost.run_at, 'document_start');
  assert.deepEqual(mainHost.matches, ['https://dashboard.babel.audio/*']);
  assert.deepEqual(isolatedEntry.js, ['dist/content/entry.js']);
  assert.deepEqual(isolatedEntry.css, ['dist/content/website-appearance.css']);
  assert.equal(isolatedEntry.run_at, 'document_start');
  assert.deepEqual(isolatedEntry.matches, ['https://dashboard.babel.audio/*']);
  assert.equal(manifest.web_accessible_resources[0].resources[0], 'dist/content/magnifier-bridge.js');
  assert.equal(manifest.web_accessible_resources[0].resources.includes('dist/content/lazy-session.js'), true);
  assert.equal(manifest.web_accessible_resources[0].resources.includes('dist/content/timestamp-bridge.js'), true);
  assert.equal(manifest.web_accessible_resources[0].resources.includes('dist/content/linter-bridge.js'), true);
  assert.equal(
    manifest.web_accessible_resources[0].resources.includes('dist/content/waveform-theme-bridge.js'),
    true
  );
  assert.equal(manifest.web_accessible_resources.length, 1);
  assert.deepEqual(manifest.web_accessible_resources[0].matches, ['https://dashboard.babel.audio/*']);
  assert.equal(manifest.background.service_worker, 'dist/background/commands.js');
  assert.equal(manifest.commands['auto-insert-segment'].suggested_key.default, 'Alt+C');
  assert.deepEqual(manifest.options_ui, { page: 'options.html', open_in_tab: true });
  assert.equal(manifest.action.default_title, 'Open Babel Helper settings');
  assert.equal(manifest.action.default_popup, 'options.html');
  assert.equal(manifest.permissions.includes('storage'), true);
  assert.equal(manifest.permissions.length, 1);
  assert.equal(manifest.host_permissions, undefined);
});

test('mod host, waveform bridge, userscript SDK, and website appearance stylesheet are build-wired', () => {
  const source = fs.readFileSync(new URL('../esbuild.config.mjs', import.meta.url), 'utf8');
  const packSource = fs.readFileSync(new URL('../scripts/pack.mjs', import.meta.url), 'utf8');

  assert.match(source, /src\/mod-platform\/page-host\.ts/);
  assert.match(source, /dist\/content\/mod-host\.js/);
  assert.match(source, /src\/userscript\/babel-mods\.ts/);
  assert.match(source, /dist\/userscript\/babel-mods\.js/);
  assert.match(source, /dist\/userscript\/babel-mods\.d\.ts/);
  assert.match(source, /src\/content\/website-appearance\.css/);
  assert.match(source, /dist\/content\/website-appearance\.css/);
  assert.match(source, /copyFile\(websiteAppearanceSource, websiteAppearanceOutput\)/);
  assert.match(
    source,
    /function enqueueCopy\(\) \{\s+const copy = pendingCopy\.then\(copyWebsiteAppearanceStylesheet\);/
  );
  assert.match(source, /filename !== null && filename !== path\.basename\(websiteAppearanceSource\)/);
  assert.match(source, /watchFileChanges\([\s\S]*?enqueueCopy\(\);\s+\}\);\s+return enqueueCopy;/);
  assert.match(
    source,
    /const enqueueWebsiteAppearanceCopy = watchWebsiteAppearanceStylesheet\(\);\s+await Promise\.all\(\[copyUserscriptDeclaration\(\), enqueueWebsiteAppearanceCopy\(\)\]\);/
  );
  assert.match(source, /src\/content\/waveform-theme-bridge\.ts/);
  assert.match(source, /dist\/content\/waveform-theme-bridge\.js/);
  assert.match(
    source,
    /banner: \{\},\s+entryPoints: \['src\/content\/waveform-theme-bridge\.ts'\]/,
    'the page-world waveform bridge must not inject the node __dirname banner into the page'
  );
  assert.match(packSource, /full\.endsWith\('\.js'\) \|\| full\.endsWith\('\.css'\)/);
});

test('waveform bridge reaches the unpacked build and the store ZIP', () => {
  const packSource = fs.readFileSync(new URL('../scripts/pack.mjs', import.meta.url), 'utf8');
  const syncSource = fs.readFileSync(new URL('../scripts/sync-unpacked.mjs', import.meta.url), 'utf8');

  assert.match(packSource, /collectFiles\(distDir, 'dist'\)/);
  assert.match(syncSource, /replaceDirectory\('dist'\)/);
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
