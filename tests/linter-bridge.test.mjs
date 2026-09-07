import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';

const bridgePath = path.resolve('src/content/linter-bridge.ts');

const LINTER_TOGGLE_EVENT = 'babel-helper-linter-bridge-toggle';
const BRIDGE_TEARDOWN_EVENT = 'babel-helper-bridge-teardown';

let bridgeBundlePromise = null;

function getBridgeBundle() {
  if (!bridgeBundlePromise) {
    bridgeBundlePromise = build({
      entryPoints: [bridgePath],
      bundle: true,
      write: false,
      minify: false,
      format: 'iife',
      platform: 'browser',
      target: 'chrome114',
      logLevel: 'silent'
    }).then((result) => result.outputFiles[0].text);
  }

  return bridgeBundlePromise;
}

// Boots the page-world bridge against a bare window whose fetch is a counting fake.
// Timeouts are recorded, never fired; intervals are recorded so a test can tick them, since
// any periodic re-patching of window.fetch is exactly what a stacked wrapper must survive.
async function bootLinterBridgeOverNativeFetch() {
  let linter;
  const calls = { native: 0 };
  const timeouts = [];
  const intervals = [];
  const nativeResponse = { native: true };
  const window = new EventTarget();
  Object.assign(window, {
    BabelMods: { unsafe: { services: {
      provide(name, service) { if (name === 'page.linter') linter = service; return () => {}; }
    } } },
    fetch: async function nativeFetch() {
      calls.native += 1;
      return nativeResponse;
    },
    location: { origin: 'https://babel.test', pathname: '/transcription/RU-tx-gold', search: '' },
    history: {},
    setTimeout(callback) {
      return timeouts.push(callback);
    },
    clearTimeout() {},
    setInterval(callback) {
      return intervals.push(callback);
    },
    clearInterval() {}
  });
  const document = {
    body: null,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const runBridge = new Function(
    'window',
    'document',
    'HTMLElement',
    'MutationObserver',
    'IntersectionObserver',
    await getBridgeBundle()
  );
  runBridge(window, document, class HTMLElement {}, undefined, undefined);
  assert.ok(window.__babelHelperLinterBridge, 'bridge did not boot');

  return {
    window,
    linter,
    calls,
    nativeResponse,
    tickIntervals() {
      for (const callback of intervals) {
        callback();
      }
    }
  };
}

test('shipped lint rules detect invalid text and accept valid text through the page service', async () => {
  const { linter } = await bootLinterBridgeOverNativeFetch();
  const cases = [
    ['comma-spacing', 'Привет,мир.', 'Число 3,14.'],
    ['period-spacing', 'Готово.Дальше.', 'Готово. Дальше.'],
    ['quote-balance', 'Он сказал "да.', 'Он сказал "да".'],
    ['unicode-quotes', 'Он сказал «да».', 'Он сказал "да".'],
    ['unicode-dashes', 'Да — нет.', 'Да - нет.'],
    ['angle-tag-spacing', 'Да<TAG>нет</TAG>.', 'Да <TAG> нет. </TAG>'],
    ['square-bracket-tag-spacing', 'Да[смех]нет.', 'Да [смех] нет.'],
    ['curly-tag-spacing', '3{SKAZ: три}.', '3. {SKAZ: три}'],
    ['angle-tag-trailing-punctuation', 'Да </TAG>.', 'Да. </TAG>'],
    ['curly-tag-trailing-punctuation', '3 {SKAZ: три}.', '3. {SKAZ: три}'],
    ['square-bracket-tag-trailing-punctuation', 'Да [смех].', 'Да. [смех]'],
    ['highlighted-words', 'Угу, понятно.', 'Совсем другой случай.'],
    ['sentence-boundary-capitalization', 'Готово. дальше.', 'Готово. Дальше.'],
    ['segment-start-capitalization', 'начало.', 'Начало.'],
    ['incorrect-interjection-forms', 'Ммм, понятно.', 'Понятно.'],
  ];
  for (const [id, invalid, valid] of cases) {
    const rule = linter.getRules().find(rule => rule.id === id);
    const matches = text => rule.getMatches({ annotationId: 'row', text }, {
      annotationEntries: [{ annotationId: 'row', text }], index: 0
    });
    assert.ok(matches(invalid).length > 0, `${id}: ${invalid}`);
    assert.deepEqual(matches(valid), [], `${id}: ${valid}`);
  }
});

test('lint issues keep annotation identity and exact highlighted word ranges', async () => {
  const { linter } = await bootLinterBridgeOverNativeFetch();
  const issues = linter.buildIssues([
    { annotationId: 'first', text: 'Всё, угу.', speakerKey: 'Speaker 1' },
    { annotationId: 'second', text: 'Понятно.', speakerKey: 'Speaker 2' },
  ]);
  const rule = linter.getRules().find(rule => rule.id === 'highlighted-words');
  const highlighted = issues.filter(issue => issue.reason === rule.reason);
  assert.equal(highlighted.length, 1);
  assert.equal(highlighted[0].annotationId, 'first');
  assert.equal(highlighted[0].babelHelper.sourceText, 'Всё, угу.');
  assert.deepEqual(highlighted[0].babelHelper.matches, [
    { start: 0, end: 3, text: 'Всё' }, { start: 5, end: 8, text: 'угу' }
  ]);
});

// A second page bridge (Review) stacked on top of the linter wrapper: it captures whatever
// window.fetch was at wrap time and calls it only after an await, so the linter's synchronous
// re-entrancy guard cannot see it. Rejecting on re-entry turns a cycle into a failure instead
// of a hang.
function wrapWithForeignAsyncFetch(window, calls) {
  const originalFetch = window.fetch;
  calls.foreign = 0;
  let inFlight = 0;
  window.fetch = async function foreignPatchedFetch(input, init) {
    calls.foreign += 1;
    inFlight += 1;
    try {
      if (inFlight > 1) {
        throw new Error('foreign fetch wrapper re-entered: window.fetch chain is cyclic');
      }
      await Promise.resolve();
      return await originalFetch(input, init);
    } finally {
      inFlight -= 1;
    }
  };
}

test('linter bridge never re-wraps a foreign fetch wrapper that captured its own wrapper', async () => {
  const { window, calls, nativeResponse, tickIntervals } = await bootLinterBridgeOverNativeFetch();
  const linterFetch = window.fetch;

  wrapWithForeignAsyncFetch(window, calls);
  window.dispatchEvent(new CustomEvent(LINTER_TOGGLE_EVENT, { detail: { enabled: false } }));
  window.dispatchEvent(new CustomEvent(LINTER_TOGGLE_EVENT, { detail: { enabled: true } }));
  tickIntervals();

  const response = await window.fetch('https://babel.test/api/ping', { method: 'GET' });
  assert.equal(response, nativeResponse);
  assert.deepEqual(calls, { native: 1, foreign: 1 });

  window.dispatchEvent(new CustomEvent(BRIDGE_TEARDOWN_EVENT));
  assert.equal(window.__babelHelperLinterBridge, undefined);
  // Disposed while a foreign wrapper holds it as original: the linter wrapper stays in the
  // chain as a passthrough to the native fetch it bound at install.
  const afterDispose = await window.fetch('https://babel.test/api/ping', { method: 'GET' });
  assert.equal(afterDispose, nativeResponse);
  assert.deepEqual(calls, { native: 2, foreign: 2 });
});

test('linter bridge restores the native fetch on teardown when it is on top', async () => {
  const { window, calls, nativeResponse } = await bootLinterBridgeOverNativeFetch();

  window.dispatchEvent(new CustomEvent(BRIDGE_TEARDOWN_EVENT));
  assert.equal(await window.fetch('https://babel.test/api/ping'), nativeResponse);
  assert.equal(calls.native, 1);
});

test('capitalization rules leave a sentence or segment that starts with a number alone', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const bridge = window.__babelHelperLinterBridge;

  assert.equal(bridge.fixSentenceBoundaryCapitalization('Что-то. 1-й вариант.'), 'Что-то. 1-й вариант.');
  assert.equal(bridge.fixSentenceBoundaryCapitalization('Готово. 2020 год был.'), 'Готово. 2020 год был.');
  assert.equal(bridge.fixSentenceBoundaryCapitalization('Готово. год был.'), 'Готово. Год был.');
  assert.equal(bridge.fixSegmentStartCapitalization('1-й вариант.', ''), '1-й вариант.');
  assert.equal(bridge.fixSegmentStartCapitalization('вариант.', ''), 'Вариант.');
});

const LINTER_CONFIG_EVENT = 'babel-helper-linter-bridge-config';
const FEEDBACK_STEP_ID = 'step-1';
const FEEDBACK_INPUTS = [
  { id: 'input-word', label: 'Word Accuracy', type: 'rating' },
  { id: 'input-word-comment', label: 'Word Accuracy Comment', type: 'textarea' },
  { id: 'input-other', label: 'Other Feedback', type: 'textarea' }
];
const FEEDBACK_DEFINITIONS_URL =
  'https://babel.test/api/trpc/forms.getFormInputsByStepId?input=' +
  encodeURIComponent(JSON.stringify({ json: { stepId: FEEDBACK_STEP_ID } }));
const FEEDBACK_DRAFT_URL = 'https://babel.test/api/trpc/transcriptionFeedbackForm.getOrCreateDraft?batch=1';
const FEEDBACK_DRAFT_INIT = {
  method: 'POST',
  body: JSON.stringify({ 0: { json: { formStepId: FEEDBACK_STEP_ID, reviewActionId: 'review-1', workerId: 'worker-1' } } })
};

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

// Boots the bridge over a fetch the test settles by hand, in front of a fake
// review fiber shaped like Babel's L2 page component: react-query observers for
// the draft mutation and the definitions query, plus the label ref its effect
// fills once the definitions commit. `Date.now` is the test's clock.
async function bootLinterBridgeForFeedbackDraft({ fiberMounted = true } = {}) {
  const timeouts = [];
  const upstream = [];
  const clock = { now: 1_000_000 };
  const window = new EventTarget();
  Object.assign(window, {
    fetch: function nativeFetch(input, init) {
      const { promise, resolve, reject } = Promise.withResolvers();
      upstream.push({ url: typeof input === 'string' ? input : input.url, init, resolve, reject });
      return promise;
    },
    location: { origin: 'https://babel.test', pathname: '/transcription/RU-tx-gold', search: '' },
    history: {},
    setTimeout(callback) {
      return timeouts.push(callback);
    },
    clearTimeout() {},
    setInterval() {
      return 0;
    },
    clearInterval() {}
  });

  const definitionsObserver = {
    options: { queryKey: [['forms', 'getFormInputsByStepId'], { input: { stepId: FEEDBACK_STEP_ID }, type: 'query' }] },
    result: { status: 'pending', data: undefined },
    getCurrentResult() {
      return this.result;
    }
  };
  const draftObserver = { options: { mutationKey: [['transcriptionFeedbackForm', 'getOrCreateDraft']] } };
  const labelsRef = { current: null };
  const hooks = [{ current: null }, { current: null }, labelsRef, definitionsObserver, draftObserver]
    .map((memoizedState) => ({ memoizedState, next: null }));
  hooks.forEach((hook, index) => {
    hook.next = hooks[index + 1] ?? null;
  });

  class Element {}
  class HTMLElement extends Element {}
  const rootFiber = { return: null, child: null, sibling: null, stateNode: null };
  rootFiber.stateNode = { current: rootFiber };
  const reviewFiber = {
    return: rootFiber,
    child: null,
    sibling: null,
    memoizedProps: { reviewActionId: 'review-1', annotations: [], linterErrors: [] },
    memoizedState: hooks[0]
  };
  const seedFiber = { return: reviewFiber, child: null, sibling: null, memoizedProps: {}, memoizedState: null };
  rootFiber.child = reviewFiber;
  reviewFiber.child = seedFiber;
  const seed = new Element();
  seed.__reactFiber$test = seedFiber;
  const document = {
    body: null,
    getElementById: () => null,
    querySelector: () => (fiberMounted ? seed : null),
    querySelectorAll: () => []
  };

  const runBridge = new Function(
    'window',
    'document',
    'HTMLElement',
    'Element',
    'MutationObserver',
    'IntersectionObserver',
    'Date',
    await getBridgeBundle()
  );
  runBridge(window, document, HTMLElement, Element, undefined, undefined, { now: () => clock.now });

  return {
    window,
    clock,
    get debug() {
      return window.__babelHelperLinterBridge.debug.feedbackDraftRestore;
    },
    async requestDefinitions() {
      const response = window.fetch(FEEDBACK_DEFINITIONS_URL, { method: 'GET' });
      await flushMicrotasks();
      return { response, upstream: upstream.findLast((call) => call.url === FEEDBACK_DEFINITIONS_URL) };
    },
    async requestDraft() {
      const response = window.fetch(FEEDBACK_DRAFT_URL, FEEDBACK_DRAFT_INIT);
      await flushMicrotasks();
      return { response, upstream: upstream.findLast((call) => call.url === FEEDBACK_DRAFT_URL) };
    },
    commitDefinitions() {
      definitionsObserver.result = { status: 'success', data: FEEDBACK_INPUTS };
      labelsRef.current = FEEDBACK_INPUTS.map(({ id, label }) => ({ id, label }));
    },
    // Settles whatever the last upstream resolution started before the clock
    // moves, so hold timestamps are taken at the pre-tick time.
    async tick(elapsedMs = 25) {
      await flushMicrotasks();
      clock.now += elapsedMs;
      for (const callback of timeouts.splice(0)) {
        callback();
      }
      await flushMicrotasks();
    }
  };
}

async function settledState(promise) {
  let state = 'pending';
  promise.then(
    () => {
      state = 'fulfilled';
    },
    () => {
      state = 'rejected';
    }
  );
  await flushMicrotasks();
  return state;
}

// A hold that never releases would otherwise hang the whole test file.
function released(promise) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('draft response was never released')), 2000))
  ]);
}

test('feedback draft restore holds a draft-first response until the definitions commit', async () => {
  const bridge = await bootLinterBridgeForFeedbackDraft();
  const definitions = await bridge.requestDefinitions();
  const draft = await bridge.requestDraft();
  const draftResponse = { ok: true, draft: true };

  draft.upstream.resolve(draftResponse);
  assert.equal(await settledState(draft.response), 'pending');
  assert.equal(bridge.debug.pendingHolds, 1);

  definitions.upstream.resolve({ ok: true, definitions: true });
  await bridge.tick();
  assert.equal(await settledState(draft.response), 'pending');
  assert.equal(bridge.debug.definitions.status, 'delivered');

  bridge.commitDefinitions();
  await bridge.tick();
  assert.equal(await released(draft.response), draftResponse);
  assert.equal(bridge.debug.pendingHolds, 0);
  assert.equal(bridge.debug.last.reason, 'committed');
});

test('feedback draft restore releases the response untouched when the commit never shows', async () => {
  const bridge = await bootLinterBridgeForFeedbackDraft();
  const definitions = await bridge.requestDefinitions();
  const draft = await bridge.requestDraft();
  const draftResponse = { ok: true, draft: true };
  draft.upstream.resolve(draftResponse);
  await bridge.tick(7_900);
  assert.equal(await settledState(draft.response), 'pending');
  await bridge.tick(200);
  assert.equal(await released(draft.response), draftResponse);
  assert.equal(bridge.debug.last.reason, 'timeout');

  // Definitions delivered but no observable commit: bounded grace, then release.
  const laterDraft = await bridge.requestDraft();
  const laterResponse = { ok: true, draft: 'later' };
  laterDraft.upstream.resolve(laterResponse);
  definitions.upstream.resolve({ ok: true });
  await bridge.tick(1_000);
  assert.equal(await settledState(laterDraft.response), 'pending');
  await bridge.tick(600);
  assert.equal(await released(laterDraft.response), laterResponse);
  assert.equal(bridge.debug.last.reason, 'commit-grace-elapsed');

  // No review fiber at all: only an in-flight definitions request justifies a hold.
  const headless = await bootLinterBridgeForFeedbackDraft({ fiberMounted: false });
  const loneDraft = await headless.requestDraft();
  const loneResponse = { ok: true };
  loneDraft.upstream.resolve(loneResponse);
  assert.equal(await released(loneDraft.response), loneResponse);
  assert.equal(headless.debug.last.reason, 'no-definitions-request');
});

test('feedback draft restore passes through when disabled, releasing holds already pending', async () => {
  const bridge = await bootLinterBridgeForFeedbackDraft();
  await bridge.requestDefinitions();
  const held = await bridge.requestDraft();
  const heldResponse = { ok: true };
  held.upstream.resolve(heldResponse);
  assert.equal(await settledState(held.response), 'pending');

  bridge.window.dispatchEvent(new CustomEvent(LINTER_CONFIG_EVENT, { detail: { feedbackDraftRestoreEnabled: false } }));
  assert.equal(await released(held.response), heldResponse);
  assert.equal(bridge.debug.last.reason, 'disabled');
  assert.equal(bridge.debug.enabled, false);

  const passthrough = await bridge.requestDraft();
  const passthroughResponse = { ok: true, second: true };
  passthrough.upstream.resolve(passthroughResponse);
  assert.equal(await released(passthrough.response), passthroughResponse);
  assert.equal(bridge.debug.pendingHolds, 0);

  bridge.window.dispatchEvent(new CustomEvent(LINTER_CONFIG_EVENT, { detail: { feedbackDraftRestoreEnabled: true } }));
  const reenabled = await bridge.requestDraft();
  reenabled.upstream.resolve({ ok: true });
  assert.equal(await settledState(reenabled.response), 'pending');
});

test('feedback draft restore never holds once the definitions are already committed', async () => {
  const bridge = await bootLinterBridgeForFeedbackDraft();
  const definitions = await bridge.requestDefinitions();
  definitions.upstream.resolve({ ok: true });
  await bridge.tick();
  bridge.commitDefinitions();

  const draft = await bridge.requestDraft();
  const draftResponse = { ok: true };
  draft.upstream.resolve(draftResponse);
  assert.equal(await released(draft.response), draftResponse);
  assert.equal(bridge.debug.pendingHolds, 0);
  assert.equal(bridge.debug.last.reason, 'committed');
  assert.equal(bridge.debug.last.heldMs, 0);
});

test('fixes native Babel-style leading and trailing spaces', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixLeadingTrailingSpaces } = window.__babelHelperLinterBridge;

  assert.equal(fixLeadingTrailingSpaces('  hello world  '), 'hello world');
  assert.equal(fixLeadingTrailingSpaces('\thello world\t'), 'hello world');
});

test('fixes native Babel-style repeated internal spaces only', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixDoubleSpaces } = window.__babelHelperLinterBridge;

  assert.equal(fixDoubleSpaces('hello  world'), 'hello world');
  assert.equal(fixDoubleSpaces('hello   brave   world'), 'hello brave world');
  assert.equal(fixDoubleSpaces('  hello world  '), '  hello world  ');
});

test('applyAllFixes combines native and helper autofixes conservatively', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(
    applyAllFixes('  hello  ,world  '),
    'hello, world.'
  );
  assert.equal(
    applyAllFixes('foo" bar "baz'),
    'foo" bar "baz.'
  );
  assert.equal(
    applyAllFixes('He said, "Hello"'),
    'He said, "Hello"'
  );
  assert.equal(
    applyAllFixes('already done!'),
    'already done!'
  );
  assert.equal(
    applyAllFixes('pause--'),
    'pause--'
  );
  assert.equal(
    applyAllFixes('hello world</i>'),
    'hello world. </i>'
  );
  assert.equal(
    applyAllFixes('hello world [laughs]'),
    'hello world. [laughs]'
  );
  assert.equal(
    applyAllFixes('hello world [неразборчиво]'),
    'hello world [неразборчиво]'
  );
  assert.equal(
    applyAllFixes('hello. world'),
    'hello. World.'
  );
  assert.equal(
    applyAllFixes('"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u0441 \u0432\u043e\u043f\u0440\u043e\u0441\u043e\u043c?"- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430'),
    '"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u0441 \u0432\u043e\u043f\u0440\u043e\u0441\u043e\u043c?"- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'
  );
});

test('applyAllFixes preserves arbitrary curly-brace content and spacing', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  const text = 'Already{ \traw /:@ content\t }attached!';
  assert.equal(applyAllFixes(text), text);
});

test('applyAllFixes normalizes unicode quote variants without changing quote spacing', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(
    applyAllFixes('foo\u00ab bar \u00bbbaz'),
    'foo" bar "baz.'
  );
  assert.equal(
    applyAllFixes('\u300chello\u300d'),
    '"hello"'
  );
});

test('applyAllFixes includes period and angle tag spacing fixes', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('hello .world'), 'hello. World.');
  assert.equal(applyAllFixes('hello<TAG>world'), 'hello <TAG> world.');
  assert.equal(applyAllFixes('<TAG>hello world</TAG>'), '<TAG> hello world. </TAG>');
});

test('applyAllFixes inserts missing space before curly annotation tags', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('9{СКАЗ: девять}'), '9. {СКАЗ: девять}');
});

test('moves punctuation before closing angle tags', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixAngleTagTrailingPunctuation } = window.__babelHelperLinterBridge;

  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>.'), 'Да. </TAG>');
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>:'), 'Да: </TAG>');
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>".'), 'Да". </TAG>');
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>" конец'), 'Да" </TAG> конец');
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>"'), 'Да" </TAG>');
  // Continuation dashes stay outside the tag; they are not movable punctuation.
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>--'), 'Да </TAG>--');
  assert.equal(
    fixAngleTagTrailingPunctuation('Он сказал "раз, затем Да </TAG> "нет".'),
    'Он сказал "раз, затем Да </TAG> "нет".'
  );
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG>   ?! next'), 'Да?! </TAG> next');
  assert.equal(fixAngleTagTrailingPunctuation('Да. </TAG>'), 'Да. </TAG>');
  assert.equal(fixAngleTagTrailingPunctuation('Да <TAG>.'), 'Да <TAG>.');
  assert.equal(fixAngleTagTrailingPunctuation('Да </TAG'), 'Да </TAG');
});

test('applyAllFixes moves punctuation before closing angle tags', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('Да </TAG>.'), 'Да. </TAG>');
  assert.equal(applyAllFixes('Да </TAG>:'), 'Да: </TAG>');
  assert.equal(applyAllFixes('Да </TAG>".'), 'Да". </TAG>');
});

test('moves standalone opening quotes after opening angle tags', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixAngleTagTrailingPunctuation, applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(fixAngleTagTrailingPunctuation('Da " <TAG> text'), 'Da <TAG> "text');
  assert.equal(fixAngleTagTrailingPunctuation('Da "<TAG> text'), 'Da <TAG> "text');
  assert.equal(fixAngleTagTrailingPunctuation('Da. <TAG> text'), 'Da. <TAG> text');
  assert.equal(fixAngleTagTrailingPunctuation('Da?! <TAG> text'), 'Da?! <TAG> text');
  assert.equal(fixAngleTagTrailingPunctuation('. <TAG> text'), '. <TAG> text');
  assert.equal(fixAngleTagTrailingPunctuation('Da." <TAG> text'), 'Da." <TAG> text');
  assert.equal(fixAngleTagTrailingPunctuation('Da <TAG>. text'), 'Da <TAG>. text');
  assert.equal(applyAllFixes('Da "<TAG>text'), 'Da <TAG> "text.');
});

test('applyAllFixes moves punctuation before curly tags before terminal checks', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('3 {SKAZ: three}".'), '3". {SKAZ: three}');
  assert.equal(applyAllFixes('3 {SKAZ: three}--'), '3 {SKAZ: three}--');
  assert.equal(applyAllFixes('3 {SKAZ: three}, next'), '3, {SKAZ: three} next.');
});

test('moves punctuation before square bracket tags that annotate preceding text', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixSquareBracketTagTrailingPunctuation } = window.__babelHelperLinterBridge;

  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh], who'), 'workers, [laugh] who');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh].'), 'workers. [laugh]');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh]--'), 'workers-- [laugh]');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh]   ?! who'), 'workers?! [laugh] who');
  assert.equal(fixSquareBracketTagTrailingPunctuation('TEXT: [tag] "TEXT'), 'TEXT: [tag] "TEXT');
  assert.equal(fixSquareBracketTagTrailingPunctuation('TEXT: [tag] "TEXT"'), 'TEXT: [tag] "TEXT"');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh] "quoted"'), 'workers [laugh] "quoted"');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers, [laugh] who'), 'workers, [laugh] who');
  assert.equal(fixSquareBracketTagTrailingPunctuation('[laugh], who'), '[laugh], who');
  assert.equal(fixSquareBracketTagTrailingPunctuation('workers [laugh'), 'workers [laugh');
});

test('applyAllFixes spaces bracket tags and moves punctuation before them', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('workers[laugh],who'), 'workers, [laugh] who.');
  assert.equal(applyAllFixes('workers [laugh], who'), 'workers, [laugh] who.');
  assert.equal(applyAllFixes('workers [ laugh ] .'), 'workers. [laugh]');
});

test('fixSegmentStartCapitalization respects same-speaker continuations and ellipsis starts', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixSegmentStartCapitalization } = window.__babelHelperLinterBridge;

  assert.equal(fixSegmentStartCapitalization('lowercase start.', 'Previous sentence.'), 'Lowercase start.');
  assert.equal(fixSegmentStartCapitalization('lowercase continuation.', 'carry on...'), 'lowercase continuation.');
  assert.equal(fixSegmentStartCapitalization('lowercase continuation.', 'carry on--'), 'lowercase continuation.');
  assert.equal(fixSegmentStartCapitalization('"lowercase continuation."', 'carry on--"'), '"lowercase continuation."');
  assert.equal(fixSegmentStartCapitalization('"lowercase continuation."', 'carry on..."'), '"lowercase continuation."');
  assert.equal(fixSegmentStartCapitalization('\u0432\u044b \u043f\u0440\u0430\u0432\u044b.', 'Previous sentence.'), '\u0412\u044b \u043f\u0440\u0430\u0432\u044b.');
  assert.equal(fixSegmentStartCapitalization('[laughs] \u0432\u0430\u0448\u0430 \u0432\u0435\u0440\u0441\u0438\u044f.', 'Previous sentence.'), '[laughs] \u0412\u0430\u0448\u0430 \u0432\u0435\u0440\u0441\u0438\u044f.');
  assert.equal(fixSegmentStartCapitalization('\u0412\u044b \u043f\u0440\u0430\u0432\u044b.', 'carry on...'), '\u0412\u044b \u043f\u0440\u0430\u0432\u044b.');
  assert.equal(fixSegmentStartCapitalization('...Upper after ellipsis.', 'Previous sentence.'), '...upper after ellipsis.');
  assert.equal(fixSegmentStartCapitalization('...lower after ellipsis.', 'Previous sentence.'), '...lower after ellipsis.');
  assert.equal(fixSegmentStartCapitalization('... 123 Upper after number.', 'Previous sentence.'), '... 123 Upper after number.');
  assert.equal(
    fixSegmentStartCapitalization('... [laughs] 123 Upper after number.', 'Previous sentence.'),
    '... [laughs] 123 Upper after number.'
  );
  assert.equal(fixSegmentStartCapitalization('[laughs] lowercase start.', 'Previous sentence.'), '[laughs] Lowercase start.');
  assert.equal(fixSegmentStartCapitalization('<i>lowercase start.</i>', 'Previous sentence.'), '<i>Lowercase start.</i>');
  assert.equal(fixSegmentStartCapitalization('...[laughs] Upper after ellipsis.', 'Previous sentence.'), '...[laughs] upper after ellipsis.');
  assert.equal(fixSegmentStartCapitalization('[laughs] ...Upper after ellipsis.', 'Previous sentence.'), '[laughs] ...upper after ellipsis.');
});


test('applyAllFixes allows comma-hyphen direct speech unchanged', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('TEXT, - TEXT.'), 'TEXT, - TEXT.');
});

test('applyAllFixes replaces free-floating mid-sentence double dashes', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('hello -- world'), 'hello - world.');
});

test('fixes double dash punctuation', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixDoubleDashPunctuation } = window.__babelHelperLinterBridge;

  assert.equal(fixDoubleDashPunctuation('wait--.'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--,'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--?'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--!'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('wait--...'), 'wait--...');
  assert.equal(fixDoubleDashPunctuation('som--...ord'), 'som--...ord');
  assert.equal(fixDoubleDashPunctuation('wait--?!'), 'wait--');
  assert.equal(fixDoubleDashPunctuation('<wait--.> {wait--?} [wait--!]'), '<wait--.> {wait--?} [wait--!]');
});

test('applyAllFixes includes double dash punctuation fix', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('wait--.'), 'wait--');
  assert.equal(applyAllFixes('wait--...'), 'wait--...');
  assert.equal(applyAllFixes('som--...ord.'), 'som--...ord.');
});

test('fixes unicode dash variants to ascii hyphen', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixUnicodeDashes } = window.__babelHelperLinterBridge;

  assert.equal(fixUnicodeDashes('wait—what'), 'wait-what');
  assert.equal(fixUnicodeDashes('wait–what'), 'wait-what');
  assert.equal(fixUnicodeDashes('wait−what'), 'wait-what');
  assert.equal(fixUnicodeDashes('wait――what'), 'wait--what');
});

test('fixes unicode quote variants to ascii double quotes', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixUnicodeQuotes } = window.__babelHelperLinterBridge;

  assert.equal(fixUnicodeQuotes('\u00abhello\u00bb'), '"hello"');
  assert.equal(fixUnicodeQuotes('\u201chello\u201d'), '"hello"');
  assert.equal(fixUnicodeQuotes('\u300chello\u300d'), '"hello"');
  assert.equal(fixUnicodeQuotes('\u301dhello\u301f'), '"hello"');
});

test('applyAllFixes normalizes unicode dashes before other dash rules', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('wait—.'), 'wait-');
  assert.equal(applyAllFixes('pause――'), 'pause--');
});

test('fixes single dash punctuation', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixSingleDashPunctuation } = window.__babelHelperLinterBridge;

  assert.equal(fixSingleDashPunctuation('wait-.'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait-,'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait-?'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait-!'), 'wait-');
  assert.equal(fixSingleDashPunctuation('wait--.'), 'wait--.'); // Should not touch double dash
  assert.equal(fixSingleDashPunctuation('<wait-.> {wait-?} [wait-!]'), '<wait-.> {wait-?} [wait-!]');
});

test('applyAllFixes includes single dash punctuation fix', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('wait-.'), 'wait-');
});

test('normalizes incorrect interjection forms conservatively', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { normalizeIncorrectInterjectionForms } = window.__babelHelperLinterBridge;

  assert.equal(normalizeIncorrectInterjectionForms('аа, я понял.'), 'а, я понял.');
  assert.equal(normalizeIncorrectInterjectionForms('а-а, я понял.'), 'а, я понял.');
  assert.equal(normalizeIncorrectInterjectionForms('ей богу, это так.'), 'ей-богу, это так.');
  assert.equal(normalizeIncorrectInterjectionForms('Ну, да.'), 'Ну да.');
  assert.equal(normalizeIncorrectInterjectionForms('о, нет!'), 'о нет!');
  assert.equal(normalizeIncorrectInterjectionForms('у-у, ясно.'), 'у, ясно.');
  assert.equal(normalizeIncorrectInterjectionForms('э-э, секунду.'), 'э, секунду.');
  assert.equal(normalizeIncorrectInterjectionForms('мм, да.'), 'м, да.');
  assert.equal(normalizeIncorrectInterjectionForms('ОК, хмм.'), 'ОК, хм.');
  assert.equal(normalizeIncorrectInterjectionForms('хахаха!'), 'ха-ха!');
});

test('preserves case shape when normalizing incorrect interjection forms', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { normalizeIncorrectInterjectionForms } = window.__babelHelperLinterBridge;

  assert.equal(normalizeIncorrectInterjectionForms('ОК, ХММ.'), 'ОК, ХМ.');
  assert.equal(normalizeIncorrectInterjectionForms('Ей богу, это так.'), 'Ей-богу, это так.');
  assert.equal(normalizeIncorrectInterjectionForms('А-м, ну ладно.'), 'Ам, ну ладно.');
  assert.equal(normalizeIncorrectInterjectionForms('А-М, ну ладно.'), 'АМ, ну ладно.');
});

test('applyAllFixes includes incorrect interjection normalization', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(applyAllFixes('ей богу'), 'ей-богу.');
  assert.equal(applyAllFixes('ОК, хмм'), 'ОК, хм.');
});
test('fixes polite Russian pronouns according to sentence context', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixPolitePronounCase } = window.__babelHelperLinterBridge;

  assert.equal(fixPolitePronounCase('\u0432\u044b \u043f\u0440\u0430\u0432\u044b.'), '\u0432\u044b \u043f\u0440\u0430\u0432\u044b.');
  assert.equal(fixPolitePronounCase('\u0421\u043f\u0430\u0441\u0438\u0431\u043e, \u0412\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.'), '\u0421\u043f\u0430\u0441\u0438\u0431\u043e, \u0432\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.');
  assert.equal(fixPolitePronounCase('\u0421\u043f\u0430\u0441\u0438\u0431\u043e. \u0432\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.'), '\u0421\u043f\u0430\u0441\u0438\u0431\u043e. \u0432\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.');
  assert.equal(fixPolitePronounCase('\u0414\u0430. --\u0412\u0430\u043c\u0438 \u044d\u0442\u043e \u0441\u0434\u0435\u043b\u0430\u043d\u043e.'), '\u0414\u0430. --\u0412\u0430\u043c\u0438 \u044d\u0442\u043e \u0441\u0434\u0435\u043b\u0430\u043d\u043e.');
  assert.equal(fixPolitePronounCase('\u0418 ...\u0412\u0430\u0448\u0435\u043c\u0443 \u043f\u0440\u0438\u043c\u0435\u0440\u0443 \u0441\u043b\u0435\u0434\u0443\u044e\u0442.'), '\u0418 ...\u0412\u0430\u0448\u0435\u043c\u0443 \u043f\u0440\u0438\u043c\u0435\u0440\u0443 \u0441\u043b\u0435\u0434\u0443\u044e\u0442.');
  assert.equal(fixPolitePronounCase('\u041c\u043d\u0435 \u043d\u0443\u0436\u043d\u043e \u0441\u043a\u0430\u0437\u0430\u0442\u044c: "\u0412\u044b \u0437\u043d\u0430\u0435\u0442\u0435".'), '\u041c\u043d\u0435 \u043d\u0443\u0436\u043d\u043e \u0441\u043a\u0430\u0437\u0430\u0442\u044c: "\u0412\u044b \u0437\u043d\u0430\u0435\u0442\u0435".');
});

test('applyAllFixes includes polite Russian pronoun normalization', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixPolitePronounCase, applyAllFixes } = window.__babelHelperLinterBridge;

  assert.equal(fixPolitePronounCase(applyAllFixes('\u0432\u044b \u043f\u0440\u0430\u0432\u044b')), '\u0432\u044b \u043f\u0440\u0430\u0432\u044b.');
  assert.equal(fixPolitePronounCase(applyAllFixes('\u0421\u043f\u0430\u0441\u0438\u0431\u043e. \u0432\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.')), '\u0421\u043f\u0430\u0441\u0438\u0431\u043e. \u0412\u0430\u0448 \u043e\u0442\u0432\u0435\u0442 \u043f\u0440\u0438\u043d\u044f\u0442.');
});

test('fixes lowercase words after clear sentence boundaries inside a segment', async () => {
  const { window } = await bootLinterBridgeOverNativeFetch();
  const { fixSentenceBoundaryCapitalization } = window.__babelHelperLinterBridge;

  assert.equal(fixSentenceBoundaryCapitalization('Hello. world'), 'Hello. World');
  assert.equal(fixSentenceBoundaryCapitalization('Hello? world'), 'Hello? World');
  assert.equal(fixSentenceBoundaryCapitalization('Hello! world'), 'Hello! World');
  assert.equal(fixSentenceBoundaryCapitalization('Hello... world'), 'Hello... world');
  assert.equal(fixSentenceBoundaryCapitalization('Hello -- world'), 'Hello -- world');
  assert.equal(fixSentenceBoundaryCapitalization('Hello - world'), 'Hello - world');
  assert.equal(fixSentenceBoundaryCapitalization('Hello. "world"'), 'Hello. "World"');
  assert.equal(fixSentenceBoundaryCapitalization('Hello. [laughs] world'), 'Hello. [laughs] World');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello?" - world'), '"Hello?" - world');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello?"- world'), '"Hello?"- world');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello!"- world'), '"Hello!"- world');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello?!" - world'), '"Hello?!" - world');
  assert.equal(fixSentenceBoundaryCapitalization('\u00abHello?\u00bb - world'), '\u00abHello?\u00bb - world');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello?" - [tag] world'), '"Hello?" - [tag] world');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello? - asked he. - What next?"'), '"Hello? - asked he. - What next?"');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello! - shouted he. - Go."'), '"Hello! - shouted he. - Go."');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello?! - asked he. - Really?"'), '"Hello?! - asked he. - Really?"');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello."- world'), '"Hello."- World');
  assert.equal(fixSentenceBoundaryCapitalization('Hello? - world'), 'Hello? - World');
  assert.equal(fixSentenceBoundaryCapitalization('"Hello? - asked he. - what next?"'), '"Hello? - asked he. - What next?"');
  assert.equal(
    fixSentenceBoundaryCapitalization('"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u0441 \u0432\u043e\u043f\u0440\u043e\u0441\u043e\u043c?"- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'),
    '"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u0441 \u0432\u043e\u043f\u0440\u043e\u0441\u043e\u043c?"- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'
  );
  assert.equal(
    fixSentenceBoundaryCapitalization('"\u0427\u0442\u043e? - \u0441\u043f\u0440\u043e\u0441\u0438\u043b \u043e\u043d. - \u0427\u0442\u043e \u0434\u0430\u043b\u044c\u0448\u0435?"'),
    '"\u0427\u0442\u043e? - \u0441\u043f\u0440\u043e\u0441\u0438\u043b \u043e\u043d. - \u0427\u0442\u043e \u0434\u0430\u043b\u044c\u0448\u0435?"'
  );
  assert.equal(
    fixSentenceBoundaryCapitalization('"\u0427\u0442\u043e? - \u0441\u043f\u0440\u043e\u0441\u0438\u043b \u043e\u043d. - \u0447\u0442\u043e \u0434\u0430\u043b\u044c\u0448\u0435?"'),
    '"\u0427\u0442\u043e? - \u0441\u043f\u0440\u043e\u0441\u0438\u043b \u043e\u043d. - \u0427\u0442\u043e \u0434\u0430\u043b\u044c\u0448\u0435?"'
  );
  assert.equal(
    fixSentenceBoundaryCapitalization('"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u043a\u043e\u043d\u0447\u0438\u043b\u0430\u0441\u044c."- \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'),
    '"\u041f\u0440\u044f\u043c\u0430\u044f \u0440\u0435\u0447\u044c \u043a\u043e\u043d\u0447\u0438\u043b\u0430\u0441\u044c."- \u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0435\u043d\u0438\u0435 \u0442\u0435\u043a\u0441\u0442\u0430.'
  );
});
