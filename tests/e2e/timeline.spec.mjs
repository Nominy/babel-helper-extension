import { test, expect } from '@nominy/babel-extension-e2e/test';
import { rows as nativeRows } from '@nominy/babel-extension-e2e/native-helpers';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

import { transcriptSelector as TEXT, readRows as rows, fillText } from './helper-editing-utils.mjs';
import { selectedAudioReady, fitNativeTimeline as fit } from './native-audio-utils.mjs';
const HOST = '[data-babel-helper-minimap-host]';
const PREVIEW = '[data-babel-helper-cut-preview]';
const ZOOM = '[role="slider"][data-orientation="horizontal"][aria-valuemin="10"][aria-valuemax="2000"]';
const TOLERANCE = 0.12; // Native timestamp quantization and pointer placement.

test.use({ extensions: ['helper', 'gold'] });


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
  await selectedAudioReady(page);
}


async function pointAt(page, seconds, lane = 0, duration = 12) {
  const wrapper = page.locator('[part="scroll"]').nth(lane).locator(':scope > [part="wrapper"]');
  const box = await wrapper.boundingBox();
  expect(box, 'Decoded WaveSurfer wrapper must have actual browser geometry').not.toBeNull();
  const point = { x: box.x + box.width * seconds / duration, y: box.y + box.height * 0.55 };
  const viewport = await page.locator('[part="scroll"]').nth(lane).boundingBox();
  expect(point.x).toBeGreaterThanOrEqual(viewport.x);
  expect(point.x).toBeLessThanOrEqual(viewport.x + viewport.width);
  return point;
}

async function preview(page, start, end, lane = 0) {
  const from = await pointAt(page, start, lane);
  const to = await pointAt(page, end, lane);
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

async function annotations(page) {
  return page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations
    .slice().sort((left, right) => left.id.localeCompare(right.id)));
}

let nativeRuntimeBundle;
async function historyDepth(page) {
  nativeRuntimeBundle ??= build({
    entryPoints: [fileURLToPath(import.meta.resolve('@nominy/babel-babel-runtime'))],
    bundle: true, write: false, format: 'iife', globalName: 'TimelineNativeRuntime'
  }).then(result => result.outputFiles[0].text);
  return page.evaluate(source => {
    const runtime = new Function(`${source}; return TimelineNativeRuntime;`)();
    const history = runtime.readBabelTranscriptBindings()?.history;
    if (!history) throw new Error('Native undo history is unavailable');
    return history.undoStack.length;
  }, await nativeRuntimeBundle);
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
    'S cuts only overlapping lane 1 and leaves the other native recording exact',
    'S cuts only overlapping lane 2 and leaves the other native recording exact',
    'S trims boundaries and deletes covered turns only in its overlapping lane',
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
  const sourceRegion = page.locator(HOST).first().locator('[part~="region"]').first();
  const regionId = await sourceRegion.evaluate(element =>
    element.getAttribute('part').split(/\s+/).find(token => token !== 'region'));
  const magnifier = page.locator('[data-babel-helper-magnifier]');

  for (const { side, field, times } of [
    { side: 'right', field: 'end', times: [2, 2.2] },
    { side: 'left', field: 'start', times: [0.7, 0.9] }
  ]) {
    const edge = sourceRegion.locator(`[part~="region-handle-${side}"]`);
    const edgeBox = await edge.boundingBox();
    await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2);
    await page.mouse.down();
    for (const seconds of times) {
      const target = await pointAt(page, seconds);
      await page.mouse.move(target.x, target.y, { steps: 12 });
      await expect(magnifier).toBeVisible();
      await expect(magnifier).toContainText(/3x @/);
      await expect(magnifier.locator('canvas').first()).toBeVisible();
      // Both live updates happen before pointerup. Annotation times and native
      // tooltip labels still describe the committed region during this drag.
      await expect.poll(async () => {
        const time = Number((await magnifier.textContent()).match(/@\s+([\d.]+)s/)?.[1]);
        return Math.abs(time - seconds);
      }).toBeLessThan(TOLERANCE);
      const rendered = magnifier.locator(`[data-babel-helper-magnifier-region="${regionId}"]`);
      await expect(rendered).toHaveCount(1);
      await expect.poll(() => rendered.evaluate((element, side) => {
        const region = element.getBoundingClientRect();
        const viewport = element.parentElement.getBoundingClientRect();
        const boundary = side === 'left' ? region.left : region.right;
        return Math.abs(boundary - (viewport.left + viewport.width / 2));
      }, side)).toBeLessThan(2);
      expect(await rows(page)).toEqual(before);
    }
    await test.info().attach(`native-${side}-edge-magnifier`, {
      body: await page.screenshot(), contentType: 'image/png'
    });
    await page.mouse.up();
    await expect(magnifier).toHaveCount(0);
    await expect.poll(async () => Math.abs((await rows(page))[0][field] - times.at(-1))).toBeLessThan(TOLERANCE);
    const after = await rows(page);
    expect(after[0][field === 'start' ? 'end' : 'start']).toBe(before[0][field === 'start' ? 'end' : 'start']);
    expect(after[0].text).toBe(before[0].text);
    expect(after.slice(1)).toEqual(before.slice(1));
    // A single native undo must restore the full drag, not one pointer step.
    await page.locator(ZOOM).focus();
    await page.keyboard.press('Control+KeyZ');
    await expect.poll(() => rows(page)).toEqual(before);
  }
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
  await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations
    .filter(annotation => annotation.processedRecordingId === 'speaker-1')
    .sort((left, right) => left.startTimeInSeconds - right.startTimeInSeconds)
    .map(annotation => annotation.content).join(' ').replace(/\s+/g, ' ').trim())).toBe(before[0].text);
  const split = await rows(page);
  expect(Math.abs(split[0].end - 2)).toBeLessThan(TOLERANCE);
  expect(Math.abs(split[1].start - 3.3)).toBeLessThan(TOLERANCE);
  expect(split.slice(2)).toEqual(before.slice(1));
  await page.locator(TEXT).first().click();
  await page.keyboard.press('Alt+Shift+ArrowDown');
  await expect(page.locator(TEXT)).toHaveCount(3);
  // Row removal and the surviving native editor can commit separately.
  await expect.poll(async () => (await rows(page))[0]).toEqual(before[0]);
  await page.locator(ZOOM).focus();
  await page.keyboard.press('Control+KeyZ');
  await expect(page.locator(TEXT)).toHaveCount(4);
  await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations
    .filter(annotation => annotation.processedRecordingId === 'speaker-1')
    .sort((left, right) => left.startTimeInSeconds - right.startTimeInSeconds)
    .map(annotation => annotation.content))).toEqual(split.slice(0, 2).map(row => row.text));
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

for (const laneIndex of [0, 1]) {
  test(`S cuts only overlapping lane ${laneIndex + 1} and leaves the other native recording exact`, async ({ page, babel }) => {
    const { action } = await babel.state();
    const recordingIds = ['speaker-1', 'speaker-2'];
    const turns = recordingIds.map(processedRecordingId => {
      const lane = action.annotations.filter(turn => turn.processedRecordingId === processedRecordingId);
      return { ...lane[0], startTimeInSeconds: 0.3, endTimeInSeconds: 8.8,
        content: lane.map(turn => turn.content).join(' ') };
    });
    await babel.reset('baseline', { action: { annotations: turns } });
    await ready(page, 2);
    await fit(page);
    const before = await annotations(page);
    const targetId = recordingIds[laneIndex], otherId = recordingIds[1 - laneIndex];
    const source = before.find(turn => turn.processedRecordingId === targetId);
    const untouched = before.filter(turn => turn.processedRecordingId === otherId);
    // A selected transcript row in the other lane must never redirect the cut.
    await page.locator(`section[data-annotation-id="${untouched[0].id}"]`).locator(TEXT).click();
    const historyBefore = await historyDepth(page);
    await preview(page, 2, 3.4, laneIndex);
    await page.keyboard.press('KeyS');
    await expect(page.locator(PREVIEW)).toHaveCount(0);
    await expect(page.locator(TEXT)).toHaveCount(3);
    const after = await annotations(page);
    expect(after.filter(turn => turn.processedRecordingId === otherId)).toEqual(untouched);
    const cut = after.filter(turn => turn.processedRecordingId === targetId)
      .sort((left, right) => left.startTimeInSeconds - right.startTimeInSeconds);
    expect(cut).toHaveLength(2);
    expect(cut.map(turn => turn.content).join(' ').replace(/\s+/g, ' ').trim()).toBe(source.content);
    expect(Math.abs(cut[0].endTimeInSeconds - 2)).toBeLessThan(TOLERANCE);
    expect(Math.abs(cut[1].startTimeInSeconds - 3.4)).toBeLessThan(TOLERANCE);
    expect(cut[0].startTimeInSeconds).toBe(source.startTimeInSeconds);
    expect(cut[1].endTimeInSeconds).toBe(source.endTimeInSeconds);
    const historyAfter = await historyDepth(page);
    expect(historyAfter - historyBefore).toBeGreaterThan(0);
    expect(historyAfter - historyBefore).toBeLessThanOrEqual(3);
    await page.locator(ZOOM).focus();
    for (let revision = historyAfter; revision > historyBefore; revision--) {
      await page.keyboard.press('Control+KeyZ');
      await expect.poll(() => historyDepth(page)).toBe(revision - 1);
    }
    await expect.poll(() => annotations(page)).toEqual(before);
  });
}

test('S trims boundaries and deletes covered turns only in its overlapping lane', async ({ page, babel }) => {
  const { action } = await babel.state();
  const turns = ['speaker-1', 'speaker-2'].flatMap(processedRecordingId => {
    const source = action.annotations.find(turn => turn.processedRecordingId === processedRecordingId);
    return [[0.3, 2.7], [3, 4.5], [4.8, 7.5]].map(([startTimeInSeconds, endTimeInSeconds], index) => ({
      ...source, id: `${source.id}-overlap-${index}`, content: `${source.content} ${index}`,
      startTimeInSeconds, endTimeInSeconds
    }));
  });
  await babel.reset('baseline', { action: { annotations: turns } });
  await ready(page, 6);
  await fit(page);
  const before = await annotations(page);
  await preview(page, 1.5, 6, 1);
  await page.keyboard.press('KeyS');
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  await expect(page.locator(TEXT)).toHaveCount(5);
  const after = await annotations(page);
  expect(after.filter(turn => turn.processedRecordingId === 'speaker-1'))
    .toEqual(before.filter(turn => turn.processedRecordingId === 'speaker-1'));
  const originalLane = before.filter(turn => turn.processedRecordingId === 'speaker-2')
    .sort((left, right) => left.startTimeInSeconds - right.startTimeInSeconds);
  const cut = after.filter(turn => turn.processedRecordingId === 'speaker-2')
    .sort((left, right) => left.startTimeInSeconds - right.startTimeInSeconds);
  expect(cut).toHaveLength(2);
  expect(cut.map(turn => turn.id)).toEqual([originalLane[0].id, originalLane[2].id]);
  expect(Math.abs(cut[0].endTimeInSeconds - 1.5)).toBeLessThan(TOLERANCE);
  expect(Math.abs(cut[1].startTimeInSeconds - 6)).toBeLessThan(TOLERANCE);
  expect(cut[0].content).toBe(originalLane[0].content);
  expect(cut[1].content).toBe(originalLane[2].content);
  expect(cut[0].startTimeInSeconds).toBe(originalLane[0].startTimeInSeconds);
  expect(cut[1].endTimeInSeconds).toBe(originalLane[2].endTimeInSeconds);
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
  await fillText(page.locator(TEXT).first(), 'Проверка масштаба после изменения текста.');
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
  const scroll = page.locator(HOST).first().locator('[part="scroll"]');
  const expectBoundedMinimap = async () => {
    await expect.poll(() => map.evaluate(async (element) => {
      const viewportWidth = document.documentElement.clientWidth;
      const root = document.querySelector('.recovered-babel-root');
      const sidebar = document.querySelector('[data-recovered-shell] > aside');
      const rect = element.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const toolbarRect = element.parentElement.getBoundingClientRect();
      const canvases = [...element.querySelectorAll('canvas')];
      const imagesValid = await Promise.all(canvases.map(async (canvas) => {
        const bounds = canvas.getBoundingClientRect();
        if (canvas.width < 1 || canvas.height < 1 ||
            canvas.width > Math.ceil(viewportWidth * devicePixelRatio) ||
            Math.abs(canvas.width - bounds.width * devicePixelRatio) > 1 ||
            Math.abs(canvas.height - bounds.height * devicePixelRatio) > 1) return false;
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) return false;
        const image = new Image();
        image.src = canvas.toDataURL();
        await image.decode();
        return image.naturalWidth === canvas.width && image.naturalHeight === canvas.height;
      }));
      return {
        shellFits: rootRect.left >= sidebar.getBoundingClientRect().right - 1 &&
          rootRect.right <= viewportWidth + 1,
        documentFits: document.documentElement.scrollWidth <= viewportWidth + 1 &&
          document.body.scrollWidth <= viewportWidth + 1 && window.scrollX === 0,
        toolbarFits: toolbarRect.left >= rootRect.left - 1 &&
          toolbarRect.right <= rootRect.right + 1 && toolbarRect.height <= 64,
        mapFits: rect.width >= 180 && rect.left >= toolbarRect.left - 1 &&
          rect.right <= toolbarRect.right + 1 && rect.height >= 40 && rect.height <= 48,
        imagesValid: canvases.length === 2 && imagesValid.every(Boolean)
      };
    })).toEqual({
      shellFits: true, documentFits: true,
      toolbarFits: true, mapFits: true, imagesValid: true
    });
  };
  await expectBoundedMinimap();
  const box = await map.boundingBox();
  await expect.poll(async () => (await media(page)).length).toBeGreaterThanOrEqual(2);
  const duration = (await media(page))[0].duration;
  expect(duration).toBeGreaterThan(12);
  await map.click({ position: { x: box.width * 0.85, y: 20 } });
  await expect.poll(async () => Math.abs((await media(page))[0].time / duration - 0.85)).toBeLessThan(0.03);
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft / (element.scrollWidth - element.clientWidth))).toBeGreaterThan(0.75);
  // At 2000px/s one minimap pixel can represent hundreds of waveform pixels.
  // Reach the actual left edge under pointer capture, not a nonzero timestamp.
  await page.mouse.move(box.x + box.width * 0.85, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x, box.y + 20, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await media(page))[0].time / duration).toBeLessThan(0.04);
  await expect.poll(async () => (await media(page))[0].time).toBeLessThanOrEqual(0.01);
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeLessThanOrEqual(1);
  await expectBoundedMinimap();
  expect(await rows(page)).toEqual(before);
  await fit(page);
  const region = page.locator(HOST).first().locator('[part~="region"]').first();
  await region.hover();
  const tooltip = page.locator('.wavesurfer-region-label-tooltip > span').filter({ visible: true }).first();
  await expect(tooltip).toBeVisible();
  // Current Babel shows the words around the hovered audio time, not the whole label.
  const regionBox = await region.boundingBox();
  const words = before[0].text.trim().split(/\s+/);
  await page.mouse.move(regionBox.x + Math.min(1, regionBox.width * 0.01), regionBox.y + regionBox.height / 2);
  await expect.poll(async () => (await tooltip.textContent()).startsWith(words[0])).toBe(true);
  await page.mouse.move(regionBox.x + regionBox.width - Math.min(1, regionBox.width * 0.01), regionBox.y + regionBox.height / 2);
  await expect.poll(async () => (await tooltip.textContent()).endsWith(words.at(-1))).toBe(true);
});

test('read-only timeline rejects every mutating Helper gesture', async ({ page, babel }) => {
  await babel.reset('readonly');
  await expect(nativeRows(page)).toHaveCount(4);
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
