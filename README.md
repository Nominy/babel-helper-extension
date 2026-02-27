# Babel Audio Workflow Helper

Initial proof-of-concept browser extension for the Babel Audio transcription dashboard.

What the snapshot shows today:
- Transcript rows live in a table with per-row textareas and an action menu hidden behind an ellipsis button.
- The page already exposes playback controls, speaker track toggles, a built-in hotkeys dialog, a diff-view toggle, linter status, and submit/save buttons.
- Deleting or merging a segment appears to be routed through the row action dropdown, which is the workflow bottleneck this helper targets first.

What this version adds:
- Keyboard shortcuts plus an `Alt + Drag` cut preview, with no persistent injected UI:
  - `Shift + Hover` over the waveform: show a temporary 10x magnifier above the hover handle
  - `Alt + Drag` inside an existing waveform segment: create a temporary cut preview
  - `Enter`: commit the cut preview by replaying the native split gesture at both cut boundaries
  - `Esc`: cancel the cut preview, or toggle blur and restore focus when no preview exists
  - `Alt+[ / Alt+]` (same physical keys as `Alt+Х / Alt+Ъ` on RU layout): move text before / after the caret into the previous / next segment
  - `Alt+Shift+Up / Alt+Shift+Down`: merge with previous / next
  - `Del`: delete the current segment

Implementation notes:
- The extension does not inject buttons, panels, badges, or any other persistent visible interface.
- The extension augments the existing Babel `Hotkeys` dialog when it opens so these custom shortcuts are visible in the platform's own help window.
- The extension edits transcript textareas by dispatching native `input` events so React keeps the page state in sync.
- The waveform magnifier is transient and non-interactive, so native region handles still receive pointer events while it is visible.
- The cut preview only activates on `Alt + Drag`, so normal waveform clicks are left to the native player and segment controls.
- The cut preview is temporary extension UI: `Esc` cancels it, and `Enter` commits it only when the preview spans at least 1 second. Shorter previews stay visible until you cancel or resize them.
- Delete and merge actions are triggered by opening the page's own action menu and clicking the matching menu item, so the existing React workflow remains in control.
- Cut commits are performed by replaying a synthetic modified `click` at the preview edges, which is intended to mirror the product's split interaction without low-level pointer injection.
- The menu item lookup is text-based and intentionally tolerant (`delete/remove`, `merge/combine/join`) because the exact menu labels were not present in the closed snapshot.
- `Esc` is stateful: if a cut preview exists, it dismisses the preview; otherwise it blurs and remembers the caret location, and the next press restores focus to the same segment and cursor position unless the active segment changed, in which case it focuses the current segment at the start.

Install:
1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click `Load unpacked`.
4. Select the `babel-helper-extension` folder.

Likely next improvements:
1. Auto-advance to the next row after a successful merge or delete.
2. Add waveform-region shortcuts once the live DOM for the open menu and active region is captured.
3. Surface linter warnings inline with one-click navigation to the next flagged row.
