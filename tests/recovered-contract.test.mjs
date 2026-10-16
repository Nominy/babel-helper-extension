import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "babel-helper-contract-"));
const bundledModulePath = path.join(tempDir, "babel-editor-contract.bundle.mjs");

await build({
  entryPoints: [path.resolve("src/core/babel-editor-contract.ts")],
  outfile: bundledModulePath,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "node20",
  logLevel: "silent",
});

const contract = await import(pathToFileURL(bundledModulePath).href);


test("recovered contract parses displayed row timestamps exactly", () => {
  assert.equal(contract.parseBabelDisplayedTime("00:00.94"), 0.94);
  assert.equal(contract.parseBabelDisplayedTime("01:31.57"), 91.57);
  assert.equal(contract.parseBabelDisplayedTime("1:02:03.45"), 3723.45);
  assert.equal(contract.parseBabelDisplayedTime("01:99.00"), null);
  assert.equal(contract.parseBabelDisplayedTime("not a time"), null);
});

test("recovered contract recognizes active row class token set", () => {
  assert.equal(
    contract.isBabelActiveRowClassList(["flex", "border-orange-300", "bg-white"]),
    true,
  );
  assert.equal(contract.isBabelActiveRowClassList(["bg-green-50", "ring-1", "ring-green-300"]), false);
});
