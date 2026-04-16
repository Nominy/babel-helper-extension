import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-helper-auto-trim-utils-'));
const bundledModulePath = path.join(tempDir, 'auto-trim-utils.bundle.mjs');
const rootDir = path.resolve('.');

await build({
  entryPoints: [path.resolve('src/services/auto-trim-utils.ts')],
  outfile: bundledModulePath,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'node20',
  logLevel: 'silent',
  banner: {
    js: 'const __dirname = "/virtual";'
  },
  plugins: [
    {
      name: 'fs-browser-shim',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^fs$/ }, () => ({
          path: path.join(rootDir, 'src/build/fs-browser-shim.js')
        }));
      }
    }
  ]
});

const utilsModule = await import(pathToFileURL(bundledModulePath).href);
const {
  clampAutoTrimBoundaryTarget,
  collectVisibleAutoTrimEntries,
  summarizeAutoTrimResults
} = utilsModule;

test('collectVisibleAutoTrimEntries keeps only visible rows with identities', () => {
  const rows = [
    { id: 'a', visible: true, identity: { annotationId: 'a' } },
    { id: 'b', visible: false, identity: { annotationId: 'b' } },
    { id: 'c', visible: true, identity: null },
    { id: 'd', visible: true, identity: { annotationId: 'd' } }
  ];

  const entries = collectVisibleAutoTrimEntries(
    rows,
    (row) => Boolean(row.visible),
    (row) => row.identity
  );

  assert.deepEqual(
    entries.map((entry) => entry.row.id),
    ['a', 'd']
  );
});

test('clamps left-boundary suggestions against the previous row', () => {
  const result = clampAutoTrimBoundaryTarget({
    side: 'left',
    currentStartSeconds: 10,
    currentEndSeconds: 11,
    suggestedSeconds: 9.95,
    previousEndSeconds: 9.96,
    minGapSeconds: 0.01,
    minDeltaMs: 5
  });

  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.targetSeconds - 9.97) < 0.0005);
  assert.equal(result.clamped, true);
});

test('rejects negligible boundary movement', () => {
  const result = clampAutoTrimBoundaryTarget({
    side: 'right',
    currentStartSeconds: 10,
    currentEndSeconds: 11,
    suggestedSeconds: 11.003,
    nextStartSeconds: 12,
    minGapSeconds: 0.01,
    minDeltaMs: 5
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'below-min-delta');
});

test('summarizes mixed row outcomes', () => {
  const summary = summarizeAutoTrimResults([
    { status: 'trimmed', boundariesTrimmed: 2 },
    { status: 'trimmed', boundariesTrimmed: 1 },
    { status: 'skipped-low-confidence', boundariesTrimmed: 0 },
    { status: 'skipped-no-audio', boundariesTrimmed: 0 },
    { status: 'failed-write', boundariesTrimmed: 0 },
    { status: 'skipped-noop', boundariesTrimmed: 0 }
  ]);

  assert.deepEqual(summary, {
    rowsProcessed: 6,
    trimmed: 2,
    boundariesTrimmed: 3,
    skippedLowConfidence: 1,
    skippedNoAudio: 1,
    failedWrite: 1,
    skippedNoop: 1,
    skippedInvalid: 0
  });
});
