import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const publishSource = fs.readFileSync(
  new URL('../scripts/publish-cws.mjs', import.meta.url),
  'utf8'
);

test('Chrome Web Store publisher retries transient transport failures only', () => {
  assert.match(publishSource, /CWS_REQUEST_RETRIES/);
  assert.match(publishSource, /CWS_REQUEST_RETRY_DELAY_MS/);
  assert.match(publishSource, /async function fetchWithRetry/);
  assert.match(publishSource, /function isTransientFetchError/);
  assert.match(publishSource, /function hasTransientErrorCode/);
  assert.match(publishSource, /await fetchWithRetry\(url,\s*options\)/);
  assert.match(publishSource, /ECONNRESET/);
  assert.match(publishSource, /UND_ERR_SOCKET/);

  const requestJsonStart = publishSource.indexOf('async function requestJson');
  const retryStart = publishSource.indexOf('async function fetchWithRetry');
  const retryEnd = publishSource.indexOf('function isTransientFetchError', retryStart);
  assert.notEqual(requestJsonStart, -1);
  assert.notEqual(retryStart, -1);
  assert.notEqual(retryEnd, -1);

  const requestJsonBody = publishSource.slice(requestJsonStart, retryStart);
  const retryBody = publishSource.slice(retryStart, retryEnd);
  assert.doesNotMatch(requestJsonBody, /catch\s*\(/);
  assert.doesNotMatch(retryBody, /response\.ok/);
});
