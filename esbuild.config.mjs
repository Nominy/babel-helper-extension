import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const rootDir = path.dirname(fileURLToPath(import.meta.url));

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

const tasks = [
  {
    ...shared,
    entryPoints: ['src/content/entry.ts'],
    outfile: 'dist/content/entry.js'
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
    entryPoints: ['src/options/options.ts'],
    outfile: 'dist/options/options.js'
  }
];

if (watch) {
  const contexts = await Promise.all(tasks.map((options) => context(options)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('Watching extension bundles...');
} else {
  await Promise.all(tasks.map((options) => build(options)));
}
