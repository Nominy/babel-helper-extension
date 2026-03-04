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
- Rule injection bridge lives in `src/content/linter-bridge.ts`.

## Validation

- `npm run typecheck`
- `npm run build`
- `npm run test`
