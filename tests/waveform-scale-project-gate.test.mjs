import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const waveformSource = fs.readFileSync(
  new URL('../src/services/waveform-scale-service.ts', import.meta.url),
  'utf8'
);

const registrySource = fs.readFileSync(
  new URL('../src/features/registry.ts', import.meta.url),
  'utf8'
);

test('waveform scale unlock retains its service surface', () => {
  assert.match(waveformSource, /export function registerWaveformScaleService\(helper: any\)/);
  assert.match(waveformSource, /helper\.bindWaveformScaleUnlock = function bindWaveformScaleUnlock\(\)/);
  assert.match(waveformSource, /helper\.unbindWaveformScaleUnlock = function unbindWaveformScaleUnlock\(\)/);
});

test('bindWaveformScaleUnlock is gated only by the feature setting', () => {
  assert.match(
    waveformSource,
    /if \(!isFeatureEnabled\('waveformScaleUnlock'\)\) \{\s*\n\s*helper\.unbindWaveformScaleUnlock\(\);\s*\n\s*return false;/
  );
  assert.doesNotMatch(waveformSource, /isRuTxGoldProject|RU-tx-gold/);
});

test('waveform scale unlock is described as available without a project restriction', () => {
  assert.doesNotMatch(registrySource, /Only active on the RU-tx-gold project/);
});
