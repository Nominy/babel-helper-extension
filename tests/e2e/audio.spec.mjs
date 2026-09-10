import { test, expect } from '@nominy/babel-extension-e2e/test';

const TEXT = 'textarea[placeholder="What was said…"]';
const HOST = '[data-babel-helper-minimap-host]';
const ZOOM = '[role="slider"][data-orientation="horizontal"][aria-valuemin="10"][aria-valuemax="2000"]';
const PREVIEW = '[data-babel-helper-cut-preview]';
const EDGE_TOLERANCE = 0.08; // 16kHz WAV, 10ms attack/release, 5ms Helper padding and displayed milliseconds.

test.use({ extensions: ['helper', 'gold'] });

async function audio(page) {
  // Read-only inspection of the native WebAudio WaveSurfer instances. Never call play/seek/setOptions here.
  return page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks);
}

async function ready(page, rowCount = 4) {
  await expect(page.locator(TEXT)).toHaveCount(rowCount);
  await expect.poll(async () => (await audio(page)).filter((track) => track.duration === 12).length).toBe(2);
  await expect(page.locator(HOST)).toHaveCount(2);
  await expect(page.locator(HOST).first().locator('canvas').first()).toBeVisible();
  await page.locator(ZOOM).focus();
  await page.keyboard.press('Home');
  await expect(page.locator(ZOOM)).toHaveAttribute('aria-valuenow', '10');
}

async function rows(page) {
  return page.locator('tbody tr').evaluateAll((elements) => elements.filter((row) => row.querySelector('textarea[placeholder="What was said…"]')).map((row) => {
    const time = (index) => {
      const text = row.children[index].textContent.match(/\d+(?::\d+)+(?:\.\d+)?/)?.[0];
      if (!text) throw new Error('Native transcript timestamp missing');
      return text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
    };
    return { speaker: row.children[1].textContent.trim(), start: time(2), end: time(3), text: row.querySelector('textarea').value };
  }));
}

async function pointAt(page, seconds, lane = 0) {
  const box = await page.locator(HOST).nth(lane).locator('[part="wrapper"]').boundingBox();
  expect(box).not.toBeNull();
  return { x: box.x + box.width * seconds / 12, y: box.y + box.height * 0.55 };
}

async function seek(page, seconds, lane = 0) {
  const point = await pointAt(page, seconds, lane);
  await page.mouse.click(point.x, point.y);
  await expect.poll(async () => Math.abs((await audio(page))[lane].currentTime - seconds)).toBeLessThan(0.15);
}

async function assertEdges(page, index, start, end) {
  await expect.poll(async () => {
    const row = (await rows(page))[index];
    return Math.max(Math.abs(row.start - start), Math.abs(row.end - end));
  }).toBeLessThan(EDGE_TOLERANCE);
}

export const featureScenarios = {
  playbackSpeedHotkeys: ['speed keys change real playback, preserve position and clamp to the native limits'],
  rowActions: ['Alt+X rewinds exactly one second, clamps at zero and keeps active audio playing'],
  focusToggle: ['Escape executes focused/unfocused pause/restore states with proportional forward-only caret'],
  proportionalCursorRestore: ['Escape executes focused/unfocused pause/restore states with proportional forward-only caret', 'disabled proportional restore restores the exact caret instead of advancing it'],
  disableNativeTimelineDoubleClick: ['double-click suppression retains the clicked time rather than jumping to a region start'],
  audioTrimOutwardPass: ['outward trim recovers clipped speech and respects the disabled outward setting'],
  timelineSelection: [
    'L loops an Alt-drag audio selection and cancelling releases the loop without editing',
    'Alt+R trims only the current segment to known WAV silence boundaries',
    'Alt+Shift+R trims both real lanes without changing their transcripts',
    'Alt+C creates an empty native region only over uncovered speech, then D deletes it',
    'auto segmentation splits known long silence and aligns text using genuine Gold L0 timing'
  ]
};

test('speed keys change real playback, preserve position and clamp to the native limits', async ({ page }) => {
  await ready(page);
  await seek(page, 4);
  const initial = (await audio(page))[0].currentTime;
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(async () => (await audio(page)).map((track) => track.playbackRate)).toEqual([1.5, 1.5]);
  expect(Math.abs((await audio(page))[0].currentTime - initial)).toBeLessThan(0.1);
  await page.keyboard.press('Shift+Digit1');
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(async () => (await audio(page)).map((track) => track.playbackRate)).toEqual([2, 2]);
  for (let index = 0; index < 7; index++) await page.keyboard.press('Shift+Digit2');
  await expect.poll(async () => (await audio(page)).map((track) => track.playbackRate)).toEqual([0.25, 0.25]);
  expect(Math.abs((await audio(page))[0].currentTime - initial)).toBeLessThan(0.1);
  const editor = page.locator(TEXT).first();
  await editor.click();
  await editor.press('End');
  const before = await editor.inputValue();
  await page.keyboard.press('Shift+Digit1');
  await expect(editor).toHaveValue(`${before}!`);
  expect((await audio(page)).map((track) => track.playbackRate)).toEqual([0.25, 0.25]);
});

test('native speed dropdown preserves both lane positions while paused and playing', async ({ page }) => {
  await ready(page);
  await seek(page, 4);
  const paused = await audio(page);
  await page.getByRole('combobox').filter({ hasText: /^1x$/ }).click();
  await page.getByRole('option', { name: '2x', exact: true }).click();
  await expect.poll(async () => (await audio(page)).map(track => track.playbackRate)).toEqual([2, 2]);
  (await audio(page)).forEach((track, index) => {
    expect(track.playing).toBe(false);
    expect(track.currentTime).toBeCloseTo(paused[index].currentTime, 3);
  });
  await page.getByRole('button', { name: 'Play all tracks', exact: true }).click();
  await expect.poll(async () => (await audio(page)).every(track => track.playing)).toBe(true);
  await page.getByRole('combobox').filter({ hasText: /^2x$/ }).click();
  const before = await audio(page);
  await page.getByRole('option', { name: '0.5x', exact: true }).click();
  await expect.poll(async () => (await audio(page)).map(track => track.playbackRate)).toEqual([0.5, 0.5]);
  const after = await audio(page);
  after.forEach((track, index) => {
    expect(track.playing).toBe(true);
    expect(track.currentTime).toBeGreaterThanOrEqual(before[index].currentTime - 0.05);
    expect(track.currentTime - before[index].currentTime).toBeLessThan(0.6);
  });
  expect(Math.abs(after[0].currentTime - after[1].currentTime)).toBeLessThan(0.1);
});

test('Alt+X rewinds exactly one second, clamps at zero and keeps active audio playing', async ({ page }) => {
  await ready(page);
  await seek(page, 4);
  await page.keyboard.press('Alt+KeyX');
  await expect.poll(async () => Math.abs((await audio(page))[0].currentTime - 3)).toBeLessThan(0.15);
  await seek(page, 0.4);
  await page.keyboard.press('Alt+KeyX');
  await expect.poll(async () => (await audio(page))[0].currentTime).toBeLessThan(0.05);
  await seek(page, 3);
  await page.getByRole('button', { name: 'Play all tracks', exact: true }).click();
  await expect.poll(async () => (await audio(page)).every((track) => track.playing)).toBe(true);
  const before = (await audio(page))[0].currentTime;
  await page.keyboard.press('Alt+KeyX');
  await expect.poll(async () => (await audio(page))[0].currentTime).toBeLessThan(before - 0.6);
  expect((await audio(page)).every((track) => track.playing)).toBe(true);
  await page.getByRole('button', { name: 'Pause all tracks', exact: true }).click();
  await expect.poll(async () => (await audio(page)).every((track) => !track.playing)).toBe(true);
});

test('Escape executes focused/unfocused pause/restore states with proportional forward-only caret', async ({ page }) => {
  await ready(page);
  await seek(page, 0.8);
  const editor = page.locator(TEXT).first();
  await editor.click();
  await editor.press('Home');
  await editor.press('ArrowRight');
  const savedOffset = await editor.evaluate((element) => element.selectionStart);
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeFocused();
  await expect.poll(async () => (await audio(page))[0].playing).toBe(true);
  await expect.poll(async () => (await audio(page))[0].currentTime).toBeGreaterThan(1.4);
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  await expect.poll(async () => (await audio(page))[0].playing).toBe(false);
  const restoredOffset = await editor.evaluate((element) => element.selectionStart);
  expect(restoredOffset).toBeGreaterThan(savedOffset);
  expect(restoredOffset).toBeLessThanOrEqual((await editor.inputValue()).length);
  await editor.press('End');
  const endOffset = await editor.evaluate((element) => element.selectionStart);
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeFocused();
  await expect.poll(async () => (await audio(page))[0].playing).toBe(true);
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((element) => element.selectionStart)).toBe(endOffset);
  await expect.poll(async () => (await audio(page))[0].playing).toBe(false);
  // Playing + focused is a separate transition: pause without blurring or moving the caret.
  await page.getByRole('button', { name: 'Play all tracks', exact: true }).click();
  await editor.click();
  await editor.press('Home');
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  await expect.poll(async () => (await audio(page))[0].playing).toBe(false);
  expect(await editor.evaluate((element) => element.selectionStart)).toBe(0);
});

test('disabled proportional restore restores the exact caret instead of advancing it', async ({ page, babel }) => {
  await babel.setExtensionSettings('helper', { features: { proportionalCursorRestore: false } });
  await babel.reset();
  await ready(page);
  await seek(page, 0.8);
  const editor = page.locator(TEXT).first();
  await editor.click();
  await editor.press('Home');
  await editor.press('ArrowRight');
  const before = await editor.evaluate((element) => element.selectionStart);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await audio(page))[0].currentTime).toBeGreaterThan(1.4);
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((element) => element.selectionStart)).toBe(before);
});

test('double-click suppression retains the clicked time rather than jumping to a region start', async ({ page }) => {
  await ready(page);
  const point = await pointAt(page, 1.8);
  await page.mouse.dblclick(point.x, point.y);
  await expect.poll(async () => Math.abs((await audio(page))[0].currentTime - 1.8)).toBeLessThan(0.15);
  expect((await audio(page))[0].currentTime).toBeGreaterThan(1.5);
});

test('L loops an Alt-drag audio selection and cancelling releases the loop without editing', async ({ page }) => {
  await ready(page);
  // At native minimum zoom this track is only 120px wide: 0.8s hits the
  // region's left resize handle rather than its body. Zoom with the real slider.
  const scroll = page.locator('[part="scroll"]').first();
  const visibleWidth = await scroll.evaluate((element) => element.clientWidth);
  const zoomTrack = page.locator('[data-orientation="horizontal"]').filter({ has: page.locator(ZOOM) }).first();
  const zoomBox = await zoomTrack.boundingBox();
  await zoomTrack.click({ position: { x: zoomBox.width * (visibleWidth * 0.8 / 12 - 10) / 1990, y: zoomBox.height / 2 } });
  await expect.poll(() => scroll.locator('[part="wrapper"]').evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(visibleWidth * 0.5);
  const before = await rows(page);
  const from = await pointAt(page, 0.8);
  const to = await pointAt(page, 2.2);
  await page.keyboard.down('Alt');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 16 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.locator(PREVIEW)).toBeVisible();
  await page.keyboard.press('KeyL');
  await expect.poll(async () => (await audio(page))[0].playing).toBe(true);
  await expect.poll(async () => (await audio(page))[0].currentTime).toBeGreaterThan(1.8);
  await expect.poll(async () => (await audio(page))[0].currentTime, { intervals: [30] }).toBeLessThan(1.1);
  expect(await rows(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(page.locator(PREVIEW)).toHaveCount(0);
  // A released loop either pauses natively or permits playback to leave its former bounds.
  await expect.poll(async () => {
    const track = (await audio(page))[0];
    return !track.playing || track.currentTime > 2.35;
  }).toBe(true);
  expect(await rows(page)).toEqual(before);
});

test('Alt+R trims only the current segment to known WAV silence boundaries', async ({ page, babel }) => {
  const state = await babel.state();
  const annotations = state.action.annotations.map((row, index) => index === 0 ? { ...row, startTimeInSeconds: 0, endTimeInSeconds: 2.9 } : row);
  await babel.reset('baseline', { action: { annotations } });
  await ready(page);
  const before = await rows(page);
  await page.locator(TEXT).first().click();
  await page.keyboard.press('Alt+KeyR');
  await assertEdges(page, 0, 0.6, 2.4);
  expect((await rows(page)).slice(1)).toEqual(before.slice(1));
  expect((await rows(page))[0].text).toBe(before[0].text);
});

test('outward trim recovers clipped speech and respects the disabled outward setting', async ({ page, babel }) => {
  const state = await babel.state();
  const annotations = state.action.annotations.map((row, index) => index === 0 ? { ...row, startTimeInSeconds: 1, endTimeInSeconds: 2 } : row);
  await babel.reset('baseline', { action: { annotations } });
  await ready(page);
  await page.locator(TEXT).first().click();
  await page.keyboard.press('Alt+KeyR');
  await assertEdges(page, 0, 0.6, 2.4);
  await babel.setExtensionSettings('helper', { features: { audioTrimOutwardPass: false } });
  await babel.reset('baseline', { action: { annotations } });
  await ready(page);
  await page.locator(TEXT).first().click();
  await page.keyboard.press('Alt+KeyR');
  await assertEdges(page, 0, 1, 2);
});

test('Alt+Shift+R trims both real lanes without changing their transcripts', async ({ page }) => {
  await ready(page);
  const before = await rows(page);
  await page.locator(TEXT).first().click();
  await page.keyboard.press('Alt+Shift+KeyR');
  for (const [index, start, end] of [[0, 0.6, 2.4], [1, 3.6, 4.9], [2, 5.6, 7.4], [3, 8.6, 9.9]]) await assertEdges(page, index, start, end);
  expect((await rows(page)).map((row) => [row.speaker, row.text])).toEqual(before.map((row) => [row.speaker, row.text]));
  await expect(page.locator('#babel-helper-long-task-progress')).toHaveCount(0);
});

test('Alt+C creates an empty native region only over uncovered speech, then D deletes it', async ({ page, babel }) => {
  const state = await babel.state();
  const annotations = state.action.annotations.filter((row) => row.id !== 'row-2');
  await babel.reset('baseline', { action: { annotations } });
  await ready(page, 3);
  await seek(page, 3.8);
  // Deliver the configured shortcut through the browser, never invoke the insert service.
  await page.keyboard.press('Alt+KeyC');
  await expect(page.locator(TEXT)).toHaveCount(4);
  await assertEdges(page, 1, 3.6, 4.9);
  await expect(page.locator(TEXT).nth(1)).toHaveValue('');
  await seek(page, 3.8);
  await page.keyboard.press('Alt+KeyC');
  await expect(page.locator(TEXT)).toHaveCount(4);
  // Auto-insert focuses the matching segment; D deletes only outside text entry.
  await expect(page.locator(TEXT).nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator(TEXT).nth(1)).not.toBeFocused();
  await page.keyboard.press('KeyD');
  await expect(page.locator(TEXT)).toHaveCount(3);
  expect((await rows(page)).map((row) => row.text)).toEqual(annotations.map((row) => row.content));
  await seek(page, 11);
  await page.keyboard.press('Alt+KeyC');
  await expect(page.locator(TEXT)).toHaveCount(3);
});

test('auto segmentation splits known long silence and aligns text using genuine Gold L0 timing', async ({ page, babel }) => {
  const state = await babel.state();
  const lane = state.action.annotations.filter((row) => row.processedRecordingId === 'speaker-1');
  const otherLane = state.action.annotations.filter((row) => row.processedRecordingId !== 'speaker-1');
  const fullText = lane.map((row) => row.content).join(' ');
  await babel.reset('baseline', {
    action: { annotations: [{ ...lane[0], startTimeInSeconds: 0, endTimeInSeconds: 5.2, content: fullText }, ...otherLane] },
    audio: { voicedWindows: { 'speaker-1': [[0.6, 2], [3.5, 4.9]] } }
  });
  await ready(page, 3);
  await page.locator('#babel-gold-drafting-magic-button').hover();
  await expect(page.locator('.bgd-timing-hover-panel')).toHaveAttribute('data-status', 'available', { timeout: 120000 });
  await page.locator(TEXT).first().click();
  await page.keyboard.press('Alt+Shift+KeyS');
  await expect(page.locator(TEXT)).toHaveCount(4, { timeout: 30000 });
  await assertEdges(page, 0, 0.6, 2);
  await assertEdges(page, 1, 3.5, 4.9);
  await expect.poll(async () => (await rows(page)).slice(0, 2).map((row) => row.text).join(' ').replace(/\s+/g, ' ').trim()).toBe(fullText);
  await expect(page.locator('#babel-helper-long-task-progress')).toHaveCount(0);
  expect((await rows(page)).slice(2).map((row) => row.text)).toEqual(otherLane.map((row) => row.content));
  await test.info().attach('silence-segmented-native-waveforms', { body: await page.screenshot(), contentType: 'image/png' });
});
