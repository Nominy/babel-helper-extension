import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('auto-segmentation hotkey is distinct from current and all-segment trim hotkeys', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const lifecycleSource = read('../src/core/lifecycle.ts');

  assert.match(source, /AUTO_SEGMENT_SILENCE_MIN_SECONDS = 1\b/);
  assert.match(source, /AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD = Math\.pow\(10, -56 \/ 20\)/);
  assert.doesNotMatch(source, /AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD = Math\.pow\(10, -18 \/ 20\)/);
  assert.match(source, /AUTO_SEGMENT_MERGE_GAP_SECONDS = 1\b/);
  assert.match(source, /\['Alt \+ Shift \+ S', 'Split visible segments on silence runs over 1000ms, then trim all'\]/);
  assert.doesNotMatch(source, /\['Alt \+ Ctrl\/Cmd \+ Shift \+ R', 'Split visible segments on silence runs over 1000ms, then trim all'\]/);

  const autoSegmentCall = source.indexOf('void helper.autoSegmentVisibleSilences()');
  const autoSegmentHotkeyStart = source.lastIndexOf('if (', autoSegmentCall);
  const autoSegmentHotkeyBlock = source.slice(autoSegmentHotkeyStart, autoSegmentCall);
  assert.ok(autoSegmentCall >= 0 && autoSegmentHotkeyStart >= 0, 'expected auto-segmentation hotkey block');
  assert.match(autoSegmentHotkeyBlock, /event\.altKey/);
  assert.match(autoSegmentHotkeyBlock, /event\.shiftKey/);
  assert.match(autoSegmentHotkeyBlock, /!event\.ctrlKey/);
  assert.match(autoSegmentHotkeyBlock, /!event\.metaKey/);
  assert.match(autoSegmentHotkeyBlock, /event\.code === 'KeyS'/);
  assert.doesNotMatch(autoSegmentHotkeyBlock, /KeyR/);
  assert.match(source, /analyticsData: \{\s*scope: 'auto-segmentation'\s*\}/);

  const windowCaptureStart = lifecycleSource.indexOf('function handleNativeArrowSuppress');
  const windowCaptureEnd = lifecycleSource.indexOf('if (isRightShiftSegmentNavigationShortcut', windowCaptureStart);
  const windowCaptureBlock = lifecycleSource.slice(windowCaptureStart, windowCaptureEnd);
  assert.match(windowCaptureBlock, /event\.altKey &&[\s\S]*event\.shiftKey &&[\s\S]*event\.code === 'KeyS'/);
  assert.doesNotMatch(windowCaptureBlock, /event\.shiftKey &&[\s\S]*\(event\.ctrlKey \|\| event\.metaKey\)[\s\S]*event\.code === 'KeyR'/);
});

test('auto-segmentation asks the bridge for silence runs over one second', () => {
  const serviceSource = read('../src/services/timeline-selection-service.ts');
  const bridgeSource = read('../src/content/magnifier-bridge.ts');

  assert.match(serviceSource, /callSelectionBridge\('find-segment-silence-runs'/);
  assert.match(serviceSource, /speakerKey: target\.speakerKey/);
  assert.match(serviceSource, /minimumSilenceSeconds: AUTO_SEGMENT_SILENCE_MIN_SECONDS/);
  assert.match(serviceSource, /amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD/);
  assert.match(serviceSource, /for \(const row of helper\.getTranscriptRows\(\)\)/);

  assert.match(bridgeSource, /function findSegmentSilenceRunsForResolvedWave/);
  assert.match(bridgeSource, /minimumSilenceSeconds/);
  assert.match(bridgeSource, /durationSeconds >= minimumDuration/);
  assert.match(bridgeSource, /splitSeconds: \(startSeconds \+ endSeconds\) \/ 2/);
  assert.match(bridgeSource, /resolveWaveForVisibleSpeaker\(speakerKey\)/);
  assert.match(bridgeSource, /operation === 'find-segment-silence-runs'/);
});

test('auto-segmentation pre-trims, merges one-second same-speaker gaps, splits, and post-trims', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const timestampServiceSource = read('../src/services/timestamp-edit-service.ts');
  const timestampBridgeSource = read('../src/content/timestamp-bridge.ts');

  const autoStart = source.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()');
  const autoEnd = source.indexOf('async function trimSegmentTarget', autoStart);
  const autoBlock = source.slice(autoStart, autoEnd);
  const preTrimIndex = autoBlock.indexOf('const preTrimResult = await helper.trimAllSegmentsToAudio');
  const mergeIndex = autoBlock.indexOf('const mergeResult = await mergeAutoSegmentCloseRows()');
  const collectIndex = autoBlock.indexOf('const targets = collectAutoSegmentTargets()');
  const splitIndex = autoBlock.indexOf('const splitPlans = collectAutoSegmentSplitPlans(targets, silenceResults)');
  const postTrimIndex = autoBlock.indexOf('const postTrimResult = await helper.trimAllSegmentsToAudio');

  assert.ok(preTrimIndex >= 0, 'expected pre-trim before collecting split targets');
  assert.ok(mergeIndex > preTrimIndex, 'expected merge pass after pre-trim');
  assert.ok(collectIndex > mergeIndex, 'expected target collection after merge pass');
  assert.ok(splitIndex > collectIndex, 'expected split plans after re-collecting targets');
  assert.ok(postTrimIndex > splitIndex, 'expected post-trim after splitting');
  assert.match(autoBlock, /preTrimResult && preTrimResult\.ok/);
  assert.match(autoBlock, /postTrimResult && postTrimResult\.ok/);
  assert.match(autoBlock, /amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD/);
  assert.doesNotMatch(autoBlock, /const trimResult = await helper\.trimAllSegmentsToAudio\(\)/);

  assert.match(source, /async function mergeAutoSegmentCloseRows\(\)/);
  assert.match(source, /const rowsBySpeaker = new Map\(\)/);
  assert.match(source, /gapSeconds > AUTO_SEGMENT_MERGE_GAP_SECONDS/);
  assert.match(source, /helper\.mergeSegmentWithNativeAction\(\{/);
  assert.match(source, /direction: 'below'/);

  assert.match(source, /const splitPlans = collectAutoSegmentSplitPlans\(targets, silenceResults\)/);
  assert.match(source, /sort\(\(left, right\) => right\.splitSeconds - left\.splitSeconds\)/);
  assert.match(source, /helper\.splitSegmentAtTime\(\{/);
  assert.match(source, /annotationId: plan\.annotationId/);
  assert.match(source, /splitSeconds: plan\.splitSeconds/);
  assert.doesNotMatch(source, /const plan = await resolveAutoSegmentSplitPlan\(splitPlans\[index\]\)/);
  assert.match(source, /await helper\.sleep\(AUTO_SEGMENT_SPLIT_SETTLE_MS\)/);
  assert.match(source, /const postTrimResult = await helper\.trimAllSegmentsToAudio\(\{/);
  assert.match(source, /const finalPhaseOk =[\s\S]*silentCleanupResult[\s\S]*redistributionResult/);
  assert.match(source, /const result = \{\s*ok: finalPhaseOk,\s*reason: finalPhaseOk \? null : 'finalize-failed',\s*changed: splitCount > 0 \|\| Boolean\(postTrimResult && postTrimResult\.changedCount\) \|\| Boolean\(mergeResult && mergeResult\.mergeCount\)/);
  assert.match(source, /return result/);

  assert.match(timestampServiceSource, /callTimestampBridge\('split-segment-at-time'/);
  assert.match(timestampBridgeSource, /function resolveRowSplitBinding/);
  assert.match(timestampBridgeSource, /findSplitAnnotationCallback/);
  assert.match(timestampBridgeSource, /splitAnnotation\(binding\.annotationId, splitSeconds\)/);
  assert.match(timestampBridgeSource, /operation === 'split-segment-at-time'/);
});

test('auto-segmentation merge pass compares consecutive rows per speaker lane', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const start = source.indexOf('function collectAutoSegmentMergePlans()');
  const end = source.indexOf('async function mergeAutoSegmentCloseRows()', start);
  const block = source.slice(start, end);

  assert.ok(start >= 0 && end > start, 'expected merge plan collector');
  assert.match(block, /const rowsBySpeaker = new Map\(\)/);
  assert.match(block, /rowsBySpeaker\.get\(snapshot\.speakerKey\)/);
  assert.match(block, /speakerRows\.sort\(\(left, right\) => left\.startSeconds - right\.startSeconds\)/);
  assert.doesNotMatch(block, /rows\[index \+ 1\]/);
});

test('auto-segmentation can use native row merge and delete callbacks through the page bridge', () => {
  const timestampServiceSource = read('../src/services/timestamp-edit-service.ts');
  const timestampBridgeSource = read('../src/content/timestamp-bridge.ts');

  assert.match(timestampBridgeSource, /function resolveRowActionBinding/);
  assert.match(timestampBridgeSource, /typeof props\.onMergeAbove === 'function'/);
  assert.match(timestampBridgeSource, /typeof props\.onMergeBelow === 'function'/);
  assert.match(timestampBridgeSource, /typeof props\.onDelete === 'function'/);
  assert.match(timestampBridgeSource, /binding\.onMergeAbove\(binding\.annotationId\)/);
  assert.match(timestampBridgeSource, /binding\.onMergeBelow\(binding\.annotationId\)/);
  assert.match(timestampBridgeSource, /binding\.onDelete\(binding\.annotationId\)/);
  assert.match(timestampBridgeSource, /operation === 'merge-segment'/);
  assert.match(timestampBridgeSource, /operation === 'delete-segment'/);

  assert.match(timestampServiceSource, /callTimestampBridge\('merge-segment'/);
  assert.match(timestampServiceSource, /callTimestampBridge\('delete-segment'/);
  assert.match(timestampServiceSource, /helper\.mergeSegmentWithNativeAction/);
  assert.match(timestampServiceSource, /helper\.deleteSegmentWithNativeAction/);
});

test('auto-segmentation removes fully silent same-speaker rows after final trim', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const autoStart = source.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()');
  const autoEnd = source.indexOf('async function trimSegmentTarget', autoStart);
  const autoBlock = source.slice(autoStart, autoEnd);

  assert.match(source, /async function cleanupAutoSegmentSilentRows\(\)/);
  assert.match(source, /function findNearestSameSpeakerAutoSegmentRow\(silent/);
  assert.match(source, /candidateSpeakerKey !== speakerKey/);
  assert.match(source, /requestTrimTargets\(target, labels, target\.speakerKey, \{/);
  assert.match(source, /amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD/);
  assert.match(source, /if \(probe && probe\.ok && !probe\.foundAudio\)/);
  assert.match(source, /helper\.setEditableValue\(nearestTextarea, nextText\)/);
  assert.match(source, /typeof helper\.deleteSegmentWithNativeAction !== 'function'/);
  assert.match(source, /reason: 'missing-delete-action'/);
  assert.match(source, /helper\.deleteSegmentWithNativeAction\(\{/);
  assert.match(source, /silentCleanupResult && silentCleanupResult\.deleteCount/);

  const cleanupIndex = autoBlock.indexOf('const silentCleanupResult = await cleanupAutoSegmentSilentRows()');
  const postTrimIndex = autoBlock.indexOf('const postTrimResult = await helper.trimAllSegmentsToAudio');
  assert.ok(cleanupIndex > postTrimIndex, 'expected silent cleanup after post-trim');
  assert.match(autoBlock, /cleanup: silentCleanupResult/);
  assert.match(autoBlock, /Boolean\(silentCleanupResult && silentCleanupResult\.deleteCount\)/);
});

test('auto-segmentation redistributes text with Prompt API after silent cleanup without crossing speakers', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const autoStart = source.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()');
  const autoEnd = source.indexOf('async function trimSegmentTarget', autoStart);
  const autoBlock = source.slice(autoStart, autoEnd);

  assert.match(source, /function collectAutoSegmentTextBaselineGroups\(\)/);
  assert.match(source, /function collectAutoSegmentTextRedistributionGroups\(baselineGroups\)/);
  assert.match(source, /async function redistributeAutoSegmentTextWithPromptApi\(baselineGroups\)/);
  assert.match(source, /createAutoSegmentTextRedistributionDraft\(group\)/);
  assert.match(source, /applyAutoSegmentTextReview\(group, draftResult\.allocations, bridgeResult\.review\)/);
  assert.match(source, /validateAutoSegmentTextAllocationsPreserveText\(group, allocations\)/);
  assert.match(source, /callSelectionBridge\('auto-segment-redistribute-text'/);
  assert.match(source, /speakerKey: group\.speakerKey/);
  assert.match(source, /fullText: draftResult\.fullText/);
  assert.match(source, /segments: group\.segments\.map/);
  assert.match(source, /draftAllocations: draftResult\.allocations/);
  assert.match(source, /helper\.setEditableValue\(textarea, allocation\.text\)/);
  assert.match(source, /segment\.speakerKey === baseline\.speakerKey/);
  assert.doesNotMatch(source, /nextText\.length >= originalText\.length \* 0\.35/);

  const cleanupIndex = autoBlock.indexOf('const silentCleanupResult = await cleanupAutoSegmentSilentRows()');
  const baselineIndex = autoBlock.indexOf('const textBaselineGroups = collectAutoSegmentTextBaselineGroups()');
  const redistributionIndex = autoBlock.indexOf('const redistributionResult = await redistributeAutoSegmentTextWithPromptApi(textBaselineGroups)');
  assert.ok(baselineIndex >= 0, 'expected pre-split text baseline capture');
  assert.ok(cleanupIndex >= 0, 'expected silent cleanup in auto-segmentation flow');
  assert.ok(baselineIndex < cleanupIndex, 'expected text baseline before splitting/final cleanup');
  assert.ok(redistributionIndex > cleanupIndex, 'expected Prompt API redistribution after silent cleanup');
  assert.match(autoBlock, /redistribution: redistributionResult/);
  assert.match(autoBlock, /Boolean\(redistributionResult && redistributionResult\.changedCount\)/);
});

test('auto-segmentation final cleanup and text alignment cannot abort complete debug output', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const autoStart = source.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()');
  const autoEnd = source.indexOf('async function trimSegmentTarget', autoStart);
  const autoBlock = source.slice(autoStart, autoEnd);

  assert.match(source, /function createAutoSegmentCleanupFailureResult\(error\)/);
  assert.match(source, /function createAutoSegmentRedistributionFailureResult\(error\)/);
  assert.match(autoBlock, /const silentCleanupResult = await cleanupAutoSegmentSilentRows\(\)\.catch\(\(error\) =>\s*createAutoSegmentCleanupFailureResult\(error\)\s*\)/);
  assert.match(autoBlock, /const redistributionResult = await redistributeAutoSegmentTextWithPromptApi\(textBaselineGroups\)\.catch\(\(error\) =>\s*createAutoSegmentRedistributionFailureResult\(error\)\s*\)/);
  assert.match(autoBlock, /const finalPhaseOk =[\s\S]*silentCleanupResult[\s\S]*redistributionResult/);
  assert.match(autoBlock, /reason: finalPhaseOk \? null : 'finalize-failed'/);
  assert.match(autoBlock, /phase: 'complete'[\s\S]*ok: result\.ok[\s\S]*reason: result\.reason \|\| null/);
});

test('auto-segmentation Prompt API bridge uses local LanguageModel with structured output and sampled audio', () => {
  const bridgeSource = read('../src/content/magnifier-bridge.ts');

  assert.match(bridgeSource, /function getPromptApiLanguageModel/);
  assert.match(bridgeSource, /LanguageModel\.availability/);
  assert.match(bridgeSource, /LanguageModel\.create/);
  assert.match(bridgeSource, /expectedInputs: \[\{ type: 'text' \}, \{ type: 'audio' \}\]/);
  assert.match(bridgeSource, /responseConstraint/);
  assert.match(bridgeSource, /session\.prompt\(/);
  assert.match(bridgeSource, /session\.destroy\(\)/);
  assert.match(bridgeSource, /function getAutoSegmentPromptReviewSchema/);
  assert.match(bridgeSource, /required: \['acceptDraft', 'moves', 'notes'\]/);
  assert.match(bridgeSource, /function validateAutoSegmentPromptReview/);
  assert.match(bridgeSource, /draftAllocations/);
  assert.match(bridgeSource, /review: \{/);
  assert.doesNotMatch(bridgeSource, /required: \['allocations'\]/);
  assert.match(bridgeSource, /function createAutoSegmentPromptAudioBuffer/);
  assert.match(bridgeSource, /getDecodedAudioChannelsForTrim\(wave\)/);
  assert.match(bridgeSource, /context\.createBuffer/);
  assert.match(bridgeSource, /resolveWaveForVisibleSpeaker\(group\.speakerKey\)/);
  assert.match(bridgeSource, /operation === 'auto-segment-redistribute-text'/);
});

test('auto-segmentation trim cannot extend split siblings into overlaps', () => {
  const source = read('../src/services/timeline-selection-service.ts');

  assert.match(source, /AUDIO_TRIM_NEIGHBOR_GUARD_SECONDS = 0\.01/);
  assert.match(source, /function getSameSpeakerBoundaryNeighborLimits\(row, speakerKey\)/);
  assert.match(source, /function capOutwardBoundaryTarget\(row, side, speakerKey, targetSeconds\)/);
  assert.match(source, /const cappedExtendEndSeconds = capOutwardBoundaryTarget\(row, 'right', speakerKey, extendEndSeconds\)/);
  assert.match(source, /const cappedExtendStartSeconds = capOutwardBoundaryTarget\(row, 'left', speakerKey, extendStartSeconds\)/);
});

test('auto-segmentation silence detection uses rendered lane peaks before decoded audio', () => {
  const bridgeSource = read('../src/content/magnifier-bridge.ts');
  const start = bridgeSource.indexOf('function findSegmentSilenceRunsForResolvedWave');
  const end = bridgeSource.indexOf('function findTrimTargetsForResolvedWave', start);
  const block = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'expected silence detection function block');
  assert.ok(
    block.indexOf('const rawPeaks = getRawExportPeaks(wave)') <
      block.indexOf('const decoded = getDecodedAudioChannelsForTrim(wave)'),
    'rendered/exported peaks must be checked before decoded full audio'
  );
  assert.match(block, /source: 'export-peaks'/);
  assert.match(block, /source: 'decoded-audio'/);
});

test('auto-segmentation does not bind speaker rows to unlabeled waveform hosts', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const bridgeSource = read('../src/content/magnifier-bridge.ts');
  const collectStart = source.indexOf('function collectAutoSegmentTargets');
  const collectEnd = source.indexOf('function getAutoSegmentTargetDiagnostics', collectStart);
  const collectBlock = source.slice(collectStart, collectEnd);
  const findStart = bridgeSource.indexOf('function findSegmentSilenceRuns(hostMarker, speakerKey');
  const findEnd = bridgeSource.indexOf('function findTrimTargetsForSpeaker', findStart);
  const findBlock = bridgeSource.slice(findStart, findEnd);

  assert.ok(collectStart >= 0 && collectEnd > collectStart, 'expected auto-segmentation target collector');
  assert.match(collectBlock, /candidateSpeakerKey === speakerKey/);
  assert.doesNotMatch(collectBlock, /!candidateSpeakerKey \|\| candidateSpeakerKey === speakerKey/);
  assert.ok(findStart >= 0 && findEnd > findStart, 'expected silence-run host resolver');
  assert.match(findBlock, /hostMatchesSpeaker\(resolved\.host, speakerKey\)/);
});

test('auto-segmentation does not fall back to a mismatched single visible speaker lane', () => {
  const bridgeSource = read('../src/content/magnifier-bridge.ts');
  const start = bridgeSource.indexOf('function resolveWaveForVisibleSpeaker');
  const end = bridgeSource.indexOf('function findTrimTargets', start);
  const block = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'expected visible-speaker wave resolver');
  assert.match(block, /if \(!normalizedSpeakerKey && !\(host instanceof HTMLElement\) && hosts\.length === 1\)/);
});

test('auto-segmentation ignores reentry while a run is already pending', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const start = source.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()');
  const end = source.indexOf('async function trimSegmentTarget', start);
  const block = source.slice(start, end);

  assert.match(source, /helper\.state\.autoSegmentationPending = false/);
  assert.match(block, /if \(helper\.state\.autoSegmentationPending\)/);
  assert.match(block, /reason: 'auto-segmentation-pending'/);
  assert.match(block, /helper\.state\.autoSegmentationPending = true/);
  assert.match(block, /helper\.state\.autoSegmentationPending = false/);
});
