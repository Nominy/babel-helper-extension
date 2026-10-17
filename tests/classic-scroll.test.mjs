import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/content/classic-scroll.ts'], bundle: true,
  format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { createClassicScrollPolicy, isClassicNativeFollowEffect } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);

function fixture() {
  const events = new Map(), calls = [];
  const doc = { activeElement: null, defaultView: { matchMedia: () => ({ matches: true }), CSS: { escape: value => value }, getComputedStyle: () => ({ overflowY: 'auto' }) } };
  let rect = { top: 50, bottom: 80, height: 30 }, scrollTop = 0;
  const container = { ownerDocument: doc, get scrollTop() { return scrollTop; }, set scrollTop(value) { calls.push(value); scrollTop = value; }, scrollHeight: 1000, clientHeight: 200, clientTop: 0,
    dispatchEvent() { return true; },
    addEventListener: (name, callback) => events.set(name, callback),
    removeEventListener: name => events.delete(name),
    getBoundingClientRect: () => ({ top: 0, bottom: 200 }) };
  const row = { getAttribute: () => 'row', getBoundingClientRect: () => rect };
  const surface = { isConnected: true, parentElement: container,
    querySelector: selector => selector === 'thead' ? { getBoundingClientRect: () => ({ height: 20 }) } : row };
  const policy = createClassicScrollPolicy(); policy.setSurface(surface);
  return { policy, calls, container, doc, events, move(value) { rect = value; } };
}

test('Classic leaves near-start rows visible, centers reachable rows, and never follows paused restoration', () => {
  const h = fixture();
  h.policy.setPlaying(true); h.policy.follow('row');
  assert.equal(h.calls.length, 0);
  h.move({ top: 250, bottom: 280, height: 30 }); h.policy.follow('row');
  assert.equal(h.container.scrollTop, 155);
  h.events.get('scroll')(); // Own scroll event does not suspend subsequent follow.
  h.move({ top: 95, bottom: 125, height: 30 });
  h.policy.follow('row'); assert.equal(h.calls.length, 1, 'already centered is stable');
  h.policy.setPlaying(false); h.move({ top: 250, bottom: 280, height: 30 }); h.policy.follow('row');
  assert.equal(h.calls.length, 1);
  h.policy.release(); assert.equal(h.events.size, 0);
});

test('Classic centers visible later rows, clamps at the bottom, and leaves oversized visible rows readable', () => {
  const h = fixture();
  h.container.scrollTop = 200;
  h.policy.setPlaying(true);
  h.policy.follow('row');
  assert.equal(h.container.scrollTop, 155);
  h.events.get('scroll')();
  h.container.scrollTop = 790;
  h.move({ top: 150, bottom: 180, height: 30 });
  h.policy.follow('row');
  assert.equal(h.container.scrollTop, 800);
  h.events.get('scroll')();
  h.move({ top: -50, bottom: 250, height: 300 });
  h.policy.follow('row');
  assert.equal(h.container.scrollTop, 800);
});

test('textarea, input and contenteditable ownership suppress native follow', () => {
  const h = fixture(); h.policy.setPlaying(true); h.move({ top: 250, bottom: 280, height: 30 });
  for (const activeElement of [{ matches: selector => selector.includes('textarea') },
    { matches: selector => selector.includes('input') }, { isContentEditable: true }]) {
    h.doc.activeElement = activeElement; h.policy.follow('row');
  }
  assert.equal(h.calls.length, 0);
  h.doc.activeElement = null; h.policy.follow('row'); assert.equal(h.calls.length, 1);
});

test('manual wheel and scrollbar scrolling suspend follow until playback restarts', () => {
  for (const event of ['wheel', 'touchmove', 'scroll']) {
    const h = fixture(); h.policy.setPlaying(true); h.policy.follow('row');
    h.events.get(event)(); h.move({ top: 250, bottom: 280, height: 30 });
    h.policy.follow('row'); assert.equal(h.calls.length, 0);
    h.policy.setPlaying(false); h.policy.setPlaying(true); h.policy.follow('row');
    assert.equal(h.calls.length, 1);
  }
});

test('only the native panel follow dependency and callback contract is replaced', () => {
  function nativeFollow() { container.querySelector('[data-annotation-id="row"]');
    if (document.activeElement.isContentEditable) return;
    container.querySelector('thead'); container.scrollTo({ top: 0 }); }
  assert.equal(isClassicNativeFollowEffect(nativeFollow, ['row', { current: true }]), true);
  assert.equal(isClassicNativeFollowEffect(nativeFollow, ['row']), false);
  assert.equal(isClassicNativeFollowEffect(() => {}, ['row', { current: true }]), false);
});
