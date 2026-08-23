import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function importEntry(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20'
  });
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64');
  return import(`data:text/javascript;base64,${source}`);
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.defaultPrevented = false;
    this.propagationStopped = false;
    Object.assign(this, init);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  stopImmediatePropagation() {
    this.propagationStopped = true;
    this.immediatePropagationStopped = true;
  }
}

class FakeClassList {
  constructor(element) {
    this.element = element;
  }

  contains(name) {
    return (this.element.getAttribute('class') ?? '').split(/\s+/).includes(name);
  }

  toggle(name, force) {
    const names = new Set((this.element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean));
    const enabled = force ?? !names.has(name);
    if (enabled) {
      names.add(name);
    } else {
      names.delete(name);
    }
    this.element.setAttribute('class', [...names].join(' '));
    return enabled;
  }
}

class FakeNode {
  constructor() {
    this.parentNode = null;
    this.children = [];
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  dispatchEvent(event) {
    if (this.disabled && (event.type === 'input' || event.type === 'change')) {
      return true;
    }
    if (!event.target) {
      event.target = this;
    }
    event.currentTarget = this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener.call(this, event);
      if (event.immediatePropagationStopped) {
        break;
      }
    }
    if (event.bubbles && !event.propagationStopped && this.parentNode) {
      this.parentNode.dispatchEvent(event);
    }
    return !event.defaultPrevented;
  }

  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) {
      return;
    }
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
}

function matchesSelector(element, selector) {
  if (selector.startsWith('#')) {
    return element.getAttribute('id') === selector.slice(1);
  }
  const attributeMatch = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attributeMatch) {
    const [, name, expected] = attributeMatch;
    return expected === undefined
      ? element.getAttribute(name) !== null
      : element.getAttribute(name) === expected;
  }
  return false;
}

function findElement(root, selector) {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) {
      return child;
    }
    const nested = findElement(child, selector);
    if (nested) {
      return nested;
    }
  }
  return null;
}

class FakeElement extends FakeNode {
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.attributes = new Map();
    this.classList = new FakeClassList(this);
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.textContent = '';
    this.shadowRoot = null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  attachShadow() {
    this.shadowRoot = new FakeShadowRoot(this.ownerDocument, this);
    return this.shadowRoot;
  }

  querySelector(selector) {
    return findElement(this, selector);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  select() {
    this.selected = true;
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node === this.ownerDocument.documentElement) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }
}

class FakeShadowRoot extends FakeNode {
  constructor(ownerDocument, host) {
    super();
    this.ownerDocument = ownerDocument;
    this.host = host;
    this.parentNode = host;
    this.markup = '';
  }

  set innerHTML(markup) {
    this.markup = markup;
    this.children = [];
    const elementPattern = /<(input|select|textarea|button|output|details|summary|p)\b([^>]*)>/gi;
    for (const match of markup.matchAll(elementPattern)) {
      const element = new FakeElement(match[1], this.ownerDocument);
      const attributePattern = /([\w-]+)(?:=(['"])(.*?)\2)?/g;
      for (const attribute of match[2].matchAll(attributePattern)) {
        element.setAttribute(attribute[1], attribute[3] ?? '');
      }
      this.appendChild(element);
    }
  }

  get innerHTML() {
    return this.markup;
  }

  querySelector(selector) {
    return findElement(this, selector);
  }
}

class FakeDocument extends FakeNode {
  constructor({ withRoot = true } = {}) {
    super();
    this.documentElement = null;
    this.body = null;
    this.activeElement = null;
    this.defaultView = null;
    if (withRoot) {
      this.installRoot();
    }
  }

  installRoot() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.appendChild(this.body);
    this.activeElement ??= this.body;
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  querySelector(selector) {
    if (!this.documentElement) {
      return null;
    }
    if (matchesSelector(this.documentElement, selector)) {
      return this.documentElement;
    }
    return findElement(this.documentElement, selector);
  }
}

class FakeWindow {
  constructor() {
    this.nextTimer = 1;
    this.timers = new Map();
    this.nextFrame = 1;
    this.frames = new Map();
    this.clipboardWrites = [];
    this.clipboardError = null;
    this.navigator = {
      clipboard: {
        writeText: async (text) => {
          if (this.clipboardError) {
            throw this.clipboardError;
          }
          this.clipboardWrites.push(text);
        }
      }
    };
  }

  setTimeout(callback) {
    const id = this.nextTimer++;
    this.timers.set(id, callback);
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  requestAnimationFrame(callback) {
    const id = this.nextFrame++;
    this.frames.set(id, callback);
    return id;
  }

  cancelAnimationFrame(id) {
    this.frames.delete(id);
  }

  runFrames() {
    const callbacks = [...this.frames.values()];
    this.frames.clear();
    callbacks.forEach((callback) => callback());
  }

  runTimers() {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    callbacks.forEach((callback) => callback());
  }
}

const DEFAULTS = {
  enabled: false,
  textEnabled: false,
  themeEnabled: false,
  gradientEnabled: false,
  customCssEnabled: false,
  textSizePx: 12,
  tableTextSizePx: 12,
  pageColor: '#f8fafc',
  surfaceColor: '#ffffff',
  textColor: '#0f172a',
  mutedTextColor: '#64748b',
  accentColor: '#2563eb',
  accentTextColor: '#ffffff',
  borderColor: '#e2e8f0',
  activeRowColor: '#f1f5f9',
  activeRowTextColor: '#0f172a',
  waveColor: '#94a3b8',
  speakerColors: ['#64b5f6', '#b083ff', '#38bdf8'],
  dangerColor: '#dc2626',
  warningColor: '#d97706',
  successColor: '#16a34a',
  gradientColors: ['#0f766e', '#2563eb', '#0f766e'],
  gradientAngle: 135,
  gradientSpeed: 'slow',
  customCss: ''
};

const PALETTE_FIELDS = [
  'pageColor',
  'surfaceColor',
  'textColor',
  'mutedTextColor',
  'accentColor',
  'accentTextColor',
  'borderColor',
  'waveColor',
  'activeRowColor',
  'activeRowTextColor',
  'dangerColor',
  'warningColor',
  'successColor',
  'speakerColor0',
  'speakerColor1',
  'speakerColor2'
];

const GROUP_DIALS = {
  textEnabled: ['textSizePx', 'tableTextSizePx'],
  themeEnabled: PALETTE_FIELDS,
  gradientEnabled: [
    'gradientColor0',
    'gradientColor1',
    'gradientColor2',
    'gradientAngle',
    'gradientSpeed'
  ]
};

/** The panel is exactly five switches: the master plus one per section. */
const SWITCHES = ['enabled', 'textEnabled', 'themeEnabled', 'gradientEnabled', 'customCssEnabled'];

function expectedFields(settings) {
  return Object.keys(settings)
    .flatMap((key) => {
      if (key === 'gradientColors') {
        return ['gradientColor0', 'gradientColor1', 'gradientColor2'];
      }
      if (key === 'speakerColors') {
        return ['speakerColor0', 'speakerColor1', 'speakerColor2'];
      }
      return [key];
    })
    .sort();
}

function markupFields(markup) {
  return [...markup.matchAll(/data-field="([^"]+)"/g)].map((match) => match[1]).sort();
}

function createHarness(createWebsiteAppearancePanel, initial = DEFAULTS, { frames = true } = {}) {
  const document = new FakeDocument();
  const window = new FakeWindow();
  if (!frames) {
    // Some hosts hand the panel a window without animation frames at all.
    window.requestAnimationFrame = undefined;
    window.cancelAnimationFrame = undefined;
  }
  document.defaultView = window;
  let settings = structuredClone(initial);
  const previews = [];
  const commits = [];
  const harness = {
    document,
    window,
    previews,
    commits,
    commitResult: { saved: true }
  };
  harness.panel = createWebsiteAppearancePanel({
    targetDocument: document,
    targetWindow: window,
    getSettings: () => structuredClone(settings),
    onPreview(next) {
      previews.push(next);
      settings = structuredClone(next);
    },
    async onCommit(next) {
      commits.push(next);
      if (harness.commitResult.saved) {
        settings = structuredClone(next);
      }
      return harness.commitResult;
    }
  });
  harness.host = document.querySelector('[data-babel-helper-appearance-panel]');
  harness.shadow = harness.host.shadowRoot;
  return harness;
}

function control(harness, field) {
  return harness.shadow.querySelector(`[data-field="${field}"]`);
}

/** One edit, exactly as a drag delivers it: no animation frame yet. */
function edit(harness, field, value) {
  const element = control(harness, field);
  if (typeof value === 'boolean') {
    element.checked = value;
  } else {
    element.value = String(value);
  }
  element.dispatchEvent(new FakeEvent('input'));
}

/** An edit plus the frame that flushes its coalesced preview. */
function input(harness, field, value) {
  edit(harness, field, value);
  harness.window.runFrames();
}

const { createWebsiteAppearancePanel } = await importEntry('src/content/website-appearance-panel.ts');

test('exact Alt+Shift+P toggles one Shadow DOM editor even while a panel control is focused', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  assert.ok(harness.host);
  assert.equal(
    harness.document.body.children.filter(
      (child) => child.getAttribute('data-babel-helper-appearance-panel') !== null
    ).length,
    1
  );
  assert.equal(harness.host.hidden, true);

  const openEvent = new FakeEvent('keydown', {
    code: 'KeyP', key: 'P', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false
  });
  harness.document.dispatchEvent(openEvent);
  assert.equal(harness.host.hidden, false);
  assert.equal(openEvent.defaultPrevented, true);
  assert.equal(harness.document.activeElement, control(harness, 'enabled'));

  for (const modifiers of [
    { altKey: false, shiftKey: true, ctrlKey: false, metaKey: false },
    { altKey: true, shiftKey: false, ctrlKey: false, metaKey: false },
    { altKey: true, shiftKey: true, ctrlKey: true, metaKey: false },
    { altKey: true, shiftKey: true, ctrlKey: false, metaKey: true },
    { altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, repeat: true }
  ]) {
    harness.document.dispatchEvent(new FakeEvent('keydown', { code: 'KeyP', key: 'P', ...modifiers }));
    assert.equal(harness.host.hidden, false);
  }

  control(harness, 'customCssEnabled').focus();
  harness.document.dispatchEvent(new FakeEvent('keydown', {
    code: 'KeyP', key: 'P', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false
  }));
  assert.equal(harness.host.hidden, true);

  const pageButton = harness.document.createElement('button');
  harness.document.body.appendChild(pageButton);
  pageButton.focus();
  harness.panel.open();

  const outsideEscape = new FakeEvent('keydown', {
    code: 'Escape', key: 'Escape', altKey: false, shiftKey: false, ctrlKey: false, metaKey: false
  });
  harness.document.dispatchEvent(outsideEscape);
  assert.equal(harness.host.hidden, false, 'Escape from the page must not close the editor');
  assert.equal(outsideEscape.defaultPrevented, false);
  assert.notEqual(outsideEscape.immediatePropagationStopped, true);

  const panelEscape = new FakeEvent('keydown', {
    code: 'Escape',
    key: 'Escape',
    target: harness.host,
    altKey: false, shiftKey: false, ctrlKey: false, metaKey: false
  });
  harness.document.dispatchEvent(panelEscape);
  assert.equal(harness.host.hidden, true);
  assert.equal(panelEscape.defaultPrevented, true);
  assert.equal(harness.document.activeElement, pageButton);
});

test('every control previews normalized complete settings and commits on debounce, change, and close', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  assert.equal(control(harness, 'customCss').disabled, false);
  input(harness, 'customCss', 'main { color: navy; }');
  assert.equal(harness.previews.at(-1).customCssEnabled, false);
  assert.equal(harness.previews.at(-1).customCss, 'main { color: navy; }');

  input(harness, 'enabled', true);
  input(harness, 'textEnabled', true);
  input(harness, 'textSizePx', 29);
  input(harness, 'tableTextSizePx', 10);
  input(harness, 'themeEnabled', true);
  input(harness, 'pageColor', '#ABCDEF');
  input(harness, 'surfaceColor', '#102030');
  input(harness, 'textColor', '#203040');
  input(harness, 'mutedTextColor', '#304050');
  input(harness, 'accentColor', '#405060');
  input(harness, 'accentTextColor', '#506070');
  input(harness, 'borderColor', '#607080');
  input(harness, 'activeRowColor', '#708090');
  input(harness, 'activeRowTextColor', '#8090a0');
  input(harness, 'waveColor', '#90a0b0');
  input(harness, 'speakerColor0', '#a0b0c0');
  input(harness, 'speakerColor1', '#b0c0d0');
  input(harness, 'speakerColor2', '#c0d0e0');
  input(harness, 'dangerColor', '#d0e0f0');
  input(harness, 'warningColor', '#e0f0a0');
  input(harness, 'successColor', '#f0a0b0');
  input(harness, 'gradientEnabled', true);
  input(harness, 'gradientColor0', '#112233');
  input(harness, 'gradientColor1', '#223344');
  input(harness, 'gradientColor2', '#334455');
  input(harness, 'gradientAngle', 300);
  input(harness, 'gradientSpeed', 'fast');
  input(harness, 'customCssEnabled', true);
  input(harness, 'customCss', 'main { color: var(--bh-text); }');

  assert.deepEqual(harness.previews.at(-1), {
    enabled: true,
    textEnabled: true,
    themeEnabled: true,
    gradientEnabled: true,
    customCssEnabled: true,
    textSizePx: 29,
    tableTextSizePx: 10,
    pageColor: '#abcdef',
    surfaceColor: '#102030',
    textColor: '#203040',
    mutedTextColor: '#304050',
    accentColor: '#405060',
    accentTextColor: '#506070',
    borderColor: '#607080',
    activeRowColor: '#708090',
    activeRowTextColor: '#8090a0',
    waveColor: '#90a0b0',
    speakerColors: ['#a0b0c0', '#b0c0d0', '#c0d0e0'],
    dangerColor: '#d0e0f0',
    warningColor: '#e0f0a0',
    successColor: '#f0a0b0',
    gradientColors: ['#112233', '#223344', '#334455'],
    gradientAngle: 300,
    gradientSpeed: 'fast',
    customCss: 'main { color: var(--bh-text); }'
  });
  assert.equal(harness.commits.length, 0);
  harness.window.runTimers();
  assert.deepEqual(harness.commits.at(-1), harness.previews.at(-1));

  input(harness, 'customCss', 'main { background: url(theme.png); }');
  const status = harness.shadow.querySelector('#custom-css-status');
  assert.equal(status.textContent, 'url() is not allowed in custom CSS.');
  assert.equal(status.classList.contains('invalid'), true);
  assert.equal(control(harness, 'customCss').getAttribute('aria-invalid'), 'true');

  control(harness, 'customCss').value = 'main { color: rebeccapurple; }';
  control(harness, 'customCss').dispatchEvent(new FakeEvent('change'));
  assert.equal(harness.commits.at(-1).customCss, 'main { color: rebeccapurple; }');
  assert.equal(status.textContent, 'Custom CSS is valid.');

  input(harness, 'textSizePx', 30);
  const commitsBeforeClose = harness.commits.length;
  harness.panel.close();
  assert.equal(harness.commits.length, commitsBeforeClose + 1);
  assert.equal(harness.commits.at(-1).textSizePx, 30);
});

test('the master switch gates all three sections, and each section switch gates only its own dials', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();

  const allDials = Object.entries(GROUP_DIALS);
  const masterHint = harness.shadow.querySelector('#master-hint');
  assert.equal(masterHint.hidden, false);
  assert.ok(harness.shadow.innerHTML.includes('Turn on custom appearance to edit these sections.'));
  for (const [flag, fields] of allDials) {
    assert.equal(control(harness, flag).disabled, true, `${flag} needs the master switch`);
    for (const field of fields) {
      assert.equal(control(harness, field).disabled, true, `${field} should start gated`);
    }
  }
  assert.equal(control(harness, 'customCssEnabled').disabled, true);
  assert.equal(control(harness, 'customCss').disabled, false);

  input(harness, 'textEnabled', true);
  assert.equal(harness.previews.length, 0, 'a gated section toggle cannot be changed');
  control(harness, 'textEnabled').checked = false;

  input(harness, 'enabled', true);
  assert.equal(masterHint.hidden, true);
  assert.equal(control(harness, 'customCssEnabled').disabled, false);
  for (const [flag, fields] of allDials) {
    assert.equal(control(harness, flag).disabled, false, `${flag} unlocked by the master switch`);
    for (const field of fields) {
      assert.equal(control(harness, field).disabled, true, `${field} stays gated by its own section`);
    }
  }

  for (const [flag, fields] of allDials) {
    input(harness, flag, true);
    assert.equal(harness.previews.at(-1)[flag], true);
    for (const [otherFlag, otherFields] of allDials) {
      for (const field of otherFields) {
        assert.equal(
          control(harness, field).disabled,
          otherFlag !== flag,
          `${flag} enabled should not ungate ${field}`
        );
      }
    }
    assert.equal(control(harness, 'customCss').disabled, false);
    input(harness, flag, false);
    assert.equal(harness.previews.at(-1)[flag], false);
    for (const field of fields) {
      assert.equal(control(harness, field).disabled, true, `${field} regated`);
    }
  }

  input(harness, 'enabled', false);
  assert.equal(masterHint.hidden, false);
  for (const [flag] of allDials) {
    assert.equal(control(harness, flag).disabled, true, `${flag} relocked with the master switch`);
  }
});

test('text-size-only usage leaves the palette and gradient untouched', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  input(harness, 'enabled', true);
  input(harness, 'textEnabled', true);
  input(harness, 'textSizePx', 22);
  harness.window.runTimers();

  const expected = { ...DEFAULTS, enabled: true, textEnabled: true, textSizePx: 22 };
  assert.deepEqual(harness.previews.at(-1), expected);
  assert.deepEqual(harness.commits.at(-1), expected);
});

test('retyping a number dial never previews a clamped placeholder value', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  input(harness, 'enabled', true);
  input(harness, 'textEnabled', true);
  input(harness, 'textSizePx', 22);

  input(harness, 'textSizePx', '');
  assert.equal(harness.previews.at(-1).textSizePx, 22);
  input(harness, 'textSizePx', '2');
  assert.equal(harness.previews.at(-1).textSizePx, 22, 'a half-typed value must not clamp to the minimum');
  input(harness, 'textSizePx', '27');
  assert.equal(harness.previews.at(-1).textSizePx, 27);
});

test('the editor and table text dials reach 10px and move independently', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  input(harness, 'enabled', true);
  input(harness, 'textEnabled', true);

  for (const field of ['textSizePx', 'tableTextSizePx']) {
    const dial = control(harness, field);
    assert.equal(dial.getAttribute('min'), '10', `${field} must reach the site's own text size`);
    assert.equal(dial.getAttribute('max'), '30');
  }

  input(harness, 'textSizePx', 10);
  assert.equal(harness.previews.at(-1).textSizePx, 10);
  assert.equal(harness.previews.at(-1).tableTextSizePx, DEFAULTS.tableTextSizePx);

  input(harness, 'tableTextSizePx', 11);
  harness.window.runTimers();
  const expected = {
    ...DEFAULTS,
    enabled: true,
    textEnabled: true,
    textSizePx: 10,
    tableTextSizePx: 11
  };
  assert.deepEqual(harness.previews.at(-1), expected);
  assert.deepEqual(harness.commits.at(-1), expected);
});

test('the editor is three sections: Text, Theme, and one Advanced block', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  const markup = harness.shadow.innerHTML;

  const groupStarts = [...markup.matchAll(/<fieldset data-group="([^"]+)">/g)];
  assert.deepEqual(
    groupStarts.map((match) => match[1]),
    ['textEnabled', 'themeEnabled', 'gradientEnabled'],
    'exactly three gated sections, in reading order'
  );

  for (const [flag, fields] of Object.entries(GROUP_DIALS)) {
    const start = markup.indexOf(`<fieldset data-group="${flag}">`);
    const end = markup.indexOf('</fieldset>', start);
    const section = markup.slice(start, end);
    const legend = section.slice(section.indexOf('<legend>'), section.indexOf('</legend>'));
    assert.ok(legend.includes(`data-field="${flag}"`), `${flag} toggle belongs in the legend`);
    for (const field of fields) {
      assert.ok(section.includes(`data-field="${field}"`), `${field} belongs to ${flag}`);
    }
  }

  // Gradient, expert CSS and theme sharing are the only things behind Advanced.
  const advanced = markup.slice(
    markup.indexOf('<details class="advanced" data-advanced>'),
    markup.indexOf('</details>')
  );
  assert.ok(advanced.includes('<summary>Advanced</summary>'));
  assert.ok(advanced.includes('<fieldset data-group="gradientEnabled">'));
  assert.ok(advanced.includes('data-field="customCssEnabled"'));
  assert.ok(advanced.includes('data-share="value"'));
  assert.ok(!advanced.includes('data-action="apply-preset"'), 'no built-in preset control');
  assert.ok(!advanced.includes('data-field="themeEnabled"'), 'the palette stays in plain sight');

  assert.ok(
    markup.includes('fieldset[data-group]:has(> legend .toggle > input:not(:checked)) {'),
    'collapsed sections must shed their padding and border'
  );
  assert.ok(
    markup.includes(
      'fieldset[data-group]:has(> legend .toggle > input:not(:checked)) > :not(legend):not(.note) {'
    ),
    'collapsed sections must hide their dials while keeping their explanation'
  );
});

test('the whole palette sits in one compact colour grid', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  const markup = harness.shadow.innerHTML;
  const start = markup.indexOf('<fieldset data-group="themeEnabled">');
  const theme = markup.slice(start, markup.indexOf('</fieldset>', start));

  const grids = [...theme.matchAll(/<div class="colors">/g)];
  assert.equal(grids.length, 1, 'the palette must not be split across sub-grids');
  const grid = theme.slice(theme.indexOf('<div class="colors">'), theme.indexOf('</div>'));
  assert.deepEqual(markupFields(grid), [...PALETTE_FIELDS].sort());
  assert.ok(theme.includes('<p class="hint note">'), 'the palette explains what it drives');

  for (const field of PALETTE_FIELDS) {
    assert.ok(
      grid.includes(`<input type="color" data-field="${field}"`),
      `${field} needs a swatch`
    );
  }
  assert.ok(grid.includes('aria-label="Active row text color"'));
  assert.ok(grid.includes('aria-label="Speaker 3 color"'));
});

test('every appearance setting is reachable, and the editor exposes nothing else', async () => {
  const { DEFAULT_WEBSITE_APPEARANCE_SETTINGS, validateWebsiteCustomCss } =
    await importEntry('src/core/settings.ts');
  assert.deepEqual(DEFAULTS, DEFAULT_WEBSITE_APPEARANCE_SETTINGS);

  const harness = createHarness(createWebsiteAppearancePanel);
  const markup = harness.shadow.innerHTML;
  assert.deepEqual(
    markupFields(markup),
    expectedFields(DEFAULT_WEBSITE_APPEARANCE_SETTINGS),
    'one control per stored value, and no orphaned dial'
  );

  const checkboxes = [...markup.matchAll(/<input type="checkbox" data-field="([^"]+)"/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(checkboxes, SWITCHES, 'the editor is exactly five switches');

  const maxLength = Number(control(harness, 'customCss').getAttribute('maxlength'));
  assert.ok(Number.isFinite(maxLength) && maxLength > 0, 'custom CSS needs a length cap');
  assert.equal(validateWebsiteCustomCss(`/*${'a'.repeat(maxLength - 4)}*/`).valid, true);
  assert.equal(validateWebsiteCustomCss(`/*${'a'.repeat(maxLength - 3)}*/`).valid, false);

  harness.panel.open();
  const status = harness.shadow.querySelector('#custom-css-status');
  input(harness, 'customCss', `/*${'a'.repeat(maxLength - 5)}*/`);
  assert.equal(status.textContent, 'Custom CSS is valid.');
  assert.equal(status.classList.contains('warn'), false);

  input(harness, 'customCss', `/*${'a'.repeat(maxLength - 4)}*/`);
  assert.equal(
    status.textContent,
    `Custom CSS is valid. Character limit of ${maxLength.toLocaleString('en-US')} reached.`
  );
  assert.equal(status.classList.contains('warn'), true);
  assert.equal(status.classList.contains('invalid'), false);
});

test('Advanced unfolds itself for a live gradient or stylesheet and never refolds itself', () => {
  const plain = createHarness(createWebsiteAppearancePanel);
  const plainAdvanced = plain.shadow.querySelector('[data-advanced]');
  plain.panel.open();
  assert.equal(plainAdvanced.open, false, 'an untouched editor starts folded');

  input(plain, 'enabled', true);
  input(plain, 'customCssEnabled', true);
  assert.equal(plainAdvanced.open, true, 'an active stylesheet must not hide');
  input(plain, 'customCssEnabled', false);
  assert.equal(plainAdvanced.open, true, 'the section never folds itself back');

  const gradient = createHarness(createWebsiteAppearancePanel, {
    ...DEFAULTS,
    enabled: true,
    gradientEnabled: true
  });
  gradient.panel.open();
  assert.equal(gradient.shadow.querySelector('[data-advanced]').open, true);
});

test('sync adopts external settings only when no local edit is pending or unsaved', async () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();

  harness.panel.sync({ ...DEFAULTS, enabled: true, themeEnabled: true, accentColor: '#ff0000' });
  assert.equal(control(harness, 'enabled').checked, true);
  assert.equal(control(harness, 'accentColor').value, '#ff0000');
  assert.equal(control(harness, 'accentColor').disabled, false);
  assert.equal(harness.previews.length, 0, 'sync must not preview');
  assert.equal(harness.commits.length, 0, 'sync must not commit');

  input(harness, 'accentColor', '#00ff00');
  harness.panel.sync({ ...DEFAULTS, enabled: true, themeEnabled: true, accentColor: '#0000ff' });
  assert.equal(control(harness, 'accentColor').value, '#00ff00', 'a pending edit outranks a storage echo');
  harness.window.runTimers();
  await Promise.resolve();
  assert.equal(harness.commits.at(-1).accentColor, '#00ff00');

  harness.panel.sync({ ...DEFAULTS, enabled: true, themeEnabled: true, accentColor: '#0000ff' });
  assert.equal(control(harness, 'accentColor').value, '#0000ff');

  harness.panel.dispose();
  harness.panel.sync({ ...DEFAULTS, enabled: true, themeEnabled: true, accentColor: '#123456' });
  assert.equal(control(harness, 'accentColor').value, '#0000ff', 'a disposed panel ignores sync');
});

test('a failed commit is reported, keeps the draft, and blocks sync until it succeeds', async () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  const commitStatus = harness.shadow.querySelector('#commit-status');
  assert.equal(commitStatus.hidden, true);

  harness.commitResult = { saved: false, error: 'Storage quota exceeded' };
  input(harness, 'enabled', true);
  harness.window.runTimers();
  await Promise.resolve();
  assert.equal(commitStatus.hidden, false);
  assert.equal(commitStatus.textContent, 'Not saved: Storage quota exceeded');

  harness.panel.sync({ ...DEFAULTS, enabled: false });
  assert.equal(control(harness, 'enabled').checked, true, 'unsaved edits survive a storage echo');

  harness.commitResult = { saved: true };
  input(harness, 'textEnabled', true);
  harness.window.runTimers();
  await Promise.resolve();
  assert.equal(commitStatus.hidden, true);
  assert.equal(commitStatus.textContent, '');

  harness.panel.sync({ ...DEFAULTS, enabled: true, textEnabled: true, textSizePx: 19 });
  assert.equal(control(harness, 'textSizePx').value, '19');
});

test('reset previews and commits a cloned default object, and dispose cancels stale work', () => {
  const harness = createHarness(createWebsiteAppearancePanel, {
    ...DEFAULTS,
    enabled: true,
    themeEnabled: true,
    speakerColors: ['#111111', '#222222', '#333333'],
    gradientColors: ['#111111', '#222222', '#333333'],
    customCss: 'main { color: red; }'
  });
  const previouslyFocused = harness.document.createElement('button');
  harness.document.body.appendChild(previouslyFocused);
  previouslyFocused.focus();
  harness.panel.open();
  harness.shadow.querySelector('[data-action="reset"]').dispatchEvent(new FakeEvent('click'));

  assert.deepEqual(harness.previews.at(-1), DEFAULTS);
  assert.deepEqual(harness.commits.at(-1), DEFAULTS);
  harness.previews.at(-1).gradientColors[0] = '#000000';
  harness.previews.at(-1).speakerColors[0] = '#000000';
  assert.deepEqual(harness.commits.at(-1).gradientColors, DEFAULTS.gradientColors);
  assert.deepEqual(harness.commits.at(-1).speakerColors, DEFAULTS.speakerColors);

  input(harness, 'customCss', 'main { color: teal; }');
  const commitCount = harness.commits.length;
  harness.panel.dispose();
  harness.window.runTimers();
  assert.equal(harness.commits.length, commitCount);
  assert.equal(harness.document.querySelector('[data-babel-helper-appearance-panel]'), null);
  assert.equal(harness.document.activeElement, previouslyFocused);

  harness.document.dispatchEvent(new FakeEvent('keydown', {
    code: 'KeyP', key: 'P', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false
  }));
  assert.equal(harness.document.querySelector('[data-babel-helper-appearance-panel]'), null);
});

test('document-start mounting appends once when a root appears and disposal cancels mounting', () => {
  const document = new FakeDocument({ withRoot: false });
  const window = new FakeWindow();
  document.defaultView = window;
  const panel = createWebsiteAppearancePanel({
    targetDocument: document,
    targetWindow: window,
    getSettings: () => structuredClone(DEFAULTS),
    onPreview() {},
    onCommit() {}
  });

  panel.open();
  document.installRoot();
  document.dispatchEvent(new FakeEvent('DOMContentLoaded', { bubbles: false }));
  const host = document.querySelector('[data-babel-helper-appearance-panel]');
  assert.ok(host);
  assert.equal(host.hidden, false);
  assert.equal(
    document.body.children.filter(
      (child) => child.getAttribute('data-babel-helper-appearance-panel') !== null
    ).length,
    1
  );

  document.dispatchEvent(new FakeEvent('DOMContentLoaded', { bubbles: false }));
  assert.equal(
    document.body.children.filter(
      (child) => child.getAttribute('data-babel-helper-appearance-panel') !== null
    ).length,
    1
  );
  panel.dispose();

  const disposedDocument = new FakeDocument({ withRoot: false });
  const disposedWindow = new FakeWindow();
  disposedDocument.defaultView = disposedWindow;
  const disposedPanel = createWebsiteAppearancePanel({
    targetDocument: disposedDocument,
    targetWindow: disposedWindow,
    getSettings: () => structuredClone(DEFAULTS),
    onPreview() {},
    onCommit() {}
  });
  disposedPanel.dispose();
  disposedDocument.installRoot();
  disposedDocument.dispatchEvent(new FakeEvent('DOMContentLoaded', { bubbles: false }));
  assert.equal(
    disposedDocument.querySelector('[data-babel-helper-appearance-panel]'),
    null
  );
});

test('Website Appearance shortcut help is always present without a feature setting', async () => {
  const { FEATURE_REGISTRATIONS, getRegisteredHotkeysHelpRows } = await importEntry('src/features/registry.ts');
  assert.equal(FEATURE_REGISTRATIONS.some((entry) => entry.setting.key === 'websiteAppearance'), false);
  assert.deepEqual(
    getRegisteredHotkeysHelpRows({}),
    [['Alt + Shift + P', 'Toggle Website Appearance editor']]
  );
});

test('each speaker swatch edits only its own slot and previews live', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  input(harness, 'enabled', true);
  input(harness, 'themeEnabled', true);

  for (const index of [0, 1, 2]) {
    const swatch = control(harness, `speakerColor${index}`);
    assert.equal(swatch.disabled, false, `speaker ${index + 1} is ungated with the theme`);
    assert.equal(swatch.value, DEFAULTS.speakerColors[index]);
  }

  input(harness, 'speakerColor1', '#123456');
  input(harness, 'speakerColor2', '#654321');
  assert.deepEqual(harness.previews.at(-1).speakerColors, [
    DEFAULTS.speakerColors[0],
    '#123456',
    '#654321'
  ]);

  harness.window.runTimers();
  assert.deepEqual(harness.commits.at(-1).speakerColors, harness.previews.at(-1).speakerColors);
  harness.previews.at(-1).speakerColors[0] = '#ffffff';
  assert.equal(harness.commits.at(-1).speakerColors[0], DEFAULTS.speakerColors[0]);

  input(harness, 'themeEnabled', false);
  for (const index of [0, 1, 2]) {
    assert.equal(control(harness, `speakerColor${index}`).disabled, true, 'speakers regate with the theme');
  }
});

test('the share string is rebuilt on render, copy and commit, never per input', async () => {
  const { encodeWebsiteAppearanceShare } = await importEntry('src/core/settings.ts');
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  const shareValue = harness.shadow.querySelector('[data-share="value"]');
  assert.equal(shareValue.getAttribute('readonly'), '');
  assert.equal(shareValue.value, encodeWebsiteAppearanceShare(DEFAULTS));

  const atOpen = shareValue.value;
  input(harness, 'enabled', true);
  input(harness, 'themeEnabled', true);
  input(harness, 'textColor', '#abcdef');
  assert.equal(atOpen, shareValue.value, 'a drag must not re-encode the whole draft per event');

  harness.window.runTimers();
  assert.equal(
    shareValue.value,
    encodeWebsiteAppearanceShare({
      ...DEFAULTS,
      enabled: true,
      themeEnabled: true,
      textColor: '#abcdef'
    }),
    'the commit refreshes the share string'
  );

  // Copy always shows the live draft, even mid-drag before any commit.
  edit(harness, 'textColor', '#123456');
  const copied = encodeWebsiteAppearanceShare({
    ...DEFAULTS,
    enabled: true,
    themeEnabled: true,
    textColor: '#123456'
  });
  const themeStatus = harness.shadow.querySelector('#theme-status');
  assert.equal(themeStatus.hidden, true);
  harness.shadow.querySelector('[data-action="copy-share"]').dispatchEvent(new FakeEvent('click'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(shareValue.value, copied, 'copying re-encodes the pending draft first');
  assert.deepEqual(harness.window.clipboardWrites, [copied]);
  assert.equal(themeStatus.hidden, false);
  assert.equal(themeStatus.textContent, 'Theme string copied to the clipboard.');
  assert.equal(themeStatus.classList.contains('invalid'), false);

  harness.window.clipboardError = new Error('denied');
  harness.shadow.querySelector('[data-action="copy-share"]').dispatchEvent(new FakeEvent('click'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(harness.window.clipboardWrites, [copied], 'a denied clipboard writes nothing');
  assert.equal(shareValue.selected, true, 'the blocked path selects the string for a manual copy');
  assert.equal(harness.document.activeElement, shareValue);
  assert.equal(themeStatus.classList.contains('invalid'), true);
  assert.match(themeStatus.textContent, /^Clipboard blocked\./);
});

test('importing a share string round-trips a theme, and an invalid string changes nothing', async () => {
  const { encodeWebsiteAppearanceShare } = await importEntry('src/core/settings.ts');
  const source = {
    ...DEFAULTS,
    enabled: true,
    themeEnabled: true,
    pageColor: '#101418',
    activeRowColor: '#1d2735',
    activeRowTextColor: '#f8fafc',
    speakerColors: ['#22d3ee', '#a78bfa', '#f472b6']
  };
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  const themeStatus = harness.shadow.querySelector('#theme-status');
  const importInput = harness.shadow.querySelector('[data-share="import"]');
  const importButton = harness.shadow.querySelector('[data-action="import-share"]');

  importButton.dispatchEvent(new FakeEvent('click'));
  assert.equal(themeStatus.textContent, 'Paste a theme string to import.');
  assert.equal(themeStatus.classList.contains('invalid'), true);
  assert.equal(harness.previews.length, 0);

  importInput.value = 'wa1.not-real-base64!!';
  importButton.dispatchEvent(new FakeEvent('click'));
  assert.equal(themeStatus.textContent, 'That is not a valid Website Appearance theme string.');
  assert.equal(themeStatus.classList.contains('invalid'), true);
  assert.equal(harness.previews.length, 0, 'an invalid string must not touch the draft');
  assert.equal(control(harness, 'enabled').checked, false);
  assert.equal(importInput.value, 'wa1.not-real-base64!!', 'the pasted text survives a failed import');

  importInput.value = ` ${encodeWebsiteAppearanceShare(source)} `;
  importButton.dispatchEvent(new FakeEvent('click'));
  assert.deepEqual(harness.previews.at(-1), source);
  assert.deepEqual(harness.commits.at(-1), source, 'an import commits immediately');
  assert.equal(themeStatus.textContent, 'Theme string imported.');
  assert.equal(themeStatus.classList.contains('invalid'), false);
  assert.equal(importInput.value, '');
  assert.equal(control(harness, 'themeEnabled').checked, true);
  assert.equal(control(harness, 'pageColor').value, '#101418');
  assert.equal(control(harness, 'pageColor').disabled, false);
  assert.equal(control(harness, 'activeRowTextColor').value, '#f8fafc');
  assert.equal(control(harness, 'speakerColor2').value, '#f472b6');
  assert.equal(
    harness.shadow.querySelector('[data-share="value"]').value,
    encodeWebsiteAppearanceShare(source),
    'the imported theme becomes the new share string'
  );

  harness.shadow.querySelector('[data-action="reset"]').dispatchEvent(new FakeEvent('click'));
  assert.deepEqual(harness.previews.at(-1), DEFAULTS);
  assert.equal(themeStatus.hidden, true, 'reset clears theme status');
});

test('a colour drag previews once per frame and the last dragged value always lands', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  input(harness, 'enabled', true);
  input(harness, 'themeEnabled', true);
  const before = harness.previews.length;
  const swatch = control(harness, 'accentColor');

  for (const shade of ['#010203', '#040506', '#070809', '#0a0b0c']) {
    edit(harness, 'accentColor', shade);
    assert.equal(swatch.value, shade, 'the visible control keeps up with every event');
  }
  assert.equal(harness.previews.length, before, 'a drag must not preview per event');

  harness.window.runFrames();
  assert.equal(harness.previews.length, before + 1, 'one preview per animation frame');
  assert.equal(harness.previews.at(-1).accentColor, '#0a0b0c', 'the latest draft wins');
  harness.window.runFrames();
  assert.equal(harness.previews.length, before + 1, 'an idle frame previews nothing');

  // A drag whose frame never arrives still lands, and it is what gets saved.
  edit(harness, 'accentColor', '#111213');
  edit(harness, 'accentColor', '#141516');
  harness.window.runTimers();
  assert.equal(harness.previews.length, before + 2, 'the commit flushes exactly one preview');
  assert.equal(harness.previews.at(-1).accentColor, '#141516');
  assert.equal(harness.commits.at(-1).accentColor, '#141516');
  harness.window.runFrames();
  assert.equal(harness.previews.length, before + 2, 'a stale frame must not preview again');
});

test('closing applies the trailing preview, and disposal cancels the pending frame', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  input(harness, 'enabled', true);
  input(harness, 'themeEnabled', true);

  edit(harness, 'accentColor', '#abcdef');
  const beforeClose = harness.previews.length;
  harness.panel.close();
  assert.equal(harness.previews.length, beforeClose + 1, 'closing applies the trailing preview');
  assert.equal(harness.previews.at(-1).accentColor, '#abcdef');
  assert.equal(harness.commits.at(-1).accentColor, '#abcdef');
  harness.window.runFrames();
  assert.equal(harness.previews.length, beforeClose + 1, 'no frame survives the close');

  harness.panel.open();
  edit(harness, 'accentColor', '#123456');
  const beforeDispose = harness.previews.length;
  const commitsBeforeDispose = harness.commits.length;
  harness.panel.dispose();
  harness.window.runFrames();
  harness.window.runTimers();
  assert.equal(harness.previews.length, beforeDispose, 'a disposed panel never previews');
  assert.equal(harness.commits.length, commitsBeforeDispose);
});

test('a window without animation frames coalesces previews onto a timer', () => {
  const harness = createHarness(createWebsiteAppearancePanel, DEFAULTS, { frames: false });
  harness.panel.open();
  edit(harness, 'enabled', true);
  edit(harness, 'themeEnabled', true);
  assert.equal(harness.previews.length, 0, 'coalescing still holds without requestAnimationFrame');

  harness.window.runTimers();
  assert.equal(harness.previews.length, 1, 'the fallback applies the trailing draft once');
  assert.equal(harness.previews.at(-1).themeEnabled, true);
  assert.equal(harness.commits.length, 1);
  assert.equal(harness.commits.at(-1).themeEnabled, true);
});

test('the custom CSS validator runs only for the custom CSS field', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  harness.panel.open();
  const status = harness.shadow.querySelector('#custom-css-status');
  input(harness, 'customCss', 'main { background: url(theme.png); }');
  assert.equal(status.textContent, 'url() is not allowed in custom CSS.');
  assert.equal(control(harness, 'customCss').getAttribute('aria-invalid'), 'true');

  status.textContent = 'untouched';
  input(harness, 'enabled', true);
  input(harness, 'themeEnabled', true);
  input(harness, 'accentColor', '#123456');
  assert.equal(status.textContent, 'untouched', 'colour drags must not re-scan custom CSS');

  // A render still reports the truth about the stylesheet.
  harness.panel.close();
  harness.panel.open();
  assert.equal(status.textContent, 'url() is not allowed in custom CSS.');
});

test('the built-in dark preset is gone and themes travel as share strings', () => {
  const harness = createHarness(createWebsiteAppearancePanel);
  const markup = harness.shadow.innerHTML;
  assert.equal(harness.shadow.querySelector('[data-action="apply-preset"]'), null);
  assert.ok(
    !/preset|dark theme|dark palette/i.test(markup),
    'no preset control, handler hook or status copy remains'
  );
  assert.ok(markup.includes('data-share="value"'), 'sharing is how a dark theme is distributed');
  assert.ok(markup.includes('data-action="import-share"'));
});
