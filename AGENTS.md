# Agent Guidance

## Default: surgical changes, no fallbacks

These are requirements for every task, not optional style preferences.

- Diagnose the actual cause before editing. Inspect the current native implementation and runtime state; do not guess from an old bundle, a screenshot alone, or a plausible explanation.
- Treat user-reported failures as facts. Investigate why they happen rather than rerunning checks merely to dispute or confirm the report.
- Make the smallest complete change that fixes the cause. Preserve unrelated behavior and follow existing code patterns.
- Implement exactly the requested workflow. Do not add extra buttons, alternate workflows, speculative features, generic frameworks, or unrelated refactors.
- Small means narrow scope, not skipped safeguards or a partial implementation.

## No fallbacks or masked failures

- Do not add fallback implementations, guessed native callbacks/setters, alternate backends, DOM-to-model mirroring, or automatic retries to conceal an unsupported integration.
- Do not turn errors into empty results, defaults, apparent success, or a different operation.
- When a required native contract is unavailable or ownership cannot be verified, stop the affected operation before mutation and report the specific actionable failure.
- Fix an incorrect ownership check by finding the correct authoritative contract—not by disabling the check, trying arbitrary candidates, or searching increasingly stale state.
- Never switch to polling, watchdogs, repeated scans, or periodic reinjection when a native hook fails.
- Normal native delegation outside the feature's scope, explicit feature disablement, and user-requested Undo/Recover are not error fallbacks. Keep those intentional behaviors distinct from failure handling.

## Native integration and performance

- Keep Babel's native state authoritative. Use its real editor, annotation writer, persistence and history mechanisms; rendered DOM text is not the source of truth.
- Prefer existing native events and narrowly owned hooks over polling. One-shot work needed to finish a user action is fine; do not create a recurring discovery loop.
- Monkey-patch only the specific verified boundary needed for the feature. Preserve arguments, return values, selection, focus, playback and unrelated actions.
- Restore a patched property only if it is still owned by this patch. Release listeners and temporary overrides on teardown; never overwrite a newer owner.
- Guard task, source and object identity before mutation. Do not guess another segment, recording, task, or callback when the original target changes.
- Keep local changes local: dropdown scrolling must not move the page; lane-specific editing must not affect the other lane.
- Avoid unnecessary allocations, full-transcript scans and repeated work in playback or keyboard hot paths. Do not add abstraction unless the current problem actually needs it.

## Verification and delivery

- Current user preference: the user owns feature acceptance testing. Do not launch optional suites or extended browser verification unless requested. Keep required checks narrowly scoped and deliver the reloadable build without a verification detour.
- Before running checks, choose the smallest evidence set that covers the change: affected behavior, exact test/command selectors, and observable pass criteria. Do not expand verification merely because more tests exist.
- Run relevant unit/contract checks and one representative real native-browser scenario first. For native ports, first prove current factory activation, editing/Undo, and the changed integration boundary before starting broad browser coverage.
- Full suites are not the default. Use them only for an explicit user/release requirement or a genuinely cross-cutting change whose risks are not covered by focused checks. Run broad acceptance once, after the focused paths are green—not during each debugging iteration.
- After a correction, rerun the failing case and its directly affected neighbors. Earlier passing results remain evidence unless the correction changes their dependencies or behavior; do not restart an entire suite to obtain one clean final transcript.
- Classify each failure from evidence: product regression, obsolete test interaction/assertion, fixture-contract mismatch, or infrastructure/teardown failure. Investigate the failing boundary directly. Never alter product behavior to satisfy an obsolete native-UI assumption, weaken behavioral assertions, or silently label an unexplained failure “flaky.”
- Do not turn an unrelated infrastructure failure into an open-ended product task. If functional assertions passed but browser shutdown failed, report both outcomes. Use a focused diagnostic only if needed to establish whether the change caused it; do not repeatedly run broad suites until cleanup happens to pass.
- Reuse the existing isolated runner and provisioned dependencies. Prefer its supported test filters over a new custom smoke harness. Keep a custom harness only when the existing runner cannot exercise the required behavior, and remove it afterward.
- Build only affected artifacts and required consumers. Reuse unchanged builds/services within the investigation, but invalidate changed artifacts and reload the extension/page before judging new code. Do not repeatedly rebuild unrelated extensions or reinstall unchanged dependencies.
- Documentation/comment-only changes need a content review, not runtime suites. Runtime-affecting code, configuration, manifests, and generated factories still require checks appropriate to their behavior.
- Exercise the actual changed native path. A successful build, mock, or bridge response is not proof that the page state changed correctly.
- Verify only relevant consumer-visible effects: saved text, native Undo, target lane, playback clocks, focus, selection and scroll positions. Do not replay every workflow for every change.
- Keep regression tests for the real failure or meaningful boundary. Do not add tests that merely assert wiring, copied values, wording, or implementation details.
- Parallelize independent checks only when their files, browser profiles, scenario state, and output directories are isolated. Batch related implementation work before verification; do not let each worker launch its own overlapping suites.
- After changing content scripts, rebuild, reload the unpacked extension, and refresh the Babel dashboard before judging the loaded behavior. Distinguish local builds from published or review-pending versions.
- Do not mutate a user's live transcript merely to demonstrate a fix. Use an isolated native-editor scenario unless live changes are explicitly authorized.
- Document non-obvious Babel internals and native integration contracts, not ordinary extension features or implementation details. Do not add routine feature write-ups to the README. Remove obsolete paths and diagnostic scaffolding.
- Report what was actually exercised and any verification limits. Do not claim “fixed” or “everything works” based only on compilation, a simulated callback, or an older editor fixture.
- Do not commit, push, publish, or replace a Store submission unless requested.
