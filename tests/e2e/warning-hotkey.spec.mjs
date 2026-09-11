import { test, expect } from '@nominy/babel-extension-e2e/test';
import { editors, row, ready, enableOnlyLinterRules } from './helper-editing-utils.mjs';

test.use({ extensions: ['helper'] });

const texts = ['Это первый контроль.', 'Это второй контроль.', 'Это третий контроль.', ''];
const pending = (page, index) => row(page, index).getByRole('button', { name: /1 linter warning, 0 acknowledged/ });
const accepted = (page, index) => row(page, index).getByRole('button', { name: /1 linter warning, 1 acknowledged/ });

async function prepareWarnings(page, babel) {
  await ready(page);
  await enableOnlyLinterRules(babel, ['highlighted-words']);
  await babel.setExtensionSettings('helper', { highlightedWordsEnabled: true, highlightedWords: ['контроль'] });
  for (let index = 0; index < texts.length; index += 1) await editors(page).nth(index).fill(texts[index]);
  await editors(page).first().focus();
  for (let index = 0; index < 3; index += 1) await expect(pending(page, index)).toBeVisible();
  await expect(row(page, 3).getByRole('button', { name: /linter errors?/ })).toBeVisible();
}

async function expectAcceptedWithoutEdits(page) {
  for (let index = 0; index < 3; index += 1) await expect(accepted(page, index)).toHaveCount(1);
  await expect(row(page, 3).getByRole('button', { name: /linter errors?/ })).toHaveCount(1);
  await expect(editors(page)).toHaveCount(texts.length);
  for (let index = 0; index < texts.length; index += 1) await expect(editors(page).nth(index)).toHaveValue(texts[index]);
}

test('warnings.acceptAll: native acknowledgement includes offscreen rows, preserves errors and never toggles accepted warnings', async ({ page, babel }) => {
  await prepareWarnings(page, babel);
  await pending(page, 0).click();
  await expect(accepted(page, 0)).toBeVisible();
  const errorLabel = await row(page, 3).getByRole('button', { name: /linter errors?/ }).getAttribute('aria-label');
  const persistedAnnotations = (await babel.state()).action.annotations;
  // Ordinary transcription shortcuts must not depend on a reviewActionId URL parameter.
  await page.evaluate(() => {
    const url = new URL(location.href);
    url.searchParams.delete('reviewActionId');
    history.replaceState({}, '', url);
  });
  await page.setViewportSize({ width: 1280, height: 200 });
  await editors(page).first().scrollIntoViewIfNeeded();
  await editors(page).first().focus();
  expect(await editors(page).nth(2).evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.top >= innerHeight || box.bottom <= 0;
  })).toBe(true);
  await page.keyboard.press('Alt+Shift+KeyA');
  await expectAcceptedWithoutEdits(page);
  await page.keyboard.press('Alt+Shift+KeyA');
  await expectAcceptedWithoutEdits(page);
  await expect(row(page, 3).getByRole('button', { name: /linter errors?/ })).toHaveAttribute('aria-label', errorLabel);
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
  await editors(page).first().focus();
  await page.keyboard.press('Alt+Shift+KeyA');
  for (let index = 0; index < 3; index += 1) await expect(pending(page, index)).toHaveCount(1);
  await page.keyboard.press('Alt+Shift+KeyW');
  await expectAcceptedWithoutEdits(page);

  await accepted(page, 0).click();
  await expect(pending(page, 0)).toBeVisible();
  await options.bringToFront();
  await shortcut.getByRole('button', { name: 'Clear: Accept all linter warnings', exact: true }).click();
  await expect(shortcut.locator('kbd')).toHaveText('Disabled');
  await expect(options.locator('[data-role="status"]')).toContainText('Saved.');
  await page.bringToFront();
  await editors(page).first().focus();
  await page.keyboard.press('Alt+Shift+KeyW');
  await page.keyboard.press('Alt+Shift+KeyA');
  await expect(pending(page, 0)).toHaveCount(1);

  await options.bringToFront();
  await shortcut.getByRole('button', { name: 'Reset: Accept all linter warnings', exact: true }).click();
  await expect(shortcut.locator('kbd')).toHaveText('Alt + Shift + A');
  await expect(options.locator('[data-role="status"]')).toContainText('Saved.');
  await options.close();
  await page.bringToFront();
  await editors(page).first().focus();
  await page.keyboard.press('Alt+Shift+KeyA');
  await expectAcceptedWithoutEdits(page);
});
