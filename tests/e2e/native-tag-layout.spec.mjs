import { test, expect } from '@nominy/babel-extension-e2e/test';
import { ready, editors, readText } from './helper-editing-utils.mjs';

test.use({ extensions: ['helper'] });
test('native tag labels remain readable across editing and playback without changing removal or Undo', async ({ page, babel }, testInfo) => {
  await babel.setExtensionSettings('helper', { features: { audioEnhancement: false }, websiteAppearance: { enabled: false } });
  const { action } = await babel.state();
  const original = 'До [смех] после.';
  await babel.reset('baseline', { action: { annotations: action.annotations.map((turn, index) => index === 0
    ? { ...turn, content: original } : turn) } });
  await ready(page);
  await page.evaluate(() => document.fonts.ready);
  const row = page.locator('section[data-annotation-id]').first();
  const editor = editors(page).first();
  const chip = row.locator('[data-chip], [data-slate-inline="true"]');
  const measure = () => chip.evaluate(tag => {
    const rect = tag.getBoundingClientRect(), style = getComputedStyle(tag);
    const label = document.createRange(); label.selectNodeContents(tag.firstChild);
    const tightWidth = label.getBoundingClientRect().width + parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    return { width: rect.width, height: rect.height, tightWidth };
  });
  const assertReadable = async expected => {
    const actual = await measure();
    expect(actual.width + 0.5).toBeGreaterThanOrEqual(expected.width);
    expect(actual.height + 0.5).toBeGreaterThanOrEqual(expected.height);
    expect(actual.width + 0.5).toBeGreaterThanOrEqual(actual.tightWidth);
    expect(await readText(editor)).toBe(original);
  };
  for (const appearance of [false, true]) {
    if (appearance) {
      await babel.setExtensionSettings('helper', { websiteAppearance: { enabled: true } });
      await expect(page.locator('html')).toHaveAttribute('data-babel-helper-appearance', 'enabled');
    }
    await expect(row.locator('[data-chip]')).toBeVisible();
    const initial = await measure();
    expect(initial.width + 0.5).toBeGreaterThanOrEqual(initial.tightWidth);
    // Enter editing through the chip label without triggering removal.
    await chip.click({ position: { x: initial.width / 2, y: initial.height / 2 } });
    await expect(row.locator('[data-slate-editor="true"]')).toBeVisible();
    await assertReadable(initial);
    await page.getByRole('button', { name: 'Play all tracks', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause all tracks', exact: true })).toBeVisible();
    await expect(row.locator('[data-chip]')).toBeVisible();
    await assertReadable(initial);
    await page.getByRole('button', { name: 'Pause all tracks', exact: true }).click();
    await editor.click();
    await expect(row.locator('[data-slate-editor="true"]')).toBeVisible();
    await assertReadable(initial);
    await page.screenshot({ path: testInfo.outputPath(`native-tag-stable-${appearance ? 'appearance' : 'native'}.png`) });
    await page.locator('[aria-label="Play all tracks"]').focus();
    await expect(row.locator('[data-chip]')).toBeVisible();
  }
  await editor.click();
  await expect(row.locator('[data-slate-editor="true"]')).toBeVisible();
  const beforeHover = await measure();
  await chip.hover();
  const remove = row.getByRole('button', { name: 'Remove смех tag', exact: true });
  await expect(remove).toHaveCSS('opacity', '1');
  await assertReadable(beforeHover);
  expect((await measure()).width).toBeCloseTo(beforeHover.width, 1);
  const overlapsLabel = await chip.evaluate(tag => {
    const label = document.createRange(); label.selectNodeContents(tag.firstChild);
    const text = label.getBoundingClientRect(), button = tag.querySelector('button').getBoundingClientRect();
    return Math.min(text.right, button.right) - Math.max(text.left, button.left) > 0.5 &&
      Math.min(text.bottom, button.bottom) - Math.max(text.top, button.top) > 0.5;
  });
  expect(overlapsLabel).toBe(false);
  await remove.click();
  await expect.poll(() => readText(editor)).not.toContain('[смех]');
  await editor.press('ControlOrMeta+KeyZ');
  await expect.poll(() => readText(editor)).toBe(original);
  await expect(chip).toHaveCount(1);
});
