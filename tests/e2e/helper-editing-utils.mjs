import { expect } from '../../../shared/babel-extension-platform/packages/babel-extension-e2e/src/test.mjs';

export const transcriptSelector = 'tbody textarea[placeholder="What was said…"]';
export const editors = (page) => page.locator(transcriptSelector);
export const row = (page, index) => editors(page).nth(index).locator('xpath=ancestor::tr');

export async function ready(page, count = 4) {
  await expect(editors(page)).toHaveCount(count);
  await expect(page.getByRole('button', { name: 'Website Appearance', exact: true })).toBeVisible();
  await expect(editors(page).first()).toBeEditable();
}

// Only the browser's selection primitive is used; mutations always enter through native UI events.
export async function selectText(editor, start, end = start) {
  await editor.focus();
  await editor.evaluate((element, selection) => element.setSelectionRange(...selection), [start, end]);
}

export async function caret(editor, position) {
  await expect.poll(() => editor.evaluate((element) => [element.selectionStart, element.selectionEnd])).toEqual([position, position]);
}

export async function enableOnlyLinterRules(babel, enabled) {
  const options = await babel.options('helper');
  await options.getByRole('button', { name: 'Manage rules', exact: true }).click();
  const inputs = options.locator('input[data-rule-id]');
  for (const rule of enabled) {
    const input = options.locator(`input[data-rule-id="${rule}"]`);
    if (!await input.isChecked()) {
      // Opt-in rules must be saved through the current options schema, not
      // interpreted as pre-migration settings that intentionally disable them.
      await input.check();
      await expect(options.getByText('Saved. Dashboard changes apply live.', { exact: true })).toBeVisible();
    }
  }
  const disabled = await inputs.evaluateAll((elements, names) => elements.map((element) => element.dataset.ruleId).filter((id) => !names.includes(id)), enabled);
  await options.close();
  await babel.setExtensionSettings('helper', { disabledCustomLinterRuleIds: disabled, highlightedWordsEnabled: false });
}

export function lane(page, number) {
  return page.getByRole('heading', { name: `Speaker ${number}`, exact: true }).locator('..').locator('..');
}

export async function openAppearance(page) {
  await page.getByRole('button', { name: 'Website Appearance', exact: true }).click();
  const panel = page.locator('[data-babel-helper-appearance-panel]').getByRole('dialog');
  await expect(panel).toBeVisible();
  return panel;
}
