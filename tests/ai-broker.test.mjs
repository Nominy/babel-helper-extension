import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relPath) {
  return fs.readFileSync(new URL('../' + relPath, import.meta.url), 'utf8');
}

test('Gold Drafting AI broker client discovers Gold by DOM marker and sends external messages', () => {
  const source = read('src/services/gold-drafting-ai-broker.ts');

  assert.match(source, /AI_BROKER_EXTENSION_ID_ATTR = 'data-babel-gold-drafting-extension-id'/);
  assert.match(source, /GOLD_DRAFTING_PRODUCTION_EXTENSION_ID = 'difidgnhacblcogknnfbeedghjpccohh'/);
  assert.match(source, /AI_BROKER_CLIENT_BUILD = 'port-stream-postmortem-/);
  assert.match(source, /data-babel-helper-ai-broker-build/);
  assert.match(source, /AI_BROKER_PORT_NAME = 'babel-gold-drafting:ai-broker-port'/);
  assert.match(source, /document\.documentElement\.getAttribute\(AI_BROKER_EXTENSION_ID_ATTR\)/);
  assert.match(source, /return extensionId \|\| GOLD_DRAFTING_PRODUCTION_EXTENSION_ID/);
  assert.match(source, /chrome\.runtime\.connect\(extensionId, \{ name: AI_BROKER_PORT_NAME \}\)/);
  assert.match(source, /port\.onMessage\.addListener/);
  assert.match(source, /if \(message\.type === 'event'\)/);
  assert.match(source, /backend-waiting/);
  assert.match(source, /GOLD_DRAFTING_BROKER_PORT_IDLE_TIMEOUT_MS = 20000/);
  assert.match(source, /function resetGoldDraftingBrokerPortIdleTimeout/);
  assert.match(source, /gold-drafting-broker-port-idle-timeout/);
  assert.match(source, /fallbackAllowed/);
});

test('Gold Drafting AI broker client keeps sendMessage as a fallback only', () => {
  const source = read('src/services/gold-drafting-ai-broker.ts');
  const connectStart = source.indexOf('async function requestGoldDraftingAiBrokerViaPort');
  const fallbackStart = source.indexOf('async function requestGoldDraftingAiBrokerViaMessage');
  const publicStart = source.indexOf('export async function requestGoldDraftingAiBroker');
  const publicBlock = source.slice(publicStart);

  assert.ok(connectStart >= 0, 'expected port broker helper');
  assert.ok(fallbackStart >= 0, 'expected message fallback helper');
  assert.ok(connectStart < fallbackStart, 'port path should be primary');
  assert.match(publicBlock, /if \(canUseGoldDraftingAiBrokerPort\(\)\)/);
  assert.match(publicBlock, /return requestGoldDraftingAiBrokerViaPort\(extensionId, payload, options\)/);
  assert.match(publicBlock, /return requestGoldDraftingAiBrokerViaMessage\(extensionId, payload\)/);
});

test('Gold Drafting AI broker client logs exact failure details to the page console', () => {
  const source = read('src/services/gold-drafting-ai-broker.ts');

  assert.match(source, /function reportGoldDraftingAiBrokerFailure/);
  assert.match(source, /function getGoldDraftingBrokerFailureReason/);
  assert.match(source, /gold-drafting-broker-empty-error-response/);
  assert.match(source, /console\.error\('\[Babel Helper\] Gold Drafting AI broker failed'/);
  assert.match(source, /operation: payload\.operation/);
  assert.match(source, /extensionId/);
  assert.match(source, /fallbackAllowed/);
});

test('Gold Drafting AI broker waits long enough for remote transcription before timing out', () => {
  const source = read('src/services/gold-drafting-ai-broker.ts');

  assert.doesNotMatch(source, /AI_BROKER_TIMEOUT_MS = 1200/);
  assert.match(source, /TRANSCRIBE_SEGMENT_BROKER_TIMEOUT_MS = 300000/);
  assert.match(source, /REDISTRIBUTE_TEXT_BROKER_TIMEOUT_MS = 120000/);
  assert.match(source, /function getGoldDraftingAiBrokerTimeoutMs/);
  assert.match(source, /payload\.operation === 'transcribeSegment' \|\| payload\.operation === 'transcribeSegmentL0'/);
  assert.match(source, /payload\.operation === 'redistributeText'/);
  assert.match(source, /message: `Gold Drafting AI broker timed out after \$\{timeoutMs\}ms\.`/);
});

test('current segment transcription prefers free L0 and retains legacy model fallback', () => {
  const source = read('src/services/timeline-selection-service.ts');
  const segmentSource = read('src/services/l0-segment-transcription.ts');
  const methodStart = source.indexOf('helper.transcribeCurrentSegmentWithL0 = async function transcribeCurrentSegmentWithL0()');
  const methodEnd = source.indexOf('helper.trimCurrentSegmentToAudio = async function trimCurrentSegmentToAudio', methodStart);
  const block = source.slice(methodStart, methodEnd);

  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'expected current segment transcription method');
  assert.match(segmentSource, /operation: 'transcribeSegmentL0'/);
  assert.match(block, /requestGoldDraftingAiBroker/);
  assert.match(block, /onEvent: \(event\) => updateL0SegmentTranscriptionProgress\(event, range\)/);
  assert.match(block, /buildCurrentL0TimingTaskId\(helper\)/);
  assert.match(block, /transcribeCurrentSegmentWithLegacyModel\(\)/);
  assert.doesNotMatch(block, /operation: 'transcribeSegment'/);
  assert.doesNotMatch(block, /transcribe-segment-audio|callSelectionBridge|OpenRouter|Gemini|Prompt/);
});

test('auto-segmentation waits for current L0 timing before mutating segments', () => {
  const source = read('src/services/timeline-selection-service.ts');
  const autoStart = source.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()');
  const waitIndex = source.indexOf('await waitForAutoSegmentL0Timing()', autoStart);
  const preTrimIndex = source.indexOf('const preTrimResult = await helper.trimAllSegmentsToAudio', autoStart);

  assert.ok(autoStart >= 0, 'expected auto-segmentation method');
  assert.ok(waitIndex > autoStart, 'expected L0 timing wait');
  assert.ok(preTrimIndex > waitIndex, 'timing must arrive before segment mutation');
  assert.match(source.slice(autoStart, preTrimIndex), /Waiting for background word timing/);
  assert.match(source.slice(autoStart, preTrimIndex), /timingWaitResult\.timingIndex/);
});

test('auto-segmentation redistributes text from L0 timings without AI review', () => {
  const source = read('src/services/timeline-selection-service.ts');
  const methodStart = source.indexOf('async function redistributeAutoSegmentTextWithL0Timing');
  const methodEnd = source.indexOf('async function redistributeAutoSegmentTextWithLegacyModels', methodStart);
  const block = source.slice(methodStart, methodEnd);

  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'expected timed redistribution method');
  assert.match(block, /createL0TimedAutoSegmentTextAllocations/);
  assert.match(block, /timingTrack\.tokens/);
  assert.match(block, /source: 'l0-word-timing'/);
  assert.doesNotMatch(block, /requestGoldDraftingAiBroker/);
  assert.doesNotMatch(block, /prepareAutoSegmentTextRedistributionSession/);
  assert.doesNotMatch(block, /auto-segment-redistribute-text/);
  assert.match(source, /async function redistributeAutoSegmentTextWithLegacyModels/);
  assert.match(source, /operation: 'redistributeText'/);
  assert.match(source, /auto-segment-redistribute-text/);
});
