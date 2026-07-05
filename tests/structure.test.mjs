import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const REQUIRED_FILES = [
  'src/core/kernel.ts',
  'src/core/lifecycle.ts',
  'src/services/row-service.ts',
  'src/services/timeline-selection-service.ts',
  'src/services/magnifier-service.ts',
  'src/features/index.ts',
  'src/content/entry.ts',
  'src/content/magnifier-bridge.ts',
  'src/content/timestamp-bridge.ts',
  'src/content/linter-bridge.ts',
  'src/options/options.ts',
  'options.html'
];

test('refactor structure files exist', () => {
  for (const relPath of REQUIRED_FILES) {
    assert.equal(fs.existsSync(new URL('../' + relPath, import.meta.url)), true, `${relPath} should exist`);
  }
});

test('options page includes passive Ko-fi support link without new host permissions', () => {
  const optionsSource = fs.readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const hostPermissions = manifest.host_permissions || [];

  assert.match(optionsSource, /https:\/\/ko-fi\.com\/naftsan/);
  assert.match(optionsSource, /Support on Ko-fi/);
  assert.equal(hostPermissions.some((permission) => /ko-fi\.com/.test(permission)), false);
});

test('hotkeys help surface includes a small Ko-fi link near the Babel Helper header', () => {
  const source = fs.readFileSync(new URL('../src/services/hotkeys-help-service.ts', import.meta.url), 'utf8');

  assert.match(source, /Babel Helper/);
  assert.match(source, /https:\/\/ko-fi\.com\/naftsan/);
  assert.match(source, /Support on Ko-fi/);
  assert.match(source, /babel-helper-support-link/);
});
