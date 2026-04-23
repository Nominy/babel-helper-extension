#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync
} from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const TARGET = join(ROOT, 'babel-helper-extension');

if (existsSync(TARGET)) {
  rmSync(TARGET, { recursive: true, force: true });
}

mkdirSync(TARGET, { recursive: true });

copyFileIntoTarget('manifest.json');
copyFileIntoTarget('options.html');
replaceDirectory('icons');
replaceDirectory('dist');

console.log(`Synced unpacked extension to ${TARGET}`);

function copyFileIntoTarget(relativePath) {
  cpSync(join(ROOT, relativePath), join(TARGET, relativePath), { force: true });
}

function replaceDirectory(relativePath) {
  const source = join(ROOT, relativePath);
  const destination = join(TARGET, relativePath);

  if (!existsSync(source)) {
    throw new Error(`Required directory is missing: ${source}`);
  }

  if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true });
  }

  cpSync(source, destination, { recursive: true, force: true });
}
