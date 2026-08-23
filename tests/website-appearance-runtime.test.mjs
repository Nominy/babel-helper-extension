import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function importRuntime() {
  const result = await build({
    entryPoints: ['src/content/website-appearance.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20'
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64');
  return import(`data:text/javascript;base64,${source}`);
}

async function importKernelHarness() {
  const harnessKey = '__babelHelperAppearanceKernelHarness';
  globalThis[harnessKey] = {
    controllerApplies: [],
    controllerDisposed: false,
    panelDisposed: false,
    panelSyncs: [],
    panelOptions: null
  };
  const modules = new Map([
    ['./config', `export const createConfig = (features) => ({ ...features });`],
    ['./state-store', `export const createState = () => ({ routeRefreshTimer: 0 });`],
    ['./logger', `export const createLogger = () => ({});`],
    [
      '../hooks/dom',
      `export const isEditable = () => false;
       export const isVisible = () => true;
       export const normalizeText = (value) => String(value);
       export const setEditableValue = () => {};
       export const dispatchClick = () => {};
       export const sleep = async () => {};
       export const waitFor = async () => null;`
    ],
    ['./lifecycle', `export const registerLifecycle = () => {};`],
    [
      './service-registry',
      `export const createBuiltinServiceRegistry = () => ({ provide() {} });`
    ],
    [
      '../mod-platform/scope',
      `export function createScope() {
         const disposers = [];
         return {
           defer(disposer) { disposers.push(disposer); },
           async dispose() {
             for (const disposer of disposers.reverse()) await disposer();
           }
         };
       }`
    ],
    ['./analytics-store', `export const createAnalyticsStore = () => ({});`],
    [
      './perf',
      `export const createPerfRuntime = () => ({
         mark() {},
         measure() {},
         setPhase() {}
       });`
    ],
    [
      '../services/extended-diff-view-service',
      `export const registerExtendedDiffViewService = () => {};`
    ],
    [
      '../services/recovered-editor-snapshot-service',
      `export const registerRecoveredEditorSnapshotService = () => {};`
    ],
    ['../services/session-service', `export const createSessionService = () => ({});`],
    [
      '../content/mod-controller',
      `export const createModController = () => ({
         generation: 1,
         start() {},
         ready() {},
         updateSettings() {},
         activateSession(_reason, action) { return action(); },
         deactivateSession(_reason, action) { return action(); },
         stop(_reason, action) { return action(); }
       });`
    ],
    [
      '../content/website-appearance',
      `export const createWebsiteAppearanceController = () => ({
         apply(next) {
           globalThis.${harnessKey}.controllerApplies.push(next);
         },
         dispose() {
           globalThis.${harnessKey}.controllerDisposed = true;
         }
       });`
    ],
    [
      '../content/website-appearance-panel',
      `export const createWebsiteAppearancePanel = (options) => {
         globalThis.${harnessKey}.panelOptions = options;
         return {
           open() {},
           close() {},
           toggle() {},
           sync(next) {
             globalThis.${harnessKey}.panelSyncs.push(next);
           },
           dispose() {
             globalThis.${harnessKey}.panelDisposed = true;
           }
         };
       };`
    ]
  ]);
  const result = await build({
    entryPoints: ['src/core/kernel.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    plugins: [
      {
        name: 'website-appearance-kernel-harness',
        setup(esbuild) {
          esbuild.onResolve({ filter: /.*/ }, (args) =>
            modules.has(args.path)
              ? { path: args.path, namespace: 'appearance-kernel-harness' }
              : null
          );
          esbuild.onLoad(
            { filter: /.*/, namespace: 'appearance-kernel-harness' },
            (args) => ({ contents: modules.get(args.path), loader: 'js' })
          );
        }
      }
    ]
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64');
  return import(`data:text/javascript;base64,${source}`);
}

// Every mutation is logged by name. A write to the real CSSOM invalidates style for the
// whole document, so "which declarations did this apply touch" is the property the
// incremental writer has to hold, not just the values it left behind.
class FakeStyleDeclaration {
  #values = new Map();

  writeLog = [];

  setProperty(name, value, priority = '') {
    this.writeLog.push(name);
    this.#values.set(name, { value: String(value), priority: String(priority) });
  }

  getPropertyValue(name) {
    return this.#values.get(name)?.value ?? '';
  }

  getPropertyPriority(name) {
    return this.#values.get(name)?.priority ?? '';
  }

  hasProperty(name) {
    return this.#values.has(name);
  }

  removeProperty(name) {
    const value = this.getPropertyValue(name);
    this.writeLog.push(name);
    this.#values.delete(name);
    return value;
  }
}

// A selector engine just wide enough for the fixed set the runtime asks for: a tag name,
// class tokens and quoted attribute matchers, joined by commas. Anything else throws, so a
// selector the runtime changes cannot quietly start matching nothing here.
function matchesCompoundSelector(element, selector) {
  let rest = selector.trim();
  const tag = /^[a-z]+/i.exec(rest);
  if (tag) {
    if (element.tagName !== tag[0].toUpperCase()) {
      return false;
    }
    rest = rest.slice(tag[0].length);
  }
  while (rest.length) {
    const className = /^\.([\w-]+)/.exec(rest);
    if (className) {
      const tokens = (element.getAttribute('class') ?? '').split(/\s+/);
      if (!tokens.includes(className[1])) {
        return false;
      }
      rest = rest.slice(className[0].length);
      continue;
    }
    const attribute = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/.exec(rest);
    if (attribute) {
      const value = element.getAttribute(attribute[1]);
      const expected = attribute[2] ?? attribute[3];
      if (value === null || (expected !== undefined && value !== expected)) {
        return false;
      }
      rest = rest.slice(attribute[0].length);
      continue;
    }
    throw new Error(`unsupported selector fragment: ${rest}`);
  }
  return true;
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.id = '';
    this.textContent = '';
    this.style = new FakeStyleDeclaration();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.attributeWriteLog = [];
  }

  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributeWriteLog.push(name);
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributeWriteLog.push(name);
    this.attributes.delete(name);
  }

  matches(selector) {
    return selector.split(',').some((part) => matchesCompoundSelector(this, part));
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child.matches(selector)) {
          matches.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  remove() {
    if (!this.parentNode) {
      return;
    }
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) {
      this.parentNode.children.splice(index, 1);
    }
    this.parentNode = null;
  }
}

class FakeWindow extends EventTarget {
  constructor() {
    super();
    this.CustomEvent = CustomEvent;
  }
}

class FakeDocument extends EventTarget {
  constructor({ withRoot = true } = {}) {
    super();
    this.documentElement = null;
    this.head = null;
    this.body = null;
    this.defaultView = new FakeWindow();
    if (withRoot) {
      this.installRoot();
    }
  }

  installRoot() {
    this.documentElement = new FakeElement('html');
    this.head = new FakeElement('head');
    this.documentElement.appendChild(this.head);
    return this.documentElement;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  #collect(predicate) {
    const matches = [];
    const visit = (element) => {
      if (predicate(element)) {
        matches.push(element);
      }
      element.children.forEach(visit);
    };
    if (this.documentElement) {
      visit(this.documentElement);
    }
    return matches;
  }

  getElementById(id) {
    return this.#collect((element) => element.id === id)[0] ?? null;
  }

  countElementsById(id) {
    return this.#collect((element) => element.id === id).length;
  }

  findAllByAttribute(name) {
    return this.#collect((element) => element.getAttribute(name) !== null);
  }
}

// The stored palette: one deliberately distinct color per dial, so a dial that is read
// from the wrong field shows up as a wrong hex rather than a coincidental match.
const PALETTE = {
  pageColor: '#101112',
  surfaceColor: '#202224',
  textColor: '#eef0f2',
  mutedTextColor: '#8a9099',
  accentColor: '#3b82f6',
  accentTextColor: '#f8fafc',
  borderColor: '#33383d',
  activeRowColor: '#1d4ed8',
  activeRowTextColor: '#ffffff',
  waveColor: '#94a3b8',
  speakerColors: ['#64b5f6', '#b083ff', '#38bdf8'],
  dangerColor: '#dc2626',
  warningColor: '#d97706',
  successColor: '#16a34a'
};

function appearance(overrides = {}) {
  return {
    enabled: true,
    textEnabled: false,
    textSizePx: 19,
    tableTextSizePx: 13,
    themeEnabled: false,
    ...PALETTE,
    speakerColors: [...PALETTE.speakerColors],
    gradientEnabled: false,
    gradientColors: ['#102030', '#405060', '#708090'],
    gradientAngle: 120,
    gradientSpeed: 'balanced',
    customCssEnabled: false,
    customCss: '',
    ...overrides
  };
}

const MASTER_ATTRIBUTE = 'data-babel-helper-appearance';

// Every derived value below is written out by hand rather than recomputed from the
// implementation, so a change to a mix ratio or a rounding rule has to be restated here
// before this suite agrees with it.
//
//   surface-raised  = #202224 pulled 5% toward #eef0f2: 32+206*.05=42.3, 34+206*.05=44.3,
//                     36+206*.05=46.3 -> #2a2c2e
//   surface-hover   = the same pull at 8%: 48.48, 50.48, 52.48 -> #303234
//   danger-tint     = #dc2626 dropped 88% onto #202224: 54.56, 34.48, 36.24 -> #372224
//   scrollbar-thumb = #33383d nudged 15% toward #eef0f2: 79.05, 83.6, 88.15 -> #4f5458
const THEME_VARIABLES = {
  '--bh-page': '#101112',
  '--bh-surface': '#202224',
  '--bh-surface-raised': '#2a2c2e',
  '--bh-surface-hover': '#303234',
  '--bh-text': '#eef0f2',
  '--bh-muted': '#8a9099',
  '--bh-accent': '#3b82f6',
  '--bh-accent-text': '#f8fafc',
  '--bh-border': '#33383d',
  '--bh-active-row': '#1d4ed8',
  '--bh-active-row-text': '#ffffff',
  '--bh-wave': '#94a3b8',
  '--bh-danger': '#dc2626',
  '--bh-warning': '#d97706',
  '--bh-success': '#16a34a',
  '--bh-danger-tint': '#372224',
  '--bh-warning-tint': '#362c20',
  '--bh-success-tint': '#1f3129',
  '--bh-speaker-1': '#64b5f6',
  '--bh-speaker-2': '#b083ff',
  '--bh-speaker-3': '#38bdf8',
  '--bh-speaker-1-tint': 'rgba(100, 181, 246, 0.25)',
  '--bh-speaker-2-tint': 'rgba(176, 131, 255, 0.25)',
  '--bh-speaker-3-tint': 'rgba(56, 189, 248, 0.25)',
  '--bh-scrollbar-thumb': '#4f5458'
};

// The dashboard resolves its own tokens as hsl(var(--token)), so the palette reaches them
// as bare space-separated triplets. Each row is one palette dial fanned out over the
// tokens it owns.
const APP_TOKENS = {
  '--background': '210 6% 7%',
  '--card': '210 6% 13%',
  '--popover': '210 6% 13%',
  '--sidebar': '210 6% 13%',
  '--muted': '210 6% 13%',
  '--secondary': '210 6% 13%',
  '--accent': '210 6% 13%',
  '--foreground': '210 13% 94%',
  '--card-foreground': '210 13% 94%',
  '--popover-foreground': '210 13% 94%',
  '--sidebar-foreground': '210 13% 94%',
  '--secondary-foreground': '210 13% 94%',
  '--accent-foreground': '210 13% 94%',
  '--muted-foreground': '216 7% 57%',
  '--primary': '217 91% 60%',
  '--ring': '217 91% 60%',
  '--sidebar-ring': '217 91% 60%',
  '--primary-foreground': '210 40% 98%',
  '--destructive-foreground': '210 40% 98%',
  '--border': '210 9% 22%',
  '--input': '210 9% 22%',
  '--sidebar-border': '210 9% 22%',
  '--destructive': '0 72% 51%'
};

const GROUPS = {
  text: {
    flag: 'textEnabled',
    attributes: { 'data-babel-helper-appearance-text': 'enabled' },
    variables: {
      '--bh-text-size': '19px',
      '--bh-table-text-size': '13px'
    }
  },
  theme: {
    flag: 'themeEnabled',
    attributes: { 'data-babel-helper-appearance-theme': 'enabled' },
    variables: { ...THEME_VARIABLES, ...APP_TOKENS }
  },
  gradient: {
    flag: 'gradientEnabled',
    attributes: {
      'data-babel-helper-appearance-gradient': 'enabled',
      'data-babel-helper-appearance-gradient-speed': 'balanced'
    },
    variables: {
      '--bh-gradient-color-1': '#102030',
      '--bh-gradient-color-2': '#405060',
      '--bh-gradient-color-3': '#708090',
      '--bh-gradient-angle': '120deg',
      '--bh-gradient-duration': '14s'
    }
  }
};

const GROUP_NAMES = Object.keys(GROUPS);
const ALL_ATTRIBUTES = [
  MASTER_ATTRIBUTE,
  ...GROUP_NAMES.flatMap((name) => Object.keys(GROUPS[name].attributes))
];
const ALL_VARIABLES = GROUP_NAMES.flatMap((name) => Object.keys(GROUPS[name].variables));

function attributeSnapshot(root) {
  const snapshot = {};
  for (const attribute of ALL_ATTRIBUTES) {
    snapshot[attribute] = root.getAttribute(attribute);
  }
  return snapshot;
}

function variableSnapshot(root) {
  const snapshot = {};
  for (const variable of ALL_VARIABLES) {
    snapshot[variable] = root.style.getPropertyValue(variable);
  }
  return snapshot;
}

function expectedSnapshots(...groupNames) {
  const attributes = {};
  const variables = {};
  for (const attribute of ALL_ATTRIBUTES) {
    attributes[attribute] = null;
  }
  for (const variable of ALL_VARIABLES) {
    variables[variable] = '';
  }
  attributes[MASTER_ATTRIBUTE] = 'enabled';
  for (const name of groupNames) {
    Object.assign(attributes, GROUPS[name].attributes);
    Object.assign(variables, GROUPS[name].variables);
  }
  return { attributes, variables };
}

/** Empties both logs and hands back the pair the next apply will fill. */
function trackWrites(root) {
  root.attributeWriteLog.length = 0;
  root.style.writeLog.length = 0;
  return { attributes: root.attributeWriteLog, variables: root.style.writeLog };
}

const STYLE_ID = 'babel-helper-website-custom-css';
const WAVEFORM_BRIDGE_ATTRIBUTE = 'data-babel-helper-waveform-theme-bridge';
const WAVEFORM_CONFIG_EVENT = 'babel-helper-waveform-theme-config';
const WAVEFORM_BRIDGE_PATH = 'dist/content/waveform-theme-bridge.js';

// The wave is shared by every slot, the speaker hue drives progress and both region
// colors, and the cursor rides the palette text color.
const EXPECTED_SLOTS = PALETTE.speakerColors.map((speaker) => ({
  waveColor: PALETTE.waveColor,
  progressColor: speaker,
  cursorColor: PALETTE.textColor,
  regionColor: speaker,
  regionBorderColor: speaker
}));

function installChromeRuntime() {
  globalThis.chrome = {
    runtime: {
      getURL(path) {
        return `chrome-extension://babel-helper/${path}`;
      }
    }
  };
}

function captureWaveformConfigs(document) {
  const configs = [];
  document.defaultView.addEventListener(WAVEFORM_CONFIG_EVENT, (event) => {
    configs.push(event.detail);
  });
  return configs;
}

const { createWebsiteAppearanceController } = await importRuntime();

test('each group emits only its own attributes and variables', () => {
  for (const name of GROUP_NAMES) {
    const document = new FakeDocument();
    const root = document.documentElement;
    const controller = createWebsiteAppearanceController(document);
    const expected = expectedSnapshots(name);

    controller.apply(appearance({ [GROUPS[name].flag]: true }));
    assert.deepEqual(
      attributeSnapshot(root),
      expected.attributes,
      `${name} must emit only its own root attributes`
    );
    assert.deepEqual(
      variableSnapshot(root),
      expected.variables,
      `${name} must emit only its own custom properties`
    );

    controller.apply(appearance({ [GROUPS[name].flag]: false }));
    assert.deepEqual(
      attributeSnapshot(root),
      expectedSnapshots().attributes,
      `${name} must remove exactly its own root attributes`
    );
    assert.deepEqual(
      variableSnapshot(root),
      expectedSnapshots().variables,
      `${name} must remove exactly its own custom properties`
    );

    controller.dispose();
  }
});

test('a text-size-only session leaves every color dial untouched', () => {
  const TEXT_SIZE_VARIABLES = ['--bh-text-size', '--bh-table-text-size'];
  const document = new FakeDocument();
  const root = document.documentElement;
  const controller = createWebsiteAppearanceController(document);

  controller.apply(appearance({ textEnabled: true, textSizePx: 22, tableTextSizePx: 11 }));

  assert.equal(root.getAttribute(MASTER_ATTRIBUTE), 'enabled');
  assert.equal(root.getAttribute('data-babel-helper-appearance-text'), 'enabled');
  assert.equal(root.style.getPropertyValue('--bh-text-size'), '22px');
  assert.equal(root.style.getPropertyValue('--bh-table-text-size'), '11px');
  const attributes = attributeSnapshot(root);
  const variables = variableSnapshot(root);
  for (const attribute of ALL_ATTRIBUTES) {
    if (attribute === MASTER_ATTRIBUTE || attribute === 'data-babel-helper-appearance-text') {
      continue;
    }
    assert.equal(attributes[attribute], null, `${attribute} must stay absent`);
  }
  for (const variable of ALL_VARIABLES) {
    if (TEXT_SIZE_VARIABLES.includes(variable)) {
      continue;
    }
    assert.equal(variables[variable], '', `${variable} must stay unset`);
  }
  assert.equal(document.getElementById(STYLE_ID), null);
});

test('disabling one group never disturbs the groups that stay enabled', () => {
  const document = new FakeDocument();
  const root = document.documentElement;
  const controller = createWebsiteAppearanceController(document);

  controller.apply(
    appearance({ textEnabled: true, themeEnabled: true, gradientEnabled: true })
  );
  const enabled = expectedSnapshots('text', 'theme', 'gradient');
  assert.deepEqual(attributeSnapshot(root), enabled.attributes);
  assert.deepEqual(variableSnapshot(root), enabled.variables);

  controller.apply(
    appearance({ textEnabled: true, themeEnabled: false, gradientEnabled: true })
  );
  const remaining = expectedSnapshots('text', 'gradient');
  assert.deepEqual(attributeSnapshot(root), remaining.attributes);
  assert.deepEqual(variableSnapshot(root), remaining.variables);

  controller.apply(appearance({ textEnabled: true }));
  const textOnly = expectedSnapshots('text');
  assert.deepEqual(attributeSnapshot(root), textOnly.attributes);
  assert.deepEqual(variableSnapshot(root), textOnly.variables);
});

test('the theme group derives its whole variable surface from the stored palette', () => {
  const document = new FakeDocument();
  const root = document.documentElement;
  const controller = createWebsiteAppearanceController(document);

  controller.apply(appearance({ themeEnabled: true }));
  for (const [name, value] of Object.entries(THEME_VARIABLES)) {
    assert.equal(root.style.getPropertyValue(name), value, `${name} must be derived`);
  }

  // A second palette whose derivations are trivial to verify by hand: white pulled 5%
  // toward black is 242.25 -> #f2f2f2 and 8% is 234.6 -> #ebebeb; pure red dropped 88%
  // onto white keeps its red channel and lifts the others to 224.4 -> #ffe0e0; mid grey
  // nudged 15% toward black is 108.8 -> #6d6d6d.
  controller.apply(
    appearance({
      themeEnabled: true,
      surfaceColor: '#ffffff',
      textColor: '#000000',
      borderColor: '#808080',
      dangerColor: '#ff0000',
      warningColor: '#00ff00',
      successColor: '#0000ff',
      speakerColors: ['#010203', '#0a141e', '#ffffff']
    })
  );
  assert.equal(root.style.getPropertyValue('--bh-surface-raised'), '#f2f2f2');
  assert.equal(root.style.getPropertyValue('--bh-surface-hover'), '#ebebeb');
  assert.equal(root.style.getPropertyValue('--bh-danger-tint'), '#ffe0e0');
  assert.equal(root.style.getPropertyValue('--bh-warning-tint'), '#e0ffe0');
  assert.equal(root.style.getPropertyValue('--bh-success-tint'), '#e0e0ff');
  assert.equal(root.style.getPropertyValue('--bh-scrollbar-thumb'), '#6d6d6d');
  assert.equal(
    root.style.getPropertyValue('--bh-speaker-1-tint'),
    'rgba(1, 2, 3, 0.25)'
  );
  assert.equal(
    root.style.getPropertyValue('--bh-speaker-2-tint'),
    'rgba(10, 20, 30, 0.25)'
  );
  assert.equal(
    root.style.getPropertyValue('--bh-speaker-3-tint'),
    'rgba(255, 255, 255, 0.25)'
  );
  // Nothing derived is ever persisted, so the palette dials still read back untouched.
  assert.equal(root.style.getPropertyValue('--bh-surface'), '#ffffff');
  assert.equal(root.style.getPropertyValue('--bh-text'), '#000000');
  assert.equal(root.style.getPropertyValue('--bh-border'), '#808080');
});

test('app design tokens are captured and restored exactly around the theme group', () => {
  const document = new FakeDocument();
  const root = document.documentElement;
  // The app sets most of its tokens from a stylesheet, so only some exist inline.
  root.style.setProperty('--background', '0 0% 100%', 'important');
  const controller = createWebsiteAppearanceController(document);

  controller.apply(appearance({ themeEnabled: true }));
  for (const [token, triplet] of Object.entries(APP_TOKENS)) {
    assert.equal(root.style.getPropertyValue(token), triplet, `${token} must be written`);
    assert.equal(
      root.style.getPropertyPriority(token),
      '',
      `${token} must never be written as important`
    );
  }
  assert.equal(
    root.style.hasProperty('--sidebar-accent'),
    false,
    'no token outside the mapping is ever written'
  );
  assert.equal(root.style.hasProperty('--chart-1'), false);

  controller.apply(appearance({ themeEnabled: false }));
  assert.equal(root.style.getPropertyValue('--background'), '0 0% 100%');
  assert.equal(root.style.getPropertyPriority('--background'), 'important');
  for (const token of Object.keys(APP_TOKENS)) {
    if (token === '--background') {
      continue;
    }
    assert.equal(
      root.style.hasProperty(token),
      false,
      `${token} must be removed rather than blanked`
    );
  }
  for (const name of Object.keys(THEME_VARIABLES)) {
    assert.equal(
      root.style.hasProperty(name),
      false,
      `${name} must be removed rather than blanked`
    );
  }
});

test('hex dials reach the app tokens as space-separated HSL triplets', () => {
  const CONVERSIONS = [
    ['#ffffff', '0 0% 100%'],
    ['#000000', '0 0% 0%'],
    ['#ff0000', '0 100% 50%'],
    ['#00ff00', '120 100% 50%'],
    ['#0000ff', '240 100% 50%'],
    ['#808080', '0 0% 50%'],
    ['#0f172a', '222 47% 11%'],
    ['#64b5f6', '207 89% 68%'],
    ['#b083ff', '262 100% 76%']
  ];
  const document = new FakeDocument();
  const root = document.documentElement;
  const controller = createWebsiteAppearanceController(document);

  for (const [hex, triplet] of CONVERSIONS) {
    controller.apply(appearance({ themeEnabled: true, pageColor: hex }));
    assert.equal(
      root.style.getPropertyValue('--background'),
      triplet,
      `${hex} must resolve to ${triplet}`
    );
    assert.equal(
      root.style.getPropertyValue('--bh-page'),
      hex,
      'the extension surface keeps the hex the token was derived from'
    );
  }
});

test('group dial changes are written in place and the master switch clears everything', () => {
  const document = new FakeDocument();
  const root = document.documentElement;
  const controller = createWebsiteAppearanceController(document);

  controller.apply(
    appearance({
      textEnabled: true,
      themeEnabled: true,
      gradientEnabled: true,
      customCssEnabled: true,
      customCss: '.dashboard { color: red; }'
    })
  );
  const style = document.getElementById(STYLE_ID);
  assert.equal(style.getAttribute('data-babel-helper-owner'), 'website-appearance');
  assert.equal(style.textContent, '.dashboard { color: red; }');

  controller.apply(
    appearance({
      textEnabled: true,
      themeEnabled: true,
      gradientEnabled: true,
      customCssEnabled: true,
      textSizePx: 999,
      tableTextSizePx: 0,
      surfaceColor: '#ABCDEF',
      gradientAngle: 999,
      gradientSpeed: 'fast',
      customCss: '.dashboard { color: blue; }'
    })
  );

  assert.equal(root.style.getPropertyValue('--bh-text-size'), '30px');
  assert.equal(root.style.getPropertyValue('--bh-table-text-size'), '10px');
  assert.equal(
    root.style.getPropertyValue('--bh-surface'),
    '#abcdef',
    'a dial is normalized before it is derived from'
  );
  // #abcdef pulled 5% toward #eef0f2: 171+67*.05=174.35, 205+35*.05=206.75, 239+3*.05=239.15
  assert.equal(root.style.getPropertyValue('--bh-surface-raised'), '#aecfef');
  assert.equal(root.style.getPropertyValue('--bh-gradient-angle'), '360deg');
  assert.equal(root.style.getPropertyValue('--bh-gradient-duration'), '8s');
  assert.equal(root.getAttribute('data-babel-helper-appearance-gradient-speed'), 'fast');
  assert.equal(document.getElementById(STYLE_ID), style);
  assert.equal(style.textContent, '.dashboard { color: blue; }');
  assert.equal(document.countElementsById(STYLE_ID), 1);

  controller.apply(
    appearance({
      enabled: false,
      textEnabled: true,
      themeEnabled: true,
      gradientEnabled: true,
      customCssEnabled: true,
      customCss: '.dashboard { color: blue; }'
    })
  );

  for (const attribute of ALL_ATTRIBUTES) {
    assert.equal(root.getAttribute(attribute), null, `${attribute} must be cleared`);
  }
  for (const variable of ALL_VARIABLES) {
    assert.equal(root.style.getPropertyValue(variable), '', `${variable} must be cleared`);
  }
  assert.equal(document.getElementById(STYLE_ID), null);
});

test('the gradient group carries every speed onto the root', () => {
  const DURATIONS = { slow: '24s', balanced: '14s', fast: '8s' };
  const document = new FakeDocument();
  const root = document.documentElement;
  const controller = createWebsiteAppearanceController(document);

  for (const [speed, duration] of Object.entries(DURATIONS)) {
    controller.apply(appearance({ gradientEnabled: true, gradientSpeed: speed }));
    assert.equal(
      root.getAttribute('data-babel-helper-appearance-gradient-speed'),
      speed,
      `${speed} must reach the root attribute`
    );
    assert.equal(root.style.getPropertyValue('--bh-gradient-duration'), duration);
  }

  controller.apply(
    appearance({
      gradientEnabled: true,
      gradientAngle: 7,
      gradientColors: ['#ABCDEF', 'not-a-color', '#010203']
    })
  );
  assert.equal(
    root.style.getPropertyValue('--bh-gradient-angle'),
    '0deg',
    'the angle is snapped to its 15 degree step before it reaches the page'
  );
  assert.equal(root.style.getPropertyValue('--bh-gradient-color-1'), '#abcdef');
  assert.equal(
    root.style.getPropertyValue('--bh-gradient-color-2'),
    '#2563eb',
    'a rejected stop falls back to its default rather than reaching CSS raw'
  );
  assert.equal(root.style.getPropertyValue('--bh-gradient-color-3'), '#010203');
});

test('invalid custom CSS is never retained or applied', () => {
  const document = new FakeDocument();
  const controller = createWebsiteAppearanceController(document);

  controller.apply(
    appearance({ customCssEnabled: true, customCss: '.dashboard { color: red; }' })
  );
  assert.ok(document.getElementById(STYLE_ID));

  controller.apply(
    appearance({
      customCssEnabled: true,
      customCss: '.x { background: url(https://example.com/x.png); }'
    })
  );
  assert.equal(document.getElementById(STYLE_ID), null);

  controller.apply(
    appearance({ customCssEnabled: true, customCss: '<style>.x { color: red; }</style>' })
  );
  assert.equal(document.getElementById(STYLE_ID), null);

  controller.apply(
    appearance({ customCssEnabled: false, customCss: '.dashboard { color: red; }' })
  );
  assert.equal(document.getElementById(STYLE_ID), null);
});

test('a same-id unowned node is never changed or removed', () => {
  const document = new FakeDocument();
  const collision = document.createElement('style');
  collision.id = STYLE_ID;
  collision.textContent = 'body { color: green; }';
  collision.setAttribute('data-babel-helper-owner', 'someone-else');
  document.head.appendChild(collision);
  const controller = createWebsiteAppearanceController(document);

  controller.apply(
    appearance({ customCssEnabled: true, customCss: '.dashboard { color: red; }' })
  );
  assert.equal(document.getElementById(STYLE_ID), collision);
  assert.equal(collision.textContent, 'body { color: green; }');
  assert.equal(collision.getAttribute('data-babel-helper-owner'), 'someone-else');
  assert.equal(document.countElementsById(STYLE_ID), 1);

  controller.apply(appearance({ enabled: false }));
  controller.dispose();
  assert.equal(document.getElementById(STYLE_ID), collision);
  assert.equal(collision.textContent, 'body { color: green; }');
});

test('repeated apply and dispose are idempotent', () => {
  const document = new FakeDocument();
  const root = document.documentElement;
  const controller = createWebsiteAppearanceController(document);
  const settings = appearance({
    textEnabled: true,
    themeEnabled: true,
    gradientEnabled: true,
    gradientSpeed: 'slow',
    customCssEnabled: true,
    customCss: '.dashboard { color: red; }'
  });

  controller.apply(settings);
  const applied = expectedSnapshots('text', 'theme', 'gradient');
  applied.attributes['data-babel-helper-appearance-gradient-speed'] = 'slow';
  applied.variables['--bh-gradient-duration'] = '24s';
  controller.apply(settings);
  assert.deepEqual(attributeSnapshot(root), applied.attributes);
  assert.deepEqual(variableSnapshot(root), applied.variables);
  assert.equal(document.countElementsById(STYLE_ID), 1);

  controller.dispose();
  controller.dispose();
  assert.equal(document.getElementById(STYLE_ID), null);
  for (const attribute of ALL_ATTRIBUTES) {
    assert.equal(root.getAttribute(attribute), null, `${attribute} must be restored`);
  }
  for (const variable of ALL_VARIABLES) {
    assert.equal(root.style.hasProperty(variable), false, `${variable} must be restored`);
  }

  controller.apply(settings);
  assert.equal(document.getElementById(STYLE_ID), null);
  assert.equal(root.getAttribute(MASTER_ATTRIBUTE), null);
});

test('an apply that changes nothing writes nothing', () => {
  const document = new FakeDocument();
  const root = document.documentElement;
  const controller = createWebsiteAppearanceController(document);
  const settled = appearance({
    textEnabled: true,
    themeEnabled: true,
    gradientEnabled: true
  });

  controller.apply(settled);
  const applied = expectedSnapshots('text', 'theme', 'gradient');
  const writes = trackWrites(root);

  controller.apply(settled);
  controller.apply(settled);
  assert.deepEqual(writes.attributes, [], 'a settled root takes no attribute write');
  assert.deepEqual(writes.variables, [], 'a settled root takes no declaration write');
  assert.deepEqual(attributeSnapshot(root), applied.attributes);
  assert.deepEqual(variableSnapshot(root), applied.variables);

  // A group that is off is restored once, not re-restored on every later apply.
  const gradientOff = appearance({ textEnabled: true, themeEnabled: true });
  controller.apply(gradientOff);
  const afterRestore = trackWrites(root);
  controller.apply(gradientOff);
  assert.deepEqual(afterRestore.attributes, [], 'a restored attribute stays restored');
  assert.deepEqual(afterRestore.variables, [], 'a restored declaration stays restored');
  assert.deepEqual(attributeSnapshot(root), expectedSnapshots('text', 'theme').attributes);
  assert.deepEqual(variableSnapshot(root), expectedSnapshots('text', 'theme').variables);
});

test('a changed dial writes only the declarations it feeds', () => {
  const document = new FakeDocument();
  const root = document.documentElement;
  const controller = createWebsiteAppearanceController(document);

  controller.apply(appearance({ themeEnabled: true }));
  const pageWrites = trackWrites(root);

  // #123456 is r18 g52 b86: hue 210, saturation 65%, lightness 20%.
  controller.apply(appearance({ themeEnabled: true, pageColor: '#123456' }));
  assert.deepEqual(pageWrites.attributes, [], 'a dial never rewrites the switches');
  assert.deepEqual(
    pageWrites.variables,
    ['--bh-page', '--background'],
    'the page dial feeds one extension variable and one app token, and nothing else'
  );
  assert.equal(root.style.getPropertyValue('--bh-page'), '#123456');
  assert.equal(root.style.getPropertyValue('--background'), '210 65% 20%');

  const surfaceWrites = trackWrites(root);

  // #303030 pulled 5% toward #eef0f2 is 57.5, 57.6, 57.7 -> #3a3a3a, and the three status
  // hues are dropped 88% onto the new surface.
  controller.apply(
    appearance({ themeEnabled: true, pageColor: '#123456', surfaceColor: '#303030' })
  );
  assert.deepEqual(
    surfaceWrites.variables,
    [
      '--bh-surface',
      '--bh-surface-raised',
      '--bh-surface-hover',
      '--bh-danger-tint',
      '--bh-warning-tint',
      '--bh-success-tint',
      '--card',
      '--popover',
      '--sidebar',
      '--muted',
      '--secondary',
      '--accent'
    ],
    'a dial that feeds derived values writes every one of them and nothing more'
  );
  assert.equal(root.style.getPropertyValue('--bh-surface-raised'), '#3a3a3a');
  assert.equal(root.style.getPropertyValue('--card'), '0 0% 19%');
  assert.equal(
    root.style.getPropertyValue('--bh-page'),
    '#123456',
    'a dial the palette did not move keeps the value it already had'
  );
});

test('late document root receives the latest settings and disposed waiters do not attach', () => {
  const document = new FakeDocument({ withRoot: false });
  const controller = createWebsiteAppearanceController(document);

  controller.apply(
    appearance({
      textEnabled: true,
      textSizePx: 23,
      themeEnabled: true,
      gradientEnabled: true,
      gradientSpeed: 'fast',
      customCssEnabled: true,
      customCss: '.dashboard { color: red; }'
    })
  );
  assert.equal(document.getElementById(STYLE_ID), null);

  const root = document.installRoot();
  document.dispatchEvent(new Event('DOMContentLoaded'));
  assert.equal(root.getAttribute(MASTER_ATTRIBUTE), 'enabled');
  assert.equal(root.getAttribute('data-babel-helper-appearance-theme'), 'enabled');
  assert.equal(root.style.getPropertyValue('--bh-text-size'), '23px');
  assert.equal(root.style.getPropertyValue('--bh-gradient-duration'), '8s');
  assert.equal(root.style.getPropertyValue('--bh-surface-hover'), '#303234');
  assert.equal(root.style.getPropertyValue('--background'), APP_TOKENS['--background']);
  assert.ok(document.getElementById(STYLE_ID));

  const disposedDocument = new FakeDocument({ withRoot: false });
  const disposedController = createWebsiteAppearanceController(disposedDocument);
  disposedController.apply(appearance({ textEnabled: true }));
  disposedController.dispose();
  const disposedRoot = disposedDocument.installRoot();
  disposedDocument.dispatchEvent(new Event('DOMContentLoaded'));
  assert.equal(disposedRoot.getAttribute(MASTER_ATTRIBUTE), null);
  assert.equal(disposedDocument.getElementById(STYLE_ID), null);
});

test('disable restores prior root state without clobbering later external changes', () => {
  const document = new FakeDocument();
  const root = document.documentElement;
  root.setAttribute(MASTER_ATTRIBUTE, 'native-appearance');
  root.style.setProperty('--bh-text-size', '14px', 'important');
  root.style.setProperty('--bh-page', '#eeeeee');
  root.style.setProperty('--bh-gradient-color-1', '#111111');
  const controller = createWebsiteAppearanceController(document);
  const groups = { textEnabled: true, themeEnabled: true, gradientEnabled: true };

  controller.apply(appearance(groups));
  root.setAttribute(MASTER_ATTRIBUTE, 'external-appearance');
  root.setAttribute('data-babel-helper-appearance-gradient-speed', 'external-speed');
  root.style.setProperty('--bh-text-size', '17px');
  root.style.setProperty('--bh-page', '#ababab');
  root.style.setProperty('--bh-gradient-color-1', '#abcdef', 'important');
  controller.apply(appearance({ ...groups, gradientSpeed: 'fast', textSizePx: 18 }));
  controller.apply(appearance({ ...groups, enabled: false }));

  assert.equal(root.getAttribute(MASTER_ATTRIBUTE), 'external-appearance');
  assert.equal(root.getAttribute('data-babel-helper-appearance-gradient'), null);
  assert.equal(
    root.getAttribute('data-babel-helper-appearance-gradient-speed'),
    'external-speed'
  );
  assert.equal(root.style.getPropertyValue('--bh-text-size'), '17px');
  assert.equal(root.style.getPropertyPriority('--bh-text-size'), '');
  assert.equal(root.style.getPropertyValue('--bh-page'), '#ababab');
  assert.equal(root.style.getPropertyValue('--bh-gradient-color-1'), '#abcdef');
  assert.equal(root.style.getPropertyPriority('--bh-gradient-color-1'), 'important');
});

test('turning one group off restores the values that group replaced', () => {
  const document = new FakeDocument();
  const root = document.documentElement;
  root.style.setProperty('--bh-border', '#010203', 'important');
  root.setAttribute('data-babel-helper-appearance-theme', 'native-theme');
  const controller = createWebsiteAppearanceController(document);

  controller.apply(appearance({ textEnabled: true, themeEnabled: true }));
  assert.equal(root.style.getPropertyValue('--bh-border'), PALETTE.borderColor);
  assert.equal(root.getAttribute('data-babel-helper-appearance-theme'), 'enabled');

  controller.apply(appearance({ textEnabled: true, themeEnabled: false }));
  assert.equal(root.style.getPropertyValue('--bh-border'), '#010203');
  assert.equal(root.style.getPropertyPriority('--bh-border'), 'important');
  assert.equal(root.getAttribute('data-babel-helper-appearance-theme'), 'native-theme');
  assert.equal(root.style.getPropertyValue('--bh-text-size'), '19px');

  root.style.setProperty('--bh-border', '#0a0b0c');
  controller.apply(appearance({ textEnabled: true, themeEnabled: true }));
  controller.apply(appearance({ textEnabled: true, themeEnabled: false }));
  assert.equal(
    root.style.getPropertyValue('--bh-border'),
    '#0a0b0c',
    'a re-enabled group must restore the value it actually replaced'
  );
});

test('owned style cleanup uses its exact element after a later same-id collision', () => {
  const document = new FakeDocument();
  const controller = createWebsiteAppearanceController(document);
  controller.apply(
    appearance({ customCssEnabled: true, customCss: '.dashboard { color: red; }' })
  );
  const ownedStyle = document.getElementById(STYLE_ID);

  const collision = document.createElement('style');
  collision.id = STYLE_ID;
  collision.textContent = 'body { color: green; }';
  collision.setAttribute('data-babel-helper-owner', 'someone-else');
  collision.parentNode = document.head;
  document.head.children.unshift(collision);
  assert.equal(document.getElementById(STYLE_ID), collision);

  controller.dispose();
  assert.equal(ownedStyle.parentNode, null);
  assert.equal(document.getElementById(STYLE_ID), collision);
  assert.equal(collision.textContent, 'body { color: green; }');
  assert.equal(document.countElementsById(STYLE_ID), 1);
});

test('an owned style that loses its id is dropped, never orphaned', () => {
  const document = new FakeDocument();
  const controller = createWebsiteAppearanceController(document);
  const owned = { customCssEnabled: true, customCss: '.a { color: red; }' };

  controller.apply(appearance(owned));
  const first = document.getElementById(STYLE_ID);
  first.id = 'someone-elses-id';

  controller.apply(appearance({ ...owned, customCss: '.b { color: blue; }' }));
  assert.equal(first.parentNode, null, 'the unreachable element must be removed');
  const second = document.getElementById(STYLE_ID);
  assert.notEqual(second, first);
  assert.equal(second.textContent, '.b { color: blue; }');
  assert.equal(
    document.findAllByAttribute('data-babel-helper-owner').length,
    1,
    'exactly one owned style may stay connected'
  );

  controller.dispose();
  assert.equal(document.findAllByAttribute('data-babel-helper-owner').length, 0);
});

test('the waveform bridge is injected once and carries the derived speaker slots', () => {
  installChromeRuntime();
  try {
    const document = new FakeDocument();
    const root = document.documentElement;
    const configs = captureWaveformConfigs(document);
    const controller = createWebsiteAppearanceController(document);

    controller.apply(appearance({ themeEnabled: true }));

    const scripts = document.findAllByAttribute(WAVEFORM_BRIDGE_ATTRIBUTE);
    assert.equal(scripts.length, 1, 'exactly one bridge script must be injected');
    const script = scripts[0];
    assert.equal(script.tagName, 'SCRIPT');
    assert.equal(script.src, `chrome-extension://babel-helper/${WAVEFORM_BRIDGE_PATH}`);
    assert.equal(script.async, false);
    assert.equal(script.parentNode, root);
    assert.deepEqual(configs, [], 'no config may be sent before the bridge loads');

    controller.apply(appearance({ themeEnabled: true }));
    assert.equal(
      document.findAllByAttribute(WAVEFORM_BRIDGE_ATTRIBUTE).length,
      1,
      'a pending injection must never be duplicated'
    );

    script.onload();
    assert.equal(script.parentNode, null, 'the loaded bridge script removes itself');
    assert.deepEqual(configs, [{ enabled: true, lanes: EXPECTED_SLOTS }]);

    controller.apply(
      appearance({
        themeEnabled: true,
        waveColor: '#0F172A',
        textColor: '#FFFFFF',
        speakerColors: ['#111111', 'not-a-color', '#333333']
      })
    );
    assert.deepEqual(configs.at(-1), {
      enabled: true,
      lanes: [
        {
          waveColor: '#0f172a',
          progressColor: '#111111',
          cursorColor: '#ffffff',
          regionColor: '#111111',
          regionBorderColor: '#111111'
        },
        {
          waveColor: '#0f172a',
          progressColor: '#b083ff',
          cursorColor: '#ffffff',
          regionColor: '#b083ff',
          regionBorderColor: '#b083ff'
        },
        {
          waveColor: '#0f172a',
          progressColor: '#333333',
          cursorColor: '#ffffff',
          regionColor: '#333333',
          regionBorderColor: '#333333'
        }
      ]
    });
    assert.equal(configs.length, 2);
    assert.equal(
      document.findAllByAttribute(WAVEFORM_BRIDGE_ATTRIBUTE).length,
      0,
      'the bridge is injected once per controller'
    );

    controller.apply(appearance({ themeEnabled: false }));
    assert.deepEqual(
      configs.at(-1),
      { enabled: false, lanes: EXPECTED_SLOTS },
      'a disabled theme still ships the palette so the bridge can restore cleanly'
    );
    assert.equal(root.getAttribute('data-babel-helper-appearance-theme'), null);
    assert.equal(root.style.getPropertyValue('--bh-wave'), '');

    controller.apply(appearance({ themeEnabled: true }));
    assert.equal(configs.at(-1).enabled, true);
    assert.equal(
      document.findAllByAttribute(WAVEFORM_BRIDGE_ATTRIBUTE).length,
      0,
      'a ready bridge is never re-injected'
    );

    controller.apply(appearance({ enabled: false, themeEnabled: true }));
    assert.equal(
      configs.at(-1).enabled,
      false,
      'the master switch disables waveform theming too'
    );

    const beforeDispose = configs.length;
    controller.apply(appearance({ themeEnabled: true }));
    assert.equal(configs.at(-1).enabled, true);
    controller.dispose();
    assert.equal(configs.length, beforeDispose + 2);
    assert.deepEqual(configs.at(-1), { enabled: false, lanes: EXPECTED_SLOTS });

    controller.apply(appearance({ themeEnabled: true }));
    assert.equal(configs.length, beforeDispose + 2, 'a disposed controller stays silent');
  } finally {
    delete globalThis.chrome;
  }
});

test('only the dials the lanes are made of reach the bridge', () => {
  installChromeRuntime();
  try {
    const document = new FakeDocument();
    const configs = captureWaveformConfigs(document);
    const controller = createWebsiteAppearanceController(document);
    const lanes = {
      themeEnabled: true,
      waveColor: '#010203',
      textColor: '#fefefe',
      speakerColors: ['#111111', '#222222', '#333333']
    };

    controller.apply(appearance({ themeEnabled: true }));
    document.findAllByAttribute(WAVEFORM_BRIDGE_ATTRIBUTE)[0].onload();
    assert.equal(configs.length, 1, 'the load itself carries the first config');

    controller.apply(appearance({ themeEnabled: true }));
    controller.apply(appearance({ themeEnabled: true, surfaceColor: '#303030' }));
    controller.apply(
      appearance({
        themeEnabled: true,
        surfaceColor: '#303030',
        accentColor: '#654321',
        borderColor: '#0a0b0c',
        pageColor: '#123456'
      })
    );
    assert.equal(
      configs.length,
      1,
      'a drag on a CSS-only dial never crosses into the page world'
    );
    assert.equal(
      document.documentElement.style.getPropertyValue('--bh-accent'),
      '#654321',
      'those dials still reach the page as CSS'
    );

    controller.apply(appearance({ themeEnabled: true, waveColor: lanes.waveColor }));
    assert.equal(configs.length, 2);
    assert.equal(configs.at(-1).lanes[0].waveColor, '#010203');

    controller.apply(appearance({ ...lanes, textColor: PALETTE.textColor }));
    assert.equal(configs.length, 3);
    assert.deepEqual(
      configs.at(-1).lanes.map((lane) => lane.progressColor),
      ['#111111', '#222222', '#333333']
    );

    controller.apply(appearance(lanes));
    assert.equal(configs.length, 4);
    assert.equal(configs.at(-1).lanes[0].cursorColor, '#fefefe');

    controller.apply(appearance(lanes));
    assert.equal(configs.length, 4, 'an unchanged palette re-sends nothing');
  } finally {
    delete globalThis.chrome;
  }
});

test('the waveform bridge stays absent until the theme group is painting', () => {
  installChromeRuntime();
  try {
    const document = new FakeDocument();
    const configs = captureWaveformConfigs(document);
    const controller = createWebsiteAppearanceController(document);

    controller.apply(appearance({ textEnabled: true, gradientEnabled: true }));
    controller.apply(appearance({ enabled: false, themeEnabled: true }));
    assert.equal(document.findAllByAttribute(WAVEFORM_BRIDGE_ATTRIBUTE).length, 0);
    assert.deepEqual(configs, []);

    controller.dispose();
    assert.deepEqual(configs, [], 'nothing to restore means nothing to dispatch');
  } finally {
    delete globalThis.chrome;
  }
});

test('the bridge is never injected without an extension runtime', () => {
  const document = new FakeDocument();
  const configs = captureWaveformConfigs(document);
  const controller = createWebsiteAppearanceController(document);

  controller.apply(appearance({ themeEnabled: true }));
  assert.equal(document.findAllByAttribute(WAVEFORM_BRIDGE_ATTRIBUTE).length, 0);
  assert.deepEqual(configs, []);
  assert.equal(
    document.documentElement.getAttribute('data-babel-helper-appearance-theme'),
    'enabled',
    'a missing runtime never blocks the CSS side of the theme'
  );
});

test('a failed bridge load is retried on the next theme apply', () => {
  installChromeRuntime();
  try {
    const document = new FakeDocument();
    const configs = captureWaveformConfigs(document);
    const controller = createWebsiteAppearanceController(document);

    controller.apply(appearance({ themeEnabled: true }));
    const failing = document.findAllByAttribute(WAVEFORM_BRIDGE_ATTRIBUTE)[0];
    failing.onerror();
    assert.equal(failing.parentNode, null);
    assert.deepEqual(configs, []);

    controller.apply(appearance({ themeEnabled: true }));
    const retried = document.findAllByAttribute(WAVEFORM_BRIDGE_ATTRIBUTE);
    assert.equal(retried.length, 1);
    retried[0].onload();
    assert.deepEqual(configs, [{ enabled: true, lanes: EXPECTED_SLOTS }]);
  } finally {
    delete globalThis.chrome;
  }
});

test('a bridge that loads after dispose never receives a stale enabled config', () => {
  installChromeRuntime();
  try {
    const document = new FakeDocument();
    const configs = captureWaveformConfigs(document);
    const controller = createWebsiteAppearanceController(document);

    controller.apply(appearance({ themeEnabled: true }));
    const script = document.findAllByAttribute(WAVEFORM_BRIDGE_ATTRIBUTE)[0];
    controller.dispose();
    assert.equal(script.parentNode, null, 'dispose detaches the pending script');
    script.onload();
    assert.deepEqual(configs, []);
  } finally {
    delete globalThis.chrome;
  }
});

const SCOPE_ATTRIBUTE = 'data-babel-helper-scope';
const ROW_TEXTAREA_PLACEHOLDER = 'What was said…';

// The scope marks live on the page rather than on the root, so these fixtures need a body,
// a MutationObserver and a clock. All three reach the controller through the document's own
// view, exactly as a browser hands them over.
function scopeFixture() {
  const document = new FakeDocument();
  const body = new FakeElement('body');
  document.documentElement.appendChild(body);
  document.body = body;

  const observers = [];
  const timers = [];
  const view = document.defaultView;
  view.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      observers.push(this);
    }

    observe(target, options) {
      this.observed.push({ target, options });
    }

    disconnect() {
      this.disconnected = true;
    }
  };
  view.setTimeout = (callback, delay) => {
    timers.push({ callback, delay, cancelled: false, ran: false });
    return timers.length;
  };
  view.clearTimeout = (handle) => {
    const timer = timers[handle - 1];
    if (timer) {
      timer.cancelled = true;
    }
  };

  return {
    document,
    body,
    observers,
    // The root is present in every scope fixture, so the scope observer is the only one a
    // controller ever builds here.
    get observer() {
      return observers[observers.length - 1];
    },
    emit(records, observer = observers[observers.length - 1]) {
      observer.callback(records, observer);
    },
    flush() {
      for (const timer of timers) {
        if (timer.cancelled || timer.ran) {
          continue;
        }
        timer.ran = true;
        timer.callback();
      }
    },
    pending() {
      return timers.filter((timer) => !timer.cancelled && !timer.ran).length;
    },
    delays() {
      return timers.map((timer) => timer.delay);
    }
  };
}

function rowTextarea({ placeholder = true } = {}) {
  const textarea = new FakeElement('textarea');
  if (placeholder) {
    textarea.setAttribute('placeholder', ROW_TEXTAREA_PLACEHOLDER);
  } else {
    textarea.setAttribute('class', 'w-full text-xs');
  }
  return textarea;
}

function mountTranscript(parent) {
  const main = new FakeElement('main');
  const table = new FakeElement('table');
  table.appendChild(rowTextarea());
  main.appendChild(table);
  parent.appendChild(main);
  return { main, table };
}

function scopeMarks(document) {
  return document
    .findAllByAttribute(SCOPE_ATTRIBUTE)
    .map((element) => [element.tagName, element.getAttribute(SCOPE_ATTRIBUTE)]);
}

test('the transcript scope is marked while the master switch is on', () => {
  const fixture = scopeFixture();
  const { main, table } = mountTranscript(fixture.body);
  // The sheet's old gate accepted `textarea.w-full` as a row marker too, so a second
  // transcript table keeps its palette, and a table without rows never had one.
  const wideTable = new FakeElement('table');
  wideTable.appendChild(rowTextarea({ placeholder: false }));
  main.appendChild(wideTable);
  const chromeTable = new FakeElement('table');
  main.appendChild(chromeTable);
  const controller = createWebsiteAppearanceController(fixture.document);

  controller.apply(appearance({ themeEnabled: true }));

  assert.deepEqual(scopeMarks(fixture.document), [
    ['MAIN', 'transcript'],
    ['TABLE', 'transcript-table'],
    ['TABLE', 'transcript-table']
  ]);
  assert.equal(main.getAttribute(SCOPE_ATTRIBUTE), 'transcript');
  assert.equal(table.getAttribute(SCOPE_ATTRIBUTE), 'transcript-table');
  assert.equal(wideTable.getAttribute(SCOPE_ATTRIBUTE), 'transcript-table');
  assert.equal(chromeTable.getAttribute(SCOPE_ATTRIBUTE), null);
  assert.equal(fixture.document.documentElement.getAttribute(SCOPE_ATTRIBUTE), null);

  assert.equal(fixture.observers.length, 1);
  assert.equal(fixture.observer.observed.length, 1);
  assert.equal(fixture.observer.observed[0].target, fixture.body);
  assert.deepEqual(fixture.observer.observed[0].options, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [SCOPE_ATTRIBUTE]
  });

  controller.dispose();
});

test('a page without a transcript is never marked', () => {
  const fixture = scopeFixture();
  // A main the transcript does not live in, and a transcript table outside every main.
  const settingsMain = new FakeElement('main');
  settingsMain.appendChild(new FakeElement('table'));
  fixture.body.appendChild(settingsMain);
  const strayTable = new FakeElement('table');
  strayTable.appendChild(rowTextarea());
  fixture.body.appendChild(strayTable);
  const controller = createWebsiteAppearanceController(fixture.document);

  controller.apply(appearance({ themeEnabled: true, textEnabled: true }));

  assert.deepEqual(scopeMarks(fixture.document), []);
  assert.equal(
    fixture.document.documentElement.getAttribute(MASTER_ATTRIBUTE),
    'enabled',
    'the palette still paints everything that does not need the scope'
  );

  // The transcript arriving on a route change is what the observer is for.
  const { main, table } = mountTranscript(fixture.body);
  fixture.emit([
    { type: 'childList', target: fixture.body, addedNodes: [main], removedNodes: [] }
  ]);
  fixture.flush();
  assert.equal(main.getAttribute(SCOPE_ATTRIBUTE), 'transcript');
  assert.equal(table.getAttribute(SCOPE_ATTRIBUTE), 'transcript-table');

  controller.dispose();
});

test('a replaced transcript is re-marked once per mutation burst', () => {
  const fixture = scopeFixture();
  const first = mountTranscript(fixture.body);
  const controller = createWebsiteAppearanceController(fixture.document);
  controller.apply(appearance({ themeEnabled: true }));
  assert.equal(first.main.getAttribute(SCOPE_ATTRIBUTE), 'transcript');

  first.main.remove();
  const second = mountTranscript(fixture.body);
  fixture.emit([
    {
      type: 'childList',
      target: fixture.body,
      addedNodes: [second.main],
      removedNodes: [first.main]
    }
  ]);
  fixture.emit([
    { type: 'childList', target: second.main, addedNodes: [second.table], removedNodes: [] }
  ]);
  assert.equal(fixture.pending(), 1, 'a burst of mutations coalesces into one pass');
  assert.deepEqual(fixture.delays(), [150]);

  fixture.flush();
  assert.deepEqual(scopeMarks(fixture.document), [
    ['MAIN', 'transcript'],
    ['TABLE', 'transcript-table']
  ]);
  assert.equal(second.main.getAttribute(SCOPE_ATTRIBUTE), 'transcript');
  assert.equal(second.table.getAttribute(SCOPE_ATTRIBUTE), 'transcript-table');
  assert.equal(
    first.main.getAttribute(SCOPE_ATTRIBUTE),
    null,
    'the transcript that left keeps no mark'
  );

  // Typing in a row is text, and a row that only changes attributes is not a transcript
  // moving: neither may cost a pass.
  fixture.emit([
    { type: 'childList', target: second.table, addedNodes: [{ nodeType: 3 }], removedNodes: [] }
  ]);
  fixture.emit([
    { type: 'childList', target: second.table, addedNodes: [], removedNodes: [] }
  ]);
  assert.equal(fixture.pending(), 0);

  controller.dispose();
});

test('disable and dispose put the transcript back exactly as it was', () => {
  const fixture = scopeFixture();
  const { main, table } = mountTranscript(fixture.body);
  main.setAttribute(SCOPE_ATTRIBUTE, 'app-owned');
  const controller = createWebsiteAppearanceController(fixture.document);

  controller.apply(appearance({ themeEnabled: true }));
  assert.equal(main.getAttribute(SCOPE_ATTRIBUTE), 'transcript');
  assert.equal(table.getAttribute(SCOPE_ATTRIBUTE), 'transcript-table');

  controller.apply(appearance({ enabled: false, themeEnabled: true }));
  assert.equal(main.getAttribute(SCOPE_ATTRIBUTE), 'app-owned', 'a captured value comes back');
  assert.equal(table.getAttribute(SCOPE_ATTRIBUTE), null, 'a mark of ours leaves nothing');
  assert.equal(fixture.observers[0].disconnected, true, 'disable disconnects the observer');
  assert.equal(fixture.pending(), 0);

  controller.apply(appearance({ themeEnabled: true }));
  assert.equal(main.getAttribute(SCOPE_ATTRIBUTE), 'transcript');
  assert.equal(table.getAttribute(SCOPE_ATTRIBUTE), 'transcript-table');
  assert.equal(fixture.observers.length, 2, 'a re-enable takes a fresh observer');

  controller.dispose();
  assert.equal(main.getAttribute(SCOPE_ATTRIBUTE), 'app-owned');
  assert.equal(table.getAttribute(SCOPE_ATTRIBUTE), null);
  assert.deepEqual(
    scopeMarks(fixture.document),
    [['MAIN', 'app-owned']],
    'the page keeps its own value and nothing else carries a mark'
  );
  assert.equal(fixture.observers[1].disconnected, true, 'dispose disconnects the observer');

  fixture.emit(
    [{ type: 'childList', target: fixture.body, addedNodes: [main], removedNodes: [] }],
    fixture.observers[1]
  );
  assert.equal(fixture.pending(), 0, 'a disposed controller schedules nothing');
});

test('an outside hand on a scope mark is repaired, never clobbered', () => {
  const fixture = scopeFixture();
  const { main } = mountTranscript(fixture.body);
  const controller = createWebsiteAppearanceController(fixture.document);
  controller.apply(appearance({ themeEnabled: true }));

  // Our own mark coming back through the observer has nothing to reconcile.
  fixture.emit([
    { type: 'attributes', attributeName: SCOPE_ATTRIBUTE, target: main }
  ]);
  assert.equal(fixture.pending(), 0);

  main.setAttribute(SCOPE_ATTRIBUTE, 'app-owned');
  fixture.emit([
    { type: 'attributes', attributeName: SCOPE_ATTRIBUTE, target: main }
  ]);
  assert.equal(fixture.pending(), 1);
  fixture.flush();
  assert.equal(main.getAttribute(SCOPE_ATTRIBUTE), 'transcript', 'the gate is repaired');

  controller.apply(appearance({ enabled: false, themeEnabled: true }));
  assert.equal(
    main.getAttribute(SCOPE_ATTRIBUTE),
    'app-owned',
    'the value the page set last is the value that comes back'
  );

  controller.dispose();
});

test('a palette drag never touches the DOM to keep the scope marks', () => {
  const fixture = scopeFixture();
  const { main, table } = mountTranscript(fixture.body);
  let queries = 0;
  const search = fixture.body.querySelectorAll.bind(fixture.body);
  fixture.body.querySelectorAll = (selector) => {
    queries += 1;
    return search(selector);
  };
  const controller = createWebsiteAppearanceController(fixture.document);

  controller.apply(appearance({ themeEnabled: true }));
  assert.equal(queries, 1, 'the first apply marks the scope');

  for (const accentColor of ['#111111', '#222222', '#333333', '#444444']) {
    controller.apply(appearance({ themeEnabled: true, accentColor }));
  }
  assert.equal(queries, 1, 'a live observer is the whole apply-time check');
  assert.equal(main.getAttribute(SCOPE_ATTRIBUTE), 'transcript');
  assert.equal(table.getAttribute(SCOPE_ATTRIBUTE), 'transcript-table');

  controller.dispose();
});

test('without a MutationObserver the marks are reconciled on the next apply', () => {
  const fixture = scopeFixture();
  delete fixture.document.defaultView.MutationObserver;
  const first = mountTranscript(fixture.body);
  const controller = createWebsiteAppearanceController(fixture.document);

  controller.apply(appearance({ themeEnabled: true }));
  assert.equal(first.main.getAttribute(SCOPE_ATTRIBUTE), 'transcript');
  assert.equal(fixture.observers.length, 0);

  first.main.remove();
  const second = mountTranscript(fixture.body);
  controller.apply(appearance({ themeEnabled: true }));
  assert.equal(second.main.getAttribute(SCOPE_ATTRIBUTE), 'transcript');
  assert.equal(second.table.getAttribute(SCOPE_ATTRIBUTE), 'transcript-table');
  assert.equal(first.main.getAttribute(SCOPE_ATTRIBUTE), null);
  assert.equal(fixture.pending(), 0, 'no timer, no polling');

  controller.dispose();
  assert.deepEqual(scopeMarks(fixture.document), []);
});

function installFakeStorage({ storedSettings = null } = {}) {
  const listeners = new Set();
  const writes = [];
  const store = storedSettings ? { settings: storedSettings } : {};
  const controls = {
    writes,
    store,
    readError: null,
    writeError: null,
    reads: 0,
    emit(next) {
      store.settings = next;
      for (const listener of listeners) {
        listener({ settings: { newValue: next } }, 'local');
      }
    },
    setStored(next) {
      store.settings = next;
    },
    settle(index) {
      writes[index].callback();
    }
  };
  globalThis.chrome = {
    runtime: {
      getURL(path) {
        return path;
      }
    },
    storage: {
      local: {
        get(_key, callback) {
          controls.reads += 1;
          if (controls.readError) {
            globalThis.chrome.runtime.lastError = controls.readError;
            callback({});
            delete globalThis.chrome.runtime.lastError;
            return;
          }
          callback({ ...store });
        },
        set(payload, callback) {
          writes.push({
            payload,
            callback() {
              if (controls.writeError) {
                globalThis.chrome.runtime.lastError = controls.writeError;
                callback();
                delete globalThis.chrome.runtime.lastError;
                return;
              }
              Object.assign(store, payload);
              callback();
            }
          });
        }
      },
      onChanged: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        }
      }
    }
  };
  return controls;
}

async function startKernelHarness(storage) {
  const { createHelperKernel } = await importKernelHarness();
  const kernel = createHelperKernel();
  const harness = globalThis.__babelHelperAppearanceKernelHarness;
  return { kernel, harness, panel: harness.panelOptions, storage };
}

function releaseKernelHarness() {
  delete globalThis.chrome;
  delete globalThis.__babelHelperAppearanceKernelHarness;
}

async function waitForWrites(storage, count) {
  for (let attempt = 0; attempt < 50 && storage.writes.length < count; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(storage.writes.length, count);
}

test('previews and commits are refused until the first storage load completes', async () => {
  const storage = installFakeStorage();
  try {
    const { kernel, harness, panel } = await startKernelHarness(storage);
    const draft = {
      ...panel.getSettings(),
      enabled: true,
      textEnabled: true,
      textSizePx: 21
    };

    panel.onPreview(draft);
    assert.equal(
      harness.controllerApplies.length,
      0,
      'a defaults draft must never reach the page before stored settings arrive'
    );
    assert.deepEqual(await panel.onCommit(draft), {
      saved: false,
      error: 'Settings are still loading.'
    });
    assert.equal(storage.writes.length, 0, 'nothing may be written before the first load');

    await kernel.start();
    panel.onPreview(draft);
    assert.equal(harness.controllerApplies.at(-1).textSizePx, 21);
    const commit = panel.onCommit(draft);
    await waitForWrites(storage, 1);
    storage.settle(0);
    assert.deepEqual(await commit, { saved: true });
    await kernel.stop();
  } finally {
    releaseKernelHarness();
  }
});

test('a commit merges into the freshly stored record, never the in-memory copy', async () => {
  const storage = installFakeStorage({
    storedSettings: {
      highlightedWordsEnabled: true,
      highlightedWords: ['alpha'],
      ghostCursor: { color: '#abcdef' }
    }
  });
  try {
    const { kernel, panel } = await startKernelHarness(storage);
    await kernel.start();
    assert.deepEqual(kernel.helper.settings.highlightedWords, ['alpha']);

    // Another surface writes while this tab misses the change notification.
    storage.setStored({
      highlightedWordsEnabled: true,
      highlightedWords: ['beta'],
      ghostCursor: { color: '#123456' }
    });

    const draft = {
      ...panel.getSettings(),
      enabled: true,
      textEnabled: true,
      textSizePx: 24
    };
    panel.onPreview(draft);
    const commit = panel.onCommit(draft);
    await waitForWrites(storage, 1);
    const written = storage.writes[0].payload.settings;
    assert.deepEqual(
      written.highlightedWords,
      ['beta'],
      'the commit must carry the stored record, not the settings this tab holds'
    );
    assert.equal(written.ghostCursor.color, '#123456');
    assert.equal(written.websiteAppearance.textSizePx, 24);
    assert.equal(written.websiteAppearance.textEnabled, true);
    storage.settle(0);
    assert.deepEqual(await commit, { saved: true });
    await kernel.stop();
  } finally {
    releaseKernelHarness();
  }
});

test('a failed write is reported and keeps the preview pending', async () => {
  const storage = installFakeStorage({ storedSettings: { highlightedWords: ['alpha'] } });
  try {
    const { kernel, panel } = await startKernelHarness(storage);
    await kernel.start();
    const draft = {
      ...panel.getSettings(),
      enabled: true,
      textEnabled: true,
      textSizePx: 26
    };

    storage.writeError = { message: 'QUOTA_BYTES quota exceeded' };
    panel.onPreview(draft);
    const failed = panel.onCommit(draft);
    await waitForWrites(storage, 1);
    storage.settle(0);
    assert.deepEqual(await failed, {
      saved: false,
      error: 'Could not save settings: QUOTA_BYTES quota exceeded'
    });

    storage.emit({ ...storage.store.settings, websiteAppearance: { enabled: false } });
    assert.equal(
      kernel.helper.settings.websiteAppearance.textSizePx,
      26,
      'a failed save keeps the preview pending so the live page keeps the user values'
    );
    assert.equal(kernel.helper.settings.websiteAppearance.enabled, true);

    storage.writeError = null;
    const retry = panel.onCommit(draft);
    await waitForWrites(storage, 2);
    storage.settle(1);
    assert.deepEqual(await retry, { saved: true });
    storage.emit({
      ...storage.store.settings,
      websiteAppearance: { ...storage.store.settings.websiteAppearance, textSizePx: 17 }
    });
    assert.equal(
      kernel.helper.settings.websiteAppearance.textSizePx,
      17,
      'a successful save releases the preview again'
    );
    await kernel.stop();
  } finally {
    releaseKernelHarness();
  }
});

test('a failed reload never becomes a defaults write', async () => {
  const storage = installFakeStorage({ storedSettings: { highlightedWords: ['alpha'] } });
  try {
    const { kernel, panel } = await startKernelHarness(storage);
    await kernel.start();
    const draft = {
      ...panel.getSettings(),
      enabled: true,
      textEnabled: true,
      textSizePx: 28
    };

    storage.readError = { message: 'Extension context invalidated.' };
    panel.onPreview(draft);
    assert.deepEqual(await panel.onCommit(draft), {
      saved: false,
      error: 'Extension context invalidated.'
    });
    assert.equal(storage.writes.length, 0);

    storage.readError = null;
    const commit = panel.onCommit(draft);
    await waitForWrites(storage, 1);
    assert.deepEqual(storage.writes[0].payload.settings.highlightedWords, ['alpha']);
    storage.settle(0);
    assert.deepEqual(await commit, { saved: true });
    await kernel.stop();
  } finally {
    releaseKernelHarness();
  }
});

test('a storage change releases the gate a failed initial read left closed', async () => {
  const storage = installFakeStorage({ storedSettings: { highlightedWords: ['alpha'] } });
  storage.readError = { message: 'Extension context invalidated.' };
  try {
    const { kernel, panel } = await startKernelHarness(storage);
    await kernel.start();
    const draft = {
      ...panel.getSettings(),
      enabled: true,
      textEnabled: true,
      textSizePx: 19
    };

    panel.onPreview(draft);
    assert.deepEqual(await panel.onCommit(draft), {
      saved: false,
      error: 'Settings are still loading.'
    });
    assert.equal(storage.writes.length, 0);

    storage.readError = null;
    storage.emit({ highlightedWords: ['beta'], highlightedWordsEnabled: true });
    panel.onPreview(draft);
    const commit = panel.onCommit(draft);
    await waitForWrites(storage, 1);
    assert.deepEqual(storage.writes[0].payload.settings.highlightedWords, ['beta']);
    assert.equal(storage.writes[0].payload.settings.websiteAppearance.textSizePx, 19);
    storage.settle(0);
    assert.deepEqual(await commit, { saved: true });
    await kernel.stop();
  } finally {
    releaseKernelHarness();
  }
});

test('storage echoes preserve newer previews and reconcile the latest committed appearance', async () => {
  const storage = installFakeStorage();
  try {
    const { kernel, harness, panel } = await startKernelHarness(storage);
    await kernel.start();
    assert.equal(harness.panelSyncs.length, 1, 'loaded settings reach the panel draft');
    assert.equal(harness.panelSyncs[0].enabled, false);

    const firstPreview = {
      ...panel.getSettings(),
      enabled: true,
      textEnabled: true,
      textSizePx: 18
    };
    panel.onPreview(firstPreview);
    const firstCommit = panel.onCommit(firstPreview);
    await waitForWrites(storage, 1);
    assert.equal(
      harness.panelSyncs.length,
      1,
      'the panel own previews and commits never sync back into its draft'
    );

    const secondPreview = {
      ...firstPreview,
      textSizePx: 22,
      themeEnabled: true,
      textColor: '#ffffff'
    };
    panel.onPreview(secondPreview);
    const secondCommit = panel.onCommit(secondPreview);
    const firstSaved = storage.writes[0].payload.settings;
    const staleEcho = {
      ...firstSaved,
      highlightedWordsEnabled: !firstSaved.highlightedWordsEnabled
    };
    storage.emit(staleEcho);
    assert.equal(kernel.helper.settings.websiteAppearance.textSizePx, 22);
    assert.equal(
      kernel.helper.settings.highlightedWordsEnabled,
      staleEcho.highlightedWordsEnabled
    );
    assert.equal(harness.controllerApplies.at(-1).textSizePx, 22);
    assert.equal(harness.controllerApplies.at(-1).themeEnabled, true);
    assert.equal(harness.panelSyncs.length, 2);
    assert.equal(
      harness.panelSyncs.at(-1).textSizePx,
      22,
      'a stale echo syncs the appearance the kernel kept, not the echoed one'
    );

    storage.settle(0);
    assert.deepEqual(await firstCommit, { saved: true });
    await waitForWrites(storage, 2);
    const secondSaved = storage.writes[1].payload.settings;
    assert.equal(
      secondSaved.highlightedWordsEnabled,
      firstSaved.highlightedWordsEnabled,
      'the second commit rebases on the record storage really holds'
    );
    assert.equal(secondSaved.websiteAppearance.textSizePx, 22);

    storage.settle(1);
    assert.deepEqual(await secondCommit, { saved: true });

    const externalAppearance = {
      ...secondSaved,
      ghostCursor: { ...secondSaved.ghostCursor, color: '#123456' },
      websiteAppearance: {
        ...secondSaved.websiteAppearance,
        textSizePx: 25
      }
    };
    storage.emit(externalAppearance);
    assert.equal(
      kernel.helper.settings.websiteAppearance.textSizePx,
      25,
      'once the commit landed, an external appearance change is adopted'
    );
    assert.equal(kernel.helper.settings.ghostCursor.color, '#123456');
    assert.equal(
      harness.panelSyncs.at(-1).textSizePx,
      25,
      'an external appearance change must reach the panel sync path'
    );
    assert.equal(harness.panelSyncs.at(-1).themeEnabled, true);

    await kernel.stop();
    assert.deepEqual(
      await panel.onCommit({ ...externalAppearance.websiteAppearance, textSizePx: 29 }),
      { saved: false }
    );
    await waitForWrites(storage, 2);
    assert.equal(harness.panelDisposed, true);
    assert.equal(harness.controllerDisposed, true);
  } finally {
    releaseKernelHarness();
  }
});
