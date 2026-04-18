#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const args = parseArgs(process.argv.slice(2));

if (args.flags.has('help')) {
  printHelp();
  process.exit(0);
}

const repo = args.values.get('repo') ?? args.positionals[0];
if (!repo) {
  throw new Error('Missing target repository. Pass OWNER/REPO as the first argument or via --repo.');
}

const dataFilePath = resolve(rootDir, args.values.get('file') ?? 'data-deploy');
const parsed = parseDeployData(await readFile(dataFilePath, 'utf8'));
const extensionTarget = parsed['the extension'];

if (!extensionTarget) {
  throw new Error(`Missing "the extension:" entry in ${dataFilePath}.`);
}

const { publisherId, extensionId } = parseItemUrl(extensionTarget);
const clientSecret = parsed.secret;
const refreshToken = parsed['refresh-token'];
const accessToken = parsed['access-token'];

if (!clientSecret || !refreshToken || !accessToken) {
  throw new Error(
    `Expected "secret:", "refresh-token:", and "access-token:" entries in ${dataFilePath}.`
  );
}

const clientId = parsed['client-id'] ?? (await resolveClientId(accessToken));

const secrets = {
  CWS_CLIENT_ID: clientId,
  CWS_CLIENT_SECRET: clientSecret,
  CWS_REFRESH_TOKEN: refreshToken,
  CWS_ACCESS_TOKEN: accessToken,
  CWS_PUBLISHER_ID: publisherId,
  CWS_EXTENSION_ID: extensionId
};

for (const [name, value] of Object.entries(secrets)) {
  execFileSync('gh', ['secret', 'set', name, '--repo', repo], {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit']
  });
  console.log(`Set ${name} on ${repo}`);
}

console.log('GitHub Actions secrets updated successfully.');

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) {
      positionals.push(entry);
      continue;
    }

    const trimmed = entry.slice(2);
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex >= 0) {
      values.set(trimmed.slice(0, equalsIndex), trimmed.slice(equalsIndex + 1));
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.add(trimmed);
      continue;
    }

    values.set(trimmed, next);
    index += 1;
  }

  return { values, flags, positionals };
}

function printHelp() {
  console.log(`Usage: node scripts/setup-github-secrets.mjs OWNER/REPO [options]

Options:
  --repo OWNER/REPO   Target GitHub repository
  --file PATH         Deployment data file. Defaults to ./data-deploy
  --help              Show this help

The data file must contain:
  secret:
  refresh-token:
  access-token:
  the extension:

Optional:
  client-id:
`);
}

function parseDeployData(source) {
  const result = {};
  let currentKey = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.endsWith(':')) {
      currentKey = line.slice(0, -1).trim().toLowerCase();
      continue;
    }

    if (!currentKey) {
      continue;
    }

    result[currentKey] = line;
    currentKey = null;
  }

  return result;
}

function parseItemUrl(itemUrl) {
  let url;
  try {
    url = new URL(itemUrl);
  } catch (error) {
    throw new Error(`Invalid extension URL in deploy data: ${error instanceof Error ? error.message : String(error)}`);
  }

  const match = url.pathname.match(/\/v2\/publishers\/([^/]+)\/items\/([^/]+)/);
  if (!match) {
    throw new Error(`Unexpected Chrome Web Store item URL: ${itemUrl}`);
  }

  return {
    publisherId: decodeURIComponent(match[1]),
    extensionId: decodeURIComponent(match[2])
  };
}

async function resolveClientId(accessToken) {
  const url = new URL('https://www.googleapis.com/oauth2/v1/tokeninfo');
  url.searchParams.set('access_token', accessToken);

  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      'Unable to recover the OAuth client ID from the current access token. ' +
        'Add a "client-id:" line to data-deploy and retry.\n' +
        JSON.stringify(payload, null, 2)
    );
  }

  const clientId = payload.issued_to;
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error(
      'Google token info did not return "issued_to". Add a "client-id:" line to data-deploy and retry.'
    );
  }

  return clientId;
}
