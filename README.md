# Babel Audio Workflow Helper

## Install and build

Requires Node.js 22.14+ and the shared platform at `../shared/babel-extension-platform`. Initialize the parent checkout with `git submodule update --init --recursive`; for a standalone checkout, clone `https://github.com/Nominy/babel-extension-platform.git` to that sibling path.

From this directory:

```sh
npm --prefix ../shared/babel-extension-platform ci
npm ci
npm run build
```

Load `babel-helper-extension/` unpacked in `chrome://extensions`. Run `npm run build` whenever you want to rebuild that same folder, then reload the extension and refresh the Babel dashboard tab. Nothing watches or rebuilds automatically.

`build` preserves the version. Use `npm run version:patch` explicitly when preparing a new release. The manifest includes the official public identity key so the unpacked Helper can connect to Gold's broker.

## Automatic ZipEnhancer audio

**ZipEnhancer audio** requires matching Gold Drafting and **Review Grader 0.1.1 or newer**, both installed and enabled. Without the pinned Grader addon, there is no enhancement toolbar/settings row, audio bridge or enhancement initialization; unrelated Helper features continue normally. The preference defaults to enabled once Grader grants access through an authenticated extension port. Once both native speaker tracks load, Gold enhances them with hardware WebGPU or, on unsupported hardware and a cache miss, uploads both Original WAVs to a compatible remote swarm GPU. The UI identifies this off-device processing before upload; participating workers must be trusted with the audio. Disable Automatic Audio Enhancement to prevent uploads. No CPU inference fallback, OpenRouter key or C-denoise/ASR bundle is required. A verified cache hit performs neither inference nor upload.

The toolbar has one **Enhanced → Original** strength slider with **10-percentage-point detents**. Left is 100% Enhanced; right is byte-exact Original; intermediate positions linearly mix the retained recordings. Dragging only previews the snapped value; release commits one latest selection. Keyboard arrows move one detent, Home/End choose endpoints, and a 200ms release debounce prevents repeated reloads. Keyboard interaction cannot trigger Babel row navigation or seek. Cancelled gestures, task changes, disable, and teardown discard pending selections. The committed blend owns waveforms, playback, audio-boundary tools and Gold/Helper L0 capture. Transport, regions, transcript and selection survive paired reloads; choosing Original before enhancement finishes prevents a late result from overriding it.

Changing strength never reruns the model. Endpoints reuse exact retained WAV bytes; intermediate output is mono PCM16 at the Original sample rate/frame count, with no gain normalization or extra gate. Original and Enhanced stay retained; only one committed mixed pair is kept in memory (plus temporary preparation/rollback resources), and mixed variants are not written to the persistent one-pair model cache. More Original brings back suppressed speech **and** noise/echo; the model changes phase, so linear blending can also cancel some components. Strength is a listening/recognition tradeoff, not a retuned neural model.

The single-row control is **36px high**, matching the theme button, with a stable 360px footprint, fixed percentage/status slots and a thin in-place progress bar. Idle, model preparation, native switching, ready and long errors do not reflow the toolbar or editor. The **i / !** details button opens complete status, errors, inference counts and elapsed time in a scrollable native popover outside layout. Progress uses completed GPU windows, not elapsed-time estimates. A strength commits only after both native players finish loading; sequential lane decodes keep Babel's cross-lane zoom callbacks away from empty buffers.

Native region-created/editing registration remains enabled during source changes. Current annotation membership, region metadata, and selection are reconciled after native rebuilding, so prior splits/text edits are not replaced by a stale ready callback. Verified editing paths include **Alt-drag → S** cuts with text preserved once, native Ctrl/Meta-click splitting, text editing, and region resizing after automatic enhancement and both source switches.

Gold's extension-local IndexedDB retains **one completed recording pair**, not a history. Both original source byte hashes, stable recording IDs, and the model graph hash identify it. A different pair/model replaces the entry; only both complete, verified enhanced WAVs can commit together. Cache hits skip model initialization and inference and show **reusing the locally cached pair**. Corrupt/evicted entries become fresh misses. Storage/quota failures are visible cache warnings while valid enhanced audio remains usable. No API keys, transcript text, labels, or duplicate original audio are stored in this cache. Real refresh reuse for the tested minute-long pair took about 1.6 seconds; full browser and offscreen-worker restart reuse were also verified.

Every nonzero strength has a stable model/source/mix identity; timing and draft caches cannot reuse another strength's recognition result. Original keeps its existing canonical identity. Committed selection—not a held thumb preview—owns capture and replacement guards. Stale task results cannot commit, and a failed second lane restores the prior full or mixed pair. Disabling the feature restores Original. Disabling/removing Review Grader also aborts active work, restores Original and removes the enhancement toolbar, settings row and page bridge. Re-enabling Grader restores access without a refresh and preserves the saved preference.


## Word-timed ghost cursor

With Gold's current-task word timing available, the ghost cursor and Alt-click seeking use absolute word timestamps. Helper resolves visible speaker labels through Gold's task-scoped recording metadata, so UUID-named timing tracks work without access to page-world React internals. Stale or ambiguous mappings are not used. The cursor falls back to proportional positioning when no usable current-task timing or matching word anchors exist.

Owned strength changes briefly hide/freeze the same ghost cursor instead of treating the native players' temporary pause as a real stop. Stale playback reads cannot stop a newly committed cursor. Same-task row remounts and equal-shaped native speaker filters resolve current DOM rows. A settled real pause, task navigation, or teardown disposes the cursor; the ghost never resumes transport itself.

Word timing retains Original and one latest nonzero-strength timing set for the current task/recording identity. Exact-strength pins take precedence for playback. When only one strength has been timed, the ghost and word-click seeking can project its absolute word clocks onto another blend of the bridge-verified same-clock pair. `pairedVariantKey` binds timing to the full Enhanced model/source pair; intermediate ASR identities remain distinct, and projected playback pins never populate another strength's ASR cache. Replaced pairs, task changes, missing clock proof, and teardown cannot borrow stale timing. Verified in the reconstructed native editor: held drag/keys leave audio unchanged, each release commits once, all mixed PCM samples match the blend formula, real Gold capture hashes match the selected mix, exact endpoint bytes remain intact, S splitting preserves text once after mixed loading, and the timed ghost/Escape caret survive 100% → 65% → Original → 25% → Original without republishing timing.

**Alt+Shift+S** checks existing current-task word clocks before contacting the timing broker. Verified same-clock pair timestamps can guide text allocation at another strength while silence detection continues to use the selected waveform. If timing arrives during pending broker admission, it is consumed immediately and that admission is cancelled; task/source changes end the wait. Verified in the native editor with genuine deployed timestamps at 50% strength: timing preparation took about 2ms, no broker connection was made, and the full trim/merge/timestamp-based text allocation completed. Missing or foreign-task timestamps do not bypass provider/ownership checks.

## Configurable shortcuts

Open the extension settings and select **Shortcuts** to open its dedicated submenu. Helper action shortcuts retain their original defaults until changed. Record a replacement, add an alternative, clear an action to disable its shortcut, or restore individual/all defaults. Changes save automatically and apply to open dashboard sessions; shortcut help and appearance hints use the saved bindings.

Recording prompts and results appear inside the action's row; the active recording button becomes **Cancel recording**. The recorder supports right-Shift combinations. Escape and Tab can be assigned; cancel with that inline button or by tapping and releasing a modifier alone. Conflict warnings are informational because some defaults intentionally share keys in different contexts.

These settings cover Helper keyboard actions, not native Babel/browser shortcuts, ordinary text editing, or mouse gestures. Browser/OS-reserved combinations may never reach the page. Auto-insert still defaults to `Alt+C`, now handled by the same configurable page input path rather than a separately reserved Chrome command.

## е/ё spelling linter

Added in **1.0.275**. **Custom Linter → Manage rules → Unnecessary ё** is enabled by default. It reports the native error **“ё written in a word without meaning changes. Use е instead.”** and highlights affected words.

Use **Alt + F** to fix the current segment or **Alt + Shift + F** to fix all segments (or your configured replacements). The fix changes non-exception `ё`/`Ё` to `е`/`Е`; it never inserts `ё`. Disabling the rule disables both its errors and its autofix. Detection alone does not rewrite text.

The bundled 4,762-form exception set preserves words such as `всё`, `всём`, `берёт`, `берёте`, and `нём`, including capitalization and decomposed Unicode spellings. Whole dictionary compounds and protected components of hyphenated words are preserved. Generic tags and their payloads remain unchanged; speech inside paired style tags is checked.

Since **1.0.276**, capitalized words are conservatively treated as proper-noun candidates: their `ё` is neither reported nor replaced, including all-caps and capitalized components of hyphenated words. This capitalization heuristic also preserves sentence-initial ordinary words; lowercase non-exceptions are still fixed.

This is entirely a Helper feature, with no backend dependency. Gold drafting has separate model-prompt guidance only. The exception set conservatively includes all extracted candidates from OpenCorpora revision `417150` (January 2022); it is dictionary-bounded, not a guarantee of complete Russian coverage. Source attribution, checksum, and the [CC BY-SA 3.0 data license](https://creativecommons.org/licenses/by-sa/3.0/) are retained in `src/features/custom-linter/linter/data/yo-exceptions.json` and the bundled bridge.

## Emotion transcription punctuation

When the current page URL contains `emotion` (case-insensitive), the curly-tag punctuation rule preserves punctuation between a braced source and its following `{СКАЗ: ...}` or `{SKAZ: ...}` annotation: `{1}, {СКАЗ: одной}` and `{*2 дня*}. {СКАЗ: два дня}`. The source group must not contain a colon. Both error detection and autofix use this exception; ordinary annotation tags retain their existing punctuation rules.

Detection reads the current URL on each check, including after navigation between projects. This is a URL-substring heuristic, not a project metadata lookup; any occurrence of `emotion` in the URL enables it.

## Stutter prefix validation

Since **1.0.276**, **Normalized stutters** requires contiguous, case-insensitive prefixes of the completed word, not arbitrary internal substrings. `к- никто` is an error; `ни- никто`, `ник- никто`, and `Ни- ник- никто` are valid. Existing fragment-chain length checks still apply. Invalid fragments are highlighted but not automatically rewritten because their intended speech cannot be inferred safely.

## Accept all linter warnings

Press **Alt + Shift + A** on an editable transcription task to acknowledge all current linter warnings, including offscreen segments. This Workflow Helper action leaves errors, already-accepted warnings, and transcript text unchanged; it does not save or submit the task. Repeating it never undoes acknowledgements. It stops if the route or editing session changes.

Change or disable the binding under **Shortcuts → Accept all linter warnings**. The action belongs to **Row Actions** and does not require Review Helper.

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
