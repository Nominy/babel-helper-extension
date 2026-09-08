import { test, expect } from '@nominy/babel-extension-e2e/test';
import { editors, ready, selectText, openAppearance } from './helper-editing-utils.mjs';

export const featureScenarios = {
  hotkeysHelp: ['hotkeysHelp: native shortcut dialog reflects enabled features without duplicates'],
  extendedDiffView: ['extendedDiffView: readonly reference, current and fusion expose text, tags, segmentation and timestamp changes'],
  selectedNumberToSkaz: ['lifecycle: options toggle removes and reinstalls keyboard handling exactly once'],
  focusToggle: ['lifecycle: leaving and revisiting a task disposes session handlers'],
};
export const distributionScenarios = {
  'dist/userscript/babel-mods.js': ['userscript: built SDK registers a scoped interactive mod and disposal removes its behavior'],
};

test(featureScenarios.hotkeysHelp[0], async ({ page, babel }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts', exact: true });
  const helper = dialog.locator('[data-babel-helper-hotkeys]');
  await expect(helper).toBeVisible();
  await expect(helper.getByText('Move text before caret to previous segment', { exact: true })).toBeVisible();
  await expect(helper.getByText('Auto-fix lint issues in current row', { exact: true })).toBeVisible();
  await expect(helper.getByText('Toggle Website Appearance editor', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await babel.setExtensionSettings('helper', { features: { textMove: false } });
  await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
  await expect(helper.getByText('Move text before caret to previous segment', { exact: true })).toHaveCount(0);
  await expect(helper.getByText('Auto-fix lint issues in current row', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await babel.setExtensionSettings('helper', { features: { hotkeysHelp: false } });
  await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
  await expect(helper).toHaveCount(0);
  await expect(dialog.getByText('Global Controls', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await babel.setExtensionSettings('helper', { features: { hotkeysHelp: true, textMove: true } });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
    await expect(helper).toHaveCount(1);
    await expect(helper.getByText('Move text before caret to previous segment', { exact: true })).toHaveCount(1);
    await page.keyboard.press('Escape');
  }
});

test(featureScenarios.selectedNumberToSkaz[0], async ({ page, babel }) => {
  await ready(page);
  const options = await babel.options('helper');
  const toggle = options.locator('input[name="selectedNumberToSkaz"]');
  for (const enabled of [false, true, false, true]) {
    await toggle.setChecked(enabled);
    await expect(options.locator('[data-role="status"]')).toContainText('Saved.');
    await page.bringToFront();
    const editor = editors(page).first();
    await editor.fill('пять');
    await selectText(editor, 0, 4);
    await page.keyboard.press('5');
    await expect(editor).toHaveValue(enabled ? '5 {СКАЗ: пять}' : '5');
    await editors(page).nth(1).click();
    await expect(editor).toHaveValue(enabled ? '5 {СКАЗ: пять}' : '5');
    await options.bringToFront();
  }
  await options.reload();
  await expect(toggle).toBeChecked();
  await options.getByRole('button', { name: 'Reset all settings', exact: true }).click();
  await expect(options.locator('[data-role="status"]')).toContainText('Saved.');
  await expect(toggle).toBeChecked();
  await options.close();
});

test(featureScenarios.focusToggle[0], async ({ page, babel }) => {
  await ready(page);
  await babel.setExtensionSettings('helper', { features: { proportionalCursorRestore: false } });
  const taskURL = page.url();
  await babel.installUserscript();
  await page.evaluate(() => {
    window.BabelModsSDK.register({
      id: 'e2e-navigation-consumer',
      activate(context) {
        const output = document.createElement('output');
        output.setAttribute('aria-label', 'Active Helper consumer session');
        output.textContent = 'Task editing available';
        document.body.append(output);
        context.scope.add(() => output.remove());
      },
    });
  });
  const activeConsumer = page.getByLabel('Active Helper consumer session');
  await expect(activeConsumer).toHaveText('Task editing available');
  for (let visit = 0; visit < 3; visit += 1) {
    // Browser history, not synthetic session/bridge events: exercise the SPA navigation observer.
    await page.evaluate(() => { history.pushState({}, '', '/projects'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await expect(activeConsumer).toHaveCount(0);
    await page.evaluate((url) => { history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate')); }, taskURL);
    await ready(page);
    await expect(activeConsumer).toHaveCount(1);
    await expect(activeConsumer).toHaveText('Task editing available');
    const editor = editors(page).first();
    await selectText(editor, 4);
    await page.keyboard.press('Escape');
    await expect(editor).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(editor).toBeFocused();
    await editor.fill('пять');
    await selectText(editor, 0, 4);
    await page.keyboard.press('5');
    await expect(editor).toHaveValue('5 {СКАЗ: пять}');
    // Two leaked toggle handlers would cancel each other and leave the panel closed.
    await page.keyboard.press('Alt+Shift+KeyP');
    await expect(page.locator('[data-babel-helper-appearance-panel]').getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Alt+Shift+KeyP');
    await expect(page.locator('[data-babel-helper-appearance-panel]').getByRole('dialog')).toBeHidden();
  }
  await babel.reset();
  await ready(page);
  await expect(editors(page).first()).toHaveValue('Привет, это тестовая запись.');
  const panel = await openAppearance(page);
  await expect(panel).toBeVisible();
});

test(featureScenarios.extendedDiffView[0], async ({ page, babel }) => {
  await babel.reset('diff');
  const original = (await babel.state()).action.annotations;
  await expect(page.getByRole('button', { name: 'Hotkeys', exact: true })).toBeVisible();
  const diffSwitch = page.getByRole('switch').first();
  await diffSwitch.setChecked(true);
  const modes = page.locator('#bh-segmentation-mode-controls');
  await expect(modes).toBeVisible();
  await modes.locator('[data-mode="fusion"]').click();
  const table = page.locator('table').filter({ hasText: 'Speaker' }).first();
  await expect(table).toContainText('пробная');
  await expect(table).toContainText('тестовая');
  await expect(table).toContainText('[смех]');
  await expect(table).toContainText('Удалённая тестовая фраза.');
  // Both reference and current boundaries are genuinely drawn over the decoded waveform.
  const oldTime = page.locator('[title*="timestamp shift"][title*="old segment 0.200s-2.800s"]');
  const newTime = page.locator('[title*="timestamp shift"][title*="new segment 0.500s-2.500s"]');
  await expect(oldTime).toBeVisible();
  await expect(newTime).toBeVisible();
  const oldBox = await oldTime.boundingBox(), newBox = await newTime.boundingBox();
  expect(oldBox.x).toBeLessThan(newBox.x);
  expect(oldBox.width).toBeGreaterThan(newBox.width);
  await expect(page.locator('[title*="old segment"][title*="deleted"]')).toBeVisible();
  await modes.locator('[data-mode="reference"]').click();
  await expect(table).toContainText('Привет это пробная запись');
  await expect(table).not.toContainText('Привет, это тестовая запись.');
  await modes.locator('[data-mode="current"]').click();
  await expect(table).toContainText('Привет, это тестовая запись.');
  await expect(table).not.toContainText('пробная');
  await expect(table).not.toContainText('[смех]');
  await page.keyboard.press('Alt+Shift+KeyF');
  await page.keyboard.press('KeyD');
  expect((await babel.state()).action.annotations).toEqual(original);
  await babel.setExtensionSettings('helper', { features: { extendedDiffView: false } });
  await expect(modes).toHaveCount(0);
  await expect(oldTime).toHaveCount(0);
  await expect(newTime).toHaveCount(0);
});

test(distributionScenarios['dist/userscript/babel-mods.js'][0], async ({ page, babel }) => {
  await ready(page);
  await babel.installUserscript();
  // This is a consumer userscript using the shipped SDK, not a copy of Helper implementation.
  await page.evaluate(() => {
    const sdk = window.BabelModsSDK;
    sdk.requireCompatible();
    window.e2eUserscriptClicks = 0;
    window.e2eUserscriptHandle = sdk.register(sdk.define({
      id: 'e2e-consumer-click-counter',
      activate(context) {
        const button = document.createElement('button');
        button.textContent = 'Consumer userscript counter: 0';
        button.style.cssText = 'position:fixed;right:8px;top:8px;z-index:2147483647;background:white;color:black;padding:8px';
        document.body.append(button);
        const increment = () => { window.e2eUserscriptClicks += 1; button.textContent = `Consumer userscript counter: ${window.e2eUserscriptClicks}`; };
        button.addEventListener('click', increment, { signal: context.signal });
        context.scope.add(() => button.remove());
        // Retain only a DOM reference so disposal can be tested even after removal.
        window.e2eUserscriptButton = button;
      },
    }));
  });
  const button = page.getByRole('button', { name: 'Consumer userscript counter: 0', exact: true });
  await button.click();
  await expect(page.getByRole('button', { name: 'Consumer userscript counter: 1', exact: true })).toBeVisible();
  await page.evaluate(async () => { await window.e2eUserscriptHandle.dispose(); await window.e2eUserscriptHandle.dispose(); });
  await expect(page.getByRole('button', { name: /Consumer userscript counter:/ })).toHaveCount(0);
  await page.evaluate(() => window.e2eUserscriptButton.click());
  expect(await page.evaluate(() => window.e2eUserscriptClicks)).toBe(1);
  await editors(page).first().fill('пять');
  await selectText(editors(page).first(), 0, 4);
  await page.keyboard.press('5');
  await expect(editors(page).first()).toHaveValue('5 {СКАЗ: пять}');
});
