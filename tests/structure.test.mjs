import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const REQUIRED_FILES = [
  'src/core/kernel.ts',
  'src/core/lifecycle.ts',
  'src/services/row-service.ts',
  'src/services/auto-trim-service.ts',
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
