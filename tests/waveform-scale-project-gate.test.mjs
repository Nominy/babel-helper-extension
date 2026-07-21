import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const waveformSource = fs.readFileSync(
  new URL('../src/services/waveform-scale-service.ts', import.meta.url),
  'utf8'
);

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.ok(start !== -1, `${functionName} should be defined in waveform-scale-service.ts`);

  let depth = 0;
  let bodyStarted = false;
  let end = start;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
      bodyStarted = true;
    } else if (char === '}') {
      depth -= 1;
      if (bodyStarted && depth === 0) {
        end = index + 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function isRuTxGoldProject(pathname) {
  const fnSource = extractFunctionSource(waveformSource, 'isRuTxGoldProject');
  // eslint-disable-next-line no-new-func
  const factory = new Function('window', `${fnSource}\nreturn isRuTxGoldProject();`);
  return factory({ location: { pathname } });
}

test('waveform scale unlock is restored with its original service surface', () => {
  assert.match(waveformSource, /export function registerWaveformScaleService\(helper: any\)/);
  assert.match(waveformSource, /helper\.bindWaveformScaleUnlock = function bindWaveformScaleUnlock\(\)/);
  assert.match(waveformSource, /helper\.unbindWaveformScaleUnlock = function unbindWaveformScaleUnlock\(\)/);
});

test('bindWaveformScaleUnlock is gated on both the feature setting and the current project', () => {
  assert.match(
    waveformSource,
    /if \(!isFeatureEnabled\('waveformScaleUnlock'\) \|\| !isRuTxGoldProject\(\)\) \{\s*\n\s*helper\.unbindWaveformScaleUnlock\(\);\s*\n\s*return false;/
  );
});

test('isRuTxGoldProject only matches the RU-tx-gold transcription project', () => {
  assert.equal(isRuTxGoldProject('/transcription/RU-tx-gold'), true);
  assert.equal(isRuTxGoldProject('/transcription/RU-tx-gold/session-42'), true);

  assert.equal(isRuTxGoldProject('/transcription/RU-tx-silver'), false);
  assert.equal(isRuTxGoldProject('/transcription/RU-tx-golden'), false, 'must not match a slug that merely starts with RU-tx-gold');
  assert.equal(isRuTxGoldProject('/other/RU-tx-gold'), false);
  assert.equal(isRuTxGoldProject('/transcription/'), false);
  assert.equal(isRuTxGoldProject(''), false);
});
