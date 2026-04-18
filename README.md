# Babel Audio Workflow Helper

Refactored MV3 extension with TypeScript + esbuild and plugin-oriented internal architecture.

## Build

1. Install dependencies:
   - `npm install`
2. Build extension bundles:
   - `npm run build`
3. Load unpacked extension from `babel-helper-extension/` in `chrome://extensions`.

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

- `npm run build:zip` bumps the patch version, rebuilds the extension, and writes `../babel-helper-extension-<version>.zip`.
- `.github/workflows/deploy-babel-helper-extension.yml` is a manual deployment workflow. It validates the extension, builds the ZIP, publishes it to the Chrome Web Store, then commits the bumped version files back to the selected branch so the repo stays in sync with the store.
- Required GitHub Actions secrets:
  - `CWS_CLIENT_ID`
  - `CWS_CLIENT_SECRET`
  - `CWS_REFRESH_TOKEN`
  - `CWS_PUBLISHER_ID`
  - `CWS_EXTENSION_ID`
- Optional GitHub Actions secret:
  - `CWS_ACCESS_TOKEN`
    Use this only as a short-lived fallback. The deploy script prefers refresh-token auth when the client credentials are present.
- To seed those secrets from the local `data-deploy` file, run `node scripts/setup-github-secrets.mjs OWNER/REPO`.
  - The helper derives `CWS_PUBLISHER_ID` and `CWS_EXTENSION_ID` from the stored Chrome Web Store item URL.
  - If the stored access token has already expired, add a `client-id:` line to `data-deploy` before running the helper so it does not need to query Google's token info endpoint.
