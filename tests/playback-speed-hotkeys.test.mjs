import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const lifecycleSource = fs.readFileSync(
  new URL('../src/core/lifecycle.ts', import.meta.url),
  'utf8'
);
const configSource = fs.readFileSync(
  new URL('../src/core/config.ts', import.meta.url),
  'utf8'
);
const rowServiceSource = fs.readFileSync(
  new URL('../src/services/row-service.ts', import.meta.url),
  'utf8'
);
const playbackBridgeSource = fs.readFileSync(
  new URL('../src/content/playback-bridge.ts', import.meta.url),
  'utf8'
);

test('Shift+1 and Shift+2 adjust playback speed through the playback bridge', () => {
  assert.match(lifecycleSource, /event\.shiftKey[\s\S]*event\.code === 'Digit1'[\s\S]*helper\.adjustPlaybackSpeed\(1\)/);
  assert.match(lifecycleSource, /event\.shiftKey[\s\S]*event\.code === 'Digit2'[\s\S]*helper\.adjustPlaybackSpeed\(-1\)/);
  assert.match(rowServiceSource, /helper\.adjustPlaybackSpeed = function adjustPlaybackSpeed\(direction\)/);
  assert.match(rowServiceSource, /callPlaybackBridge\('adjust-speed'/);
  assert.match(playbackBridgeSource, /operation === 'adjust-speed'/);
  assert.match(playbackBridgeSource, /function adjustPlaybackSpeed\(direction, steps\)/);
});

test('playback speed steps match the live Babel selector values', () => {
  const expectedSteps = /\[0\.25, 0\.5, 0\.75, 1, 1\.5, 2\]/;
  assert.match(rowServiceSource, expectedSteps);
  assert.match(playbackBridgeSource, expectedSteps);
  assert.doesNotMatch(rowServiceSource, /1\.25|1\.75/);
  assert.doesNotMatch(playbackBridgeSource, /1\.25|1\.75/);
});

test('speed hotkeys do not open the visible selector menu', () => {
  assert.doesNotMatch(lifecycleSource, /function\s+adjustPlaybackSpeedFromSelector/);
  assert.doesNotMatch(lifecycleSource, /findPlaybackSpeedSelectorTrigger\(\)/);
  assert.doesNotMatch(lifecycleSource, /querySelectorAll\('\[role="option"\], \[role="menuitem"\], \[data-radix-collection-item\]'\)/);
  assert.doesNotMatch(lifecycleSource, /trigger\.click\(\)/);
});

test('playback speed changes preserve the current playback timestamp', () => {
  assert.match(playbackBridgeSource, /const previousState = getPlaybackState\(\)/);
  assert.match(playbackBridgeSource, /restorePlaybackPositionAfterSpeedChange\(previousState\)/);
  assert.match(playbackBridgeSource, /wave\.setTime\(targetTime\)/);
  assert.match(rowServiceSource, /const previousState = getPlaybackStateLocally\(\)/);
  assert.match(rowServiceSource, /restorePlaybackPositionLocallyAfterSpeedChange\(previousState\)/);
});

test('hotkeys help advertises playback speed shortcuts', () => {
  assert.match(configSource, /\['Shift \+ 1 \/ Shift \+ 2', 'Increase \/ decrease playback speed'\]/);
});
