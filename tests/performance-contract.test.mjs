import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('entry kernel lazy-loads the heavy session runtime', () => {
  const kernelSource = read('../src/core/kernel.ts');
  const entrySource = read('../src/content/entry.ts');

  assert.match(kernelSource, /ensureSessionRuntime/);
  assert.match(kernelSource, /chromeApi\.runtime\.getURL\('dist\/content\/lazy-session\.js'\)/);
  assert.doesNotMatch(kernelSource, /registerMinimapService/);
  assert.doesNotMatch(kernelSource, /createFeatureModules/);
  assert.match(entrySource, /babel-helper-bridge-teardown/);
});

test('custom linter and quick autocomplete bridges do not inject during feature start', () => {
  const linterSource = read('../src/features/custom-linter-feature.ts');
  const quickSource = read('../src/features/quick-region-autocomplete-feature.ts');

  assert.match(linterSource, /start\(ctx: FeatureContext\) {\s*ctx\.helper\.requestAutoFix = requestAutoFix;\s*}/);
  assert.match(linterSource, /async onLoaded/);
  assert.match(quickSource, /async onLoaded/);
  assert.doesNotMatch(quickSource, /async start\(ctx: FeatureContext\) {\s*if \(!startPromise\)/);
});

test('playback row sync is adaptive and row lookup is cached', () => {
  const lifecycleSource = read('../src/core/lifecycle.ts');
  const rowSource = read('../src/services/row-service.ts');

  assert.doesNotMatch(lifecycleSource, /setInterval\(schedulePlaybackRowSync,\s*250\)/);
  assert.match(lifecycleSource, /getPlaybackSyncDelay/);
  assert.match(lifecycleSource, /playback\.sync\.tick/);
  assert.match(rowSource, /rowTimeCache/);
  assert.match(rowSource, /row-cache\.previous-hit/);
  assert.match(rowSource, /row-cache\.search-hit/);
});

test('steady-state observers are scoped away from whole body where possible', () => {
  const minimapSource = read('../src/services/minimap-service.ts');
  const waveformSource = read('../src/services/waveform-scale-service.ts');
  const quickSource = read('../src/content/quick-region-autocomplete-bridge.ts');
  const linterSource = read('../src/content/linter-bridge.ts');

  assert.doesNotMatch(minimapSource, /mutationObserver\.observe\(document\.body/);
  assert.doesNotMatch(waveformSource, /rowObserver\.observe\(document\.body/);
  assert.match(quickSource, /function bindMouseMove/);
  assert.match(quickSource, /function unbindMouseMove/);
  assert.match(linterSource, /disconnectHighlightObserver/);
});
