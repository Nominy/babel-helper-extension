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

test("recovered contract exposes exact Babel editor selectors and labels", () => {
  assert.equal(contract.BABEL_TRANSCRIPT_ROW_SELECTOR, 'section[data-annotation-id]');
  assert.equal(contract.BABEL_ROW_EDITOR_SELECTOR, '[role="textbox"][aria-label="Edit turn text"], [data-slate-editor="true"]');
  assert.deepEqual(contract.BABEL_ROW_ACTION_LABELS, {
    insertAbove: "Add Segment Above",
    insertBelow: "Add Segment Below",
    mergePrevious: "Merge With Above",
    mergeNext: "Merge With Below",
    deleteSegment: "Delete",
  });
  assert.equal(contract.getBabelRowActionLabel("mergePrevious"), "Merge With Above");
  assert.equal(contract.getBabelRowActionNameForLabel("Merge With Below"), "mergeNext");
  assert.equal(contract.getBabelRowActionNameForLabel("merge below"), null);
});

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
