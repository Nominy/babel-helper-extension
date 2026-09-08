import { test, expect } from '@nominy/babel-extension-e2e/test';

const TEXT = 'textarea[placeholder="What was said…"]';
const PROGRESS = '#babel-helper-long-task-progress';
const DRAFT = '/v1/draft';
const TIMING = '/v1/transcribe';
const REDISTRIBUTE = '/api/broker/redistribute-text';
const ZOOM = '[role="slider"][data-orientation="horizontal"][aria-valuemin="10"][aria-valuemax="2000"]';

test.use({ extensions: ['helper', 'gold'] });

async function captureTiming(page) {
  await page.addInitScript(() => {
    window.__helperE2ETiming = [];
    window.addEventListener('message', (event) => {
      if (event.source === window && event.data?.type === 'babel-gold-drafting:l0-timing-update') window.__helperE2ETiming.push(structuredClone(event.data));
    });
  });
}

async function ready(page, babel, count) {
  await expect(page.locator(TEXT)).toHaveCount(count ?? (await babel.state()).action.annotations.length);
  await expect(page.locator('html')).toHaveAttribute('data-babel-gold-drafting-extension-id', babel.extensionIds.gold);
  await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks.filter((track) => track.duration > 0).length)).toBe(2);
}

async function calls(babel, path) {
  return (await babel.state()).calls.filter((call) => call.path === path);
}

async function completedCall(babel, path, count = 1) {
  await expect.poll(async () => (await calls(babel, path)).filter((call) => call.outcome !== 'pending').length, { timeout: 120000 }).toBeGreaterThanOrEqual(count);
  return (await calls(babel, path)).filter((call) => call.outcome !== 'pending').at(-1);
}

async function emptyFirstRow(page, babel, overrides = {}) {
  const audio = babel.ai !== 'placeholder' && babel.hasSpeechFixtures ? { fixture: 'speech' } : {};
  const { action } = Object.keys(audio).length ? await babel.reset('baseline', { audio }) : await babel.state();
  const annotations = action.annotations.map((row, index) => index === 0 ? { ...row, content: '' } : row);
  await babel.reset('baseline', { ...overrides, audio: { ...audio, ...overrides.audio }, action: { ...overrides.action, annotations } });
  await ready(page, babel);
  await page.locator(TEXT).first().click();
  return annotations;
}

async function invokeTranscription(page) {
  await page.locator(TEXT).first().click();
  await page.keyboard.press('Alt+Shift+KeyG');
}

async function assertGeneratedRow(page, babel, call) {
  const response = call.response;
  const generated = response?.rows?.[0]?.text;
  const noSpeech = call.outcome === 'error' || !generated?.trim();
  if (noSpeech) {
    expect(babel.ai).not.toBe('placeholder');
    expect(babel.hasSpeechFixtures, 'Provisioned speech-success fixtures must yield a valid transcript').toBeFalsy();
    if (call.outcome === 'error') expect(call.error.message).toMatch(/no speech|no segments|empty|no.*voic|invalid local draft response/i);
    else expect(response.rows.every((row) => !row.text.trim())).toBe(true);
    await expect(page.locator(PROGRESS)).toContainText(/failed|invalid|empty|no speech/i);
    await expect(page.locator(TEXT).first()).toHaveValue('');
    test.info().annotations.push({ type: 'model-observation', description: 'Real inference on synthetic tones reported no speech; no transcript was fabricated.' });
    return false;
  }
  expect(call.outcome).toBe('success');
  expect(typeof generated).toBe('string');
  const normalized = generated.trim().replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase('ru-RU'));
  await expect(page.locator(TEXT).first()).toHaveValue(normalized);
  if (babel.ai === 'placeholder') {
    expect(generated).toBe('[E2E placeholder] Проверенная тестовая запись.');
    expect(response.models.asr.name).toBe('e2e-placeholder-v1');
  } else {
    expect(generated).not.toContain('[E2E placeholder]');
  }
  return true;
}

// Shift only the isolated Helper wall-clock after its real 250ms poll has registered.
// No timers, Date constructor, performance.now, main-world clock or WebAudio context are replaced.
async function withHelperTimeoutClock(context, page, extensionId, action) {
  const session = await context.newCDPSession(page);
  const contexts = new Map();
  session.on('Runtime.executionContextCreated', ({ context: value }) => contexts.set(value.id, value));
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => contexts.delete(executionContextId));
  await session.send('Runtime.enable');
  await expect.poll(() => [...contexts.values()].filter((value) => value.origin === `chrome-extension://${extensionId}` || value.name?.includes(extensionId)).length).toBeGreaterThan(0);
  const isolated = [...contexts.values()].find((value) => (value.origin === `chrome-extension://${extensionId}` || value.name?.includes(extensionId)) && !value.auxData?.isDefault);
  expect(isolated, 'The clock must belong to the actual Helper content-script isolated world').toBeTruthy();
  const installed = await session.send('Runtime.evaluate', {
    contextId: isolated.id,
    expression: 'globalThis.__helperE2EOriginalDateNow = Date.now; Date.now = () => globalThis.__helperE2EOriginalDateNow() + 300001;',
    returnByValue: true
  });
  expect(installed.exceptionDetails).toBeUndefined();
  try {
    await action();
  } finally {
    await session.send('Runtime.evaluate', { contextId: isolated.id, expression: 'Date.now = globalThis.__helperE2EOriginalDateNow; delete globalThis.__helperE2EOriginalDateNow;' });
    await session.detach();
  }
}

async function observeNano(page) {
  await page.evaluate(() => {
    const model = globalThis.LanguageModel;
    if (typeof model?.create !== 'function') throw new Error('Nano audio inference requires a provisioned LanguageModel API.');
    const observation = window.__helperE2ENano = { placeholder: model.e2ePlaceholder === true, sessions: [], reviews: [] };
    const create = model.create;
    model.create = async function (...args) {
      const session = await create.apply(this, args);
      const record = { options: structuredClone(args[0]), prompts: [], destroyed: false };
      observation.sessions.push(record);
      const prompt = session.prompt, destroy = session.destroy;
      session.prompt = async function (...promptArgs) {
        const content = promptArgs[0].flatMap((message) => message.content ?? []);
        const call = { audio: content.filter((part) => part.type === 'audio').map((part) => ({
          type: part.value.constructor.name, duration: part.value.duration,
          sampleRate: part.value.sampleRate, frames: part.value.length
        })) };
        record.prompts.push(call);
        const result = await prompt.apply(this, promptArgs);
        call.result = structuredClone(result);
        return result;
      };
      session.destroy = function (...destroyArgs) {
        const result = destroy.apply(this, destroyArgs);
        record.destroyed = true;
        return result;
      };
      return session;
    };
    window.addEventListener('babel-helper-magnifier-request', (event) => {
      if (event.detail?.operation === 'auto-segment-redistribute-text') {
        observation.reviews.push({ id: event.detail.id, payload: structuredClone(event.detail.payload) });
      }
    });
    window.addEventListener('babel-helper-magnifier-response', (event) => {
      const review = observation.reviews.find((item) => item.id === event.detail?.id);
      if (review && event.detail.result) review.result = structuredClone(event.detail.result);
    });
  });
}

function reviewedSentenceAllocations(payload, review) {
  const sentences = (text) => [...new Intl.Segmenter('ru', { granularity: 'sentence' }).segment(text)]
    .map((part) => part.segment.trim()).filter(Boolean);
  const chunks = payload.draftAllocations.map((allocation) => sentences(allocation.text));
  for (const { fromIndex, toIndex, sentenceCount } of review.moves) {
    expect(Math.abs(fromIndex - toIndex)).toBe(1);
    expect(sentenceCount).toBeGreaterThan(0);
    const from = chunks[fromIndex - 1], to = chunks[toIndex - 1];
    expect(from.length).toBeGreaterThanOrEqual(sentenceCount);
    if (toIndex > fromIndex) to.unshift(...from.splice(from.length - sentenceCount, sentenceCount));
    else to.push(...from.splice(0, sentenceCount));
  }
  return chunks.map((chunk) => chunk.join(' '));
}

export const featureScenarios = {
  rowActions: ['Helper consumes public Gold absolute word timings on both lanes through actual Alt-clicks'],
  timelineSelection: [
    'empty segment transcribes through Helper, the authorized Gold port and multipart L0 API',
    'nonempty transcription is never sent and typing during an in-flight result wins',
    'changing the current row during inference refuses a stale segment result',
    'task navigation disconnects the old broker port and new identity can transcribe',
    'closing a requesting tab releases its real port and another tab remains usable',
    'L0 backend failure is visible, cannot silently use paid fallback, and retries via the same hotkey',
    'timing identity is refreshed after task navigation and old timestamps cannot seek the new task',
    'timing timeout reaches real broker redistribution without changing words or advancing media clocks',
    'Nano audio review consumes actual local inference through the selected Helper redistribution route',
    'empty segment reports unavailable broker without fabricating transcript or remote calls'
  ]
};

test('empty segment transcribes through Helper, the authorized Gold port and multipart L0 API', { tag: '@local-engine' }, async ({ page, babel }) => {
  const annotations = await emptyFirstRow(page, babel);
  await babel.control({ routes: { [DRAFT]: { delayMs: 700 } } });
  await invokeTranscription(page);
  await expect(page.locator(PROGRESS)).toContainText(/Transcribing current segment/);
  const call = await completedCall(babel, DRAFT);
  expect(call.method).toBe('POST');
  expect(call.body.options.preserveRows).toEqual([expect.objectContaining({ startSeconds: annotations[0].startTimeInSeconds, endSeconds: annotations[0].endTimeInSeconds, text: '' })]);
  const visibleSpeaker = await page.locator(TEXT).first().evaluate((element) => element.closest('tr').children[1].textContent.trim());
  expect([annotations[0].processedRecordingId, visibleSpeaker]).toContain(call.body.options.preserveRows[0].speakerKey);
  expect(call.body.tracks.some((track) => track.lane === call.body.options.preserveRows[0].speakerKey)).toBe(true);
  expect(call.body.tracks).toHaveLength(2);
  expect(call.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ fieldName: 'audio:1', type: 'audio/wav' }),
    expect.objectContaining({ fieldName: 'audio:2', type: 'audio/wav' })
  ]));
  expect(call.files.every((file) => file.size > 44)).toBe(true);
  expect(call.body.taskId).toContain((await babel.state()).action.actionId);
  const applied = await assertGeneratedRow(page, babel, call);
  if (applied) await expect(page.locator(PROGRESS)).toHaveCount(0);
  expect(await page.locator(TEXT).evaluateAll((elements) => elements.map((element) => element.value))).toEqual([await page.locator(TEXT).first().inputValue(), ...annotations.slice(1).map((row) => row.content)]);
  expect(await calls(babel, '/api/broker/transcribe-segment')).toEqual([]);
});

test('nonempty transcription is never sent and typing during an in-flight result wins', { tag: '@local-engine' }, async ({ page, babel }) => {
  await ready(page, babel);
  const original = await page.locator(TEXT).evaluateAll((elements) => elements.map((element) => element.value));
  await invokeTranscription(page);
  expect(await calls(babel, DRAFT)).toEqual([]);
  expect(await page.locator(TEXT).evaluateAll((elements) => elements.map((element) => element.value))).toEqual(original);
  const annotations = await emptyFirstRow(page, babel);
  await babel.control({ routes: { [DRAFT]: { delayMs: 1800 } } });
  await invokeTranscription(page);
  await expect.poll(async () => (await calls(babel, DRAFT)).length).toBe(1);
  const typed = 'Пользователь успел ввести собственный текст.';
  await page.locator(TEXT).first().fill(typed);
  await completedCall(babel, DRAFT);
  await expect(page.locator(PROGRESS)).toContainText(/no.longer.empty|failed|не|segment/i);
  await expect(page.locator(TEXT).first()).toHaveValue(typed);
  expect(await page.locator(TEXT).evaluateAll((elements) => elements.map((element) => element.value))).toEqual([typed, ...annotations.slice(1).map((row) => row.content)]);
});

test('changing the current row during inference refuses a stale segment result', { tag: '@local-engine' }, async ({ page, babel }) => {
  const annotations = await emptyFirstRow(page, babel);
  await babel.control({ routes: { [DRAFT]: { delayMs: 1800 } } });
  await invokeTranscription(page);
  await expect.poll(async () => (await calls(babel, DRAFT)).length).toBe(1);
  await page.locator(TEXT).nth(1).click();
  await completedCall(babel, DRAFT);
  await expect(page.locator(PROGRESS)).toContainText(/no.longer.current|failed|segment/i);
  await expect(page.locator(TEXT).first()).toHaveValue('');
  await expect(page.locator(TEXT).nth(1)).toHaveValue(annotations[1].content);
});

test('task navigation disconnects the old broker port and new identity can transcribe', { tag: '@local-engine' }, async ({ page, babel }) => {
  await emptyFirstRow(page, babel);
  await babel.control({ routes: { [DRAFT]: { delayMs: 1800 } } });
  await invokeTranscription(page);
  await expect.poll(async () => (await calls(babel, DRAFT)).length).toBe(1);
  const oldTaskId = (await calls(babel, DRAFT))[0].body.taskId;
  const { action } = await babel.state();
  const nextId = '55555555-5555-4555-8555-555555555555';
  const annotations = action.annotations.map((row) => ({ ...row, reviewActionId: nextId, id: `next-${row.id}` }));
  await babel.reset('baseline', { audio: babel.ai !== 'placeholder' && babel.hasSpeechFixtures ? { fixture: 'speech' } : {}, action: { actionId: nextId, reviewActionId: nextId, annotations } });
  await ready(page, babel);
  await expect(page.locator(TEXT).first()).toHaveValue('');
  await invokeTranscription(page);
  const next = await completedCall(babel, DRAFT);
  expect(next.body.taskId).toContain(nextId);
  expect(next.body.taskId).not.toBe(oldTaskId);
  expect(next.body.options.preserveRows).toEqual([expect.objectContaining({ startSeconds: annotations[0].startTimeInSeconds, endSeconds: annotations[0].endTimeInSeconds, text: '' })]);
  const visibleSpeaker = await page.locator(TEXT).first().evaluate((element) => element.closest('tr').children[1].textContent.trim());
  expect([annotations[0].processedRecordingId, visibleSpeaker]).toContain(next.body.options.preserveRows[0].speakerKey);
  await assertGeneratedRow(page, babel, next);
  expect(await page.locator(TEXT).evaluateAll((elements) => elements.map((element) => element.value))).toEqual([await page.locator(TEXT).first().inputValue(), ...annotations.slice(1).map((row) => row.content)]);
});

test('closing a requesting tab releases its real port and another tab remains usable', { tag: '@local-engine' }, async ({ page, context, babel }) => {
  await emptyFirstRow(page, babel);
  await babel.control({ routes: { [DRAFT]: { delayMs: 1800, times: 1 } } });
  const second = await context.newPage();
  await second.goto(page.url());
  await ready(second, babel);
  await invokeTranscription(second);
  await expect.poll(async () => (await calls(babel, DRAFT)).length).toBe(1);
  await second.close();
  await page.bringToFront();
  await expect(page.locator(TEXT).first()).toHaveValue('');
  await invokeTranscription(page);
  await expect.poll(async () => (await calls(babel, DRAFT)).length).toBe(2);
  await expect.poll(async () => (await calls(babel, DRAFT)).at(-1).outcome, { timeout: 120000 }).not.toBe('pending');
  await assertGeneratedRow(page, babel, (await calls(babel, DRAFT)).at(-1));
});

test('L0 backend failure is visible, cannot silently use paid fallback, and retries via the same hotkey', { tag: '@local-engine' }, async ({ page, babel }) => {
  await emptyFirstRow(page, babel);
  await babel.control({ routes: { [DRAFT]: { error: { status: 503, message: 'E2E L0 engine unavailable' }, times: 1 } } });
  await invokeTranscription(page);
  await expect(page.locator(PROGRESS)).toContainText(/unavailable|503|failed/i);
  await expect(page.locator(TEXT).first()).toHaveValue('');
  expect(await calls(babel, '/api/broker/transcribe-segment')).toEqual([]);
  await invokeTranscription(page);
  const call = await completedCall(babel, DRAFT, 2);
  await assertGeneratedRow(page, babel, call);
});

test('Helper consumes public Gold absolute word timings on both lanes through actual Alt-clicks', { tag: '@local-engine' }, async ({ page, babel }) => {
  await captureTiming(page);
  const fixture = await babel.reset('baseline', { audio: babel.ai !== 'placeholder' && babel.hasSpeechFixtures ? { fixture: 'speech' } : {} });
  await ready(page, babel);
  await expect.poll(() => page.evaluate(() => window.__helperE2ETiming.length), { timeout: 120000 }).toBeGreaterThan(0);
  const timing = await page.evaluate(() => window.__helperE2ETiming.at(-1));
  expect(timing.taskId).toContain((await babel.state()).action.actionId);
  expect(timing.tracks).toHaveLength(2);
  const visibleSpeakers = await page.locator('tbody tr').evaluateAll((rows) => rows.filter((row) => row.querySelector('textarea[placeholder="What was said…"]')).map((row) => row.children[1].textContent.trim()));
  for (const [laneIndex, track] of timing.tracks.entries()) {
    const rowIndex = fixture.action.annotations.findIndex((row, index) => row.processedRecordingId === track.lane || visibleSpeakers[index] === track.lane);
    expect(rowIndex, `Timing lane ${track.lane} must belong to a current native annotation`).toBeGreaterThanOrEqual(0);
    const row = fixture.action.annotations[rowIndex];
    const tokens = track.tokens.filter((token) => token.startSeconds >= row.startTimeInSeconds && token.endSeconds <= row.endTimeInSeconds);
    if (babel.ai === 'placeholder' || babel.hasSpeechFixtures) expect(tokens.length, 'Speech-success timing must cover the exercised interval').toBeGreaterThanOrEqual(2);
    if (!tokens.length) {
      const editor = page.locator(TEXT).nth(rowIndex);
      const original = await editor.inputValue();
      const before = await page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks[0].currentTime);
      await editor.click({ modifiers: ['Alt'], position: { x: 10, y: 10 } });
      await expect(editor).toHaveValue(original);
      expect(await page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks[0].currentTime)).toBe(before);
      test.info().annotations.push({ type: 'model-observation', description: `Real inference returned no words in lane ${laneIndex + 1}; Alt-click safely declined seeking.` });
      continue;
    }
    for (let index = 0; index < tokens.length; index++) {
      expect(Number.isFinite(tokens[index].startSeconds)).toBe(true);
      expect(tokens[index].endSeconds).toBeGreaterThan(tokens[index].startSeconds);
      if (index) expect(tokens[index].startSeconds).toBeGreaterThanOrEqual(tokens[index - 1].startSeconds);
    }
    const editor = page.locator(TEXT).nth(rowIndex);
    const text = tokens.map((token) => token.text).join(' ');
    await editor.fill(text);
    const targetIndex = tokens.findIndex((token) => /^[\p{L}\p{N}]+[.,!?]?$/u.test(token.text));
    expect(targetIndex, 'Alt-click must target a spoken word, not the inference marker tag').toBeGreaterThanOrEqual(0);
    const offset = tokens.slice(0, targetIndex).reduce((length, token) => length + token.text.length + 1, 0);
    const point = await editor.evaluate((element, offset) => {
      const style = getComputedStyle(element);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = style.font;
      const box = element.getBoundingClientRect();
      return { x: box.x + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft) + context.measureText(element.value.slice(0, offset)).width + 2,
        y: box.y + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) + (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2) / 2 };
    }, offset);
    await page.keyboard.down('Alt');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Alt');
    await expect(editor).toBeFocused();
    const caret = await editor.evaluate((element) => element.selectionStart);
    expect(caret).toBeGreaterThanOrEqual(offset);
    expect(caret).toBeLessThanOrEqual(offset + tokens[targetIndex].text.length);
    await expect.poll(() => page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks[0].currentTime)).toBeCloseTo(tokens[targetIndex].startSeconds, 1);
    await expect(editor).toHaveValue(text);
  }
  expect(await calls(babel, DRAFT)).toEqual([]);
});

test('timing identity is refreshed after task navigation and old timestamps cannot seek the new task', { tag: '@local-engine' }, async ({ page, babel }) => {
  await captureTiming(page);
  await babel.reset('baseline', { audio: babel.ai !== 'placeholder' && babel.hasSpeechFixtures ? { fixture: 'speech' } : {} });
  await ready(page, babel);
  await expect.poll(() => page.evaluate(() => window.__helperE2ETiming.length), { timeout: 120000 }).toBeGreaterThan(0);
  const previous = await page.evaluate(() => window.__helperE2ETiming.at(-1).taskId);
  const { action } = await babel.state();
  const nextId = '66666666-6666-4666-8666-666666666666';
  await babel.reset('baseline', { audio: babel.ai !== 'placeholder' && babel.hasSpeechFixtures ? { fixture: 'speech' } : {}, action: { actionId: nextId, reviewActionId: nextId, annotations: action.annotations.map((row) => ({ ...row, reviewActionId: nextId })) }, controls: { routes: { [TIMING]: { delayMs: 1800 } } } });
  await ready(page, babel);
  await expect(page.locator(TEXT).first()).toHaveValue(action.annotations[0].content);
  await expect.poll(async () => (await calls(babel, TIMING)).length).toBe(1);
  const before = await page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks[0].currentTime);
  await page.locator(TEXT).first().click({ modifiers: ['Alt'], position: { x: 10, y: 10 } });
  expect(await page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks[0].currentTime)).toBe(before);
  await expect.poll(() => page.evaluate(() => window.__helperE2ETiming.length), { timeout: 120000 }).toBeGreaterThan(0);
  const next = await page.evaluate(() => window.__helperE2ETiming.at(-1));
  expect(next.taskId).toContain(nextId);
  expect(next.taskId).not.toBe(previous);
  await page.locator('#babel-gold-drafting-magic-button').hover();
  await expect(page.locator('.bgd-timing-hover-panel')).toHaveAttribute('data-task-id', next.taskId);
});

test('timing timeout reaches real broker redistribution without changing words or advancing media clocks', async ({ page, context, babel }) => {
  const { action } = await babel.state();
  const lane = action.annotations.filter((row) => row.processedRecordingId === 'speaker-1');
  const others = action.annotations.filter((row) => row.processedRecordingId !== 'speaker-1');
  const fullText = lane.map((row) => row.content).join(' ');
  await babel.setExtensionSettings('gold', { aiBrokerProvider: 'remote-openrouter', localModelsEnabled: false });
  await babel.reset('baseline', {
    action: { annotations: [{ ...lane[0], startTimeInSeconds: 0, endTimeInSeconds: 5.2, content: fullText }, ...others] },
    audio: { voicedWindows: { 'speaker-1': [[0.6, 2], [3.5, 4.9]] } },
    controls: { routes: { [TIMING]: { error: { status: 503, message: 'E2E timing unavailable for timeout transition' } } } }
  });
  await ready(page, babel, 3);
  await page.locator(ZOOM).focus();
  await page.keyboard.press('Home');
  await page.locator(TEXT).first().click();
  await page.keyboard.press('Alt+Shift+KeyS');
  await expect(page.locator(PROGRESS)).toContainText('Waiting for background word timing (0s)');
  const mediaBefore = await page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks.map((track) => track.currentTime));
  await withHelperTimeoutClock(context, page, babel.extensionIds.helper, async () => {
    await expect.poll(async () => (await calls(babel, REDISTRIBUTE)).length, { timeout: 30000 }).toBe(1);
  });
  await expect(page.locator(TEXT)).toHaveCount(4);
  await expect(page.locator(PROGRESS)).toHaveCount(0, { timeout: 120000 });
  const call = (await calls(babel, REDISTRIBUTE))[0];
  expect(call.body.groups.some((group) => group.fullText === fullText)).toBe(true);
  if (babel.ai === 'local') {
    expect(call.outcome).toBe('error');
    expect(call.error.message).toMatch(/local L0 does not support broker-redistribute/i);
  } else {
    expect(call.response.results.every((result) => result.ok)).toBe(true);
    if (babel.ai === 'placeholder') expect(call.response.model).toBe('e2e-placeholder-v1');
    else expect(call.response.model).not.toBe('e2e-placeholder-v1');
  }
  await expect.poll(async () => (await page.locator(TEXT).evaluateAll((elements) => elements.map((element) => element.value))).slice(0, 2).join(' ').replace(/\s+/g, ' ').trim()).toBe(fullText);
  const mediaAfter = await page.evaluate(() => window.__BABEL_E2E__.snapshot().audio.tracks.map((track) => track.currentTime));
  expect(mediaAfter).toEqual(mediaBefore);
});

test('Nano audio review consumes actual local inference through the selected Helper redistribution route', { tag: '@nano' }, async ({ page, context, babel }) => {
  test.setTimeout(360000);
  if (babel.nano === 'real') expect(babel.hasSpeechFixtures, '--nano=real requires explicitly provisioned speech fixtures').toBe(true);
  const options = await babel.options('gold');
  await options.locator('#aiBrokerProvider').selectOption('local-gemini-nano');
  await options.locator('[data-role="save"]').click();
  await expect(options.locator('[data-role="status"]')).toContainText('Saved.');
  await options.close();
  const fixture = await babel.reset('baseline', {
    audio: babel.nano === 'real' ? { fixture: 'speech' } : {},
    controls: { routes: { [TIMING]: { error: { status: 503, message: 'E2E timing unavailable: exercising selected Nano audio review' } } } }
  });
  const speaker = fixture.action.annotations[0].processedRecordingId;
  const lane = fixture.action.annotations.filter((row) => row.processedRecordingId === speaker);
  const others = fixture.action.annotations.filter((row) => row.processedRecordingId !== speaker);
  const fullText = lane.map((row) => row.content).join(' ');
  await babel.reset('baseline', {
    action: { annotations: [{ ...lane[0], startTimeInSeconds: Math.min(...lane.map((row) => row.startTimeInSeconds)), endTimeInSeconds: Math.max(...lane.map((row) => row.endTimeInSeconds)), content: fullText }, ...others] },
    audio: babel.nano === 'real' ? { fixture: 'speech' } : {},
    controls: { routes: { [TIMING]: { error: { status: 503, message: 'E2E timing unavailable: exercising selected Nano audio review' } } } }
  });
  await ready(page, babel);
  await observeNano(page);
  await page.locator(TEXT).first().click();
  await page.keyboard.press('Alt+Shift+KeyS');
  await expect(page.locator(PROGRESS)).toContainText('Waiting for background word timing (0s)');
  await withHelperTimeoutClock(context, page, babel.extensionIds.helper, async () => {
    await expect.poll(() => page.evaluate(() => window.__helperE2ENano.reviews.length), { timeout: 30000 }).toBeGreaterThan(0);
  });
  await expect(page.locator(PROGRESS)).toHaveCount(0, { timeout: 300000 });
  const inference = await page.evaluate(() => window.__helperE2ENano);
  expect(inference.placeholder).toBe(babel.nano === 'placeholder');
  expect(inference.sessions.length).toBeGreaterThan(0);
  for (const session of inference.sessions) {
    expect(session.options.expectedInputs).toEqual([{ type: 'text', languages: ['en'] }, { type: 'audio' }]);
    expect(session.options.expectedOutputs).toEqual([{ type: 'text', languages: ['en'] }]);
    expect(session.destroyed).toBe(true);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0].audio.length).toBeGreaterThan(0);
    for (const audio of session.prompts[0].audio) {
      expect(audio.type).toBe('AudioBuffer');
      expect(audio.duration).toBeGreaterThan(0);
      expect(audio.frames).toBeGreaterThan(0);
      expect(audio.sampleRate).toBeGreaterThan(0);
    }
    const result = typeof session.prompts[0].result === 'string' ? JSON.parse(session.prompts[0].result) : session.prompts[0].result;
    expect(typeof result.acceptDraft).toBe('boolean');
    expect(Array.isArray(result.moves)).toBe(true);
    if (babel.nano === 'placeholder') expect(result.notes).toContain('[E2E placeholder]');
    else expect(result.notes ?? '').not.toContain('[E2E placeholder]');
  }
  expect(inference.reviews.some(({ payload, result }) => payload.segments.length > 1 && result?.ok)).toBe(true);
  let observedMove = false;
  for (const { payload, result } of inference.reviews) {
    let expected;
    if (payload.segments.length === 1) {
      expect(result).toMatchObject({ ok: false, reason: 'invalid-group' });
      expected = payload.draftAllocations.map((allocation) => allocation.text);
    } else {
      expect(result.ok).toBe(true);
      expect(result.audioSampleCount).toBeGreaterThan(0);
      expected = reviewedSentenceAllocations(payload, result.review);
    }
    expect(expected.join(' ').replace(/\s+/g, ' ').trim()).toBe(payload.fullText.replace(/\s+/g, ' ').trim());
    if (result.ok && result.review.moves.length) {
      observedMove = true;
      expect(expected).not.toEqual(payload.draftAllocations.map((allocation) => allocation.text));
    }
    await expect.poll(() => page.locator(TEXT).evaluateAll((elements, segments) => {
      const seconds = (text) => text.match(/\d+(?::\d+)+(?:\.\d+)?/)[0].split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
      return segments.map((segment) => {
        const editor = elements.find((element) => {
          const row = element.closest('tr');
          return row.children[1].textContent.trim() === segment.speakerKey &&
            Math.abs(seconds(row.children[2].textContent) - segment.startSeconds) < 0.02 &&
            Math.abs(seconds(row.children[3].textContent) - segment.endSeconds) < 0.02;
        });
        return editor?.value;
      });
    }, payload.segments)).toEqual(expected);
  }
  if (babel.nano === 'placeholder') expect(observedMove, 'Marked Nano inference must change an allocation so ignoring its result cannot pass').toBe(true);
  const state = await babel.state();
  expect(state.calls.filter((call) => call.path.startsWith('/api/broker/') || call.path.startsWith('/api/draft/'))).toEqual([]);
  const upstream = state.calls.filter((call) => call.path.startsWith('/v1/') &&
    !(call.method === 'GET' && /^\/v1\/queue\/[^/]+$/.test(call.path)));
  expect(upstream.length).toBeGreaterThan(0);
  for (const call of upstream) {
    expect(call.path).toBe(TIMING);
    expect(call.outcome).toBe('error');
    expect(call.error.message).toContain('exercising selected Nano audio review');
    expect(call.response).toBeUndefined();
  }
  await test.info().attach('nano-audio-review', { body: JSON.stringify(inference, null, 2), contentType: 'application/json' });
});

test.describe('Helper without Gold', () => {
  test.use({ extensions: ['helper'] });
  test('empty segment reports unavailable broker without fabricating transcript or remote calls', async ({ page, babel }) => {
    const { action } = await babel.state();
    await babel.reset('baseline', { action: { annotations: action.annotations.map((row, index) => index ? row : { ...row, content: '' }) } });
    await expect(page.locator(TEXT)).toHaveCount(4);
    await invokeTranscription(page);
    await expect(page.locator(PROGRESS)).toContainText(/unavailable|not.installed|failed|receiving end|connect/i, { timeout: 15000 });
    await expect(page.locator(TEXT).first()).toHaveValue('');
    expect((await babel.state()).calls.filter((call) => call.path.startsWith('/v1/') || call.path.startsWith('/api/broker/'))).toEqual([]);
  });
});
