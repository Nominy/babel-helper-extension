import { test, expect } from '@nominy/babel-extension-e2e/test';
import { audio, audioReady, fillText, readText, text, row } from '@nominy/babel-extension-e2e/native-helpers';
import { ready } from './helper-editing-utils.mjs';

const FLAG = 'data-babel-helper-disable-segment-click-seek';
test.use({ extensions: ['helper'] });

async function prepare(page, babel) {
  await babel.setExtensionSettings('helper', { features: { audioEnhancement: false } });
  await babel.reset();
  await ready(page);
  await audioReady(page);
  await expect(page.locator('html')).toHaveAttribute(FLAG, 'true');
  // This native button is labelled as five seconds but navigates turn starts.
  for (let step = 0; step < 3; step++) {
    await page.getByRole('button', { name: 'Jump forward 5 seconds', exact: true }).click();
  }
  await expect.poll(async () => (await audio(page)).every(track => track.currentTime > 4)).toBe(true);
}

test('segment click seek: clicks edit without rewinding, live opt-out restores native seek, explicit play still works', async ({ page, babel }) => {
  await prepare(page, babel);
  const before = (await audio(page)).map(track => track.currentTime);
  await text(page, 0).click();
  expect((await audio(page)).map(track => track.currentTime)).toEqual(before);
  await text(page, 1).click();
  await expect(text(page, 1)).toBeFocused();
  expect((await audio(page)).map(track => track.currentTime)).toEqual(before);
  await fillText(text(page, 1), 'Проверка редактирования без перемотки.');
  await expect.poll(() => readText(text(page, 1))).toBe('Проверка редактирования без перемотки.');
  await text(page, 1).press('Enter');
  await text(page, 0).click();
  expect((await audio(page)).map(track => track.currentTime)).toEqual(before);

  await babel.setExtensionSettings('helper', { features: { disableNativeSegmentClickSeek: false } });
  await expect(page.locator('html')).not.toHaveAttribute(FLAG, 'true');
  await text(page, 0).click();
  await expect.poll(async () => (await audio(page)).map(track => track.currentTime)).toEqual([0.5, 0.5]);

  await babel.setExtensionSettings('helper', { features: { disableNativeSegmentClickSeek: true } });
  await expect(page.locator('html')).toHaveAttribute(FLAG, 'true');
  await page.getByRole('button', { name: 'Jump forward 5 seconds', exact: true }).click();
  await page.getByRole('button', { name: 'Jump forward 5 seconds', exact: true }).click();
  const restored = (await audio(page)).map(track => track.currentTime);
  await text(page, 1).click();
  expect((await audio(page)).map(track => track.currentTime)).toEqual(restored);
  await row(page, 0).getByRole('button', { name: 'Play segment', exact: true }).click();
  const playing = await audio(page);
  expect(playing.every(track => track.playing && track.currentTime >= 0.5 && track.currentTime < 2.5)).toBe(true);
});

test('segment click seek: changing the editing turn preserves running playback on both lanes', async ({ page, babel }) => {
  await prepare(page, babel);
  await page.getByRole('button', { name: 'Play all tracks', exact: true }).click();
  await expect.poll(async () => (await audio(page)).every(track => track.playing)).toBe(true);
  for (const index of [0, 1]) {
    const before = await audio(page);
    await text(page, index).click();
    await expect(text(page, index)).toBeFocused();
    const after = await audio(page);
    for (let lane = 0; lane < after.length; lane++) {
      expect(after[lane].playing).toBe(true);
      expect(after[lane].currentTime).toBeGreaterThanOrEqual(before[lane].currentTime);
    }
  }
});
