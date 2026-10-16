import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  stdin: { contents: `
    export * from './src/content/classic-input-geometry';
    export { createClassicControls } from './src/content/classic-controls';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent',
  plugins: [{ name: 'owned-classic-controls', setup(build) {
    build.onResolve({ filter: /^@nominy\/babel-babel-runtime$/ }, () => ({ path: 'runtime', namespace: 'fixture' }));
    build.onResolve({ filter: /ui\/native-automation-failure$/ }, () => ({ path: 'failure', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'runtime' ? `
      export function registerBabelClassicInput(row, lease) {
        globalThis.classicGeometryLeases.set(row, lease);
        return () => globalThis.classicGeometryLeases.delete(row);
      }
      export function readBabelClassicInput(id) {
        const input = [...globalThis.classicGeometryLeases.values()].find(lease => lease.annotation.id === id);
        return input ? { input, readOnly: input.readOnly, annotation: input.annotation } : null;
      }
      export function flushBabelClassicInputs() { return true; }
      export function readBabelTranscriptBindings() { return null; }
    ` : 'export function showNativeAutomationFailure() { throw new Error("Unexpected native failure"); }' }));
  } }]
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);

// These fixtures provide browser-layout answers, not a glyph-width model. The
// browser smoke covers actual shaping; these tests exercise cache consumers and
// lifecycle/invalidation against controllable Range and event responses.
function fixture(t) {
  const installed = new Map(), mutationObservers = [], resizeObservers = [];
  const counters = { elements: 0, ranges: 0, styles: 0, measurements: 0 };
  function install(key, value) {
    installed.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  class Events {
    listeners = new Map();
    addEventListener(name, callback) {
      let callbacks = this.listeners.get(name);
      if (!callbacks) this.listeners.set(name, callbacks = new Set());
      callbacks.add(callback);
    }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    emit(type, target = this) { for (const callback of this.listeners.get(type) ?? []) callback({ type, target }); }
    get listenerCount() { return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); }
  }
  function record(mutation) {
    for (const observer of mutationObservers) {
      if (observer.target?.contains(mutation.target)) observer.records.push(mutation);
    }
  }
  class Node extends Events {
    children = [];
    parentNode = null;
    attributes = new Map();
    constructor(tagName, nodeType = 1) {
      super();
      this.tagName = tagName;
      this.nodeType = nodeType;
      this.style = new Proxy({}, { set: (target, key, value) => {
        target[key] = value;
        record({ type: 'attributes', target: this, attributeName: 'style' });
        return true;
      } });
    }
    get ownerDocument() { return doc; }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get isConnected() { return this === doc.documentElement || Boolean(this.parentNode?.isConnected); }
    get data() { return this._data ?? ''; }
    set data(value) { this._data = value; record({ type: 'characterData', target: this }); }
    set textContent(value) { this.replaceChildren(doc.createTextNode(value)); }
    appendChild(node) {
      node.remove();
      this.children.push(node); node.parentNode = this;
      record({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] });
      return node;
    }
    replaceChildren(...nodes) {
      for (const node of [...this.children]) node.remove();
      for (const node of nodes) this.appendChild(node);
    }
    remove() {
      const parent = this.parentNode;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null;
      record({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      record({ type: 'attributes', target: this, attributeName: name });
    }
    removeAttribute(name) {
      if (!this.attributes.delete(name)) return;
      record({ type: 'attributes', target: this, attributeName: name });
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    matches() { return this.tagName === 'style' || this.tagName === 'link' && this.getAttribute('rel') === 'stylesheet'; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    querySelector(selector) {
      for (const child of this.children) {
        if (child.nodeType === 1 && child.matches(selector)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    getBoundingClientRect() {
      if (this.tagName === 'textarea') return { ...this.rect };
      if (this.tagName === 'span') return { ...doc.markerRect };
      return { left: 0, top: 0, width: Number.parseFloat(this.style.width) || 100, height: 80 };
    }
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  }
  class MutationObserver {
    records = [];
    constructor(callback) { this.callback = callback; mutationObservers.push(this); }
    observe(target) { this.target = target; }
    takeRecords() { return this.records.splice(0); }
    disconnect() { this.target = null; this.records = []; }
  }
  class ResizeObserver {
    targets = new Set();
    constructor(callback) { this.callback = callback; resizeObservers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const view = new Events(), fonts = new Events(), media = new Events();
  view.visualViewport = new Events();
  view.matchMedia = () => media;
  view.getComputedStyle = input => { counters.styles++; return input.computed; };
  const doc = Object.assign(new Events(), {
    defaultView: view, fonts,
    createElement(name) { counters.elements++; return new Node(name); },
    createTextNode(text) { const node = new Node('#text', 3); node.data = text; return node; },
    createRange() {
      counters.ranges++;
      return {
        setStart(node, offset) { this.node = node; this.start = offset; },
        setEnd(node, offset) { assert.equal(node, this.node); this.end = offset; },
        getClientRects() {
          counters.measurements++;
          assert.equal(this.node.parentNode?.children.length, 1, 'fallback markers never split the owned Text node');
          return doc.layout(this.node.data, this.start, this.end, this.node.parentNode.style);
        }
      };
    },
    layout: () => [{ left: 11, top: 5, width: 0, height: 18 }],
    markerRect: { left: 2, top: 30, width: 0, height: 18 }
  });
  doc.documentElement = new Node('html');
  doc.body = new Node('body'); doc.documentElement.appendChild(doc.body);
  install('MutationObserver', MutationObserver);
  install('ResizeObserver', ResizeObserver);
  install('DOMRect', class { constructor(left, top, width, height) { Object.assign(this, { left, top, width, height }); } });
  install('document', doc); install('window', view);
  install('classicGeometryLeases', new Map());
  const inputs = [], cleanups = [];
  function input(text = 'sample') {
    const input = doc.createElement('textarea');
    input.value = text; input.scrollLeft = 0; input.scrollTop = 0;
    input.clientWidth = 100; input.clientHeight = 80; input.offsetWidth = 100; input.offsetHeight = 80; input.clientLeft = 0;
    input.rect = { left: 100, top: 50, width: 100, height: 80 };
    input.computed = { width: '100px', height: '80px', boxSizing: 'border-box',
      fontSize: '16px', whiteSpace: 'pre-wrap', direction: 'ltr',
      borderLeftWidth: '0px', borderRightWidth: '0px', borderTopWidth: '0px', borderBottomWidth: '0px',
      paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px' };
    input.setSelectionRange(1, 4, 'backward');
    doc.body.appendChild(input); inputs.push(input);
    return input;
  }
  t.after(() => {
    for (const cleanup of cleanups) cleanup();
    for (const input of inputs) api.releaseClassicInputGeometry(input);
    for (const [key, descriptor] of installed) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return { doc, view, fonts, media, input, counters, mutationObservers, resizeObservers, cleanups,
    mirrors: () => doc.body.children.filter(node => node.getAttribute('aria-hidden') === 'true'),
    flush() { for (const observer of mutationObservers) if (observer.target) observer.callback(observer.takeRecords()); }
  };
}

test('repeated caret requests reuse native layout and translate current scrolling without touching selection', t => {
  const f = fixture(t), input = f.input();
  assert.deepEqual({ ...api.classicTextRects(input, input.value, 2)[0] }, { left: 111, top: 55, width: 1, height: 18 });
  const mirror = f.mirrors()[0], work = { ...f.counters };
  input.rect.left = 300; input.rect.top = 80; input.scrollLeft = 7; input.scrollTop = 11;
  for (let index = 0; index < 20; index++) {
    assert.deepEqual({ ...api.classicTextRects(input, input.value, 2)[0] }, { left: 304, top: 74, width: 1, height: 18 });
  }
  assert.deepEqual(f.counters, work);
  assert.equal(f.mirrors()[0], mirror);
  assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [1, 4, 'backward']);
  input.rect.width = 200; input.rect.height = 160;
  assert.deepEqual({ ...api.classicTextRects(input, input.value, 2)[0] }, { left: 308, top: 68, width: 1, height: 36 });
  assert.deepEqual(f.counters, work, 'ancestor scale changes only transform cached local coordinates');
});

test('text, native input and layout signals invalidate the real geometry consumer', t => {
  const f = fixture(t), input = f.input('first');
  f.doc.layout = (text, start, end, style) => [{ left: Number.parseFloat(style.fontSize) + (text === 'second' ? 20 : 0),
    top: style.direction === 'rtl' ? 30 : 5, width: 0, height: 18 }];
  const rect = () => api.classicTextRects(input, input.value, 1)[0];
  assert.equal(rect().left, 116);
  input.value = 'second';
  assert.equal(rect().left, 136);
  assert.equal(f.counters.styles, 1, 'new text reuses unchanged copied typography');
  const invalidations = [
    () => f.doc.emit('input', input),
    () => input.setAttribute('style', 'font-size: 17px'),
    () => f.doc.body.setAttribute('data-appearance', 'large'),
    () => { input.clientWidth = 90; },
    () => { for (const observer of f.resizeObservers) observer.callback([{ target: input }]); },
    () => f.fonts.emit('loadingdone'),
    () => f.fonts.emit('loadingerror'),
    () => f.view.emit('resize'),
    () => f.view.visualViewport.emit('resize'),
    () => f.media.emit('change'),
    () => { const style = f.doc.createElement('style'); style.textContent = 'textarea { font-size: 25px }'; f.doc.body.appendChild(style); },
    () => { f.doc.body.querySelector('style').children[0].data = 'textarea { font-size: 26px }'; },
    () => input.setAttribute('wrap', 'off'),
    () => input.setAttribute('dir', 'rtl')
  ];
  for (const invalidate of invalidations) {
    const reads = f.counters.styles, measurements = f.counters.measurements;
    input.computed.fontSize = `${17 + reads}px`;
    invalidate();
    assert.equal(rect().left, 137 + reads);
    assert.equal(f.counters.styles, reads + 1);
    assert.equal(f.counters.measurements, measurements + 1);
  }
  input.computed.direction = 'rtl'; input.computed.whiteSpace = 'pre'; input.setAttribute('class', 'rtl-nowrap');
  assert.equal(rect().top, 80);
  assert.equal(f.mirrors()[0].style.direction, 'rtl');
  assert.equal(f.mirrors()[0].style.whiteSpace, 'pre');
});

test('mirror and unrelated overlay mutations do not invalidate copied layout', t => {
  const f = fixture(t), input = f.input();
  const overlay = f.doc.createElement('div'); f.doc.body.appendChild(overlay);
  api.classicTextRects(input, input.value, 2);
  const work = { ...f.counters };
  overlay.style.left = '100px'; overlay.style.top = '200px';
  f.mirrors()[0].style.width = '100px';
  f.flush();
  api.classicTextRects(input, input.value, 2);
  assert.deepEqual(f.counters, work);
});

test('bridge result roundtrips on rows and html keep the caret layout cache warm', t => {
  const f = fixture(t), input = f.input(), row = f.doc.createElement('tr');
  f.doc.body.appendChild(row); row.appendChild(input);
  const requestCaret = id => {
    row.removeAttribute('data-babel-helper-editor-result');
    const rect = api.classicTextRects(input, input.value, 2)[0];
    row.setAttribute('data-babel-helper-editor-result', JSON.stringify({ id, ok: true, rect }));
    const result = JSON.parse(row.getAttribute('data-babel-helper-editor-result'));
    row.removeAttribute('data-babel-helper-editor-result');
    return result.rect;
  };
  const expected = requestCaret(0), work = { ...f.counters };
  for (let id = 1; id <= 20; id++) {
    // Batch identity/session publication targets html, which is also indexed
    // as an ancestor. Both async delivery and synchronous takeRecords matter.
    f.doc.documentElement.setAttribute('data-babel-helper-editor-result', JSON.stringify({ id, rows: [] }));
    f.doc.documentElement.removeAttribute('data-babel-helper-editor-result');
    f.doc.documentElement.setAttribute('data-babel-helper-native-session', JSON.stringify({ generation: id }));
    if (id % 2) f.flush();
    assert.deepEqual(requestCaret(id), expected);
  }
  assert.deepEqual(f.counters, work, 'transport writes perform no CSS reads, native range measurements or mirror allocations');
  row.setAttribute('data-appearance', 'large');
  requestCaret(21);
  assert.equal(f.counters.styles, work.styles + 1, 'real ancestor appearance changes still invalidate');
  assert.equal(f.counters.measurements, work.measurements + 1);
});

test('point lookup caches native bidi/wrapped fragments and preserves logical tie order after scrolling', t => {
  const f = fixture(t), input = f.input('abcd');
  const positions = [[30, 0], [10, 0], [20, 0], [0, 30], [20, 30]];
  f.doc.layout = (_text, offset) => [{ left: positions[offset][0], top: positions[offset][1], width: 0, height: 18 }];
  assert.equal(api.classicOffsetAtPoint(input, input.value, 110, 55), 1);
  const work = { ...f.counters };
  assert.equal(api.classicOffsetAtPoint(input, input.value, 120, 85), 4);
  assert.equal(api.classicOffsetAtPoint(input, input.value, 125, 55), 0, 'equidistant bidi positions choose first logical offset');
  input.scrollTop = 20; input.scrollLeft = -5;
  assert.equal(api.classicOffsetAtPoint(input, input.value, 125, 65), 4);
  assert.equal(api.classicTextRects(input, input.value, 4)[0].top, 60);
  assert.deepEqual(f.counters, work);
  assert.equal(api.classicOffsetAtPoint(input, input.value, NaN, 0), null);
});

test('RTL scrollbar gutters shift local geometry without changing cached native offsets', t => {
  const f = fixture(t), input = f.input('rtl');
  input.clientWidth = 85; input.clientLeft = 15; input.computed.direction = 'rtl';
  assert.equal(api.classicTextRects(input, input.value, 1)[0].left, 126);
  assert.equal(f.mirrors()[0].style.width, '85px');
  const work = { ...f.counters };
  input.scrollLeft = -20;
  assert.equal(api.classicTextRects(input, input.value, 1)[0].left, 146);
  assert.deepEqual(f.counters, work);
});

test('empty-line fallback restores reusable text and keeps its marker owned', t => {
  const f = fixture(t), input = f.input('a\n');
  f.doc.layout = (_text, start) => start === 2 ? [] : [{ left: 4, top: 0, width: 0, height: 18 }];
  assert.equal(api.classicTextRects(input, input.value, 2)[0].top, 80);
  const mirror = f.mirrors()[0], work = { ...f.counters };
  assert.equal(mirror.children.length, 1);
  assert.equal(mirror.children[0].data, 'a\n');
  api.classicTextRects(input, input.value, 2);
  assert.deepEqual(f.counters, work);
  assert.equal(api.classicTextRects(input, input.value, 0)[0].left, 104);
  assert.equal(api.classicOffsetAtPoint(input, input.value, 102, 85), 2);
  input.value = '';
  f.doc.layout = () => [];
  assert.equal(api.classicTextRects(input, '', 0)[0].top, 80);
  assert.equal(f.counters.elements, work.elements, 'empty text reuses the fallback span');
});

test('range and live-input caches evict old work and release all observers on disposal or detach', t => {
  const f = fixture(t), input = f.input('x'.repeat(300));
  for (let offset = 0; offset < 140; offset++) api.classicTextRects(input, input.value, offset);
  let measured = f.counters.measurements;
  api.classicTextRects(input, input.value, 139);
  assert.equal(f.counters.measurements, measured);
  api.classicTextRects(input, input.value, 0);
  assert.equal(f.counters.measurements, measured + 1, 'old offset ranges do not accumulate forever');
  const inputs = [input];
  for (let index = 0; index < 9; index++) {
    const next = f.input(); inputs.push(next); api.classicTextRects(next, next.value, 0);
  }
  assert.equal(f.mirrors().length, 8);
  assert.equal(f.resizeObservers.flatMap(observer => [...observer.targets]).length, 8);
  for (const input of inputs) input.remove();
  f.flush();
  assert.equal(f.mirrors().length, 0);
  assert.ok(f.mutationObservers.every(observer => observer.target === null));
  assert.ok(f.resizeObservers.every(observer => observer.targets.size === 0));
  assert.equal(f.doc.listenerCount + f.view.listenerCount + f.fonts.listenerCount + f.media.listenerCount + f.view.visualViewport.listenerCount, 0);
  assert.deepEqual(api.classicTextRects(input, input.value, 0), []);
  assert.equal(api.classicOffsetAtPoint(input, input.value, 1, 1), null);
  const remounted = f.input();
  api.classicTextRects(remounted, remounted.value, 0);
  assert.equal(f.mirrors().length, 1);
  api.releaseClassicInputGeometry(remounted);
  api.releaseClassicInputGeometry(remounted);
  assert.equal(f.mirrors().length, 0);
  assert.equal(f.doc.listenerCount, 0);
});

function hooks() {
  let cursor = 0;
  const slots = [], pending = [];
  const React = {
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useLayoutEffect(callback, deps) {
      const index = cursor++, previous = slots[index];
      if (!deps || !previous || deps.some((value, at) => value !== previous.deps[at])) {
        pending.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; });
      }
    }
  };
  return { React, render(callback) { cursor = 0; callback(); for (const effect of pending.splice(0)) effect(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

test('Classic controls release textarea replacement, row unmount and controller disposal without changing backward selections', t => {
  const f = fixture(t), react = hooks(), first = f.input('sample'), row = f.doc.createElement('tr');
  f.doc.body.appendChild(row); row.appendChild(first);
  const binding = { annotation: { id: 'turn', content: 'sample' }, text: 'sample', readOnly: false,
    rootRef: { current: row }, inputRef: { current: first }, cancel() {} };
  const context = { reviewActionId: 'task', flushSync: callback => callback(), transcriptProps: { handlers: {} } };
  const controls = api.createClassicControls(react.React, () => context);
  f.cleanups.push(() => controls.release());
  react.render(() => controls.useRow(binding));
  const lease = globalThis.classicGeometryLeases.get(row);
  lease.rects(2);
  assert.equal(f.mirrors().length, 1);
  const second = f.input('sample'); row.appendChild(second); binding.inputRef.current = second;
  react.render(() => controls.useRow(binding));
  assert.equal(f.mirrors().length, 0, 'ref replacement releases the prior live textarea before another request');
  lease.rects(2);
  assert.equal(f.mirrors().length, 1);
  assert.equal(lease.read().direction, 'backward');
  controls.release();
  assert.equal(f.mirrors().length, 0);
  assert.equal(globalThis.classicGeometryLeases.size, 0);
  react.unmount();
  assert.equal(f.doc.listenerCount + f.view.listenerCount, 0);

  const nextHooks = hooks(), nextControls = api.createClassicControls(nextHooks.React, () => context);
  f.cleanups.push(() => nextControls.release());
  nextHooks.render(() => nextControls.useRow(binding));
  globalThis.classicGeometryLeases.get(row).rects(1);
  assert.equal(f.mirrors().length, 1);
  nextHooks.unmount();
  assert.equal(f.mirrors().length, 0, 'row unmount releases geometry even while the controller stays mounted');
});
