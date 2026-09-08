import { test, expect } from '@nominy/babel-extension-e2e/test';
import { editors, row, ready, selectText, caret, lane, enableOnlyLinterRules } from './helper-editing-utils.mjs';

// Canonical src/features/registry.ts setting keys -> executable browser scenario titles.
export const featureScenarios = {
  selectedNumberToSkaz: ['selectedNumberToSkaz: digit replacement and numeric expansion preserve surrounding text'],
  textMove: ['textMove: adjacent transfers preserve the other speaker and controlled values'],
  rowActions: ['rowActions: merge both directions and delete only outside typing', 'rowActions: right Shift navigation starts the adjacent editor at zero'],
  disableNativeArrowSeek: ['disableNativeArrowSeek: arrows move the caret without changing the active segment'],
  focusToggle: ['focusToggle: escape blurs and restores the remembered editing selection'],
  proportionalCursorRestore: ['proportionalCursorRestore: Tab moves the ghost cursor between speaker lanes'],
  quickRegionAutocomplete: ['quickRegionAutocomplete: wrap selected text with a native style tag', 'quickRegionAutocomplete: Backspace removes one tag part but protects foreign speech'],
  speakerWorkflowHotkeys: ['speakerWorkflowHotkeys: switch isolates the editing lane and reset restores both'],
  customLinter: ['customLinter: current and all-row fixes have distinct scope', 'customLinter: highlighted words require acknowledgement and changed text revokes it', 'customLinter: disabled rule leaves its text unchanged'],
};

test.describe('Helper native editing', () => {
  test.beforeEach(async ({ page }) => ready(page));

  test(featureScenarios.selectedNumberToSkaz[0], async ({ page, babel }) => {
    const editor = editors(page).first();
    await editor.fill('У меня пять книг.');
    await selectText(editor, 7, 11);
    await page.keyboard.press('5');
    await expect(editor).toHaveValue('У меня 5 {СКАЗ: пять} книг.');
    await editor.fill('Число 42 сегодня.');
    await selectText(editor, 6, 8);
    await page.keyboard.press('Alt+KeyA');
    await expect(editor).toHaveValue('Число 42 {СКАЗ: сорок два} сегодня.');
    await editors(page).nth(1).click();
    await expect(editor).toHaveValue('Число 42 {СКАЗ: сорок два} сегодня.');
    await page.getByRole('button', { name: 'Save progress', exact: true }).click();
    await expect.poll(async () => (await babel.state()).action.annotations.find((annotation) => annotation.id === 'row-1')?.content).toBe('Число 42 {СКАЗ: сорок два} сегодня.');
    await page.reload();
    await ready(page);
    await expect(editors(page).first()).toHaveValue('Число 42 {СКАЗ: сорок два} сегодня.');
  });

  test(featureScenarios.textMove[0], async ({ page, babel }) => {
    const first = editors(page).nth(0), second = editors(page).nth(1);
    const otherSpeaker = await editors(page).nth(2).inputValue();
    await first.fill('Начало.');
    await second.fill('Перенос Остаток.');
    await selectText(second, 7);
    await page.keyboard.press('Alt+BracketLeft');
    await expect(first).toHaveValue('Начало. Перенос');
    await expect(second).toHaveValue('Остаток.');
    await caret(second, 0);
    await selectText(first, 7);
    await page.keyboard.press('Alt+BracketRight');
    await expect(first).toHaveValue('Начало.');
    await expect(second).toHaveValue('Перенос Остаток.');
    await caret(first, 7);
    await expect(editors(page).nth(2)).toHaveValue(otherSpeaker);
    await second.click();
    await expect(first).toHaveValue('Начало.');
    await page.getByRole('button', { name: 'Save progress', exact: true }).click();
    await expect.poll(async () => (await babel.state()).action.annotations.slice(0, 3).map((annotation) => annotation.content)).toEqual(['Начало.', 'Перенос Остаток.', otherSpeaker]);
  });

  test(featureScenarios.rowActions[0], async ({ page, babel }) => {
    for (const direction of ['ArrowDown', 'ArrowUp']) {
      await babel.reset();
      await ready(page);
      await editors(page).nth(0).fill('Первая.');
      await editors(page).nth(1).fill('Вторая.');
      await editors(page).nth(direction === 'ArrowDown' ? 0 : 1).focus();
      await page.keyboard.press(`Alt+Shift+${direction}`);
      await expect(editors(page)).toHaveCount(3);
      await expect(editors(page).first()).toHaveValue('Первая. Вторая.');
      await expect(editors(page).nth(1)).toHaveValue('Да, я слышу тебя хорошо.');
    }
    const editor = editors(page).first();
    await selectText(editor, (await editor.inputValue()).length);
    await page.keyboard.press('d');
    await expect(editor).toHaveValue('Первая. Вторая.d');
    await expect(editors(page)).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(editor).not.toBeFocused();
    await page.keyboard.press('KeyD');
    await expect(editors(page)).toHaveCount(2);
    await expect(editors(page).first()).toHaveValue('Да, я слышу тебя хорошо.');
  });

  test(featureScenarios.rowActions[1], async ({ page }) => {
    await editors(page).first().click();
    await page.keyboard.down('ShiftRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('ShiftRight');
    await expect(editors(page).nth(1)).toBeFocused();
    await caret(editors(page).nth(1), 0);
    await page.keyboard.down('ShiftRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('ShiftRight');
    await expect(editors(page).first()).toBeFocused();
    await caret(editors(page).first(), 0);
  });

  test(featureScenarios.disableNativeArrowSeek[0], async ({ page }) => {
    const editor = editors(page).first();
    await selectText(editor, 5);
    await page.keyboard.press('ArrowLeft');
    await expect(editor).toBeFocused();
    await caret(editor, 4);
    await page.keyboard.press('ArrowRight');
    await caret(editor, 5);
    await selectText(editor, 0);
    await page.keyboard.press('ArrowLeft');
    await caret(editor, 0);
    await expect(editor).toBeFocused();
    await expect(editors(page).nth(1)).not.toBeFocused();
  });

  test(featureScenarios.focusToggle[0], async ({ page, babel }) => {
    await babel.setExtensionSettings('helper', { features: { proportionalCursorRestore: false } });
    const editor = editors(page).first();
    await selectText(editor, 5);
    await page.keyboard.press('Escape');
    await expect(editor).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(editor).toBeFocused();
    await caret(editor, 5);
    await page.keyboard.insertText('ТОЧНО');
    await expect(editor).toHaveValue('ПривеТОЧНОт, это тестовая запись.');
  });

  test(featureScenarios.proportionalCursorRestore[0], async ({ page, babel }) => {
    const { action } = await babel.state();
    // Lane switching needs a current segment on both speakers, not a future segment.
    await babel.reset('baseline', { action: { annotations: action.annotations.map((annotation) =>
      annotation.id === 'row-3' ? { ...annotation, startTimeInSeconds: 0.5, endTimeInSeconds: 2.5 } : annotation) } });
    await ready(page);
    const target = editors(page).nth(1);
    await expect(target).toHaveValue('Да, я слышу тебя хорошо.');
    const zoom = page.locator('[role="slider"][aria-valuemin="10"][aria-valuemax="2000"]');
    await zoom.focus();
    await page.keyboard.press('Home');
    await expect(zoom).toHaveAttribute('aria-valuenow', '10');
    await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks.filter((track) => track.duration === 12).length)).toBe(2);
    const waveform = await page.locator('[data-babel-helper-minimap-host]').first().locator('[part="wrapper"]').boundingBox();
    expect(waveform).not.toBeNull();
    await page.mouse.click(waveform.x + waveform.width * 0.8 / 12, waveform.y + waveform.height * 0.55);
    await expect.poll(() => page.evaluate(() => Math.abs(window.__BABEL_E2E__.snapshot().audio.tracks[0].currentTime - 0.8))).toBeLessThan(0.15);
    await selectText(editors(page).first(), 4);
    await page.keyboard.press('Escape');
    const ghost = page.locator('[data-babel-helper-ghost-cursor]');
    await expect(ghost).toBeVisible();
    const targetBox = await target.boundingBox();
    expect(targetBox).not.toBeNull();
    await page.keyboard.press('Tab');
    await expect.poll(async () => {
      const box = await ghost.boundingBox();
      return box && box.y >= targetBox.y && box.y < targetBox.y + targetBox.height;
    }).toBe(true);
    await page.keyboard.press('Escape');
    await expect(target).toBeFocused();
  });

  test(featureScenarios.quickRegionAutocomplete[0], async ({ page, babel }) => {
    const editor = editors(page).first();
    await editor.fill('Тихая речь.');
    await selectText(editor, 0, 5);
    await page.keyboard.press('Shift+Comma');
    const suggestions = page.locator('[data-babel-helper-quick-region-listbox]');
    await expect(suggestions).toBeVisible();
    const suggestion = suggestions.getByRole('option').first();
    const tag = (await suggestion.innerText()).trim();
    await page.keyboard.press('Enter');
    await expect(editor).toHaveValue(`<${tag}> Тихая </${tag}> речь.`);
    await expect(suggestions).toBeHidden();
    await editor.fill('');
    await page.keyboard.press('Shift+Comma');
    const nativeOption = page.getByRole('option').first();
    await expect(nativeOption).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor).toHaveValue('<');

    await row(page, 0).locator('td').last().getByRole('button').click();
    await page.getByRole('menuitem', { name: 'Add Segment Below', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add New Region' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Start Time (mm:ss.xx)', { exact: true }).fill('00:02.60');
    await dialog.getByLabel('Start Time (mm:ss.xx)', { exact: true }).press('Tab');
    await dialog.getByLabel('End Time (mm:ss.xx)', { exact: true }).fill('00:02.90');
    await dialog.getByLabel('End Time (mm:ss.xx)', { exact: true }).press('Tab');
    const quickEditor = dialog.getByPlaceholder('Enter text for this region...', { exact: true });
    await quickEditor.fill('');
    await quickEditor.press('Shift+Comma');
    await expect(suggestions).toBeVisible();
    const quickSuggestion = suggestions.getByRole('option').first();
    const quickTag = (await quickSuggestion.innerText()).trim();
    await quickSuggestion.click();
    await expect(quickEditor).toHaveValue(`<${quickTag}> </${quickTag}>`);
    await expect(suggestions).toBeHidden();
    await page.keyboard.insertText('Новая речь. ');
    const createdText = `<${quickTag}> Новая речь. </${quickTag}>`;
    await expect(quickEditor).toHaveValue(createdText);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(editors(page)).toHaveCount(5);
    await expect(editors(page).nth(1)).toHaveValue(createdText);
    await page.getByRole('button', { name: 'Save progress', exact: true }).click();
    await expect.poll(async () => (await babel.state()).action.annotations.some((annotation) =>
      annotation.content === createdText && annotation.startTimeInSeconds === 2.6 && annotation.endTimeInSeconds === 2.9)).toBe(true);
  });

  test(featureScenarios.quickRegionAutocomplete[1], async ({ page }) => {
    const editor = editors(page).first();
    await editor.fill('<шепот> Тихо </шепот>');
    await selectText(editor, 7);
    await page.keyboard.press('Backspace');
    await expect(editor).toHaveValue(' Тихо </шепот>');
    await editor.fill('<иностранная-речь> hello </иностранная-речь>');
    await selectText(editor, '<иностранная-речь>'.length);
    await page.keyboard.press('Backspace');
    await expect(editor).toHaveValue('<иностранная-речь hello </иностранная-речь>');
  });

  test(featureScenarios.speakerWorkflowHotkeys[0], async ({ page }) => {
    await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks.length)).toBe(2);
    // Both lanes start muted and collapsed: callbacks must work without first
    // mounting the hidden mute buttons or temporarily expanding the other lane.
    for (const number of [1, 2]) {
      await lane(page, number).getByRole('button', { name: 'Solo track', exact: true }).click();
      await lane(page, number).getByRole('button', { name: 'Hide track', exact: true }).click();
    }
    for (const number of [1, 1, 2, 2]) {
      await page.evaluate(() => delete document.documentElement.dataset.babelHelperSpeakerWorkflow);
      await page.keyboard.press(`Alt+Digit${number}`);
      await expect(lane(page, number).getByRole('button', { name: 'Hide track', exact: true })).toBeVisible();
      await expect(lane(page, 3 - number).getByRole('button', { name: 'Show track', exact: true })).toBeVisible();
      await expect(lane(page, number).getByRole('button', { name: 'Solo track', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox').filter({ hasText: `Speaker ${number}` })).toBeVisible();
      // Native controls update before the asynchronous workflow releases its
      // busy guard; order independent commands on actual workflow completion.
      await expect.poll(() => page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.babelHelperSpeakerWorkflow || 'null')
      )).toMatchObject({ stage: 'switch-ok', targetLabel: `Speaker ${number}` });
      await expect(editors(page)).toHaveCount(2);
      await expect.poll(() => page.evaluate(() =>
        window.__BABEL_E2E__.snapshot().audio.tracks.map(track => track.volume)
      )).toEqual(number === 1 ? [1, 0] : [0, 1]);
    }
    await page.keyboard.press('Alt+Backquote');
    for (const number of [1, 2]) {
      await expect(lane(page, number).getByRole('button', { name: 'Hide track', exact: true })).toBeVisible();
      await expect(lane(page, number).getByRole('button', { name: 'Solo track', exact: true })).toBeVisible();
    }
    await expect(page.getByRole('combobox').filter({ hasText: 'All Tracks' })).toBeVisible();
    await expect(editors(page)).toHaveCount(4);
    await expect.poll(() => page.evaluate(() =>
      window.__BABEL_E2E__.snapshot().audio.tracks.map(track => track.volume)
    )).toEqual([1, 1]);
    // A filter with no matching annotations still has native track controls.
    while (await editors(page).count()) {
      const count = await editors(page).count();
      await row(page, 0).locator('button[aria-haspopup="menu"]').click();
      await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
      await expect(editors(page)).toHaveCount(count - 1);
    }
    for (const number of [1, 2]) {
      await page.keyboard.press(`Alt+Digit${number}`);
      await expect.poll(() => page.evaluate(() =>
        JSON.parse(document.documentElement.dataset.babelHelperSpeakerWorkflow || 'null')
      )).toMatchObject({ stage: 'switch-ok', targetLabel: `Speaker ${number}` });
      await expect(page.getByRole('combobox').filter({ hasText: `Speaker ${number}` })).toBeVisible();
      await expect(editors(page)).toHaveCount(0);
    }
    await page.keyboard.press('Alt+Backquote');
    await expect.poll(() => page.evaluate(() =>
      JSON.parse(document.documentElement.dataset.babelHelperSpeakerWorkflow || 'null')
    )).toMatchObject({ stage: 'reset-ok' });
  });

  test(featureScenarios.customLinter[0], async ({ page, babel }) => {
    await enableOnlyLinterRules(babel, ['double-spaces', 'leading-trailing-spaces']);
    await editors(page).nth(0).fill('  Первый  ряд. ');
    await editors(page).nth(1).fill('Второй  ряд.');
    await editors(page).first().focus();
    await page.keyboard.press('Alt+KeyF');
    await expect(editors(page).first()).toHaveValue('Первый ряд.');
    await expect(editors(page).nth(1)).toHaveValue('Второй  ряд.');
    await page.keyboard.press('Alt+Shift+KeyF');
    await expect(editors(page).nth(1)).toHaveValue('Второй ряд.');
  });

  test(featureScenarios.customLinter[1], async ({ page, babel }) => {
    await enableOnlyLinterRules(babel, ['highlighted-words']);
    await babel.setExtensionSettings('helper', { highlightedWordsEnabled: true, highlightedWords: ['контроль'] });
    await editors(page).first().fill('Это контроль.');
    await editors(page).nth(1).focus();
    const status = row(page, 0).getByRole('button', { name: /1 linter warning, 0 acknowledged/ });
    await expect(status).toBeVisible();
    await status.hover();
    await expect(page.locator('mark[data-babel-helper-linter-highlight]').filter({ hasText: 'контроль' })).toBeVisible();
    await status.click();
    await expect(row(page, 0).getByRole('button', { name: /1 linter warning, 1 acknowledged/ })).toBeVisible();
    await editors(page).first().fill('Это новый контроль.');
    await editors(page).nth(1).focus();
    await expect(status).toBeVisible();
  });

  test(featureScenarios.customLinter[2], async ({ page, babel }) => {
    await enableOnlyLinterRules(babel, ['unicode-dashes']);
    const options = await babel.options('helper');
    await options.getByRole('button', { name: 'Manage rules', exact: true }).click();
    await options.locator('[data-rule-id="unicode-dashes"]').uncheck();
    await expect(options.locator('[data-role="status"]')).toContainText('Saved.');
    await options.close();
    await editors(page).first().fill('Да — нет.');
    await page.keyboard.press('Alt+KeyF');
    await editors(page).nth(1).focus();
    await expect(editors(page).first()).toHaveValue('Да — нет.');
    await expect(row(page, 0).getByRole('button', { name: 'No linter issues' })).toBeVisible();
  });
});

// Each row guards a distinct supported rule, not repeated plumbing. Non-fixable diagnostics
// explicitly preserve text; fixable rules must clear the native status after the real hotkey.
export const linterRuleScenarios = [
  ['leading-trailing-spaces', ' Привет. ', 'Привет.'],
  ['double-spaces', 'Привет,  мир.', 'Привет, мир.'],
  ['comma-spacing', 'Привет,мир.', 'Привет, мир.'],
  ['period-spacing', 'Привет.Мир.', 'Привет. Мир.'],
  ['angle-tag-spacing', 'Да<речь-нараспев>тихо.</речь-нараспев>', 'Да <речь-нараспев> тихо. </речь-нараспев>'],
  ['square-bracket-tag-spacing', 'Да[смех]точно.', 'Да [смех] точно.'],
  ['curly-tag-spacing', '9{СКАЗ: девять}', '9 {СКАЗ: девять}'],
  ['quote-balance', 'Он сказал "привет.', null],
  ['unicode-quotes', 'Он сказал «привет».', 'Он сказал "привет".'],
  ['unicode-dashes', 'Да — нет.', 'Да - нет.'],
  ['curly-tag-trailing-punctuation', '3 {СКАЗ: три}.', '3. {СКАЗ: три}'],
  ['angle-tag-trailing-punctuation', '<речь-нараспев> Да </речь-нараспев>.', '<речь-нараспев> Да. </речь-нараспев>'],
  ['square-bracket-tag-trailing-punctuation', 'Да [смех].', 'Да. [смех]'],
  ['free-mid-sentence-double-dash', 'Да -- нет.', 'Да - нет.'],
  ['double-dash-punctuation', 'Подожди--.', 'Подожди--'],
  ['single-dash-punctuation', 'Подожди-.', 'Подожди-'],
  ['terminal-punctuation', 'Привет', 'Привет.'],
  ['incorrect-interjection-forms', 'Аа, я понял.', 'А, я понял.'],
  ['normalized-stutters', 'Ф- привет.', null],
  ['sentence-boundary-capitalization', 'Привет. мир.', 'Привет. Мир.'],
  ['polite-pronoun-case', 'Спасибо, Ваш ответ принят.', 'Спасибо, ваш ответ принят.'],
  ['segment-start-capitalization', 'привет.', 'Привет.'],
];
featureScenarios.customLinter.push(...linterRuleScenarios.map(([rule]) =>
  `customLinter: each rule displays a native issue and applies only supported fixes [${rule}]`));

for (const [rule, text, fixed] of linterRuleScenarios) {
  test(`customLinter: each rule displays a native issue and applies only supported fixes [${rule}]`, async ({ page, babel }) => {
    await ready(page);
    await enableOnlyLinterRules(babel, [rule]);
    const editor = editors(page).first();
    await editor.fill(text);
    await editors(page).nth(1).focus();
    const status = row(page, 0).getByRole('button', { name: /\d+ linter errors?/ });
    await expect(status).toBeVisible();
    await status.hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await editor.focus();
    await page.keyboard.press('Alt+KeyF');
    await expect(editor).toHaveValue(fixed ?? text);
    await editors(page).nth(1).focus();
    if (fixed === null) await expect(status).toBeVisible();
    else await expect(row(page, 0).getByRole('button', { name: 'No linter issues' })).toBeVisible();
  });
}
