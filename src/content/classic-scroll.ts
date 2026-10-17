// @ts-nocheck
import { cancelTranscriptScroll, isTranscriptScrollAnimating, scrollTranscriptTo } from '../services/transcript-scroll';
/** The native panel chooses the filtered active row and schedules this policy.
 * Manual scrolling suspends follow for the current playback run. Editing and
 * paused caret restoration never initiate a follow scroll. */
export function createClassicScrollPolicy() {
  let surface = null, container = null, playing = false, manual = false, expectedTop = null;
  const onScroll = () => {
    if (isTranscriptScrollAnimating(container)) return;
    if (expectedTop !== null && Math.abs(container.scrollTop - expectedTop) < 1) { expectedTop = null; return; }
    expectedTop = null;
    if (playing) manual = true;
  };
  const onIntent = () => { cancelTranscriptScroll(container); if (playing) manual = true; };
  function detach() {
    if (!container) return;
    cancelTranscriptScroll(container);
    container.removeEventListener('scroll', onScroll);
    container.removeEventListener('wheel', onIntent);
    container.removeEventListener('touchmove', onIntent);
    container = null;
    expectedTop = null;
  }
  return {
    setSurface(value) { surface = value; if (!value) detach(); },
    setPlaying(value) {
      if (playing !== value) manual = false;
      playing = value;
      if (!playing) cancelTranscriptScroll(container);
    },
    follow(id) {
      if (!surface?.isConnected) return;
      if (!container) {
        for (let node = surface.parentElement; node; node = node.parentElement) {
          if (/(auto|scroll)/.test(node.ownerDocument.defaultView.getComputedStyle(node).overflowY)) {
            container = node;
            container.addEventListener('scroll', onScroll, { passive: true });
            container.addEventListener('wheel', onIntent, { passive: true });
            container.addEventListener('touchmove', onIntent, { passive: true });
            break;
          }
        }
      }
      if (!container || !playing || manual || !id) return;
      const active = container.ownerDocument.activeElement;
      if (active && (active.isContentEditable || active.matches?.('textarea,input,select'))) return;
      const row = surface.querySelector(`[data-babel-classic-row="true"][data-annotation-id="${container.ownerDocument.defaultView.CSS.escape(id)}"]`);
      if (!row) return;
      const bounds = container.getBoundingClientRect(), rect = row.getBoundingClientRect();
      const header = surface.querySelector('thead')?.getBoundingClientRect().height ?? 0;
      const top = bounds.top + container.clientTop + header + 4, bottom = bounds.top + container.clientTop + container.clientHeight - 4;
      const centered = container.scrollTop + rect.top + rect.height / 2 - (top + bottom) / 2;
      let target = centered;
      if (centered < 0 || rect.height > bottom - top) {
        // Near the start, or within an oversized row, reveal only clipped edges.
        if (rect.top <= top && rect.bottom >= bottom || rect.top >= top && rect.bottom <= bottom) return;
        target = container.scrollTop + (rect.top < top || rect.height > bottom - top ? rect.top - top : rect.bottom - bottom);
      }
      target = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, target));
      if (Math.abs(target - container.scrollTop) < 1) return;
      expectedTop = target;
      scrollTranscriptTo(container, target);
    },
    release() { detach(); surface = null; }
  };
}

export function isClassicNativeFollowEffect(callback, dependencies) {
  if (dependencies?.length !== 2 || !(dependencies[0] == null || typeof dependencies[0] === 'string') ||
      !dependencies[1] || typeof dependencies[1].current !== 'boolean') return false;
  const source = Function.prototype.toString.call(callback);
  return source.includes('scrollTo') && source.includes('data-annotation-id') &&
    source.includes('isContentEditable') && source.includes('thead');
}
