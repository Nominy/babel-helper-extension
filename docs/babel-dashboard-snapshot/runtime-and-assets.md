# Runtime And Asset Inventory

## Source

Observed from:
- `decompiles/Babel Audio - Global Conversational Platform.html`
- files under `decompiles/Babel Audio - Global Conversational Platform_files/`

This is a browser-generated asset dump, not a clean source checkout. Filenames are whatever the browser saved, including some vendor ids and the `Без названия` suffix.

## Runtime Architecture

High-confidence inference:
- This is a Next.js App Router build using the `_N_E` webpack runtime.

Evidence:
- `self.webpackChunk_N_E`
- `_N_E` runtime bootstrap
- `main-app-...` entry
- `polyfills-...` bundle
- streamed `self.__next_f.push(...)` payloads in the saved HTML

What that means for extensions:
- The DOM is React-controlled.
- Re-renders can replace nodes at any time.
- Menus and dialogs are often rendered through portals.
- Generated ids and many class names are not stable contract points.

## Asset Categories

### First-Party App Runtime

These are the highest-value files when reverse-engineering behavior.

| File | Likely role | Confidence |
| --- | --- | --- |
| `webpack-27572af3f5b887b4.js.Без названия` | Webpack/Next.js loader runtime | High |
| `main-app-eafd3b4b3407ccb0.js.Без названия` | Next.js app bootstrap entry | High |
| `polyfills-42372ed130431b0a.js.Без названия` | Browser polyfills | High |
| `4265-a5130d3a167bfd8d.js.Без названия` | App/vendor chunk loaded by runtime | High |
| `bc1df455-32a8c9d27092e560.js.Без названия` | App/vendor chunk loaded by runtime | High |

Notes:
- `main-app-...` is only a small bridge that pushes a webpack chunk and schedules additional modules.
- `webpack-...` contains chunk loading and script injection logic.
- The hashed chunk files are where the actual app logic is likely concentrated, but they remain minified.

### App / Framework CSS

| File | Likely role | Confidence |
| --- | --- | --- |
| `105f718885f3997a.css` | Main app CSS chunk, large utility/style payload | High |
| `186593a2addc4ff8.css` | Font-face bundle (TikTok Sans) | Medium |
| `80cf67a7af72320f.css` | Font-face bundle (Inter) | Medium |
| `f2f58bddd9c92338.css` | Small component/widget CSS chunk | Medium |

Notes:
- The DOM uses Tailwind-like classes heavily, and the CSS split matches Next.js chunked styles.
- These styles are part of the app build, not standalone third-party libraries.

### Authentication / Messaging / Product SDKs

| File | Likely role | Confidence |
| --- | --- | --- |
| `clerk.browser.js.Без названия` | Clerk auth browser SDK | High |
| `wy4wyjld` | Intercom loader script | High |
| `saved_resource(1).html` | Saved Intercom iframe document | High |
| `saved_resource.html` | Minimal saved iframe/resource stub | Medium |

Observed from HTML:
- Clerk publishable key is embedded in the page.
- Intercom frame is present in the DOM.

Implications:
- Auth state is likely managed by Clerk.
- Support chat/help overlays may appear asynchronously.
- Extensions should avoid brittle assumptions when overlays are open.

### Google Maps / Places

| File | Likely role | Confidence |
| --- | --- | --- |
| `places.js.Без названия` | Google Maps Places API module | High |
| `main.js.Без названия` | Google Maps core module | High |
| `common.js.Без названия` | Google Maps shared module | High |
| `util.js.Без названия` | Google Maps utility module | High |
| `config.js.Без названия` | Google Maps config bootstrap | High |
| `js(1)` | Additional Google Maps script payload | High |

Observed:
- The HTML loads the Maps API with `libraries=places`.

Inferred:
- Some part of the dashboard or broader app uses address/autocomplete UI.
- This is not directly relevant to the transcription workbench DOM shown in the snapshot.

### Analytics / Tracking / Session Capture

The saved page includes a heavy analytics stack.

| File | Likely role | Confidence |
| --- | --- | --- |
| `gtm.js.Без названия` | Google Tag Manager container | High |
| `js` | Google tag/measurement script resource | High |
| `fbevents.js.Без названия` | Meta Pixel library | High |
| `25825097737149217` | Saved Meta Pixel payload named by pixel id | High |
| `pixel.js.Без названия` | Reddit Pixel | High |
| `bat.js.Без названия` | Microsoft/Bing UET base tag | High |
| `343232315` | UET-related helper payload | Medium |
| `343232315.js.Без названия` | UET-related helper script | Medium |
| `insight.min.js.Без названия` | LinkedIn Insight tag | High |
| `0.8.55` | Clarity-style analytics/session script | Medium |
| `posthog-recorder.js.Без названия` | PostHog recorder | High |
| `dead-clicks-autocapture.js.Без названия` | PostHog autocapture module | High |
| `exception-autocapture.js.Без названия` | PostHog exception capture | High |
| `surveys.js.Без названия` | PostHog surveys module | High |
| `web-vitals.js.Без названия` | Performance metrics helper | Medium |

Extension implications:
- User interactions may be tracked.
- Synthetic clicks and keyboard events can produce analytics noise.
- If you want your extension to be "quiet," favor minimal event emission and reuse existing controls rather than simulating unusual interaction sequences.

### Empty / Noise Files

| File | Likely role | Confidence |
| --- | --- | --- |
| `0` | Empty beacon response or placeholder | Medium |
| `0(1)` | Empty beacon response or placeholder | Medium |

These can be ignored for extension work.

## HTML Boot Sequence Notes

Observed in the saved HTML:
- CSS links are loaded before the main app scripts.
- The page includes inline `self.__next_f.push(...)` flight data.
- The HTML body is already populated with server-rendered markup and then hydrated client-side.

Inferred:
- The app likely uses server components plus client boundaries.
- Some product modules may not exist in the static HTML until hydration completes.

Why this matters:
- A content script should tolerate incomplete DOM on `document_idle`.
- Mutation observers are useful for portal-based menus/dialogs and late-loaded widgets.

## Third-Party Noise In The DOM

Observed:
- The saved DOM includes a `veepn-lock-screen` element injected by a browser extension at capture time.

This is not part of Babel.

Rule:
- Ignore any `veepn-*` nodes when building selectors or docs about the product itself.

## What We Can And Cannot Learn From These Assets

We can learn:
- Framework stack
- Visible controls
- Accessible labels
- Presence of vendors
- General interaction model

We cannot learn with confidence:
- The exact internal React component names for the transcription page
- The original TypeScript source
- API endpoints, request payloads, and auth contracts
- Reducer/store structure
- Full route tree of the real app

## Fast Triage For Future Reverse-Engineering

If you want to go deeper later, inspect in this order:
1. Saved HTML for current visible DOM and labels
2. `webpack-...` for runtime assumptions
3. `main-app-...` for initial entry dependencies
4. Large hashed chunks (`4265...`, `bc1df...`) for app logic
5. CSS chunks only when you need layout/styling constraints

Avoid spending time first on:
- analytics scripts
- empty files
- Google Maps bundles unless the task actually touches maps/places
