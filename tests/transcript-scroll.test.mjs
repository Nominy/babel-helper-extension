import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({ entryPoints: ['src/services/transcript-scroll.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`;
const { scrollTranscriptTo, isTranscriptScrollAnimating } = await import(moduleUrl);
const isolated = await import(`${moduleUrl}#isolated-world`);
function fixture() {
  let now = 0, next = 0;
  const frames = new Map(), events = new Map();
  const view = { performance: { now: () => now }, matchMedia: () => ({ matches: false }),
    requestAnimationFrame(fn) { const id = ++next; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); } };
  const container = { ownerDocument: { defaultView: view }, isConnected: true, scrollTop: 0, scrollHeight: 1000, clientHeight: 200,
    dispatchEvent(event) { events.get(event.type)?.(event); return true; },
    addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } };
  return { container, frames, events, frame(time) { now = time; const queued = [...frames.values()]; frames.clear(); queued.forEach(fn => fn(time)); } };
}
test('scroll eases toward its target and finishes at the original 100 ms deadline', () => {
  const h = fixture(); scrollTranscriptTo(h.container, 400);
  h.frame(50); assert.equal(h.container.scrollTop, 350);
  assert.equal(isTranscriptScrollAnimating(h.container), true);
  h.frame(100); assert.equal(h.container.scrollTop, 400);
  assert.equal(h.frames.size, 0); assert.equal(h.events.size, 0);
  scrollTranscriptTo(h.container, 700); h.frame(350);
  assert.equal(h.container.scrollTop, 700, 'a delayed frame finishes rather than restarting the duration');
  assert.equal(h.frames.size, 0);
});
test('a replacement cancels the old target and input immediately stops further movement', () => {
  const h = fixture(); scrollTranscriptTo(h.container, 400); h.frame(50);
  const stale = [...h.frames.values()][0];
  scrollTranscriptTo(h.container, 200); stale(100);
  assert.equal(h.container.scrollTop, 350);
  h.frame(100); assert.equal(h.container.scrollTop, 218.75);
  h.events.get('wheel')(); h.frame(150);
  assert.equal(h.container.scrollTop, 218.75);
  assert.equal(isTranscriptScrollAnimating(h.container), false);
  assert.equal(h.events.size, 0);
});
test('detached scrollports stop and reduced motion applies the bounded target immediately', () => {
  const h = fixture(); scrollTranscriptTo(h.container, 400);
  h.container.isConnected = false; h.frame(25);
  assert.equal(h.container.scrollTop, 0); assert.equal(h.frames.size, 0);
  h.container.isConnected = true;
  h.container.ownerDocument.defaultView.matchMedia = () => ({ matches: true });
  scrollTranscriptTo(h.container, 1200);
  assert.equal(h.container.scrollTop, 800); assert.equal(h.frames.size, 0);
});
test('separate execution worlds replace each other rather than fighting over the scrollport', () => {
  const h = fixture(); scrollTranscriptTo(h.container, 400); h.frame(50);
  isolated.scrollTranscriptTo(h.container, 100);
  assert.equal(isTranscriptScrollAnimating(h.container), false);
  h.frame(150);
  assert.equal(h.container.scrollTop, 100);
  assert.equal(isolated.isTranscriptScrollAnimating(h.container), false);
  assert.equal(h.frames.size, 0);
});
