import { test, expect } from '@nominy/babel-extension-e2e/test';
import { transcriptScroll } from './helper-editing-utils.mjs';

export const featureScenarios = {
  extendedDiffView: ['extendedDiffView: repeated native mode switches repaint and disabling restores the original comparison'],
};

test(featureScenarios.extendedDiffView[0], async ({ page, babel }) => {
  await babel.setExtensionSettings('helper', { features: { extendedDiffView: false } });
  await babel.reset('diff');
  await expect(page.getByRole('button', { name: 'Hotkeys', exact: true })).toBeVisible();
  const diffSwitch = page.locator('#diff-mode[role="switch"]');
  await diffSwitch.setChecked(true);
  const transcript = transcriptScroll(page);
  await expect(transcript).toContainText('пробная');
  await expect(transcript).toContainText('тестовая');
  await expect(transcript).toContainText('Удалённая тестовая фраза.');
  const nativeText = await transcript.innerText();
  const originalAnnotations = (await babel.state()).action.annotations;
  const originalNativeAnnotations = await page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations);

  await babel.setExtensionSettings('helper', { features: { extendedDiffView: true } });
  const modes = page.locator('#bh-segmentation-mode-controls');
  await expect(modes).toBeVisible();
  const oldTime = page.locator('[title*="timestamp shift"][title*="old segment 0.200s-2.800s"]');
  const newTime = page.locator('[title*="timestamp shift"][title*="new segment 0.500s-2.500s"]');
  for (const mode of ['fusion', 'reference', 'current', 'fusion', 'current', 'reference']) {
    const applied = mode === 'fusion' ? null : page.evaluate((expectedMode) => new Promise((resolve) => {
      const requestType = 'babel-helper-recovered-editor-request';
      const responseType = 'babel-helper-recovered-editor-response';
      const responses = new Map();
      let request;
      const finish = () => {
        if (!request || !responses.has(request.id)) return;
        window.removeEventListener(requestType, onRequest, true);
        window.removeEventListener(responseType, onResponse, true);
        resolve({ payload: request.payload, result: responses.get(request.id), routeKey: location.pathname + location.search });
      };
      const onResponse = (event) => {
        responses.set(event.detail?.id, event.detail?.result);
        finish();
      };
      const onRequest = (event) => {
        if (event.detail?.operation !== 'apply-extended-diff-state' ||
            event.detail.payload?.textMode !== expectedMode) return;
        request = event.detail;
        finish();
      };
      // Observe the real cross-world feature request and synchronous bridge response.
      // The bridge may respond before this later-registered request listener runs.
      window.addEventListener(requestType, onRequest, true);
      window.addEventListener(responseType, onResponse, true);
    }), mode);
    await modes.locator(`[data-mode="${mode}"]`).click();
    if (applied) {
      const application = await applied;
      expect(application.payload.routeKey).toBe(application.routeKey);
      expect(application.result).toMatchObject({ ok: true, textMode: mode, patchedCurrentDiffResult: true });
    }
    if (mode === 'reference') {
      await expect(transcript).toContainText('Привет это пробная запись');
      await expect(transcript).not.toContainText('тестовая запись.');
      await expect(transcript).toContainText('[смех]');
      await expect(transcript).toContainText('Удалённая тестовая фраза.');
      await expect(transcript).not.toContainText('Продолжим проверку вместе.');
    } else if (mode === 'current') {
      await expect(transcript).toContainText('Привет, это тестовая запись.');
      await expect(transcript).toContainText('Продолжим проверку вместе.');
      await expect(transcript).not.toContainText('пробная');
      await expect(transcript).not.toContainText('[смех]');
      await expect(transcript).not.toContainText('Удалённая тестовая фраза.');
    } else {
      await expect(transcript).toContainText('пробная');
      await expect(transcript).toContainText('тестовая');
      await expect(transcript).toContainText('[смех]');
      await expect(transcript).toContainText('Удалённая тестовая фраза.');
      await expect(oldTime).toBeVisible();
      await expect(newTime).toBeVisible();
      await expect(page.locator('[title*="old segment"][title*="deleted"]')).toBeVisible();
    }
    await expect(diffSwitch).toBeChecked();
    await expect(page.locator('section[data-annotation-id] [data-slate-editor="true"]')).toHaveCount(0);
  }
  await babel.setExtensionSettings('helper', { features: { extendedDiffView: false } });
  await expect(modes).toHaveCount(0);
  await expect(oldTime).toHaveCount(0);
  await expect(newTime).toHaveCount(0);
  await expect(diffSwitch).toBeChecked();
  await expect(transcript).toHaveText(nativeText, { useInnerText: true });
  expect(await page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations)).toEqual(originalNativeAnnotations);
  expect((await babel.state()).action.annotations).toEqual(originalAnnotations);
});
