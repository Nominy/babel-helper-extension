// Geometry only: the inert measurement node never receives focus, input, or
// model ownership. The captured native textarea remains the sole text control.
const METRICS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'fontStretch', 'fontKerning', 'fontFeatureSettings', 'fontVariationSettings', 'fontOpticalSizing',
  'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'textAlign', 'textAlignLast',
  'direction', 'unicodeBidi', 'tabSize', 'lineHeight', 'whiteSpace', 'textWrap', 'overflowWrap', 'wordBreak',
  'textRendering', 'textOrientation', 'writingMode', 'hyphens',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle'] as const;
const MAX_INPUTS = 8, MAX_RANGES = 128, MAX_RANGE_RECTS = 256;
type Box = { left: number; top: number; width: number; height: number };
type Geometry = {
  input: HTMLTextAreaElement;
  root: HTMLDivElement;
  node: Text;
  range: Range;
  marker: HTMLSpanElement | null;
  before: Text | null;
  after: Text | null;
  text: string | null;
  dirty: boolean;
  dimensions: number[];
  width: number;
  height: number;
  mirrorWidth: number;
  scrollbarLeft: number;
  rects: Map<string, Box[]>;
  // Built only for point hit testing, and discarded with the current text/layout.
  points: Float64Array | null;
  ancestors: Element[];
};
type Owner = {
  states: Map<HTMLTextAreaElement, Geometry>;
  mutations: MutationObserver;
  consume(records: MutationRecord[]): void;
  add(state: Geometry): void;
  release(state: Geometry): void;
};
const owners = new WeakMap<Document, Owner>();

function createOwner(document: Document): Owner {
  const view = document.defaultView!;
  const states = new Map<HTMLTextAreaElement, Geometry>();
  const ancestors = new Map<Element, Set<Geometry>>();
  const ownedNodes = new WeakSet<Node>();
  const cleanups: (() => void)[] = [];
  const dirtyAll = () => { for (const state of states.values()) state.dirty = true; };
  function listen(target: EventTarget, event: string, callback: EventListener, capture = false) {
    target.addEventListener(event, callback, capture);
    cleanups.push(() => target.removeEventListener(event, callback, capture));
  }
  function index(state: Geometry) {
    for (const element of state.ancestors) {
      const entries = ancestors.get(element)!;
      entries.delete(state);
      if (!entries.size) ancestors.delete(element);
    }
    state.ancestors = [];
    for (let element: Element | null = state.input; element; element = element.parentElement) {
      state.ancestors.push(element);
      let entries = ancestors.get(element);
      if (!entries) ancestors.set(element, entries = new Set());
      entries.add(state);
    }
  }
  function own(node: Node | null): boolean {
    for (; node; node = node.parentNode) if (ownedNodes.has(node)) return true;
    return false;
  }
  function stylesheet(node: Node): boolean {
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    return Boolean(element?.closest('style, link[rel~="stylesheet"]'));
  }
  function dirtyTarget(target: EventTarget | null) {
    for (const state of ancestors.get(target as Element) ?? []) state.dirty = true;
  }
  const resize = new ResizeObserver(entries => {
    for (const entry of entries) {
      const state = states.get(entry.target as HTMLTextAreaElement);
      if (state) state.dirty = true;
    }
  });
  const mutations = new MutationObserver(consume);
  function consume(records: MutationRecord[]) {
    let structure = false;
    for (const record of records) {
      // Mirror text, fallback markers and overlay styles must never invalidate
      // their own measurements. Only input ancestors can affect copied metrics.
      if (own(record.target)) continue;
      // Bridge request/results are transport metadata, not appearance. The
      // caret response itself writes this attribute on an input ancestor.
      if (record.type === 'attributes' && (record.attributeName === 'data-babel-helper-editor-result' ||
        record.attributeName === 'data-babel-helper-native-session')) continue;
      if (record.type === 'childList') {
        const changed: Node[] = [];
        for (let index = 0; index < record.addedNodes.length; index++) {
          const node = record.addedNodes[index];
          if (!own(node)) changed.push(node);
        }
        for (let index = 0; index < record.removedNodes.length; index++) {
          const node = record.removedNodes[index];
          if (!own(node)) changed.push(node);
        }
        if (!changed.length) continue;
        structure = true;
        if (stylesheet(record.target) || changed.some(node => stylesheet(node) ||
          (node.nodeType === 1 && Boolean((node as Element).querySelector('style, link[rel~="stylesheet"]'))))) dirtyAll();
        dirtyTarget(record.target);
      } else if (stylesheet(record.target)) dirtyAll();
      else if (record.type === 'attributes') dirtyTarget(record.target);
    }
    if (structure) {
      for (const state of [...states.values()]) {
        if (!state.input.isConnected) owner.release(state);
        else if (state.ancestors.some((element, position) =>
          element.parentElement !== (state.ancestors[position + 1] ?? null))) {
          index(state);
          state.dirty = true;
        }
      }
    }
  }
  const owner: Owner = {
    states, mutations, consume,
    add(state) {
      states.set(state.input, state);
      ownedNodes.add(state.root);
      index(state);
      resize.observe(state.input);
      document.body.appendChild(state.root);
    },
    release(state) {
      if (!states.delete(state.input)) return;
      resize.unobserve(state.input);
      for (const element of state.ancestors) {
        const entries = ancestors.get(element)!;
        entries.delete(state);
        if (!entries.size) ancestors.delete(element);
      }
      state.ancestors = [];
      state.rects.clear();
      state.points = null;
      state.root.remove();
      if (!states.size) {
        mutations.disconnect();
        resize.disconnect();
        for (const cleanup of cleanups) cleanup();
        owners.delete(document);
      }
    }
  };
  mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  listen(document, 'input', event => dirtyTarget(event.target), true);
  for (const event of ['focusin', 'focusout', 'transitionrun', 'transitionend', 'transitioncancel',
    'animationstart', 'animationend', 'animationcancel']) {
    listen(document, event, event => dirtyTarget(event.target), true);
  }
  listen(document, 'load', event => { if (event.target && stylesheet(event.target as Node)) dirtyAll(); }, true);
  listen(view, 'resize', dirtyAll);
  if (view.visualViewport) listen(view.visualViewport, 'resize', dirtyAll);
  if (document.fonts) {
    listen(document.fonts, 'loadingdone', dirtyAll);
    listen(document.fonts, 'loadingerror', dirtyAll);
  }
  const colorScheme = view.matchMedia('(prefers-color-scheme: dark)');
  listen(colorScheme, 'change', dirtyAll);
  return owner;
}

/** Release at native textarea replacement/unmount, even if the row survives. */
export function releaseClassicInputGeometry(input: HTMLTextAreaElement): void {
  const owner = owners.get(input.ownerDocument), state = owner?.states.get(input);
  if (state) owner!.release(state);
}

function prepare(input: HTMLTextAreaElement, text: string) {
  const document = input.ownerDocument;
  let owner = owners.get(document);
  // Consume synchronous style/DOM changes before their observer microtask.
  if (owner) owner.consume(owner.mutations.takeRecords());
  if (!input.isConnected) {
    releaseClassicInputGeometry(input);
    return null;
  }
  owner = owners.get(document);
  if (!owner) owners.set(document, owner = createOwner(document));
  let state = owner.states.get(input);
  if (!state) {
    const root = document.createElement('div'), node = document.createTextNode('');
    root.setAttribute('aria-hidden', 'true');
    root.inert = true;
    Object.assign(root.style, { all: 'initial', position: 'fixed', left: '0', top: '0',
      visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden', boxSizing: 'border-box',
      height: 'auto', minHeight: '0', maxHeight: 'none', minWidth: '0', maxWidth: 'none', margin: '0' });
    root.appendChild(node);
    state = { input, root, node, range: document.createRange(), marker: null, before: null, after: null,
      text: null, dirty: true, dimensions: [], width: 0, height: 0, mirrorWidth: 0, scrollbarLeft: 0,
      rects: new Map(), points: null, ancestors: [] };
    owner.add(state);
    // An active recording may have arbitrarily many live rows; keep only the
    // recently measured inputs, not one mirror/index for every visited row.
    if (owner.states.size > MAX_INPUTS) owner.release(owner.states.values().next().value!);
  } else {
    owner.states.delete(input);
    owner.states.set(input, state);
  }
  const rect = input.getBoundingClientRect();
  const dimensions = [input.clientWidth, input.clientHeight, input.offsetWidth, input.offsetHeight, input.clientLeft];
  if (dimensions.some((value, index) => value !== state.dimensions[index])) state.dirty = true;
  if (state.dirty) {
    const style = document.defaultView!.getComputedStyle(input);
    for (const key of METRICS) state.root.style[key] = style[key];
    const px = (value: string) => Number.parseFloat(value) || 0;
    const borderX = px(style.borderLeftWidth) + px(style.borderRightWidth);
    const borderY = px(style.borderTopWidth) + px(style.borderBottomWidth);
    const paddingX = px(style.paddingLeft) + px(style.paddingRight);
    const paddingY = px(style.paddingTop) + px(style.paddingBottom);
    state.width = px(style.width) + (style.boxSizing === 'border-box' ? 0 : paddingX + borderX);
    state.height = px(style.height) + (style.boxSizing === 'border-box' ? 0 : paddingY + borderY);
    const scrollbar = Math.max(0, input.offsetWidth - input.clientWidth - Math.round(borderX));
    state.mirrorWidth = state.width - scrollbar;
    state.scrollbarLeft = Math.max(0, input.clientLeft - Math.round(px(style.borderLeftWidth)));
    state.root.style.width = `${state.mirrorWidth}px`;
    state.dimensions = dimensions;
    state.dirty = false;
    state.rects.clear();
    state.points = null;
  }
  if (state.text !== text) {
    state.text = text;
    state.node.data = text || '\u200b';
    state.rects.clear();
    state.points = null;
  }
  // Positions and scrolling are viewport data, not text-layout invalidations.
  // Ratios also account for ancestor CSS zoom/scale without copying it twice.
  const scaleX = state.width ? rect.width / state.width : 1;
  const scaleY = state.height ? rect.height / state.height : scaleX;
  return { state, left: rect.left + (state.scrollbarLeft - input.scrollLeft) * scaleX,
    top: rect.top - input.scrollTop * scaleY, scaleX, scaleY };
}

function localRects(state: Geometry, start: number, end: number): Box[] {
  const key = `${start}:${end}`, cached = state.rects.get(key);
  if (cached) return cached;
  if (start === end && state.points) {
    const index = start * 3, top = state.points[index + 1];
    if (Number.isFinite(top)) return [{ left: state.points[index], top, width: 0, height: state.points[index + 2] }];
  }
  const { range, node, root } = state;
  range.setStart(node, start);
  range.setEnd(node, end);
  let rects = Array.from(range.getClientRects());
  if (!rects.length && start === end) {
    // Empty lines/end-of-text need an inline glyph, but its nodes are owned and
    // reused too. Restore the original Text node before another Range uses it.
    if (!state.marker) {
      const document = root.ownerDocument;
      state.marker = document.createElement('span');
      state.marker.style.all = 'unset';
      state.marker.textContent = '\u200b';
      state.before = document.createTextNode('');
      state.after = document.createTextNode('');
    }
    state.before!.data = node.data.slice(0, start);
    state.after!.data = node.data.slice(start);
    root.replaceChildren(state.before!, state.marker, state.after!);
    try { rects = [state.marker.getBoundingClientRect()]; }
    finally { root.replaceChildren(node); }
  }
  // A fixed mirror can still move with a transformed containing block. Read
  // its origin only for a new native measurement, never for a cached caret.
  const origin = state.root.getBoundingClientRect();
  const scale = state.mirrorWidth ? origin.width / state.mirrorWidth : 1;
  const boxes = rects.map(box => ({ left: (box.left - origin.left) / scale,
    top: (box.top - origin.top) / scale, width: box.width / scale, height: box.height / scale }));
  if (boxes.length <= MAX_RANGE_RECTS) {
    if (state.rects.size === MAX_RANGES) state.rects.delete(state.rects.keys().next().value!);
    state.rects.set(key, boxes);
  }
  return boxes;
}

export function classicTextRects(input: HTMLTextAreaElement, text: string, start: number, end = start): DOMRect[] {
  const measured = prepare(input, text);
  if (!measured) return [];
  const left = Math.max(0, Math.min(start, text.length)), right = Math.max(left, Math.min(end, text.length));
  return localRects(measured.state, left, right).map(box => new DOMRect(
    measured.left + box.left * measured.scaleX, measured.top + box.top * measured.scaleY,
    box.width * measured.scaleX || 1, box.height * measured.scaleY));
}

export function classicOffsetAtPoint(input: HTMLTextAreaElement, text: string, x: number, y: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const measured = prepare(input, text);
  if (!measured) return null;
  const { state } = measured;
  if (!state.points) {
    const points = new Float64Array((text.length + 1) * 3);
    points.fill(NaN);
    for (let offset = 0; offset <= text.length; offset++) {
      const box = localRects(state, offset, offset)[0];
      if (box) {
        const index = offset * 3;
        points[index] = box.left;
        points[index + 1] = box.top;
        points[index + 2] = box.height;
      }
    }
    state.points = points;
  }
  // Retain all native bidi visual positions: logical offsets need not increase
  // with x, and equal-distance ties must still choose the first logical offset.
  let nearest = 0, distance = Infinity;
  for (let offset = 0; offset <= text.length; offset++) {
    const index = offset * 3;
    const left = measured.left + state.points[index] * measured.scaleX;
    const top = measured.top + state.points[index + 1] * measured.scaleY;
    const height = state.points[index + 2] * measured.scaleY;
    const dy = y < top ? top - y : y > top + height ? y - top - height : 0;
    const next = dy * dy * 100 + (x - left) ** 2;
    if (next < distance) { distance = next; nearest = offset; }
  }
  return nearest;
}
