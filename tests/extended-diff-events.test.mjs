import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/features/extended-diff-view-feature.ts'], bundle: true,
  format: 'iife', globalName: 'diffFeature', platform: 'browser', write: false, logLevel: 'silent',
  plugins: [{ name: 'style-boundary', setup(builder) {
    builder.onResolve({ filter: /^@nominy\/babel-extension-frontend$/ }, () => ({ path: 'styles', namespace: 'unit' }));
    builder.onLoad({ filter: /.*/, namespace: 'unit' }, () => ({ contents: 'export const themeRoot = () => {}; export const applyComponent = () => {};' }));
  } }]
});

class Element extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.children = [];
    this.dataset = {}; this.style = {}; this.className = ''; this.textContent = ''; this.innerText = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(node) { node.remove(); this.children.push(node); node.parentElement = this; return node; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  replaceChildren(...nodes) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...nodes); }
  insertAdjacentElement(_position, node) { this.parentElement.appendChild(node); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim();
      if (part.startsWith('[id^="')) return (this.id || '').startsWith(part.slice(6, -2));
      if (part === '[role="combobox"]') return this.getAttribute('role') === 'combobox';
      if (part.startsWith('#')) return this.id === part.slice(1).split('[')[0];
      if (part.startsWith('.')) return this.className.split(' ').includes(part.slice(1));
      return this.tagName.toLowerCase() === part;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function payload(task = 'task', comparison = 'comparison', text = 'new words') {
  return { referenceReviewActionId: comparison, currentReviewActionId: task, referenceLevel: 1, currentLevel: 2,
    speakerDiffs: [{ processedRecordingId: 'speaker-1', segmentMappings: [{ relationship: 'modified',
      referenceText: 'old words', hypothesisText: text,
      segmentsA: [{ text: 'old words', startTimeInSeconds: 0, endTimeInSeconds: 1 }],
      segmentsB: [{ text, startTimeInSeconds: 0, endTimeInSeconds: 1 }], substitutions: 1
    }] }] };
}

function harness({ status = 'ready', observeFailure = false, read, fetch: fetchOverride } = {}) {
  const root = new Element('html'), body = new Element('body'), toggle = new Element('button');
  root.appendChild(body); body.appendChild(toggle); toggle.id = 'diff-mode';
  toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', 'true');
  const document = {
    documentElement: root, body,
    getElementById: id => root.querySelector(`#${id}`),
    createElement: tag => new Element(tag),
    querySelector: selector => root.querySelector(selector),
    querySelectorAll: selector => root.querySelectorAll(selector)
  };
  const window = new EventTarget();
  window.location = new URL('https://babel.test/transcription/task?reviewActionId=task');
  let reloads = 0;
  window.location.reload = () => { reloads++; };
  window.setTimeout = window.setInterval = () => { throw new Error('Diff automation must not schedule timer retries'); };
  const observers = [], performanceObservers = [], calls = [], fetches = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; this.connected = false; observers.push(this); }
    observe(target) { this.target = target; this.connected = true; }
    disconnect() { this.connected = false; }
    emit(records) { if (this.connected) this.callback(records); }
  }
  class PerformanceObserver {
    constructor(callback) { this.callback = callback; this.connected = false; performanceObservers.push(this); }
    observe() { if (observeFailure) throw new Error('Resource observer rejected'); this.connected = true; }
    disconnect() { this.connected = false; }
    emit(name) { if (this.connected) this.callback({ getEntries: () => [{ name }] }); }
  }
  let native = { ok: true, status, generation: 1, editorGeneration: 1, routeKey: '/transcription/task?reviewActionId=task', reviewActionId: 'task',
    selectedCompareActionId: 'comparison', availableReviewActions: [{ id: 'comparison', level: 1 }], payload: payload() };
  let reads = 0, clears = 0;
  const helper = {
    state: {},
    readExtendedDiffState: async () => { reads++; return read ? read(native) : structuredClone(native); },
    getEditorSnapshot: () => ({ rows: [], capturedAt: 1 }),
    applyRecoveredEditorDiffState: async state => { calls.push(state); return { ok: true }; },
    clearRecoveredEditorDiffState: async () => { clears++; return { ok: true }; }
  };
  const context = { window, document, console, URL, URLSearchParams, queueMicrotask, MutationObserver, PerformanceObserver,
    Element, HTMLElement: Element, HTMLDivElement: Element, ShadowRoot: class {},
    fetch: async url => { fetches.push(url); if (!fetchOverride) throw new Error('Unexpected network request'); return fetchOverride(url); }
  };
  vm.runInNewContext(bundled.outputFiles[0].text, context);
  context.diffFeature.registerExtendedDiffViewService(helper);
  return {
    window, document, toggle, helper, observers, performanceObservers, calls, fetches,
    get native() { return native; }, set native(value) { native = value; },
    get reads() { return reads; }, get clears() { return clears; },
    get reloads() { return reloads; },
    event(name = 'babel-helper:native-editor-commit') { window.dispatchEvent(new Event(name)); },
    mutation(target = toggle, type = 'attributes') { observers[0].emit([{ target, type, addedNodes: [], removedNodes: [] }]); },
    debug() { return JSON.parse(root.dataset.bhExtendedDiffDebug || 'null'); },
    async settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
  };
}

test('native pending data waits for notifications, cached arrival and turn changes refresh without timers or fetch', async () => {
  const h = harness({ status: 'loading' });
  await h.settle();
  assert.equal(h.calls.length, 0);
  const reads = h.reads;
  await h.settle();
  assert.equal(h.reads, reads, 'waiting does not poll');
  h.native.status = 'ready'; h.event(); await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.debug().renderableCount, 1);
  assert.equal(h.fetches.length, 0);
  h.native.payload = payload('task', 'comparison', 'cached update'); h.event(); await h.settle();
  assert.equal(h.calls.length, 2, 'cache-only native changes reapply the projection');
  h.event(); await h.settle();
  assert.equal(h.calls.length, 2, 'turn commits rerender without a redundant query write');
  const controls = h.document.getElementById('bh-segmentation-mode-controls');
  for (const mode of ['reference', 'current', 'fusion']) {
    controls.children.find(button => button.dataset.mode === mode).dispatchEvent(new Event('click'));
    await h.settle();
    assert.equal(h.calls.at(-1).textMode, mode);
  }
  h.toggle.setAttribute('aria-checked', 'false'); h.mutation(); await h.settle();
  assert.equal(h.document.getElementById('bh-segmentation-mode-controls'), null);
  h.toggle.setAttribute('aria-checked', 'true'); h.mutation(); await h.settle();
  assert.equal(h.debug().renderableCount, 1);
  h.helper.unbindExtendedDiffView();
  assert.equal(h.observers[0].connected, false);
  assert.equal(h.performanceObservers[0].connected, false);
  const disposedReads = h.reads; h.event(); h.mutation(); await h.settle();
  assert.equal(h.reads, disposedReads);
});

test('same-task Compare levels remain available and historical resource URLs never choose another task', async () => {
  const h = harness({ fetch: async url => {
    const input = JSON.parse(new URL(url).searchParams.get('input'))[0].json;
    return new Response(JSON.stringify([{ result: { data: { json: payload(input.currentReviewActionId, input.referenceReviewActionId) } } }]));
  } });
  h.native.availableReviewActions.push({ id: 'older', level: 0 });
  h.event();
  await h.settle();
  assert.equal(h.fetches.length, 1);
  assert.match(decodeURIComponent(h.fetches[0]), /older/);
  h.native.payload = payload('task', 'older'); h.native.selectedCompareActionId = 'older';
  h.event(); await h.settle();
  assert.equal(h.calls.at(-1).selectedCompareActionId, 'older');
  h.performanceObservers[0].emit('https://babel.test/api/trpc/transcriptions.getTranscriptionDiff?input=old-unrelated-task');
  await h.settle();
  assert.equal(h.fetches.length, 1, 'same-task preloads are deduplicated and resource names do not supply ownership');
  h.window.location = new URL('https://babel.test/transcription/next?reviewActionId=next');
  h.native = { ...h.native, generation: 2, routeKey: '/transcription/next?reviewActionId=next', reviewActionId: 'next',
    selectedCompareActionId: 'comparison', availableReviewActions: [{ id: 'comparison', level: 1 }], payload: payload('next') };
  h.event('babel-helper:native-route-change'); await h.settle();
  assert.equal(h.calls.at(-1).currentReviewActionId, 'next');
  assert.equal(h.debug().diffCount, 1);
  h.helper.unbindExtendedDiffView();
});

test('unsupported native readiness and observer failures remain actionable without event-driven retries', async () => {
  for (const options of [{ read: () => ({ ok: false, reason: 'transcription-diff-query-not-found' }) }, { observeFailure: true }]) {
    const h = harness(options); await h.settle();
    const failure = h.document.getElementById('babel-helper-native-failure-Extended-diff-view');
    assert.ok(failure);
    assert.equal(failure.getAttribute('role'), 'alert');
    const action = name => failure.querySelectorAll('button')
      .find(button => name.test(button.getAttribute('aria-label') || button.textContent));
    const reload = action(/reload/i);
    assert.ok(reload, 'the failure exposes an accessible reload action');
    reload.dispatchEvent(new Event('click'));
    assert.equal(h.reloads, 1);
    const reads = h.reads; h.event(); h.mutation(); await h.settle();
    assert.equal(h.reads, reads);
    assert.equal(h.observers[0].connected, false);
    assert.equal(h.document.getElementById(failure.id), failure, 'failure events do not replace the alert');
    const dismiss = action(/dismiss/i);
    assert.ok(dismiss, 'the failure exposes an accessible dismiss action');
    dismiss.dispatchEvent(new Event('click'));
    assert.equal(h.document.getElementById(failure.id), null, 'dismiss removes the alert');
    h.native.status = 'ready';
    h.event(); h.mutation(); await h.settle();
    assert.equal(h.document.getElementById(failure.id), null, 'events do not restore a dismissed failure');
    assert.equal(h.reloads, 1, 'dismiss does not reload the page');
    assert.equal(h.reads, reads, 'dismiss does not restart failed automation');
    assert.equal(h.observers[0].connected, false);
    assert.equal(h.calls.length, 0, 'failed automation never applies a projection');
    assert.equal(h.fetches.length, 0, 'failed automation never falls back to network requests');
    h.helper.unbindExtendedDiffView();
  }
});

test('an in-flight native read cannot repaint after task navigation or teardown', async () => {
  let resolve;
  const h = harness({ read: () => new Promise(done => { resolve = done; }) });
  h.window.location = new URL('https://babel.test/queue');
  h.event('babel-helper:native-route-change'); await h.settle();
  resolve(h.native); await h.settle();
  assert.equal(h.calls.length, 0);
  h.helper.unbindExtendedDiffView();
  assert.equal(h.document.getElementById('bh-segmentation-mode-controls'), null);
});

test('same-route editor remount invalidates previous native projection identity', async () => {
  const h = harness(); await h.settle();
  assert.equal(h.calls.length, 1);
  h.native.editorGeneration = 2;
  h.event(); await h.settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls.at(-1).editorGeneration, 2);
  assert.equal(h.clears, 1);
  h.helper.unbindExtendedDiffView();
});

test('a commit arriving during native read supersedes the stale snapshot instead of applying then retrying', async () => {
  const pending = [];
  const h = harness({ read: native => {
    const snapshot = structuredClone(native);
    return new Promise(resolve => pending.push(() => resolve(snapshot)));
  } });
  h.native.editorGeneration = 2;
  h.event(); await h.settle();
  pending.shift()(); await h.settle();
  assert.equal(h.calls.length, 0);
  assert.equal(pending.length, 1, 'only the observed commit requests the next snapshot');
  pending.shift()(); await h.settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].editorGeneration, 2);
  h.helper.unbindExtendedDiffView();
});
