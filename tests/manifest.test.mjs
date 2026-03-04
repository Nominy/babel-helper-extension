import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('manifest targets bundled dist assets', () => {
  const raw = fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '');
  const manifest = JSON.parse(raw);

  assert.equal(manifest.content_scripts[0].js[0], 'dist/content/entry.js');
  assert.equal(manifest.web_accessible_resources[0].resources[0], 'dist/content/magnifier-bridge.js');
  assert.equal(manifest.web_accessible_resources[0].resources.includes('dist/content/linter-bridge.js'), true);
  assert.equal(manifest.options_page, 'options.html');
  assert.equal(manifest.permissions.includes('storage'), true);
});
