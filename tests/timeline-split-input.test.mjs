import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const built = await build({
  stdin: { contents: "export { registerTimelineSelection, registerTimelineInput } from './src/features/timeline-selection-feature'; export { createEditorHooks } from './src/core/editor-hooks';", resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent'
});
const { registerTimelineSelection, registerTimelineInput, createEditorHooks } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
);

const previousHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement');
test.before(() => Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: class HTMLElement {} }));
test.after(() => previousHTMLElement
  ? Object.defineProperty(globalThis, 'HTMLElement', previousHTMLElement)
  : delete globalThis.HTMLElement);
function harness({ typing = false, interactive = true, shortcuts } = {}) {
  const commits = [];
  const helper = {
    state: {}, config: { shortcuts, hotkeysHelpRows: [] },
    runtime: { isSessionInteractive: () => interactive }
  };
  registerTimelineSelection(helper, { site: { isFeatureEnabled: () => false, getLaneZoomSignature: () => 'zoom' } });
  helper.state.cutPreview = { zoomSignature: 'zoom', container: {} };
  const nativeCommit = helper.commitCutPreview;
  helper.commitCutPreview = options => { commits.push(options?.smartSplit === true ? 'smart' : 'native'); };
  const hooks = createEditorHooks();
  registerTimelineInput(helper, hooks, { isFeatureEnabled: () => true, isTypingInTextControl: () => typing });
  return { helper, commits, nativeCommit, press(overrides = {}) {
    const event = { key: 's', code: 'KeyS', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {}, ...overrides };
    const captured = hooks.dispatch('capture', event);
    const bubbled = hooks.dispatch('keydown', event);
    return { captured, bubbled, event };
  } };
}

test('S claims a timeline preview before native handlers and commits only once', () => {
  const h = harness();
  const result = h.press();
  assert.equal(result.captured, true);
  assert.equal(result.event.defaultPrevented, true);
  assert.deepEqual(h.commits, ['smart']);
});

test('Shift+S intentionally retains native-text split mode', () => {
  const h = harness();
  assert.equal(h.press({ key: 'S', shiftKey: true }).captured, true);
  assert.deepEqual(h.commits, ['native']);
});

test('focused text keeps s and S as typing even with a preview or pending split', () => {
  const h = harness({ typing: true });
  for (const pending of [false, true]) {
    h.helper.state.cutCommitPending = pending;
    for (const shiftKey of [false, true]) {
      const result = h.press({ shiftKey, key: shiftKey ? 'S' : 's' });
      assert.equal(result.event.defaultPrevented, false);
      assert.equal(result.captured, false);
      assert.equal(result.bubbled, false);
    }
  }
  assert.deepEqual(h.commits, []);
});

test('missing previews, composition, readonly sessions and claimed input never split', () => {
  for (const overrides of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    const h = harness();
    h.press(overrides);
    assert.deepEqual(h.commits, []);
  }
  const readonly = harness({ interactive: false });
  readonly.press();
  assert.deepEqual(readonly.commits, []);
  const empty = harness();
  empty.helper.state.cutPreview = null;
  assert.equal(empty.press().event.defaultPrevented, false);
  assert.deepEqual(empty.commits, []);
});

test('rebound preview split is admitted in capture without retaining S', () => {
  const h = harness({ shortcuts: { 'preview.commitLeft': [{ code: 'KeyX', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }] } });
  assert.equal(h.press().event.defaultPrevented, false);
  assert.equal(h.press({ key: 'x', code: 'KeyX' }).captured, true);
  assert.deepEqual(h.commits, ['smart']);
});

test('a preview invalidated by its originating task or audio source never reaches mutation', async () => {
  const h = harness();
  h.helper.state.cutPreview.isCurrentTask = () => false;
  assert.equal(await h.nativeCommit({ smartSplit: true }), false);
  assert.equal(h.helper.state.cutCommitPending, false);
  assert.deepEqual(h.commits, []);
});

test('preview time admission owns the command before awaiting and releases invalid ranges', async () => {
  const h = harness();
  h.helper.stopSelectionLoop = () => {};
  const preview = h.helper.state.cutPreview;
  preview.isCurrentTask = () => true;
  let resolveRange;
  preview.timeRangeRequest = new Promise(resolve => { resolveRange = resolve; });
  const pending = h.nativeCommit({ smartSplit: true });
  assert.equal(h.helper.state.cutCommitPending, true);
  assert.equal(await h.nativeCommit({ smartSplit: true }), false);
  resolveRange({ startSeconds: 1, endSeconds: 1.2 });
  assert.equal(await pending, false);
  assert.equal(h.helper.state.cutCommitPending, false);
  assert.equal(h.helper.state.cutPreview, preview);
});
