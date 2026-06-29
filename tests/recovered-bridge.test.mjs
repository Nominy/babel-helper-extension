import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(new URL(path, import.meta.url), "utf8");
}

function exists(path) {
  return fs.existsSync(new URL(path, import.meta.url));
}

test("recovered editor bridge is bundled, exposed, and registered in the session runtime", () => {
  assert.equal(exists("../src/content/recovered-editor-bridge.ts"), true);
  assert.equal(exists("../src/services/recovered-editor-snapshot-service.ts"), true);

  const bridgeSource = read("../src/content/recovered-editor-bridge.ts");
  const serviceSource = read("../src/services/recovered-editor-snapshot-service.ts");
  const esbuildSource = read("../esbuild.config.mjs");
  const manifestSource = read("../manifest.json");
  const kernelSource = read("../src/core/kernel.ts");
  const lazySessionSource = read("../src/content/lazy-session.ts");

  assert.match(bridgeSource, /babel-helper-recovered-editor-request/);
  assert.match(bridgeSource, /babel-helper-recovered-editor-response/);
  assert.match(bridgeSource, /__babelHelperRecoveredEditorBridge/);
  assert.match(bridgeSource, /function getEditorSnapshot/);
  assert.match(bridgeSource, /function applyExtendedDiffState/);
  assert.match(bridgeSource, /function clearExtendedDiffState/);
  assert.match(bridgeSource, /BABEL_ROW_TEXTAREA_SELECTOR/);
  assert.match(bridgeSource, /activeRowId/);
  assert.match(bridgeSource, /tracks/);
  assert.match(bridgeSource, /onToggleDiffMode/);
  assert.match(bridgeSource, /onSelectCompareAction/);

  assert.match(serviceSource, /registerRecoveredEditorSnapshotService/);
  assert.match(serviceSource, /helper\.refreshEditorSnapshot/);
  assert.match(serviceSource, /helper\.applyRecoveredEditorDiffState/);
  assert.match(serviceSource, /helper\.clearRecoveredEditorDiffState/);
  assert.match(serviceSource, /helper\.findRowFromEditorSnapshot/);
  assert.match(serviceSource, /dist\/content\/recovered-editor-bridge\.js/);

  assert.match(esbuildSource, /src\/content\/recovered-editor-bridge\.ts/);
  assert.match(esbuildSource, /dist\/content\/recovered-editor-bridge\.js/);
  assert.match(manifestSource, /dist\/content\/recovered-editor-bridge\.js/);
  assert.match(kernelSource, /registerRecoveredEditorSnapshotService\(helper\);[\s\S]*registerExtendedDiffViewService\(helper\)/);
  assert.match(lazySessionSource, /registerRecoveredEditorSnapshotService\(helper\)/);
});

test("recovered editor bridge applies and restores native diff selection for extended diff tags", () => {
  const bridgeSource = read("../src/content/recovered-editor-bridge.ts");
  const serviceSource = read("../src/services/recovered-editor-snapshot-service.ts");

  assert.match(bridgeSource, /operation === 'apply-extended-diff-state'/);
  assert.match(bridgeSource, /operation === 'clear-extended-diff-state'/);
  assert.match(bridgeSource, /function getTranscriptionDiffToolbarProps/);
  assert.match(bridgeSource, /availableReviewActions/);
  assert.match(bridgeSource, /selectedCompareActionId/);
  assert.match(bridgeSource, /extendedDiffPatch/);
  assert.match(bridgeSource, /function ensureExtendedDiffReviewAction/);
  assert.match(bridgeSource, /if \(selectedCompareActionId\) \{[\s\S]*return actions\.find\(\(action\) => action\?\.id === selectedCompareActionId\) \|\| null;[\s\S]*\}/);
  assert.match(bridgeSource, /availableReviewActions\.push\(syntheticAction\)/);
  assert.match(bridgeSource, /syntheticExtendedDiffActionId/);
  assert.match(bridgeSource, /function removeSyntheticExtendedDiffAction/);
  assert.match(bridgeSource, /__babelHelperExtendedDiff/);
  assert.match(bridgeSource, /previousSelectedCompareActionId/);
  assert.match(bridgeSource, /lastAppliedActionId/);
  assert.match(bridgeSource, /onToggleDiffMode\(true\)/);
  assert.match(bridgeSource, /onSelectCompareAction\(action\.id\)/);
  assert.match(bridgeSource, /removeSyntheticExtendedDiffAction\(toolbarProps, extendedDiffPatch\.syntheticExtendedDiffActionId\)/);
  assert.match(bridgeSource, /currentSelectedCompareActionId !== extendedDiffPatch\.lastAppliedActionId/);
  assert.match(bridgeSource, /onToggleDiffMode\(false\)/);
  assert.match(bridgeSource, /function installExtendedDiffFetchPatch/);
  assert.match(bridgeSource, /function uninstallExtendedDiffFetchPatch/);
  assert.match(bridgeSource, /function patchTranscriptionDiffPayload/);
  assert.match(bridgeSource, /function buildFullWordDiffs/);
  assert.match(bridgeSource, /function splitFullDiffTokens/);
  assert.match(bridgeSource, /String\(text \|\| ''\)\.match\(\/\\S\+\/g\)/);
  assert.match(bridgeSource, /setExtendedDiffValue\(mapping, 'wordDiffs', wordDiffs, restorable\)/);
  assert.match(bridgeSource, /patchCurrentDiffResult\(toolbarProps\)/);
  assert.match(bridgeSource, /patchTranscriptionDiffResponseText/);
  assert.match(bridgeSource, /restoreExtendedDiffMutations\(\)/);
  assert.match(bridgeSource, /onSelectCompareAction\(null\)/);
  assert.match(bridgeSource, /patchedCurrentDiffResult/);

  assert.match(serviceSource, /callRecoveredEditorBridge\('apply-extended-diff-state'/);
  assert.match(serviceSource, /callRecoveredEditorBridge\('clear-extended-diff-state'/);
});

test("row actions prefer recovered snapshot and exact recovered labels over fuzzy fallbacks", () => {
  const configSource = read("../src/core/config.ts");
  const rowSource = read("../src/services/row-service.ts");

  assert.match(configSource, /BABEL_ROW_ACTION_LABELS/);
  assert.match(configSource, /actionLabels/);
  assert.doesNotMatch(configSource, /mergeFallback/);
  assert.doesNotMatch(configSource, /actionPatterns/);

  assert.match(rowSource, /helper\.findRowFromEditorSnapshot/);
  assert.match(rowSource, /helper\.refreshEditorSnapshot/);
  assert.match(rowSource, /runNativeRowAction/);
  assert.match(rowSource, /getBabelRowActionLabel\(actionName\)/);
  assert.doesNotMatch(rowSource, /helper\.config\.actionPatterns/);
  assert.doesNotMatch(rowSource, /mergeFallback/);
});

test("row selector callers use the recovered exact textarea contract", () => {
  const productionSources = [
    "../src/core/config.ts",
    "../src/hooks/selectors.ts",
    "../src/content/timestamp-bridge.ts",
    "../src/content/linter-bridge.ts",
    "../src/content/quick-region-autocomplete-bridge.ts",
    "../src/services/row-service.ts"
  ];

  for (const sourcePath of productionSources) {
    const source = read(sourcePath);
    assert.doesNotMatch(source, /textarea\[placeholder\^="What was said"\]/, sourcePath);
  }
});
