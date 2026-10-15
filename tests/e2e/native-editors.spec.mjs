import { test, expect } from '@nominy/babel-extension-e2e/test';
import { saved } from '@nominy/babel-extension-e2e/native-helpers';
import { editors, ready, readText, fillText, selectText, caret, enableOnlyLinterRules, row } from './helper-editing-utils.mjs';

test.use({ extensions: ['helper'] });

test('native editor: selected-number conversion retains native undo and raw selection after styled text', async ({ page, babel }) => {
  const { action } = await babel.state();
  const source = '<тихо> Текст </тихо> 42 книг.';
  await babel.reset('baseline', { action: { annotations: action.annotations.map((annotation, index) => index === 0 ? { ...annotation, content: source } : annotation) } });
  await ready(page);
  const editor = editors(page).first();
  const start = source.indexOf('42');
  await selectText(editor, start, start + 2);
  await page.keyboard.press('Alt+KeyA');
  await expect.poll(() => readText(editor)).toBe('<тихо> Текст </тихо> 42 {СКАЗ: сорок два} книг.');
  await page.keyboard.press('Control+z');
  await expect.poll(() => readText(editor)).toBe(source);
  await selectText(editor, start, start + 2);
  await page.keyboard.press('Alt+KeyA');
  await expect.poll(() => readText(editor)).toBe('<тихо> Текст </тихо> 42 {СКАЗ: сорок два} книг.');
  await editors(page).nth(1).click();
  await expect(editors(page).nth(1)).toBeFocused();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await saved(page, babel);
  await page.reload();
  await ready(page);
  await expect.poll(() => readText(editors(page).first())).toBe('<тихо> Текст </тихо> 42 {СКАЗ: сорок два} книг.');
});

test('native editor: focus restore keeps raw caret through static-to-Slate replacement', async ({ page, babel }) => {
  await babel.setExtensionSettings('helper', { features: { proportionalCursorRestore: false } });
  await ready(page);
  const editor = editors(page).first();
  const source = '<тихо> Тихая </тихо> речь.';
  await fillText(editor, source);
  const offset = source.indexOf('речь');
  await selectText(editor, offset);
  await page.keyboard.press('Escape');
  await expect(row(page, 0).locator('[data-slate-editor="true"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  await caret(editor, offset);
  await page.keyboard.insertText('новая ');
  await expect.poll(() => readText(editor)).toBe('<тихо> Тихая </тихо> новая речь.');
});

test('native editor: selected-number and text-move settings disable and reenable live', async ({ page, babel }) => {
  await ready(page);
  await babel.setExtensionSettings('helper', { features: { selectedNumberToSkaz: false, textMove: false } });
  const first = editors(page).first(), second = editors(page).nth(1);
  await fillText(first, 'пять');
  await selectText(first, 0, 4);
  await page.keyboard.press('5');
  await expect.poll(() => readText(first)).toBe('5');
  await fillText(second, 'перенос остаток');
  await selectText(second, 7);
  await page.keyboard.press('Alt+BracketLeft');
  await expect.poll(() => readText(first)).toBe('5');
  await expect.poll(() => readText(second)).toBe('перенос остаток');
  await babel.setExtensionSettings('helper', { features: { selectedNumberToSkaz: true, textMove: true } });
  await selectText(second, 7);
  await page.keyboard.press('Alt+BracketLeft');
  await expect.poll(() => readText(first)).toBe('5 перенос');
  await expect.poll(() => readText(second)).toBe('остаток');
  await fillText(second, 'семь');
  await selectText(second, 0, 4);
  await page.keyboard.press('7');
  await expect.poll(() => readText(second)).toBe('7 {СКАЗ: семь}');
});

test('native warnings: accept-all acknowledges every issue in one turn without approving errors', async ({ page, babel }) => {
  await ready(page);
  await enableOnlyLinterRules(babel, ['highlighted-words']);
  await babel.setExtensionSettings('helper', { highlightedWordsEnabled: true, highlightedWords: ['контроль'] });
  // Two highlighted terms are one grouped issue. Use two distinct real rules:
  // native consecutive-capitals and Helper highlighted-words.
  const source = 'АБВГД контроль.';
  await fillText(editors(page).first(), source);
  await fillText(editors(page).nth(1), '');
  await editors(page).first().click();
  const pending = row(page, 0).getByRole('button', { name: 'My transcription is correct', exact: true });
  await expect(pending).toHaveCount(2);
  const error = row(page, 1).locator('[role="img"][aria-label]');
  await expect(error).not.toHaveAccessibleName(/^(No issues|Checking…)$/);
  const errorLabel = await error.getAttribute('aria-label');
  await editors(page).first().click();
  await page.keyboard.press('Alt+Shift+KeyA');
  await expect(pending).toHaveCount(0);
  await expect(row(page, 0).getByRole('button', { name: 'Show 2 confirmed warnings', exact: true })).toBeVisible();
  await expect(error).toHaveAccessibleName(errorLabel);
  await expect.poll(() => row(page, 0).evaluate(element =>
    window.__BABEL_E2E__.snapshot().annotations.find(annotation => annotation.id === element.dataset.annotationId)
      ?.metadata?.assertedWarnings ?? [])).toHaveLength(2);
  await expect.poll(() => row(page, 1).evaluate(element =>
    window.__BABEL_E2E__.snapshot().annotations.find(annotation => annotation.id === element.dataset.annotationId)
      ?.metadata?.assertedWarnings ?? [])).toEqual([]);
  await expect.poll(() => readText(editors(page).first())).toBe(source);
});
