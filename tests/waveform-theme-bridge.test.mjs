import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const CONFIG_EVENT = 'babel-helper-waveform-theme-config';
const TEARDOWN_EVENT = 'babel-helper-bridge-teardown';
const GLOBAL_KEY = '__babelHelperWaveformThemeBridge';
const RESCAN_SETTLE_MS = 320;

// Wavesurfer's defaultOptions cover waveColor and progressColor but never cursorColor,
// so a realistic instance carries exactly these two keys in options.
const NATIVE_COLORS = {
  waveColor: '#999999',
  progressColor: '#555555'
};

// What a full restore looks like now that the cursor is written from a slot: the two native
// keys handed back plus the cursor as the explicit absence wavesurfer started with.
const RESTORED_COLORS = { ...NATIVE_COLORS, cursorColor: undefined };

const LANE_INDEX_ATTRIBUTE = 'data-babel-helper-lane-index';
const LANE_SLOT_ATTRIBUTE = 'data-babel-helper-lane-slot';
const LANE_LABEL_ATTRIBUTE = 'data-babel-helper-speaker-label';

// What the dashboard paints before the bridge touches anything.
const APP_REGION_FILL = 'rgba(100, 181, 246, 0.25)';
const APP_REGION_BORDER = 'rgb(49, 160, 252)';

// The runtime derives these five roles per slot out of the core palette (wave from the shared
// wave colour, progress and both region colours from the speaker colour, cursor from the text
// colour) and the bridge only places them. Deliberately distinct per slot -- the shipped
// palette repeats a blue in slots 1 and 3 -- so a wrong rotation cannot pass by accident.
const LANES = [
  {
    waveColor: '#111111',
    progressColor: '#1122ff',
    cursorColor: '#113300',
    regionColor: '#1144ff',
    regionBorderColor: '#1155ff'
  },
  {
    waveColor: '#222222',
    progressColor: '#2222ff',
    cursorColor: '#223300',
    regionColor: '#2244ff',
    regionBorderColor: '#2255ff'
  },
  {
    waveColor: '#333333',
    progressColor: '#3322ff',
    cursorColor: '#333300',
    regionColor: '#3344ff',
    regionBorderColor: '#3355ff'
  }
];

// The entire payload: an enabled flag and three slots. There are no global wave dials left.
const THEME = { enabled: true, lanes: LANES };
const DISABLED = { enabled: false, lanes: LANES };

// The slot a lane in the given zero-based order takes, and the setOptions patch it produces.
function laneSlot(position) {
  return LANES[position % LANES.length];
}

function lanePatch(slot) {
  return {
    waveColor: slot.waveColor,
    progressColor: slot.progressColor,
    cursorColor: slot.cursorColor
  };
}

function recolouredLanes(position, patch) {
  return LANES.map((slot, index) => (index === position ? { ...slot, ...patch } : slot));
}

const measurements = {
  computedStyle: 0,
  rect: 0,
  // Every whole-document sweep the bridge can make: the `div` host scan and the speaker-cell
  // query. Counting them is how a test proves a config change did no scanning at all.
  query: 0
};

class FakeElementBase {}

class TestCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

class FakeWindow extends EventTarget {
  getComputedStyle(element) {
    measurements.computedStyle += 1;
    element.styleReads = (element.styleReads || 0) + 1;
    return { display: 'block', visibility: 'visible' };
  }
}

// Verified against headless Chromium: a colour property set from hex reads back as `rgb(…)`,
// an `!important` colour longhand overrides an earlier `!important` border shorthand while
// leaving its width alone, and setting a property to '' removes it. The fake reproduces all
// three, so the bridge's echo bookkeeping is exercised against real serialisation instead of
// a string that happens to round-trip.
const COLOR_PROPERTIES = {
  color: true,
  'background-color': true,
  'border-left-color': true,
  'border-right-color': true
};

function serializeColor(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) {
    return value;
  }

  const digits = match[1].length === 3 ? match[1].replace(/./g, (digit) => digit + digit) : match[1];
  const red = parseInt(digits.slice(0, 2), 16);
  const green = parseInt(digits.slice(2, 4), 16);
  const blue = parseInt(digits.slice(4, 6), 16);
  return `rgb(${red}, ${green}, ${blue})`;
}

// Only the CSSOM surface the bridge actually touches: longhand get/set/remove plus
// priorities. Shorthands are not expanded, so a fake that wants a shorthand and its derived
// longhand to both be readable has to write both, exactly like a real style attribute reads.
class FakeStyle {
  constructor() {
    this.values = new Map();
    this.priorities = new Map();
    this.writes = 0;
  }

  getPropertyValue(name) {
    const value = this.values.get(name);
    return value === undefined ? '' : value;
  }

  getPropertyPriority(name) {
    const priority = this.priorities.get(name);
    return priority === undefined ? '' : priority;
  }

  setProperty(name, value, priority = '') {
    if (value === '' || value == null) {
      this.removeProperty(name);
      return;
    }
    this.writes += 1;
    this.values.set(name, COLOR_PROPERTIES[name] ? serializeColor(value) : value);
    this.priorities.set(name, priority || '');
  }

  removeProperty(name) {
    this.writes += 1;
    this.values.delete(name);
    this.priorities.delete(name);
  }
}

class FakeElement extends FakeElementBase {
  constructor(width = 800, height = 96) {
    super();
    this.isConnected = true;
    this.parentElement = null;
    this.shadowRoot = null;
    this.root = null;
    this.width = width;
    this.height = height;
    this.styleReads = 0;
    this.rectReads = 0;
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.textContent = '';
  }

  getAttribute(name) {
    const value = this.attributes.get(name);
    return value === undefined ? null : value;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  getBoundingClientRect() {
    measurements.rect += 1;
    this.rectReads += 1;
    return { width: this.width, height: this.height };
  }

  contains(other) {
    let current = other;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  getRootNode() {
    return this.root;
  }
}

class FakeShadowRoot {
  constructor(parts) {
    this.parts = parts;
  }

  querySelector(selector) {
    return this.parts[selector] || null;
  }

  contains(node) {
    return Object.values(this.parts).includes(node);
  }
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.target = null;
    this.options = null;
    this.disconnected = false;
    FakeMutationObserver.instances.push(this);
  }

  observe(target, options) {
    this.target = target;
    this.options = options;
  }

  disconnect() {
    this.disconnected = true;
  }
}

FakeMutationObserver.instances = [];

let bundlePromise = null;

function getBundle() {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'babel-helper-waveform-theme-'));
      const outfile = path.join(tempDir, 'waveform-theme-bridge.mjs');
      // Same shape the extension ships (esbuild.config.mjs `shared`), so the test exercises
      // the production wrapper rather than a test-only module build.
      await build({
        entryPoints: [path.resolve('src/content/waveform-theme-bridge.ts')],
        outfile,
        bundle: true,
        minify: false,
        format: 'iife',
        platform: 'browser',
        target: 'chrome114',
        banner: { js: 'var __dirname = typeof __dirname === "string" ? __dirname : "/virtual";' },
        logLevel: 'silent'
      });
      return pathToFileURL(outfile).href;
    })();
  }

  return bundlePromise;
}

function createWave(container, colors, plugins = []) {
  const wave = {
    options: { container, ...colors },
    plugins,
    calls: [],
    // One-shot reaction, mirroring wavesurfer: options are assigned, then the re-render and
    // its listeners run synchronously inside setOptions and may call back into the bridge.
    onWrite: null,
    getDuration: () => 42,
    setOptions(patch) {
      Object.assign(wave.options, patch);
      wave.calls.push({ ...patch });
      const hook = wave.onWrite;
      if (hook) {
        wave.onWrite = null;
        hook(patch, wave);
      }
    }
  };
  return wave;
}

function createRegionsPlugin() {
  const regions = [];
  const listeners = new Map();
  return {
    regions,
    getRegions: () => regions.slice(),
    on(event, handler) {
      let handlers = listeners.get(event);
      if (!handlers) {
        handlers = new Set();
        listeners.set(event, handlers);
      }
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    emit(event, region) {
      const handlers = listeners.get(event);
      for (const handler of handlers ? Array.from(handlers) : []) {
        handler(region);
      }
    },
    listenerCount() {
      let total = 0;
      for (const handlers of listeners.values()) {
        total += handlers.size;
      }
      return total;
    }
  };
}

// How the dashboard paints a region, verbatim: a plain inline background plus
// `border-left`/`border-right` shorthands written with `!important`. The derived longhand
// colour is written too because a real style attribute reports it and the bridge reads it.
function createRegion(id, trackId) {
  const element = new FakeElement();
  element.style.setProperty('background-color', APP_REGION_FILL);
  for (const side of ['left', 'right']) {
    element.style.setProperty(`border-${side}`, `2px solid ${APP_REGION_BORDER}`, 'important');
    element.style.setProperty(`border-${side}-width`, '2px', 'important');
    element.style.setProperty(`border-${side}-color`, APP_REGION_BORDER, 'important');
  }

  const region = {
    id,
    element,
    color: APP_REGION_FILL,
    data: { trackId, label: '' },
    setOptions(patch) {
      if (patch.color) {
        region.color = patch.color;
        element.style.setProperty('background-color', patch.color);
      }
    }
  };
  return region;
}

// The app's track descriptor shape: { id, label, description, audioUrl,
// processedRecordingId, colors }.
function createTrack(index, label) {
  return {
    id: `rec-${index}`,
    label,
    description: `Edits here only affect ${label}.`,
    audioUrl: '',
    processedRecordingId: `rec-${index}`,
    colors: { wave: '#707070', progress: '#64B5F6' }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createEnvironment() {
  const hosts = [];
  const cells = [];
  const pageWindow = new FakeWindow();
  const body = new FakeElement();
  const pageDocument = {
    body,
    documentElement: new FakeElement(),
    querySelectorAll: (selector) => {
      measurements.query += 1;
      if (selector === 'div') {
        return hosts.slice();
      }
      return selector === 'td[style*="color"]' ? cells.slice() : [];
    }
  };

  FakeMutationObserver.instances = [];
  measurements.computedStyle = 0;
  measurements.rect = 0;
  measurements.query = 0;
  globalThis.window = pageWindow;
  globalThis.document = pageDocument;
  globalThis.HTMLElement = FakeElementBase;
  globalThis.MutationObserver = FakeMutationObserver;

  function addHost(attach) {
    const host = new FakeElement();
    const wrapper = new FakeElement();
    const scroll = new FakeElement();
    wrapper.parentElement = host;
    scroll.parentElement = host;
    host.shadowRoot = new FakeShadowRoot({
      '[part="wrapper"]': wrapper,
      '[part="scroll"]': scroll
    });
    host.parentElement = body;
    attach(host);
    hosts.push(host);
    return host;
  }

  function addPlainDiv() {
    const element = new FakeElement();
    element.parentElement = body;
    hosts.push(element);
    return element;
  }

  function addReactPropsHost(colors) {
    let wave = null;
    const host = addHost((element) => {
      wave = createWave(element, colors);
      element['__reactProps$abc123'] = { waveformRef: { current: wave } };
    });
    return { host, wave };
  }

  function addRegistryHost(colors) {
    let wave = null;
    const host = addHost((element) => {
      wave = createWave(element, colors);
      const registry = { 'lane-1': { wavesurfer: wave } };
      element['__reactFiber$abc123'] = {
        memoizedState: { memoizedState: { current: registry }, next: null },
        return: null
      };
    });
    return { host, wave };
  }

  // A lane as the dashboard builds it: the wavesurfer host inside the frame div that carries
  // the inline 2.5px border, with the track descriptor and the whole track array on the
  // host's React props. `mountOrder` mounts the hosts in a different document order than the
  // track array so a test can prove which of the two the bridge trusts.
  function addLaneStack(labels, mountOrder) {
    const tracks = labels.map((label, index) => createTrack(index + 1, label));
    const lanes = [];

    function mount(trackIndex) {
      const track = tracks[trackIndex];
      const regions = createRegionsPlugin();
      const frame = new FakeElement();
      frame.parentElement = body;
      frame.style.setProperty('border-left', '2.5px solid #64b5f6');
      frame.style.setProperty('border-left-color', '#64b5f6');
      frame.style.setProperty('border-right-color', '#64b5f6');

      let wave = null;
      const host = addHost((element) => {
        element.parentElement = frame;
        wave = createWave(element, NATIVE_COLORS, [regions]);
        element['__reactProps$abc123'] = { track, tracks, waveformRef: { current: wave } };
      });

      const lane = { track, host, frame, wave, regions };
      lanes.push(lane);
      return lane;
    }

    for (const trackIndex of mountOrder || tracks.map((track, index) => index)) {
      mount(trackIndex);
    }

    return { tracks, lanes, mount };
  }

  function addSpeakerCell(text) {
    const cell = new FakeElement();
    cell.parentElement = body;
    cell.textContent = text;
    cell.style.setProperty('color', 'rgb(32, 154, 255)');
    cells.push(cell);
    return cell;
  }

  function sendConfig(detail) {
    pageWindow.dispatchEvent(new TestCustomEvent(CONFIG_EVENT, { detail }));
  }

  function notifyAdded(element) {
    for (const observer of FakeMutationObserver.instances) {
      if (!observer.disconnected) {
        observer.callback([{ type: 'childList', addedNodes: [element] }]);
      }
    }
  }

  function notifyAttributeChurn() {
    for (const observer of FakeMutationObserver.instances) {
      if (!observer.disconnected) {
        observer.callback([{ type: 'attributes', addedNodes: [] }]);
      }
    }
  }

  return {
    window: pageWindow,
    document: pageDocument,
    body,
    hosts,
    cells,
    addHost,
    addPlainDiv,
    addReactPropsHost,
    addRegistryHost,
    addLaneStack,
    addSpeakerCell,
    sendConfig,
    notifyAdded,
    notifyAttributeChurn
  };
}

async function installBridge() {
  const bundle = await getBundle();
  await import(`${bundle}?install=${Math.random()}`);
  return globalThis.window[GLOBAL_KEY];
}

test('applies canvas colors to instances found through props and lane registries', async () => {
  const env = createEnvironment();
  const props = env.addReactPropsHost(NATIVE_COLORS);
  const registry = env.addRegistryHost(NATIVE_COLORS);
  const bridge = await installBridge();

  env.sendConfig(THEME);

  [props.wave, registry.wave].forEach((wave, position) => {
    const slot = laneSlot(position);
    assert.equal(wave.calls.length, 1);
    assert.deepEqual(wave.calls[0], lanePatch(slot));
    assert.equal(wave.options.waveColor, slot.waveColor);
    assert.equal(wave.options.progressColor, slot.progressColor);
    assert.equal(wave.options.cursorColor, slot.cursorColor);
  });

  assert.equal(bridge.instanceCount(), 2);
  bridge.dispose();
});

test('the payload is exactly an enabled flag and three lane slots', async () => {
  const env = createEnvironment();
  env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  // A stale sender still shipping the deleted global dials must not resurrect them.
  env.sendConfig({ ...THEME, waveColor: '#94a3b8', progressColor: '#0f766e', cursorColor: '#f59e0b' });

  const seen = bridge.getConfig();
  assert.deepEqual(Object.keys(seen).sort(), ['enabled', 'lanes']);
  assert.equal(seen.enabled, true);
  assert.deepEqual(seen.lanes, LANES);
  bridge.dispose();
});

test('the cursor is written from the lane slot and handed back as an explicit absence', async () => {
  const env = createEnvironment();
  const { wave } = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  env.sendConfig(THEME);

  assert.equal(wave.options.cursorColor, LANES[0].cursorColor);

  env.sendConfig(DISABLED);

  const restore = wave.calls[wave.calls.length - 1];
  assert.equal('cursorColor' in restore, true, 'a cursor we wrote must be restored, not left behind');
  assert.equal(restore.cursorColor, undefined);
  assert.equal(wave.options.cursorColor, undefined);
  assert.deepEqual(restore, RESTORED_COLORS);
  bridge.dispose();
});

test('restore is presence-based, handing a missing original back as explicit undefined', async () => {
  const env = createEnvironment();
  const { wave } = env.addReactPropsHost({ progressColor: '#555555' });
  const bridge = await installBridge();

  env.sendConfig(THEME);
  assert.equal(wave.options.waveColor, LANES[0].waveColor);

  env.sendConfig(DISABLED);

  const restore = wave.calls[wave.calls.length - 1];
  assert.equal('waveColor' in restore, true, 'a key we wrote must be restored even when it was absent');
  assert.equal(restore.waveColor, undefined);
  assert.equal(wave.options.waveColor, undefined);
  assert.equal(wave.options.progressColor, '#555555');
  bridge.dispose();
});

test('repeated identical configs are idempotent while changed colors are pushed through', async () => {
  const env = createEnvironment();
  const { wave } = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  env.sendConfig(THEME);
  env.sendConfig(THEME);
  env.sendConfig({ ...THEME, lanes: LANES.map((slot) => ({ ...slot })) });

  assert.equal(wave.calls.length, 1);

  env.sendConfig({ enabled: true, lanes: recolouredLanes(0, { progressColor: '#2563eb' }) });

  assert.equal(wave.calls.length, 2);
  assert.deepEqual(wave.calls[1], { progressColor: '#2563eb' });
  assert.equal(wave.options.waveColor, LANES[0].waveColor);
  assert.equal(wave.options.progressColor, '#2563eb');
  bridge.dispose();
});

test('a color dropped from an enabled config goes back to native immediately', async () => {
  const env = createEnvironment();
  const { wave } = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  env.sendConfig(THEME);
  env.sendConfig({ enabled: true, lanes: recolouredLanes(0, { waveColor: null }) });

  assert.deepEqual(wave.calls[1], { waveColor: NATIVE_COLORS.waveColor });
  assert.equal(wave.options.waveColor, NATIVE_COLORS.waveColor);
  assert.equal(wave.options.progressColor, LANES[0].progressColor);

  env.sendConfig(DISABLED);

  assert.deepEqual(wave.calls[wave.calls.length - 1], {
    progressColor: NATIVE_COLORS.progressColor,
    cursorColor: undefined
  });
  assert.equal(wave.options.progressColor, NATIVE_COLORS.progressColor);
  bridge.dispose();
});

test('host discovery rejects plain divs before it measures style or layout', async () => {
  const env = createEnvironment();
  const plain = [];
  for (let index = 0; index < 500; index += 1) {
    plain.push(env.addPlainDiv());
  }
  const { wave, host } = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  env.sendConfig(THEME);

  assert.equal(wave.options.waveColor, LANES[0].waveColor);
  assert.equal(
    plain.some((element) => element.styleReads > 0 || element.rectReads > 0),
    false,
    'a div without a wavesurfer shadow root must never be measured'
  );
  assert.equal(measurements.computedStyle, 2, 'only the host and its scroll part are measured');
  assert.equal(measurements.rect, 2);
  assert.ok(host.styleReads > 0);
  bridge.dispose();
});

test('newly mounted instances are adopted through a debounced element-only observer', async () => {
  const env = createEnvironment();
  const first = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  env.sendConfig(THEME);
  assert.equal(bridge.instanceCount(), 1);

  const late = env.addReactPropsHost(NATIVE_COLORS);
  env.notifyAttributeChurn();
  await sleep(RESCAN_SETTLE_MS);

  assert.equal(late.wave.calls.length, 0, 'attribute churn must not trigger a rescan');
  assert.equal(bridge.instanceCount(), 1);

  env.notifyAdded(late.host);
  assert.equal(late.wave.calls.length, 0, 'rescan must be debounced, not synchronous');

  await sleep(RESCAN_SETTLE_MS);

  assert.equal(late.wave.calls.length, 1);
  assert.equal(late.wave.options.waveColor, LANES[1].waveColor, 'a late lane takes the next slot');
  assert.equal(first.wave.calls.length, 1, 'already themed instances are not re-set');
  assert.equal(bridge.instanceCount(), 2);
  bridge.dispose();
});

test('a lane mounting right after a config change is still adopted', async () => {
  const env = createEnvironment();
  const bridge = await installBridge();

  env.sendConfig(THEME);

  const laneA = env.addReactPropsHost(NATIVE_COLORS);
  env.notifyAdded(laneA.host);
  await sleep(20);

  // Colour nudge from a picker drag: bumps the generation mid-debounce.
  env.sendConfig({ enabled: true, lanes: recolouredLanes(0, { progressColor: '#2563eb' }) });
  assert.equal(laneA.wave.calls.length, 1, 'the immediate scan adopts the pending lane');

  const laneB = env.addReactPropsHost(NATIVE_COLORS);
  env.notifyAdded(laneB.host);
  await sleep(RESCAN_SETTLE_MS);

  assert.equal(laneB.wave.calls.length, 1, 'a stale pending rescan must not swallow the new lane');
  assert.deepEqual(laneB.wave.calls[0], lanePatch(LANES[1]));
  assert.equal(bridge.instanceCount(), 2);
  bridge.dispose();
});

test('every mounted lane is themed, not just the first few in document order', async () => {
  const env = createEnvironment();
  const lanes = [];
  for (let index = 0; index < 30; index += 1) {
    lanes.push(env.addReactPropsHost(NATIVE_COLORS));
  }
  const bridge = await installBridge();

  assert.equal(bridge.applyConfig(THEME), 30);
  assert.equal(bridge.instanceCount(), 30);
  assert.equal(
    lanes.every((lane, position) => lane.wave.options.waveColor === laneSlot(position).waveColor),
    true
  );
  bridge.dispose();
});

test('instances reached across a shadow boundary are themed', async () => {
  const env = createEnvironment();
  const outer = new FakeElement();
  let wave = null;
  const host = env.addHost((element) => {
    const container = new FakeElement();
    container.root = { host: element };
    wave = createWave(container, NATIVE_COLORS);
    element.parentElement = null;
    element.root = { host: outer };
    outer['__reactProps$abc123'] = { waveformRef: { current: wave } };
  });
  const bridge = await installBridge();

  env.sendConfig(THEME);

  assert.equal(wave.options.waveColor, LANES[0].waveColor, 'seed walk must hop out of the shadow root');
  assert.equal(wave.options.progressColor, LANES[0].progressColor);
  assert.equal(bridge.instanceCount(), 1);
  assert.ok(host.shadowRoot);
  bridge.dispose();
});

test('disabling restores the captured original colors and stops observing', async () => {
  const env = createEnvironment();
  const { wave } = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  env.sendConfig(THEME);
  env.sendConfig(DISABLED);

  assert.deepEqual(wave.calls[wave.calls.length - 1], RESTORED_COLORS);
  assert.equal(wave.options.waveColor, NATIVE_COLORS.waveColor);
  assert.equal(wave.options.progressColor, NATIVE_COLORS.progressColor);
  assert.equal(bridge.instanceCount(), 0);
  assert.equal(bridge.getConfig().enabled, false);
  assert.equal(
    FakeMutationObserver.instances.every((observer) => observer.disconnected),
    true
  );

  const callsAfterRestore = wave.calls.length;
  env.notifyAdded(env.hosts[0]);
  await sleep(RESCAN_SETTLE_MS);
  assert.equal(wave.calls.length, callsAfterRestore, 'disabled bridge must not reapply');
  bridge.dispose();
});

test('restore never clobbers a color the page changed while theming was on', async () => {
  const env = createEnvironment();
  const { wave } = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  env.sendConfig(THEME);
  wave.setOptions({ waveColor: '#dashboardDark' });

  env.sendConfig(DISABLED);

  assert.equal(wave.options.waveColor, '#dashboardDark', 'the page owns this value now');
  assert.equal(wave.options.progressColor, NATIVE_COLORS.progressColor);
  assert.deepEqual(wave.calls[wave.calls.length - 1], {
    progressColor: NATIVE_COLORS.progressColor,
    cursorColor: undefined
  });
  bridge.dispose();
});

test('teardown event restores colors, unbinds listeners, and clears the page global', async () => {
  const env = createEnvironment();
  const { wave } = env.addReactPropsHost(NATIVE_COLORS);
  await installBridge();

  env.sendConfig(THEME);
  env.window.dispatchEvent(new TestCustomEvent(TEARDOWN_EVENT, {}));

  assert.deepEqual(wave.calls[wave.calls.length - 1], RESTORED_COLORS);
  assert.equal(env.window[GLOBAL_KEY], undefined);

  const callsAfterTeardown = wave.calls.length;
  env.sendConfig(THEME);
  assert.equal(wave.calls.length, callsAfterTeardown, 'torn down bridge ignores later configs');
});

test('a second load is a no-op and keeps the already installed bridge state', async () => {
  const env = createEnvironment();
  const { wave } = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  env.sendConfig(THEME);
  const reinstalled = await installBridge();

  assert.equal(reinstalled, bridge, 'duplicate installation must not replace the bridge');
  assert.deepEqual(reinstalled.getConfig().lanes, LANES);
  assert.equal(reinstalled.instanceCount(), 1);
  assert.equal(wave.calls.length, 1);
  bridge.dispose();
});

test('only real wavesurfer instances are adopted and failures stay isolated', async () => {
  const env = createEnvironment();
  const { wave } = env.addReactPropsHost(NATIVE_COLORS);
  const lookalikes = [];
  env.addHost((element) => {
    // Dashboard-side object: setOptions plus options, but no wavesurfer identity.
    const lookalike = {
      options: { container: element, theme: 'dark' },
      calls: [],
      setOptions(patch) {
        lookalike.calls.push({ ...patch });
      }
    };
    lookalikes.push(lookalike);
    element['__reactProps$abc123'] = { waveformRef: { current: lookalike } };
  });
  env.addHost((element) => {
    // Real shape but detached from any container, so it cannot be attributed to a host.
    const orphan = {
      options: { ...NATIVE_COLORS },
      calls: [],
      getDuration: () => 1,
      setOptions(patch) {
        orphan.calls.push({ ...patch });
      }
    };
    lookalikes.push(orphan);
    element['__reactProps$abc123'] = { waveformRef: { current: orphan } };
  });
  env.addHost((element) => {
    element['__reactProps$abc123'] = {
      waveformRef: {
        current: {
          options: { container: element, ...NATIVE_COLORS },
          getDuration: () => 3,
          setOptions() {
            throw new Error('detached renderer');
          }
        }
      }
    };
  });
  globalThis.MutationObserver = undefined;
  const bridge = await installBridge();

  assert.equal(bridge.applyConfig(THEME), 1);
  assert.equal(wave.calls.length, 1);
  assert.equal(wave.options.waveColor, LANES[0].waveColor);
  assert.equal(
    lookalikes.every((candidate) => candidate.calls.length === 0),
    true,
    'objects without a matching container and wavesurfer API must not be patched'
  );
  bridge.dispose();
});

test('detached instances are pruned while hidden-but-live ones stay restorable', async () => {
  const env = createEnvironment();
  const removed = env.addReactPropsHost(NATIVE_COLORS);
  const hidden = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  env.sendConfig(THEME);
  assert.equal(bridge.instanceCount(), 2);

  removed.host.isConnected = false;
  hidden.host.width = 0;
  env.hosts.length = 0;
  const replacement = env.addReactPropsHost(NATIVE_COLORS);

  assert.equal(bridge.refresh(), 1);
  assert.equal(removed.wave.calls.length, 1, 'a removed lane is not touched again');
  assert.equal(bridge.instanceCount(), 2, 'the hidden lane keeps its record');
  assert.equal(replacement.wave.options.progressColor, LANES[0].progressColor);

  env.sendConfig(DISABLED);

  assert.deepEqual(hidden.wave.calls[hidden.wave.calls.length - 1], RESTORED_COLORS);
  assert.equal(hidden.wave.options.waveColor, NATIVE_COLORS.waveColor);
  assert.equal(removed.wave.calls.length, 1);
  bridge.dispose();
});

test('a re-entrant refresh from inside our own write defers instead of recursing', async () => {
  const env = createEnvironment();
  const first = env.addReactPropsHost(NATIVE_COLORS);
  const second = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  let reentries = 0;
  first.wave.onWrite = () => {
    reentries += 1;
    assert.equal(bridge.refresh(), 0, 'a nested pass must not run inside the outer one');
  };

  env.sendConfig(THEME);

  assert.equal(reentries, 1);
  assert.equal(first.wave.calls.length, 1);
  assert.equal(second.wave.calls.length, 1, 'the outer pass still finishes the remaining lanes');
  assert.equal(bridge.instanceCount(), 2);

  await sleep(RESCAN_SETTLE_MS);

  assert.equal(first.wave.calls.length, 1, 'the deferred reconciliation writes nothing new');
  assert.equal(second.wave.calls.length, 1);
  bridge.dispose();
});

test('a disable dispatched from inside our own write stops the pass and restores', async () => {
  const env = createEnvironment();
  const first = env.addReactPropsHost(NATIVE_COLORS);
  const second = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  first.wave.onWrite = () => env.sendConfig(DISABLED);

  env.sendConfig(THEME);

  assert.equal(bridge.getConfig().enabled, false);
  assert.equal(bridge.instanceCount(), 0);
  assert.deepEqual(first.wave.calls[1], RESTORED_COLORS, 'the nested disable restores what we wrote');
  assert.equal(first.wave.options.waveColor, NATIVE_COLORS.waveColor);
  assert.equal(first.wave.options.progressColor, NATIVE_COLORS.progressColor);
  assert.equal(second.wave.calls.length, 0, 'an invalidated pass must not theme further lanes');
  assert.equal(second.wave.options.waveColor, NATIVE_COLORS.waveColor);

  await sleep(RESCAN_SETTLE_MS);

  assert.equal(first.wave.calls.length, 2);
  assert.equal(second.wave.calls.length, 0);
  bridge.dispose();
});

test('a teardown dispatched from inside our own write unwinds the pass cleanly', async () => {
  const env = createEnvironment();
  const first = env.addReactPropsHost(NATIVE_COLORS);
  const second = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  first.wave.onWrite = () => env.window.dispatchEvent(new TestCustomEvent(TEARDOWN_EVENT, {}));

  env.sendConfig(THEME);

  assert.equal(env.window[GLOBAL_KEY], undefined);
  assert.deepEqual(first.wave.calls[1], RESTORED_COLORS);
  assert.equal(first.wave.options.waveColor, NATIVE_COLORS.waveColor);
  assert.equal(second.wave.calls.length, 0, 'a torn down pass must not keep theming lanes');
  assert.equal(bridge.instanceCount(), 0, 'a disposed bridge must not resurrect records mid-pass');

  await sleep(RESCAN_SETTLE_MS);

  assert.equal(first.wave.calls.length, 2);
  assert.equal(second.wave.calls.length, 0);
});


test('lane slots rotate over lane order and repeat every three lanes', async () => {
  const env = createEnvironment();
  const stack = env.addLaneStack(['Speaker 1', 'Speaker 2', 'Speaker 3', 'Speaker 4']);
  const bridge = await installBridge();

  assert.equal(bridge.applyConfig(THEME), 4);

  const expected = [LANES[0], LANES[1], LANES[2], LANES[0]];
  stack.lanes.forEach((lane, index) => {
    const slot = expected[index];
    assert.equal(lane.wave.options.waveColor, slot.waveColor, `lane ${index + 1} wave`);
    assert.equal(lane.wave.options.progressColor, slot.progressColor, `lane ${index + 1} progress`);
    assert.equal(lane.wave.options.cursorColor, slot.cursorColor, `lane ${index + 1} cursor`);

    for (const element of [lane.host, lane.frame]) {
      assert.equal(element.getAttribute(LANE_INDEX_ATTRIBUTE), String(index + 1));
      assert.equal(element.getAttribute(LANE_SLOT_ATTRIBUTE), String((index % 3) + 1));
      assert.equal(element.getAttribute(LANE_LABEL_ATTRIBUTE), `Speaker ${index + 1}`);
    }
  });

  assert.deepEqual(bridge.laneInfo(), [
    { laneIndex: 1, label: 'Speaker 1', trackId: 'rec-1' },
    { laneIndex: 2, label: 'Speaker 2', trackId: 'rec-2' },
    { laneIndex: 3, label: 'Speaker 3', trackId: 'rec-3' },
    { laneIndex: 4, label: 'Speaker 4', trackId: 'rec-4' }
  ]);
  bridge.dispose();
});

test('lane order comes from the app track array, not from document order', async () => {
  const env = createEnvironment();
  // Hosts mount as track 3, track 1, track 2; only the array order is the truth.
  const stack = env.addLaneStack(['Speaker 1', 'Speaker 2', 'Speaker 3'], [2, 0, 1]);
  const bridge = await installBridge();

  bridge.applyConfig(THEME);

  const expected = [LANES[2], LANES[0], LANES[1]];
  const expectedIndex = ['3', '1', '2'];
  stack.lanes.forEach((lane, position) => {
    assert.equal(lane.wave.options.progressColor, expected[position].progressColor);
    assert.equal(lane.host.getAttribute(LANE_INDEX_ATTRIBUTE), expectedIndex[position]);
    assert.equal(lane.host.getAttribute(LANE_SLOT_ATTRIBUTE), expectedIndex[position]);
  });
  bridge.dispose();
});

test('lane order falls back to document order when no track array is reachable', async () => {
  const env = createEnvironment();
  const first = env.addReactPropsHost(NATIVE_COLORS);
  const second = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  bridge.applyConfig(THEME);

  assert.equal(first.wave.options.progressColor, LANES[0].progressColor);
  assert.equal(second.wave.options.progressColor, LANES[1].progressColor);
  assert.equal(first.host.getAttribute(LANE_SLOT_ATTRIBUTE), '1');
  assert.equal(second.host.getAttribute(LANE_SLOT_ATTRIBUTE), '2');
  assert.equal(
    second.host.getAttribute(LANE_LABEL_ATTRIBUTE),
    null,
    'an unresolvable label must leave the attribute off rather than invent one'
  );
  assert.equal(env.body.getAttribute(LANE_INDEX_ATTRIBUTE), null, 'a shared ancestor is never a lane root');
  bridge.dispose();
});

test('region fill is recoloured at 25% alpha and the border without touching geometry', async () => {
  const env = createEnvironment();
  const stack = env.addLaneStack(['Speaker 1', 'Speaker 2']);
  const [first, second] = stack.lanes;
  const regionA = createRegion('r1', first.track.processedRecordingId);
  const regionB = createRegion('r2', second.track.processedRecordingId);
  first.regions.regions.push(regionA);
  second.regions.regions.push(regionB);
  // The app marks the active region by layering a filter over whatever fill is in place.
  regionA.element.style.setProperty('filter', 'brightness(0.8)');
  const bridge = await installBridge();

  bridge.applyConfig(THEME);

  assert.equal(regionA.element.style.getPropertyValue('background-color'), 'rgba(17, 68, 255, 0.25)');
  assert.equal(regionA.color, 'rgba(17, 68, 255, 0.25)', 'the plugin cache has to agree with the element');
  assert.equal(regionB.element.style.getPropertyValue('background-color'), 'rgba(34, 68, 255, 0.25)');

  assert.equal(
    regionA.element.style.getPropertyValue('border-left-color'),
    serializeColor(LANES[0].regionBorderColor)
  );
  assert.equal(regionA.element.style.getPropertyPriority('border-left-color'), 'important');
  assert.equal(
    regionA.element.style.getPropertyValue('border-right-color'),
    serializeColor(LANES[0].regionBorderColor)
  );
  assert.equal(
    regionB.element.style.getPropertyValue('border-left-color'),
    serializeColor(LANES[1].regionBorderColor)
  );

  assert.equal(
    regionA.element.style.getPropertyValue('border-left'),
    `2px solid ${APP_REGION_BORDER}`,
    'only the colour longhand is written, so the app keeps its border width'
  );
  assert.equal(regionA.element.style.getPropertyValue('border-left-width'), '2px');
  assert.equal(
    regionA.element.style.getPropertyValue('filter'),
    'brightness(0.8)',
    'the active-region highlight is layered over the fill and must be left alone'
  );

  // The browser reports a hex colour back as `rgb(…)`, so a naive "did I already write this
  // string" check would repaint every region on every pass. The echo bookkeeping must not.
  const writesAfterApply = regionA.element.style.writes;
  assert.equal(bridge.refresh(), 2);
  assert.equal(regionA.element.style.writes, writesAfterApply, 'a redundant pass rewrites nothing');

  bridge.applyConfig(DISABLED);

  assert.equal(regionA.element.style.getPropertyValue('background-color'), APP_REGION_FILL);
  assert.equal(regionA.color, APP_REGION_FILL);
  assert.equal(regionA.element.style.getPropertyValue('border-left-color'), APP_REGION_BORDER);
  assert.equal(regionA.element.style.getPropertyPriority('border-left-color'), 'important');
  assert.equal(regionB.element.style.getPropertyValue('border-right-color'), APP_REGION_BORDER);
  assert.equal(regionA.element.style.getPropertyValue('filter'), 'brightness(0.8)');
  bridge.dispose();
});

test('regions created later are recoloured through the plugin event and re-asserted after the app repaints', async () => {
  const env = createEnvironment();
  const stack = env.addLaneStack(['Speaker 1']);
  const [lane] = stack.lanes;
  const bridge = await installBridge();

  bridge.applyConfig(THEME);
  assert.equal(lane.regions.listenerCount(), 2, 'region-created and region-updated are both watched');

  const late = createRegion('r-late', lane.track.processedRecordingId);
  lane.regions.regions.push(late);
  lane.regions.emit('region-created', late);

  assert.equal(
    late.element.style.getPropertyValue('background-color'),
    'rgba(17, 68, 255, 0.25)',
    'a new region is coloured synchronously so it never flashes'
  );
  assert.equal(
    late.element.style.getPropertyValue('border-left-color'),
    serializeColor(LANES[0].regionBorderColor)
  );

  // The dashboard repaints its own colours on a 0ms and a ~50ms timer after creating a region.
  late.element.style.setProperty('background-color', APP_REGION_FILL);
  late.element.style.setProperty('border-left-color', APP_REGION_BORDER, 'important');
  late.element.style.setProperty('border-right-color', APP_REGION_BORDER, 'important');

  await sleep(RESCAN_SETTLE_MS);

  assert.equal(late.element.style.getPropertyValue('background-color'), 'rgba(17, 68, 255, 0.25)');
  assert.equal(
    late.element.style.getPropertyValue('border-left-color'),
    serializeColor(LANES[0].regionBorderColor)
  );

  bridge.applyConfig(DISABLED);

  assert.equal(late.element.style.getPropertyValue('background-color'), APP_REGION_FILL);
  assert.equal(late.element.style.getPropertyValue('border-left-color'), APP_REGION_BORDER);
  assert.equal(lane.regions.listenerCount(), 0, 'a disable unsubscribes from the regions plugin');
  bridge.dispose();
});

test('a region the page recoloured after us is left alone on restore', async () => {
  const env = createEnvironment();
  const stack = env.addLaneStack(['Speaker 1']);
  const [lane] = stack.lanes;
  const region = createRegion('r1', lane.track.processedRecordingId);
  lane.regions.regions.push(region);
  const bridge = await installBridge();

  bridge.applyConfig(THEME);
  region.element.style.setProperty('border-left-color', '#0f172a', 'important');

  bridge.applyConfig(DISABLED);

  assert.equal(
    region.element.style.getPropertyValue('border-left-color'),
    'rgb(15, 23, 42)',
    'the page owns this value now'
  );
  assert.equal(region.element.style.getPropertyValue('border-right-color'), APP_REGION_BORDER);
  bridge.dispose();
});

test('a lane mounted after the config is adopted with its own slot', async () => {
  const env = createEnvironment();
  const stack = env.addLaneStack(['Speaker 1', 'Speaker 2', 'Speaker 3'], [0, 1]);
  const bridge = await installBridge();

  env.sendConfig(THEME);
  assert.equal(bridge.instanceCount(), 2);

  const late = stack.mount(2);
  env.notifyAdded(late.host);
  assert.equal(late.wave.calls.length, 0, 'rescan must stay debounced');

  await sleep(RESCAN_SETTLE_MS);

  assert.equal(late.wave.options.waveColor, LANES[2].waveColor);
  assert.equal(late.wave.options.progressColor, LANES[2].progressColor);
  assert.equal(late.wave.options.cursorColor, LANES[2].cursorColor);
  assert.equal(late.host.getAttribute(LANE_SLOT_ATTRIBUTE), '3');
  assert.equal(late.frame.getAttribute(LANE_LABEL_ATTRIBUTE), 'Speaker 3');
  assert.equal(stack.lanes[0].wave.calls.length, 1, 'already themed lanes are not rewritten');
  bridge.dispose();
});

test('a lane that moves up sheds its old stamp and takes the new slot', async () => {
  const env = createEnvironment();
  const first = env.addReactPropsHost(NATIVE_COLORS);
  const second = env.addReactPropsHost(NATIVE_COLORS);
  const bridge = await installBridge();

  bridge.applyConfig(THEME);
  assert.equal(second.host.getAttribute(LANE_SLOT_ATTRIBUTE), '2');

  first.host.isConnected = false;
  env.hosts.splice(0, 1);

  assert.equal(bridge.refresh(), 1);

  assert.equal(second.host.getAttribute(LANE_INDEX_ATTRIBUTE), '1');
  assert.equal(second.host.getAttribute(LANE_SLOT_ATTRIBUTE), '1');
  assert.equal(second.wave.options.waveColor, LANES[0].waveColor);
  assert.equal(second.wave.options.progressColor, LANES[0].progressColor);
  bridge.dispose();
});

test('speaker table cells are stamped with the slot of the lane whose label they carry', async () => {
  const env = createEnvironment();
  env.addLaneStack(['Speaker 1', 'Speaker 2', 'Speaker 3']);
  const cellOne = env.addSpeakerCell('  Speaker 1  ');
  const cellThree = env.addSpeakerCell('Speaker 3');
  const unrelated = env.addSpeakerCell('Total');
  const bridge = await installBridge();

  bridge.applyConfig(THEME);

  assert.equal(cellOne.getAttribute(LANE_SLOT_ATTRIBUTE), '1');
  assert.equal(cellOne.getAttribute(LANE_LABEL_ATTRIBUTE), 'Speaker 1');
  assert.equal(
    cellThree.getAttribute(LANE_SLOT_ATTRIBUTE),
    '3',
    'slots 1 and 3 ship the same colour, so only a stamp can tell them apart'
  );
  assert.equal(cellThree.getAttribute(LANE_INDEX_ATTRIBUTE), '3');
  assert.equal(unrelated.getAttribute(LANE_SLOT_ATTRIBUTE), null);

  cellOne.textContent = 'Speaker 2';
  assert.equal(bridge.refresh(), 3);
  assert.equal(cellOne.getAttribute(LANE_SLOT_ATTRIBUTE), '2', 'a re-rendered cell follows its new speaker');

  bridge.applyConfig(DISABLED);

  assert.equal(cellOne.getAttribute(LANE_SLOT_ATTRIBUTE), null);
  assert.equal(cellOne.getAttribute(LANE_LABEL_ATTRIBUTE), null);
  assert.equal(cellThree.getAttribute(LANE_INDEX_ATTRIBUTE), null);
  bridge.dispose();
});

test('disabling restores every lane colour, stamp and region and stops observing', async () => {
  const env = createEnvironment();
  const stack = env.addLaneStack(['Speaker 1', 'Speaker 2']);
  const region = createRegion('r1', stack.lanes[0].track.processedRecordingId);
  stack.lanes[0].regions.regions.push(region);
  const cell = env.addSpeakerCell('Speaker 2');
  const bridge = await installBridge();

  env.sendConfig(THEME);
  env.sendConfig(DISABLED);

  for (const lane of stack.lanes) {
    assert.deepEqual(lane.wave.calls[lane.wave.calls.length - 1], RESTORED_COLORS);
    assert.equal(lane.wave.options.waveColor, NATIVE_COLORS.waveColor);
    assert.equal(lane.wave.options.progressColor, NATIVE_COLORS.progressColor);
    assert.equal(lane.wave.options.cursorColor, undefined);
    assert.equal(lane.host.attributes.size, 0);
    assert.equal(lane.frame.attributes.size, 0);
  }

  assert.equal(cell.attributes.size, 0);
  assert.equal(region.element.style.getPropertyValue('background-color'), APP_REGION_FILL);
  assert.equal(bridge.instanceCount(), 0);
  assert.equal(
    FakeMutationObserver.instances.every((observer) => observer.disconnected),
    true
  );
  bridge.dispose();
});

test('teardown restores lane stamps and region colours as completely as a disable', async () => {
  const env = createEnvironment();
  const stack = env.addLaneStack(['Speaker 1']);
  const [lane] = stack.lanes;
  const region = createRegion('r1', lane.track.processedRecordingId);
  lane.regions.regions.push(region);
  const cell = env.addSpeakerCell('Speaker 1');
  await installBridge();

  env.sendConfig(THEME);
  env.window.dispatchEvent(new TestCustomEvent(TEARDOWN_EVENT, {}));

  assert.equal(lane.wave.options.waveColor, NATIVE_COLORS.waveColor);
  assert.equal(lane.wave.options.cursorColor, undefined);
  assert.equal(lane.host.attributes.size, 0);
  assert.equal(lane.frame.attributes.size, 0);
  assert.equal(cell.attributes.size, 0);
  assert.equal(region.element.style.getPropertyValue('background-color'), APP_REGION_FILL);
  assert.equal(region.element.style.getPropertyValue('border-left-color'), APP_REGION_BORDER);
  assert.equal(lane.regions.listenerCount(), 0);
  assert.equal(env.window[GLOBAL_KEY], undefined);
});

test('a lane the payload does not cover is left entirely native', async () => {
  const env = createEnvironment();
  const stack = env.addLaneStack(['Speaker 1', 'Speaker 2']);
  const region = createRegion('r1', stack.lanes[0].track.processedRecordingId);
  stack.lanes[0].regions.regions.push(region);
  const bridge = await installBridge();

  bridge.applyConfig({ enabled: true, lanes: [null, LANES[1], LANES[2]] });

  // No global fallback exists any more, so an empty slot means hands off entirely.
  assert.equal(stack.lanes[0].wave.calls.length, 0, 'a lane with no slot is never written to');
  assert.equal(stack.lanes[0].wave.options.waveColor, NATIVE_COLORS.waveColor);
  assert.equal(stack.lanes[0].wave.options.progressColor, NATIVE_COLORS.progressColor);
  assert.equal(stack.lanes[0].wave.options.cursorColor, undefined);
  assert.equal(region.element.style.getPropertyValue('background-color'), APP_REGION_FILL);
  assert.equal(region.element.style.getPropertyValue('border-left-color'), APP_REGION_BORDER);

  // The lane is still identified, so the stylesheet can still reach its frame and table text.
  assert.equal(stack.lanes[0].host.getAttribute(LANE_SLOT_ATTRIBUTE), '1');
  assert.equal(stack.lanes[0].frame.getAttribute(LANE_LABEL_ATTRIBUTE), 'Speaker 1');

  assert.deepEqual(stack.lanes[1].wave.calls[0], lanePatch(LANES[1]));

  // Filling the slot in adopts the lane without a remount.
  bridge.applyConfig(THEME);

  assert.deepEqual(stack.lanes[0].wave.calls[0], lanePatch(LANES[0]));
  assert.equal(
    region.element.style.getPropertyValue('background-color'),
    'rgba(17, 68, 255, 0.25)',
    'the region follows its lane once the slot arrives'
  );
  bridge.dispose();
});

test('switching lane palettes repaints only what changed', async () => {
  const env = createEnvironment();
  const stack = env.addLaneStack(['Speaker 1', 'Speaker 2']);
  const bridge = await installBridge();

  bridge.applyConfig(THEME);
  const before = stack.lanes.map((lane) => lane.wave.calls.length);

  bridge.applyConfig(THEME);
  assert.deepEqual(
    stack.lanes.map((lane) => lane.wave.calls.length),
    before,
    'an identical lane payload must be idempotent'
  );

  const recoloured = [{ ...LANES[0], progressColor: '#abcdef' }, LANES[1], LANES[2]];
  bridge.applyConfig({ ...THEME, lanes: recoloured });

  assert.deepEqual(stack.lanes[0].wave.calls[before[0]], { progressColor: '#abcdef' });
  assert.equal(stack.lanes[1].wave.calls.length, before[1], 'an untouched slot is not rewritten');
  bridge.dispose();
});

// A colour drag dispatches this payload on every pointer move, and a dial that feeds no lane
// slot -- or a slot that simply arrived twice in one frame -- reaches the bridge as the exact
// payload already on the page. Idempotence is not enough there: the pass itself is the cost,
// so an unchanged payload has to be refused before any discovery happens.
test('a repeated identical config performs no scan, no host probe and no instance write', async () => {
  const env = createEnvironment();
  const stack = env.addLaneStack(['Speaker 1', 'Speaker 2', 'Speaker 3']);
  const cell = env.addSpeakerCell('Speaker 1');
  const bridge = await installBridge();

  assert.equal(bridge.applyConfig(THEME), 3);

  const writes = stack.lanes.map((lane) => lane.wave.calls.length);
  const settled = { ...measurements };
  assert.ok(settled.query > 0, 'the first apply really did scan');

  for (let index = 0; index < 60; index += 1) {
    // Rebuilt every time: reference identity must not be what makes this cheap, the value is.
    const repeat = { enabled: true, lanes: LANES.map((slot) => ({ ...slot })) };
    assert.equal(bridge.applyConfig(repeat), 3, 'an unchanged config still reports the themed lanes');
  }

  assert.deepEqual(
    stack.lanes.map((lane) => lane.wave.calls.length),
    writes,
    '60 repeats must cost zero instance writes'
  );
  assert.deepEqual(
    { ...measurements },
    settled,
    '60 repeats must cost zero document queries, zero style reads and zero layout reads'
  );

  // Everything the pass owns is still in place: the repeats changed nothing, they skipped.
  assert.equal(cell.getAttribute(LANE_SLOT_ATTRIBUTE), '1');
  assert.equal(stack.lanes[2].host.getAttribute(LANE_SLOT_ATTRIBUTE), '3');
  assert.equal(stack.lanes[1].wave.options.waveColor, LANES[1].waveColor);

  // The value the drag finally lands on does reach a slot, and that one applies in full.
  assert.equal(bridge.applyConfig({ enabled: true, lanes: recolouredLanes(1, { waveColor: '#0f172a' }) }), 3);
  assert.deepEqual(stack.lanes[1].wave.calls[writes[1]], { waveColor: '#0f172a' });
  assert.equal(stack.lanes[1].wave.options.waveColor, '#0f172a');
  assert.equal(stack.lanes[0].wave.calls.length, writes[0], 'a slot that did not move is not rewritten');

  bridge.applyConfig(DISABLED);

  for (const lane of stack.lanes) {
    assert.deepEqual(lane.wave.calls[lane.wave.calls.length - 1], RESTORED_COLORS);
    assert.equal(lane.host.attributes.size, 0);
    assert.equal(lane.frame.attributes.size, 0);
  }

  assert.equal(cell.attributes.size, 0);
  assert.equal(bridge.instanceCount(), 0);
  bridge.dispose();
});