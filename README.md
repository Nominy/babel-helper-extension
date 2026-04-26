# Babel Audio Workflow Helper

Refactored MV3 extension with TypeScript + esbuild and plugin-oriented internal architecture.

## Build

1. Install dependencies:
   - `npm install`
2. Build extension bundles:
   - `npm run build`
3. Load unpacked extension from `babel-helper-extension/` in `chrome://extensions`.

Versioning:
- `npm run build` bumps the patch version, rebuilds, and syncs `babel-helper-extension/` so Chrome's extension card shows a new version after you press Reload.
- `npm run build:reload` is an alias for `npm run build`.
- `npm run version:patch` bumps only `package.json`, `manifest.json`, and `package-lock.json`.

Bundled outputs:
- `dist/content/entry.js`
- `dist/content/magnifier-bridge.js`
- `dist/content/linter-bridge.js`
- `dist/options/options.js`

## Architecture

Source lives under `src/`:
- `core/` runtime/kernel/lifecycle
- `hooks/` DOM + React introspection helpers
- `services/` row/menu/focus/timeline/magnifier services
- `handlers/` keyboard/pointer/route handler adapters
- `features/` plugin modules that consume typed context
- `content/` extension entry points (`entry.ts`, `magnifier-bridge.ts`, `linter-bridge.ts`)

Supporting engineering notes live under:
- `docs/babel-dashboard-snapshot/`

Read these first when working on Babel-specific interactions:
- `docs/babel-dashboard-snapshot/README.md`
- `docs/babel-dashboard-snapshot/extension-engineering.md`

## Behavior

This refactor keeps existing shortcuts and workflow behavior parity while separating concerns for growth:
- hooks
- handlers
- features
- services

Feature settings are available in extension options (`chrome://extensions` -> Babel Audio Workflow Helper -> Extension options). Settings are stored in `chrome.storage.local` and applied on the next dashboard tab reload.

Custom linter notes:
- `Custom Linter` is enabled by default and augments Babel's native lint API response.
- Built-in helper rules currently include:
  - comma formatting: enforce `, ` (comma + single space)
  - incorrect interjection forms: normalize listed malformed spellings to dictionary forms during autofix
- Rule injection bridge lives in `src/content/linter-bridge.ts`.

## Validation

- `npm run typecheck`
- `npm run build`
- `npm run test`

## Deployment

- `npm run build:zip` rebuilds the extension and writes `.artifacts/babel-helper-extension-<version>.zip`.
- The deploy workflow validates, runs `npm run build:zip` (which bumps through `npm run build`), publishes to Chrome Web Store, and commits the bumped version files.
- `.github/workflows/deploy-babel-helper-extension.yml` is a manual deployment workflow. It validates the extension, builds the ZIP, publishes it to the Chrome Web Store, commits the bumped version files back to the selected branch, and then creates or updates the matching GitHub Release asset tagged as `v<version>`.
- Required GitHub Actions secrets:
  - `CWS_CLIENT_ID`
  - `CWS_CLIENT_SECRET`
  - `CWS_REFRESH_TOKEN`
  - `CWS_PUBLISHER_ID`
  - `CWS_EXTENSION_ID`
- Optional GitHub Actions secret:
  - `CWS_ACCESS_TOKEN`
    Use this only as a short-lived fallback. The deploy script prefers refresh-token auth when the client credentials are present.
- For local publishing helpers, keep Chrome Web Store credentials in `.env.cws.local` (ignored by git).
  - Start from `.env.cws.example`.
  - Recommended variables:
    - `CWS_CLIENT_ID`
    - `CWS_CLIENT_SECRET`
    - `CWS_REFRESH_TOKEN`
    - `CWS_ITEM_URL`
  - Optional fallback variable:
    - `CWS_ACCESS_TOKEN`
- To seed GitHub Actions secrets from the local dotenv file, run `node scripts/setup-github-secrets.mjs OWNER/REPO`.
  - The helper loads `.env.cws.local` by default and still accepts the old `data-deploy` format as a fallback.
  - It derives `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID` from `CWS_ITEM_URL` unless those values are already set directly.
  - If `CWS_CLIENT_ID` is missing, the helper can recover it from `CWS_ACCESS_TOKEN`, but storing `CWS_CLIENT_ID` directly in `.env.cws.local` is more reliable.
