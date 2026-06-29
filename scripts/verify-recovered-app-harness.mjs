import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const babelRoot = path.resolve(repoRoot, '..');
const RECOVERED_APP_RELATIVE_PATH = 'tools/babel-editor-rebuild/app';
const recoveredAppDir = path.join(babelRoot, RECOVERED_APP_RELATIVE_PATH);
const BABEL_ROW_TEXTAREA_SELECTOR = 'textarea[placeholder="What was said…"]';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const port = readPort(args) ?? 5177;

const requiredArtifacts = [
  'src/recovered/RecoveredBabelApp.tsx',
  'src/recovered/fixture/final.json',
  'src/recovered/mockReviewAction.ts',
  'public/babel-fixture/speaker_1.wav',
  'public/babel-fixture/speaker_2.wav',
  'package.json'
];

function readPort(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--port' && argv[index + 1]) {
      const parsed = Number(argv[index + 1]);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (value.startsWith('--port=')) {
      const parsed = Number(value.slice('--port='.length));
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

async function assertFile(relativePath) {
  const absolutePath = path.join(recoveredAppDir, relativePath);
  const stats = await fs.stat(absolutePath).catch(() => null);
  if (!stats || !stats.isFile()) {
    throw new Error(`Recovered Babel app artifact is missing: ${path.join(RECOVERED_APP_RELATIVE_PATH, relativePath)}`);
  }
}

async function assertRecoveredSource() {
  const source = await fs.readFile(path.join(recoveredAppDir, 'src/recovered/RecoveredBabelApp.tsx'), 'utf8');
  if (!source.includes('RecoveredBabelApp')) {
    throw new Error('RecoveredBabelApp source no longer exports the recovered app shell.');
  }
}

async function verifyArtifacts() {
  const stats = await fs.stat(recoveredAppDir).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    throw new Error(`Recovered Babel app directory is missing: ${RECOVERED_APP_RELATIVE_PATH}`);
  }

  await Promise.all(requiredArtifacts.map((relativePath) => assertFile(relativePath)));
  await assertRecoveredSource();
}

function startRecoveredApp() {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawn(command, ['run', 'dev', '--', '--port', String(port)], {
    cwd: recoveredAppDir,
    env: {
      ...process.env,
      BROWSER: 'none'
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Recovered Babel app did not become ready at ${url}: ${lastError?.message || 'timeout'}`);
}

async function verifyWithBrowser() {
  const { chromium } = await import('playwright-core');
  const url = `http://127.0.0.1:${port}`;
  const server = startRecoveredApp();
  const output = [];
  server.stdout.on('data', (chunk) => output.push(String(chunk)));
  server.stderr.on('data', (chunk) => output.push(String(chunk)));

  let browser = null;
  try {
    await waitForHttp(url);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector(BABEL_ROW_TEXTAREA_SELECTOR, { timeout: 15000 });
    const snapshot = await page.evaluate((selector) => {
      const textareas = Array.from(document.querySelectorAll(selector));
      const rows = textareas
        .map((textarea) => textarea.closest('tr'))
        .filter(Boolean);
      return {
        title: document.title,
        rows: rows.length,
        textareas: textareas.length
      };
    }, BABEL_ROW_TEXTAREA_SELECTOR);

    if (!snapshot.rows || !snapshot.textareas) {
      throw new Error('Recovered Babel app rendered, but no transcript rows matched the recovered selector.');
    }

    console.log(JSON.stringify({
      ok: true,
      mode: 'browser',
      app: RECOVERED_APP_RELATIVE_PATH,
      component: 'RecoveredBabelApp',
      selector: BABEL_ROW_TEXTAREA_SELECTOR,
      snapshot
    }, null, 2));
  } catch (error) {
    if (output.length) {
      console.error(output.join('').slice(-4000));
    }
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
    server.kill();
  }
}

await verifyArtifacts();

if (dryRun) {
  console.log(JSON.stringify({
    ok: true,
    mode: 'dry-run',
    app: RECOVERED_APP_RELATIVE_PATH,
    component: 'RecoveredBabelApp',
    selector: BABEL_ROW_TEXTAREA_SELECTOR,
    artifacts: requiredArtifacts.length
  }, null, 2));
} else {
  await verifyWithBrowser();
}
