import { test, expect } from '@nominy/babel-extension-e2e/test';
import { ready, transcriptSelector as TEXT } from './helper-editing-utils.mjs';

test.use({ extensions: ['helper'] });
export const featureScenarios = {
  nativeMergeAcrossGaps: ['native same-lane merges preserve boundaries, other speakers and one-step undo']
};

async function annotations(page) {
  return page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations
    .slice().sort((left, right) => left.id.localeCompare(right.id)));
}

test(featureScenarios.nativeMergeAcrossGaps[0], async ({ page, babel }) => {
  await babel.setExtensionSettings('helper', { features: { audioEnhancement: false, nativeMergeAcrossGaps: true } });
  const { action } = await babel.state();
  const a = action.annotations.find(turn => turn.processedRecordingId === 'speaker-1');
  const b = action.annotations.find(turn => turn.processedRecordingId === 'speaker-2');
  await babel.reset('baseline', { action: { annotations: [
    { ...a, id: 'merge-first', content: 'Первая реплика.', startTimeInSeconds: 0.2, endTimeInSeconds: 1 },
    { ...b, id: 'merge-other', content: 'Другая дорожка.', startTimeInSeconds: 1.5, endTimeInSeconds: 7 },
    { ...a, id: 'merge-middle', content: 'Средняя реплика.', startTimeInSeconds: 4, endTimeInSeconds: 4.5 },
    { ...a, id: 'merge-last', content: 'Последняя реплика.', startTimeInSeconds: 8, endTimeInSeconds: 9 }
  ] } });
  await ready(page);
  const before = await annotations(page);
  const first = page.locator('section[data-annotation-id="merge-first"]');
  await first.locator('button[aria-haspopup="menu"]').click();
  await expect(page.getByRole('menuitem', { name: 'Merge With Above', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Merge With Below', exact: true })).toBeEnabled();
  await page.mouse.click(1, 1);
  await expect(page.getByRole('menu')).toHaveCount(0);
  const last = page.locator('section[data-annotation-id="merge-last"]');
  await last.locator('button[aria-haspopup="menu"]').click();
  await expect(page.getByRole('menuitem', { name: 'Merge With Below', exact: true })).toBeDisabled();
  await page.mouse.click(1, 1);
  await expect(page.getByRole('menu')).toHaveCount(0);
  const middle = page.locator('section[data-annotation-id="merge-middle"]');
  await middle.locator('button[aria-haspopup="menu"]').click();
  await expect(page.getByRole('menuitem', { name: 'Merge With Above', exact: true })).toBeEnabled();
  await expect(page.getByRole('menuitem', { name: 'Merge With Below', exact: true })).toBeEnabled();
  await page.getByRole('menuitem', { name: 'Merge With Above', exact: true }).click();
  await expect(page.locator(TEXT)).toHaveCount(3);
  const after = await annotations(page);
  expect(after.find(turn => turn.id === 'merge-middle')).toMatchObject({
    content: 'Первая реплика. Средняя реплика.', startTimeInSeconds: 0.2, endTimeInSeconds: 4.5,
    processedRecordingId: 'speaker-1'
  });
  expect(after.find(turn => turn.id === 'merge-other')).toEqual(before.find(turn => turn.id === 'merge-other'));
  await page.locator('[aria-label="Play all tracks"], [aria-label="Pause all tracks"]').first().focus();
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect.poll(() => annotations(page)).toEqual(before);
  await expect(page.locator('[id^="babel-helper-native-failure-"]')).toHaveCount(0);
});
