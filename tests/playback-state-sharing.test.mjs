import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/site/playback.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { createPlaybackSiteApi } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

function harness(t) {
  const saved = new Map(['window', 'document', 'CustomEvent', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const window = new EventTarget();
  let taskId = 'task-one';
  Object.assign(window, { __babelHelperPlaybackBridge: {}, location: new URL('https://babel.test/transcription/task'), setTimeout, clearTimeout });
  class Root extends EventTarget {
    isConnected = true;
    dataset = {};
    attributes = new Map([['data-babel-review-action-id', 'task-one']]);
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
  }
  const root = new Root();
  const document = { documentElement: root, location: window.location, hidden: false };
  root.ownerDocument = document;
  root.addEventListener('babel-helper:editor-control', event => {
    const request = JSON.parse(event.detail);
    if (request.operation !== 'session') return;
    root.setAttribute('data-babel-helper-editor-result', JSON.stringify({
      id: request.id, ok: true, reviewActionId: taskId, readOnly: false,
      routeKey: window.location.pathname + window.location.search
    }));
  });
  Object.assign(globalThis, {
    window, document, HTMLElement: Root,
    CustomEvent: class extends Event { constructor(type, options) { super(type); this.detail = options.detail; } }
  });
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const requests = [];
  window.addEventListener('babel-helper-playback-request', event => requests.push(event.detail));
  const helper = { state: { sessionLifecycleRevision: 1, nativeSessionAdmission: {
    href: window.location.href, reviewActionId: taskId, lifecycleRevision: 1
  } } };
  createPlaybackSiteApi(helper);
  return {
    helper, requests, root,
    task(value) { taskId = value; },
    admit(value) {
      taskId = value;
      helper.state.sessionLifecycleRevision++;
      helper.state.nativeSessionAdmission = {
        href: window.location.href, reviewActionId: taskId,
        lifecycleRevision: helper.state.sessionLifecycleRevision
      };
    },
    respond(index, state) {
      window.dispatchEvent(new CustomEvent('babel-helper-playback-response', { detail: { id: requests[index].id, result: state } }));
    }
  };
}

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('concurrent explicit command reads share only their in-flight native clock', async t => {
  const h = harness(t);
  const first = h.helper.getPlaybackState();
  assert.equal(h.helper.getPlaybackState(), first);
  await flush();
  assert.equal(h.requests.length, 1);
  h.respond(0, { ok: true, currentTime: 2, paused: false, playbackRate: 2 });
  assert.equal((await first).playbackRate, 2);
  const next = h.helper.getPlaybackState();
  await flush();
  assert.equal(h.requests.length, 2, 'no timed cache after settlement');
  h.respond(1, { ok: true, currentTime: 1, paused: true, playbackRate: 0.5 });
  assert.deepEqual(await next, { ok: true, currentTime: 1, paused: true, playbackRate: 0.5 });
});

test('seek dispatch does not wait for a pending command read or reuse its sample', async t => {
  const h = harness(t);
  const old = h.helper.getPlaybackState();
  const seek = h.helper.seekPlaybackBySeconds(3);
  const next = h.helper.getPlaybackState();
  await flush();
  assert.deepEqual(h.requests.map(request => request.operation), ['state', 'seek', 'state']);
  h.respond(0, { ok: true, currentTime: 1 });
  h.respond(1, { ok: true });
  h.respond(2, { ok: true, currentTime: 4 });
  assert.equal((await old).currentTime, 1);
  assert.equal(await seek, true);
  assert.equal((await next).currentTime, 4);
});

test('same-route task switches and lifecycle retirement reject delayed samples', async t => {
  const h = harness(t);
  const old = h.helper.getPlaybackState();
  await flush();
  h.task('task-two');
  const next = h.helper.getPlaybackState();
  await flush();
  h.respond(0, { ok: true, currentTime: 19 });
  assert.equal((await old).ok, false);
  h.respond(1, { ok: true, currentTime: 0 });
  assert.equal((await next).currentTime, 0);
  const retiring = h.helper.getPlaybackState();
  await flush();
  h.helper.state.sessionLifecycleRevision++;
  h.respond(2, { ok: true, currentTime: 20 });
  assert.equal((await retiring).ok, false);
});

test('native subscriptions reject hidden, stale source, task, lifecycle and subscription samples', async t => {
  const h = harness(t);
  const received = [];
  const release = h.helper.subscribePlayback(sample => received.push(sample));
  await flush();
  const subscription = h.requests.find(request => request.operation === 'subscribe');
  h.respond(h.requests.indexOf(subscription), { ok: true });
  const publish = (sample, detail = {}) => window.dispatchEvent(new CustomEvent('babel-helper-playback-sample', {
    detail: { ...subscription.payload, sample: { ok: true, paused: false, currentTime: 1, reviewActionId: 'task-one',
      recordingTracks: [{ id: 'recording-one', label: 'Speaker 1' }], sourceRevision: 2, ...sample }, ...detail }
  }));
  publish({});
  assert.equal(received.length, 1);
  document.hidden = true;
  publish({ currentTime: 8 });
  document.hidden = false;
  publish({ currentTime: 3, sourceRevision: 1 });
  publish({ currentTime: 4 }, { subscriptionId: 'retired' });
  publish({ currentTime: 5 }, { lifecycleRevision: 0 });
  assert.equal(received.length, 1);
  publish({ currentTime: 9, sourceRevision: 3 });
  assert.equal(received.at(-1).currentTime, 9);
  h.helper.state.sessionLifecycleRevision++;
  publish({ currentTime: 10 });
  assert.equal(received.length, 2);
  assert.equal(h.requests.at(-1).operation, 'unsubscribe');
  release();
  assert.equal(h.requests.filter(request => request.operation === 'state').length, 0);
});

test('subscription setup failure is visible and terminal without poll fallback', async t => {
  const h = harness(t);
  const received = [];
  const failures = [];
  h.helper.reportPlaybackFailure = failure => failures.push(failure);
  h.helper.subscribePlayback(sample => received.push(sample));
  await flush();
  h.respond(0, { ok: false, reason: 'native-playback-subscription-failed', message: 'unsupported FiberRoot' });
  await flush();
  assert.equal(failures.length, 1);
  assert.equal(received[0].fatal, true);
  assert.equal(received[0].paused, null);
  assert.deepEqual(h.requests.map(request => request.operation), ['subscribe', 'unsubscribe']);
});

test('disposing a pending subscription releases it even after its late setup response', async t => {
  const h = harness(t);
  const received = [];
  const release = h.helper.subscribePlayback(sample => received.push(sample));
  await flush();
  release();
  h.respond(0, { ok: true });
  await flush();
  assert.equal(h.requests.filter(request => request.operation === 'unsubscribe').length, 2);
  const subscription = h.requests[0].payload;
  window.dispatchEvent(new CustomEvent('babel-helper-playback-sample', {
    detail: { ...subscription, sample: { ok: true, paused: false, currentTime: 3, reviewActionId: 'task-one', sourceRevision: 1 } }
  }));
  assert.equal(received.length, 0);
});

test('same-URL native task admission ignores stale Gold identity and owns a fresh subscription', async t => {
  const h = harness(t);
  const oldSamples = [];
  const releaseOld = h.helper.subscribePlayback(sample => oldSamples.push(sample));
  await flush();
  const oldRequest = h.requests[0];
  releaseOld();
  h.admit('task-two');
  assert.equal(h.root.getAttribute('data-babel-review-action-id'), 'task-one');
  const nextSamples = [];
  const releaseNext = h.helper.subscribePlayback(sample => nextSamples.push(sample));
  await flush();
  const nextRequest = h.requests.find(request => request.operation === 'subscribe' && request !== oldRequest);
  assert.equal(nextRequest.payload.reviewActionId, 'task-two');
  h.respond(h.requests.indexOf(nextRequest), { ok: true });
  h.respond(h.requests.indexOf(oldRequest), { ok: true });
  await flush();
  const publish = (request, currentTime) => window.dispatchEvent(new CustomEvent('babel-helper-playback-sample', {
    detail: { ...request.payload, sample: { ok: true, paused: false, currentTime,
      reviewActionId: request.payload.reviewActionId, sourceRevision: 1,
      recordingTracks: [{ id: 'recording-two', label: 'Speaker 2' }] } }
  }));
  publish(oldRequest, 99);
  publish(nextRequest, 4);
  assert.equal(oldSamples.length, 0);
  assert.equal(nextSamples.at(-1).currentTime, 4);
  assert.equal(h.requests.filter(request => request.operation === 'unsubscribe')
    .every(request => request.payload.subscriptionId === oldRequest.payload.subscriptionId), true);
  const state = h.helper.getPlaybackState();
  await flush();
  const stateRequest = h.requests.find(request => request.operation === 'state');
  assert.equal(stateRequest.payload.reviewActionId, 'task-two', 'explicit commands also bind live native identity');
  h.respond(h.requests.indexOf(stateRequest), { ok: true, currentTime: 5 });
  assert.equal((await state).currentTime, 5);
  releaseNext();
});

test('native playback refuses missing or stale session admission without dispatching', t => {
  const h = harness(t);
  h.helper.state.nativeSessionAdmission = null;
  assert.throws(() => h.helper.subscribePlayback(() => {}), /session admission/);
  h.helper.state.nativeSessionAdmission = {
    href: window.location.href, reviewActionId: 'retired-task', lifecycleRevision: 1
  };
  assert.throws(() => h.helper.subscribePlayback(() => {}), /session admission/);
  assert.equal(h.requests.length, 0);
});

test('missing native recording metadata stops subscription instead of requesting a transcript snapshot', async t => {
  const h = harness(t);
  const failures = [];
  h.helper.reportPlaybackFailure = failure => failures.push(failure);
  h.helper.subscribePlayback(() => {});
  await flush();
  h.respond(0, { ok: true });
  const subscription = h.requests[0].payload;
  window.dispatchEvent(new CustomEvent('babel-helper-playback-sample', {
    detail: { ...subscription, sample: { ok: true, paused: false, currentTime: 3,
      reviewActionId: 'task-one', sourceRevision: 1 } }
  }));
  assert.equal(failures[0].reason, 'native-playback-recording-metadata-unavailable');
  assert.equal(h.requests.at(-1).operation, 'unsubscribe');
});
