import { test, expect } from '@nominy/babel-extension-e2e/test';
import { writeFile } from 'node:fs/promises';
import { ready, editors, caret } from './helper-editing-utils.mjs';

// Local recovered editor + genuine WaveSurfer transport; no model/provider calls.
test.use({ extensions: ['helper'], scenario: 'baseline' });

async function measureMotion(page, durationMs) {
  return page.evaluate(async duration => {
    const requests = { state: 0, seek: 0, other: 0 };
    const onRequest = event => {
      const operation = event.detail?.operation;
      requests[operation === 'state' || operation === 'seek' ? operation : 'other']++;
    };
    window.addEventListener('babel-helper-playback-request', onRequest, true);
    const samples = [];
    const started = performance.now();
    try {
      await new Promise(resolve => {
        const frame = now => {
          const element = document.querySelector('[data-babel-helper-ghost-cursor]');
          const track = window.__BABEL_E2E__.snapshot().audio.tracks[0];
          if (element) {
            const style = getComputedStyle(element);
            const target = new DOMMatrixReadOnly(element.style.transform);
            const painted = new DOMMatrixReadOnly(style.transform);
            samples.push({
              elapsedMs: now - started, currentTime: track.currentTime,
              playbackRate: track.playbackRate, playing: track.playing,
              targetX: target.m41, targetY: target.m42,
              paintedX: painted.m41, paintedY: painted.m42,
              transitionMs: parseFloat(style.transitionDuration) * 1000,
              visible: style.display !== 'none'
            });
          }
          if (now - started >= duration) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    } finally {
      window.removeEventListener('babel-helper-playback-request', onRequest, true);
    }
    const gaps = samples.slice(1).map((sample, index) => sample.elapsedMs - samples[index].elapsedMs).sort((a, b) => a - b);
    const changes = samples.slice(1).filter((sample, index) => sample.targetX !== samples[index].targetX || sample.targetY !== samples[index].targetY).length;
    return { durationMs: duration, requests, changes, frameGapP95Ms: gaps[Math.floor(gaps.length * 0.95)] ?? null, samples };
  }, durationMs);
}

test('native playback ghost motion measurement preserves speed rewind and pause synchronization', async ({ page, babel }, testInfo) => {
  const { action } = await babel.state();
  await babel.reset('baseline', { action: { annotations: action.annotations.map((annotation, index) => index === 0
    ? { ...annotation, endTimeInSeconds: 8, content: 'Проверяем движение курсора вместе со звуком без задержки на каждом следующем слове.' }
    : index === 1 ? { ...annotation, startTimeInSeconds: 9.1, endTimeInSeconds: 11 } : annotation) } });
  await ready(page);
  await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.ready)).toBe(true);
  await editors(page).first().press('Home');
  await caret(editors(page).first(), 0);
  await page.keyboard.press('Escape');
  const ghost = page.locator('[data-babel-helper-ghost-cursor]');
  await expect(ghost).toBeVisible();
  // Cover the first word boundary after the existing reaction-time offset.
  const normal = await measureMotion(page, 2200);
  await page.keyboard.press('Shift+Digit1');
  await page.keyboard.press('Shift+Digit1');
  await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks[0].playbackRate)).toBe(2);
  const fast = await measureMotion(page, 1000);
  const beforeRewind = await page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks[0].currentTime);
  await page.keyboard.press('Alt+KeyX');
  const afterRewind = await page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks[0].currentTime);
  const rewound = await measureMotion(page, 350);
  await page.getByRole('button', { name: 'Pause all tracks', exact: true }).click();
  await expect(ghost).toHaveCount(0);
  const measurementPath = testInfo.outputPath('native-playback-ghost-motion.json');
  await writeFile(measurementPath, JSON.stringify({ normal, fast, beforeRewind, afterRewind, rewound }, null, 2));
  await testInfo.attach('native-playback-ghost-motion', { path: measurementPath, contentType: 'application/json' });
  for (const [measurement, rate] of [[normal, 1], [fast, 2]]) {
    const first = measurement.samples[0];
    const last = measurement.samples.at(-1);
    expect(last.currentTime - first.currentTime).toBeCloseTo(
      rate * (last.elapsedMs - first.elapsedMs) / 1000, 1);
    expect(measurement.samples.every(sample => sample.playbackRate === rate && sample.playing)).toBe(true);
    expect(last.targetY > first.targetY || (last.targetY === first.targetY && last.targetX > first.targetX)).toBe(true);
    for (const sample of measurement.samples) {
      const prior = measurement.samples.findLast(value => value.elapsedMs <= sample.elapsedMs - 100);
      if (!prior || sample.targetY !== prior.targetY || sample.targetX < prior.targetX) continue;
      // Check rendered motion, not a CSS setting: it must not trail a target
      // already published more than 100ms ago on the same line.
      expect(sample.paintedX).toBeGreaterThanOrEqual(prior.targetX - 2);
    }
  }
  expect(afterRewind).toBeLessThan(beforeRewind - 0.5);
  const previousCursor = fast.samples.at(-1);
  expect(rewound.samples.some(sample => sample.targetY < previousCursor.targetY ||
    (sample.targetY === previousCursor.targetY && sample.targetX < previousCursor.targetX))).toBe(true);
});
