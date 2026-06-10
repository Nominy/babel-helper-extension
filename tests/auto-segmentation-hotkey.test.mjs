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
  assert.match(source, /AUTO_SEGMENT_SILENCE_THRESHOLD = Math\.pow\(10, -24 \/ 20\)/);
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
  assert.match(serviceSource, /amplitudeThreshold: AUTO_SEGMENT_SILENCE_THRESHOLD/);
  assert.match(serviceSource, /for \(const row of helper\.getTranscriptRows\(\)\)/);

  assert.match(bridgeSource, /function findSegmentSilenceRunsForResolvedWave/);
  assert.match(bridgeSource, /minimumSilenceSeconds/);
  assert.match(bridgeSource, /durationSeconds >= minimumDuration/);
  assert.match(bridgeSource, /splitSeconds: \(startSeconds \+ endSeconds\) \/ 2/);
  assert.match(bridgeSource, /resolveWaveForVisibleSpeaker\(speakerKey\)/);
  assert.match(bridgeSource, /operation === 'find-segment-silence-runs'/);
});

test('auto-segmentation splits from the end and trims all after splitting', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const timestampServiceSource = read('../src/services/timestamp-edit-service.ts');
  const timestampBridgeSource = read('../src/content/timestamp-bridge.ts');

  assert.match(source, /const splitPlans = collectAutoSegmentSplitPlans\(targets, silenceResults\)/);
  assert.match(source, /sort\(\(left, right\) => right\.splitSeconds - left\.splitSeconds\)/);
  assert.match(source, /helper\.splitSegmentAtTime\(\{/);
  assert.match(source, /annotationId: plan\.annotationId/);
  assert.match(source, /splitSeconds: plan\.splitSeconds/);
  assert.doesNotMatch(source, /const plan = await resolveAutoSegmentSplitPlan\(splitPlans\[index\]\)/);
  assert.match(source, /await helper\.sleep\(AUTO_SEGMENT_SPLIT_SETTLE_MS\)/);
  assert.match(source, /const trimResult = await helper\.trimAllSegmentsToAudio\(\)/);
  assert.match(source, /const result = \{\s*ok: true,\s*changed: splitCount > 0 \|\| Boolean\(trimResult && trimResult\.changedCount\)/);
  assert.match(source, /return result/);

  assert.match(timestampServiceSource, /callTimestampBridge\('split-segment-at-time'/);
  assert.match(timestampBridgeSource, /function resolveRowSplitBinding/);
  assert.match(timestampBridgeSource, /findSplitAnnotationCallback/);
  assert.match(timestampBridgeSource, /splitAnnotation\(binding\.annotationId, splitSeconds\)/);
  assert.match(timestampBridgeSource, /operation === 'split-segment-at-time'/);
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
