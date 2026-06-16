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
  assert.match(source, /state\.textOverlayRaf/);
  assert.match(source, /function cancelTextOverlayRender/);
  assert.match(source, /cancelTextOverlayRender\(state\);[\s\S]*state\.loadGeneration \+= 1/);
  assert.match(source, /function bindViewportListeners/);
  assert.match(source, /window\.addEventListener\('scroll', state\.viewportEventHandler, \{ capture: true, passive: true \}\)/);
  assert.match(source, /document\.addEventListener\('scroll', state\.viewportEventHandler, \{ capture: true, passive: true \}\)/);
  assert.match(source, /window\.addEventListener\('wheel', state\.viewportEventHandler, \{ capture: true, passive: true \}\)/);
  assert.match(source, /function unbindViewportListeners/);
  assert.match(source, /window\.cancelAnimationFrame\(state\.textOverlayRaf\)/);
  assert.match(source, /document\.querySelectorAll\('#bh-native-diff-overlay-root, \.bh-native-diff-overlay-root'\)/);
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

test('extended diff renders text patches without rewriting React-owned transcript cells', () => {
  const source = read('../src/services/extended-diff-view-service.ts');

  assert.match(source, /function renderTextDiffOverlay/);
  assert.match(source, /function scheduleTextDiffOverlayRender/);
  assert.match(source, /window\.requestAnimationFrame/);
  assert.match(source, /getNativeDiffOverlayRoot\(\)/);
  assert.match(source, /function getClippedCellRect/);
  assert.match(source, /function isOverflowClippingElement/);
  assert.match(source, /function isScrollableViewportElement/);
  assert.match(source, /function isKnownScrollViewportElement/);
  assert.match(source, /function isTextOverlayClippingElement/);
  assert.match(source, /function isTableStructureElement/);
  assert.match(source, /if \(isTableStructureElement\(element\)\) return false/);
  assert.match(source, /function findTableHeaderRow/);
  assert.match(source, /function getTableHeaderOcclusionClip/);
  assert.match(source, /headerRow\.contains\(cell\)/);
  assert.match(source, /const headerClip = getTableHeaderOcclusionClip\(cell, rect\)/);
  assert.match(source, /clip = intersectRects\(clip, headerClip\)/);
  assert.match(source, /TEXT_OVERLAY_CLIP_INSET_PX/);
  assert.match(source, /if \(isTextOverlayClippingElement\(ancestor\)\)/);
  assert.match(source, /clip = insetRect\(clip, TEXT_OVERLAY_CLIP_INSET_PX\)/);
  assert.match(source, /bh-native-diff-overlay-mask/);
  assert.match(source, /mask\.style\.left = `\$\{clip\.left\}px`/);
  assert.match(source, /mask\.style\.width = `\$\{clip\.right - clip\.left\}px`/);
  assert.match(source, /item\.style\.left = `\$\{rect\.left - clip\.left\}px`/);
  assert.match(source, /mask\.appendChild\(item\)/);
  assert.match(source, /root\.replaceChildren\(\)/);
  assert.match(source, /renderPatchIntoOverlay\(root, row\.textCell, patch\)/);
  assert.match(source, /removeNativeDiffOverlayRoot\(\)/);
  assert.doesNotMatch(source, /data-bh-native-diff-original/);
  assert.doesNotMatch(source, /bhNativeDiffOriginal/);
  assert.doesNotMatch(source, /cell\.replaceChildren/);
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
