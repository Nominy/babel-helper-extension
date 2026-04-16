import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babel-helper-auto-trim-analysis-'));
const bundledModulePath = path.join(tempDir, 'boundary-trim-analysis.bundle.mjs');
const rootDir = path.resolve('.');

await build({
  entryPoints: [path.resolve('src/shared/boundary-trim-analysis.ts')],
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

const analysisModule = await import(pathToFileURL(bundledModulePath).href);
const { analyzeBoundaryTrimEnvelope } = analysisModule;

function buildEnvelope({ windowStartSeconds, windowEndSeconds, stepSeconds, segments }) {
  const binCount = Math.max(1, Math.round((windowEndSeconds - windowStartSeconds) / stepSeconds));
  const values = new Array(binCount).fill(0);

  for (const segment of segments || []) {
    const startIndex = Math.max(
      0,
      Math.floor((segment.startSeconds - windowStartSeconds) / stepSeconds)
    );
    const endIndex = Math.min(
      binCount,
      Math.ceil((segment.endSeconds - windowStartSeconds) / stepSeconds)
    );
    for (let index = startIndex; index < endIndex; index += 1) {
      values[index] = Math.max(values[index], Number(segment.level) || 0);
    }
  }

  return values;
}

test('detects leading silence and trims inward with 20ms padding', () => {
  const windowStartSeconds = 0.75;
  const stepSeconds = 0.005;
  const values = buildEnvelope({
    windowStartSeconds,
    windowEndSeconds: 1.35,
    stepSeconds,
    segments: [
      { startSeconds: 1.12, endSeconds: 1.28, level: 1 }
    ]
  });

  const result = analyzeBoundaryTrimEnvelope({
    side: 'left',
    boundarySeconds: 1.0,
    windowStartSeconds,
    stepSeconds,
    values,
    paddingMs: 20,
    maxOutwardMs: 50,
    source: 'decoded'
  });

  assert.equal(result.ok, true);
  assert.equal(result.confidence, 'high');
  assert.ok(Math.abs(result.suggestedSeconds - 1.1) < 0.02);
  assert.ok(result.inwardDeltaMs >= 80);
});

test('detects trailing silence and trims inward with 20ms padding', () => {
  const windowStartSeconds = 0.65;
  const stepSeconds = 0.005;
  const values = buildEnvelope({
    windowStartSeconds,
    windowEndSeconds: 1.25,
    stepSeconds,
    segments: [
      { startSeconds: 0.72, endSeconds: 0.89, level: 1 }
    ]
  });

  const result = analyzeBoundaryTrimEnvelope({
    side: 'right',
    boundarySeconds: 1.0,
    windowStartSeconds,
    stepSeconds,
    values,
    paddingMs: 20,
    maxOutwardMs: 50,
    source: 'decoded'
  });

  assert.equal(result.ok, true);
  assert.equal(result.confidence, 'high');
  assert.ok(Math.abs(result.suggestedSeconds - 0.91) < 0.02);
  assert.ok(result.inwardDeltaMs >= 80);
});

test('clamps outward expansion to the 50ms cap', () => {
  const windowStartSeconds = 0.75;
  const stepSeconds = 0.005;
  const values = buildEnvelope({
    windowStartSeconds,
    windowEndSeconds: 1.35,
    stepSeconds,
    segments: [
      { startSeconds: 0.91, endSeconds: 1.14, level: 1 }
    ]
  });

  const result = analyzeBoundaryTrimEnvelope({
    side: 'left',
    boundarySeconds: 1.0,
    windowStartSeconds,
    stepSeconds,
    values,
    paddingMs: 20,
    maxOutwardMs: 50,
    source: 'decoded'
  });

  assert.equal(result.ok, true);
  assert.equal(result.confidence, 'high');
  assert.ok(Math.abs(result.suggestedSeconds - 0.95) < 0.015);
  assert.ok(Math.abs(result.outwardDeltaMs - 50) < 1);
});

test('returns none on low-dynamic-range windows', () => {
  const values = new Array(120).fill(0.002);

  const result = analyzeBoundaryTrimEnvelope({
    side: 'left',
    boundarySeconds: 1.0,
    windowStartSeconds: 0.75,
    stepSeconds: 0.005,
    values,
    paddingMs: 20,
    maxOutwardMs: 50,
    source: 'decoded'
  });

  assert.equal(result.ok, true);
  assert.equal(result.confidence, 'none');
  assert.equal(result.suggestedSeconds, null);
});
