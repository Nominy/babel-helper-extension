# Babel Audio Workflow Helper

Initial proof-of-concept browser extension for the Babel Audio transcription dashboard.

What the snapshot shows today:
- Transcript rows live in a table with per-row textareas and an action menu hidden behind an ellipsis button.
- The page already exposes playback controls, speaker track toggles, a built-in hotkeys dialog, a diff-view toggle, linter status, and submit/save buttons.
- Deleting or merging a segment appears to be routed through the row action dropdown, which is the workflow bottleneck this helper targets first.

What this version adds:
- Keyboard shortcuts plus an `Alt + Drag` timeline selection, with no persistent injected UI:
  - Drag a segment edge: show a temporary 10x magnifier above the active handle
  - `Alt + Drag` inside an existing waveform segment: create a temporary selection range
  - `S`: smart-split the selected range by replaying the native split gesture at both boundaries, then redistributing words
  - `Shift + S`: split the selected range without smart word redistribution
  - `L`: loop the selected range until playback is moved outside it
  - `Shift + Ctrl/Cmd + Click`: use Babel's native split, then smart-split words across the new pair
  - `Esc`: clear the selection, or toggle blur and restore focus when no selection exists
  - `Alt+[ / Alt+]` (same physical bracket keys on RU layout): move text before / after the caret into the previous / next segment
  - `Alt+Shift+Up / Alt+Shift+Down`: merge with previous / next
  - `Del`: delete the current segment

Implementation notes:
- The extension does not inject buttons, panels, badges, or any other persistent visible interface.
- The extension augments the existing Babel `Hotkeys` dialog when it opens so these custom shortcuts are visible in the platform's own help window.
- The extension edits transcript textareas by dispatching native `input` events so React keeps the page state in sync.
- The waveform magnifier is transient and non-interactive, so native region handles still receive pointer events while it is visible.
- The selection overlay only activates on `Alt + Drag`, so normal waveform clicks are left to the native player and segment controls.
- The selection is temporary extension UI: `Esc` clears it, `S` / `Shift + S` commit it only when the selected span is at least 1 second, and `L` loops it until playback is moved outside the selection. Shorter selections stay visible until you cancel or resize them.
- Smart splitting is additive: Babel still performs the real split, and the extension only redistributes words afterward using a simple word-count ratio based on the split position.
- Delete and merge actions are triggered by opening the page's own action menu and clicking the matching menu item, so the existing React workflow remains in control.
- Selection splits are performed by replaying a synthetic modified `click` at the selection edges, which is intended to mirror the product's split interaction without low-level pointer injection.
- The menu item lookup is text-based and intentionally tolerant (`delete/remove`, `merge/combine/join`) because the exact menu labels were not present in the closed snapshot.
- `Esc` is stateful: if a selection exists, it dismisses the selection; otherwise it blurs and remembers the caret location, and the next press restores focus to the same segment and cursor position unless the active segment changed, in which case it focuses the current segment at the start.

Install:
1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click `Load unpacked`.
4. Select the `babel-helper-extension` folder.

Likely next improvements:
1. Auto-advance to the next row after a successful merge or delete.
2. Add waveform-region shortcuts once the live DOM for the open menu and active region is captured.
3. Surface linter warnings inline with one-click navigation to the next flagged row.
