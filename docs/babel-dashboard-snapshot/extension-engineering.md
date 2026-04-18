# Extension Engineering Notes

This file is the practical extension-builder guide for the saved Babel transcription snapshot.

## Ground Rules

1. The page is React-driven and can re-render aggressively.
2. Prefer accessibility labels, visible text, and semantic roles over classes and ids.
3. Use the platform's own controls to trigger actions whenever possible.
4. Treat the snapshot as a moving target. Anything without an accessibility hook may drift.

## Best Hooking Strategies

### Use These First

- `textarea[placeholder="What was said…"]` for transcript inputs
- `tbody tr` filtered by the textarea above for transcript rows
- `button[aria-haspopup="menu"]` inside a row for the row action menu trigger
- `button[aria-label="Jump back 5 seconds"]`
- `button[aria-label="Play all tracks"]`
- `button[aria-label="Jump forward 5 seconds"]`
- `button[aria-label="Show track"]`
- `button[aria-label="Hide track"]`
- `button[aria-label="Solo track"]`
- `#diff-mode`
- `[role="dialog"]` plus title text matching `Keyboard Shortcuts` for the hotkeys modal

### Avoid These

- `radix-...` ids
- `aria-controls` values referencing `radix-...`
- Tailwind class blobs
- DOM position selectors such as `tr:nth-child(3)`

## Menu / Dialog Behavior

### Radix Menus

Observed and inferred:
- Row menus are likely Radix dropdown menus.
- They may render outside the row using a portal.
- The menu content may not exist until after the trigger is clicked.

Safe pattern:

```js
async function waitForMenuItem(match, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const items = Array.from(
      document.querySelectorAll('[role="menuitem"], [data-radix-collection-item]')
    );
    const found = items.find((node) => match(node.innerText || ''));
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}
```

Why this matters:
- If you click too early, you will miss the portal.
- If you scope the search to the row, you may never find the menu because it may not be in the row subtree.

### Keyboard Shortcuts Modal

Observed from live behavior plus extension work:
- The modal title is `Keyboard Shortcuts`
- The button that opens it is labeled `Hotkeys`

Safe pattern:
- Detect the dialog by its visible text, not by the trigger button alone.
- Append documentation to the dialog content area after it opens.
- Use a `MutationObserver` because the modal is created dynamically.

## Known Side Effects

These matter directly when building keyboard helpers or automation.

### Row Click Can Reset Segment Position

Observed during extension work:
- Clicking a transcript row can move the active playhead/segment handle to the start of that segment.

Practical consequence:
- If your goal is only to focus the textarea, do not click the row.

Safer pattern:

```js
const textarea = row.querySelector('textarea[placeholder="What was said…"]');
textarea.focus({ preventScroll: true });
```

### Focusing The Textarea Is Different From Selecting The Row

Observed:
- A row click and a textarea focus are not equivalent side-effect-wise.

Implication:
- Build separate helpers for:
  - row activation
  - editor focus restoration

That is why the current helper extension restores focus after `Esc` without dispatching a synthetic row click.

### Playback Transport Is Not The Dummy Audio Element

Observed during live extension debugging:
- The page may expose an `audio` element that looks usable but is not the real playback transport.
- In live testing this element had `src === null`, `readyState === 0`, and changing `currentTime` did not move Babel playback.
- The actual transport state lived in Wavesurfer instances stored in React hook state on the large waveform hosts.

Practical consequence:
- Do not assume `document.querySelector('audio')` is the source of truth for playback.
- If native playback buttons work and your helper does not, you are probably mutating the wrong transport object.
- A content script can still be the wrong place to touch that transport directly. On the live page, the reliable fix was a page-world bridge script that resolved the Wavesurfer instances from the native transport React tree and applied seeks there.

Safer pattern:
- Prefer the product's own playback controls first.
- If you must implement custom rewind/seek behavior, resolve the real Wavesurfer instances from the waveform host React state and call their own time setters.
- If the real transport hangs off page-owned React objects, inject a web-accessible bridge script and send requests into the page world instead of trusting isolated-world object access.
- Verify against the live dashboard, not only against DOM guesses.

Debugging checklist:
- Compare your helper behavior against `button[aria-label="Jump back 5 seconds"]`.
- Inspect whether the visible `audio` element has a real `src`, duration, and ready state before trusting it.
- Check an actual HTML playback indicator such as the waveform shadow-DOM `cursor` / `progress` parts, not just synthetic method return values.
- Reload the unpacked extension and refresh the dashboard tab after content-script changes, otherwise you may test stale code.

### Synthetic Events May Trigger Analytics

Inferred:
- Because the page loads multiple tracking libraries, synthetic interactions may still be captured.

Implication:
- Keep automation conservative.
- Reuse existing controls rather than dispatching complex custom event chains unnecessarily.

## Recommended Extension Patterns

### 1. Keyboard Navigation Between Transcript Rows

Good use case:
- Move between rows without reaching for the mouse.

Pattern:

```js
const rows = Array.from(document.querySelectorAll('tbody tr')).filter((row) =>
  row.querySelector('textarea[placeholder="What was said…"]')
);

function focusRowByIndex(index) {
  const row = rows[index];
  const textarea = row?.querySelector('textarea[placeholder="What was said…"]');
  textarea?.focus({ preventScroll: true });
}
```

### 2. Safe Delete / Merge

Good use case:
- Expose missing keybinds for actions that are buried in the dropdown.

Pattern:
- Open the row's real action menu
- Wait for portal content
- Match menu item text
- Click the real menu item

Benefits:
- Lets Babel's own handlers perform state updates
- Reduces the chance of corrupting React state

### 3. Augment Existing Help UI

Good use case:
- Show extension hotkeys inside the native help modal

Pattern:
- Observe DOM mutations
- Detect the open dialog by title text
- Append a clearly marked extension-owned section

Benefits:
- No floating overlay needed
- Less intrusive than injecting persistent UI

### 4. Focus Toggle With Remembered Caret

Good use case:
- Temporary "blur out" from the textarea to free up keybinds

Pattern:
- On blur toggle, capture:
  - active row
  - `selectionStart`
  - `selectionEnd`
  - `selectionDirection`
- On restore:
  - if same row is still current, restore the exact selection
  - otherwise focus the current row at position `0`

This is the model currently implemented by the helper extension.

## Patterns To Avoid

### Do Not Rewrite Textarea Values Without Dispatching Input

Inferred:
- React likely tracks controlled or semi-controlled textarea state.

If you must write text:
- set the value
- dispatch an `input` event

Example:

```js
textarea.value = 'new text';
textarea.dispatchEvent(new Event('input', { bubbles: true }));
```

Even then, prefer typing helpers only if needed. A real user edit is less risky than force-setting values.

### Do Not Depend On Color Alone

Observed:
- Speaker lanes and linter states use colors.

Risk:
- Color values can change without semantic behavior changing.

Instead:
- Use text labels
- Use row structure
- Use aria labels

### Do Not Assume One Menu Label Forever

Observed limitation:
- The original saved snapshot did not include an open row dropdown.

Implication:
- Menu item labels for delete/merge are inferred from the UI and extension testing approach.
- The helper extension uses tolerant matching (`delete/remove`, `merge/combine/join`) for that reason.

## Suggested Future Extension Ideas

1. Playback-only keybind layer:
   - Space remap safety
   - quick replay of current segment start/end windows

2. Linter triage tools:
   - next error row
   - previous error row
   - error count badge in the browser action popup

3. Segment structure helpers:
   - one-key merge up/down
   - one-key split at caret if the product supports it
   - speaker copy-down / apply-to-selection if the app supports multi-select

4. Workflow state helpers:
   - autosave visibility
   - submit-readiness checks
   - confirmation prompts before destructive actions

## What Needs Live Verification Before Bigger Extensions

These are still unknown from the static save and should be rechecked in the live page before deeper automation:
- Exact row menu labels for delete and merge
- Whether row textareas are controlled React inputs
- Whether waveform regions are shadow-DOM backed in the live build
- Whether selecting a row always moves the playhead
- Whether save is manual, auto, or hybrid
- Whether there are hidden keyboard shortcuts already bound by the app

## Relationship To The Current Helper Extension

The current extension in this repo follows the safe patterns in this document:
- it targets stable DOM labels
- it uses the real row menu for delete/merge
- it keeps normal waveform clicks native and only creates a temporary cut preview on an explicit `Alt + Drag`
- it commits cut previews by replaying a synthetic modified `click` instead of mutating segment state directly
- it augments the native keyboard-shortcuts dialog instead of keeping a persistent overlay
- it avoids row-click side effects when restoring textarea focus
