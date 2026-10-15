import { test, expect } from '@nominy/babel-extension-e2e/test';
import { editors, row, ready, fillText, readText, selectText, textSelection, enableOnlyLinterRules } from './helper-editing-utils.mjs';

test.use({ extensions: ['helper'] });

const texts = ['Это первый контроль.', 'Это второй контроль.', 'Это третий контроль.', ''];
const pending = (page, index) => row(page, index).getByRole('button', { name: 'My transcription is correct', exact: true });
const accepted = (page, index) => row(page, index).getByRole('button', { name: /^(Show|Hide) 1 confirmed warning$/ });
const highlightedReason = 'Highlighted word requires clearance before use.';
const nativeWarnings = (page, index) => row(page, index).evaluate(element =>
  window.__BABEL_E2E__.snapshot().annotations.find(annotation => annotation.id === element.dataset.annotationId)
    ?.metadata?.assertedWarnings ?? []);

async function prepareWarnings(page, babel) {
  await ready(page);
  await enableOnlyLinterRules(babel, ['highlighted-words']);
  await babel.setExtensionSettings('helper', { features: { hideInlineIssues: false }, highlightedWordsEnabled: true, highlightedWords: ['контроль'] });
  for (let index = 0; index < texts.length; index += 1) await fillText(editors(page).nth(index), texts[index]);
  await editors(page).first().click();
  for (let index = 0; index < 3; index += 1) {
    await expect(row(page, index).locator('[role="img"][aria-label]')).toHaveAccessibleName(highlightedReason);
    await expect.poll(() => nativeWarnings(page, index)).not.toContain(highlightedReason);
  }
  await expect(pending(page, 0)).toBeVisible();
  await expect(pending(page, 1)).toHaveCount(0);
  await expect(row(page, 3).locator('[role="img"][aria-label]')).not.toHaveAccessibleName(/^(No issues|Checking…)$/);
}

async function expectAcceptedWithoutEdits(page) {
  for (let index = 0; index < 3; index += 1) {
    await expect.poll(() => nativeWarnings(page, index)).toContain(highlightedReason);
    await expect(row(page, index).locator('[role="img"][aria-label]')).toHaveAccessibleName('No issues');
  }
  await expect(row(page, 3).locator('[role="img"][aria-label]')).not.toHaveAccessibleName(/^(No issues|Checking…)$/);
  await expect.poll(() => nativeWarnings(page, 3)).toEqual([]);
  await expect(editors(page)).toHaveCount(texts.length);
  for (let index = 0; index < texts.length; index += 1) await expect.poll(() => readText(editors(page).nth(index))).toBe(texts[index]);
}

test('warnings.acceptAll: native acknowledgement includes offscreen rows, preserves errors and never toggles accepted warnings', async ({ page, babel }) => {
  // Exercise the native queue route without changing task routing after edits.
  const url = new URL(page.url());
  url.searchParams.delete('reviewActionId');
  await page.goto(url.href);
  await prepareWarnings(page, babel);
  await pending(page, 0).click();
  await expect(accepted(page, 0)).toBeVisible();
  const errorLabel = await row(page, 3).locator('[role="img"][aria-label]').getAttribute('aria-label');
  const persistedAnnotations = (await babel.state()).action.annotations;
  // Leave a real transcript viewport below the native waveform panels.
  const heightControl = page.getByRole('button', { name: /^Waveform height:/ });
  for (let step = 0; step < 3 && await heightControl.getAttribute('aria-label') !== 'Waveform height: Medium'; step++) {
    await heightControl.click();
  }
  await expect(heightControl).toHaveAccessibleName('Waveform height: Medium');
  await page.setViewportSize({ width: 1280, height: 600 });
  await editors(page).first().scrollIntoViewIfNeeded();
  await selectText(editors(page).first(), 4, 10);
  const selection = await textSelection(editors(page).first());
  expect(await editors(page).nth(2).evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.top >= innerHeight || box.bottom <= 0;
  })).toBe(true);
  await page.keyboard.press('Alt+Shift+KeyA');
  await expectAcceptedWithoutEdits(page);
  expect(await textSelection(editors(page).first())).toEqual(selection);
  await expect(editors(page).first()).toBeFocused();
  await page.keyboard.press('Alt+Shift+KeyA');
  await expectAcceptedWithoutEdits(page);
  await expect(row(page, 3).locator('[role="img"][aria-label]')).toHaveAccessibleName(errorLabel);
  const state = await babel.state();
  expect(state.submitted).toBe(false);
  expect(state.action.annotations).toEqual(persistedAnnotations);
});

test('warnings.acceptAll: Shortcuts replacement, clear and reset update the action and its help live', async ({ page, babel }) => {
  await prepareWarnings(page, babel);
  const options = await babel.options('helper');
  await options.getByRole('button', { name: 'Shortcuts', exact: true }).click();
  const shortcut = options.getByRole('group', { name: 'Accept all linter warnings', exact: true });
  await expect(shortcut.locator('kbd')).toHaveText('Alt + Shift + A');
  await shortcut.getByRole('button', { name: 'Record replacement: Accept all linter warnings', exact: true }).click();
  await options.keyboard.press('Alt+Shift+KeyW');
  await expect(shortcut.locator('kbd')).toHaveText('Alt + Shift + W');
  await expect(options.locator('[data-role="status"]')).toContainText('Saved.');
  await page.bringToFront();
  await page.getByRole('button', { name: 'Hotkeys', exact: true }).click();
  const help = page.getByRole('dialog', { name: 'Keyboard Shortcuts', exact: true }).locator('[data-babel-helper-hotkeys]');
  await expect(help.getByText('Accept all linter warnings without changing transcript text', { exact: true }).locator('..')).toContainText('Alt + Shift + W');
  await page.keyboard.press('Escape');
  await editors(page).first().click();
  await page.keyboard.press('Alt+Shift+KeyA');
  for (let index = 0; index < 3; index += 1) {
    await expect.poll(() => nativeWarnings(page, index)).not.toContain(highlightedReason);
    await expect(row(page, index).locator('[role="img"][aria-label]')).toHaveAccessibleName(highlightedReason);
  }
  await page.keyboard.press('Alt+Shift+KeyW');
  await expectAcceptedWithoutEdits(page);

  await accepted(page, 0).click();
  await row(page, 0).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(pending(page, 0)).toBeVisible();
  await options.bringToFront();
  await shortcut.getByRole('button', { name: 'Clear: Accept all linter warnings', exact: true }).click();
  await expect(shortcut.locator('kbd')).toHaveText('Disabled');
  await expect(options.locator('[data-role="status"]')).toContainText('Saved.');
  await page.bringToFront();
  await editors(page).first().click();
  await page.keyboard.press('Alt+Shift+KeyW');
  await page.keyboard.press('Alt+Shift+KeyA');
  await expect(pending(page, 0)).toHaveCount(1);

  await options.bringToFront();
  await shortcut.getByRole('button', { name: 'Reset: Accept all linter warnings', exact: true }).click();
  await expect(shortcut.locator('kbd')).toHaveText('Alt + Shift + A');
  await expect(options.locator('[data-role="status"]')).toContainText('Saved.');
  await options.close();
  await page.bringToFront();
  await editors(page).first().click();
  await page.keyboard.press('Alt+Shift+KeyA');
  await expectAcceptedWithoutEdits(page);
});
