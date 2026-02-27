# Babel Audio Workflow Helper

Initial proof-of-concept browser extension for the Babel Audio transcription dashboard.

What the snapshot shows today:
- Transcript rows live in a table with per-row textareas and an action menu hidden behind an ellipsis button.
- The page already exposes playback controls, speaker track toggles, a built-in hotkeys dialog, a diff-view toggle, linter status, and submit/save buttons.
- Deleting or merging a segment appears to be routed through the row action dropdown, which is the workflow bottleneck this helper targets first.

What this version adds:
- Keyboard shortcuts only, with no injected UI:
  - `Esc`: toggle blur and restore focus
  - `Alt+Up / Alt+Down`: move focus between transcript rows
  - `Alt+Shift+Up / Alt+Shift+Down`: merge with previous / next
  - `Del`: delete the current segment

Implementation notes:
- The extension does not inject buttons, panels, badges, or any other visible interface.
- The extension augments the existing Babel `Hotkeys` dialog when it opens so these custom shortcuts are visible in the platform's own help window.
- The extension does not mutate transcript state directly.
- Delete and merge actions are triggered by opening the page's own action menu and clicking the matching menu item, so the existing React workflow remains in control.
- The menu item lookup is text-based and intentionally tolerant (`delete/remove`, `merge/combine/join`) because the exact menu labels were not present in the closed snapshot.
- `Esc` is stateful: the first press blurs and remembers the caret location; the next press restores focus to the same segment and cursor position unless the active segment changed, in which case it focuses the current segment at the start.

Install:
1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click `Load unpacked`.
4. Select the `babel-helper-extension` folder.

Likely next improvements:
1. Auto-advance to the next row after a successful merge or delete.
2. Add waveform-region shortcuts once the live DOM for the open menu and active region is captured.
3. Surface linter warnings inline with one-click navigation to the next flagged row.
