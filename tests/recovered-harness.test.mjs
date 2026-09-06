import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), "utf8");
}

function exists(path) {
  return fs.existsSync(new URL(path, import.meta.url));
}

test("recovered app verification harness is available as a package script", () => {
  assert.equal(exists("../scripts/verify-recovered-app-harness.mjs"), true);

  const packageJson = JSON.parse(read("../package.json"));
  assert.equal(packageJson.scripts["verify:recovered-app"], "node scripts/verify-recovered-app-harness.mjs");

  const harnessSource = read("../scripts/verify-recovered-app-harness.mjs");
  assert.match(harnessSource, /tools[\\/]babel-editor-rebuild[\\/]app/);
  assert.match(harnessSource, /BABEL_ROW_TEXTAREA_SELECTOR/);
  assert.match(harnessSource, /--dry-run/);
  assert.match(harnessSource, /playwright-core/);
  assert.match(harnessSource, /RecoveredBabelApp/);
});
