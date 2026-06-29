import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('extended diff has teardown, observers, and stale-load protection', () => {
  const source = read('../src/services/extended-diff-view-service.ts');

  assert.match(source, /lifecycle:\s*'inactive'\s*\|\s*'waiting'\s*\|\s*'loading'\s*\|\s*'mounted'/);
  assert.match(source, /function bindMutationObserver/);
  assert.match(source, /function bindPerformanceObserver/);
  assert.match(source, /loadGeneration/);
  assert.match(source, /generation !== state\.loadGeneration/);
  assert.match(source, /removeInjectedStyles\(\)/);
  assert.match(source, /delete document\.documentElement\.dataset\.bhExtendedDiffDebug/);
  assert.match(source, /state\.mutationObserver\?\.disconnect\(\)/);
  assert.match(source, /state\.performanceObserver\?\.disconnect\(\)/);
  assert.match(source, /clearDiffToggleRetries\(state\)/);
  assert.match(source, /state\.observerDebounceTimer/);
  assert.doesNotMatch(source, /textOverlayRaf/);
  assert.doesNotMatch(source, /function cancelTextOverlayRender/);
  assert.doesNotMatch(source, /function bindViewportListeners/);
  assert.doesNotMatch(source, /function unbindViewportListeners/);
  assert.doesNotMatch(source, /state\.viewportEventHandler/);
  assert.doesNotMatch(source, /bh-native-diff-overlay-root/);
  assert.match(source, /delete helper\.unbindExtendedDiffView/);
});

test('extended diff toggle recovery uses bounded retries, not interval bursts', () => {
  const source = read('../src/services/extended-diff-view-service.ts');

  const scheduleCalls = source.match(/scheduleDiffToggleRetries\(state\)/g) || [];
  assert.equal(scheduleCalls.length, 1);
  assert.match(source, /if \(diffViewEnabled && !state\.lastDiffViewEnabled\) \{\s*scheduleDiffToggleRetries\(state\);/);
  assert.match(source, /DIFF_TOGGLE_RETRY_DELAYS_MS = \[120, 450, 1100\]/);
  assert.doesNotMatch(source, /AGGRESSIVE_DIFF_TOGGLE_POLL_INTERVAL_MS/);
  assert.doesNotMatch(source, /window\.setInterval\(\(\) => \{\s*if \(state\.disposed \|\| state\.aggressivePollsRemaining/);
  assert.match(source, /NORMAL_POLL_INTERVAL_MS/);
});

test('extended diff generated fallback supports lower and higher review levels', () => {
  const source = read('../src/services/extended-diff-view-service.ts');

  assert.match(source, /function getCurrentReviewActionIdFromDiffUrl/);
  assert.match(source, /reviewActionId = asString\(record\.currentReviewActionId\);/);
  assert.match(source, /const queryValue = new URLSearchParams\(window\.location\.search \|\| ''\)\.get\('reviewActionId'\) \|\| '';/);
  assert.match(source, /Boolean\(getCurrentReviewActionId\(\)\)/);
  assert.match(source, /Boolean\(document\.body\.innerText\.match\(\/\\bCompare:\\b\/\)\)/);
  assert.match(source, /displayFeedback !== 'false'/);
  assert.match(source, /function buildGeneratedDiffUrlForAction/);
  assert.match(source, /action\.level < currentLevel[\s\S]*return buildDiffUrl\(action\.id, currentReviewActionId\);/);
  assert.match(source, /return buildDiffUrl\(currentReviewActionId, action\.id\);/);
  assert.doesNotMatch(source, /action\.level <= currentLevel\) continue/);
  assert.match(source, /function dedupeDiffEntries/);
  assert.match(source, /const generatedUrls = await discoverGeneratedDiffUrls\(state\);/);
  assert.doesNotMatch(source, /nativeEntries\.length \? \[\] : await discoverGeneratedDiffUrls\(state\)/);
  assert.doesNotMatch(source, /getReviewActionsForChunk'\) && diffUrlMentionsReviewAction/);
  assert.match(source, /const entries = dedupeDiffEntries\(\[[\s\S]*\]\)\.filter\(\(entry\) => !state\.loadedUrls\.has\(entry\.url\)\);/);
  assert.match(source, /const compareLevels = new Set\(generated\.map\(\(diff\) => diff\.compareLevel\)\.filter\(\(level\) => level != null\)\);/);
  assert.match(source, /return compareLevels\.size === 1 \? generated : \[\];/);
});

test('extended diff delegates text presentation to recovered Babel state instead of row overlays', () => {
  const source = read('../src/services/extended-diff-view-service.ts');

  assert.match(source, /function reconcileRecoveredEditorTextDiffState/);
  assert.match(source, /helper\.getEditorSnapshot/);
  assert.match(source, /helper\.refreshEditorSnapshot\('extended-diff-text-state'\)/);
  assert.match(source, /referenceReviewActionId: asString\(payload\.referenceReviewActionId\)/);
  assert.match(source, /currentReviewActionId: asString\(payload\.currentReviewActionId\)/);
  assert.match(source, /selectedCompareActionId: anchorSide === 'current' \? referenceReviewActionId : currentReviewActionId/);
  assert.match(source, /helper\.applyRecoveredEditorDiffState/);
  assert.match(source, /helper\.clearRecoveredEditorDiffState/);
  assert.match(source, /pendingRecoveredDiffActionId/);
  assert.match(source, /const recoveredDiff = renderableDiffs\.find\(\(diff\) => diff\.selectedCompareActionId\);/);
  assert.doesNotMatch(source, /diff\.source === 'generated' && diff\.selectedCompareActionId/);
  assert.match(source, /helper\.applyRecoveredEditorDiffState\(\{[\s\S]*\}\)\.then\(\(result(?:: any)?\) =>/);
  assert.match(source, /if \(result\?\.ok\) \{[\s\S]*state\.appliedRecoveredDiffActionId = actionId;/);
  assert.match(source, /else \{[\s\S]*state\.appliedRecoveredDiffActionId = '';/);
  assert.match(source, /textDiffMode: 'babel-native-state'/);
  assert.match(source, /source: recoveredDiff\.source/);
  assert.match(source, /tagCount: renderableDiffs\.reduce/);
  assert.match(source, /textDiffMode: 'babel-native-state'/);
  assert.match(source, /source: recoveredDiff\.source/);
  assert.match(source, /tagCount: renderableDiffs\.reduce/);
  assert.match(source, /function renderSegmentationModeControls[\s\S]*injectStyles\(\)/);
  assert.doesNotMatch(source, /renderNativeDiffTextReplacements/);
  assert.doesNotMatch(source, /nativeDiffTextOriginalChildren/);
  assert.doesNotMatch(source, /host\.replaceChildren/);
  assert.doesNotMatch(source, /bh-native-diff-supplement/);
  assert.doesNotMatch(source, /renderNativeDiffSupplements/);
  assert.doesNotMatch(source, /supplementCount/);
  assert.doesNotMatch(source, /function renderTextDiffOverlay/);
  assert.doesNotMatch(source, /function scheduleTextDiffOverlayRender/);
  assert.doesNotMatch(source, /function getClippedCellRect/);
  assert.doesNotMatch(source, /getBoundingClientRect\(\)[\s\S]*bh-native-diff-overlay/);
  assert.doesNotMatch(source, /bh-native-diff-overlay-mask/);
  assert.doesNotMatch(source, /bh-native-diff-overlay-item/);
  assert.doesNotMatch(source, /renderPatchIntoOverlay/);
  assert.doesNotMatch(source, /data-bh-native-diff-original/);
  assert.doesNotMatch(source, /bhNativeDiffOriginal/);
  assert.doesNotMatch(source, /cell\.innerHTML\s*=/);
});

test('speaker workflow uses robust control driving and always releases pending guard', () => {
  const source = read('../src/services/row-service.ts');

  assert.match(source, /function clickControl\(element\)/);
  assert.match(source, /try \{\s*element\.click\(\);\s*return true;\s*\} catch/);
  assert.doesNotMatch(source, /new KeyboardEvent\('keydown'[\s\S]*code: 'Escape'/);
  assert.match(source, /recordSpeakerWorkflow\('switch-failed'/);
  assert.match(source, /recordSpeakerWorkflow\('reset-failed'/);
  assert.match(source, /finally \{\s*helper\.state\.speakerSwitchPending = false;\s*\}/);
});

test('row actions use strict current-row resolution instead of first-row fallback', () => {
  const rowSource = read('../src/services/row-service.ts');
  const lifecycleSource = read('../src/core/lifecycle.ts');

  assert.match(rowSource, /helper\.getCurrentActionRow = function getCurrentActionRow/);
  assert.match(rowSource, /helper\.resolveTimelineSegmentTargetRow/);
  assert.match(rowSource, /allowFallback: settings\.allowFallback === true/);
  assert.doesNotMatch(rowSource, /allowFallback: settings\.allowFallback !== false/);
  assert.match(lifecycleSource, /helper\.getCurrentActionRow\(\{ allowFallback: false \}\)/);
  assert.match(lifecycleSource, /helper\.runRowAction\('mergePrevious'\)/);
  assert.match(lifecycleSource, /helper\.runRowAction\('mergeNext'\)/);
});

test('timeline clicks become authoritative current segment targets', () => {
  const source = read('../src/services/timeline-selection-service.ts');

  assert.match(source, /helper\.state\.currentTimelineTarget = null/);
  assert.match(source, /function captureTimelineSegmentTarget/);
  assert.match(source, /helper\.resolveTimelineSegmentTargetRow = function resolveTimelineSegmentTargetRow/);
  assert.match(source, /captureTimelineSegmentTarget\(event\);/);
  assert.match(source, /rememberTimelineSegmentTarget\(row, container, entry, speakerKey\)/);
  assert.match(source, /const liveEntry =[\s\S]*findRegionEntryForRow\(row, target\.container\)/);
  assert.match(source, /entry: liveEntry \|\| labels/);
  assert.match(source, /liveTarget\.entry = labels/);
});

test('native timeline double-clicks are blocked before Babel seeks to segment start', () => {
  const source = read('../src/services/timeline-selection-service.ts');

  assert.match(source, /function isNativeTimelineDoubleClickTarget/);
  assert.match(source, /function handleTimelineDoubleClick/);
  assert.match(source, /isFeatureEnabled\('disableNativeTimelineDoubleClick'\)/);
  assert.match(source, /event\.preventDefault\(\);[\s\S]*event\.stopImmediatePropagation\(\);[\s\S]*event\.stopPropagation\(\);/);
  assert.match(source, /document\.addEventListener\('dblclick', handleTimelineDoubleClick, true\);/);
  assert.match(source, /document\.removeEventListener\('dblclick', handleTimelineDoubleClick, true\);/);
});

test('ghost cursor uses lane lock and overlap-aware playback lookup', () => {
  const source = read('../src/services/row-service.ts');
  const stateSource = read('../src/core/state-store.ts');

  assert.match(stateSource, /ghostCursorLaneLock: null/);
  assert.match(source, /function getActiveRowEntriesByPlaybackTime/);
  assert.match(source, /row-cache\.lane-hit/);
  assert.match(source, /function findGhostCursorEntryByPlaybackTime/);
  assert.match(source, /setGhostCursorLaneLockForSpeaker\(targetLabel, 'manual'\)/);
  assert.match(source, /setGhostCursorLaneLockAuto\(\)/);
});

test('ghost cursor lane toggle uses isolated per-lane projections over the old active cursor', () => {
  const source = read('../src/services/row-service.ts');
  const stateSource = read('../src/core/state-store.ts');
  const lifecycleSource = read('../src/core/lifecycle.ts');
  const registrySource = read('../src/features/registry.ts');

  assert.match(stateSource, /ghostCursorProjectionSpeakerKey: null/);
  assert.match(stateSource, /ghostCursorProjectionSource: 'auto'/);
  assert.match(stateSource, /ghostCursorLaneProjections: \{\}/);
  assert.match(stateSource, /ghostCursorPlaybackTime: null/);

  assert.match(source, /const GHOST_CURSOR_TOGGLE_LANES = \['Speaker 1', 'Speaker 2'\]/);
  assert.match(source, /function rememberGhostCursorProjection/);
  assert.match(source, /function computeGhostCursorProjectionForEntry/);
  assert.match(source, /function updateGhostCursorLaneProjectionsForPlayback/);
  assert.match(source, /function getRenderedGhostCursorProjection/);
  assert.match(source, /function renderGhostCursorProjection/);
  assert.match(source, /function rememberFocusedGhostCursorProjection/);
  assert.match(source, /function focusGhostCursorProjection/);
  assert.match(source, /helper\.toggleGhostCursorLane = function toggleGhostCursorLane/);
  assert.match(source, /findRowEntryByPlaybackTime\(currentTime, \{ speakerKey \}\)/);
  assert.match(source, /findLatestRowEntryBeforePlaybackTime\(currentTime, \{ speakerKey \}\)/);
  assert.match(source, /rememberGhostCursorProjection\(trackedRow, result\.offset/);
  assert.match(source, /renderGhostCursorProjection\(renderedProjection\)/);
  assert.match(source, /const focusedProjection = rememberFocusedGhostCursorProjection\(\)/);
  assert.match(source, /const focusedKey = focusedProjection \? getRowSpeakerKeySafe\(focusedProjection\.row\) : ''/);
  assert.match(source, /helper\.state\.ghostCursorElement instanceof HTMLElement[\s\S]*renderGhostCursorProjection\(projection\)[\s\S]*focusGhostCursorProjection\(projection\)/);

  assert.doesNotMatch(source, /function setActiveGhostCursorSpeakerKey/);
  assert.doesNotMatch(source, /activeGhostCursorSpeakerKey/);
  assert.doesNotMatch(source, /setActiveGhostCursorSpeakerKey\(speakerKey, 'auto'\)/);
  assert.doesNotMatch(source, /if \(!\(helper\.state\.ghostCursorElement instanceof HTMLElement\)\) \{\s*return false;\s*\}/);

  assert.match(lifecycleSource, /function isGhostCursorLaneToggleShortcut/);
  assert.match(lifecycleSource, /helper\.toggleGhostCursorLane\(\)/);
  assert.match(registrySource, /rows\.push\(\['Tab', 'Toggle active ghost cursor lane'\]\)/);
});
