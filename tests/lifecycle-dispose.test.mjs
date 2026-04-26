import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('lifecycle exposes cleanup used by kernel stop', () => {
  const lifecycleSource = fs.readFileSync(
    new URL('../src/core/lifecycle.ts', import.meta.url),
    'utf8'
  );
  const kernelSource = fs.readFileSync(
    new URL('../src/core/kernel.ts', import.meta.url),
    'utf8'
  );

  assert.match(kernelSource, /helper\.runtime\.disposeLifecycle\(\)/);
  assert.match(lifecycleSource, /helper\.runtime\.disposeLifecycle\s*=/);
  assert.match(lifecycleSource, /unbindRouteWatchers\(\)/);
  assert.match(lifecycleSource, /unbindGlobalListeners\(\)/);
  assert.match(lifecycleSource, /helper\.unbindRowTracking\(\)/);
});

test('reset-to-defaults follows extension default settings', () => {
  const optionsSource = fs.readFileSync(
    new URL('../src/options/options.ts', import.meta.url),
    'utf8'
  );

  assert.match(optionsSource, /DEFAULT_EXTENSION_SETTINGS\.features\[key\]/);
});

test('content boot tears down page-world bridges before restarting', () => {
  const entrySource = fs.readFileSync(
    new URL('../src/content/entry.ts', import.meta.url),
    'utf8'
  );

  assert.match(entrySource, /babel-helper-bridge-teardown/);
  assert.match(entrySource, /data-babel-helper-linter-bridge/);
  assert.match(entrySource, /data-babel-helper-quick-region-autocomplete-bridge/);
});

test('page-world bridges expose teardown cleanup hooks', () => {
  const bridgePaths = [
    '../src/content/playback-bridge.ts',
    '../src/content/timestamp-bridge.ts',
    '../src/content/magnifier-bridge.ts',
    '../src/content/linter-bridge.ts',
    '../src/content/quick-region-autocomplete-bridge.ts'
  ];

  for (const bridgePath of bridgePaths) {
    const source = fs.readFileSync(new URL(bridgePath, import.meta.url), 'utf8');
    assert.match(source, /babel-helper-bridge-teardown/, bridgePath);
    assert.match(source, /function dispose\(/, bridgePath);
    assert.match(source, /removeEventListener/, bridgePath);
  }
});

test('bridge injection handles invalidated extension context', () => {
  const injectors = [
    '../src/features/custom-linter-feature.ts',
    '../src/features/quick-region-autocomplete-feature.ts',
    '../src/services/row-service.ts',
    '../src/services/timestamp-edit-service.ts',
    '../src/services/waveform-scale-service.ts',
    '../src/services/magnifier-service.ts',
    '../src/services/minimap-service.ts',
    '../src/services/timeline-selection-service.ts'
  ];

  for (const injector of injectors) {
    const source = fs.readFileSync(new URL(injector, import.meta.url), 'utf8');
    assert.match(source, /try\s*{[\s\S]*runtime\.getURL/, injector);
    assert.match(source, /catch\s*\(_error\)/, injector);
  }
});
