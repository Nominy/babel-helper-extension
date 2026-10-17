const animations = new WeakMap<HTMLElement, { cancel(): void }>();
const DURATION_MS = 100;
const START_EVENT = 'babel-helper:transcript-scroll-start';

export function cancelTranscriptScroll(container: HTMLElement | null) {
  if (container) animations.get(container)?.cancel();
}

export function isTranscriptScrollAnimating(container: HTMLElement) {
  return animations.has(container);
}

/** One deadline per movement; replacement and user input retire the old owner. */
export function scrollTranscriptTo(container: HTMLElement, requestedTop: number) {
  cancelTranscriptScroll(container);
  // MAIN-world follow and isolated-world Escape share one DOM scrollport.
  container.dispatchEvent(new Event(START_EVENT));
  const view = container.ownerDocument.defaultView;
  const target = Math.max(0, Math.min(container.scrollHeight - container.clientHeight, requestedTop));
  const start = container.scrollTop;
  if (!view || Math.abs(target - start) < 1) return;
  if (view.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    container.scrollTop = target;
    return;
  }
  const started = view.performance.now();
  let frame = 0;
  const cancel = () => {
    view.cancelAnimationFrame(frame);
    container.removeEventListener('wheel', cancel, true);
    container.removeEventListener('touchstart', cancel, true);
    container.removeEventListener('pointerdown', cancel, true);
    container.removeEventListener('keydown', cancel, true);
    container.removeEventListener(START_EVENT, cancel, true);
    if (animations.get(container) === animation) animations.delete(container);
  };
  const animation = { cancel };
  animations.set(container, animation);
  container.addEventListener('wheel', cancel, { passive: true, capture: true });
  container.addEventListener('touchstart', cancel, { passive: true, capture: true });
  container.addEventListener('pointerdown', cancel, true);
  container.addEventListener('keydown', cancel, true);
  container.addEventListener(START_EVENT, cancel, true);
  const tick = (now: number) => {
    if (animations.get(container) !== animation) return;
    if (!container.isConnected) { cancel(); return; }
    const progress = Math.min(1, Math.max(0, (now - started) / DURATION_MS));
    const eased = 1 - (1 - progress) ** 3;
    container.scrollTop = progress === 1 ? target : start + (target - start) * eased;
    if (progress === 1) cancel();
    else frame = view.requestAnimationFrame(tick);
  };
  frame = view.requestAnimationFrame(tick);
}
