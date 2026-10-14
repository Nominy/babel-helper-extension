import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/site/playback.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { createPlaybackSiteApi } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

function harness(t) {
  const saved = new Map(['window', 'document', 'CustomEvent'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const window = new EventTarget();
  let taskId = 'task-one';
  Object.assign(window, { __babelHelperPlaybackBridge: {}, location: { href: 'https://babel.test/transcription/task' }, setTimeout, clearTimeout });
  Object.assign(globalThis, {
    window,
    document: { documentElement: { getAttribute: () => taskId } },
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
  const helper = { state: { sessionLifecycleRevision: 1 } };
  createPlaybackSiteApi(helper);
  return {
    helper, requests,
    task(value) { taskId = value; },
    respond(index, state) {
      window.dispatchEvent(new CustomEvent('babel-helper-playback-response', { detail: { id: requests[index].id, result: state } }));
    }
  };
}

const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('concurrent cursor and row reads share only their in-flight native clock', async t => {
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

test('seek dispatch does not wait for a pending poll or reuse its sample', async t => {
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
