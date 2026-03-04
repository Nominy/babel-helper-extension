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

## Architecture

Source lives under `src/`:
- `core/` runtime/kernel/lifecycle
- `hooks/` DOM + React introspection helpers
- `services/` row/menu/focus/timeline/magnifier services
- `handlers/` keyboard/pointer/route handler adapters
- `features/` plugin modules that consume typed context
- `content/` extension entry points (`entry.ts`, `magnifier-bridge.ts`)

## Behavior

This refactor keeps existing shortcuts and workflow behavior parity while separating concerns for growth:
- hooks
- handlers
- features
- services

## Validation

- `npm run typecheck`
- `npm run build`
- `npm run test`
