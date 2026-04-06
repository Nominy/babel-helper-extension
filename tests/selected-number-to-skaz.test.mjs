import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "babel-helper-selected-number-"),
);
const bundledModulePath = path.join(
  tempDir,
  "selected-number-to-skaz.bundle.mjs",
);
const rootDir = path.resolve(".");

await build({
  entryPoints: [path.resolve("src/hooks/selected-number-to-skaz.ts")],
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

const selectedNumberModule = await import(
  pathToFileURL(bundledModulePath).href
);

const {
  formatGroupedIntegerText,
  formatGroupedDecimalText,
  buildExpandedSkazText,
  buildExpandedSkazForNumericPattern,
  buildSkazFromSlashFraction,
  buildSkazFromSpokenDigitSequence,
  buildAutoConvertedNumberText,
} = selectedNumberModule;

test("formatGroupedIntegerText groups large canonical integers but preserves leading-zero forms", () => {
  assert.equal(formatGroupedIntegerText("1000"), "1 000");
  assert.equal(formatGroupedIntegerText("1000000"), "1 000 000");
  assert.equal(formatGroupedIntegerText("-1000000"), "-1 000 000");
  assert.equal(formatGroupedIntegerText("00123"), "00123");
});

test("formatGroupedDecimalText groups only the integer side of comma decimals", () => {
  assert.equal(formatGroupedDecimalText("1000,5"), "1 000,5");
  assert.equal(formatGroupedDecimalText("-1000000,25"), "-1 000 000,25");
  assert.equal(formatGroupedDecimalText("00123,45"), "00123,45");
});

test("buildExpandedSkazText preserves digit formatting as written", () => {
  assert.equal(
    buildExpandedSkazText("00123"),
    "00123 {СКАЗ: сто двадцать три}",
  );
  assert.equal(buildExpandedSkazText("-0007"), "-0007 {СКАЗ: минус семь}");
  assert.equal(
    buildExpandedSkazText("1000000"),
    "1 000 000 {СКАЗ: один миллион}",
  );
  assert.equal(buildExpandedSkazText("-42"), "-42 {СКАЗ: минус сорок два}");
  assert.equal(buildExpandedSkazText("1,5"), "1,5 {СКАЗ: один и пять}");
  assert.equal(
    buildExpandedSkazText("1000,25"),
    "1 000,25 {СКАЗ: одна тысяча и два пять}",
  );
});

test("buildExpandedSkazForNumericPattern handles ranges and percent forms", () => {
  assert.equal(
    buildExpandedSkazForNumericPattern("2-3"),
    "2-3 {СКАЗ: два три}",
  );
  assert.equal(
    buildExpandedSkazForNumericPattern("46 %"),
    "46 % {СКАЗ: сорок шесть процентов}",
  );
  assert.equal(
    buildExpandedSkazForNumericPattern("1000 %"),
    "1 000 % {СКАЗ: одна тысяча процентов}",
  );
  assert.equal(
    buildExpandedSkazForNumericPattern("20-30-40"),
    "20-30-40 {СКАЗ: двадцать тридцать сорок}",
  );
  assert.equal(
    buildExpandedSkazForNumericPattern("1000-1000000"),
    "1 000-1 000 000 {СКАЗ: одна тысяча один миллион}",
  );
});

test("buildSkazFromSlashFraction handles direct slash fractions", () => {
  assert.equal(buildSkazFromSlashFraction("2/3"), "2/3 {СКАЗ: две третьих}");
  assert.equal(buildSkazFromSlashFraction("1/2"), "1/2 {СКАЗ: одна вторая}");
  assert.equal(buildSkazFromSlashFraction("4/6"), "4/6 {СКАЗ: четыре шестых}");
  assert.equal(
    buildSkazFromSlashFraction("2 / 3"),
    "2 / 3 {СКАЗ: две третьих}",
  );
  assert.equal(buildSkazFromSlashFraction("2/21"), null);
});

test("buildSkazFromSpokenDigitSequence handles spoken digit ranges", () => {
  assert.equal(
    buildSkazFromSpokenDigitSequence("пять шесть"),
    "5-6 {СКАЗ: пять шесть}",
  );
  assert.equal(buildSkazFromSpokenDigitSequence("двадцать три"), null);
});

test("buildAutoConvertedNumberText handles direct digits and digit patterns", () => {
  assert.equal(buildAutoConvertedNumberText("42"), "42 {СКАЗ: сорок два}");
  assert.equal(
    buildAutoConvertedNumberText("1000"),
    "1 000 {СКАЗ: одна тысяча}",
  );
  assert.equal(
    buildAutoConvertedNumberText("-42"),
    "-42 {СКАЗ: минус сорок два}",
  );
  assert.equal(buildAutoConvertedNumberText("2-3"), "2-3 {СКАЗ: два три}");
  assert.equal(
    buildAutoConvertedNumberText("46 %"),
    "46 % {СКАЗ: сорок шесть процентов}",
  );
  assert.equal(
    buildAutoConvertedNumberText("пять шесть"),
    "5-6 {СКАЗ: пять шесть}",
  );
  assert.equal(
    buildAutoConvertedNumberText("20-30-40"),
    "20-30-40 {СКАЗ: двадцать тридцать сорок}",
  );
  assert.equal(buildAutoConvertedNumberText("2/3"), "2/3 {СКАЗ: две третьих}");
  assert.equal(buildAutoConvertedNumberText("1,5"), "1,5 {СКАЗ: один и пять}");
  assert.equal(
    buildAutoConvertedNumberText("1000,25"),
    "1 000,25 {СКАЗ: одна тысяча и два пять}",
  );
  assert.equal(buildAutoConvertedNumberText("hello world"), null);
  // Word conversions are removed:
  assert.equal(buildAutoConvertedNumberText("сорок два"), null);
  assert.equal(buildAutoConvertedNumberText("один миллион"), null);
  assert.equal(buildAutoConvertedNumberText("две третьих"), null);
});
