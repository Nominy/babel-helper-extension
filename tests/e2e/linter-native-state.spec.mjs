import { test, expect } from '@nominy/babel-extension-e2e/test';
import { ready, row, editText } from '@nominy/babel-extension-e2e/native-helpers';
import { editors, enableOnlyLinterRules } from './helper-editing-utils.mjs';

test.use({ extensions: ['helper'] });

test('native highlighted-word card and ranges refresh when settings change without changing the issue key', async ({ page, babel }) => {
  await ready(page);
  await enableOnlyLinterRules(babel, ['highlighted-words']);
  await babel.setExtensionSettings('helper', { highlightedWordsEnabled: true, highlightedWords: ['контроль'] });
  await editText(page, 0, 'Здесь контроль и проверка.');
  await editors(page).first().click();
  const card = row(page, 0).locator('p').filter({
    hasText: 'Highlighted word requires clearance before use.'
  });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('"контроль"');
  const before = await page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations);
  await babel.setExtensionSettings('helper', { highlightedWords: ['проверка'] });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('"проверка"');
  await expect(card).not.toContainText('"контроль"');
  expect(await page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations)).toEqual(before);
  await babel.setExtensionSettings('helper', { highlightedWordsEnabled: false });
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations)).toEqual(before);
});
