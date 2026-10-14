import { expect } from '@nominy/babel-extension-e2e/test';

import {
  TEXT as transcriptSelector, row, rowMenu, rowValues, transcriptScroll, readText, selectText, textSelection, focusTranscript, fillText,
} from '@nominy/babel-extension-e2e/native-helpers';

export { transcriptSelector, row, rowMenu, transcriptScroll, readText, selectText, textSelection, fillText };
export const editors = (page) => page.locator(transcriptSelector);


export async function readRows(page) {
  const seconds = (value) => value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  return (await rowValues(page)).map((entry) => ({
    ...entry, start: seconds(entry.start), end: seconds(entry.end),
  }));
}

export async function ready(page, count = 4) {
  await expect(editors(page)).toHaveCount(count);
  await expect(page.getByRole('button', { name: 'Website Appearance', exact: true })).toBeVisible();
  await editors(page).first().click();
  await expect(editors(page).first()).toBeEditable();
  await focusTranscript(page);
}


export async function caret(editor, position) {
  await expect.poll(() => textSelection(editor)).toEqual([position, position]);
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
  return page.getByRole('button', { name: /^(Show|Hide) track$/ }).nth(number - 1)
    .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " flex-row ")][1]');
}

export async function openAppearance(page) {
  await page.getByRole('button', { name: 'Website Appearance', exact: true }).click();
  const panel = page.locator('[data-babel-helper-appearance-panel]').getByRole('dialog');
  await expect(panel).toBeVisible();
  return panel;
}
