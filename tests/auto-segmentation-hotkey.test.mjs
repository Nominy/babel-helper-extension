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

test('current segment transcription hotkey uses Alt+Shift+G without touching trim shortcuts', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const lifecycleSource = read('../src/core/lifecycle.ts');

  assert.match(source, /\['Alt \+ Shift \+ G', 'Transcribe current empty segment with local Prompt API'\]/);

  const transcribeCall = source.indexOf('void helper.transcribeCurrentSegmentWithPromptApi()');
  const transcribeHotkeyStart = source.lastIndexOf('if (', transcribeCall);
  const transcribeHotkeyBlock = source.slice(transcribeHotkeyStart, transcribeCall);
  assert.ok(transcribeCall >= 0 && transcribeHotkeyStart >= 0, 'expected current-segment transcription hotkey block');
  assert.match(transcribeHotkeyBlock, /event\.altKey/);
  assert.match(transcribeHotkeyBlock, /event\.shiftKey/);
  assert.match(transcribeHotkeyBlock, /!event\.ctrlKey/);
  assert.match(transcribeHotkeyBlock, /!event\.metaKey/);
  assert.match(transcribeHotkeyBlock, /event\.code === 'KeyG'/);
  assert.doesNotMatch(transcribeHotkeyBlock, /trimCurrentSegmentToAudio|autoSegmentVisibleSilences/);
  assert.match(source, /analyticsData: \{\s*scope: 'segment-transcription'\s*\}/);

  const windowCaptureStart = lifecycleSource.indexOf('function handleNativeArrowSuppress');
  const windowCaptureEnd = lifecycleSource.indexOf('if (isRightShiftSegmentNavigationShortcut', windowCaptureStart);
  const windowCaptureBlock = lifecycleSource.slice(windowCaptureStart, windowCaptureEnd);
  assert.match(windowCaptureBlock, /event\.shiftKey &&[\s\S]*!event\.ctrlKey &&[\s\S]*!event\.metaKey &&[\s\S]*\(event\.code === 'KeyS' \|\| event\.code === 'KeyG'\)/);
});

test('current segment transcription refuses non-empty rows and writes only the Prompt API text', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const start = source.indexOf('helper.transcribeCurrentSegmentWithPromptApi = async function transcribeCurrentSegmentWithPromptApi()');
  const end = source.indexOf('helper.trimCurrentSegmentToAudio = async function trimCurrentSegmentToAudio', start);
  const block = source.slice(start, end);

  assert.ok(start >= 0 && end > start, 'expected current-segment transcription service method');
  assert.match(block, /const target = findCurrentSegmentTarget\(\)/);
  assert.match(block, /const textarea = helper\.getRowTextarea\(target\.row\)/);
  assert.match(block, /normalizeAutoSegmentRedistributionText\(helper\.getRowTextValue\(target\.row\)\)/);
  assert.match(block, /reason: 'segment-not-empty'/);
  assert.match(block, /callSelectionBridge\([\s\S]*'transcribe-segment-audio'/);
  assert.match(block, /speakerKey: target\.speakerKey/);
  assert.match(block, /startSeconds: range\.startSeconds/);
  assert.match(block, /endSeconds: range\.endSeconds/);
  assert.match(block, /timeoutMs: 300000/);
  assert.match(block, /const text = normalizeAutoSegmentRedistributionText\(bridgeResult\.text\)/);
  assert.match(block, /reason: 'segment-no-longer-empty'/);
  assert.match(block, /helper\.setEditableValue\(textarea, text\)/);
});

test('automatic segment insertion hotkey uses Alt+C from the playback caret', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const lifecycleSource = read('../src/core/lifecycle.ts');
  const backgroundSource = read('../src/background/commands.ts');
  const esbuildSource = read('../esbuild.config.mjs');

  assert.match(source, /\['Alt \+ C', 'Create empty segment around nearest uncovered speech near caret'\]/);
  assert.match(backgroundSource, /AUTO_INSERT_SEGMENT_COMMAND = 'auto-insert-segment'/);
  assert.match(backgroundSource, /chrome\.commands\.onCommand\.addListener/);
  assert.match(backgroundSource, /chrome\.tabs\.sendMessage/);
  assert.match(esbuildSource, /entryPoints: \['src\/background\/commands\.ts'\]/);

  const autoInsertCall = source.indexOf('void helper.autoInsertSegmentAtCaret()');
  const autoInsertHotkeyStart = source.lastIndexOf('if (', autoInsertCall);
  const autoInsertHotkeyBlock = source.slice(autoInsertHotkeyStart, autoInsertCall);
  assert.ok(autoInsertCall >= 0 && autoInsertHotkeyStart >= 0, 'expected automatic segment insertion hotkey block');
  assert.match(autoInsertHotkeyBlock, /event\.altKey/);
  assert.match(autoInsertHotkeyBlock, /!event\.shiftKey/);
  assert.match(autoInsertHotkeyBlock, /!event\.ctrlKey/);
  assert.match(autoInsertHotkeyBlock, /!event\.metaKey/);
  assert.match(autoInsertHotkeyBlock, /event\.code === 'KeyC'/);
  assert.doesNotMatch(autoInsertHotkeyBlock, /autoSegmentVisibleSilences|trimCurrentSegmentToAudio/);
  assert.match(source, /analyticsData: \{\s*scope: 'auto-insert-segment'\s*\}/);

  const windowCaptureStart = lifecycleSource.indexOf('function handleNativeArrowSuppress');
  const windowCaptureEnd = lifecycleSource.indexOf('if (isRightShiftSegmentNavigationShortcut', windowCaptureStart);
  const windowCaptureBlock = lifecycleSource.slice(windowCaptureStart, windowCaptureEnd);
  assert.match(windowCaptureBlock, /event\.altKey &&[\s\S]*!event\.shiftKey &&[\s\S]*event\.code === 'KeyC'/);

  assert.match(source, /helper\.handleCutPreviewKeyup = function handleCutPreviewKeyup\(event\)/);
  assert.match(source, /helper\.state\.autoInsertSegmentHotkeyHandledAt = Date\.now\(\)/);
  assert.match(source, /Date\.now\(\) - lastHandledAt < 700/);
  assert.match(lifecycleSource, /function handleGlobalKeyup\(event\)/);
  assert.match(lifecycleSource, /helper\.handleCutPreviewKeyup\(event\)/);
  assert.match(lifecycleSource, /function handleExtensionCommandMessage\(message, _sender, sendResponse\)/);
  assert.match(lifecycleSource, /message\.command !== 'auto-insert-segment'/);
  assert.match(lifecycleSource, /helper\.runtime\.ensureSessionRuntime\('command:auto-insert-segment'\)/);
  assert.match(lifecycleSource, /helper\.autoInsertSegmentAtCaret\(\)/);
});

test('automatic segment insertion scans visible lanes within one second and trims created rows', () => {
  const serviceSource = read('../src/services/timeline-selection-service.ts');
  const bridgeSource = read('../src/content/magnifier-bridge.ts');

  assert.match(serviceSource, /AUTO_INSERT_SEGMENT_SCAN_WINDOW_SECONDS = 1\b/);
  assert.match(serviceSource, /AUTO_INSERT_SEGMENT_PROVISIONAL_PADDING_SECONDS = 0\.05\b/);
  assert.match(serviceSource, /AUTO_INSERT_SEGMENT_MERGE_WINDOW_SECONDS = 1\b/);
  assert.doesNotMatch(serviceSource, /function getDomSpeakerKeyFromLaneRow/);
  assert.doesNotMatch(serviceSource, /function getDomSpeakerKeyForContainer/);
  assert.doesNotMatch(serviceSource, /getSingleSpeakerKeyFromText/);
  assert.doesNotMatch(serviceSource, /textContent\.replace\([\s\S]*Speaker\\s\+\\d/);
  assert.match(serviceSource, /async function collectAutoInsertSegmentLaneTargets\(\)/);
  assert.match(serviceSource, /for \(const container of discoverWaveformContainers\(\)\)/);
  assert.match(serviceSource, /callSelectionBridge\('resolve-visible-lane-targets'/);
  assert.match(serviceSource, /const processedRecordingId =[\s\S]*resolvedLane\.processedRecordingId/);
  assert.match(serviceSource, /callSelectionBridge\('find-nearest-speech-island'/);
  assert.match(serviceSource, /scanWindowSeconds: AUTO_INSERT_SEGMENT_SCAN_WINDOW_SECONDS/);
  assert.match(serviceSource, /paddingSeconds: AUTO_INSERT_SEGMENT_PROVISIONAL_PADDING_SECONDS/);
  const islandRequestStart = serviceSource.indexOf('async function requestNearestSpeechIslandForLane');
  const islandRequestEnd = serviceSource.indexOf('function findAutoInsertCreatedRow', islandRequestStart);
  const islandRequestBlock = serviceSource.slice(islandRequestStart, islandRequestEnd);
  assert.ok(islandRequestStart >= 0 && islandRequestEnd > islandRequestStart, 'expected auto-insert island request block');
  assert.doesNotMatch(islandRequestBlock, /paddingSeconds: AUDIO_TRIM_PADDING_SECONDS/);
  assert.match(bridgeSource, /function resolveVisibleLaneTargets\(lanes\)/);
  assert.match(bridgeSource, /function normalizeNearestSpeechIslandRange/);
  assert.match(bridgeSource, /clamp\(Number\(paddingSeconds\) \|\| 0, 0, 1\)/);
  assert.match(bridgeSource, /const trackProps = getTrackPropsForHost\(host\)/);
  assert.match(bridgeSource, /track\.processedRecordingId != null/);
  assert.match(bridgeSource, /operation === 'resolve-visible-lane-targets'/);
  assert.match(serviceSource, /helper\.autoInsertSegmentAtCaret = async function autoInsertSegmentAtCaret\(\)/);
  assert.match(serviceSource, /helper\.createSegmentWithNativeAction\(\{/);
  assert.match(serviceSource, /processedRecordingId: target\.trackId/);
  assert.match(serviceSource, /createResult\.verification/);
  const createdRowStart = serviceSource.indexOf('function findAutoInsertCreatedRow');
  const createdRowEnd = serviceSource.indexOf('function buildAutoInsertTrimTarget', createdRowStart);
  const createdRowBlock = serviceSource.slice(createdRowStart, createdRowEnd);
  assert.ok(createdRowStart >= 0 && createdRowEnd > createdRowStart, 'expected created row lookup helper');
  assert.match(createdRowBlock, /target\.trackLabel/);
  assert.match(createdRowBlock, /target\.speakerKey/);
  assert.ok(
    createdRowBlock.indexOf('target.trackLabel') < createdRowBlock.indexOf('target.speakerKey'),
    'created row lookup should prefer the visible lane label used by transcript rows'
  );
  const autoInsertStart = serviceSource.indexOf('helper.autoInsertSegmentAtCaret = async function autoInsertSegmentAtCaret()');
  const autoInsertEnd = serviceSource.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()', autoInsertStart);
  const autoInsertBlock = serviceSource.slice(autoInsertStart, autoInsertEnd);
  assert.match(autoInsertBlock, /trimSegmentTarget\(trimTarget, trimOptions\)/);
  assert.match(autoInsertBlock, /progressLabel: 'Trimming inserted segment'/);
  assert.match(autoInsertBlock, /mergeAutoInsertAdjacentRows\(trimTarget\.row\)/);
  assert.match(autoInsertBlock, /if \(trimResult && trimResult\.ok\)/);
  assert.doesNotMatch(autoInsertBlock, /followupTrimResult/);
  assert.doesNotMatch(autoInsertBlock, /followupTrimTarget/);
  assert.doesNotMatch(autoInsertBlock, /amplitudeThreshold: AUTO_SEGMENT_STRUCTURAL_SILENCE_THRESHOLD/);

  const trimTargetStart = serviceSource.indexOf('function buildAutoInsertTrimTarget');
  const trimTargetEnd = serviceSource.indexOf('function getAutoSegmentRowActionSnapshot', trimTargetStart);
  const trimTargetBlock = serviceSource.slice(trimTargetStart, trimTargetEnd);
  assert.ok(trimTargetStart >= 0 && trimTargetEnd > trimTargetStart, 'expected auto-insert trim target builder');
  assert.match(trimTargetBlock, /const rowSpeakerKey = helper\.getRowSpeakerKey\(row\)/);
  assert.match(trimTargetBlock, /speakerKey: rowSpeakerKey/);
  assert.match(trimTargetBlock, /rememberTimelineSegmentTarget\(row, trimTarget\.container, trimTarget\.entry, rowSpeakerKey\)/);
  assert.doesNotMatch(trimTargetBlock, /target\.trackId \|\| target\.speakerKey/);
});

test('automatic segment insertion merges adjacent same-speaker rows within one second after trim', () => {
  const serviceSource = read('../src/services/timeline-selection-service.ts');
  const start = serviceSource.indexOf('function findAutoInsertAdjacentMergePlan');
  const end = serviceSource.indexOf('function getAutoSegmentRowActionSnapshot', start);
  const block = serviceSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'expected auto-insert adjacent merge helper');
  assert.match(block, /AUTO_INSERT_SEGMENT_MERGE_WINDOW_SECONDS/);
  assert.match(block, /getAutoSegmentRowActionSnapshot\(row\)/);
  assert.match(block, /helper\s*\.\s*getTranscriptRows\(\)/);
  assert.match(block, /candidate\.speakerKey === current\.speakerKey/);
  assert.match(block, /leftGapSeconds <= AUTO_INSERT_SEGMENT_MERGE_WINDOW_SECONDS/);
  assert.match(block, /rightGapSeconds <= AUTO_INSERT_SEGMENT_MERGE_WINDOW_SECONDS/);
  assert.match(block, /direction: 'above'/);
  assert.match(block, /direction: 'below'/);
  assert.match(block, /helper\.mergeSegmentWithNativeAction\(\{/);
});

test('automatic segment insertion focuses the final row at the inserted text boundary', () => {
  const serviceSource = read('../src/services/timeline-selection-service.ts');
  const autoInsertStart = serviceSource.indexOf('helper.autoInsertSegmentAtCaret = async function autoInsertSegmentAtCaret()');
  const autoInsertEnd = serviceSource.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()', autoInsertStart);
  const autoInsertBlock = serviceSource.slice(autoInsertStart, autoInsertEnd);
  const mergeStart = serviceSource.indexOf('async function mergeAutoInsertAdjacentRows');
  const mergeEnd = serviceSource.indexOf('function getAutoSegmentRowActionSnapshot', mergeStart);
  const mergeBlock = serviceSource.slice(mergeStart, mergeEnd);
  const focusStart = serviceSource.indexOf('function focusAutoInsertResultRow');
  const focusEnd = serviceSource.indexOf('function getAutoSegmentRowActionSnapshot', focusStart);
  const focusBlock = serviceSource.slice(focusStart, focusEnd);

  assert.ok(autoInsertStart >= 0 && autoInsertEnd > autoInsertStart, 'expected auto-insert method');
  assert.ok(mergeStart >= 0 && mergeEnd > mergeStart, 'expected auto-insert merge helper');
  assert.ok(focusStart >= 0 && focusEnd > focusStart, 'expected auto-insert focus helper');
  assert.match(autoInsertBlock, /focusAutoInsertResultRow\(trimTarget\.row, mergeResult\)/);
  assert.match(mergeBlock, /caretPosition = 'start'/);
  assert.match(mergeBlock, /caretPosition = 'end'/);
  assert.match(mergeBlock, /caretPosition = 'offset'/);
  assert.match(mergeBlock, /caretOffset = leftTextLength/);
  assert.match(focusBlock, /helper\.focusRow\(row, \{/);
  assert.match(focusBlock, /activateRow: false/);
  assert.match(focusBlock, /selectionStart: caretOffset/);
  assert.match(focusBlock, /selectionEnd: caretOffset/);
});

test('automatic segment insertion has no temporary floating button or debug event plumbing', () => {
  const serviceSource = read('../src/services/timeline-selection-service.ts');
  const start = serviceSource.indexOf('helper.autoInsertSegmentAtCaret = async function autoInsertSegmentAtCaret()');
  const end = serviceSource.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()', start);
  const block = serviceSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'expected automatic segment insertion method');
  assert.doesNotMatch(serviceSource, /AUTO_INSERT_SEGMENT_BUTTON_ID/);
  assert.doesNotMatch(serviceSource, /autoInsertSegmentButton/);
  assert.doesNotMatch(serviceSource, /ensureAutoInsertSegmentButton/);
  assert.doesNotMatch(serviceSource, /handleAutoInsertSegmentButtonClick/);
  assert.doesNotMatch(serviceSource, /babel-helper-auto-insert-segment-debug/);
  assert.doesNotMatch(serviceSource, /emitAutoInsertSegmentDebug/);
  assert.doesNotMatch(block, /laneDiagnostics/);
  assert.match(block, /return \{\s*ok: false,\s*reason: 'auto-segmentation-pending'/);
  assert.match(block, /return \{\s*ok: false,\s*reason: 'missing-create-action'/);
  assert.match(block, /return \{\s*ok: false,\s*reason: 'missing-visible-lanes'/);
});

test('automatic segment insertion bridge finds nearest uncovered speech island from rendered peaks first', () => {
  const bridgeSource = read('../src/content/magnifier-bridge.ts');
  const start = bridgeSource.indexOf('function findNearestSpeechIslandForResolvedWave');
  const end = bridgeSource.indexOf('function findTrimTargetsForResolvedWave', start);
  const block = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'expected nearest speech island bridge function');
  assert.ok(
    block.indexOf('const rawPeaks = getRawExportPeaks(wave)') <
      block.indexOf('const decoded = getDecodedAudioChannelsForTrim(wave)'),
    'rendered/exported peaks must be checked before decoded full audio'
  );
  assert.match(block, /hasRegionCoveringTime\(regions, caretSeconds\)/);
  assert.match(block, /reason: 'covered-at-caret'/);
  assert.match(block, /hasRegionOverlap\(regions, targetStartSeconds, targetEndSeconds\)/);
  assert.match(block, /reason: 'covered-candidate'/);
  assert.match(bridgeSource, /leftDistance <= rightDistance/);
  assert.match(bridgeSource, /operation === 'find-nearest-speech-island'/);
  assert.match(bridgeSource, /const hostResolved = resolveWaveForHost\(hostMarker\)/);
  assert.match(bridgeSource, /if \(hostResolved\.wave && isUsableWaveCandidate\(hostResolved\.wave, hostResolved\.host\)\)/);
  assert.match(bridgeSource, /typeof existingBridge\.findNearestSpeechIsland === 'function'/);
  assert.match(bridgeSource, /findNearestSpeechIsland: findNearestSpeechIslandForResolvedWave/);
  assert.match(bridgeSource, /track\.processedRecordingId != null/);
});

test('automatic segment insertion creates native empty transcription segments through React onCreateAnnotation', () => {
  const timestampServiceSource = read('../src/services/timestamp-edit-service.ts');
  const timestampBridgeSource = read('../src/content/timestamp-bridge.ts');

  assert.match(timestampServiceSource, /helper\.createSegmentWithNativeAction = async function createSegmentWithNativeAction/);
  assert.match(timestampServiceSource, /callTimestampBridge\('create-segment'/);
  assert.match(timestampServiceSource, /processedRecordingId: settings\.processedRecordingId/);

  assert.match(timestampBridgeSource, /function resolveCreateAnnotationBinding/);
  assert.match(timestampBridgeSource, /typeof props\.onCreateAnnotation === 'function'/);
  assert.match(timestampBridgeSource, /onCreateAnnotation\(\{/);
  assert.match(timestampBridgeSource, /type: 'transcription'/);
  assert.match(timestampBridgeSource, /content: ''/);
  assert.match(timestampBridgeSource, /processedRecordingId/);
  assert.match(timestampBridgeSource, /startTimeInSeconds/);
  assert.match(timestampBridgeSource, /endTimeInSeconds/);
  assert.match(timestampBridgeSource, /operation === 'create-segment'/);
  assert.match(timestampBridgeSource, /typeof existingBridge\.createSegment === 'function'/);
});

test('automatic segment insertion trim moves created annotation boundaries by row identity', () => {
  const timelineSource = read('../src/services/timeline-selection-service.ts');
  const timestampServiceSource = read('../src/services/timestamp-edit-service.ts');

  const moveStart = timelineSource.indexOf('async function moveSegmentBoundary');
  const moveEnd = timelineSource.indexOf('function getCurrentMoveLabels', moveStart);
  const moveBlock = timelineSource.slice(moveStart, moveEnd);
  assert.ok(moveStart >= 0 && moveEnd > moveStart, 'expected segment boundary move helper');
  assert.match(moveBlock, /async function moveSegmentBoundary\(side, labels, speakerKey, targetSeconds, row\)/);
  assert.match(moveBlock, /const rowIdentity =[\s\S]*helper\.getRowIdentity\(row\)/);
  assert.match(moveBlock, /annotationId:[\s\S]*rowIdentity\.annotationId/);
  assert.match(moveBlock, /rowIdentity/);
  assert.match(moveBlock, /startSeconds: parseTimeValue\(labels\.startText\)/);
  assert.match(moveBlock, /endSeconds: parseTimeValue\(labels\.endText\)/);

  const inwardStart = timelineSource.indexOf('async function applyInwardTrimToRow');
  const inwardEnd = timelineSource.indexOf('async function requestTrimTargetsForRow', inwardStart);
  const inwardBlock = timelineSource.slice(inwardStart, inwardEnd);
  assert.match(inwardBlock, /moveSegmentBoundary\('right', labels, speakerKey, nextEndSeconds, row\)/);
  assert.match(inwardBlock, /moveSegmentBoundary\('left', getCurrentMoveLabels\(row, labels\), speakerKey, nextStartSeconds, row\)/);

  const trimStart = timelineSource.indexOf('async function trimSegmentTarget');
  const trimEnd = timelineSource.indexOf('helper.transcribeCurrentSegmentWithPromptApi', trimStart);
  const trimBlock = timelineSource.slice(trimStart, trimEnd);
  assert.match(trimBlock, /moveSegmentBoundary\('right', labels, speakerKey, cappedExtendEndSeconds, row\)/);
  assert.match(trimBlock, /moveSegmentBoundary\('left', getCurrentMoveLabels\(row, labels\), speakerKey, cappedExtendStartSeconds, row\)/);

  const setBoundaryStart = timestampServiceSource.indexOf('helper.setSegmentBoundaryTime = async function setSegmentBoundaryTime');
  const setBoundaryEnd = timestampServiceSource.indexOf('helper.splitSegmentAtTime = async function splitSegmentAtTime', setBoundaryStart);
  const setBoundaryBlock = timestampServiceSource.slice(setBoundaryStart, setBoundaryEnd);
  assert.ok(setBoundaryStart >= 0 && setBoundaryEnd > setBoundaryStart, 'expected timestamp boundary setter');
  assert.match(setBoundaryBlock, /helper\.findRowByIdentity[\s\S]*settings\.rowIdentity/);
  assert.ok(
    setBoundaryBlock.indexOf('helper.findRowByIdentity') < setBoundaryBlock.indexOf('findRowByTimeLabels'),
    'row identity lookup must run before label lookup'
  );
  assert.match(setBoundaryBlock, /annotationId:[\s\S]*settings\.annotationId[\s\S]*rowIdentity\.annotationId/);
  assert.match(setBoundaryBlock, /rowIdentity/);
  assert.match(setBoundaryBlock, /startSeconds: settings\.startSeconds/);
  assert.match(setBoundaryBlock, /endSeconds: settings\.endSeconds/);
});

test('current segment transcription updates simple progress from streamed bridge packets', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const bridgeCallStart = source.indexOf('async function callSelectionBridge(operation, payload, options)');
  const bridgeCallEnd = source.indexOf('function getWaveformHostFromContainer', bridgeCallStart);
  const bridgeCallBlock = source.slice(bridgeCallStart, bridgeCallEnd);
  const transcribeStart = source.indexOf('helper.transcribeCurrentSegmentWithPromptApi = async function transcribeCurrentSegmentWithPromptApi()');
  const transcribeEnd = source.indexOf('helper.trimCurrentSegmentToAudio = async function trimCurrentSegmentToAudio', transcribeStart);
  const transcribeBlock = source.slice(transcribeStart, transcribeEnd);
  const progressStart = source.indexOf('function updateCurrentSegmentTranscriptionProgress(progress, range)');
  const progressEnd = source.indexOf('function parseSecondsLabel', progressStart);
  const progressBlock = source.slice(progressStart, progressEnd);

  assert.ok(bridgeCallStart >= 0 && bridgeCallEnd > bridgeCallStart, 'expected selection bridge helper');
  assert.match(bridgeCallBlock, /const onProgress = options && typeof options\.onProgress === 'function' \? options\.onProgress : null/);
  assert.match(bridgeCallBlock, /if \(detail\.progress\)/);
  assert.match(bridgeCallBlock, /if \(onProgress\)/);
  assert.match(bridgeCallBlock, /onProgress\(detail\.progress\)/);

  assert.match(source, /function updateCurrentSegmentTranscriptionProgress\(progress, range\)/);
  assert.match(progressBlock, /generatedCharCount/);
  assert.match(progressBlock, /estimatedCharCount/);
  assert.match(progressBlock, /percent,/);
  assert.match(progressBlock, /detail/);
  assert.match(transcribeBlock, /callSelectionBridge\([\s\S]*'transcribe-segment-audio'[\s\S]*onProgress: \(progress\) => updateCurrentSegmentTranscriptionProgress\(progress, range\)/);
  assert.match(transcribeBlock, /const text = normalizeAutoSegmentRedistributionText\(bridgeResult\.text\)/);
  assert.match(transcribeBlock, /helper\.setEditableValue\(textarea, text\)/);
});

test('current segment transcription bridge streams full speaker segment audio and asks for Russian text', () => {
  const bridgeSource = read('../src/content/magnifier-bridge.ts');
  const start = bridgeSource.indexOf('async function transcribeSegmentAudio(payload, onProgress)');
  const end = bridgeSource.indexOf('function indexToSeconds', start);
  const block = bridgeSource.slice(start, end);

  assert.match(bridgeSource, /const AUTO_SEGMENT_TRANSCRIBE_SESSION_OPTIONS = \{/);
  assert.doesNotMatch(bridgeSource, /AUTO_SEGMENT_TRANSCRIBE_MAX_AUDIO_SECONDS/);
  assert.match(bridgeSource, /maxAudioSeconds === null\s*\?\s*Infinity/);
  assert.match(bridgeSource, /Напиши точный текст, сказанный в аудио/);
  assert.ok(start >= 0 && end > start, 'expected bridge transcription function');
  assert.match(block, /const model = await getPromptApiLanguageModel\(AUTO_SEGMENT_TRANSCRIBE_SESSION_OPTIONS\)/);
  assert.match(block, /resolveWaveForVisibleSpeaker\(speakerKey\)/);
  assert.match(block, /getDecodedAudioChannelsForTrim\(wave\)/);
  assert.match(block, /createAutoSegmentPromptAudioBuffer\(decoded, segment, null\)/);
  assert.match(block, /typeof session\.promptStreaming === 'function'/);
  assert.match(block, /const stream = session\.promptStreaming\(buildSegmentTranscriptionPromptMessages\(audioBuffer\)\)/);
  assert.match(block, /for await \(const chunk of stream\)/);
  assert.match(block, /appendPromptStreamChunk\(text, chunk\)/);
  assert.match(block, /emitSegmentTranscriptionProgress\(onProgress, \{/);
  assert.match(block, /generatedCharCount: normalizeAutoSegmentPromptText\(text\)\.length/);
  assert.match(block, /estimatedCharCount/);
  assert.match(block, /session\.destroy\(\)/);
  assert.match(bridgeSource, /function respondProgress\(id, progress\)/);
  assert.match(bridgeSource, /operation === 'transcribe-segment-audio'/);
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
  const mergeIndex = autoBlock.indexOf('const mergeResult = await mergeAutoSegmentCloseRows');
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

  assert.match(source, /async function mergeAutoSegmentCloseRows\(options\)/);
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

test('auto-segmentation keeps one staged interactive progress bar across all phases', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const autoStart = source.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()');
  const autoEnd = source.indexOf('async function trimSegmentTarget', autoStart);
  const autoBlock = source.slice(autoStart, autoEnd);
  const trimStart = source.indexOf('helper.trimAllSegmentsToAudio = async function trimAllSegmentsToAudio');
  const trimEnd = source.indexOf('function getRegionBounds', trimStart);
  const trimBlock = source.slice(trimStart, trimEnd);

  assert.match(source, /function updateAutoSegmentProgress\(\{/);
  assert.match(source, /AUTO_SEGMENT_PROGRESS_PHASES/);
  assert.match(source, /percentBase/);
  assert.match(source, /percentSpan/);
  assert.match(source, /detail/);

  assert.match(autoBlock, /updateAutoSegmentProgress\(\{\s*phase: 'prepare'/);
  assert.match(autoBlock, /prepareAutoSegmentTextRedistributionSession\(\)/);
  assert.match(autoBlock, /progressLabel: 'Pre-trimming visible segments'/);
  assert.match(autoBlock, /keepProgress: true/);
  assert.match(autoBlock, /progressPhase: 'preTrim'/);
  assert.match(autoBlock, /const mergeResult = await mergeAutoSegmentCloseRows\(\{\s*progressPhase: 'merge'/);
  assert.match(autoBlock, /updateAutoSegmentProgress\(\{\s*phase: 'silence'/);
  assert.match(autoBlock, /detail: 'Detected ' \+ silenceRunCount \+ ' silence runs'/);
  assert.match(autoBlock, /updateAutoSegmentProgress\(\{\s*phase: 'split'/);
  assert.match(autoBlock, /detail: 'Created ' \+ splitCount \+ ' splits'/);
  assert.match(autoBlock, /progressLabel: 'Post-trimming segmented draft'/);
  assert.match(autoBlock, /progressPhase: 'postTrim'/);
  assert.match(autoBlock, /const silentCleanupResult = await cleanupAutoSegmentSilentRows\(\{\s*progressPhase: 'cleanup'/);
  assert.match(autoBlock, /const redistributionResult = await redistributeAutoSegmentTextWithPromptApi\(textBaselineGroups, \{\s*progressPhase: 'alignText'/);
  assert.match(autoBlock, /updateAutoSegmentProgress\(\{\s*phase: 'complete'/);

  assert.match(trimBlock, /const keepProgress = Boolean\(options && options\.keepProgress\)/);
  assert.match(trimBlock, /updateAutoSegmentProgress\(\{\s*phase: progressPhase/);
  assert.match(trimBlock, /if \(!keepProgress\) \{\s*dismissLongTaskProgress\(\)/);
});

test('auto-segmentation merge pass compares consecutive rows per speaker lane', () => {
  const source = read('../src/services/timeline-selection-service.ts');
  const start = source.indexOf('function collectAutoSegmentMergePlans()');
  const end = source.indexOf('async function mergeAutoSegmentCloseRows', start);
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

  assert.match(source, /async function cleanupAutoSegmentSilentRows\(options\)/);
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

  const cleanupIndex = autoBlock.indexOf('const silentCleanupResult = await cleanupAutoSegmentSilentRows');
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
  assert.match(source, /async function redistributeAutoSegmentTextWithPromptApi\(baselineGroups, options\)/);
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

  const cleanupIndex = autoBlock.indexOf('const silentCleanupResult = await cleanupAutoSegmentSilentRows');
  const baselineIndex = autoBlock.indexOf('const textBaselineGroups = collectAutoSegmentTextBaselineGroups()');
  const redistributionIndex = autoBlock.indexOf('const redistributionResult = await redistributeAutoSegmentTextWithPromptApi(textBaselineGroups');
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
  assert.match(autoBlock, /const silentCleanupResult = await cleanupAutoSegmentSilentRows\(\{[\s\S]*?progressPhase: 'cleanup'[\s\S]*?\}\)\.catch\(\(error\) =>\s*createAutoSegmentCleanupFailureResult\(error\)\s*\)/);
  assert.match(autoBlock, /const redistributionResult = await redistributeAutoSegmentTextWithPromptApi\(textBaselineGroups, \{[\s\S]*?progressPhase: 'alignText'[\s\S]*?\}\)\.catch\(\(error\) =>\s*createAutoSegmentRedistributionFailureResult\(error\)\s*\)/);
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
