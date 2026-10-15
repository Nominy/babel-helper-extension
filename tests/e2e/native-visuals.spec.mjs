import { test, expect } from '@nominy/babel-extension-e2e/test';
import { saved, rows as nativeRows } from '@nominy/babel-extension-e2e/native-helpers';
import { editors, ready, fillText, readText, selectText, row, readRows, caret } from './helper-editing-utils.mjs';

const MENU = '[data-babel-helper-quick-region-listbox]';
const MAP = '[data-babel-helper-minimap]';

export const featureScenarios = {
  quickRegionAutocomplete: [
    'native autocomplete: wrapping and tag-part deletion retain native undo and save',
    'native autocomplete: native picker remains authoritative and disabling closes pending wrapping',
    'native readonly: Helper mutations stay denied while native local edits retain Undo without saving',
  ],
  customLinter: ['native readonly: Helper mutations stay denied while native local edits retain Undo without saving'],
  minimap: ['native minimap: dense and empty transcripts survive live disable and re-enable'],
  hotkeysHelp: ['native visual settings: open shortcut help and tooltip styles clean up live'],
  wavesurferTooltipEllipsis: ['native visual settings: open shortcut help and tooltip styles clean up live'],
};

test(featureScenarios.quickRegionAutocomplete[0], async ({ page, babel }) => {
  await ready(page);
  const editor = editors(page).first();
  const original = 'Тихая речь.';
  const committedText = () => page.evaluate(() =>
    window.__BABEL_E2E__.snapshot().annotations.find((annotation) => annotation.id === 'row-1')?.content);
  await fillText(editor, original);
  await editors(page).nth(1).click();
  await expect.poll(committedText).toBe(original);
  await selectText(editor, 0, 5);
  await page.keyboard.press('Shift+Comma');
  const menu = page.locator(MENU);
  const option = menu.getByRole('option').first();
  await expect(option).toBeVisible();
  const tag = (await option.innerText()).trim();
  await option.click();
  const wrapped = `<${tag}> Тихая </${tag}> речь.`;
  await expect.poll(() => readText(editor)).toBe(wrapped);
  await caret(editor, `<${tag}> Тихая </${tag}>`.length);
  await page.keyboard.press('Escape');
  // A raw Slate value is visible before its native 400ms history commit.
  await expect.poll(committedText).toBe(wrapped);
  await page.keyboard.press('Control+z');
  await expect.poll(() => readText(editor)).toBe(original);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => readText(editor)).toBe(wrapped);
  await selectText(editor, `<${tag}>`.length);
  await page.keyboard.press('Backspace');
  await expect.poll(() => readText(editor)).toBe(` Тихая </${tag}> речь.`);
  await caret(editor, 0);
  await page.keyboard.press('Control+z');
  await expect.poll(() => readText(editor)).toBe(wrapped);
  // Undo the deletion while editing, before native blur introduces its own
  // whitespace-normalization command; then verify the actual committed value.
  await page.keyboard.press('Escape');
  await expect.poll(committedText).toBe(wrapped);
  await saved(page, babel);
  expect((await babel.state()).action.annotations.find((annotation) => annotation.id === 'row-1').content).toBe(wrapped);
});

test(featureScenarios.quickRegionAutocomplete[1], async ({ page, babel }) => {
  await ready(page);
  const editor = editors(page).first();
  await fillText(editor, '');
  await page.keyboard.press('Shift+Comma');
  await expect(row(page, 0).getByRole('list').getByRole('button').first()).toBeVisible();
  await expect(page.locator(MENU)).toBeHidden();
  await page.keyboard.press('Escape');
  await fillText(editor, 'Тихая речь.');
  await selectText(editor, 0, 5);
  await page.keyboard.press('Shift+Comma');
  await expect(page.locator(MENU)).toBeVisible();
  await babel.setExtensionSettings('helper', { features: { quickRegionAutocomplete: false } });
  await expect(page.locator(MENU)).toHaveCount(0);
  await expect.poll(() => readText(editor)).toBe('Тихая речь.');
  await babel.setExtensionSettings('helper', { features: { quickRegionAutocomplete: true } });
  await selectText(editor, 0, 5);
  await page.keyboard.press('Shift+Comma');
  await expect(page.locator(MENU)).toHaveCount(1);
});

test(featureScenarios.quickRegionAutocomplete[2], async ({ page, babel }) => {
  await babel.reset('readonly');
  await expect(nativeRows(page)).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Website Appearance', exact: true })).toBeVisible();
  const before = await readRows(page);
  await expect(editors(page)).toHaveCount(4);
  await expect(page.locator(MENU)).toBeHidden();
  expect(await readRows(page)).toEqual(before);

  // Oct15 intentionally permits a local native draft on read-only tasks.
  // Its visible textbox is not permission for Helper to write that draft.
  const editor = editors(page).first();
  const local = '  Локальный  черновик.';
  await fillText(editor, local);
  await expect.poll(() => readText(editor)).toBe(local);
  await selectText(editor, local.length);
  // These are Helper commands. Plain typing/Backspace and the native picker
  // intentionally remain available for local-only edits on this task.
  for (const key of ['Alt+KeyF', 'Alt+Shift+KeyF']) await page.keyboard.press(key);
  await expect.poll(() => readText(editor)).toBe(local);
  await caret(editor, local.length);
  await expect(page.locator(MENU)).toBeHidden();
  const denied = await nativeRows(page).first().evaluate(element => {
    return ['replace', 'focus', 'select', 'syncSelection'].map(operation => {
      const id = crypto.randomUUID();
      element.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
        bubbles: true, detail: JSON.stringify({ id, annotationId: element.dataset.annotationId,
          operation, text: 'Must not change the local draft.', start: 0, end: 0 })
      }));
      const result = JSON.parse(element.getAttribute('data-babel-helper-editor-result'));
      element.removeAttribute('data-babel-helper-editor-result');
      if (result.id !== id) throw new Error('Native editor bridge did not answer this request');
      return { operation, ok: result.ok, reason: result.reason };
    });
  });
  expect(denied).toEqual(['replace', 'focus', 'select', 'syncSelection']
    .map(operation => ({ operation, ok: false, reason: 'read-only' })));
  await expect.poll(() => readText(editor)).toBe(local);
  await caret(editor, local.length);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => readText(editor)).toBe(before[0].text);
  await page.keyboard.press('Enter');
  expect(await readRows(page)).toEqual(before);
  // Native typing and its picker remain available; only Helper wrapping is denied.
  await editor.click();
  await page.keyboard.press('Shift+Comma');
  await expect(nativeRows(page).first().getByRole('list')).toBeVisible();
  await expect(page.locator(MENU)).toBeHidden();
  await expect.poll(() => readText(editor)).toContain('<');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');
  expect((await babel.state()).action.annotations.map(annotation => annotation.content)).toEqual(before.map(turn => turn.text));
  expect((await babel.state()).calls.filter((call) => /saveAnnotations|submit/.test(call.procedure || call.path || ''))).toEqual([]);
});

test(featureScenarios.minimap[0], async ({ page, babel }) => {
  const { action } = await babel.state();
  const template = action.annotations[0];
  const annotations = Array.from({ length: 650 }, (_, index) => ({
    ...template, id: `dense-${index}`, startTimeInSeconds: index * 0.017,
    endTimeInSeconds: index * 0.017 + 0.012, content: `Фраза ${index}.`,
  }));
  await babel.reset('baseline', { action: { annotations } });
  await expect(nativeRows(page)).toHaveCount(annotations.length);
  const map = page.locator(MAP);
  await expect(map).toBeVisible();
  await expect.poll(() => map.evaluate((element) => [...element.querySelectorAll('canvas')].reduce((count, canvas) => {
    const regions = [...canvas.parentElement.children].find((child) => child.style.zIndex === '2');
    return count + (regions?.childElementCount || 0);
  }, 0))).toBe(annotations.length);
  for (const enabled of [false, true, false, true]) {
    await babel.setExtensionSettings('helper', { features: { minimap: enabled } });
    await expect(map).toHaveCount(enabled ? 1 : 0);
    if (enabled) await expect(map.locator('canvas')).toHaveCount(2);
  }
  await babel.reset('baseline', { action: { annotations: [] } });
  await expect(nativeRows(page)).toHaveCount(0);
  await expect(map).toBeVisible();
  await expect(map.locator('canvas')).toHaveCount(2);
  await expect.poll(() => map.evaluate((element) => [...element.querySelectorAll('canvas')].reduce((count, canvas) => {
    const regions = [...canvas.parentElement.children].find((child) => child.style.zIndex === '2');
    return count + (regions?.childElementCount || 0);
  }, 0))).toBe(0);
  // Empty region layers can render while automatic enhancement is still replacing
  // native buffers. Navigate only after that genuine source commit is complete.
  const enhancement = page.locator('[data-babel-helper-audio-enhancement]');
  await expect(enhancement.locator('[data-selection]')).toHaveText('90%');
  await expect(enhancement).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.ready)).toBe(true);
  const box = await map.boundingBox();
  await map.click({ position: { x: box.width * 0.75, y: box.height / 2 } });
  await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks.map((track) => Math.round(track.currentTime)))).toEqual([9, 9]);
});

test(featureScenarios.hotkeysHelp[0], async ({ page, babel }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts', exact: true });
  const help = dialog.locator('[data-babel-helper-hotkeys]');
  await expect(help).toHaveCount(1);
  await babel.setExtensionSettings('helper', { features: { hotkeysHelp: false, wavesurferTooltipEllipsis: false } });
  await expect(dialog).toBeVisible();
  await expect(help).toHaveCount(0);
  await expect(page.locator('#babel-helper-wavesurfer-tooltip-ellipsis')).toHaveCount(0);
  await babel.setExtensionSettings('helper', { features: { hotkeysHelp: true, wavesurferTooltipEllipsis: true } });
  await expect(help).toHaveCount(1);
  await expect(page.locator('#babel-helper-wavesurfer-tooltip-ellipsis')).toHaveCount(1);
});

test('native magnifier: disabling during a drag destroys the view and re-enabling does not duplicate it', async ({ page, babel }) => {
  await ready(page);
  const edge = page.locator('[data-babel-helper-minimap-host]').first().locator('[part~="region-handle-right"]').first();
  await expect(edge).toBeVisible();
  const box = await edge.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 8, box.y + box.height / 2, { steps: 4 });
  const magnifier = page.locator('[data-babel-helper-magnifier]');
  await expect(magnifier).toBeVisible();
  await babel.setExtensionSettings('helper', { features: { magnifier: false } });
  await expect(magnifier).toHaveCount(0);
  await page.mouse.up();
  await babel.setExtensionSettings('helper', { features: { magnifier: true } });
  const next = await edge.boundingBox();
  await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2);
  await page.mouse.down();
  await page.mouse.move(next.x + 8, next.y + next.height / 2, { steps: 4 });
  await expect(magnifier).toHaveCount(1);
  await expect(magnifier.locator('canvas').first()).toBeVisible();
  await page.mouse.up();
  await expect(magnifier).toHaveCount(0);
});

featureScenarios.magnifier = ['native magnifier: disabling during a drag destroys the view and re-enabling does not duplicate it'];
