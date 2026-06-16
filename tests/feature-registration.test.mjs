import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function importBundledTs(entryPoint) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-helper-feature-registry-'));
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

test('feature settings are derived from co-located feature registrations', async () => {
  const registry = await importBundledTs('src/features/registry.ts');
  const settings = await importBundledTs('src/core/settings.ts');

  const registeredKeys = registry.FEATURE_REGISTRATIONS.map(
    (registration) => registration.setting.key
  );

  assert.deepEqual(settings.FEATURE_KEYS, registeredKeys);
  assert.deepEqual(Object.keys(settings.DEFAULT_FEATURE_SETTINGS), registeredKeys);
  assert.deepEqual(Object.keys(settings.FEATURE_META), registeredKeys);

  for (const registration of registry.FEATURE_REGISTRATIONS) {
    const { key, defaultEnabled, label, description } = registration.setting;
    assert.equal(settings.DEFAULT_FEATURE_SETTINGS[key], defaultEnabled);
    assert.deepEqual(settings.FEATURE_META[key], { label, description });
  }
});

test('feature module creation and hotkeys help use feature registrations', async () => {
  const registry = await importBundledTs('src/features/registry.ts');
  const features = await importBundledTs('src/features/index.ts');
  const { createConfig } = await importBundledTs('src/core/config.ts');
  const { DEFAULT_FEATURE_SETTINGS } = await importBundledTs('src/core/settings.ts');

  const moduleIds = features.createFeatureModules(DEFAULT_FEATURE_SETTINGS).map((module) => module.id);
  const registeredModuleIds = registry.FEATURE_REGISTRATIONS
    .filter((registration) => registration.createModule)
    .slice()
    .sort((left, right) => (left.moduleOrder || 0) - (right.moduleOrder || 0))
    .map((registration) => registration.id);

  assert.deepEqual(moduleIds, registeredModuleIds);
  assert.ok(
    createConfig(DEFAULT_FEATURE_SETTINGS).hotkeysHelpRows.some(
      ([shortcut, label]) => shortcut === 'Alt + F' && label.includes('Auto-fix lint')
    )
  );
});

test('custom linter feature is co-located in a feature folder', async () => {
  await assert.rejects(
    fs.access('src/features/custom-linter-feature.ts'),
    /ENOENT/
  );
  await fs.access('src/features/custom-linter/index.ts');
  await fs.access('src/features/custom-linter/feature.ts');

  const registrySource = await fs.readFile('src/features/registry.ts', 'utf8');
  const entrySource = await fs.readFile('src/content/entry.ts', 'utf8');

  assert.match(registrySource, /from ['"]\.\/custom-linter['"]/);
  assert.match(entrySource, /from ['"]\.\.\/features\/custom-linter['"]/);
});
