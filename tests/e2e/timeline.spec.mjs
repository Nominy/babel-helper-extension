import { test, expect } from '../../../shared/babel-extension-platform/packages/babel-extension-e2e/src/test.mjs';

const TEXT = 'textarea[placeholder="What was said…"]';
const HOST = '[data-babel-helper-minimap-host]';
const PREVIEW = '[data-babel-helper-cut-preview]';
const ZOOM = '[role="slider"][data-orientation="horizontal"][aria-valuemin="10"][aria-valuemax="2000"]';
const TOLERANCE = 0.12; // Native timestamp quantization and pointer placement.

test.use({ extensions: ['helper', 'gold'] });

async function rows(page) {
  return page.locator('tbody tr').evaluateAll((elements) => elements.filter((row) => row.querySelector('textarea[placeholder="What was said…"]')).map((row) => {
    const seconds = (cell) => {
      const match = cell?.textContent?.match(/\d+(?::\d+)+(?:\.\d+)?/);
      if (!match) throw new Error(`Missing native timestamp: ${cell?.textContent}`);
      return match[0].split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
    };
    return { speaker: row.children[1].textContent.trim(), start: seconds(row.children[2]), end: seconds(row.children[3]), text: row.querySelector('textarea').value };
  }));
}

async function ready(page, count = 4) {
  await expect(page.locator(TEXT)).toHaveCount(count);
  await expect(page.locator(HOST)).toHaveCount(2);
  await expect(page.locator(HOST).first().locator('canvas').first()).toBeVisible();
  await expect(page.locator('[data-babel-helper-minimap] canvas')).toHaveCount(2);
  for (const canvas of await page.locator('[data-babel-helper-minimap] canvas').all()) {
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute('width', /^[1-9]\d*$/);
  }
  await expect(page.locator(ZOOM)).toBeVisible();
}

async function fit(page) {
  const scroll = page.locator('[part="scroll"]').first();
  const duration = (await media(page))[0].duration;
  const visibleWidth = await scroll.evaluate((element) => element.clientWidth);
  await page.locator(ZOOM).focus();
  await page.keyboard.press('Home');
  await expect(page.locator(ZOOM)).toHaveAttribute('aria-valuenow', '10');
  // Native minimum zoom is 10px/s, not "fit": short tracks otherwise have
  // overlapping handle hit areas and sub-threshold cut-selection distances.
  const value = Math.max(10, visibleWidth * 0.8 / duration);
  if (value > 10) {
    const track = page.locator('[data-orientation="horizontal"]').filter({ has: page.locator(ZOOM) }).first();
    const box = await track.boundingBox();
    await track.click({ position: { x: box.width * (value - 10) / 1990, y: box.height / 2 } });
  }
  await expect.poll(() => scroll.locator('[part="wrapper"]').evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(visibleWidth * 0.5);
  await expect.poll(() => scroll.locator('[part="wrapper"]').evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(visibleWidth);
}

async function pointAt(page, seconds, lane = 0, duration = 12) {
  const wrapper = page.locator('[part="scroll"]').nth(lane).locator('[part="wrapper"]');
  const box = await wrapper.boundingBox();
  expect(box, 'Decoded WaveSurfer wrapper must have actual browser geometry').not.toBeNull();
  const point = { x: box.x + box.width * seconds / duration, y: box.y + box.height * 0.55 };
  const viewport = await page.locator('[part="scroll"]').nth(lane).boundingBox();
  expect(point.x).toBeGreaterThanOrEqual(viewport.x);
  expect(point.x).toBeLessThanOrEqual(viewport.x + viewport.width);
  return point;
}

async function preview(page, start, end) {
  const from = await pointAt(page, start);
  const to = await pointAt(page, end);
  await page.keyboard.down('Alt');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.locator(PREVIEW)).toBeVisible();
  await expect(page.locator(`${PREVIEW} [data-babel-helper-cut-label]`)).toHaveText(/\d+\.\d+s/);
}

async function mergedLaneFixture(babel) {
  const { action } = await babel.state();
  const lane = action.annotations.filter((row) => row.processedRecordingId === 'speaker-1');
  const others = action.annotations.filter((row) => row.processedRecordingId !== 'speaker-1');
  await babel.reset('baseline', { action: { annotations: [{ ...lane[0], startTimeInSeconds: 0.3, endTimeInSeconds: 5.2, content: lane.map((row) => row.content).join(' ') }, ...others] } });
}

async function media(page) {
  return page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks.map((track) => ({
    time: track.currentTime, duration: track.duration, paused: !track.playing
  })));
}

export const featureScenarios = {
  magnifier: ['edge drag shows a decoded 3x magnifier and commits the native timestamp'],
  timelineSelection: [
    'Alt-click adjusts only the nearest boundary without making a cut preview',
    'Alt-drag cut handles resize, short cuts refuse, Escape cancels, and zoom cancels stale geometry',
    'S cuts a real region, preserves text once, and native merge restores one row',
    'Shift+S keeps native duplicated text while cutting, and a fully covered region is deleted',
    'read-only timeline rejects every mutating Helper gesture'
  ],
  waveformScaleUnlock: ['waveform scale exceeds 20x, persists, and remains patched after native editing'],
  timelineZoomDefaults: ['zoom is remembered across task boots and minimap reflects the actual viewport'],
  minimap: ['zoom is remembered across task boots and minimap reflects the actual viewport', 'long-track minimap navigates both ends without losing region tooltips or transcript text'],
  wavesurferTooltipEllipsis: ['long-track minimap navigates both ends without losing region tooltips or transcript text']
};

test('edge drag shows a decoded 3x magnifier and commits the native timestamp', async ({ page }) => {
  await ready(page);
  await fit(page);
  const before = await rows(page);
  const edge = page.locator(HOST).first().locator('[part~="region-handle-right"]').first();
  const edgeBox = await edge.boundingBox();
  const target = await pointAt(page, 2.2);
  await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  const magnifier = page.locator('[data-babel-helper-magnifier]');
  await expect(magnifier).toBeVisible();
  await expect(magnifier).toContainText(/3x @/);
  await expect(magnifier.locator('canvas').first()).toBeVisible();
  await test.info().attach('native-edge-magnifier', { body: await page.screenshot(), contentType: 'image/png' });
  await page.mouse.up();
  await expect(magnifier).toHaveCount(0);
  await expect.poll(async () => Math.abs((await rows(page))[0].end - 2.2)).toBeLessThan(TOLERANCE);
  const after = await rows(page);
  expect(after[0].start).toBe(before[0].start);
  expect(after[0].text).toBe(before[0].text);
  expect(after.slice(1)).toEqual(before.slice(1));
});

test('Alt-click adjusts only the nearest boundary without making a cut preview', async ({ page }) => {
  await ready(page);
  await fit(page);
  const before = await rows(page);
  const point = await pointAt(page, 2.7);
  await page.keyboard.down('Alt');
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up('Alt');
  await expect.poll(async () => Math.abs((await rows(page))[0].end - 2.7)).toBeLessThan(TOLERANCE);
  expect((await rows(page)).slice(1)).toEqual(before.slice(1));
  await expect(page.locator(PREVIEW)).toHaveCount(0);
});

test('Alt-drag cut handles resize, short cuts refuse, Escape cancels, and zoom cancels stale geometry', async ({ page }) => {
  await ready(page);
  await fit(page);
  const previousZoom = await page.locator(ZOOM).getAttribute('aria-valuenow');
  await page.locator(ZOOM).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator(ZOOM)).not.toHaveAttribute('aria-valuenow', previousZoom);
  const before = await rows(page);
  await preview(page, 1, 1.5);
  await page.keyboard.press('KeyS');
  await expect(page.locator(PREVIEW)).toBeVisible();
  expect(await rows(page)).toEqual(before);
  const handle = page.locator(`${PREVIEW} [data-babel-helper-cut-handle="right"]`);
  const box = await handle.boundingBox();
  const target = await pointAt(page, 2.4);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(`${PREVIEW} [data-babel-helper-cut-label]`)).toHaveText(/1\.[34]\ds/);
  await page.keyboard.press('Escape');
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  expect(await rows(page)).toEqual(before);
  await preview(page, 1, 2.4);
  const wrapper = page.locator('[part="scroll"]').first().locator('[part="wrapper"]');
  const previousWidth = await wrapper.evaluate((element) => element.getBoundingClientRect().width);
  await page.locator(ZOOM).focus();
  await page.keyboard.press('Home');
  await expect(page.locator(ZOOM)).toHaveAttribute('aria-valuenow', '10');
  await expect.poll(() => wrapper.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(previousWidth / 2);
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  expect(await rows(page)).toEqual(before);
});

test('S cuts a real region, preserves text once, and native merge restores one row', async ({ page, babel }) => {
  await mergedLaneFixture(babel);
  await ready(page, 3);
  await fit(page);
  const before = await rows(page);
  await preview(page, 2, 3.3);
  await page.keyboard.press('KeyS');
  await expect(page.locator(TEXT)).toHaveCount(4);
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  await expect.poll(async () => (await rows(page)).slice(0, 2).map((row) => row.text).join(' ').replace(/\s+/g, ' ').trim()).toBe(before[0].text);
  const split = await rows(page);
  expect(Math.abs(split[0].end - 2)).toBeLessThan(TOLERANCE);
  expect(Math.abs(split[1].start - 3.3)).toBeLessThan(TOLERANCE);
  expect(split.slice(2)).toEqual(before.slice(1));
  await page.locator(TEXT).first().click();
  await page.keyboard.press('Alt+Shift+ArrowDown');
  await expect(page.locator(TEXT)).toHaveCount(3);
  // Row removal and the surviving controlled textarea can commit separately.
  await expect.poll(async () => (await rows(page))[0]).toEqual(before[0]);
});

test('Shift+S keeps native duplicated text while cutting, and a fully covered region is deleted', async ({ page, babel }) => {
  await mergedLaneFixture(babel);
  await ready(page, 3);
  await fit(page);
  const original = (await rows(page))[0].text;
  await preview(page, 2, 3.3);
  await page.keyboard.press('Shift+KeyS');
  await expect(page.locator(TEXT)).toHaveCount(4);
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  const result = await rows(page);
  expect(result[0].text).toBe(original);
  expect(result[1].text).toBe(original);
  expect(Math.abs(result[0].end - 2)).toBeLessThan(TOLERANCE);
  expect(Math.abs(result[1].start - 3.3)).toBeLessThan(TOLERANCE);
  await babel.reset();
  await ready(page);
  await fit(page);
  const before = await rows(page);
  await preview(page, 0.2, 2.8);
  await page.keyboard.press('Shift+KeyS');
  await expect(page.locator(TEXT)).toHaveCount(3);
  expect(await rows(page)).toEqual(before.slice(1));
});

test('waveform scale exceeds 20x, persists, and remains patched after native editing', async ({ page, babel }) => {
  await ready(page);
  const scale = page.locator('[role="slider"][data-orientation="vertical"]').first();
  await expect(scale).toHaveAttribute('aria-valuemax', '1000');
  await scale.dblclick();
  const input = page.locator('[data-babel-helper-waveform-scale-editor] input');
  await expect(input).toBeVisible();
  await input.fill('33');
  await input.press('Enter');
  await expect(scale).toHaveAttribute('aria-valuenow', '33');
  await page.locator(TEXT).first().fill('Проверка масштаба после изменения текста.');
  await expect(scale).toHaveAttribute('aria-valuemax', '1000');
  await expect(scale).toHaveAttribute('aria-valuenow', '33');
  const options = await babel.options('helper');
  await expect.poll(() => options.evaluate(async () => Object.values((await chrome.storage.local.get('workflowDefaults')).workflowDefaults?.waveformScales ?? {}))).toContain(33);
  await options.close();
  // A second task boot reads the persisted user preference, not a test-injected WaveSurfer option.
  await babel.reset();
  await ready(page);
  await expect(scale).toHaveAttribute('aria-valuenow', '33');
});

test('zoom is remembered across task boots and minimap reflects the actual viewport', async ({ page, babel }) => {
  await ready(page);
  await page.locator(ZOOM).focus();
  await page.keyboard.press('End');
  await expect(page.locator(ZOOM)).toHaveAttribute('aria-valuenow', '2000');
  const scroll = page.locator(HOST).first().locator('[part="scroll"]');
  await expect.poll(() => scroll.evaluate((element) => element.scrollWidth / element.clientWidth)).toBeGreaterThan(2);
  const map = page.locator('[data-babel-helper-minimap]');
  await map.click({ position: { x: (await map.boundingBox()).width * 0.8, y: 20 } });
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect.poll(async () => {
    const native = await scroll.evaluate((element) => ({ left: element.scrollLeft, total: element.scrollWidth, visible: element.clientWidth }));
    const viewport = await map.evaluate((element) => {
      const viewport = [...element.querySelectorAll('div')].find((child) => child.style.zIndex === '5');
      if (!viewport) return null;
      const box = viewport.getBoundingClientRect(), mapBox = element.getBoundingClientRect();
      return { left: (box.left - mapBox.left) / mapBox.width, width: box.width / mapBox.width };
    });
    return viewport ? Math.max(Math.abs(viewport.left - native.left / native.total), Math.abs(viewport.width - native.visible / native.total)) : Infinity;
  }).toBeLessThan(0.03);
  await test.info().attach('zoomed-minimap', { body: await page.screenshot(), contentType: 'image/png' });
  const options = await babel.options('helper');
  await expect.poll(() => options.evaluate(async () => (await chrome.storage.local.get('workflowDefaults')).workflowDefaults?.lastZoomValue)).toBe(2000);
  await options.close();
  await babel.reset();
  await ready(page);
  await expect(page.locator(ZOOM)).toHaveAttribute('aria-valuenow', '2000');
});

test('long-track minimap navigates both ends without losing region tooltips or transcript text', async ({ page, babel }) => {
  const scenario = await babel.reset('long');
  const expected = scenario.action.annotations.map((row, index) => index === 0 ? { ...row, content: `${row.content} Длинная подпись на миникарте сохраняет весь исходный текст даже при визуальном сокращении.` } : row);
  await babel.reset('long', { action: { annotations: expected } });
  await ready(page, expected.length);
  await page.locator(ZOOM).focus();
  await page.keyboard.press('End');
  await expect(page.locator(ZOOM)).toHaveAttribute('aria-valuenow', '2000');
  await expect.poll(() => page.locator('[part="scroll"]').first().evaluate((element) => element.scrollWidth / element.clientWidth)).toBeGreaterThan(2);
  const before = await rows(page);
  const map = page.locator('[data-babel-helper-minimap]');
  const box = await map.boundingBox();
  await expect.poll(async () => (await media(page)).length).toBeGreaterThanOrEqual(2);
  const duration = (await media(page))[0].duration;
  expect(duration).toBeGreaterThan(12);
  await map.click({ position: { x: box.width * 0.85, y: 20 } });
  await expect.poll(async () => Math.abs((await media(page))[0].time / duration - 0.85)).toBeLessThan(0.03);
  await expect.poll(() => page.locator(HOST).first().locator('[part="scroll"]').evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await map.click({ position: { x: box.width * 0.01, y: 20 } });
  await expect.poll(async () => (await media(page))[0].time / duration).toBeLessThan(0.04);
  expect(await rows(page)).toEqual(before);
  await fit(page);
  const region = page.locator(HOST).first().locator('[part~="region"]').first();
  await region.hover();
  const tooltip = page.locator('.wavesurfer-region-label-tooltip > span').filter({ visible: true }).first();
  await expect(tooltip).toBeVisible();
  const clipping = await tooltip.evaluate((element) => ({ overflow: getComputedStyle(element).overflow, ellipsis: getComputedStyle(element).textOverflow, nowrap: getComputedStyle(element).whiteSpace, text: element.textContent }));
  expect(clipping).toMatchObject({ overflow: 'hidden', ellipsis: 'ellipsis', nowrap: 'nowrap' });
  expect(clipping.text.trim()).toBe(before[0].text);
});

test('read-only timeline rejects every mutating Helper gesture', async ({ page, babel }) => {
  await babel.reset('readonly');
  await expect(page.locator(TEXT)).toHaveCount(4);
  await expect(page.locator('[part="scroll"]')).toHaveCount(2);
  await expect.poll(async () => (await media(page)).filter((track) => track.duration === 12).length).toBe(2);
  await fit(page);
  const before = await rows(page);
  const point = await pointAt(page, 1.5);
  await page.mouse.click(point.x, point.y);
  for (const shortcut of ['Alt+KeyR', 'Alt+Shift+KeyR', 'Alt+Shift+KeyS', 'Alt+KeyC', 'Alt+Shift+KeyG', 'KeyD', 'Alt+Shift+ArrowDown']) await page.keyboard.press(shortcut);
  const from = await pointAt(page, 1);
  const to = await pointAt(page, 2.4);
  await page.keyboard.down('Alt');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.press('Shift+KeyS');
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  await expect(page.locator('[data-babel-helper-magnifier]')).toHaveCount(0);
  expect(await rows(page)).toEqual(before);
  const state = await babel.state();
  expect(state.action.annotations.map((row) => row.content)).toEqual(before.map((row) => row.text));
  expect(state.calls.filter((call) => /saveAnnotations|submit|transcribeSegment/.test(call.procedure || call.path || ''))).toEqual([]);
});
