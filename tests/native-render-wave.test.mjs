import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import ts from 'typescript';
import { nativeFactorySource } from './fixtures/native-factory-source.mjs';

const bundle = await build({ entryPoints: ['src/content/native-render-wave.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
const { createNativeWaveAdapters } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
function nativeClass(id) {
  const exports = {};
  const require = () => { throw new Error('Unexpected native dependency'); };
  require.d = (target, entries) => { for (const [key, value] of Object.entries(entries)) Object.defineProperty(target, key, { get: value }); };
  // Only the test oracle evaluates captured native source.
  new Function(`return (${nativeFactorySource(id)})`)()({}, exports, require);
  return exports.Z;
}
function nativeNode(id, accepts) {
  const ast = ts.createSourceFile('native.js', nativeFactorySource(id), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [];
  const visit = node => { if (accepts(node, node.getText(ast))) matches.push(node.getText(ast)); ts.forEachChild(node, visit); };
  visit(ast);
  assert.ok(matches.length, 'Captured native boundary exists');
  return matches.sort((left, right) => left.length - right.length)[0];
}
const createSource = nativeNode(59327, (node, text) => ts.isArrowFunction(node) && text.includes('onTimeUpdate') && text.includes('onReady') && text.includes('wavesurfer:') && text.includes('regions:'));
const timeSource = nativeNode(59327, (node, text) => ts.isArrowFunction(node) && text.includes('recordTime') && text.includes('getRegions'));
const styleSource = nativeNode(59327, (node, text) => ts.isArrowFunction(node) && text.includes('getRegions') && text.includes('brightness(0.8)'));
const scrollSource = nativeNode(99407, node => ts.isMethodDeclaration(node) && node.name.getText() === 'scrollIntoView');
const nativeScroll = new Function(`return ({${scrollSource}}).scrollIntoView`)();
function evaluate(source, scope) { return new Function(...Object.keys(scope), `return (${source})`)(...Object.values(scope)); }

class Emitter {
  listeners = new Map();
  on(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
    return () => this.listeners.get(name).delete(callback);
  }
  once(name, callback) { const release = this.on(name, (...args) => { release(); callback(...args); }); return release; }
  emit(name, ...args) { for (const callback of this.listeners.get(name) || []) callback(...args); }
  count(name) { return this.listeners.get(name)?.size || 0; }
}
class Element {
  style = { setProperty(name, value) { this[name] = value; } };
  children = [];
  attributes = {};
  clientWidth = 1000;
  scrollWidth = 1000;
  parentElement = null;
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  appendChild(element) { element.remove(); element.parentElement = this; this.children.push(element); return element; }
  removeChild(element) { element.remove(); }
  remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
  cloneNode() { const element = new Element(); Object.assign(element.style, this.style); return element; }
  getBoundingClientRect() { return { left: 0, right: this.clientWidth, width: this.clientWidth, height: 20 }; }
}
let globals;
beforeEach(() => {
  globals = new Map(['document', 'Node', 'HTMLElement', 'matchMedia'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  globalThis.Node = Element;
  globalThis.HTMLElement = Element;
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.document = { createElement: () => new Element(), createElementNS: () => new Element(), documentElement: new Element(), addEventListener() {}, removeEventListener() {} };
});
afterEach(() => { for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const defer = () => new Promise(resolve => setTimeout(resolve, 5));
function waveFixture() {
  const wave = new Emitter(), wrapper = new Element();
  return Object.assign(wave, { left: 0, width: 100, duration: 100,
    getWrapper: () => wrapper, getDuration() { return this.duration; }, getWidth() { return this.width; }, getScroll() { return this.left; },
    getDecodedData: () => ({ numberOfChannels: 1 }), getCurrentTime: () => 0, play() {},
    getVolume: () => 1, isPlaying: () => true
  });
}
function addRegion(plugin, id, start, end) { return plugin.addRegion({ id, start, end, drag: false, resize: false }); }
function notice(notices, boundary, state) { return notices.some(value => value.boundary === boundary && value.state === state); }

// The harness isolates browser/media construction; real captured region and timeline
// constructors and the renderer method still execute unchanged inside the adapters.
class WaveHarness extends Emitter {
  static creates = 0;
  static create(options) { this.creates++; return new WaveHarness(options); }
  constructor(options) {
    super(); Object.assign(this, waveFixture()); this.options = options;
    this.renderer = { scrollContainer: { scrollLeft: 0, clientWidth: 100, scrollWidth: 1000 }, options, isDragging: false, scrollIntoView: nativeScroll };
    for (const plugin of options.plugins) if (plugin.getRegions) this.registerPlugin(plugin);
  }
  registerPlugin(plugin) { plugin._init(this); return plugin; }
  getDuration() { return this.duration; }
  getCurrentTime() { return 0; }
  getWrapper() { return this.wrapper; }
  destroy() { for (const plugin of this.options.plugins) plugin.destroy?.(); this.emit('destroy'); }
}
function editorFixture(adapter, timeOverride) {
  const Regions = nativeClass(94846), Timeline = nativeClass(60039), tracks = { current: {} }, effects = [];
  const scope = { e11: tracks, n11: updater => effects.push(['state', typeof updater]),
    t6: adapter.adaptImport({ Z: Regions }), t7: adapter.adaptImport({ Z: Timeline }), t4: adapter.adaptImport({ Z: WaveHarness }),
    ne: { Z: { create: () => ({}) } }, t8: { Z: { create: () => ({}) } }, t9: { Z: { create: () => ({}) } },
    y: () => () => {}, nt: () => ({}), nn: track => ({ id: track.id }) };
  const nativeCreate = evaluate(createSource, scope), create = adapter.adaptCallback(nativeCreate);
  const excluded = { id: 'loop', prefix: 'overlay-' };
  const nativeTime = timeOverride || evaluate(timeSource, { e11: { id: 'track' }, ng2: tracks.current, $2: ['track'],
    tF2: { update: time => effects.push(['clock', time]) }, tC2: { recordTime: (...args) => effects.push(['coverage', ...args]) },
    _: 'loop', t5: id => id.startsWith(excluded.prefix), eA2: (...args) => effects.push(['active', ...args]),
    ev2: time => effects.push(['loop', time]), tb2: { seekAllTracksToTime() {} } });
  const handlers = { onReady() { effects.push(['ready', this === handlers]); }, onTimeUpdate: nativeTime };
  const track = { id: 'track', colors: { wave: 'blue', progress: 'red', region: 'gray' }, audioUrl: '/native.wav' };
  const result = create(track, new Element(), handlers, null, 150, true, 150);
  const nativeStyle = evaluate(styleSource, { a11: (...args) => effects.push(['setter', ...args]), r10: () => tracks.current });
  return { result, plugin: result.plugins.regions, wave: result.wavesurfer, create, nativeCreate, handlers, nativeTime,
    style: adapter.adaptCallback(nativeStyle), nativeStyle, effects, excluded, tracks };
}

test('factory-local native class facades preserve constructors, initialization and unrelated exports', async () => {
  const notices = [], adapter = createNativeWaveAdapters(value => notices.push(value));
  const Regions = nativeClass(94846), Timeline = nativeClass(60039);
  const regionsPrototype = Regions.prototype.virtualAppend, timelinePrototype = Timeline.prototype.updateVisibleNotches;
  const exports = Object.freeze({ renamedRegions: Regions, unrelated: () => 'native' });
  const facade = adapter.adaptImport(exports);
  assert.notEqual(facade, exports);
  assert.equal(adapter.adaptImport(exports), facade);
  assert.equal(facade.unrelated, exports.unrelated);
  const plugin = facade.renamedRegions.create({ custom: 'untouched' });
  const constructed = new facade.renamedRegions({ other: true });
  assert.ok(plugin instanceof Regions);
  assert.ok(constructed instanceof Regions);
  assert.equal(plugin.options.custom, 'untouched');
  assert.equal(Regions.prototype.virtualAppend, regionsPrototype);
  const timeline = adapter.adaptImport({ renamedTimeline: Timeline }).renamedTimeline.create({ height: 37 });
  assert.ok(timeline instanceof Timeline);
  assert.equal(timeline.options.height, 37);
  assert.equal(Timeline.prototype.updateVisibleNotches, timelinePrototype);
  const wave = waveFixture(); plugin._init(wave);
  assert.equal(plugin.regionsContainer.parentElement, wave.getWrapper());
  assert.equal(wave.count('ready'), 1);
  addRegion(plugin, 'visible', 0, 2);
  addRegion(plugin, 'hidden', 50, 52);
  await Promise.resolve();
  assert.equal(wave.count('scroll'), 1);
  assert.equal(plugin.regions[0].element.parentElement, plugin.regionsContainer);
  assert.equal(plugin.regions[1].element.parentElement, null);
  wave.left = 500; wave.emit('scroll');
  assert.equal(plugin.regions[0].element.parentElement, null);
  assert.equal(plugin.regions[1].element.parentElement, plugin.regionsContainer);
  assert.ok(notice(notices, 'wave-regions-viewport', 'installed'));
  assert.ok(notice(notices, 'wave-regions-events', 'installed'));
  assert.ok(notice(notices, 'wave-timeline', 'installed'));
  adapter.release(); await defer();
  assert.equal(plugin.virtualAppend, regionsPrototype);
  assert.equal(timeline.updateVisibleNotches, timelinePrototype);
  assert.equal(wave.count('scroll'), 2, 'Release reinstates the native per-region listeners');
  wave.left = 0; wave.emit('scroll');
  assert.equal(plugin.regions[0].element.parentElement, plugin.regionsContainer);
  assert.equal(plugin.regions[1].element.parentElement, null);
  plugin.destroy(); constructed.destroy(); timeline.destroy();
  assert.equal(wave.count('scroll'), 0);
});

test('native event callback keeps overlap order, marker endpoints and private previous state through release', async () => {
  const run = async optimized => {
    const adapter = createNativeWaveAdapters(() => {}), Regions = nativeClass(94846);
    const Plugin = optimized ? adapter.adaptImport({ arbitrary: Regions }).arbitrary : Regions;
    const plugin = Plugin.create(), wave = waveFixture(), events = [];
    plugin._init(wave);
    for (const [id, start, end] of [['first', 1, 4], ['second', 0, 2], ['point', 3, 3]]) addRegion(plugin, id, start, end);
    plugin.on('region-in', region => events.push(['in', region.id]));
    plugin.on('region-out', region => events.push(['out', region.id]));
    for (const time of [0, 1, 2, 2.01, 3, 3.05]) wave.emit('timeupdate', time);
    adapter.release();
    for (const time of [3.051, 4, 4.1, 1, 1]) wave.emit('timeupdate', time);
    assert.equal(Object.hasOwn(plugin.regions, 'filter'), false);
    await defer(); plugin.destroy();
    assert.equal(wave.count('timeupdate'), 0);
    return events;
  };
  assert.deepEqual(await run(true), await run(false));
});

test('indexed native callbacks retain coverage, clock, loop, active setter and current exclusion closures', async () => {
  const notices = [], adapter = createNativeWaveAdapters(value => notices.push(value)), fixture = editorFixture(adapter);
  const { plugin, wave, handlers, nativeTime, effects } = fixture;
  assert.equal(adapter.adaptCallback(fixture.nativeCreate), fixture.create);
  assert.equal(adapter.adaptCallback(fixture.nativeStyle), fixture.style);
  assert.equal(fixture.tracks.current.track, fixture.result);
  wave.emit('ready', 100);
  for (const values of [['first', 2, 8], ['second', 0, 4], ['loop', 0, 100], ['overlay-a', 0, 100], ['last', 4, 6], ['overlay-tail', 50, 60]]) addRegion(plugin, ...values);
  const expected = time => {
    const eligible = plugin.regions.filter(region => region.id !== 'loop' && !region.id.startsWith(fixture.excluded.prefix));
    return eligible.find(region => time >= region.start && time < region.end) || eligible.find(region => time >= region.start && time === region.end && region === eligible.at(-1));
  };
  for (const time of [0, 2, 4, 6, 8, 10, 60]) {
    wave.emit('timeupdate', time);
    assert.deepEqual(effects.findLast(value => value[0] === 'active'), ['active', 'track', expected(time)?.id ?? null]);
  }
  fixture.excluded.prefix = 'different-';
  wave.emit('timeupdate', 60);
  assert.deepEqual(effects.findLast(value => value[0] === 'active'), ['active', 'track', expected(60)?.id ?? null]);
  plugin.regions[0].setOptions({ start: 20, end: 24, id: 'changed' });
  wave.emit('timeupdate', 21);
  assert.deepEqual(effects.findLast(value => value[0] === 'active'), ['active', 'track', 'changed']);
  let writes = 0;
  for (const region of plugin.regions) {
    let filter = '';
    Object.defineProperty(region.element.style, 'filter', { configurable: true, get: () => filter, set(value) { writes++; filter = value; } });
  }
  for (let index = 0; index < 20; index++) fixture.style('track', 'changed');
  assert.equal(writes, 1);
  fixture.style('track', 'second');
  assert.equal(writes, 3);
  assert.equal(effects.filter(value => value[0] === 'setter').length, 21);
  assert.equal(effects.filter(value => value[0] === 'clock').length, 9);
  assert.equal(effects.filter(value => value[0] === 'coverage').length, 9);
  assert.equal(effects.filter(value => value[0] === 'loop').length, 9);
  assert.ok(effects.some(value => value[0] === 'ready' && value[1]));
  assert.ok(notice(notices, 'wave-active-query', 'installed'));
  assert.ok(notice(notices, 'wave-active-style', 'installed'));
  adapter.release();
  assert.equal(adapter.adaptCallback(fixture.nativeCreate), fixture.create, 'Teardown must not retrigger native player-creation effects');
  assert.equal(adapter.adaptCallback(fixture.nativeStyle), fixture.style);
  assert.equal(handlers.onTimeUpdate, nativeTime);
  wave.emit('timeupdate', 2);
  assert.equal(effects.filter(value => value[0] === 'coverage').length, 10);
  await defer(); wave.destroy();
});

test('native renderer clamping and drag rules use a single write without shared prototype changes', () => {
  for (const [left, progress, playing, autoCenter, dragging] of [[0, 0.9, true, true, false], [850, 0.01, false, true, false], [0, 0.9, false, false, false], [890, 1, true, true, true], [0, 0, false, true, true], [100, 0.15, true, true, false]]) {
    const make = () => {
      let value = left, writes = 0;
      return { container: { clientWidth: 100, scrollWidth: 1000, get scrollLeft() { return value; }, set scrollLeft(next) { writes++; value = Math.max(0, Math.min(900, next)); } }, writes: () => writes };
    };
    const native = make(), optimized = make(), adapter = createNativeWaveAdapters(() => {});
    const renderer = { scrollContainer: optimized.container, options: { autoCenter }, isDragging: dragging, scrollIntoView: nativeScroll };
    class Wave extends WaveHarness { static create() { const wave = new WaveHarness({ plugins: [] }); wave.renderer = renderer; return wave; } }
    const instance = adapter.adaptImport({ renamed: Wave }).renamed.create();
    nativeScroll.call({ scrollContainer: native.container, options: { autoCenter }, isDragging: dragging }, progress, playing);
    instance.renderer.scrollIntoView(progress, playing);
    assert.equal(optimized.container.scrollLeft, native.container.scrollLeft);
    assert.ok(optimized.writes() <= 1);
    adapter.release();
    assert.equal(renderer.scrollIntoView, nativeScroll);
  }
});

test('timeline visibility keeps native edge widths and restores live methods without undoing a newer owner', () => {
  const run = optimized => {
    const adapter = createNativeWaveAdapters(() => {}), Timeline = nativeClass(60039);
    const plugin = (optimized ? adapter.adaptImport({ timeline: Timeline }).timeline : Timeline).create();
    const container = new Element();
    for (let index = 0; index < 100; index++) {
      const element = new Element(); element.id = index;
      plugin.notchElements.set(element, { start: index * 10, width: index % 3 * 3, wasVisible: false });
    }
    const snapshots = [];
    for (const [left, right] of [[0, 100], [9, 109], [500, 600], [400, 401], [0, 1000]]) {
      plugin.updateVisibleNotches(left, right, container);
      snapshots.push(container.children.map(element => element.id).sort((a, b) => a - b));
    }
    const installed = plugin.updateVisibleNotches;
    let getterReads = 0;
    const newerGetter = () => { getterReads++; return installed; };
    Object.defineProperty(plugin, 'updateVisibleNotches', { configurable: true, get: newerGetter });
    adapter.release();
    assert.equal(getterReads, 0, 'Teardown must not invoke a newer owner getter');
    assert.equal(Object.getOwnPropertyDescriptor(plugin, 'updateVisibleNotches').get, newerGetter);
    plugin.destroy();
    return snapshots;
  };
  assert.deepEqual(run(true), run(false));
});

test('unknown query and event shapes leave native side effects intact and disable only their boundaries', async () => {
  const notices = [], adapter = createNativeWaveAdapters(value => notices.push(value)), calls = [];
  const fixture = editorFixture(adapter, function(time) { calls.push([time, this]); });
  fixture.wave.emit('timeupdate', 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], fixture.handlers);
  assert.ok(notice(notices, 'wave-active-query', 'unsupported'));
  assert.ok(notice(notices, 'wave-regions-viewport', 'installed'));
  assert.ok(notice(notices, 'wave-scroll', 'installed'));
  const Regions = nativeClass(94846);
  class Changed extends Regions {
    static create() { return new Changed(); }
    onInit() { this.subscriptions.push(this.wavesurfer.on('timeupdate', time => { calls.push(['changed', time]); this.getRegions().filter(region => region.start < time); })); }
  }
  const plugin = adapter.adaptImport({ changed: Changed }).changed.create(), wave = waveFixture();
  plugin._init(wave); wave.emit('timeupdate', 5); wave.emit('timeupdate', 6);
  assert.deepEqual(calls.slice(-2), [['changed', 5], ['changed', 6]]);
  assert.equal(notices.filter(value => value.boundary === 'wave-regions-events' && value.state === 'unsupported').length, 1);
  const unknownStyle = (trackId, regionId) => { fixture.plugin.getRegions().forEach(region => { calls.push(regionId); if (region.id === regionId) region.element.style.filter = 'brightness(0.8)'; }); };
  assert.equal(adapter.adaptCallback(unknownStyle), unknownStyle);
  adapter.release(); await defer(); fixture.wave.destroy(); plugin.destroy();
});

test('warm playback queries inspect interval candidates rather than every native region', async () => {
  const adapter = createNativeWaveAdapters(() => {}), fixture = editorFixture(adapter);
  for (let index = 0; index < 300; index++) addRegion(fixture.plugin, `region-${index}`, index / 10, index / 10 + 0.05);
  await Promise.resolve();
  let reads = 0;
  for (const region of fixture.plugin.regions) {
    for (const key of ['start', 'end']) {
      let value = region[key];
      Object.defineProperty(region, key, { configurable: true, get() { reads++; return value; }, set(next) { value = next; } });
    }
  }
  fixture.wave.emit('timeupdate', 10);
  reads = 0;
  for (let index = 0; index < 50; index++) fixture.wave.emit('timeupdate', 10 + index / 10000);
  assert.ok(reads < 1000, `Expected bounded candidate reads, got ${reads}`);
  assert.equal(fixture.effects.findLast(value => value[0] === 'active')[2], 'region-100');
  assert.equal(Object.hasOwn(fixture.plugin.regions, 'filter'), false);
  assert.equal(Object.hasOwn(fixture.plugin.regions, 'forEach'), false);
  adapter.release(); await defer(); fixture.wave.destroy();
});

test('coverage subscribers retain native array identity and unrelated full-array filters', async () => {
  const adapter = createNativeWaveAdapters(() => {}), fixture = editorFixture(adapter);
  for (let index = 0; index < 20; index++) addRegion(fixture.plugin, `region-${index}`, index, index + 0.5);
  const push = fixture.effects.push;
  let observed = 0;
  fixture.effects.push = function(...values) {
    if (values[0]?.[0] === 'coverage') {
      const regions = fixture.plugin.getRegions();
      assert.equal(regions, fixture.plugin.regions);
      assert.equal(regions.filter(region => region.id !== null).length, 20);
      observed++;
    }
    return Reflect.apply(push, this, values);
  };
  fixture.wave.emit('timeupdate', 1.25);
  assert.equal(observed, 1);
  assert.equal(fixture.effects.findLast(value => value[0] === 'active')[2], 'region-1');
  adapter.release(); await defer(); fixture.wave.destroy();
});
