# DOM And Workflow Map

## Source

Observed from:
- historical local Babel dashboard capture, not included in this public repository

This is the most important file for extension work because it preserves the rendered DOM, visible labels, and a partial snapshot of portal content.

## Page Identity

Observed:
- Saved-from URL: `https://dashboard.babel.audio/transcription/RU-transcription`
- Title: `Babel Audio - Global Conversational Platform`
- It is a transcription/review workbench, not a marketing page.

Inferred:
- The route belongs to a transcription workflow inside the logged-in dashboard shell.
- The `RU-transcription` suffix likely identifies a project, queue, or task variant.

## Major Layout Regions

The page breaks into three main product areas plus two global utility systems.

### 1. Global Notification Layer

Observed:
- There is a notification region with `aria-label="Notifications (F8)"`.
- There is a second live region with `aria-label="Notifications alt+T"`.
- The UI uses a Sonner-style toast system.

Why this matters:
- Extensions that dispatch actions may trigger toast feedback.
- You can detect success/error toasts by watching the notification region rather than scraping random text.

Potential side effects:
- Triggering app actions may briefly create ephemeral DOM in the toast layer.
- Avoid global selectors that accidentally match toast buttons.

### 2. Top Transport / Utility Bar

Observed controls:
- Zoom slider area with zoom indicator showing `10.0x`
- Playback speed control showing `0.75x`
- `Copy Support ID` button
- `Hotkeys` button
- `Diff View` toggle with stable id `#diff-mode`

Stable hooks:
- `#diff-mode`
- `label[for="diff-mode"]`
- a button whose visible text is `Copy Support ID`
- a button whose visible text is `Hotkeys`

Risk:
- The speed control and zoom control are visually clear but their deeper internal component structure is generated and may change.
- Prefer visible text or role/aria over utility classes.

### 3. Speaker Track / Waveform Area

Observed:
- Two speaker lanes are visible: `Speaker 2` and `Speaker 1`
- Each lane has track visibility controls
- The active lane shows a `Solo track` button
- `Mute` is visible in lane controls
- The waveform renderer uses a shadow-root template

Observed stable aria labels:
- `button[aria-label="Show track"]`
- `button[aria-label="Hide track"]`
- `button[aria-label="Solo track"]`

Observed stable shadow parts:
- `[part="timeline"]`
- `[part="regions-container"]`
- `[part="cursor"]`
- `[part="hover"]`
- `[part="progress"]`
- `[part~="region-handle-left"]`
- `[part~="region-handle-right"]`

Inferred:
- A waveform library or custom renderer exposes region overlays for audio segment editing.
- Segment boundaries are represented visually on the waveform and mirrored in the lower transcript table.

Extension implications:
- The `part` attributes are more stable than class names if you need to inspect the waveform host.
- If the component lives inside shadow DOM in the live app, you may need to walk shadow roots to inspect inner nodes.

Likely side effects:
- Clicking a row or segment may move the playhead to the segment boundary.
- Focusing or selecting a segment may synchronize both the waveform highlight and the active transcript row.

### Waveform Visibility Measurement

Observed from live page inspection on `https://dashboard.babel.audio/transcription/RU-tx-silver`:
- Vertical waveform scale slider was set to `20x`
- Horizontal zoom slider was set to `603`, which is the current timeline widening and does not change vertical amplitude resolution
- The waveform lane height was `150px` CSS
- The backing canvas height was `188px` on a `window.devicePixelRatio` of `1.25`
- Wavesurfer reported `options.height = 150`, `options.barHeight = 20`, `options.normalize = false`
- The renderer path in use was the line waveform renderer, not the bar renderer

Observed from the live renderer code:
- The line renderer maps amplitude against half the canvas height
- At this inspected state, half-height was `188 / 2 = 94` device pixels
- The waveform scale factor was `20`
- One device-pixel vertical step therefore corresponded to approximately `1 / (94 * 20) = 0.000532` full-scale amplitude

Practical conversion:
- `20 * log10(0.000532)` is about `-65.5 dBFS`
- Treat that as the approximate amplitude represented by one visible device-pixel step at `20x`
- In CSS-pixel terms, one CSS pixel is about `1.25` device pixels here, so one CSS-pixel step was about `-63.6 dBFS`

Practical takeaway:
- Horizontal zoom or `3x` widening improves time resolution only. It does not improve the dB resolution of the waveform height.
- For this renderer, only true zero in the sampled time bin is fully invisible. Non-zero audio can still show as a minimum one-pixel trace.
- As a working rule of thumb at `20x`, signals below about `-65 dBFS` are beneath one visible vertical step, and about `-62 dBFS` is the threshold for a roughly two-pixel trace.

### 4. Lower Transcript Editor / Review Panel

Observed controls above the table:
- Speaker selector currently showing `Speaker 1`
- `Jump back 5 seconds` button
- `Play all tracks` button
- `Jump forward 5 seconds` button
- Undo icon button
- Redo icon button
- Status text `1 error`
- `Saved` button
- `Submit Review` button (disabled in the snapshot)

Stable hooks:
- `button[aria-label="Jump back 5 seconds"]`
- `button[aria-label="Play all tracks"]`
- `button[aria-label="Jump forward 5 seconds"]`
- button text `Saved`
- button text `Submit Review`

Observed table headers:
- `ID`
- `Speaker`
- `Start (mm:ss)`
- `End (mm:ss)`
- `Text`
- `Linter`
- `Actions`

Observed row structure:
- Each row is a `tr` inside `tbody`
- The transcript cell uses a textarea
- The textarea placeholder is `What was said…`
- The linter column shows a colored dot
- The action column contains an overflow menu button (`aria-haspopup="menu"`)

Stable row selector strategy:
- Start from `tbody tr`
- Filter to rows containing `textarea[placeholder="What was said…"]`

This is the row predicate used by the helper extension because it avoids dynamic ids and catches actual transcript rows.

Observed linter state:
- There are 6 visible rows
- 5 rows show green dots
- 1 row shows a red dot
- This matches the summary `1 error`

Inferred:
- The linter column is synchronized with row-level validation status.
- The summary text at the panel level likely aggregates row-level linter state.

### 5. Row Action Menus

Observed:
- Each row has an ellipsis/overflow button with `aria-haspopup="menu"`
- The concrete ids are Radix-generated and unstable
- The opened menu contents are not visible in the original saved snapshot

Inferred:
- Delete, merge, and possibly split or speaker reassignment actions are exposed through this menu
- The menu is probably rendered in a portal

Extension implication:
- To trigger row actions safely, click the existing menu button, wait for the portal, then click the correct menu item.
- Do not assume the menu is a child of the row.

Known risk:
- Radix uses generated ids such as `radix-:r1hl:`, which must not be treated as stable selectors.

## Current Workflow Model

Based on the observed UI, the page likely expects the worker to:
1. Navigate audio by track and segment.
2. Select a segment visually or from the row table.
3. Edit the transcript in the row textarea.
4. Use the linter state to resolve errors.
5. Save or auto-save.
6. Submit review when validation passes.

Inferred synchronization points:
- Row selection and waveform selection are probably linked.
- Speaker lane visibility likely affects waveform display, not the table rows directly.
- Diff mode likely changes rendering or comparison state in the workbench.

## Stable Selectors To Prefer

- `#diff-mode`
- `label[for="diff-mode"]`
- `button[aria-label="Jump back 5 seconds"]`
- `button[aria-label="Play all tracks"]`
- `button[aria-label="Jump forward 5 seconds"]`
- `button[aria-label="Show track"]`
- `button[aria-label="Hide track"]`
- `button[aria-label="Solo track"]`
- `textarea[placeholder="What was said…"]`
- `tbody tr`
- `button[aria-haspopup="menu"]` scoped to a transcript row
- `[role="dialog"]` for the hotkeys/keyboard-shortcuts modal
- waveform `part` attributes listed above

## Selectors To Avoid

- ids starting with `radix-`
- `aria-controls` values pointing at `radix-...`
- long Tailwind class strings
- nth-child selectors against the table
- any selector that depends on a specific speaker color

## Browser Extension Side Effects Already Observed

From the helper extension work:
- Clicking the row itself can reset the active segment playhead to the segment start.
- Refocusing the textarea without clicking the row avoids that side effect.
- Portal content for menus and dialogs appears after a render delay and should be awaited.
- Keyboard shortcut overlays can be augmented reliably by watching the dialog after it opens, not by trying to patch the button.

## Safe Interaction Patterns

Focus a transcript textarea without row reselection:

```js
const row = document.querySelector('tbody tr');
const textarea = row?.querySelector('textarea[placeholder="What was said…"]');
textarea?.focus({ preventScroll: true });
```

Find transcript rows:

```js
const rows = Array.from(document.querySelectorAll('tbody tr')).filter((row) =>
  row.querySelector('textarea[placeholder="What was said…"]')
);
```

Trigger a row menu:

```js
const row = rows[0];
const menuButton = row?.querySelector('button[aria-haspopup="menu"]');
menuButton?.click();
```

Wait for a portaled menu item:

```js
const candidates = Array.from(
  document.querySelectorAll('[role="menuitem"], [data-radix-collection-item]')
);
const deleteItem = candidates.find((node) => /delete|remove/i.test(node.innerText));
deleteItem?.click();
```
