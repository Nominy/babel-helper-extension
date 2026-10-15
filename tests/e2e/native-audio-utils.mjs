import { expect } from '@nominy/babel-extension-e2e/test';

const ZOOM = '[role="slider"][data-orientation="horizontal"][aria-valuemin="10"][aria-valuemax="2000"]';

// Success-path setup: duration alone is also true before the automatic selected
// pair replaces the native decoded buffers. Pending/rejection tests do not use this.
export async function selectedAudioReady(page) {
  await expect.poll(() => page.evaluate(() => {
    const native = window.__BABEL_E2E__.snapshot();
    const raw = document.documentElement.getAttribute('data-babel-audio-enhancement');
    const selected = raw ? JSON.parse(raw) : null;
    if (selected?.status === 'error' && (!selected.taskId || selected.taskId === native.reviewActionId)) {
      throw new Error(selected.message || 'Native enhancement failed');
    }
    const failure = document.querySelector('[id^="babel-helper-native-failure-"]');
    if (failure) throw new Error(failure.textContent || 'Native Helper automation stopped');
    return Boolean(native.audio.ready && native.audio.tracks.length === 2 &&
      native.audio.tracks.every(track => track.decoded && track.decodedLength > 0) &&
      selected?.taskId === native.reviewActionId && selected.status === 'ready' &&
      selected.strength === 90 && selected.desiredStrength === 90 && selected.variantKey);
  }), { timeout: 120000 }).toBe(true);
}

export async function fitNativeTimeline(page) {
  const scroll = page.locator('[part="scroll"]').first();
  const duration = await page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks[0].duration);
  const visibleWidth = await scroll.evaluate(element => element.clientWidth);
  await page.locator(ZOOM).focus();
  await page.keyboard.press('Home');
  await expect(page.locator(ZOOM)).toHaveAttribute('aria-valuenow', '10');
  const target = Math.max(10, visibleWidth * 0.8 / duration);
  if (target > 10) {
    // Near-minimum track clicks hit the thumb rather than changing its value.
    // Native36978 binds Ctrl+wheel on the tracks to zoom += -2 * deltaY.
    const box = await scroll.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down('Control');
    try {
      await page.mouse.wheel(0, (10 - target) / 2);
    } finally {
      await page.keyboard.up('Control');
    }
    await expect.poll(async () => Math.abs(Number(await page.locator(ZOOM).getAttribute('aria-valuenow')) - target)).toBeLessThan(1.5);
  }
  const width = () => scroll.locator('[part="wrapper"]').evaluate(element => element.getBoundingClientRect().width);
  await expect.poll(width).toBeGreaterThan(visibleWidth * 0.5);
  await expect.poll(width).toBeLessThanOrEqual(visibleWidth);
}
