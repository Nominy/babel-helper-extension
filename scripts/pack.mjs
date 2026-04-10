#!/usr/bin/env node
/**
 * pack.mjs — Build a Chrome Web Store–ready ZIP of the extension.
 *
 * Usage:  node scripts/pack.mjs          (runs build first)
 *         node scripts/pack.mjs --no-build
 *
 * Output: ../babel-helper-extension-<version>.zip  (one directory up)
 *
 * Only the files required at runtime are included:
 *   manifest.json
 *   options.html
 *   icons/*
 *   dist/ JS bundles       (source maps excluded)
 */

import { execSync } from 'node:child_process';
import { createWriteStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const skipBuild = process.argv.includes('--no-build');

// 1. Build
if (!skipBuild) {
  console.log('Building...');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}

// 2. Read version from manifest
const manifestRaw = readFileSync(join(ROOT, 'manifest.json'), 'utf-8').replace(/^\uFEFF/, '');
const manifest = JSON.parse(manifestRaw);
const version = manifest.version;
const zipName = `babel-helper-extension-${version}.zip`;
const zipPath = resolve(ROOT, '..', zipName);

// 3. Collect files
function collectFiles(dir, base) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = join(base, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, rel));
    } else {
      results.push({ full, rel });
    }
  }
  return results;
}

const files = [];

// manifest.json
files.push({ full: join(ROOT, 'manifest.json'), rel: 'manifest.json' });

// options.html
files.push({ full: join(ROOT, 'options.html'), rel: 'options.html' });

// icons/
const iconsDir = join(ROOT, 'icons');
try {
  files.push(...collectFiles(iconsDir, 'icons'));
} catch (_e) {
  console.warn('  Warning: icons/ directory not found. Store submission requires icons.');
}

// dist/**/*.js (no .map files)
const distDir = join(ROOT, 'dist');
for (const { full, rel } of collectFiles(distDir, 'dist')) {
  if (full.endsWith('.js')) {
    files.push({ full, rel });
  }
}

// 4. Write ZIP
// Minimal ZIP writer — no dependencies required.

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const d =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, date: d };
}

function writeUInt32LE(buf, val, off) { buf.writeUInt32LE(val >>> 0, off); }
function writeUInt16LE(buf, val, off) { buf.writeUInt16LE(val & 0xffff, off); }

async function deflate(data) {
  const chunks = [];
  const deflater = createDeflateRaw({ level: 9 });
  deflater.on('data', (chunk) => chunks.push(chunk));
  deflater.end(data);
  await new Promise((resolve, reject) => {
    deflater.on('end', resolve);
    deflater.on('error', reject);
  });
  return Buffer.concat(chunks);
}

async function createZip(outPath, entries) {
  const centralHeaders = [];
  let offset = 0;
  const parts = [];

  const now = new Date();
  const { time: dosTime, date: dosDate } = dosDateTime(now);

  for (const { rel, full } of entries) {
    const raw = readFileSync(full);
    const crc = crc32(raw);
    const compressed = await deflate(raw);

    // Use DEFLATE only if it actually saves space
    const useDeflate = compressed.length < raw.length;
    const method = useDeflate ? 8 : 0;
    const stored = useDeflate ? compressed : raw;

    const nameBytes = Buffer.from(rel.replace(/\\/g, '/'), 'utf-8');

    // Local file header (30 + name)
    const local = Buffer.alloc(30 + nameBytes.length);
    writeUInt32LE(local, 0x04034b50, 0);   // signature
    writeUInt16LE(local, 20, 4);            // version needed
    writeUInt16LE(local, 0, 6);             // flags
    writeUInt16LE(local, method, 8);        // method
    writeUInt16LE(local, dosTime, 10);
    writeUInt16LE(local, dosDate, 12);
    writeUInt32LE(local, crc, 14);
    writeUInt32LE(local, stored.length, 18);
    writeUInt32LE(local, raw.length, 22);
    writeUInt16LE(local, nameBytes.length, 26);
    writeUInt16LE(local, 0, 28);            // extra length
    nameBytes.copy(local, 30);

    parts.push(local, stored);

    // Central directory header (46 + name)
    const central = Buffer.alloc(46 + nameBytes.length);
    writeUInt32LE(central, 0x02014b50, 0);
    writeUInt16LE(central, 20, 4);          // version made by
    writeUInt16LE(central, 20, 6);          // version needed
    writeUInt16LE(central, 0, 8);           // flags
    writeUInt16LE(central, method, 10);
    writeUInt16LE(central, dosTime, 12);
    writeUInt16LE(central, dosDate, 14);
    writeUInt32LE(central, crc, 16);
    writeUInt32LE(central, stored.length, 20);
    writeUInt32LE(central, raw.length, 24);
    writeUInt16LE(central, nameBytes.length, 28);
    writeUInt16LE(central, 0, 30);          // extra length
    writeUInt16LE(central, 0, 32);          // comment length
    writeUInt16LE(central, 0, 34);          // disk start
    writeUInt16LE(central, 0, 36);          // internal attrs
    writeUInt32LE(central, 0, 38);          // external attrs
    writeUInt32LE(central, offset, 42);     // local header offset
    nameBytes.copy(central, 46);
    centralHeaders.push(central);

    offset += local.length + stored.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralHeaders) {
    parts.push(c);
    centralSize += c.length;
  }

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  writeUInt32LE(eocd, 0x06054b50, 0);
  writeUInt16LE(eocd, 0, 4);               // disk number
  writeUInt16LE(eocd, 0, 6);               // disk with CD
  writeUInt16LE(eocd, entries.length, 8);   // entries on disk
  writeUInt16LE(eocd, entries.length, 10);  // total entries
  writeUInt32LE(eocd, centralSize, 12);
  writeUInt32LE(eocd, centralStart, 16);
  writeUInt16LE(eocd, 0, 20);              // comment length
  parts.push(eocd);

  const { writeFileSync } = await import('node:fs');
  writeFileSync(outPath, Buffer.concat(parts));
}

console.log(`Packing ${files.length} files...`);
for (const f of files) {
  console.log(`  ${f.rel}`);
}

await createZip(zipPath, files);
const stat = statSync(zipPath);
console.log(`\nCreated ${zipName} (${(stat.size / 1024).toFixed(1)} KB)`);
