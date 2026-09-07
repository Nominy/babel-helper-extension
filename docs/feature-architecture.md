# Feature ownership and site APIs

Feature behavior belongs in `src/features`. `src/services` contains stable entry
points, service facades, and composition. `src/site` adapts Babel's native state,
rows, playback, waveform geometry, and page-world operations. Site adapters must
not import feature implementations at runtime.

The public service and content-script paths are preserved. Existing mods continue
to call the same late-bound service facades. The `helper` methods remain the
compatibility surface used by those facades; this refactor does not replace that
public protocol.

## Where to make a change

| Behavior | Owner |
| --- | --- |
| Row identity, current row, focus primitives | `site/rows.ts` |
| Row/time lookup and cache | `site/row-time.ts` |
| Playback bridge requests | `site/playback.ts` |
| Native waveform/region lookup and geometry | `site/timeline.ts`, `site/page-waveforms.ts` |
| Speaker selection, visibility and mute policy | `features/speaker-workflow.ts` |
| Speed shortcuts and native speed-position fix | `features/playback-speed-hotkeys.ts` |
| Ghost cursor projection and lane switching | `features/ghost-cursor.ts` |
| Escape focus/playback restoration | `features/focus-toggle-feature.ts` |
| Delete/merge policy and caret restoration | `features/row-actions-feature.ts` |
| Adjacent segment text movement | `features/text-move-feature.ts` |
| Playback-driven row tracking | `features/playback-row-tracking.ts` |
| Selection preview and pointer routing | `features/timeline-selection-feature.ts` |
| Selection looping | `features/selection-loop.ts` |
| Smart splitting | `features/smart-split.ts` |
| Boundary adjustment | `features/timeline-edge-adjustment.ts` |
| Audio trimming | `features/audio-trim.ts` |
| Silence segmentation and text redistribution | `features/auto-segmentation.ts`, `features/auto-segmentation/` |
| Segment insertion | `features/auto-insert-segment.ts` |
| Empty-segment transcription | `features/segment-transcription.ts`, `features/segment-transcription/` |
| Transcript replacement | `features/transcript-replacement.ts` |
| Zoom persistence | `features/zoom-persistence.ts` |
| Minimap, magnifier, hotkeys help, timestamp editing, scale unlock, extended diff | Corresponding `features/*-feature.ts` |
| Linter page integration and rules | `features/custom-linter/` |
| Autocomplete page integration | `features/quick-region-autocomplete/` |
| Waveform theme integration | `features/waveform-theme/` |

Large native adapters and intrinsically large features can still have substantial
implementations. Split by responsibility and execution world, not arbitrary line
counts. Supporting algorithms stay beside their feature. Shared progress rendering
lives in `ui/long-task-progress.ts`.

## Registration and dependencies

`registerRowService` and `registerTimelineSelectionService` construct per-session
module APIs, then register feature behavior against them. Their `RowModules` and
`TimelineModules` types describe the composition. Each feature accepts a `Pick`
of only the modules it uses. The references are resolved when callbacks execute,
after synchronous registration completes; constructors must not invoke a peer
feature that has not yet been registered.

Keep native lookup and low-level operations in site adapters. Keep decisions such
as which lane to mute, how to distribute text, or where to restore the caret in
the feature. Session lifecycle code binds and unbinds listeners and manages routes;
it does not decide what a shortcut does.

## Attaching input hooks

`runtime.editorHooks` exposes `on(phase, handler, order)`. Phases are `capture`
(window keydown), `keydown` (document keydown), and `keyup` (window keyup).
Lower order runs first; equal orders retain registration order. Returning `true`
claims the event and ends that phase's dispatch. Call `preventDefault` or
`stopPropagation` explicitly when the feature needs them.

```ts
const dispose = ctx.runtime.editorHooks.on('keydown', event => {
  if (!ctx.helper.isFeatureEnabled('myFeature')) return false;
  if (event.code !== 'KeyQ' || !event.altKey) return false;
  event.preventDefault();
  const row = ctx.services.rows.getCurrentActionRow({ allowFallback: false });
  if (row) ctx.services.focus.focusRow(row, { activateRow: false });
  return true;
}, 150);
ctx.scope.defer(dispose);
```

`features/editor-input.ts` establishes shared eligibility and registration order.
Individual features own their shortcut conditions and actions. Session and dialog
eligibility remain at the dispatch boundary, with the existing capture behavior
preserved. Feature scopes should own any extra subscription's disposer.

## Verification

Tests execute production modules and assert outputs, state changes, event handling,
and disposal. Browser tests exercise native state and visible behavior through the
actual extension entries. Hook tests verify priority, event ownership, and
independent disposal.

Do not assert source text, function names, import layout, file placement, line
counts, or implementation order. Do not copy production algorithms into tests.
Refactoring without changing behavior should not require rewriting expectations.
