import { test, expect } from '@nominy/babel-extension-e2e/test';
import { ready, readRows } from './helper-editing-utils.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Both branches exercise the actual offscreen/broker/MAIN/native-WaveSurfer path
// without Grader. Real mode uses packaged ZipEnhancer/WebGPU and licensed speech;
// placeholder mode uses explicitly synthetic half-amplitude HTTP fixture PCM.
// Sample arithmetic proves native buffer commits, never denoising quality.
test.use({ extensions: ['helper', 'gold'] });

export const featureScenarios = {
  audioEnhancement: ['native enhancement: manual Generate, 90% mix, Original, full-strength consent and persistent cache without Grader'],
};

async function audioTracks(page) {
  return page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks.map((track) => ({
    id: track.id, duration: track.duration, decodedSampleRate: track.decodedSampleRate,
    decodedLength: track.decodedLength, decodedRms: track.decodedRms,
    regions: track.regions,
  })));
}

let runtimeBundle;
async function installPcmReader(page) {
  runtimeBundle ??= build({
    entryPoints: [fileURLToPath(import.meta.resolve('@nominy/babel-babel-runtime'))],
    bundle: true, write: false, format: 'iife', globalName: 'BabelEnhancementTestRuntime',
  }).then((result) => result.outputFiles[0].text);
  await page.addScriptTag({ content: await runtimeBundle });
  await page.evaluate(() => { window.enhancementPcmSnapshots = new Map(); });
}

async function capturePcm(page, name) {
  return page.evaluate(async (label) => {
    const bindings = window.BabelEnhancementTestRuntime.readBabelPlaybackBindings();
    if (!bindings?.waves.length) throw new Error('Native playback bindings are unavailable');
    const tracks = bindings.waves.map((wave) => {
      const buffer = wave.getDecodedData();
      if (!buffer) throw new Error('Native audio has not decoded');
      return {
        sampleRate: buffer.sampleRate, frameCount: buffer.length,
        samples: new Float32Array(buffer.getChannelData(0)),
      };
    });
    // Keep PCM inside the browser; only small metadata and hashes cross Playwright.
    window.enhancementPcmSnapshots.set(label, tracks);
    return Promise.all(tracks.map(async ({ sampleRate, frameCount, samples }) => ({
      sampleRate, frameCount,
      sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', samples.buffer))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    })));
  }, name);
}

test('ZipEnhancer shares the transcript toolbar with theme and magic wand', async ({ page }, testInfo) => {
  await ready(page);
  const panel = page.locator('[data-babel-helper-audio-enhancement]');
  const theme = page.locator('[data-babel-helper-appearance-button]');
  const wand = page.locator('#babel-gold-drafting-magic-button');
  await expect(panel).toBeInViewport({ ratio: 1 });
  await expect(theme).toBeVisible();
  await expect(wand).toBeVisible();
  await expect.poll(() => panel.evaluate(element => {
    const theme = document.querySelector('[data-babel-helper-appearance-button]');
    const wand = document.querySelector('#babel-gold-drafting-magic-button');
    return element.parentElement === theme?.parentElement && element.parentElement === wand?.parentElement;
  })).toBe(true);
  const boxes = await Promise.all([panel, theme, wand].map(control => control.boundingBox()));
  const center = boxes[0].y + boxes[0].height / 2;
  for (const box of boxes.slice(1)) expect(Math.abs(box.y + box.height / 2 - center)).toBeLessThan(2);
  await page.screenshot({ path: `${testInfo.project.outputDir}/zipenhancer-toolbar.png` });
});

test(featureScenarios.audioEnhancement[0], async ({ page, babel }) => {
  const realModels = babel.browserModels === 'real';
  test.setTimeout(realModels ? 600_000 : 120_000);
  await page.addInitScript(() => {
    window.enhancementInferenceEvidence = [];
    window.addEventListener('message', (event) => {
      if (event.source !== window || event.data?.source !== 'babel-helper-audio-enhancement-event' ||
          event.data.type !== 'state') return;
      const progress = event.data.state?.progress;
      if (progress?.backend === 'webgpu' && progress.phase === 'enhancing' && progress.completedChunks > 0) {
        window.enhancementInferenceEvidence.push({
          backend: progress.backend, phase: progress.phase,
          completedChunks: progress.completedChunks, totalChunks: progress.totalChunks,
        });
      }
    });
  });
  await babel.setExtensionSettings('gold', {
    mode: 'simple', openRouterApiKey: '', localModelsEnabled: false,
    audioEnhancementBackend: realModels ? 'auto' : 'swarm',
    l0CustomBaseUrl: babel.apiURL, backendBaseUrl: babel.apiURL,
  });
  await babel.setExtensionSettings('helper', { features: { audioEnhancement: true } });
  const scenario = await babel.reset('baseline', realModels ? { audio: { fixture: 'speech' } } : {});
  await ready(page, scenario.action.annotations.length);
  await installPcmReader(page);
  const before = await readRows(page);
  const panel = page.locator('[data-babel-helper-audio-enhancement]');
  const slider = panel.getByRole('slider', { name: 'Original audio mix', exact: true });
  const selected = panel.locator('[data-selection]');
  const generate = panel.locator('[data-details-button]');
  await expect(panel).toBeVisible();
  await expect(slider).toHaveValue('100');
  await expect(slider).toBeDisabled();
  await expect(selected).toHaveText('0%');
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  await expect(generate).toHaveText('Generate');
  expect((await babel.state()).calls.filter((call) => call.path === '/v1/enhance')).toEqual([]);
  await generate.focus();
  await generate.press('Enter');
  await expect(slider).toHaveValue('10');
  await expect(selected).toHaveText('90%', { timeout: realModels ? 300_000 : 60_000 });
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  const mixed = await audioTracks(page);
  const mixedPcm = await capturePcm(page, 'mixed90');
  expect(mixed).toHaveLength(2);
  const enhanceCalls = (await babel.state()).calls.filter((call) => call.path === '/v1/enhance');
  if (realModels) {
    expect(enhanceCalls).toEqual([]);
    // A cache-only result cannot masquerade as first-run local inference.
    expect(await page.evaluate(() => window.enhancementInferenceEvidence.length)).toBeGreaterThan(0);
  } else {
    expect(enhanceCalls.length).toBeGreaterThan(0);
    expect(enhanceCalls.every((call) => call.outcome === 'success')).toBe(true);
  }

  await slider.press('End');
  await expect(selected).toHaveText('0%');
  await expect(slider).toHaveValue('100');
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  const original = await audioTracks(page);
  const originalPcm = await capturePcm(page, 'original');
  original.forEach((track, index) => {
    expect(track.decodedRms).toBeGreaterThan(0);
    expect(mixed[index]).toMatchObject({
      id: track.id, duration: track.duration, decodedSampleRate: track.decodedSampleRate,
      decodedLength: track.decodedLength, regions: track.regions,
    });
    if (!realModels) expect(mixed[index].decodedRms / track.decodedRms).toBeCloseTo(0.55, 3);
  });

  await slider.press('Home');
  const warning = page.getByRole('dialog', { name: 'Use 100% enhanced audio?', exact: true });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('suppress or remove speech');
  expect(await audioTracks(page)).toEqual(original);
  expect(await capturePcm(page, 'pending-consent')).toEqual(originalPcm);
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(selected).toHaveText('0%');
  await expect(slider).toHaveValue('100');
  await slider.press('Home');
  await expect(warning).toBeVisible();
  await warning.getByRole('button', { name: 'Use 100% enhanced', exact: true }).click();
  await expect(selected).toHaveText('100%');
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  const enhanced = await audioTracks(page);
  const enhancedPcm = await capturePcm(page, 'enhanced');
  enhanced.forEach((track, index) => {
    if (!realModels) expect(track.decodedRms / original[index].decodedRms).toBeCloseTo(0.5, 3);
    expect(track).toMatchObject({
      id: original[index].id, duration: original[index].duration,
      decodedSampleRate: original[index].decodedSampleRate,
      decodedLength: original[index].decodedLength, regions: original[index].regions,
    });
    expect(enhancedPcm[index].sha256).not.toBe(originalPcm[index].sha256);
  });
  const arithmetic = await page.evaluate(() => {
    const snapshots = window.enhancementPcmSnapshots;
    const original = snapshots.get('original'), mixed = snapshots.get('mixed90'), enhanced = snapshots.get('enhanced');
    if (original.length !== mixed.length || original.length !== enhanced.length) throw new Error('Native lane count changed');
    return original.map((track, index) => {
      const mix = mixed[index], clean = enhanced[index];
      if (track.sampleRate !== mix.sampleRate || track.sampleRate !== clean.sampleRate ||
          track.frameCount !== mix.frameCount || track.frameCount !== clean.frameCount) throw new Error('Native PCM clocks changed');
      let maximumError = 0, finite = true;
      for (let sample = 0; sample < track.samples.length; sample += 1) {
        const expected = 0.1 * track.samples[sample] + 0.9 * clean.samples[sample];
        finite &&= Number.isFinite(expected) && Number.isFinite(mix.samples[sample]);
        maximumError = Math.max(maximumError, Math.abs(mix.samples[sample] - expected));
      }
      return { maximumError, finite, sampleCount: track.samples.length };
    });
  });
  expect(arithmetic).toHaveLength(2);
  for (const track of arithmetic) {
    expect(track.sampleCount).toBeGreaterThan(0);
    expect(track.finite).toBe(true);
    expect(track.maximumError).toBeLessThanOrEqual(4 / 32768);
  }
  await slider.press('End');
  await expect(selected).toHaveText('0%');
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  expect(await capturePcm(page, 'restored-original')).toEqual(originalPcm);
  expect(await readRows(page)).toEqual(before);
  expect((await babel.state()).calls.filter((call) => call.path === '/v1/enhance')).toHaveLength(enhanceCalls.length);

  // A full page boot stays Original until Generate requests the verified cached pair.
  await page.reload();
  await ready(page, scenario.action.annotations.length);
  await installPcmReader(page);
  await expect(selected).toHaveText('0%');
  await expect(generate).toHaveText('Generate');
  await generate.click();
  await expect(selected).toHaveText('90%');
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  const cached = await audioTracks(page);
  cached.forEach((track, index) => expect(track.decodedRms).toBeCloseTo(mixed[index].decodedRms, 6));
  expect(await capturePcm(page, 'cached90')).toEqual(mixedPcm);
  await expect(panel.locator('[data-status]')).toContainText('Reusing the locally cached pair.');
  expect((await babel.state()).calls.filter((call) => call.path === '/v1/enhance')).toHaveLength(enhanceCalls.length);

  await babel.setExtensionSettings('helper', { features: { audioEnhancement: false } });
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await audioTracks(page)).map((track) => track.decodedRms)).toEqual(original.map((track) => track.decodedRms));
  expect(await capturePcm(page, 'disabled-original')).toEqual(originalPcm);
  await babel.setExtensionSettings('helper', { features: { audioEnhancement: true } });
  await expect(selected).toHaveText('0%');
  await expect(generate).toHaveText('Generate');
  await generate.click();
  await expect(selected).toHaveText('90%');
  await expect(panel).toHaveAttribute('aria-busy', 'false');
  expect(await capturePcm(page, 'reenabled90')).toEqual(mixedPcm);
  await expect(panel.locator('[data-status]')).toContainText('Reusing the locally cached pair.');
  const calls = (await babel.state()).calls;
  expect(calls.filter((call) => call.path === '/v1/enhance')).toHaveLength(enhanceCalls.length);
  expect(calls.filter((call) => /\/api\/draft|\/v1\/transcribe|openrouter|chat\/completions/.test(call.path || ''))).toEqual([]);
  expect(await readRows(page)).toEqual(before);
});
