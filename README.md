# Babel Audio Workflow Helper

## Install and build

Requires Node.js 22.14+ and the shared platform at `../shared/babel-extension-platform`. Initialize the parent checkout with `git submodule update --init --recursive`; for a standalone checkout, clone `https://github.com/Nominy/babel-extension-platform.git` to that sibling path.

From this directory:

```sh
npm --prefix ../shared/babel-extension-platform ci
npm ci
npm run build
```

Load `babel-helper-extension/` unpacked in `chrome://extensions`. After rebuilding, reload the extension and refresh the Babel dashboard tab.

`build` bumps the patch version, writes `dist/`, and syncs the unpacked folder. To rebuild without changing versions:

```sh
npm run build:core
npm run sync:unpacked
```

## Configurable shortcuts

Open the extension settings and select **Shortcuts** to open its dedicated submenu. All 28 Helper action shortcuts retain their original defaults until changed. Record a replacement, add an alternative, clear an action to disable its shortcut, or restore individual/all defaults. Changes save automatically and apply to open dashboard sessions; shortcut help and appearance hints use the saved bindings.

Recording prompts and results appear inside the action's row; the active recording button becomes **Cancel recording**. The recorder supports right-Shift combinations. Escape and Tab can be assigned; cancel with that inline button or by tapping and releasing a modifier alone. Conflict warnings are informational because some defaults intentionally share keys in different contexts.

These settings cover Helper keyboard actions, not native Babel/browser shortcuts, ordinary text editing, or mouse gestures. Browser/OS-reserved combinations may never reach the page. Auto-insert still defaults to `Alt+C`, now handled by the same configurable page input path rather than a separately reserved Chrome command.

## Audio boundary threshold

By default, `Alt+R`, `Alt+Shift+R`, and the final trim after `Alt+C` use the same silence threshold as `Alt+Shift+S`. Inward and outward trimming share that threshold and retain decoded-audio precision when available. Coarse speech-island scanning, boundary padding, and outward scan steps are unchanged.

## Checks

```sh
npm run typecheck
npm test
npm run test:e2e:native
```

The browser command requires the [shared browser setup](../shared/babel-extension-platform/README.md#browser-checks).

## Package and publish

```sh
npm run build:zip                     # rebuilds and bumps the version
npm run build:zip -- --no-build       # package existing dist/ without a bump
```

Output: `.artifacts/babel-helper-extension-<version>.zip`. `BABEL_EXTENSION_ZIP_DIR` overrides the output directory; `BABEL_EXTENSION_ZIP_PATH` overrides the full path. Relative paths resolve from this directory.

Commit the release version in `manifest.json`, `package.json`, and `package-lock.json`; `npm run version:patch` bumps them without building. CI does not bump versions. The version must exceed the store's published and submitted versions.

Push to `main` creates a GitHub prerelease `v<version>`. To publish, manually run `.github/workflows/deploy-babel-helper-extension.yml` on that commit with `version=<version>` and `confirm=PUBLISH <version>`. The tag must still be a prerelease pointing at the selected commit. `publish_type` defaults to `STAGED_PUBLISH`; `replace_pending_submission` cancels a pending review. A successful publish promotes the prerelease.

Required Actions secrets: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`. Optional short-lived fallback: `CWS_ACCESS_TOKEN`.

For local publishing, copy `.env.cws.example` to ignored `.env.cws.local` and fill the credentials. Seed repository secrets with `node scripts/setup-github-secrets.mjs OWNER/REPO`; publish locally with `npm run publish:cws`.
