import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/core/shortcuts.ts'], bundle: true, write: false, format: 'esm', logLevel: 'silent' });
const { matchesShortcut, normalizeShortcutSettings } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const key = (code, modifiers = {}) => ({ code, key: code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });

test('legacy modifier exceptions and right Shift retain their distinct behavior', () => {
  assert.equal(matchesShortcut({}, 'focus.toggle', key('Escape', { ctrlKey: true, altKey: true })), true);
  assert.equal(matchesShortcut({}, 'speaker.reset', key('Backquote', { altKey: true, shiftKey: true })), true);
  assert.equal(matchesShortcut({}, 'number.convert', key('KeyA', { altKey: true, ctrlKey: true })), true);
  assert.equal(matchesShortcut({}, 'number.convert', key('KeyA', { altKey: true, shiftKey: true })), false);
  assert.equal(matchesShortcut({}, 'row.previous', key('ArrowLeft', { shiftKey: true }), false), false);
  assert.equal(matchesShortcut({}, 'row.previous', key('ArrowLeft', { shiftKey: true }), true), true);
});

test('persisted overrides replace defaults, disable actions, and reset without losing legacy behavior', () => {
  const settings = normalizeShortcutSettings(JSON.parse(JSON.stringify({
    'speaker.reset': [key('KeyZ', { ctrlKey: true })],
    'playback.faster': null,
    'playback.slower': [{ code: 'invalid' }]
  })));
  assert.equal(matchesShortcut(settings, 'speaker.reset', key('Backquote', { altKey: true })), false);
  assert.equal(matchesShortcut(settings, 'speaker.reset', key('KeyZ', { ctrlKey: true })), true);
  assert.equal(matchesShortcut(settings, 'speaker.reset', key('KeyZ', { ctrlKey: true, shiftKey: true })), false);
  assert.equal(matchesShortcut(settings, 'playback.faster', key('Digit1', { shiftKey: true })), false);
  assert.equal(matchesShortcut(settings, 'playback.slower', key('Digit2', { shiftKey: true })), true);
  delete settings['speaker.reset'];
  assert.equal(matchesShortcut(settings, 'speaker.reset', key('Backquote', { altKey: true, shiftKey: true })), true);
});
