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

## Current Babel editor

Helper targets the turn/Slate editor captured on 2026-10-15 (module `59327`), not the archived
table editor. Transcript operations use native model callbacks and an explicit
editor control for raw text, selections and geometry; they do not create hidden
textareas or replace Slate DOM. Native Ctrl/Meta+A updates the model and browser
selection together. Accepted focus/selection operations remain authoritative until
the DOM catches up; passive selection events cannot replace them with an
initialization caret.
Arrow-key suppression runs after Slate handles caret movement, blocking only
Babel's outer seek handler.
Pointer and programmatic turn changes blur the connected native editor before
activating another turn, so its native blur handler can commit pending text before
the old Slate instance unmounts.
Native per-turn Slate history survives editor remounts independently of the global
annotation Undo stack. Helper replacements in an active Slate editor use its
genuine `withNewBatch` boundary, so Undo does not consume older typing. Missing
verified history authority rejects the replacement before changing text or selection.
The native `beforeinput` handler keeps a stable identity while invoking the latest
committed controller. Unrelated row commits therefore do not detach the focused
Slate editor's DOM mapping during input or blur.

Focused PageUp/PageDown move the caret by a transcript viewport; Shift extends
the native selection. Paging and Escape restoration scroll only that viewport.
The document, sidebar and waveforms retain their original sizing and horizontal
scrolling; Helper does not clip or paint-contain the document or editor shells.

**Disable Native Segment Click Seek** is enabled by default. It suppresses the
incidental seek performed by native turn selection (`onSelect`), without changing
native edit activation/deactivation (`onActivate`/`onDeactivate`). Explicit playback,
timeline navigation and Alt-click word seeking remain available.
Disabling the feature restores the current native selection behavior: it seeks
when the playhead is outside the selected turn, rather than unconditionally
rewinding whenever its text editor is reactivated. Changes apply without reloading.

**Tag Dropdown Keyboard Navigation** is enabled by default. In the native style
tag dropdown opened by selecting words, Up/Down cycles options and Enter applies
the highlighted tag through Babel's native editor. The selection and native undo
are preserved; Escape, mouse selection and ordinary search input stay native.
Up/Down keeps the highlighted option visible by scrolling only the dropdown,
including wrap-around and native keyboard-opened tag menus. Already-visible
options do not jump; the transcript, page and waveform scroll positions stay
unchanged. Rapid keys share one post-key frame, with no background polling.

Native tag chips keep their compact static width in both playback and editable
views. The existing remove button sits at the chip corner outside text flow,
without covering the tag label or widening the chip on hover. This scoped CSS
correction works with appearance settings on or off and leaves native tag
removal, text content and Undo unchanged.

Native WaveSurfer notifications drive playback tracking; there is no independent
row/cursor polling loop. Clock-only updates are coalesced to 66ms using incoming
events, while play, pause, seek and source changes are immediate. Each cursor frame
shares one fresh row/time collection across active-lane and off-lane lookup.
Empty gaps are normal results, not reasons to rebuild the cache or retry searches.
Playback clocks remain live; concurrent explicit command reads share only their
in-flight request. Recording metadata does not trigger full transcript snapshots.
Hidden tabs and owned source switches suspend drawing until native visibility or
ready notifications, without a watchdog timer.

Native commits and navigation events drive task/permission admission, enhancement
ownership, diff refresh and mutation verification. The shared commit hook preserves
the actual React root value and restores only its own property descriptor.
Unsupported hooks stop the affected automation with a visible error; they never
switch to polling or timed bootstrap retries. Explicit operation deadlines report
failure, and mutations are not automatically replayed after missing responses.
UI elapsed-time ticks and input debounces are not native-state polling.

Native zoom synchronization waits for the affected lane's actual decoded-ready
event instead of calling `zoom()` on unloaded audio. The latest native zoom intent
wins; subscriptions and method ownership are released on destruction or teardown.

The magnifier follows live native region boundaries during a drag rather than
waiting for committed annotation timestamps. Final timestamps and undo still use
the native release/commit workflow.

Custom-linter diagnostics bind to the committed annotation/lint-state owner,
without depending on incidental controller memo storage. Issue cards reconcile
after native lint updates; existing native issues and disabled rules are preserved.
Initial lint publication waits for native commit/session notifications rather than
retrying on a timer; an unsupported mounted lint owner is reported visibly.
Highlight observation runs only while a transcript row is hovered. Publishing
already-merged diagnostics does not run the same rules again; ordinary playback
DOM updates outside a hovered row do not schedule document-wide highlight passes.

Readonly status comes from the current native task, not `displayFeedback` URL
flags. Writable feedback routes and empty transcripts remain supported; actual
readonly tasks reject Helper editing operations, including when Babel offers
local-only edits. Task navigation, live feature toggles and speaker filtering
retain their own lifecycle boundaries.
Guarded transcript mutations and rollback bind the complete row snapshot, pending
local text and exact native undo-command identity. An undo/redo fork at the same
history depth cannot authorize an old replacement receipt.

Feedback draft restoration shares one native hydration gate with Review Helper:
disabling Helper's setting releases Helper's ownership, not an independently
enabled Review Helper protection.

## Performance and listening coverage

Helper installs precompiled rendering optimizations at `document_start` for the
verified October 15 editor `59327` and waveform/region/timeline modules. Factory
sources must match exactly; a different Babel build keeps its native implementation
and displays an unsupported-version notification. No runtime source evaluation or
remote replacement code is used. **Reload the extension and refresh existing Babel
tabs after updating.** Disabling/removing Helper also requires a page refresh to
remove already-executed native rendering changes.

The current October 15 refresh targets editor chunk `8022-bab2b789674d6122.js`
and regions/timeline chunk `6264-da8e30159773903a.js`. It preserves Babel's
updated button components and project navigation links. The optimized editor
boundaries and both plugins retain their prior behavior with renamed bindings;
the regenerated patches still require exact native source matches.

Playback uses indexed region/word lookup, transition-only region styling, shared
viewport calculations, and cached per-turn word/lint inputs. Transcript rows stay
mounted and searchable: `content-visibility: auto` skips offscreen layout/painting
without replacing Slate editors, browser Find text, selection, or native Undo.
Focused rows synchronously release containment through `:focus-within`, keeping
native editing and caret layout unrestricted. This is rendering containment,
not JavaScript row virtualization.
The port retains the native transcript component, copy handling, local-history
cache, editing state, CJK-space highlighting and draft-tag issue suppression.
It reuses upstream word memoization instead of wrapping it again. Rate-aware
bounded playback and its listener/timer cleanup remain native; timeline patches
use the current viewport parameter order.


Listening coverage follows continuous native Web Audio clock spans rather than
discarding playback after a two-second UI callback delay. Explicit seek, pause,
mute, speed, source and loop boundaries prevent skipped or inaudible intervals
from becoming credit. Native speaker obligations, 100ms bins and final-half-second
coverage semantics remain intact; the native store and submission gate remain
authoritative. Missing coverage is maintained incrementally. UI notifications are
coalesced to 200ms, and native-format storage checkpoints to two seconds during
playback, with pause/task/page-lifecycle/submission flushes. A browser/process crash
can still lose the uncheckpointed interval; this does not bypass listening checks.

Minimap viewport movement reads geometry only; waveform/annotation/style changes
invalidate content separately. Hidden lane candidates remain discoverable on
visibility-only restoration. The magnifier reuses its decoded source and overlay
nodes, rendering only for source/zoom/height/theme changes; a retired source is
released before the next drag event acquires current ownership.

Native-session publications own mount admission instead of duplicate global
observers, including an initial MAIN bridge bootstrap before the editor mounts.
Waveform theming uses verified registry recording IDs rather than DOM/Fiber graph
crawling. Shipped linter rules reuse unchanged per-row work with explicit
cross-row/settings/task invalidation; external rules remain uncached because their
dependencies are not declared. Hover observation is scoped to the row and tooltip
content, with shallow portal-mount observation.

## Automatic ZipEnhancer audio

**ZipEnhancer audio** requires matching Gold Drafting, not Review Grader. Once both native speaker tracks load, Gold enhances them according to Options → **ZipEnhancer processing**: **Automatic (prefer local GPU)** or **Remote inference (official first, then swarm)**. Remote works even on WebGPU-capable hardware; Automatic also uses remote processing when local capabilities are unavailable. Save in Gold and reload the task. On a remote cache miss, both Original WAVs leave the device for the configured coordinator and executing service/worker; only use services and workers you trust with the audio. Disable Automatic Audio Enhancement to prevent uploads. No CPU fallback, OpenRouter key or C-denoise/ASR bundle is required. A verified cache hit performs neither inference nor upload, independent of this preference.

Every new pair defaults to **90% Enhanced / 10% Original**; this is the committed native audio, not just a slider label. Selecting 100% Enhanced warns that full enhancement can suppress or remove speech. **Cancel** is initially focused and leaves the prior audio untouched; **Use 100% enhanced** explicitly commits it and remembers approval for that task in the current tab, including reloads and returning to the task. Later transitions to 100% on that task do not ask again; a different task still requires approval. Cancellation or a stale confirmation never grants approval. If tab storage is blocked, approval lasts only for the current page. New selections, task/session changes, navigation, disabling and teardown invalidate pending confirmations. Keyboard events in the modal cannot trigger editor shortcuts. The blend reduces reliance on model output but is not a guarantee that all speech remains audible; use Original to check unclear words.

The toolbar has one **Enhanced → Original** strength slider with **10-percentage-point detents**. Left is 100% Enhanced; right is byte-exact Original; intermediate positions linearly mix the retained recordings. Dragging only previews the snapped value; release commits one latest selection. Keyboard arrows move one detent, Home/End choose endpoints, and a 200ms release debounce prevents repeated reloads. Keyboard interaction cannot trigger Babel row navigation or seek. Cancelled gestures, task changes, disable, and teardown discard pending selections. The committed blend owns waveforms, playback, audio-boundary tools and Gold/Helper L0 capture. Transport, regions, transcript and selection survive paired reloads; choosing Original before enhancement finishes prevents a late result from overriding it.

Changing strength never reruns the model. Endpoints reuse exact retained WAV bytes; intermediate output is mono PCM16 at the Original sample rate/frame count, with no gain normalization or extra gate. Original and Enhanced stay retained; only one committed mixed pair is kept in memory (plus temporary preparation/rollback resources), and mixed variants are not written to the persistent one-pair model cache. More Original brings back suppressed speech **and** noise/echo; the model changes phase, so linear blending can also cancel some components. Strength is a listening/recognition tradeoff, not a retuned neural model.

Intermediate mixing and decoded-PCM WAV serialization run in a session-owned
packaged worker before playback is paused for native source replacement. Superseded
preparation is canceled; worker output buffers transfer back without a byte clone.
Original/Enhanced endpoint data remains available for synchronous capture and
restoration, while the worker holds no additional persistent endpoint-byte cache.
Worker startup or processing failures are reported rather than falling back to
main-thread DSP.

Disabling waits for both native players to restore Original before releasing the
bridge or allowing reactivation. Capture stays unavailable during that transition,
even after the toolbar disappears. A failed restoration retains its error and
Original resources for an explicit retry; elapsed time is not a successful
disposal acknowledgement, and an old owner cannot clear its successor's state.
Transport changes made during decoding remain authoritative: completing a switch
does not replay old mute, seek, rate, scroll or selection values. New play/pause
intent is preserved while playback is rebound to the committed decoded pair.

ZipEnhancer sits in the transcript action toolbar alongside the theme button and
Gold Drafting magic wand, not in the waveform zoom controls.

The single-row control is **36px high**, matching the theme button, with a stable 360px footprint, fixed percentage/status slots and a thin in-place progress bar. Idle, model preparation, native switching, ready and long errors do not reflow the toolbar or editor. The **i / !** details button opens complete status, errors, inference counts and elapsed time in a scrollable native popover outside layout. Progress uses completed GPU windows, not elapsed-time estimates. A strength commits only after both native players finish loading; sequential lane decodes keep Babel's cross-lane zoom callbacks away from empty buffers.

Native region-created/editing registration remains enabled during source changes. Current annotation membership, region metadata, and selection are reconciled after native rebuilding, so prior splits/text edits are not replaced by a stale ready callback. Verified editing paths include **Alt-drag → S** cuts with text preserved once, native Ctrl/Meta-click splitting, text editing, and region resizing after automatic enhancement and both source switches.

Gold's extension-local IndexedDB retains **one completed recording pair**, not a history. Both original source byte hashes, stable recording IDs, and the model graph hash identify it. A different pair/model replaces the entry; only both complete, verified enhanced WAVs can commit together. Cache hits skip model initialization and inference and show **reusing the locally cached pair**. Corrupt/evicted entries become fresh misses. Storage/quota failures are visible cache warnings while valid enhanced audio remains usable. No API keys, transcript text, labels, or duplicate original audio are stored in this cache. Real refresh reuse for the tested minute-long pair took about 1.6 seconds; full browser and offscreen-worker restart reuse were also verified.

Every nonzero strength has a stable model/source/mix identity; timing and draft caches cannot reuse another strength's recognition result. Original keeps its existing canonical identity. Committed selection—not a held thumb preview or open confirmation—owns capture and replacement guards. Stale task results cannot commit, and a failed second lane restores the prior full or mixed pair. Disabling the feature restores Original.


## Word-timed ghost cursor

With Gold's current-task word timing available, the ghost cursor and Alt-click seeking use absolute word timestamps. Helper resolves visible speaker labels through Gold's task-scoped recording metadata, so UUID-named timing tracks work without access to page-world React internals. Stale or ambiguous mappings are not used. The cursor falls back to proportional positioning when no usable current-task timing or matching word anchors exist.

Without word timing, rewinds reset the proportional cursor's lower bound on the
same reaction-compensated clock used during forward playback. Lane toggles and
Escape restoration share that bound instead of retaining a later word after seek.
Each real blur captures the current native caret as its new baseline, including
selections made by native commands without input or pointer events.

Owned strength changes briefly hide/freeze the same ghost cursor instead of treating the native players' temporary pause as a real stop. Stale playback reads cannot stop a newly committed cursor. Same-task row remounts and equal-shaped native speaker filters resolve current DOM rows. A settled real pause, task navigation, or teardown disposes the cursor; the ghost never resumes transport itself.

Word timing retains Original and one latest nonzero-strength timing set for the current task/recording identity. Exact-strength pins take precedence for playback. When only one strength has been timed, the ghost and word-click seeking can project its absolute word clocks onto another blend of the bridge-verified same-clock pair. `pairedVariantKey` binds timing to the full Enhanced model/source pair; intermediate ASR identities remain distinct, and projected playback pins never populate another strength's ASR cache. Replaced pairs, task changes, missing clock proof, and teardown cannot borrow stale timing. Verified in the reconstructed native editor: held drag/keys leave audio unchanged, each release commits once, all mixed PCM samples match the blend formula, real Gold capture hashes match the selected mix, exact endpoint bytes remain intact, S splitting preserves text once after mixed loading, and the timed ghost/Escape caret survive 100% → 65% → Original → 25% → Original without republishing timing.

**Alt+Shift+S** checks existing current-task word clocks before contacting the timing broker. Verified same-clock pair timestamps can guide text allocation at another strength while silence detection continues to use the selected waveform. If timing arrives during pending broker admission, it is consumed immediately and that admission is cancelled; task/source changes end the wait. Verified in the native editor with genuine deployed timestamps at 50% strength: timing preparation took about 2ms, no broker connection was made, and the full trim/merge/timestamp-based text allocation completed. Missing or foreign-task timestamps do not bypass provider/ownership checks.

## Native merge and replacement rules

**Merge Across Gaps** is enabled by default. Babel currently disables merging
same-speaker neighbors when their gap exceeds two seconds, even for intermediate
turns. Helper removes only that gap restriction in native menus and merge
commands. First/last boundaries, speaker identity, locked segments, readonly
tasks, pending-text checks and stale-task protection remain enforced. A merge
uses Babel's annotation writer and history, preserving other speakers and native
Undo. Disabling the feature restores the original gap restriction.
Transactions resolve the unique directional merge command from the current
native controller's owned dependencies, never from a retained panel callback.
Panel/keyboard closures can outlive both React render slots. Keyboard entrypoints
retain their native role but dispatch through the current controller. Ambiguous
commands, foreign history, stale annotation arrays and raw setters are rejected.

Click Helper's **Chrome toolbar icon** to open **Advanced replacement**. Settings
remain available through Chrome's extension options and the popup's **Settings**
link. No separate in-editor button, replacement shortcut or FAR installation is
needed. The **Replacement Rules** feature is enabled by default.

**Add rule**, **Edit**, **Delete**, enable/disable and **Up/Down** manage an ordered
list saved in extension-local storage. Rules support literal or regex matching,
case sensitivity and Unicode whole-word matching. An empty replacement deletes
matches. Regex replacements support `$0`/`$&`, numbered/named captures and `$$`;
dollar signs in literal replacements remain literal.

**Run** applies one enabled rule; **Run all** applies all enabled rules in saved
order to native transcript content across every speaker, including hidden turns.
Raw tags are intentionally replaceable, so rules such as `[стук]` → `[смех]` work.
The focused native edit is committed through Babel's normal blur handler before
mutation; pending text or an active composition cannot be overwritten.

Each run uses one native annotation/history command and remains natively undoable.
**Recover latest run** survives popup close/reopen and restores that run's original
text only while its affected output and transcript structure still match.
Intervening affected edits, task changes and native Undo invalidate recovery;
unrelated edits are preserved. Recovery is itself one undoable native command.
No-op runs do not add history or discard valid recovery.

Rules run only on explicit user commands, never automatically. The popup binds
the active tab and native task session; failures are shown without retries,
polling, generic DOM synchronization or guessing another native writer.

## Configurable shortcuts

Open the extension settings and select **Shortcuts** to open its dedicated submenu. Helper action shortcuts retain their original defaults until changed. Record a replacement, add an alternative, clear an action to disable its shortcut, or restore individual/all defaults. Changes save automatically and apply to open dashboard sessions; shortcut help and appearance hints use the saved bindings.

Recording prompts and results appear inside the action's row; the active recording button becomes **Cancel recording**. The recorder supports right-Shift combinations. Escape and Tab can be assigned; cancel with that inline button or by tapping and releasing a modifier alone. Conflict warnings are informational because some defaults intentionally share keys in different contexts.

These settings cover Helper keyboard actions, not native Babel/browser shortcuts, ordinary text editing, or mouse gestures. Browser/OS-reserved combinations may never reach the page. Auto-insert still defaults to `Alt+C`, now handled by the same configurable page input path rather than a separately reserved Chrome command.

Timeline previews own **S** (smart text allocation) and **Shift+S** (native text
duplication) only outside text editing. Creating or grabbing an Alt-drag preview
focuses that preview without scrolling; clicking back into turn text keeps `s`
and `S` as ordinary typing, even while a preview is visible.
The preview's native recording owns every split, boundary trim and covered-turn
deletion. Overlapping turns on the other lane remain unchanged, regardless of the
selected text row. A replaced/disconnected host or changed audio source rejects
the command with an explicit preview error instead of guessing another target.

Light manual check: Alt-drag a valid interval inside a writable turn, press S,
and confirm the resulting turn times and text. Undo the existing boundary-trim
steps, then the split; text allocation belongs to that one native split command.
Repeat with Shift+S to check native text duplication. With a preview visible, click
into turn text and type `sS`; neither key should commit the preview. A stale
preview after task/audio-source changes must not edit the new task.

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

Press **Alt + Shift + A** on an editable transcription task to acknowledge current ordinary linter warnings, including offscreen segments. The action uses native history-backed callbacks and observes their commits; it does not depend on issue cards being visible in every row. Errors, signal questions, already-accepted warnings, transcript text and native selection are preserved. It does not explicitly save or submit, never toggles an accepted warning off, and stops if task, root, route, permissions or source identity changes.

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

Native split/switch regression tests load the captured editor factory from the shared E2E package's published recreation snapshot. They do not require the private sibling `tools/babel-editor-rebuild` checkout.

## Package and publish

```sh
npm run build:zip                     # rebuilds and bumps the version
npm run build:zip -- --no-build       # package existing dist/ without a bump
```

Output: `.artifacts/babel-helper-extension-<version>.zip`. `BABEL_EXTENSION_ZIP_DIR` overrides the output directory; `BABEL_EXTENSION_ZIP_PATH` overrides the full path. Relative paths resolve from this directory.

Commit the release version in `manifest.json`, `package.json`, and `package-lock.json`; `npm run version:patch` bumps them without building. CI does not bump versions. The version must exceed the store's published and submitted versions.

Push to `main` creates a GitHub prerelease `v<version>`. To publish, manually run `.github/workflows/deploy-babel-helper-extension.yml` on that commit with `version=<version>` and `confirm=PUBLISH <version>`. The tag must still be a prerelease pointing at the selected commit. `publish_type` defaults to `DEFAULT_PUBLISH`: Google still reviews the update, then publishes it automatically on approval. Select `STAGED_PUBLISH` only when manual publication is intentional. `replace_pending_submission` cancels a pending review and remains off by default. A successful submission promotes the GitHub prerelease; it does not mean the Store update is already live.

Required Actions secrets: `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`, `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`. Optional short-lived fallback: `CWS_ACCESS_TOKEN`.

For local publishing, copy `.env.cws.example` to ignored `.env.cws.local` and fill the credentials. Seed repository secrets with `node scripts/setup-github-secrets.mjs OWNER/REPO`; publish locally with `npm run publish:cws`.
