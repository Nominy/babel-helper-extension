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
  const linterSource = read('../src/features/custom-linter/feature.ts');
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
  assert.match(linterSource, /function countPerf/);
  assert.doesNotMatch(linterSource, /safe\(\(\) => window\.__babelHelperPerf/);
});

test('minimap full redraws self-heal stale hosts and region data', () => {
  const minimapSource = read('../src/services/minimap-service.ts');
  const bridgeSource = read('../src/content/magnifier-bridge.ts');

  assert.match(minimapSource, /const discovered = discoverWaveformHosts\(\)/);
  assert.match(minimapSource, /return discovered\.slice\(0, MINIMAP_MAX_TRACKS\)/);
  assert.match(minimapSource, /function primaryHostStillCurrent/);
  assert.match(minimapSource, /contentSignature !== minimap\.primaryContentSignature/);
  assert.match(minimapSource, /host\.shadowRoot instanceof ShadowRoot/);
  assert.match(minimapSource, /new MutationObserver\(\(\) => requestDebouncedFullSync\(minimap\)\)/);
  assert.match(minimapSource, /minimap\.hostSignature = '';\s*minimap\.primaryContentSignature = '';\s*minimap\.fullSyncOk = false;/);

  assert.match(bridgeSource, /function getMinimapContentSignature/);
  assert.match(bridgeSource, /contentSignature: getMinimapContentSignature\(wave\)/);
  assert.match(bridgeSource, /const signature = getMinimapPeakSignature\(wave\)/);
  assert.match(bridgeSource, /minimapPeakCache\.set\(wave, base\)/);
});

test('minimap navigation seeks every visible wave and then recenters', () => {
  const bridgeSource = read('../src/content/magnifier-bridge.ts');
  const applyIndex = bridgeSource.indexOf('const applied = applySourceTimeToWaves(waves, targetTime, duration)');
  const centerIndex = bridgeSource.indexOf('const scrollLeft = centerViewportOnTime', applyIndex);

  assert.match(bridgeSource, /function centerViewportOnTime/);
  assert.match(bridgeSource, /function applySourceTime/);
  assert.match(bridgeSource, /function applySourceTimeToWaves/);
  assert.match(bridgeSource, /function getNavigationWaveSet/);
  assert.match(bridgeSource, /renderer\.renderProgress\(progress\)/);
  assert.match(bridgeSource, /const minimapNavigationTokens = new WeakMap\(\)/);
  assert.match(bridgeSource, /window\.requestAnimationFrame\(\(\) =>/);
  assert.ok(applyIndex > 0, 'navigateSource should set all waveform instances');
  assert.ok(centerIndex > applyIndex, 'navigateSource should recenter after setting time');
});

test('cut preview commit reuses the final in-flight time range request', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const ensureStart = source.indexOf('async function ensurePreviewTimeRange(preview)');
  const forceRefreshIndex = source.indexOf('refreshPreviewTimeRange(preview, { force: true })', ensureStart);
  const reuseRequestIndex = source.indexOf('if (preview.timeRangeRequest) {', ensureStart);

  assert.ok(ensureStart > 0, 'timeline selection should expose ensurePreviewTimeRange');
  assert.ok(reuseRequestIndex > ensureStart, 'ensurePreviewTimeRange should check for an in-flight request');
  assert.ok(
    reuseRequestIndex < forceRefreshIndex,
    'ensurePreviewTimeRange should await the existing request before forcing a duplicate request'
  );
  assert.match(
    source.slice(reuseRequestIndex, forceRefreshIndex),
    /return \(await preview\.timeRangeRequest\) \|\| null;/
  );
});

test('split-required cut commit uses a short duplicate-row wait before trimming', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const commitStart = source.indexOf('helper.commitCutPreview = async function commitCutPreview');
  const commitEnd = source.indexOf('helper.handleCutPreviewKeydown', commitStart);
  const commitBody = source.slice(commitStart, commitEnd);

  assert.match(source, /CUT_PREVIEW_FAST_DUPLICATE_ROW_WAIT_MS = 180/);
  assert.match(source, /CUT_PREVIEW_SMART_SPLIT_ROW_WAIT_MS = 1200/);
  assert.match(source, /async function waitForDuplicateSplitRows\(previousRows, speakerKey, timeoutMs\)/);
  assert.match(
    commitBody,
    /waitForDuplicateSplitRows\(\s*splitRowSnapshot,\s*speakerKey,\s*CUT_PREVIEW_FAST_DUPLICATE_ROW_WAIT_MS\s*\)/
  );
  assert.doesNotMatch(
    commitBody,
    /findNewDuplicateSplitRows\(splitRowSnapshot[\s\S]*1200,\s*40/,
    'commit should not block for the full smart-split duplicate-row window before moving boundaries'
  );
});
