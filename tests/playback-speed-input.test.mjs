import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function load(entry) {
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const { createEditorHooks } = await load('src/core/editor-hooks.ts');
const { registerPlaybackSpeedInput } = await load('src/features/playback-speed-hotkeys.ts');

function setup({ disabled = [], typing = false } = {}) {
  const hooks = createEditorHooks();
  const changes = [];
  registerPlaybackSpeedInput({ adjustPlaybackSpeed: async direction => { changes.push(direction); } }, hooks, {
    isFeatureEnabled: feature => !disabled.includes(feature),
    isTypingInTextControl: () => typing,
  });
  return { changes, press(overrides = {}) {
    const event = {
      code: 'Digit1', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false,
      defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; }, ...overrides,
    };
    const claimed = hooks.dispatch('keydown', event);
    return { claimed, event };
  } };
}

test('speed shortcuts request opposite adjustments and consume handled keys', () => {
  const harness = setup();
  for (const code of ['Digit1', 'Digit2']) {
    const { claimed, event } = harness.press({ code });
    assert.equal(claimed, true);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
  }
  assert.deepEqual(harness.changes, [1, -1]);
});

test('typing, disabled features and unrelated modifiers leave speed and keyboard events untouched', () => {
  for (const options of [{ typing: true }, { disabled: ['playbackSpeedHotkeys'] }, { disabled: ['rowActions'] }]) {
    const harness = setup(options);
    const { claimed, event } = harness.press();
    assert.equal(claimed, false);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.propagationStopped, false);
    assert.deepEqual(harness.changes, []);
  }
  const harness = setup();
  for (const overrides of [{ shiftKey: false }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { code: 'KeyA' }]) {
    const { claimed, event } = harness.press(overrides);
    assert.equal(claimed, false);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(harness.changes, []);
});
