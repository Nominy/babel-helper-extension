import { test, expect } from '../../../shared/babel-extension-platform/packages/babel-extension-e2e/src/test.mjs';
import { editors, ready, selectText, openAppearance } from './helper-editing-utils.mjs';

export const appearanceScenarios = {
  websiteAppearance: ['appearance: panel changes editor fonts and reload preserves the chosen sizes', 'appearance: theme and speaker colors repaint real waveform regions and canvas', 'appearance: custom CSS font and gradient apply, unsafe CSS is rejected, disable restores native styling', 'appearance: share import restores a theme and rejects malformed data'],
  proportionalCursorRestore: ['appearance: ghost cursor options persist, share and repaint the visible cursor'],
};

test.beforeEach(async ({ page }) => ready(page));

test(appearanceScenarios.websiteAppearance[0], async ({ page }) => {
  const editor = editors(page).first();
  const nativeSize = await editor.evaluate((element) => getComputedStyle(element).fontSize);
  let panel = await openAppearance(page);
  await panel.getByLabel('Enable custom appearance', { exact: true }).check();
  await panel.getByLabel('Enable Text', { exact: true }).check();
  await panel.getByLabel('Transcript editor text size in pixels').fill('21');
  await panel.getByLabel('Transcript table text size in pixels').fill('18');
  await expect(editor).toHaveCSS('font-size', '21px');
  await panel.getByRole('button', { name: 'Close Website Appearance editor' }).click();
  await page.reload();
  await ready(page);
  await expect(editors(page).first()).toHaveCSS('font-size', '21px');
  panel = await openAppearance(page);
  await expect(panel.getByLabel('Transcript table text size in pixels')).toHaveValue('18');
  await panel.getByLabel('Enable Text', { exact: true }).uncheck();
  await expect(editors(page).first()).toHaveCSS('font-size', nativeSize);
  await panel.getByRole('button', { name: 'Reset appearance', exact: true }).click();
  await expect(panel.getByLabel('Enable custom appearance', { exact: true })).not.toBeChecked();
});

test(appearanceScenarios.websiteAppearance[1], async ({ page, babel }) => {
  const regions = page.locator('[part~="region"]');
  await expect(regions.first()).toBeVisible();
  const originalFill = await regions.first().evaluate((element) => getComputedStyle(element).backgroundColor);
  await babel.setExtensionSettings('helper', { websiteAppearance: {
    enabled: true, themeEnabled: true, pageColor: '#112233', waveColor: '#123456',
    speakerColors: ['#cc2200', '#0088cc', '#22aa44'],
  } });
  // Region DOM is in WaveSurfer's open shadow root, not a helper-created stand-in.
  await expect(regions.first()).toHaveCSS('background-color', 'rgba(204, 34, 0, 0.25)');
  await expect(page.locator('[part~="region"]').last()).toHaveCSS('background-color', 'rgba(0, 136, 204, 0.25)');
  await expect.poll(() => page.locator('canvas').evaluateAll((canvases) => canvases.some((canvas) => {
    if (!canvas.width || !canvas.height) return false;
    const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) return false;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 18 && pixels[i + 1] === 52 && pixels[i + 2] === 86 && pixels[i + 3] > 0) return true;
    return false;
  }))).toBe(true);
  await editors(page).first().fill('Изменение вызывает перерисовку.');
  await expect(regions.first()).toHaveCSS('background-color', 'rgba(204, 34, 0, 0.25)');
  await babel.setExtensionSettings('helper', { websiteAppearance: { themeEnabled: false } });
  await expect(regions.first()).toHaveCSS('background-color', originalFill);
});

test(appearanceScenarios.websiteAppearance[2], async ({ page }) => {
  const editor = editors(page).first();
  const nativeFont = await editor.evaluate((element) => getComputedStyle(element).fontFamily);
  const panel = await openAppearance(page);
  await panel.getByLabel('Enable custom appearance', { exact: true }).check();
  await panel.locator('summary').click();
  await panel.getByLabel('Enable Gradient', { exact: true }).check();
  await expect.poll(() => page.locator('body').evaluate((element) => {
    const style = getComputedStyle(element);
    const before = getComputedStyle(element, '::before');
    return [style.backgroundImage, before.backgroundImage].join(' ');
  })).toContain('gradient');
  await panel.getByLabel('Apply expert CSS', { exact: true }).check();
  await panel.getByLabel('Custom CSS', { exact: true }).fill('tbody textarea { font-family: monospace !important; border-left: 7px solid rgb(17, 34, 51) !important; }');
  await expect(editor).toHaveCSS('font-family', 'monospace');
  await expect(editor).toHaveCSS('border-left-width', '7px');
  await panel.getByLabel('Custom CSS', { exact: true }).fill('@import url("https://invalid.example/remote.css");');
  await expect(panel.locator('#custom-css-status')).toBeVisible();
  await expect(panel.locator('#custom-css-status')).not.toHaveText('');
  await expect(panel.getByLabel('Custom CSS', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(editor).toHaveCSS('font-family', nativeFont);
  await panel.getByLabel('Custom CSS', { exact: true }).fill('tbody textarea { font-family: monospace !important; border-left: 7px solid rgb(17, 34, 51) !important; }');
  await expect(editor).toHaveCSS('font-family', 'monospace');
  await panel.getByLabel('Enable custom appearance', { exact: true }).uncheck();
  await expect(editor).toHaveCSS('font-family', nativeFont);
  await expect(editor).not.toHaveCSS('border-left-width', '7px');
});

test(appearanceScenarios.websiteAppearance[3], async ({ page }) => {
  const panel = await openAppearance(page);
  await panel.getByLabel('Enable custom appearance', { exact: true }).check();
  await panel.getByLabel('Enable Text', { exact: true }).check();
  await panel.getByLabel('Transcript editor text size in pixels').fill('23');
  await panel.locator('summary').click();
  const share = panel.getByLabel('Website Appearance share string', { exact: true });
  await expect(share).toHaveValue(/^wa1\./);
  const exported = await share.inputValue();
  await panel.getByRole('button', { name: 'Reset appearance', exact: true }).click();
  await panel.getByLabel('Website Appearance share string to import').fill(exported);
  await panel.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(editors(page).first()).toHaveCSS('font-size', '23px');
  await panel.getByLabel('Website Appearance share string to import').fill('wa1.not-valid');
  await panel.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(panel.locator('#theme-status')).toContainText(/not a valid/i);
  await expect(editors(page).first()).toHaveCSS('font-size', '23px');
});

test(appearanceScenarios.proportionalCursorRestore[0], async ({ page, babel }) => {
  const options = await babel.options('helper');
  await options.getByRole('button', { name: 'Customize ghost cursor', exact: true }).click();
  await options.getByLabel('Enable animated gradient').check();
  await options.locator('[data-role="ghost-cursor-thickness"]').focus();
  await options.keyboard.press('End');
  await options.getByLabel('Gradient motion').selectOption('snappy');
  await expect(options.locator('[data-role="status"]')).toContainText('Saved.');
  const shared = await options.getByLabel('Share settings', { exact: true }).inputValue();
  await options.reload();
  await options.getByRole('button', { name: 'Customize ghost cursor', exact: true }).click();
  await expect(options.getByLabel('Gradient motion')).toHaveValue('snappy');
  await expect(options.locator('[data-role="ghost-cursor-thickness"]')).toHaveValue('8');
  await options.locator('[data-role="ghost-cursor-thickness"]').focus();
  await options.keyboard.press('Home');
  await options.getByLabel('Import settings', { exact: true }).fill(shared);
  await options.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(options.locator('[data-role="ghost-cursor-thickness"]')).toHaveValue('8');
  await options.close();
  await selectText(editors(page).first(), 4);
  await page.keyboard.press('Escape');
  const ghost = page.locator('[data-babel-helper-ghost-cursor]');
  await expect(ghost).toBeVisible();
  await expect(ghost).toHaveCSS('width', '8px');
  await expect(ghost).toHaveCSS('background-image', /linear-gradient/);
  await expect(ghost).toHaveCSS('animation-name', /babel-helper-ghost-cursor-gradient/);
});
