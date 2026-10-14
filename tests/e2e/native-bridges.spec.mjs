import { test, expect } from '@nominy/babel-extension-e2e/test';
import { ready, rows, readText, textSelection, saved, history, fillText, editText } from '@nominy/babel-extension-e2e/native-helpers';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test.use({ extensions: ['helper'] });

async function loadBridge(page, babel, name, globalName) {
  if (!await page.evaluate(name => Boolean(window[name]), globalName)) {
    await page.addScriptTag({ url: `chrome-extension://${babel.extensionIds.helper}/dist/content/${name}-bridge.js` });
  }
  await expect.poll(() => page.evaluate(name => Boolean(window[name]), globalName)).toBe(true);
}

async function timestamp(page, method, payload = {}) {
  return page.evaluate(({ method, payload }) => window.__babelHelperTimestampBridge[method](payload), { method, payload });
}

async function control(row, request) {
  return row.evaluate((element, request) => {
    const id = crypto.randomUUID();
    element.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
      bubbles: true, detail: JSON.stringify({ id, annotationId: element.dataset.annotationId, ...request })
    }));
    const response = JSON.parse(element.getAttribute('data-babel-helper-editor-result'));
    element.removeAttribute('data-babel-helper-editor-result');
    if (response.id !== id) throw new Error('Native editor bridge did not answer this request');
    return response;
  }, request);
}

const nativeAnnotations = page => page.evaluate(() => window.__BABEL_E2E__.snapshot().annotations);
const byId = annotations => annotations.slice().sort((a, b) => a.id.localeCompare(b.id));

test('native session status supports empty writable and feedback tasks and fails closed without a workbench', async ({ page, babel }) => {
  const session = () => page.evaluate(() => {
    const root = document.documentElement;
    const id = crypto.randomUUID();
    root.removeAttribute('data-babel-helper-editor-result');
    root.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
      bubbles: true, detail: JSON.stringify({ id, operation: 'session' })
    }));
    const result = JSON.parse(root.getAttribute('data-babel-helper-editor-result'));
    root.removeAttribute('data-babel-helper-editor-result');
    if (result?.id !== id) throw new Error('Native session bridge did not answer this request');
    return result;
  });
  const empty = await babel.reset('baseline', { action: { annotations: [] } });
  await expect(page.getByText('No segments yet. Drag on a waveform to add one.', { exact: true })).toBeVisible();
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  expect(await session()).toMatchObject({ ok: true, reviewActionId: empty.action.reviewActionId, readOnly: false });
  await expect(rows(page)).toHaveCount(0);

  const review = await babel.reset('review');
  const feedbackURL = new URL(page.url());
  feedbackURL.searchParams.set('displayFeedback', 'true');
  await page.goto(feedbackURL.href);
  await expect(page.locator('[data-transcript-scroll]')).toBeVisible();
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  const reviewAnnotations = await nativeAnnotations(page);
  expect(await session()).toMatchObject({ ok: true, reviewActionId: review.action.reviewActionId,
    readOnly: false, routeKey: feedbackURL.pathname + feedbackURL.search });
  expect(await nativeAnnotations(page)).toEqual(reviewAnnotations);

  const readonly = await babel.reset('readonly');
  await expect(page.locator('[data-transcript-scroll]')).toBeVisible();
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  const readonlyAnnotations = await nativeAnnotations(page);
  expect(await session()).toMatchObject({ ok: true, reviewActionId: readonly.action.reviewActionId, readOnly: true });
  expect(await nativeAnnotations(page)).toEqual(readonlyAnnotations);

  await page.goto(`${babel.baseURL}/projects`);
  await expect(page.getByRole('link', { name: /RU-tx-gold/ })).toBeVisible();
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  expect(await session()).toMatchObject({ ok: false, reviewActionId: '', readOnly: true, routeKey: '/projects' });
});

let nativeRuntimeBundle;
async function installNativeWaveReader(page) {
  nativeRuntimeBundle ??= build({
    entryPoints: [fileURLToPath(import.meta.resolve('@nominy/babel-babel-runtime'))],
    bundle: true, write: false, format: 'iife', globalName: 'BabelBridgeTestRuntime',
  }).then(result => result.outputFiles[0].text);
  await page.addScriptTag({ content: await nativeRuntimeBundle });
}

async function expectNativeRegions(page, annotations) {
  const expected = byId(annotations).map(annotation => ({
    id: annotation.id, processedRecordingId: annotation.processedRecordingId,
    start: annotation.startTimeInSeconds, end: annotation.endTimeInSeconds,
    trackId: annotation.processedRecordingId, label: annotation.content ?? '',
  }));
  await expect.poll(() => page.evaluate(() => {
    const bindings = window.BabelBridgeTestRuntime.readBabelPlaybackBindings();
    if (!bindings?.waves.length) throw new Error('Native WaveSurfer bindings are unavailable');
    const data = new Map(bindings.waves.flatMap(wave => wave.getActivePlugins()
      .filter(plugin => typeof plugin.getRegions === 'function')
      .flatMap(plugin => plugin.getRegions().map(region => [region.id, region.data]))));
    // The registry is authoritative even when virtualAppend detaches offscreen
    // elements. Track IDs come from the actual native track-ref, not DOM order.
    return window.__BABEL_E2E__.snapshot().audio.tracks.flatMap(track => track.regions.map(region => ({
      ...region, processedRecordingId: track.id, trackId: data.get(region.id)?.trackId,
      label: data.get(region.id)?.label,
    }))).sort((a, b) => a.id.localeCompare(b.id));
  })).toEqual(expected);
}

async function revealNativeRegion(page, annotation) {
  await page.evaluate(annotation => {
    const waves = window.BabelBridgeTestRuntime.readBabelPlaybackBindings()?.waves ?? [];
    const wave = waves.find(wave => wave.getActivePlugins().some(plugin =>
      typeof plugin.getRegions === 'function' && plugin.getRegions().some(region => region.id === annotation.id)));
    if (!wave) throw new Error(`Missing native region: ${annotation.id}`);
    wave.setScrollTime(annotation.startTimeInSeconds);
  }, annotation);
  await expect(page.locator(`[part~="region"][part~="${annotation.id}"]`)).toHaveCount(1);
}


test('timestamp commands preserve empty lanes and restore exact native annotations with undo', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'timestamp', '__babelHelperTimestampBridge');
  await installNativeWaveReader(page);
  const original = await nativeAnnotations(page);
  const before = await timestamp(page, 'snapshotTranscript');
  await expectNativeRegions(page, original);
  let revision = before.historyRevision;
  let token = before.historyToken;
  for (const annotation of original) {
    const result = await timestamp(page, 'deleteSegment', { annotationId: annotation.id,
      expectedReviewActionId: before.reviewActionId, expectedHistoryRevision: revision, expectedHistoryToken: token });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.previousHistoryRevision).toBe(revision);
    revision = result.historyRevision;
    token = result.historyToken;
    await expectNativeRegions(page, original.slice(revision - before.historyRevision));
  }
  await expect(rows(page)).toHaveCount(0);
  const empty = await timestamp(page, 'snapshotTranscript');
  expect(empty.rows).toEqual([]);
  expect(empty.lanes).toEqual(before.lanes);
  const created = await timestamp(page, 'createSegment', { annotationId: 'helper-native-empty-lane',
    processedRecordingId: before.lanes[1].processedRecordingId, startSeconds: 1, endSeconds: 2,
    text: 'Новая реплика.', expectedReviewActionId: before.reviewActionId, expectedHistoryRevision: revision, expectedHistoryToken: token });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('[part~="region"][part~="helper-native-empty-lane"]')).toHaveCount(1);
  await expectNativeRegions(page, [{ id: created.annotationId, processedRecordingId: created.processedRecordingId,
    startTimeInSeconds: 1, endTimeInSeconds: 2, content: 'Новая реплика.' }]);
  revision = created.historyRevision;
  token = created.historyToken;
  while (revision > before.historyRevision) {
    const result = await timestamp(page, 'undoTranscript', { expectedReviewActionId: before.reviewActionId,
      expectedHistoryRevision: revision, expectedHistoryToken: token });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.historyRevision).toBe(revision - 1);
    revision = result.historyRevision;
    token = result.historyToken;
    const restored = original.slice(revision - before.historyRevision);
    expect(byId(await nativeAnnotations(page))).toEqual(byId(restored));
    await expectNativeRegions(page, restored);
  }
  expect(token).toBe(before.historyToken);
  await expect(rows(page)).toHaveCount(original.length);
  expect(byId(await nativeAnnotations(page))).toEqual(byId(original));
  for (const annotation of original) await revealNativeRegion(page, annotation);
});

test('native undo restores an offscreen region before native scrolling materializes its element', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'timestamp', '__babelHelperTimestampBridge');
  await installNativeWaveReader(page);
  const original = await nativeAnnotations(page);
  const target = original.reduce((latest, annotation) =>
    annotation.startTimeInSeconds > latest.startTimeInSeconds ? annotation : latest);
  await expectNativeRegions(page, original);
  await page.evaluate(annotation => {
    const waves = window.BabelBridgeTestRuntime.readBabelPlaybackBindings().waves;
    const wave = waves.find(wave => wave.getActivePlugins().some(plugin =>
      typeof plugin.getRegions === 'function' && plugin.getRegions().some(region => region.id === annotation.id)));
    // Place the real region beyond the viewport, independent of viewport size.
    wave.zoom((wave.getWidth() + 200) / annotation.startTimeInSeconds);
    wave.setScrollTime(0);
  }, target);
  const region = page.locator(`[part~="region"][part~="${target.id}"]`);
  await expect(region).toHaveCount(0);
  await expectNativeRegions(page, original);
  const before = await timestamp(page, 'snapshotTranscript');
  const removed = await timestamp(page, 'deleteSegment', { annotationId: target.id,
    expectedReviewActionId: before.reviewActionId, expectedHistoryRevision: before.historyRevision,
    expectedHistoryToken: before.historyToken });
  expect(removed.ok, JSON.stringify(removed)).toBe(true);
  await expectNativeRegions(page, original.filter(annotation => annotation.id !== target.id));
  const undone = await timestamp(page, 'undoTranscript', { expectedReviewActionId: before.reviewActionId,
    expectedHistoryRevision: removed.historyRevision, expectedHistoryToken: removed.historyToken });
  expect(undone.ok, JSON.stringify(undone)).toBe(true);
  expect(undone.historyToken).toBe(before.historyToken);
  expect(byId(await nativeAnnotations(page))).toEqual(byId(original));
  await expectNativeRegions(page, original);
  await expect(region).toHaveCount(0);
  await revealNativeRegion(page, target);
  await expectNativeRegions(page, original);
  expect(byId(await nativeAnnotations(page))).toEqual(byId(original));
});

test('native merge flushes pending Slate edits and saves the actual merged text', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'timestamp', '__babelHelperTimestampBridge');
  const before = await timestamp(page, 'snapshotTranscript');
  const first = before.rows[0];
  const adjacent = before.rows.find(row => row.processedRecordingId === first.processedRecordingId && row.annotationId !== first.annotationId);
  expect(adjacent).toBeTruthy();
  const row = page.locator(`section[data-annotation-id="${first.annotationId}"]`);
  await row.getByRole('textbox', { name: 'Edit turn text' }).click();
  const editor = row.locator('[data-slate-editor="true"]');
  await expect(editor).toBeVisible();
  await fillText(editor, 'Не потерять новый текст.');
  // Do not blur or wait for the native400ms debounce: the command must flush it.
  const merged = await timestamp(page, 'mergeSegment', { annotationId: first.annotationId, direction: 'below',
    reviewActionId: before.reviewActionId });
  expect(merged.ok, JSON.stringify(merged)).toBe(true);
  const expected = `Не потерять новый текст. ${adjacent.text}`;
  await expect.poll(async () => (await nativeAnnotations(page)).find(turn => turn.id === first.annotationId)?.content).toBe(expected);
  await expect(rows(page)).toHaveCount(before.rows.length - 1);
  const state = await saved(page, babel);
  expect(state.action.annotations.find(turn => turn.id === first.annotationId).content).toBe(expected);
  const undone = await timestamp(page, 'undoTranscript', { expectedReviewActionId: before.reviewActionId,
    expectedHistoryRevision: merged.historyRevision, expectedHistoryToken: merged.historyToken });
  expect(undone.ok).toBe(true);
  expect((await nativeAnnotations(page)).find(turn => turn.id === first.annotationId).content).toBe('Не потерять новый текст.');
  expect((await nativeAnnotations(page)).find(turn => turn.id === adjacent.annotationId).content).toBe(adjacent.text);
});

test('raw-tag replacements preserve native Slate selection and local undo', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  const row = rows(page).first();
  const raw = 'Раз [неразборчиво] два.';
  const start = raw.indexOf('два');
  const replaced = await control(row, { operation: 'replace', text: raw, start, end: start + 3, direction: 'backward', focus: true });
  expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
  const editor = row.locator('[data-slate-editor="true"]');
  await expect(editor).toBeVisible();
  await expect.poll(() => readText(editor)).toBe(raw);
  await expect.poll(() => textSelection(editor)).toEqual([start, start + 3]);
  const next = 'Другой [неразборчиво] текст.';
  const activeReplacement = await control(row, { operation: 'replace', text: next, start: next.length, end: next.length, focus: true });
  expect(activeReplacement.ok).toBe(true);
  await expect.poll(() => readText(editor)).toBe(next);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => readText(editor)).toBe(raw);
  await editor.press('Enter');
  const state = await saved(page, babel);
  expect(state.action.annotations.find(turn => turn.id === replaced.annotationId).content).toBe(raw);
});

test('editor bridge reads live browser selection before deferred Slate selectionchange', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  const row = rows(page).first();
  await row.getByRole('textbox', { name: 'Edit turn text' }).click();
  await fillText(row.locator('[data-slate-editor="true"]'), 'У меня пять книг.');
  await row.locator('[data-slate-editor="true"]').press('Enter');
  await row.getByRole('textbox', { name: 'Edit turn text' }).focus();
  await expect(row.locator('[data-slate-editor="true"]')).toBeVisible();
  const before = await control(row, { operation: 'read' });
  expect(before.start).toBe(before.end);
  const selected = await row.evaluate(element => {
    const editor = element.querySelector('[data-slate-editor="true"]');
    const strings = [...editor.querySelectorAll('[data-slate-string]')].map(span => span.firstChild);
    const point = wanted => {
      for (const node of strings) {
        if (wanted <= node.length) return [node, wanted];
        wanted -= node.length;
      }
      throw new Error('Expected real native text nodes for the selection');
    };
    const [anchor, anchorOffset] = point(7);
    const [focus, focusOffset] = point(11);
    window.getSelection().setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    // Stay in this browser turn; Slate has not received selectionchange yet.
    const id = crypto.randomUUID();
    element.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
      bubbles: true, detail: JSON.stringify({ id, annotationId: element.dataset.annotationId, operation: 'read' })
    }));
    const result = JSON.parse(element.getAttribute('data-babel-helper-editor-result'));
    element.removeAttribute('data-babel-helper-editor-result');
    if (result.id !== id) throw new Error('Missing synchronous native control result');
    return result;
  });
  expect(selected).toMatchObject({ ok: true, text: 'У меня пять книг.', start: 7, end: 11, direction: 'forward' });
});

test('syncSelection preserves fast modifier selection without text, focus or undo changes', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  const row = rows(page).first();
  expect((await control(row, { operation: 'syncSelection' })).ok).toBe(true);
  await expect(row.locator('[data-slate-editor="true"]')).toHaveCount(0);
  await row.getByRole('textbox', { name: 'Edit turn text' }).click();
  await fillText(row.locator('[data-slate-editor="true"]'), 'Число 42 сегодня.');
  await row.locator('[data-slate-editor="true"]').press('Enter');
  await row.getByRole('textbox', { name: 'Edit turn text' }).focus();
  const editable = row.locator('[data-slate-editor="true"]');
  await expect(editable).toBeVisible();
  expect((await control(row, { operation: 'syncSelection', source: 'intent' })).ok).toBe(true);
  const synchronized = await row.evaluate(element => {
    const editable = element.querySelector('[data-slate-editor="true"]');
    const key = Object.getOwnPropertyNames(editable).find(key => key.startsWith('__reactFiber$'));
    let fiber = key && editable[key], editor = null;
    while (fiber && !editor) {
      const candidate = fiber.memoizedProps?.editor;
      if (candidate && typeof candidate.apply === 'function' && typeof candidate.insertData === 'function') editor = candidate;
      fiber = fiber.return;
    }
    if (!editor) throw new Error('Missing actual native Slate editor');
    const point = wanted => {
      for (const span of editable.querySelectorAll('[data-slate-string]')) {
        const node = span.firstChild;
        if (wanted <= node.length) return [node, wanted];
        wanted -= node.length;
      }
      throw new Error('Native text offset not found');
    };
    const [anchor, anchorOffset] = point(6), [focus, focusOffset] = point(8);
    window.getSelection().setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    const focused = document.activeElement;
    const undoCount = editor.history.undos.length;
    const counts = [editor.operations.length];
    const results = [];
    for (let index = 0; index < 2; index += 1) {
      const id = crypto.randomUUID();
      element.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
        bubbles: true, detail: JSON.stringify({ id, annotationId: element.dataset.annotationId, operation: 'syncSelection' })
      }));
      results.push(JSON.parse(element.getAttribute('data-babel-helper-editor-result')));
      element.removeAttribute('data-babel-helper-editor-result');
      counts.push(editor.operations.length);
    }
    return { results, firstOperations: counts[1] - counts[0], repeatedOperations: counts[2] - counts[1],
      undoChanged: editor.history.undos.length !== undoCount, focusChanged: document.activeElement !== focused };
  });
  for (const result of synchronized.results) expect(result).toMatchObject({ ok: true, start: 6, end: 8, text: 'Число 42 сегодня.' });
  expect(synchronized).toMatchObject({ firstOperations: 1, repeatedOperations: 0, undoChanged: false, focusChanged: false });
  await page.keyboard.down('Alt');
  await expect.poll(() => textSelection(editable)).toEqual([6, 8]);
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Alt');
  await expect.poll(() => readText(editable)).toBe('Число 42 {СКАЗ: сорок два} сегодня.');
});

test('passive DOM selection acknowledges native commands without overwriting their pending range', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  const row = rows(page).first();
  await row.getByRole('textbox', { name: 'Edit turn text' }).click();
  await expect(row.locator('[data-slate-editor="true"]')).toBeFocused();
  const annotations = await nativeAnnotations(page);
  const result = await row.evaluate(element => {
    const editable = element.querySelector('[data-slate-editor="true"]');
    const key = Object.getOwnPropertyNames(editable).find(key => key.startsWith('__reactFiber$'));
    let fiber = key && editable[key], editor = null;
    while (fiber && !editor) {
      if (typeof fiber.memoizedProps?.editor?.apply === 'function') editor = fiber.memoizedProps.editor;
      fiber = fiber.return;
    }
    if (!editor) throw new Error('Missing actual native Slate editor');
    const undoCount = editor.history.undos.length;
    const invoke = request => {
      const id = crypto.randomUUID();
      element.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
        bubbles: true, detail: JSON.stringify({ id, annotationId: element.dataset.annotationId, ...request })
      }));
      const response = JSON.parse(element.getAttribute('data-babel-helper-editor-result'));
      element.removeAttribute('data-babel-helper-editor-result');
      if (response.id !== id || !response.ok) throw new Error('Native selection command failed');
      return response;
    };
    const domCaret = offset => {
      for (const span of editable.querySelectorAll('[data-slate-string]')) {
        const text = span.firstChild;
        if (offset <= text.length) {
          window.getSelection().setBaseAndExtent(text, offset, text, offset);
          return;
        }
        offset -= text.length;
      }
      throw new Error('Missing native DOM caret point');
    };
    const modelCaret = () => editor.selection.anchor.offset;
    invoke({ operation: 'select', start: 5, end: 5 });
    domCaret(0); // Reproduce the browser's transient pre-projection native caret.
    const pending = invoke({ operation: 'syncSelection', source: 'selectionchange' });
    const pendingModel = modelCaret();
    domCaret(5);
    invoke({ operation: 'syncSelection', source: 'selectionchange' });
    domCaret(2);
    invoke({ operation: 'syncSelection', source: 'selectionchange' });
    const afterAcknowledgement = modelCaret();
    invoke({ operation: 'select', start: 7, end: 7 });
    domCaret(1);
    invoke({ operation: 'syncSelection', source: 'input' });
    const inputModel = modelCaret();
    invoke({ operation: 'select', start: 3, end: 3 });
    domCaret(0);
    invoke({ operation: 'syncSelection', source: 'intent' });
    const intentModel = modelCaret();
    domCaret(4);
    invoke({ operation: 'syncSelection', source: 'selectionchange' });
    return { pending, pendingModel, afterAcknowledgement, inputModel, intentModel,
      pointerModel: modelCaret(), undoChanged: editor.history.undos.length !== undoCount,
      focused: document.activeElement === editable };
  });
  expect(result.pending).toMatchObject({ ok: true, start: 5, end: 5 });
  expect(result).toMatchObject({ pendingModel: 5, afterAcknowledgement: 2, inputModel: 7,
    intentModel: 3, pointerModel: 4, undoChanged: false, focused: true });
  expect(await nativeAnnotations(page)).toEqual(annotations);
});

test('MAIN transcript mutations deny readonly and stale task requests without native saves', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'timestamp', '__babelHelperTimestampBridge');
  const before = await timestamp(page, 'snapshotTranscript');
  const stale = await timestamp(page, 'deleteSegment', { annotationId: before.rows[0].annotationId,
    expectedReviewActionId: 'a-different-task', expectedHistoryRevision: before.historyRevision, expectedHistoryToken: before.historyToken });
  expect(stale.reason).toBe('stale-task');
  expect((await timestamp(page, 'snapshotTranscript')).rows).toEqual(before.rows);
  await babel.reset('readonly');
  await ready(page);
  await loadBridge(page, babel, 'timestamp', '__babelHelperTimestampBridge');
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  const readonly = await timestamp(page, 'snapshotTranscript');
  expect(readonly.readOnly).toBe(true);
  const payload = { annotationId: readonly.rows[0].annotationId, processedRecordingId: readonly.lanes[0].processedRecordingId,
    startSeconds: 1, endSeconds: 2, targetSeconds: 2, splitSeconds: 1.5,
    expectedHistoryRevision: readonly.historyRevision, expectedHistoryToken: readonly.historyToken };
  for (const method of ['createSegment', 'deleteSegment', 'mergeSegment', 'setBoundaryTime', 'splitSegmentAtTime', 'undoTranscript']) {
    expect((await timestamp(page, method, payload)).reason, method).toBe('read-only');
  }
  const row = rows(page).first();
  expect((await control(row, { operation: 'read' })).text).toBe(readonly.rows[0].text);
  expect((await control(row, { operation: 'replace', text: 'Must not persist.' })).reason).toBe('read-only');
  expect((await control(row, { operation: 'syncSelection' })).reason).toBe('read-only');
  expect((await control(row, { operation: 'select', selectAll: true })).reason).toBe('read-only');
  expect((await timestamp(page, 'snapshotTranscript')).rows).toEqual(readonly.rows);
  expect((await babel.state()).calls.filter(call => /saveAnnotations|submit/.test(call.procedure || ''))).toEqual([]);
});

test('guarded native undo rejects an old receipt after Undo and another edit restore the same history depth', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'timestamp', '__babelHelperTimestampBridge');
  const before = await timestamp(page, 'snapshotTranscript');
  const first = before.rows[0];
  const receipt = await timestamp(page, 'setBoundaryTime', {
    annotationId: first.annotationId, side: 'right', targetSeconds: first.endSeconds - 0.1,
    expectedReviewActionId: before.reviewActionId,
    expectedHistoryRevision: before.historyRevision, expectedHistoryToken: before.historyToken
  });
  expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
  await history(page, 'undo');
  await expect.poll(async () => (await timestamp(page, 'snapshotTranscript')).historyRevision).toBe(before.historyRevision);
  await editText(page, 0, 'Ручная правка после отмены.');
  await expect.poll(async () => (await timestamp(page, 'snapshotTranscript')).historyRevision).toBe(receipt.historyRevision);
  const edited = await nativeAnnotations(page);
  expect(edited.find(turn => turn.id === first.annotationId).content).toBe('Ручная правка после отмены.');
  const rejected = await timestamp(page, 'undoTranscript', {
    expectedReviewActionId: before.reviewActionId,
    expectedHistoryRevision: receipt.historyRevision, expectedHistoryToken: receipt.historyToken
  });
  expect(rejected, 'Equal stack depth must not authorize undo of a different native command').toMatchObject({
    ok: false, reason: 'history-conflict'
  });
  expect(byId(await nativeAnnotations(page))).toEqual(byId(edited));
});

test('guarded native undo refuses newer local-only Slate text before its debounce commits', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'timestamp', '__babelHelperTimestampBridge');
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  const before = await timestamp(page, 'snapshotTranscript');
  const first = before.rows[0], target = first.endSeconds - 0.1;
  const receipt = await timestamp(page, 'setBoundaryTime', { annotationId: first.annotationId, side: 'right',
    targetSeconds: target, expectedReviewActionId: before.reviewActionId,
    expectedHistoryRevision: before.historyRevision, expectedHistoryToken: before.historyToken });
  expect(receipt.ok).toBe(true);
  const row = page.locator(`section[data-annotation-id="${first.annotationId}"]`);
  await row.getByRole('textbox', { name: 'Edit turn text' }).focus();
  const editable = row.locator('[data-slate-editor="true"]');
  await expect(editable).toBeVisible();
  const pendingText = 'Новый текст ещё не сохранён в состоянии.';
  const observed = await row.evaluate(async (element, { pendingText, receipt, reviewActionId }) => {
    const id = crypto.randomUUID();
    element.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
      bubbles: true, detail: JSON.stringify({ id, annotationId: element.dataset.annotationId, reviewActionId,
        operation: 'replace', text: pendingText })
    }));
    const replaced = JSON.parse(element.getAttribute('data-babel-helper-editor-result'));
    element.removeAttribute('data-babel-helper-editor-result');
    const pending = window.__babelHelperRecoveredEditorBridge.getEditorSnapshot().rows
      .find(row => row.annotationId === element.dataset.annotationId).text;
    const committed = window.__BABEL_E2E__.snapshot().annotations.find(turn => turn.id === element.dataset.annotationId).content;
    const rejected = await window.__babelHelperTimestampBridge.undoTranscript({
      expectedReviewActionId: reviewActionId, expectedHistoryRevision: receipt.historyRevision,
      expectedHistoryToken: receipt.historyToken
    });
    return { replaced, pending, committed, rejected };
  }, { pendingText, receipt, reviewActionId: before.reviewActionId });
  expect(observed.replaced.ok).toBe(true);
  expect(observed.pending).toBe(pendingText);
  expect(observed.committed).toBe(first.text);
  expect(observed.rejected).toMatchObject({ ok: false, reason: 'history-conflict' });
  await expect.poll(() => readText(editable)).toBe(pendingText);
  const settled = await timestamp(page, 'flushTranscript');
  expect(settled.ok).toBe(true);
  expect(settled.rows.find(row => row.annotationId === first.annotationId)).toMatchObject({
    text: pendingText, endSeconds: target
  });
});

test('native container and void selections map raw offsets before select-all replacement and lint fixes', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  const row = rows(page).first();
  const tag = await row.evaluate(element => {
    const key = Object.getOwnPropertyNames(element).find(key => key.startsWith('__reactFiber$'));
    for (let fiber = key && element[key]; fiber; fiber = fiber.return) {
      const vocabulary = fiber.memoizedProps?.vocabulary;
      const bracket = vocabulary?.bracketTypes?.[0];
      const name = vocabulary?.tags?.values?.().next().value;
      if (bracket && typeof name === 'string' && name) return `${bracket.open}${name}${bracket.close}`;
    }
    throw new Error('Captured native turn vocabulary is unavailable');
  });
  const raw = `До ${tag} после.`;
  expect((await control(row, { operation: 'replace', text: raw })).ok).toBe(true);
  await expect.poll(() => readText(row.getByRole('textbox', { name: 'Edit turn text' }))).toBe(raw);
  const staticRange = await row.evaluate(element => {
    const text = element.querySelector('[role="textbox"][aria-label="Edit turn text"]');
    window.getSelection().selectAllChildren(text);
    const id = crypto.randomUUID();
    element.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
      bubbles: true, detail: JSON.stringify({ id, annotationId: element.dataset.annotationId, operation: 'read' })
    }));
    const result = JSON.parse(element.getAttribute('data-babel-helper-editor-result'));
    element.removeAttribute('data-babel-helper-editor-result');
    return result;
  });
  expect(staticRange).toMatchObject({ ok: true, start: 0, end: raw.length });
  expect((await control(row, { operation: 'select', selectAll: true })).reason).toBe('editor-not-focused');
  await expect(row.locator('[data-slate-editor="true"]')).toHaveCount(0);
  await row.getByRole('textbox', { name: 'Edit turn text' }).focus();
  const editable = row.locator('[data-slate-editor="true"]');
  await expect(editable).toBeVisible();
  await expect(editable.locator('[data-slate-void="true"]')).toHaveCount(1);
  const beforeSelectAll = await nativeAnnotations(page);
  const atomic = await row.evaluate(element => {
    const editable = element.querySelector('[data-slate-editor="true"]');
    const key = Object.getOwnPropertyNames(editable).find(key => key.startsWith('__reactFiber$'));
    let fiber = key && editable[key], editor = null;
    while (fiber && !editor) {
      if (typeof fiber.memoizedProps?.editor?.apply === 'function') editor = fiber.memoizedProps.editor;
      fiber = fiber.return;
    }
    if (!editor) throw new Error('Missing actual native Slate editor');
    const undoCount = editor.history.undos.length;
    const invoke = request => {
      const id = crypto.randomUUID();
      element.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
        bubbles: true, detail: JSON.stringify({ id, annotationId: element.dataset.annotationId, ...request })
      }));
      const result = JSON.parse(element.getAttribute('data-babel-helper-editor-result'));
      element.removeAttribute('data-babel-helper-editor-result');
      if (result.id !== id) throw new Error('Missing native selection response');
      return result;
    };
    const stale = invoke({ operation: 'select', selectAll: true, reviewActionId: 'not-this-task' });
    const selected = invoke({ operation: 'select', selectAll: true, start: 7, end: 7 });
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    const wholeEditor = range.startContainer === editable && range.startOffset === 0 &&
      range.endContainer === editable && range.endOffset === editable.childNodes.length;
    const modelOffset = point => editor.children[0].children.slice(0, point.path[1])
      .reduce((offset, node) => offset + (node.text ?? node.raw ?? '').length, 0) + point.offset;
    const model = [modelOffset(editor.selection.anchor), modelOffset(editor.selection.focus)];
    const input = invoke({ operation: 'syncSelection', source: 'input' });
    return { stale, selected, input, model, wholeEditor,
      includesTag: selection.containsNode(editable.querySelector('[data-slate-void="true"]'), false),
      undoChanged: editor.history.undos.length !== undoCount, focused: document.activeElement === editable };
  });
  expect(atomic.stale).toMatchObject({ ok: false, reason: 'stale-task' });
  expect(atomic.selected).toMatchObject({ ok: true, start: 0, end: raw.length });
  expect(atomic.input).toMatchObject({ ok: true, start: 0, end: raw.length });
  expect(atomic).toMatchObject({ model: [0, raw.length], wholeEditor: true,
    includesTag: true, undoChanged: false, focused: true });
  expect(await nativeAnnotations(page)).toEqual(beforeSelectAll);
  for (const kind of ['root', 'paragraph', 'void']) {
    expect((await control(row, { operation: 'select', start: raw.length, end: raw.length })).ok).toBe(true);
    // The following real DOM selection is a newer selection gesture, not an
    // acknowledgement of the deliberately different native caret above.
    expect((await control(row, { operation: 'syncSelection', source: 'intent' })).ok).toBe(true);
    const result = await row.evaluate((element, kind) => {
      const editor = element.querySelector('[data-slate-editor="true"]');
      const target = kind === 'root' ? editor : editor.querySelector(
        kind === 'paragraph' ? '[data-slate-node="element"]' : '[data-slate-void="true"]');
      window.getSelection().selectAllChildren(target);
      const results = [];
      for (const operation of ['read', 'syncSelection']) {
        const id = crypto.randomUUID();
        element.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
          bubbles: true, detail: JSON.stringify({ id, annotationId: element.dataset.annotationId, operation })
        }));
        results.push(JSON.parse(element.getAttribute('data-babel-helper-editor-result')));
        element.removeAttribute('data-babel-helper-editor-result');
      }
      return results;
    }, kind);
    for (const selection of result) expect(selection).toMatchObject({
      ok: true, start: kind === 'void' ? 3 : 0, end: kind === 'void' ? 3 + tag.length : raw.length
    });
  }
  await fillText(editable, 'Да — нет.');
  await expect.poll(() => readText(editable)).toBe('Да — нет.');
  await page.keyboard.press('Alt+KeyF');
  await expect.poll(() => readText(editable)).toBe('Да - нет.');
  await editable.press('Enter');
  const state = await saved(page, babel);
  expect(state.action.annotations.find(turn => turn.id === staticRange.annotationId).content).toBe('Да - нет.');
});

test('atomic native split applies both text parts in one history command and one native Undo restores exact metadata', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'timestamp', '__babelHelperTimestampBridge');
  const original = await nativeAnnotations(page);
  const before = await timestamp(page, 'snapshotTranscript');
  const first = before.rows[0];
  const boundary = first.text.indexOf(' ');
  expect(boundary).toBeGreaterThan(0);
  const texts = [first.text.slice(0, boundary), first.text.slice(boundary).trimStart()];
  const split = await timestamp(page, 'splitSegmentAtTime', {
    annotationId: first.annotationId, splitSeconds: (first.startSeconds + first.endSeconds) / 2,
    sourceText: first.text, texts, expectedReviewActionId: before.reviewActionId,
    expectedHistoryRevision: before.historyRevision, expectedHistoryToken: before.historyToken
  });
  expect(split.ok, JSON.stringify(split)).toBe(true);
  expect(split.previousHistoryRevision).toBe(before.historyRevision);
  expect(split.previousHistoryToken).toBe(before.historyToken);
  expect(split.historyRevision).toBe(before.historyRevision + 1);
  const divided = await nativeAnnotations(page);
  expect(divided.some(turn => turn.id === first.annotationId)).toBe(false);
  expect(divided.find(turn => turn.id === split.leftAnnotationId).content).toBe(texts[0]);
  expect(divided.find(turn => turn.id === split.rightAnnotationId).content).toBe(texts[1]);
  await history(page, 'undo');
  await expect.poll(async () => byId(await nativeAnnotations(page))).toEqual(byId(original));
  const restored = await timestamp(page, 'snapshotTranscript');
  expect(restored.historyRevision).toBe(before.historyRevision);
  expect(restored.historyToken).toBe(before.historyToken);
});

test('programmatic turn focus blurs the connected prior Slate before activation and preserves its pending text', async ({ page, babel }) => {
  await ready(page);
  await loadBridge(page, babel, 'recovered-editor', '__babelHelperRecoveredEditorBridge');
  const first = rows(page).first(), next = rows(page).nth(2);
  const nextId = await next.getAttribute('data-annotation-id');
  await first.getByRole('textbox', { name: 'Edit turn text' }).focus();
  const editor = first.locator('[data-slate-editor="true"]');
  await expect(editor).toBeFocused();
  const pending = 'Не терять текст при переключении.';
  await fillText(editor, pending);
  const transition = await editor.evaluate((oldEditor, nextId) => {
    const oldRow = oldEditor.closest('section[data-annotation-id]');
    const target = [...document.querySelectorAll('section[data-annotation-id]')]
      .find(row => row.dataset.annotationId === nextId);
    const blurs = [];
    const onBlur = () => blurs.push({ connected: oldEditor.isConnected });
    oldEditor.addEventListener('blur', onBlur);
    const invoke = (row, request) => {
      const id = crypto.randomUUID();
      row.dispatchEvent(new CustomEvent('babel-helper:editor-control', {
        bubbles: true, detail: JSON.stringify({ id, annotationId: row.dataset.annotationId, ...request })
      }));
      const result = JSON.parse(row.getAttribute('data-babel-helper-editor-result'));
      row.removeAttribute('data-babel-helper-editor-result');
      return result;
    };
    const read = invoke(oldRow, { operation: 'read' });
    const selected = invoke(oldRow, { operation: 'select', start: read.start, end: read.end, direction: read.direction });
    const blursBeforeActivation = blurs.length;
    const focused = invoke(target, { operation: 'focus', activateRow: true, start: 0, end: 0 });
    oldEditor.removeEventListener('blur', onBlur);
    return { selected, focused, blursBeforeActivation, blurs, oldId: oldRow.dataset.annotationId };
  }, nextId);
  expect(transition.selected.ok).toBe(true);
  expect(transition.blursBeforeActivation).toBe(0);
  expect(transition.focused.ok).toBe(true);
  expect(transition.blurs).toEqual([{ connected: true }]);
  await expect(next.locator('[data-slate-editor="true"]')).toBeFocused();
  await expect(first.locator('[data-slate-editor="true"]')).toHaveCount(0);
  await expect.poll(async () => (await nativeAnnotations(page)).find(turn => turn.id === transition.oldId)?.content).toBe(pending);
});
