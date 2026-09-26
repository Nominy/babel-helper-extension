#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = join(root, 'babel-helper-extension');
const entries = ['manifest.json', 'options.html', 'icons', 'dist'];

for (const entry of entries) {
  if (!existsSync(join(root, entry))) throw new Error(`Required build input is missing: ${entry}`);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const entry of entries) {
  cpSync(join(root, entry), join(target, entry), { recursive: true });
}
console.log(`Load unpacked: ${target}`);
