import { test, expect } from '@nominy/babel-extension-e2e/test';
import { ready, editors, fillText } from './helper-editing-utils.mjs';

test.use({ extensions: ['helper'] });
export const featureScenarios = {
  nativeFindReplace: ['toolbar rules replace native tags and hidden lanes in order, recover and undo']
};

async function nativeAnnotations(page) {
  return page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations);
}

async function openPopup(context, page, controller, id) {
  await page.bringToFront();
  const opened = context.waitForEvent('page');
  // Chromium action popups are not exposed as Playwright Page targets. Exercise
  // the actual packaged popup document with the real Babel tab still active.
  await controller.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false }));
  const popup = await opened;
  await popup.waitForURL(`chrome-extension://${id}/popup.html`);
  await popup.setViewportSize({ width: 550, height: 600 });
  await expect(popup.locator('#task-status')).toContainText('segments');
  await expect(popup.getByRole('button', { name: 'Add rule', exact: true })).toBeEnabled();
  return popup;
}

async function addRule(popup, find, replacement, wholeWord = false) {
  await popup.getByRole('button', { name: 'Add rule', exact: true }).click();
  await popup.getByRole('textbox', { name: 'Find', exact: true }).fill(find);
  await popup.getByRole('textbox', { name: 'Replace with', exact: true }).fill(replacement);
  await popup.getByRole('checkbox', { name: 'Unicode whole-word', exact: true }).setChecked(wholeWord);
  await popup.getByRole('button', { name: 'Save rule', exact: true }).click();
  await expect(popup.locator('#rule-editor')).toBeHidden();
}

test(featureScenarios.nativeFindReplace[0], async ({ page, context, babel }, testInfo) => {
  await babel.setExtensionSettings('helper', { features: { audioEnhancement: false, nativeFindReplace: true } });
  const { action } = await babel.state();
  const typed = 'кот [стук] котик <шепот> x </шепот>';
  const hidden = 'Кот [стук] и кот.';
  await babel.reset('baseline', { action: { annotations: action.annotations.map((turn, index) => ({
    ...turn, content: index === 0 ? 'Старый текст.' : index === 2 ? hidden : turn.content
  })) } });
  await ready(page);
  const initial = await nativeAnnotations(page);
  const id = babel.extensionIds.helper;
  const controller = await babel.options('helper');
  let popup = await openPopup(context, page, controller, id);
  await addRule(popup, '[шум]', '[смех]');
  await addRule(popup, '[стук]', '[шум]');
  await addRule(popup, 'кот', 'пёс', true);
  await popup.getByRole('button', { name: 'Move rule 2 up', exact: true }).click();
  await expect(popup.locator('#rules > li').first()).toContainText('[стук]');
  await popup.close();

  await page.getByRole('combobox').filter({ hasText: 'All Tracks' }).click();
  await page.getByRole('option', { name: 'Speaker 1', exact: true }).click();
  await expect(editors(page)).toHaveCount(2);
  await fillText(editors(page).first(), typed);
  popup = await openPopup(context, page, controller, id);
  await expect(popup.locator('#rules > li')).toHaveCount(3);
  await expect(popup.locator('#rules > li').first()).toContainText('[стук]');
  await popup.getByRole('button', { name: 'Run all', exact: true }).click();
  await expect(popup.locator('#result')).toContainText('7 replacements; 2 segments changed');
  const texts = async () => (await nativeAnnotations(page)).map(turn => turn.content);
  const afterText = 'пёс [смех] котик <шепот> x </шепот>';
  const hiddenAfter = 'пёс [смех] и пёс.';
  await expect.poll(texts).toEqual(initial.map((turn, index) => index === 0 ? afterText : index === 2 ? hiddenAfter : turn.content));
  const after = await nativeAnnotations(page);
  for (let index = 0; index < initial.length; index++) {
    expect(after[index]).toMatchObject({ id: initial[index].id,
      processedRecordingId: initial[index].processedRecordingId,
      startTimeInSeconds: initial[index].startTimeInSeconds, endTimeInSeconds: initial[index].endTimeInSeconds });
    if (index !== 0 && index !== 2) expect(after[index]).toEqual(initial[index]);
  }
  await popup.screenshot({ path: testInfo.outputPath('replacement-toolbar-popup.png') });
  await popup.close();

  popup = await openPopup(context, page, controller, id);
  await expect(popup.getByRole('button', { name: 'Recover latest run', exact: true })).toBeEnabled();
  await popup.getByRole('button', { name: 'Recover latest run', exact: true }).click();
  await expect(popup.locator('#result')).toContainText('2 segments restored');
  const beforeTexts = initial.map((turn, index) => index === 0 ? typed : turn.content);
  await expect.poll(texts).toEqual(beforeTexts);
  await expect(popup.getByRole('button', { name: 'Recover latest run', exact: true })).toBeDisabled();
  await controller.close();
  const optionsOpened = context.waitForEvent('page');
  await popup.getByRole('link', { name: 'Settings', exact: true }).click();
  const options = await optionsOpened;
  await expect(options).toHaveURL(`chrome-extension://${id}/options.html`);
  await options.close();

  await page.bringToFront();
  await page.locator('[aria-label="Play all tracks"], [aria-label="Pause all tracks"]').first().focus();
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(texts).toEqual(after.map(turn => turn.content));
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(texts).toEqual(beforeTexts);
  await expect(page.locator('[id^="babel-helper-native-failure-"]')).toHaveCount(0);
});
