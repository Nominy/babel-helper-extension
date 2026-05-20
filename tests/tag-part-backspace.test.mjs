import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-helper-tag-part-'));
const bundledModulePath = path.join(tempDir, 'tag-part-backspace.bundle.mjs');

await build({
  entryPoints: [path.resolve('src/content/tag-part-backspace.ts')],
  outfile: bundledModulePath,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
});

const { getAngleTagPartBackspaceEdit, shouldHandleAngleTagPartBackspaceEvent } = await import(
  pathToFileURL(bundledModulePath).href
);

test('removes the complete opening angle tag part when Backspace hits it', () => {
  const edit = getAngleTagPartBackspaceEdit('<laugh> hello </laugh>', 7, 7);

  assert.deepEqual(edit, {
    nextValue: ' hello </laugh>',
    removedText: '<laugh>',
    selectionStart: 0,
    selectionEnd: 0,
  });
});

test('removes an angle tag part when Backspace starts inside a partially edited token', () => {
  const edit = getAngleTagPartBackspaceEdit('<laugh> hello </laugh>', 3, 3);

  assert.deepEqual(edit, {
    nextValue: ' hello </laugh>',
    removedText: '<laugh>',
    selectionStart: 0,
    selectionEnd: 0,
  });
});

test('removes only the closing angle tag part', () => {
  const edit = getAngleTagPartBackspaceEdit('<laugh> hello </laugh>', 22, 22);

  assert.deepEqual(edit, {
    nextValue: '<laugh> hello ',
    removedText: '</laugh>',
    selectionStart: 14,
    selectionEnd: 14,
  });
});

test('does not remove a whole closure when Backspace is in wrapped transcript text', () => {
  assert.equal(getAngleTagPartBackspaceEdit('<laugh> hello </laugh>', 10, 10), null);
});

test('leaves selections and malformed angle fragments to native editing', () => {
  assert.equal(getAngleTagPartBackspaceEdit('<laugh> hello', 1, 6), null);
  assert.equal(getAngleTagPartBackspaceEdit('<laugh hello', 4, 4), null);
  assert.equal(getAngleTagPartBackspaceEdit('<> hello', 1, 1), null);
});

test('handles Ctrl+Backspace for angle tag part removal', () => {
  assert.equal(shouldHandleAngleTagPartBackspaceEvent({ key: 'Backspace' }), true);
  assert.equal(shouldHandleAngleTagPartBackspaceEvent({ key: 'Backspace', ctrlKey: true }), true);
  assert.equal(shouldHandleAngleTagPartBackspaceEvent({ key: 'Backspace', altKey: true }), false);
  assert.equal(shouldHandleAngleTagPartBackspaceEvent({ key: 'Backspace', metaKey: true }), false);
});

test('Ctrl+Backspace removes a tag part before directly adjacent text or spaces', () => {
  assert.deepEqual(getAngleTagPartBackspaceEdit('<laugh>hello', 12, 12, { skipAdjacentSuffix: true }), {
    nextValue: 'hello',
    removedText: '<laugh>',
    selectionStart: 0,
    selectionEnd: 0,
  });

  assert.deepEqual(getAngleTagPartBackspaceEdit('<laugh>   ', 10, 10, { skipAdjacentSuffix: true }), {
    nextValue: '   ',
    removedText: '<laugh>',
    selectionStart: 0,
    selectionEnd: 0,
  });

  assert.deepEqual(getAngleTagPartBackspaceEdit('</laugh>hello', 13, 13, { skipAdjacentSuffix: true }), {
    nextValue: 'hello',
    removedText: '</laugh>',
    selectionStart: 0,
    selectionEnd: 0,
  });
});

test('Ctrl+Backspace does not jump across separated transcript text', () => {
  assert.equal(getAngleTagPartBackspaceEdit('<laugh> hello', 13, 13, { skipAdjacentSuffix: true }), null);
});
