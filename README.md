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
- `dist/content/waveform-theme-bridge.js`
- `dist/options/options.js`
- `dist/content/website-appearance.css`

## Architecture

Source lives under `src/`:
- `core/` runtime/kernel/lifecycle
- `hooks/` DOM + React introspection helpers
- `services/` row/menu/focus/timeline/magnifier services
- `handlers/` keyboard/pointer/route handler adapters
- `features/` plugin modules that consume typed context
- `content/` extension entry points and dashboard-authored styles, including `website-appearance.css`

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

Feature settings are available in extension options (`chrome://extensions` -> Babel Audio Workflow Helper -> Extension options) and stored in `chrome.storage.local`.

Website Appearance:
- Applies only to `https://dashboard.babel.audio/*`; it does not style the extension Settings page. The manifest remains storage-only and does not request broader host access.
- On a Babel dashboard page, press `Alt + Shift + P` to open or close the on-page live editor. The shortcut also works while focus is inside the editor; press `Escape` or use Close to dismiss it.
- Changes preview immediately on the dashboard and persist in `chrome.storage.local` as controls are changed or the editor is closed. `Reset appearance` restores the complete default record.
- Everything is strictly opt-in. There are five switches — the master `Enable custom appearance` plus `Text`, `Theme`, `Gradient`, and `Expert CSS` — and all five default to off, so a fresh install renders the dashboard exactly as Babel ships it. Nothing is applied unless the master switch **and** that section's switch are both on; turning a section back off removes its styling and restores the native look. `Gradient`, `Expert CSS`, and theme sharing live under `Advanced`, which unfolds itself whenever a live gradient or expert stylesheet is in play.
- `Text` is two independent px dials, `Editor` (`10`–`30`, default `12`) for the transcript textarea and compact transcript text and `Table` (`10`–`30`, default `12`) for transcript table cells and the dashboard's `.text-xs` labels. Both defaults match the `text-xs` size Babel already ships, so enabling the section with untouched dials is visually neutral. Each size drives its own variable (`--bh-text-size`, `--bh-table-text-size`) with a matching line height, and never widths, padding, wrapping, resize behavior, or row heights.
- `Theme` is one core palette — thirteen scalar colors plus three speaker colors — and nothing else is stored. Every `--bh-*` variable and every app design token is derived from these entries at runtime:

| Dial | Field | Default | Drives |
| --- | --- | --- | --- |
| `Page` | `pageColor` | `#f8fafc` | the page canvas behind the app (`--bh-page`, `--background`) |
| `Surface` | `surfaceColor` | `#ffffff` | panels, cards, toolbars, popovers, sidebar (`--bh-surface`, `--card`, `--popover`, `--sidebar`, `--muted`, `--secondary`, `--accent`), and the base for the raised and hover surfaces |
| `Text` | `textColor` | `#0f172a` | body text (`--bh-text` and the six foreground tokens), the waveform cursor, and the mix partner for raised/hover surfaces and the scrollbar thumb |
| `Muted` | `mutedTextColor` | `#64748b` | secondary labels and hints (`--bh-muted`, `--muted-foreground`) |
| `Accent` | `accentColor` | `#2563eb` | primary buttons, the active toolbar state, focus rings (`--bh-accent`, `--primary`, `--ring`, `--sidebar-ring`) |
| `Accent text` | `accentTextColor` | `#ffffff` | text on accent and destructive fills (`--bh-accent-text`, `--primary-foreground`, `--destructive-foreground`) |
| `Border` | `borderColor` | `#e2e8f0` | hairlines, inputs, sidebar edges (`--bh-border`, `--border`, `--input`, `--sidebar-border`), and the base for the scrollbar thumb |
| `Waveform` | `waveColor` | `#94a3b8` | the unplayed wave, shared by every lane (`--bh-wave`) |
| `Active row` | `activeRowColor` | `#f1f5f9` | the fill of the active or selected transcript row (`--bh-active-row`) |
| `Active row text` | `activeRowTextColor` | `#0f172a` | the text of that row (`--bh-active-row-text`) |
| `Danger` | `dangerColor` | `#dc2626` | error dots, removed diff text, the app's destructive token (`--bh-danger`, `--bh-danger-tint`, `--destructive`) |
| `Warning` | `warningColor` | `#d97706` | warning dots and changed diff rows (`--bh-warning`, `--bh-warning-tint`) |
| `Success` | `successColor` | `#16a34a` | clean-lint dots and added diff text (`--bh-success`, `--bh-success-tint`) |
| `Speaker 1`–`Speaker 3` | `speakerColors` | `#64b5f6`, `#b083ff`, `#38bdf8` | per-lane frame, speaker-cell text, playback progress, and region fill and edges (`--bh-speaker-1..3`, `--bh-speaker-1-tint..3-tint`) |

- Derived, never stored: a raised surface is `Surface` pulled `5%` toward `Text` (`--bh-surface-raised`) and a hover surface pulls it `8%` (`--bh-surface-hover`); a status tint is that status color dropped `88%` of the way onto `Surface` (`--bh-danger-tint`, `--bh-warning-tint`, `--bh-success-tint`); a speaker tint is that speaker color at `0.25` alpha; the scrollbar thumb is `Border` nudged `15%` toward `Text` (`--bh-scrollbar-thumb`) so it stays visible at both ends of the lightness range, while the scrollbar track and corner take `Surface`. Mixes run in sRGB, per channel, so the same palette always produces the same declarations and a disable restores the page byte for byte.
- Root attributes carry the switches: `data-babel-helper-appearance` (master), plus `-text`, `-theme`, `-gradient`, and `-gradient-speed`. Every variable and attribute is captured before it is written and restored on the way out, and the stylesheet gates each rule on the master attribute plus the attribute of the section that owns it. Selectors stay in `:where()` so they never out-rank the app's own rules, they claim colors only — never geometry — and `!important` appears only where the app writes the value inline.
- App design tokens: the dashboard is a shadcn/Tailwind app that resolves its colors as `hsl(var(--token))` at the point of use, so overriding those variables recolors every component that consumes them — surfaces with no stable class or role, widgets this extension has never seen, portals rendered outside `main`. That is coverage no selector list can reach. The tokens ride the `Theme` switch instead of having one of their own: one palette paints both the extension's own rules and the app's native token surface, so a token can never drift away from the color it was derived from. Because the app wraps each token in `hsl()`, the written values are bare space-separated HSL triplets such as `222 47% 11%`, converted from the hex palette at apply time; an `hsl()` triplet carries no alpha, so token surfaces are opaque. Tokens outside the map stay native, including `--sidebar-accent` and `--sidebar-accent-foreground`, so the sidebar keeps its own hover accent.
- Speaker lanes: the dashboard colors lanes from a fixed three-entry palette indexed by lane order, so speaker colors persist as exactly three slots and lane N takes slot `((N - 1) mod 3) + 1`. The app's lane keys are per-task, so a speaker's identity cannot be stored across tasks; lane order is the stable user-facing concept, which is why the dials are labeled `Speaker 1` through `Speaker 3`.
  - Wavesurfer paints the wave into a canvas and the regions plugin writes inline styles inside a shadow root, so CSS cannot reach either. The page-world bridge `dist/content/waveform-theme-bridge.js` is injected only while the master and `Theme` switches are both on, and it drives the live instances directly: the shared `Waveform` color as the wave, the lane's speaker color as progress and as both region colors (the fill reproduced at the app's own `0.25` alpha), and `Text` as the cursor so it stays visible against the palette. Every value it overwrites is captured first and restored when the section goes off or the bridge tears down. The active-region highlight is a separate `filter: brightness(0.8)` the bridge never reads or writes, so a recolored region still darkens when it becomes active.
  - The bridge resolves lane order from the app's own track list, falling back to the DOM order of visible lanes, and stamps `data-babel-helper-lane-index` (1-based), `data-babel-helper-lane-slot`, and `data-babel-helper-speaker-label` on the Wavesurfer host, on the lane root that carries the app's inline frame border, and on the transcript speaker cells it can attribute to a lane. The stylesheet keys off the slot stamp and never repeats that arithmetic; a label it cannot read is simply omitted. CSS owns exactly the two lane colors it can reach — the lane frame's side borders and the speaker cell's text, both from `--bh-speaker-N`. The app writes both inline (`border-left`/`border-right: 2.5px solid` on the frame, `color` on the cell), so these are the one place a light-DOM rule needs `!important`, and it claims the two side colors and the text color only, never the `2.5px` width, the border style, or any geometry.
- The active-row pair is the fix for unreadable selected rows. The app marks the active or selected row with `bg-neutral-100 ring-1 ring-neutral-300` (or `bg-green-50 ring-1 ring-green-300`) and never changes that row's text color, so a dark palette used to leave the selected row's own text stranded on a light fill. `Active row` and `Active row text` claim the fill and the text together, so the row that has focus stays the most readable row on the page.
- `Gradient`: three colors (defaults `#0f766e`, `#2563eb`, `#0f766e`), an angle (`0`–`360` in `15` degree steps, default `135`), and a speed (`Slow`, `Balanced`, `Fast`, mapped to `24s`, `14s`, `8s`). The colors, angle, and duration ride `--bh-gradient-color-1..3`, `--bh-gradient-angle`, and `--bh-gradient-duration`, and `prefers-reduced-motion: reduce` keeps the gradient static.
- `Expert CSS`: an optional custom stylesheet, injected as one page-level `<style>` element (`#babel-helper-website-custom-css`, tagged `data-babel-helper-owner`) and gated on the master switch plus this section's switch, so it is removed the moment either goes off. It carries no scope of its own — a rule reaches whatever it selects — so validation is the guard rail: drafts longer than `50,000` characters, `@import`, the resource functions `url()`, `src()`, `image()`, and `image-set()`, embedded `<style>` tags, unbalanced `{}`/`[]`/`()`, unclosed comments or strings, unescaped line breaks in strings, and incomplete escapes are all rejected. An invalid draft stays editable and reports why, but is not applied. Disable `Expert CSS`, clear the draft, or reset the appearance to recover from rules that hide or move dashboard controls.
- Theme sharing: the `Theme sharing` block shows a read-only `Share string` for the current draft with a `Copy` button (if the clipboard is blocked the string is selected instead so it can be copied by hand), plus a paste field and `Import`. A share string is `wa1.` followed by base64url JSON of the whole normalized appearance record — all five switches, the two text sizes, the full palette, the three speaker colors, the gradient, and the Expert CSS draft — mirroring the ghost-cursor `gc1.` codec. `encodeWebsiteAppearanceShare` and `decodeWebsiteAppearanceShare` live in `src/core/settings.ts`; decoding returns `null` for anything that is not a `wa1.` string or does not parse, and otherwise normalizes, so a string written by another version imports cleanly with unknown keys dropped and missing ones defaulted.
- Themes travel as `wa1.` share strings rather than shipping with the extension: a complete look — a dark one included — is authored once in the panel, copied out, and pasted into `Import`, which lands the whole normalized record at once, switches and all, so the string's author decides which sections come on and the palette arrives exactly as it was written. An import previews immediately and persists like any other change, so `Reset appearance` undoes it.
- Appearance records saved before the palette existed are detected by any pre-palette key (an old group flag, a retired per-surface dial, `textSizePercent`, `gradientPalette`, or the `lanes` tuple) and come back as text theming only: `Text` on, `Theme`, `Gradient`, and `Expert CSS` off. A stored editor text size is kept and clamped into `10`–`30`; an old text size percentage is still converted with the existing `15 * percent / 100` formula and then clamped into the same range; a missing table text size falls back to its `12` px default. Only the colors that map one-to-one survive — `pageBackgroundColor` to `Page`, plus the old surface, text, muted, and border colors, and `primaryColor`/`accentColor` and `primaryTextColor` to `Accent` and `Accent text`. Every other palette entry resets to its new default rather than guessing an equivalent out of the retired group model, and the old seven-dial lane tuples are dropped for the same reason.

Custom linter notes:
- `Custom Linter` is enabled by default and augments Babel's native lint API response.
- Built-in helper rules currently include:
  - comma formatting: enforce `, ` (comma + single space)
  - incorrect interjection forms: normalize listed malformed spellings to dictionary forms during autofix
- highlighted words: add Babel-native warning rows for configured words or phrases
- The highlighted words dictionary is editable in extension options and defaults to the built-in list in `src/core/highlighted-words.ts`. Highlighted-word warnings are injected into Babel's native warning list; Babel's own warning click handler controls the yellow/green state, while the helper strips the helper-only asserted warning from outgoing save/lint payloads and restores task-scoped clearance from local storage.
- Rule injection bridge lives in `src/content/linter-bridge.ts`.

## Validation

- `npm run typecheck`
- `npm run build:core` (builds without bumping the extension version or syncing unpacked files)
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
