import { watch as watchFileChanges } from 'node:fs';
import { copyFile, cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import { buildClassicEditor } from './scripts/build-classic-editor.mjs';

const watch = process.argv.includes('--watch');
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(rootDir, 'manifest.json'), 'utf8'));
const userscriptDeclarationSource = path.join(rootDir, 'src/userscript/babel-mods.d.ts');
const userscriptDeclarationOutput = path.join(rootDir, 'dist/userscript/babel-mods.d.ts');
const websiteAppearanceSource = path.join(rootDir, 'src/content/website-appearance.css');
const websiteAppearanceOutput = path.join(rootDir, 'dist/content/website-appearance.css');
const classicAssetsSource = path.join(rootDir, 'assets/classic');
const classicAssetsOutput = path.join(rootDir, 'dist/classic');

await buildClassicEditor();

async function copyClassicAssets() {
  await cp(classicAssetsSource, classicAssetsOutput, { recursive: true });
}

function watchClassicAssets() {
  let pendingCopy = Promise.resolve();
  const enqueueCopy = () => {
    const copy = pendingCopy.then(copyClassicAssets);
    pendingCopy = copy.then(
      () => console.log('Copied Classic editor assets.'),
      (error) => console.error('Failed to copy Classic editor assets:', error)
    );
    return copy;
  };
  watchFileChanges(classicAssetsSource, { recursive: true }, enqueueCopy);
  return enqueueCopy;
}

async function copyUserscriptDeclaration() {
  await mkdir(path.dirname(userscriptDeclarationOutput), { recursive: true });
  await copyFile(userscriptDeclarationSource, userscriptDeclarationOutput);
}

async function copyWebsiteAppearanceStylesheet() {
  await mkdir(path.dirname(websiteAppearanceOutput), { recursive: true });
  await copyFile(websiteAppearanceSource, websiteAppearanceOutput);
}

function watchWebsiteAppearanceStylesheet() {
  let pendingCopy = Promise.resolve();

  function enqueueCopy() {
    const copy = pendingCopy.then(copyWebsiteAppearanceStylesheet);
    pendingCopy = copy.then(
      () => console.log('Copied website appearance stylesheet.'),
      (error) => console.error('Failed to copy website appearance stylesheet:', error)
    );
    return copy;
  }

  watchFileChanges(path.dirname(websiteAppearanceSource), (_eventType, filename) => {
    if (filename !== null && filename !== path.basename(websiteAppearanceSource)) {
      return;
    }

    enqueueCopy();
  });

  return enqueueCopy;
}

const shared = {
  bundle: true,
  minify: false,
  sourcemap: true,
  target: 'chrome114',
  format: 'iife',
  logLevel: 'info'
};

const sharedModule = {
  ...shared,
  format: 'esm'
};

const tasks = [
  {
    ...shared,
    entryPoints: ['src/content/native-performance-entry.ts'],
    outfile: 'dist/content/native-performance-entry.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/classic-performance-entry.ts'],
    outfile: 'dist/content/classic-performance-entry.js'
  },
  {
    ...shared,
    entryPoints: ['src/background/editor-mode.ts'],
    outfile: 'dist/background/editor-mode.js'
  },
  {
    ...shared,
    define: {
      __BABEL_MOD_INTERNALS_VERSION__: JSON.stringify(manifest.version)
    },
    entryPoints: ['src/mod-platform/page-host.ts'],
    outfile: 'dist/content/mod-host.js'
  },
  {
    ...shared,
    entryPoints: ['src/userscript/babel-mods.ts'],
    outfile: 'dist/userscript/babel-mods.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/entry.ts'],
    outfile: 'dist/content/entry.js'
  },
  {
    ...sharedModule,
    entryPoints: ['src/content/lazy-session.ts'],
    outfile: 'dist/content/lazy-session.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/magnifier-bridge.ts'],
    outfile: 'dist/content/magnifier-bridge.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/playback-bridge.ts'],
    outfile: 'dist/content/playback-bridge.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/audio-enhancement-bridge.ts'],
    outfile: 'dist/content/audio-enhancement-bridge.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/audio-enhancement-worker.ts'],
    outfile: 'dist/content/audio-enhancement-worker.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/recovered-editor-bridge.ts'],
    outfile: 'dist/content/recovered-editor-bridge.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/timestamp-bridge.ts'],
    outfile: 'dist/content/timestamp-bridge.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/linter-bridge.ts'],
    outfile: 'dist/content/linter-bridge.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/quick-region-autocomplete-bridge.ts'],
    outfile: 'dist/content/quick-region-autocomplete-bridge.js'
  },
  {
    ...shared,
    entryPoints: ['src/content/waveform-theme-bridge.ts'],
    outfile: 'dist/content/waveform-theme-bridge.js'
  },
  {
    ...shared,
    entryPoints: ['src/popup/popup.ts'],
    outfile: 'dist/popup/popup.js'
  },
  {
    ...shared,
    entryPoints: ['src/options/options.ts'],
    outfile: 'dist/options/options.js'
  }
];

if (watch) {
  const contexts = await Promise.all(tasks.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  const enqueueWebsiteAppearanceCopy = watchWebsiteAppearanceStylesheet();
  const enqueueClassicAssetsCopy = watchClassicAssets();
  await Promise.all([copyUserscriptDeclaration(), enqueueWebsiteAppearanceCopy(), enqueueClassicAssetsCopy()]);
  console.log('Watching extension bundles, website appearance stylesheet and Classic editor assets...');
} else {
  await Promise.all(tasks.map((options) => build(options)));
  await Promise.all([copyUserscriptDeclaration(), copyWebsiteAppearanceStylesheet(), copyClassicAssets()]);
}
