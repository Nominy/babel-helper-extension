import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "babel-helper-contract-"));
const bundledModulePath = path.join(tempDir, "babel-editor-contract.bundle.mjs");
const rootDir = path.resolve(".");

await build({
  entryPoints: [path.resolve("src/core/babel-editor-contract.ts")],
  outfile: bundledModulePath,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "node20",
  logLevel: "silent",
  banner: {
    js: 'const __dirname = "/virtual";',
  },
  plugins: [
    {
      name: "fs-browser-shim",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^fs$/ }, () => ({
          path: path.join(rootDir, "src/build/fs-browser-shim.js"),
        }));
      },
    },
  ],
});

const contract = await import(pathToFileURL(bundledModulePath).href);

test("recovered contract exposes exact Babel editor selectors and labels", () => {
  assert.equal(contract.BABEL_EDITOR_CONTRACT_VERSION, "recovered-81835-2026-06-21");
  assert.equal(contract.BABEL_ROW_TEXTAREA_SELECTOR, 'textarea[placeholder="What was said…"]');
  assert.deepEqual(contract.BABEL_TABLE_COLUMN_INDEX, {
    id: 0,
    speaker: 1,
    start: 2,
    end: 3,
    text: 4,
    linter: 5,
    actions: 6,
  });
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
    contract.isBabelActiveRowClassList(["relative", "bg-neutral-100", "ring-1", "ring-neutral-300"]),
    true,
  );
  assert.equal(contract.isBabelActiveRowClassList(["bg-green-50", "ring-1", "ring-green-300"]), false);
});
