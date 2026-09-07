# Native bridge audit

Evidence: captured Babel module `73681`, readable at
`tools/babel-editor-rebuild/app/src/recovered/source/babel-owned/73681.js`
in the parent workspace, and the captured-module recreation used by browser E2E.

## Simplified

| Path | Native source | Change |
| --- | --- | --- |
| Playback state | `n3` workbench's WaveSurfer ref | Read that ref once in the committed editor, instead of searching controls, waveform hosts, and a dummy audio element. |
| Play/pause | `n2.onPlayPause` → `tb2.togglePlayPause` | Invoke once, then observe completion. Remove click simulation and duplicate direct media calls. |
| Seek | `n2.onSeekToTime` → `tb2.seekAllTracksToTime` | Use Babel's synchronized seek callback. |
| Speed | `t1` Select's `onValueChange` → `p2` | Update the selector state and native rates together. Wrap each native WaveSurfer `setPlaybackRate` with a seek back to that lane's prior time, fixing Babel's WebAudio position jump for both its dropdown and Helper hotkeys. Restore original methods on task replacement or bridge teardown. |
| Isolated-world playback | MAIN-world playback bridge | Remove the second implementation in `row-service.ts`; isolated scripts cannot access native React expandos. Report bridge unavailability instead of changing the dummy audio element. |
| Synthetic region dragging | Unreferenced `getHandle` and `dragHandleToClientX` | Remove dead pointer/mouse event code. Active timestamp mutations already use the timestamp bridge. |
| Speaker visibility and mute | `n5.onToggleCollapse` / `onToggleSolo` → `ed2.toggleCollapsed` / `toggleMuted` | Read committed collapsed/muted state by recording ID, then invoke only necessary toggles once. Mute works while collapsed; no temporary expansion or button retries. |
| Track filtering | `n2` track Select's `onValueChange` | Pass the recording ID or `all` directly to the native filter setter. No combobox opening, option lookup, or synthetic clicks. |

Speaker identity is also shared: `n3.transcriptionChunkProcessedRecordings`
provides recording IDs, labels, and audio URLs independently of annotations.

## Other paths inspected

- Timestamp delete/merge/time changes already invoke native callbacks. Keep the
  commit check before merging: pending textarea text is separate from committed
  annotation state, so directly calling merge too early loses edits.
- Native textarea autocomplete and custom-linter edits still send input events.
  The captured row component owns local editor state and debounce/blur behavior.
  Calling the parent annotation setter alone is not equivalent; these need tests
  for pending text, caret, and undo before replacing the input path.
- Speaker workflows use one MAIN-world request and observe committed state before
  reporting completion. A task change aborts that observation without replaying
  callbacks against the new task. Session detection uses the mounted editor table,
  so filtering to zero annotations does not disable the reset hotkey.
- Magnifier selection searches also resolve viewport geometry and regions, not
  just speaker identity. They should not be replaced wholesale by a track lookup.

## Validation

The faithful recreation exercises speed limits and preserved position, native
speed dropdown changes while paused and playing, rewind
while playing, Escape pause/resume with proportional caret restoration, disabled
proportional restoration, and recording identity after deleting every annotation.
No production task is submitted or edited by these tests.

Speaker workflow coverage includes both lanes initially collapsed and muted,
repeated switches, actual audio volumes, annotation filtering, reset, and switching
after deleting every annotation.
