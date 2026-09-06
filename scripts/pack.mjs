#!/usr/bin/env node
/**
 * Build a Chrome Web Store–ready ZIP, or package existing bundles with --no-build.
 * Includes manifest.json, options.html, icons, and dist JS/CSS (not source maps).
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectFiles, packExtension } from '@nominy/babel-extension-build';

const ROOT = resolve(import.meta.dirname, '..');
const skipBuild = process.argv.includes('--no-build');

if (!skipBuild) {
  console.log('Building...');
}

await packExtension({
  rootDir: ROOT,
  skipBuild,
  buildCommand: {
    command: 'npm',
    args: ['run', 'build']
  },
  collectPackResult() {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf-8').replace(/^\uFEFF/, ''));
    const files = [
      { full: join(ROOT, 'manifest.json'), rel: 'manifest.json' },
      { full: join(ROOT, 'options.html'), rel: 'options.html' }
    ];

    try {
      files.push(...collectFiles(join(ROOT, 'icons'), 'icons'));
    } catch (_error) {
      console.warn('  Warning: icons/ directory not found. Store submission requires icons.');
    }

    for (const entry of collectFiles(join(ROOT, 'dist'), 'dist')) {
      if (entry.full.endsWith('.js') || entry.full.endsWith('.css')) {
        files.push(entry);
      }
    }

    return {
      entries: files,
      zipName: `babel-helper-extension-${manifest.version}.zip`,
      zipOutputDir: process.env.BABEL_EXTENSION_ZIP_DIR || '.artifacts',
      zipPath: process.env.BABEL_EXTENSION_ZIP_PATH
    };
  }
});
