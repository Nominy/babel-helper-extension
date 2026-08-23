import { watch as watchFileChanges } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(rootDir, 'manifest.json'), 'utf8'));
const userscriptDeclarationSource = path.join(rootDir, 'src/userscript/babel-mods.d.ts');
const userscriptDeclarationOutput = path.join(rootDir, 'dist/userscript/babel-mods.d.ts');
const websiteAppearanceSource = path.join(rootDir, 'src/content/website-appearance.css');
const websiteAppearanceOutput = path.join(rootDir, 'dist/content/website-appearance.css');

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

const fsShimPlugin = {
  name: 'fs-browser-shim',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^fs$/ }, () => ({
      path: path.join(rootDir, 'src/build/fs-browser-shim.js')
    }));
  }
};

const shared = {
  bundle: true,
  minify: false,
  sourcemap: true,
  target: 'chrome114',
  format: 'iife',
  logLevel: 'info',
  banner: {
    js: 'var __dirname = typeof __dirname === "string" ? __dirname : "/virtual";'
  },
  plugins: [fsShimPlugin]
};

const sharedModule = {
  ...shared,
  format: 'esm',
  banner: {}
};

const tasks = [
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
    ...shared,
    entryPoints: ['src/background/commands.ts'],
    outfile: 'dist/background/commands.js'
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
    banner: {},
    entryPoints: ['src/content/waveform-theme-bridge.ts'],
    outfile: 'dist/content/waveform-theme-bridge.js'
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
  await Promise.all([copyUserscriptDeclaration(), enqueueWebsiteAppearanceCopy()]);
  console.log('Watching extension bundles and website appearance stylesheet...');
} else {
  await Promise.all(tasks.map((options) => build(options)));
  await Promise.all([copyUserscriptDeclaration(), copyWebsiteAppearanceStylesheet()]);
}
