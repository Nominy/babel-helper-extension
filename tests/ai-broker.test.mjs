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
  assert.match(source, /payload\.operation === 'transcribeSegment'/);
  assert.match(source, /payload\.operation === 'redistributeText'/);
  assert.match(source, /message: `Gold Drafting AI broker timed out after \$\{timeoutMs\}ms\.`/);
});

test('current segment transcription tries Gold remote broker before local Gemini Nano fallback', () => {
  const source = read('src/services/timeline-selection-service.ts');
  const methodStart = source.indexOf('helper.transcribeCurrentSegmentWithPromptApi = async function transcribeCurrentSegmentWithPromptApi()');
  const methodEnd = source.indexOf('helper.trimCurrentSegmentToAudio = async function trimCurrentSegmentToAudio', methodStart);
  const block = source.slice(methodStart, methodEnd);

  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'expected current segment transcription method');
  assert.match(block, /requestGoldDraftingAiBroker\(\s*\{\s*operation: 'transcribeSegment'/);
  assert.match(block, /if \(brokerResult && brokerResult\.ok\)/);
  assert.match(block, /if \(brokerResult && !brokerResult\.ok && brokerResult\.fallbackAllowed === false\)/);
  assert.doesNotMatch(block, /if \(brokerResult && !brokerResult\.fallbackAllowed\)/);
  assert.match(block, /callSelectionBridge\(\s*'transcribe-segment-audio'/);
});

test('current segment transcription shows Gold remote progress before falling back local', () => {
  const source = read('src/services/timeline-selection-service.ts');
  const methodStart = source.indexOf('helper.transcribeCurrentSegmentWithPromptApi = async function transcribeCurrentSegmentWithPromptApi()');
  const methodEnd = source.indexOf('helper.trimCurrentSegmentToAudio = async function trimCurrentSegmentToAudio', methodStart);
  const block = source.slice(methodStart, methodEnd);

  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'expected current segment transcription method');
  assert.match(block, /phase: 'starting-remote-broker'/);
  assert.match(block, /onEvent: \(event\) => updateGoldDraftingBrokerProgress\(event, range\)/);
  assert.match(source, /Starting Gold Drafting remote model\.\.\./);
  assert.match(source, /formatBrokerWaitDuration/);
  assert.match(source, /Waiting for OpenRouter\.\.\. \$\{formatBrokerWaitDuration/);
});

test('current segment transcription keeps Gold broker failure visible when remote path dies', () => {
  const source = read('src/services/timeline-selection-service.ts');
  const methodStart = source.indexOf('helper.transcribeCurrentSegmentWithPromptApi = async function transcribeCurrentSegmentWithPromptApi()');
  const methodEnd = source.indexOf('helper.trimCurrentSegmentToAudio = async function trimCurrentSegmentToAudio', methodStart);
  const block = source.slice(methodStart, methodEnd);

  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'expected current segment transcription method');
  assert.match(source, /function showGoldDraftingBrokerFailure/);
  assert.match(source, /Gold Drafting remote model failed/);
  assert.match(source, /progress\.fill\.style\.background = '#dc2626'/);
  assert.match(source, /function serializeGoldDraftingBrokerFailure/);
  assert.match(source, /Details: /);
  assert.match(source, /data-babel-helper-gold-drafting-broker-failure-details/);
  assert.doesNotMatch(source, /Reason: ' \+ reason \+ '\. Check the console for the full broker response\.'/);
  assert.match(block, /let brokerFailure = null/);
  assert.match(block, /brokerFailure = brokerResult/);
  assert.match(block, /showGoldDraftingBrokerFailure\(brokerFailure, 'Gold Drafting remote transcription'\)/);
  assert.match(block, /keepTroubleshootingProgress = true/);
});

test('auto-segmentation text redistribution tries Gold broker review before local Prompt API review', () => {
  const source = read('src/services/timeline-selection-service.ts');
  const methodStart = source.indexOf('async function redistributeAutoSegmentTextWithPromptApi');
  const methodEnd = source.indexOf('const finalDetail =', methodStart);
  const block = source.slice(methodStart, methodEnd);

  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'expected redistribution method');
  assert.match(block, /requestGoldDraftingAiBroker\(\s*\{\s*operation: 'redistributeText'/);
  assert.match(block, /groups: remoteReviewGroups/);
  assert.match(block, /brokerResult && brokerResult\.ok && Array\.isArray\(brokerResult\.results\)/);
  assert.match(block, /if \(brokerResult && !brokerResult\.ok && brokerResult\.fallbackAllowed === false\)/);
  assert.doesNotMatch(block, /if \(brokerResult && !brokerResult\.fallbackAllowed\)/);
  assert.match(block, /callSelectionBridge\('auto-segment-redistribute-text'/);
});

test('auto-segmentation sends one server-side grouped Gold broker text review request before ordered apply', () => {
  const source = read('src/services/timeline-selection-service.ts');
  const methodStart = source.indexOf('async function redistributeAutoSegmentTextWithPromptApi');
  const methodEnd = source.indexOf('const finalDetail =', methodStart);
  const block = source.slice(methodStart, methodEnd);
  const remoteRunIndex = block.indexOf('const brokerResult = remoteReviewGroups.length');
  const applyLoopIndex = block.indexOf('for (const job of redistributionJobs)');

  assert.ok(methodStart >= 0 && methodEnd > methodStart, 'expected redistribution method');
  assert.doesNotMatch(source, /GOLD_DRAFTING_REMOTE_REVIEW_CONCURRENCY/);
  assert.doesNotMatch(source, /runGoldDraftingRemoteReviewJobsWithConcurrency/);
  assert.doesNotMatch(block, /remoteReviewJobs/);
  assert.doesNotMatch(block, /Promise\.all\(\s*remoteReviewJobs/);
  assert.match(block, /const redistributionJobs = \[\]/);
  assert.match(block, /const remoteReviewGroups = \[\]/);
  assert.match(block, /remoteReviewGroupIndex: remoteReviewGroups\.length/);
  assert.match(block, /const brokerResult = remoteReviewGroups\.length[\s\S]*?requestGoldDraftingAiBroker\(\{[\s\S]*?operation: 'redistributeText'[\s\S]*?groups: remoteReviewGroups/);
  assert.ok(remoteRunIndex >= 0, 'expected one server-side grouped remote review request');
  assert.ok(applyLoopIndex > remoteRunIndex, 'expected ordered apply loop after server review finishes');
});

test('auto-segmentation does not start local text reviewer before Gold broker can be tried', () => {
  const source = read('src/services/timeline-selection-service.ts');
  const autoStart = source.indexOf('helper.autoSegmentVisibleSilences = async function autoSegmentVisibleSilences()');
  const autoEnd = source.indexOf('const preTrimResult = await helper.trimAllSegmentsToAudio', autoStart);
  const autoPrepareBlock = source.slice(autoStart, autoEnd);
  const redistributeStart = source.indexOf('async function redistributeAutoSegmentTextWithPromptApi');
  const redistributeEnd = source.indexOf('const finalDetail =', redistributeStart);
  const redistributeBlock = source.slice(redistributeStart, redistributeEnd);
  const brokerIndex = redistributeBlock.indexOf("requestGoldDraftingAiBroker({");
  const localPrepareIndex = redistributeBlock.indexOf('prepareAutoSegmentTextRedistributionSession()');

  assert.ok(autoStart >= 0 && autoEnd > autoStart, 'expected auto-segmentation prepare block');
  assert.ok(redistributeStart >= 0 && redistributeEnd > redistributeStart, 'expected redistribution method');
  assert.doesNotMatch(autoPrepareBlock, /prepareAutoSegmentTextRedistributionSession\(\)/);
  assert.match(autoPrepareBlock, /detail: 'Preparing AI text reviewer'/);
  assert.ok(brokerIndex >= 0, 'expected Gold broker attempt in redistribution');
  assert.ok(localPrepareIndex > brokerIndex, 'expected local reviewer startup only after broker attempt');
});
