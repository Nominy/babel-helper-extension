import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function importBundledTs(entryPoint) {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'babel-helper-appearance-settings-'));
  const outfile = path.join(tempDir, path.basename(entryPoint).replace(/\.ts$/, '.mjs'));
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'silent'
  });
  return import(pathToFileURL(outfile).href);
}

const settingsModule = importBundledTs('src/core/settings.ts');

/** The stored record is the palette and nothing else: exactly these 25 fields. */
const APPEARANCE_KEYS = [
  'enabled',
  'textEnabled',
  'textSizePx',
  'tableTextSizePx',
  'themeEnabled',
  'pageColor',
  'surfaceColor',
  'textColor',
  'mutedTextColor',
  'accentColor',
  'accentTextColor',
  'borderColor',
  'activeRowColor',
  'activeRowTextColor',
  'waveColor',
  'speakerColors',
  'dangerColor',
  'warningColor',
  'successColor',
  'gradientEnabled',
  'gradientColors',
  'gradientAngle',
  'gradientSpeed',
  'customCssEnabled',
  'customCss'
];

const EXPECTED_DEFAULTS = {
  enabled: false,
  textEnabled: false,
  textSizePx: 12,
  tableTextSizePx: 12,
  themeEnabled: false,
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
  gradientEnabled: false,
  gradientColors: ['#0f766e', '#2563eb', '#0f766e'],
  gradientAngle: 135,
  gradientSpeed: 'slow',
  customCssEnabled: false,
  customCss: ''
};

/** Every opt-in switch in the palette schema. Nothing else gates a group. */
const GROUP_FLAG_KEYS = [
  'enabled',
  'textEnabled',
  'themeEnabled',
  'gradientEnabled',
  'customCssEnabled'
];

/** The 13 scalar palette entries, each independently normalized. */
const PALETTE_COLOR_KEYS = [
  'pageColor',
  'surfaceColor',
  'textColor',
  'mutedTextColor',
  'accentColor',
  'accentTextColor',
  'borderColor',
  'activeRowColor',
  'activeRowTextColor',
  'waveColor',
  'dangerColor',
  'warningColor',
  'successColor'
];

const PALETTE_PROBE_COLORS = {
  pageColor: '#101112',
  surfaceColor: '#131415',
  textColor: '#161718',
  mutedTextColor: '#191A1B',
  accentColor: '#1C1D1E',
  accentTextColor: '#1F2021',
  borderColor: '#222324',
  activeRowColor: '#252627',
  activeRowTextColor: '#28292A',
  waveColor: '#2B2C2D',
  dangerColor: '#2E2F30',
  warningColor: '#313233',
  successColor: '#343536'
};

/**
 * Presence of any of these keys marks a stored record as pre-palette. None of
 * them is ever written back.
 */
const LEGACY_MARKER_KEYS = [
  'textSizePercent',
  'gradientPalette',
  'tokensEnabled',
  'pageEnabled',
  'surfacesEnabled',
  'textColorsEnabled',
  'controlsEnabled',
  'bordersEnabled',
  'waveformEnabled',
  'pageBackgroundColor',
  'panelSurfaceColor',
  'surfaceOpacity',
  'headerSurfaceColor',
  'rowSurfaceColor',
  'rowHoverColor',
  'rowSelectedColor',
  'editorSurfaceColor',
  'headingColor',
  'placeholderColor',
  'linkColor',
  'controlSurfaceColor',
  'controlTextColor',
  'controlBorderColor',
  'primaryColor',
  'primaryTextColor',
  'waveBackgroundColor',
  'waveProgressColor',
  'waveCursorColor',
  'waveRegionColor',
  'waveRegionHandleColor',
  'lanes'
];

/** Nothing outside the 25-field schema may ever appear in normalized output. */
const DELETED_KEYS = LEGACY_MARKER_KEYS;

const LEGACY_LANES = [
  {
    waveColor: '#A1A2A3',
    progressColor: '#A4A5A6',
    cursorColor: '#A7A8A9',
    regionColor: '#AAABAC',
    regionBorderColor: '#ADAEAF',
    frameColor: '#B0B1B2',
    tableTextColor: '#B3B4B5'
  },
  {
    waveColor: '#B6B7B8',
    progressColor: '#B9BABB',
    cursorColor: '#BCBDBE',
    regionColor: '#BFC0C1',
    regionBorderColor: '#C2C3C4',
    frameColor: '#C5C6C7',
    tableTextColor: '#C8C9CA'
  },
  {
    waveColor: '#CBCCCD',
    progressColor: '#CECFD0',
    cursorColor: '#D1D2D3',
    regionColor: '#D4D5D6',
    regionBorderColor: '#D7D8D9',
    frameColor: '#DADBDC',
    tableTextColor: '#DDDEDF'
  }
];

/** A full pre-palette record: every retired group flag and per-surface dial. */
const LEGACY_RECORD = {
  enabled: true,
  tokensEnabled: true,
  textEnabled: true,
  textSizePercent: 140,
  pageEnabled: true,
  pageBackgroundColor: '#101112',
  gradientEnabled: true,
  gradientPalette: 'teal',
  surfacesEnabled: true,
  surfaceColor: '#131415',
  surfaceOpacity: 93,
  panelSurfaceColor: '#555657',
  headerSurfaceColor: '#161718',
  rowSurfaceColor: '#191A1B',
  rowHoverColor: '#1C1D1E',
  rowSelectedColor: '#1F2021',
  editorSurfaceColor: '#222324',
  textColorsEnabled: true,
  textColor: '#252627',
  mutedTextColor: '#28292A',
  headingColor: '#2B2C2D',
  placeholderColor: '#2E2F30',
  linkColor: '#313233',
  controlsEnabled: true,
  controlSurfaceColor: '#343536',
  controlTextColor: '#373839',
  controlBorderColor: '#3A3B3C',
  primaryColor: '#3D3E3F',
  primaryTextColor: '#404142',
  bordersEnabled: true,
  borderColor: '#434445',
  waveformEnabled: true,
  waveBackgroundColor: '#58595A',
  waveColor: '#464748',
  waveProgressColor: '#494A4B',
  waveCursorColor: '#4C4D4E',
  waveRegionColor: '#4F5051',
  waveRegionHandleColor: '#525354',
  lanes: LEGACY_LANES,
  speakerColors: ['#111111', '#222222', '#333333'],
  customCssEnabled: true,
  customCss: '.transport { margin-block: 1rem; }'
};

/**
 * The only pre-palette colors with a one-to-one successor. Everything else is
 * reset rather than guessed out of the retired nine-group model.
 */
const LEGACY_RECORD_EXPECTED = {
  ...EXPECTED_DEFAULTS,
  enabled: true,
  textEnabled: true,
  textSizePx: 21,
  pageColor: '#101112',
  surfaceColor: '#131415',
  textColor: '#252627',
  mutedTextColor: '#28292a',
  borderColor: '#434445',
  accentColor: '#3d3e3f',
  accentTextColor: '#404142',
  customCss: '.transport { margin-block: 1rem; }'
};

/** A full palette record with every field set away from its default. */
const EVERY_FIELD_INPUT = {
  enabled: true,
  textEnabled: true,
  textSizePx: 23.7,
  tableTextSizePx: 10.4,
  themeEnabled: true,
  ...PALETTE_PROBE_COLORS,
  speakerColors: ['#373839', '#3A3B3C', '#3D3E3F'],
  gradientEnabled: true,
  gradientColors: ['#404142', '#434445', '#464748'],
  gradientAngle: 143,
  gradientSpeed: 'fast',
  customCssEnabled: true,
  customCss: '.transport { margin-block: 1rem; }'
};

const EVERY_FIELD_EXPECTED = {
  enabled: true,
  textEnabled: true,
  textSizePx: 24,
  tableTextSizePx: 10,
  themeEnabled: true,
  pageColor: '#101112',
  surfaceColor: '#131415',
  textColor: '#161718',
  mutedTextColor: '#191a1b',
  accentColor: '#1c1d1e',
  accentTextColor: '#1f2021',
  borderColor: '#222324',
  activeRowColor: '#252627',
  activeRowTextColor: '#28292a',
  waveColor: '#2b2c2d',
  speakerColors: ['#373839', '#3a3b3c', '#3d3e3f'],
  dangerColor: '#2e2f30',
  warningColor: '#313233',
  successColor: '#343536',
  gradientEnabled: true,
  gradientColors: ['#404142', '#434445', '#464748'],
  gradientAngle: 150,
  gradientSpeed: 'fast',
  customCssEnabled: true,
  customCss: '.transport { margin-block: 1rem; }'
};

const MALFORMED_COLORS = [
  '#fff',
  '#ffff',
  '#ffffffff',
  'ffffff',
  '#gggggg',
  '#fffff',
  ' #ffffff',
  '#ffffff ',
  'rgb(1, 2, 3)',
  'red',
  'currentColor',
  '',
  42,
  0,
  null,
  undefined,
  true,
  ['#ffffff'],
  { value: '#ffffff' }
];

const HEX = /^#[0-9a-f]{6}$/;

function assertNoDeletedKeys(record, label) {
  for (const key of DELETED_KEYS) {
    assert.equal(
      Object.hasOwn(record, key),
      false,
      `${label} must not resurrect the deleted key ${key}`
    );
  }
}

test('the stored record is exactly the 25 field palette schema', async () => {
  const {
    DEFAULT_EXTENSION_SETTINGS,
    DEFAULT_WEBSITE_APPEARANCE_SETTINGS,
    normalizeExtensionSettings,
    normalizeWebsiteAppearanceSettings
  } = await settingsModule;

  const expectedKeys = [...APPEARANCE_KEYS].sort();
  assert.equal(APPEARANCE_KEYS.length, 25);

  const records = {
    defaults: DEFAULT_WEBSITE_APPEARANCE_SETTINGS,
    nestedDefaults: DEFAULT_EXTENSION_SETTINGS.websiteAppearance,
    empty: normalizeWebsiteAppearanceSettings({}),
    legacy: normalizeWebsiteAppearanceSettings(LEGACY_RECORD),
    everyField: normalizeWebsiteAppearanceSettings(EVERY_FIELD_INPUT),
    nested: normalizeExtensionSettings({ websiteAppearance: LEGACY_RECORD }).websiteAppearance
  };

  for (const [label, record] of Object.entries(records)) {
    assert.deepEqual(Object.keys(record).sort(), expectedKeys, `${label} key set`);
    assertNoDeletedKeys(record, label);
  }
});

test('appearance defaults are fully opt out and match the shipped palette exactly', async () => {
  const {
    DEFAULT_EXTENSION_SETTINGS,
    DEFAULT_WEBSITE_APPEARANCE_SETTINGS,
    normalizeExtensionSettings,
    normalizeWebsiteAppearanceSettings
  } = await settingsModule;

  assert.deepEqual(DEFAULT_WEBSITE_APPEARANCE_SETTINGS, EXPECTED_DEFAULTS);
  assert.deepEqual(DEFAULT_EXTENSION_SETTINGS.websiteAppearance, EXPECTED_DEFAULTS);

  for (const key of GROUP_FLAG_KEYS) {
    assert.equal(
      DEFAULT_WEBSITE_APPEARANCE_SETTINGS[key],
      false,
      `${key} must default to off so a fresh install changes nothing`
    );
  }

  for (const source of [undefined, null, 42, 'settings', true, [], () => {}, Symbol('x')]) {
    assert.deepEqual(
      normalizeWebsiteAppearanceSettings(source),
      EXPECTED_DEFAULTS,
      `${String(source)} must normalize to the shipped defaults`
    );
  }

  assert.deepEqual(normalizeExtensionSettings({}).websiteAppearance, EXPECTED_DEFAULTS);
  assert.deepEqual(
    normalizeExtensionSettings({ websiteAppearance: 'nonsense' }).websiteAppearance,
    EXPECTED_DEFAULTS
  );
  assert.deepEqual(
    normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS).websiteAppearance,
    EXPECTED_DEFAULTS,
    'normalization must be idempotent'
  );

  for (const color of Object.values(EXPECTED_DEFAULTS)) {
    if (typeof color === 'string' && color.startsWith('#')) {
      assert.match(color, HEX, 'shipped defaults must already be lowercase six digit hex');
    }
  }
});

test('each opt-in flag is independent and never implies another', async () => {
  const { normalizeWebsiteAppearanceSettings } = await settingsModule;

  for (const key of GROUP_FLAG_KEYS) {
    const only = normalizeWebsiteAppearanceSettings({ [key]: true });
    assert.deepEqual(only, { ...EXPECTED_DEFAULTS, [key]: true }, `${key} must stand alone`);

    for (const other of GROUP_FLAG_KEYS) {
      if (other !== key) {
        assert.equal(only[other], false, `${key} must not imply ${other}`);
      }
    }

    for (const truthy of ['true', 1, {}, [], 'yes']) {
      assert.equal(
        normalizeWebsiteAppearanceSettings({ [key]: truthy })[key],
        false,
        `${key} must reject the non-boolean ${String(truthy)}`
      );
    }

    assert.equal(normalizeWebsiteAppearanceSettings({ [key]: false })[key], false);
  }

  const all = normalizeWebsiteAppearanceSettings(
    Object.fromEntries(GROUP_FLAG_KEYS.map((key) => [key, true]))
  );
  for (const key of GROUP_FLAG_KEYS) {
    assert.equal(all[key], true);
  }
});

test('every palette entry normalizes strictly and in isolation', async () => {
  const { normalizeWebsiteAppearanceSettings } = await settingsModule;

  for (const key of PALETTE_COLOR_KEYS) {
    const probe = PALETTE_PROBE_COLORS[key];
    assert.notEqual(probe.toLowerCase(), EXPECTED_DEFAULTS[key], `${key} probe must differ`);

    assert.deepEqual(
      normalizeWebsiteAppearanceSettings({ [key]: probe }),
      { ...EXPECTED_DEFAULTS, [key]: probe.toLowerCase() },
      `${key} must lowercase and touch nothing else`
    );

    for (const malformed of MALFORMED_COLORS) {
      assert.deepEqual(
        normalizeWebsiteAppearanceSettings({ [key]: malformed }),
        EXPECTED_DEFAULTS,
        `${key} must fall back to its default for ${String(malformed)}`
      );
    }
  }

  assert.deepEqual(normalizeWebsiteAppearanceSettings(EVERY_FIELD_INPUT), EVERY_FIELD_EXPECTED);
  assert.deepEqual(
    normalizeWebsiteAppearanceSettings(EVERY_FIELD_EXPECTED),
    EVERY_FIELD_EXPECTED,
    'a normalized record must survive a second pass unchanged'
  );
});

test('speakerColors is always exactly three lowercase hex slots', async () => {
  const {
    DEFAULT_WEBSITE_APPEARANCE_SETTINGS,
    WEBSITE_APPEARANCE_SPEAKER_SLOT_COUNT,
    normalizeWebsiteAppearanceSettings
  } = await settingsModule;

  assert.equal(WEBSITE_APPEARANCE_SPEAKER_SLOT_COUNT, 3);
  assert.equal(DEFAULT_WEBSITE_APPEARANCE_SETTINGS.speakerColors.length, 3);
  assert.deepEqual(DEFAULT_WEBSITE_APPEARANCE_SETTINGS.speakerColors, [
    '#64b5f6',
    '#b083ff',
    '#38bdf8'
  ]);

  for (let slot = 0; slot < WEBSITE_APPEARANCE_SPEAKER_SLOT_COUNT; slot += 1) {
    const incoming = [undefined, undefined, undefined];
    incoming[slot] = '#ABCDEF';
    const expected = [...EXPECTED_DEFAULTS.speakerColors];
    expected[slot] = '#abcdef';

    assert.deepEqual(
      normalizeWebsiteAppearanceSettings({ speakerColors: incoming }),
      { ...EXPECTED_DEFAULTS, speakerColors: expected },
      `speaker slot ${slot} must be isolated`
    );

    for (const malformed of MALFORMED_COLORS) {
      const broken = [...EXPECTED_DEFAULTS.speakerColors];
      broken[slot] = malformed;
      assert.deepEqual(
        normalizeWebsiteAppearanceSettings({ speakerColors: broken }).speakerColors,
        EXPECTED_DEFAULTS.speakerColors,
        `speaker slot ${slot} must reject ${String(malformed)}`
      );
    }
  }

  assert.deepEqual(
    normalizeWebsiteAppearanceSettings({
      speakerColors: ['#111111', '#222222', '#333333', '#444444', '#555555']
    }).speakerColors,
    ['#111111', '#222222', '#333333'],
    'extra slots are dropped instead of stored'
  );
  assert.deepEqual(
    normalizeWebsiteAppearanceSettings({ speakerColors: ['#111111'] }).speakerColors,
    ['#111111', '#b083ff', '#38bdf8'],
    'missing slots fall back to their own default'
  );
  for (const source of [
    '#111111',
    42,
    null,
    { 0: '#111111', 1: '#222222', 2: '#333333' },
    new Set(['#111111'])
  ]) {
    assert.deepEqual(
      normalizeWebsiteAppearanceSettings({ speakerColors: source }).speakerColors,
      EXPECTED_DEFAULTS.speakerColors,
      `a non-array speaker container (${String(source)}) must reset the tuple`
    );
  }
});

test('gradient colors, angle, and speed normalize independently', async () => {
  const { normalizeWebsiteAppearanceSettings } = await settingsModule;

  for (let slot = 0; slot < 3; slot += 1) {
    const incoming = [undefined, undefined, undefined];
    incoming[slot] = '#ABCDEF';
    const expected = [...EXPECTED_DEFAULTS.gradientColors];
    expected[slot] = '#abcdef';

    assert.deepEqual(
      normalizeWebsiteAppearanceSettings({ gradientColors: incoming }),
      { ...EXPECTED_DEFAULTS, gradientColors: expected },
      `gradient stop ${slot} must be isolated`
    );

    for (const malformed of MALFORMED_COLORS) {
      const broken = [...EXPECTED_DEFAULTS.gradientColors];
      broken[slot] = malformed;
      assert.deepEqual(
        normalizeWebsiteAppearanceSettings({ gradientColors: broken }).gradientColors,
        EXPECTED_DEFAULTS.gradientColors,
        `gradient stop ${slot} must reject ${String(malformed)}`
      );
    }
  }

  assert.deepEqual(
    normalizeWebsiteAppearanceSettings({
      gradientColors: ['#111111', '#222222', '#333333', '#444444']
    }).gradientColors,
    ['#111111', '#222222', '#333333']
  );
  for (const source of ['#111111', 42, null, { 0: '#111111' }]) {
    assert.deepEqual(
      normalizeWebsiteAppearanceSettings({ gradientColors: source }).gradientColors,
      EXPECTED_DEFAULTS.gradientColors
    );
  }

  for (const [input, expected] of [
    [0, 0],
    [7, 0],
    [8, 15],
    [143, 150],
    [180, 180],
    [352, 345],
    [353, 360],
    [360, 360],
    [1_000, 360],
    [-40, 0]
  ]) {
    assert.equal(
      normalizeWebsiteAppearanceSettings({ gradientAngle: input }).gradientAngle,
      expected,
      `angle ${input} must clamp and step to ${expected}`
    );
  }
  for (const invalid of ['135', Number.NaN, Number.POSITIVE_INFINITY, null, undefined, {}, [135]]) {
    assert.equal(
      normalizeWebsiteAppearanceSettings({ gradientAngle: invalid }).gradientAngle,
      135,
      `angle ${String(invalid)} must fall back to the default`
    );
  }

  for (const speed of ['slow', 'balanced', 'fast']) {
    assert.equal(normalizeWebsiteAppearanceSettings({ gradientSpeed: speed }).gradientSpeed, speed);
  }
  for (const invalid of ['Fast', 'instant', '', 0, 1, null, undefined, {}, 'toString']) {
    assert.equal(
      normalizeWebsiteAppearanceSettings({ gradientSpeed: invalid }).gradientSpeed,
      'slow',
      `speed ${String(invalid)} must fall back to slow`
    );
  }
});

test('both text sizes clamp to 10 through 30 pixels and round to integers', async () => {
  const { normalizeExtensionSettings, normalizeWebsiteAppearanceSettings } = await settingsModule;

  for (const key of ['textSizePx', 'tableTextSizePx']) {
    for (const [input, expected] of [
      [-100, 10],
      [0, 10],
      [9, 10],
      [9.9, 10],
      [10, 10],
      [12.4, 12],
      [12.5, 13],
      [23.7, 24],
      [30, 30],
      [30.4, 30],
      [31, 30],
      [1_000, 30]
    ]) {
      assert.equal(
        normalizeWebsiteAppearanceSettings({ [key]: input })[key],
        expected,
        `${key} ${input} must clamp and round to ${expected}`
      );
    }

    for (const invalid of ['16', Number.NaN, Number.POSITIVE_INFINITY, null, {}, [16], true]) {
      assert.equal(
        normalizeWebsiteAppearanceSettings({ [key]: invalid })[key],
        12,
        `${key} must reject ${String(invalid)}`
      );
    }
  }

  const both = normalizeWebsiteAppearanceSettings({ textSizePx: 30, tableTextSizePx: 10 });
  assert.equal(both.textSizePx, 30);
  assert.equal(both.tableTextSizePx, 10, 'the table dial is independent of the editor dial');
  assert.deepEqual(
    normalizeExtensionSettings({ websiteAppearance: { textSizePx: 44, tableTextSizePx: 1 } })
      .websiteAppearance,
    { ...EXPECTED_DEFAULTS, textSizePx: 30, tableTextSizePx: 10 }
  );
});

test('legacy percentage text sizes migrate to bounded pixels', async () => {
  const { normalizeWebsiteAppearanceSettings } = await settingsModule;

  // The retired dial was a percentage of the 15px editor base.
  for (const [textSizePercent, expected] of [
    [100, 15],
    [80, 12],
    [140, 21],
    [200, 30],
    [400, 30],
    [50, 10],
    [0, 10],
    [-100, 10]
  ]) {
    const migrated = normalizeWebsiteAppearanceSettings({ textSizePercent });
    assert.equal(migrated.textSizePx, expected, `${textSizePercent}% must become ${expected}px`);
    assert.equal(Object.hasOwn(migrated, 'textSizePercent'), false);
    assert.equal(migrated.textEnabled, true, 'a percentage marks a legacy record');
  }

  assert.equal(
    normalizeWebsiteAppearanceSettings({ textSizePercent: 200, textSizePx: 17 }).textSizePx,
    17,
    'an explicit pixel dial always wins over the retired percentage'
  );
  assert.equal(
    normalizeWebsiteAppearanceSettings({ textSizePercent: 200, textSizePx: 'nope' }).textSizePx,
    12,
    'a present but malformed pixel dial does not fall back to the percentage'
  );
  assert.equal(
    normalizeWebsiteAppearanceSettings({ textSizePercent: '140' }).textSizePx,
    12,
    'a non-numeric percentage is discarded'
  );
  assert.equal(
    normalizeWebsiteAppearanceSettings({ textSizePercent: '140' }).textEnabled,
    true,
    'the key still marks the record legacy even when its value is unusable'
  );
});

test('legacy records migrate forward as text-only without resurrecting deleted fields', async () => {
  const { normalizeExtensionSettings, normalizeWebsiteAppearanceSettings } = await settingsModule;

  const migrated = normalizeWebsiteAppearanceSettings(LEGACY_RECORD);
  assert.deepEqual(migrated, LEGACY_RECORD_EXPECTED);
  assertNoDeletedKeys(migrated, 'a migrated legacy record');
  assert.deepEqual(
    normalizeExtensionSettings({ websiteAppearance: LEGACY_RECORD }).websiteAppearance,
    LEGACY_RECORD_EXPECTED,
    'the nested pipeline migrates identically'
  );

  assert.equal(migrated.textEnabled, true, 'legacy survives as text theming only');
  for (const key of ['themeEnabled', 'gradientEnabled', 'customCssEnabled']) {
    assert.equal(migrated[key], false, `${key} must stay off for a legacy record`);
  }

  // Palette entries with no one-to-one predecessor reset instead of guessing.
  for (const key of [
    'activeRowColor',
    'activeRowTextColor',
    'waveColor',
    'dangerColor',
    'warningColor',
    'successColor'
  ]) {
    assert.equal(
      migrated[key],
      EXPECTED_DEFAULTS[key],
      `${key} has no legacy predecessor and must reset to its default`
    );
  }
  assert.deepEqual(
    migrated.speakerColors,
    EXPECTED_DEFAULTS.speakerColors,
    'the retired seven-dial lane tuple has no mapping onto speaker colors'
  );

  // Presence alone marks a record legacy, whatever the value.
  for (const key of LEGACY_MARKER_KEYS) {
    const probe = normalizeWebsiteAppearanceSettings({
      [key]: undefined,
      themeEnabled: true,
      gradientEnabled: true,
      customCssEnabled: true,
      speakerColors: ['#111111', '#222222', '#333333']
    });
    assert.equal(probe.textEnabled, true, `${key} must mark the record legacy`);
    assert.equal(probe.themeEnabled, false, `${key} must force the theme group off`);
    assert.equal(probe.gradientEnabled, false, `${key} must force the gradient group off`);
    assert.equal(probe.customCssEnabled, false, `${key} must force custom CSS off`);
    assert.deepEqual(probe.speakerColors, EXPECTED_DEFAULTS.speakerColors);
    assertNoDeletedKeys(probe, `a record carrying ${key}`);
  }

  // The surviving one-to-one color mappings, each in isolation.
  for (const [legacyKey, paletteKey] of [
    ['pageBackgroundColor', 'pageColor'],
    ['primaryColor', 'accentColor'],
    ['primaryTextColor', 'accentTextColor']
  ]) {
    assert.equal(
      normalizeWebsiteAppearanceSettings({ [legacyKey]: '#ABCDEF' })[paletteKey],
      '#abcdef',
      `${legacyKey} must migrate onto ${paletteKey}`
    );
    assert.equal(
      normalizeWebsiteAppearanceSettings({ [legacyKey]: 'nope' })[paletteKey],
      EXPECTED_DEFAULTS[paletteKey],
      `a malformed ${legacyKey} must fall back to the new default`
    );
  }
  for (const key of ['surfaceColor', 'textColor', 'mutedTextColor', 'borderColor']) {
    assert.equal(
      normalizeWebsiteAppearanceSettings({ lanes: [], [key]: '#ABCDEF' })[key],
      '#abcdef',
      `${key} keeps its own value across the migration`
    );
  }
  assert.equal(
    normalizeWebsiteAppearanceSettings({
      lanes: [],
      primaryColor: '#111111',
      accentColor: '#ABCDEF'
    }).accentColor,
    '#abcdef',
    'an already-migrated accent wins over the retired primary color'
  );
  assert.equal(
    normalizeWebsiteAppearanceSettings({ lanes: [], primaryColor: '#111111', accentColor: 'nope' })
      .accentColor,
    '#111111',
    'a malformed accent falls back to the retired primary color'
  );

  // Gradient geometry and the CSS draft are not gated on the legacy flag.
  const legacyGradient = normalizeWebsiteAppearanceSettings({
    lanes: [],
    gradientEnabled: true,
    gradientColors: ['#111111', '#222222', '#333333'],
    gradientAngle: 90,
    gradientSpeed: 'fast',
    customCssEnabled: true,
    customCss: '.transport { gap: 1rem; }'
  });
  assert.equal(legacyGradient.gradientEnabled, false);
  assert.deepEqual(legacyGradient.gradientColors, ['#111111', '#222222', '#333333']);
  assert.equal(legacyGradient.gradientAngle, 90);
  assert.equal(legacyGradient.gradientSpeed, 'fast');
  assert.equal(legacyGradient.customCssEnabled, false);
  assert.equal(legacyGradient.customCss, '.transport { gap: 1rem; }');
});

test('a palette record is never mistaken for a legacy record', async () => {
  const { normalizeWebsiteAppearanceSettings } = await settingsModule;

  for (const key of APPEARANCE_KEYS) {
    assert.equal(
      LEGACY_MARKER_KEYS.includes(key),
      false,
      `${key} is a live field and must not be a legacy marker`
    );
  }

  // accentColor, surfaceColor and friends survived the rename: they are data,
  // not migration markers.
  for (const key of ['accentColor', 'surfaceColor', 'textColor', 'mutedTextColor', 'borderColor']) {
    const record = normalizeWebsiteAppearanceSettings({ themeEnabled: true, [key]: '#ABCDEF' });
    assert.deepEqual(record, {
      ...EXPECTED_DEFAULTS,
      themeEnabled: true,
      [key]: '#abcdef'
    });
  }

  assert.deepEqual(normalizeWebsiteAppearanceSettings(EVERY_FIELD_EXPECTED), EVERY_FIELD_EXPECTED);
});

test('normalization hands back fresh mutable containers', async () => {
  const {
    DEFAULT_EXTENSION_SETTINGS,
    DEFAULT_WEBSITE_APPEARANCE_SETTINGS,
    normalizeWebsiteAppearanceSettings
  } = await settingsModule;

  const source = {
    gradientColors: ['#111111', '#222222', '#333333'],
    speakerColors: ['#444444', '#555555', '#666666']
  };
  const first = normalizeWebsiteAppearanceSettings(source);
  const second = normalizeWebsiteAppearanceSettings(source);

  for (const key of ['gradientColors', 'speakerColors']) {
    assert.notEqual(first[key], second[key], `${key} must not be shared between calls`);
    assert.notEqual(first[key], source[key], `${key} must not alias the caller's array`);
    assert.notEqual(
      DEFAULT_EXTENSION_SETTINGS.websiteAppearance[key],
      DEFAULT_WEBSITE_APPEARANCE_SETTINGS[key],
      `the nested default ${key} must not alias the exported default`
    );
  }

  first.gradientColors[0] = '#ffffff';
  first.speakerColors.length = 0;
  assert.deepEqual(second.gradientColors, ['#111111', '#222222', '#333333']);
  assert.deepEqual(second.speakerColors, ['#444444', '#555555', '#666666']);
  assert.deepEqual(source.gradientColors, ['#111111', '#222222', '#333333']);
  assert.deepEqual(source.speakerColors, ['#444444', '#555555', '#666666']);
  assert.deepEqual(DEFAULT_WEBSITE_APPEARANCE_SETTINGS.gradientColors, [
    '#0f766e',
    '#2563eb',
    '#0f766e'
  ]);
  assert.deepEqual(DEFAULT_WEBSITE_APPEARANCE_SETTINGS.speakerColors, [
    '#64b5f6',
    '#b083ff',
    '#38bdf8'
  ]);
});

function installFakeStorage({ lastError, throwOnGet, throwOnSet } = {}) {
  let stored = {};
  globalThis.chrome = {
    runtime: lastError ? { lastError } : {},
    storage: {
      local: {
        get(key, callback) {
          if (throwOnGet) {
            throw new Error(throwOnGet);
          }

          callback({ [key]: stored[key] });
        },
        set(items, callback) {
          if (throwOnSet) {
            throw new Error(throwOnSet);
          }

          stored = structuredClone(items);
          callback();
        }
      }
    }
  };
  return () => stored;
}

test('save and load preserve every palette field under the shared settings key', async () => {
  const { SETTINGS_STORAGE_KEY, loadExtensionSettings, saveExtensionSettings } =
    await settingsModule;
  const readStored = installFakeStorage();

  assert.equal(SETTINGS_STORAGE_KEY, 'settings');

  try {
    const saved = await saveExtensionSettings({ websiteAppearance: EVERY_FIELD_INPUT });
    const loaded = await loadExtensionSettings();
    const stored = readStored();

    assert.deepEqual(saved.websiteAppearance, EVERY_FIELD_EXPECTED);
    assert.equal(loaded.loaded, true);
    assert.equal(Object.hasOwn(loaded, 'error'), false);
    assert.deepEqual(loaded.settings.websiteAppearance, EVERY_FIELD_EXPECTED);
    assert.deepEqual(stored[SETTINGS_STORAGE_KEY].websiteAppearance, EVERY_FIELD_EXPECTED);
    assertNoDeletedKeys(stored[SETTINGS_STORAGE_KEY].websiteAppearance, 'the persisted record');
  } finally {
    delete globalThis.chrome;
  }

  const legacyStore = installFakeStorage();
  try {
    await saveExtensionSettings({ websiteAppearance: LEGACY_RECORD });
    const loaded = await loadExtensionSettings();
    assert.deepEqual(loaded.settings.websiteAppearance, LEGACY_RECORD_EXPECTED);
    assertNoDeletedKeys(
      legacyStore()[SETTINGS_STORAGE_KEY].websiteAppearance,
      'a rewritten legacy record'
    );
  } finally {
    delete globalThis.chrome;
  }
});

test('load reports read failures instead of silently returning defaults', async () => {
  const { loadExtensionSettings } = await settingsModule;

  const missingStorage = await loadExtensionSettings();
  assert.equal(missingStorage.loaded, false);
  assert.equal(missingStorage.error, 'Extension storage is unavailable.');
  assert.deepEqual(missingStorage.settings.websiteAppearance, EXPECTED_DEFAULTS);

  installFakeStorage({ lastError: { message: 'Storage read blew up.' } });
  try {
    const failed = await loadExtensionSettings();
    assert.equal(failed.loaded, false);
    assert.equal(failed.error, 'Storage read blew up.');
    assert.deepEqual(failed.settings.websiteAppearance, EXPECTED_DEFAULTS);
  } finally {
    delete globalThis.chrome;
  }

  installFakeStorage({ lastError: {} });
  try {
    const failed = await loadExtensionSettings();
    assert.equal(failed.loaded, false);
    assert.equal(failed.error, 'Could not load settings.');
  } finally {
    delete globalThis.chrome;
  }

  installFakeStorage({ throwOnGet: 'Extension context invalidated.' });
  try {
    const threw = await loadExtensionSettings();
    assert.equal(threw.loaded, false);
    assert.equal(threw.error, 'Extension context invalidated.');
  } finally {
    delete globalThis.chrome;
  }

  installFakeStorage();
  try {
    const empty = await loadExtensionSettings();
    assert.equal(empty.loaded, true, 'an empty store is a successful read, not a failure');
    assert.equal(Object.hasOwn(empty, 'error'), false);
    assert.deepEqual(empty.settings.websiteAppearance, EXPECTED_DEFAULTS);
  } finally {
    delete globalThis.chrome;
  }
});

test('save surfaces write failures to callers', async () => {
  const { saveExtensionSettings } = await settingsModule;

  installFakeStorage({ lastError: { message: 'QUOTA_BYTES quota exceeded' } });
  try {
    await assert.rejects(saveExtensionSettings({ websiteAppearance: { textEnabled: true } }), {
      message: 'Could not save settings: QUOTA_BYTES quota exceeded'
    });
  } finally {
    delete globalThis.chrome;
  }

  installFakeStorage({ lastError: {} });
  try {
    await assert.rejects(saveExtensionSettings({}), { message: 'Could not save settings.' });
  } finally {
    delete globalThis.chrome;
  }

  installFakeStorage({ throwOnSet: 'Extension context invalidated.' });
  try {
    await assert.rejects(saveExtensionSettings({}), {
      message: 'Could not save settings: Extension context invalidated.'
    });
  } finally {
    delete globalThis.chrome;
  }

  const withoutStorage = await saveExtensionSettings({ websiteAppearance: { textEnabled: true } });
  assert.deepEqual(withoutStorage.websiteAppearance, { ...EXPECTED_DEFAULTS, textEnabled: true });
});

test('custom CSS is clamped to the stored ceiling so oversized blobs cannot be persisted', async () => {
  const {
    SETTINGS_STORAGE_KEY,
    WEBSITE_CUSTOM_CSS_MAX_LENGTH,
    normalizeExtensionSettings,
    normalizeWebsiteAppearanceSettings,
    saveExtensionSettings
  } = await settingsModule;
  const oversized = `${'a'.repeat(WEBSITE_CUSTOM_CSS_MAX_LENGTH)}OVERFLOW`;

  const normalized = normalizeWebsiteAppearanceSettings({ customCss: oversized });
  assert.equal(normalized.customCss.length, WEBSITE_CUSTOM_CSS_MAX_LENGTH);
  assert.equal(normalized.customCss.includes('OVERFLOW'), false);
  assert.equal(
    normalizeWebsiteAppearanceSettings({ customCss: 'a'.repeat(WEBSITE_CUSTOM_CSS_MAX_LENGTH) })
      .customCss.length,
    WEBSITE_CUSTOM_CSS_MAX_LENGTH
  );
  assert.equal(
    normalizeExtensionSettings({ websiteAppearance: { customCss: oversized } }).websiteAppearance
      .customCss.length,
    WEBSITE_CUSTOM_CSS_MAX_LENGTH
  );

  for (const invalid of [42, null, undefined, {}, ['.a{}'], true]) {
    assert.equal(
      normalizeWebsiteAppearanceSettings({ customCss: invalid }).customCss,
      '',
      `a non-string draft (${String(invalid)}) must normalize to empty text`
    );
  }
  assert.equal(
    normalizeWebsiteAppearanceSettings({ customCss: '  .a { color: red }  ' }).customCss,
    '  .a { color: red }  ',
    'a valid draft is stored verbatim, whitespace included'
  );

  const readStored = installFakeStorage();
  try {
    await saveExtensionSettings({ websiteAppearance: { customCss: oversized } });
    assert.equal(
      readStored()[SETTINGS_STORAGE_KEY].websiteAppearance.customCss.length,
      WEBSITE_CUSTOM_CSS_MAX_LENGTH
    );
  } finally {
    delete globalThis.chrome;
  }
});

test('custom CSS validator rejects forbidden constructs and structural damage', async () => {
  const { validateWebsiteCustomCss } = await settingsModule;
  const invalidCases = [
    42,
    null,
    undefined,
    {},
    '<style>main { color: red; }</style>',
    'main { color: red; }</STYLE >',
    '@import "theme.css"; main { color: red; }',
    String.raw`@\69mport "theme.css";`,
    'main { background: URL(https://example.com/theme.png); }',
    String.raw`main { background: u\72l(image.png); }`,
    'main { background-image: image-set("https://example.com/panel.png" 1x); }',
    'main { background-image: -webkit-image-set("https://example.com/panel.png" 1x); }',
    '@font-face { src: src("https://example.com/font.woff2"); }',
    'main { background: image("https://example.com/panel.png"); }',
    String.raw`main { background: sr\63 ("https://example.com/font.woff2"); }`,
    'main { color: red; /* missing close',
    'main { color: red; */ }',
    'main::before { content: "missing close; }',
    'main::before { content: "safe\n} main { background: url(evil.png); }\n"; }',
    'main::before { content: "safe\r} main { background: url(evil.png); }\r"; }',
    'main::before { content: "safe\f} main { background: url(evil.png); }\f"; }',
    'main { color: rgb(1, 2, 3]; }',
    '@media (width > 40rem) { main { color: red; }',
    'main { color: red; }' + '\\'
  ];

  for (const source of invalidCases) {
    const result = validateWebsiteCustomCss(source);
    assert.equal(result.valid, false, `expected validator to reject ${String(source)}`);
    assert.equal(typeof result.message, 'string');
    assert.notEqual(result.message, '');
  }

  assert.deepEqual(validateWebsiteCustomCss(42), {
    valid: false,
    message: 'Custom CSS must be text.'
  });
  assert.deepEqual(validateWebsiteCustomCss('@import "theme.css";'), {
    valid: false,
    message: '@import is not allowed in custom CSS.'
  });
  assert.deepEqual(validateWebsiteCustomCss('main { background: url(theme.png); }'), {
    valid: false,
    message: 'url() is not allowed in custom CSS.'
  });
  assert.deepEqual(validateWebsiteCustomCss('<style>main{}</style>'), {
    valid: false,
    message: 'Style tags are not allowed in custom CSS.'
  });
  assert.deepEqual(validateWebsiteCustomCss('main { color: red; }' + '\\'), {
    valid: false,
    message: 'Custom CSS contains an incomplete escape.'
  });
  assert.deepEqual(validateWebsiteCustomCss('main { color: rgb(1, 2, 3]; }'), {
    valid: false,
    message: 'Custom CSS contains unbalanced delimiters.'
  });
  assert.deepEqual(validateWebsiteCustomCss('main { color: red;'), {
    valid: false,
    message: 'Custom CSS contains unbalanced delimiters.'
  });
  assert.deepEqual(validateWebsiteCustomCss('main::before { content: "oops; }'), {
    valid: false,
    message: 'Custom CSS contains an unclosed string.'
  });
  assert.deepEqual(validateWebsiteCustomCss('main { color: red; /* nope'), {
    valid: false,
    message: 'Custom CSS contains an unclosed comment.'
  });
  assert.deepEqual(validateWebsiteCustomCss('main { color: red; */ }'), {
    valid: false,
    message: 'Custom CSS contains an unmatched comment closer.'
  });

  for (const functionName of ['image-set', '-webkit-image-set']) {
    assert.deepEqual(
      validateWebsiteCustomCss(
        `main { background-image: ${functionName}("https://example.com/panel.png" 1x); }`
      ),
      { valid: false, message: 'image-set() is not allowed in custom CSS.' }
    );
  }
  for (const [functionName, label] of [
    ['src', 'src'],
    ['image', 'image'],
    ['IMAGE', 'image'],
    ['url', 'url']
  ]) {
    assert.deepEqual(
      validateWebsiteCustomCss(`main { background: ${functionName}("https://example.com/x.png"); }`),
      { valid: false, message: `${label}() is not allowed in custom CSS.` }
    );
  }

  assert.equal(validateWebsiteCustomCss('main { width: calc(2px*/*inline*/2); }').valid, true);
  assert.deepEqual(validateWebsiteCustomCss('main { color: red; */* }'), {
    valid: false,
    message: 'Custom CSS contains an unclosed comment.'
  });
});

test('custom CSS validator enforces the UTF-16 length ceiling shared with the clamp', async () => {
  const { WEBSITE_CUSTOM_CSS_MAX_LENGTH, normalizeWebsiteAppearanceSettings, validateWebsiteCustomCss } =
    await settingsModule;

  assert.equal(WEBSITE_CUSTOM_CSS_MAX_LENGTH, 50_000);
  assert.equal(validateWebsiteCustomCss(' '.repeat(WEBSITE_CUSTOM_CSS_MAX_LENGTH)).valid, true);
  assert.deepEqual(validateWebsiteCustomCss(' '.repeat(WEBSITE_CUSTOM_CSS_MAX_LENGTH + 1)), {
    valid: false,
    message: 'Custom CSS must be 50,000 characters or fewer.'
  });
  assert.equal(
    normalizeWebsiteAppearanceSettings({ customCss: ' '.repeat(WEBSITE_CUSTOM_CSS_MAX_LENGTH + 1) })
      .customCss.length,
    WEBSITE_CUSTOM_CSS_MAX_LENGTH,
    'the clamp and the validator must share one ceiling'
  );
  assert.equal(validateWebsiteCustomCss('😀'.repeat(25_000)).valid, true);
  assert.equal(validateWebsiteCustomCss('😀'.repeat(25_000) + 'x').valid, false);
});

test('custom CSS validator accepts nested rules, keyframes, comments, and quoted text', async () => {
  const { validateWebsiteCustomCss } = await settingsModule;
  const css = `
    /* url(fake.png), @import and <style> inside comments are inert */
    @media (min-width: 48rem) {
      @supports (display: grid) {
        main[data-label="url(fake.png)"] {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 2fr;
          transform: translateX(calc((100% - 2rem) / 2));
        }
      }
    }
    @keyframes panel-slide {
      0% { transform: translateX(0); }
      100% { transform: translateX(1rem); }
    }
  `;

  assert.deepEqual(validateWebsiteCustomCss(css), {
    valid: true,
    message: 'Custom CSS is valid.'
  });
  assert.deepEqual(validateWebsiteCustomCss(''), {
    valid: true,
    message: 'Custom CSS is valid.'
  });
});

test('appearance share strings round-trip an identical normalized record', async () => {
  const {
    DEFAULT_WEBSITE_APPEARANCE_SETTINGS,
    WEBSITE_APPEARANCE_SHARE_PREFIX,
    decodeWebsiteAppearanceShare,
    encodeWebsiteAppearanceShare,
    normalizeWebsiteAppearanceSettings
  } = await settingsModule;

  assert.equal(WEBSITE_APPEARANCE_SHARE_PREFIX, 'wa1.');

  for (const record of [
    DEFAULT_WEBSITE_APPEARANCE_SETTINGS,
    normalizeWebsiteAppearanceSettings(EVERY_FIELD_INPUT),
    // A palette-only record: non-default colors with every other group left off.
    normalizeWebsiteAppearanceSettings({
      enabled: true,
      themeEnabled: true,
      ...PALETTE_PROBE_COLORS,
      speakerColors: ['#373839', '#3a3b3c', '#3d3e3f']
    })
  ]) {
    const share = encodeWebsiteAppearanceShare(record);
    assert.equal(share.startsWith('wa1.'), true);
    assert.match(share.slice(4), /^[A-Za-z0-9_-]+$/, 'payload must be base64url without padding');

    const decoded = decodeWebsiteAppearanceShare(share);
    assert.deepEqual(decoded, normalizeWebsiteAppearanceSettings(record));
    assert.notEqual(decoded, record);
    assert.notEqual(decoded.speakerColors, record.speakerColors);
    assert.notEqual(decoded.gradientColors, record.gradientColors);
    assert.equal(encodeWebsiteAppearanceShare(decoded), share, 'encoding must be stable');
  }

  // A malformed record is normalized on the way out, not shared verbatim.
  const sanitized = encodeWebsiteAppearanceShare({
    ...DEFAULT_WEBSITE_APPEARANCE_SETTINGS,
    accentColor: 'red',
    textSizePx: 99,
    speakerColors: ['#ABCDEF']
  });
  assert.deepEqual(decodeWebsiteAppearanceShare(sanitized), {
    ...EXPECTED_DEFAULTS,
    textSizePx: 30,
    speakerColors: ['#abcdef', '#b083ff', '#38bdf8']
  });

  const unicode = encodeWebsiteAppearanceShare({
    ...DEFAULT_WEBSITE_APPEARANCE_SETTINGS,
    customCssEnabled: true,
    customCss: '/* тема 😀 */ .transport { gap: 1rem; }'
  });
  assert.equal(
    decodeWebsiteAppearanceShare(unicode).customCss,
    '/* тема 😀 */ .transport { gap: 1rem; }'
  );

  // Unknown and missing keys are tolerated by normalizing rather than failing.
  const sparse = 'wa1.' + Buffer.from('{"themeEnabled":true,"nope":1}', 'utf8').toString('base64url');
  assert.deepEqual(decodeWebsiteAppearanceShare(sparse), {
    ...EXPECTED_DEFAULTS,
    themeEnabled: true
  });
  assert.equal(Object.hasOwn(decodeWebsiteAppearanceShare(sparse), 'nope'), false);

  // Legacy markers inside a share string still migrate to text-only theming.
  const legacyShare =
    'wa1.' +
    Buffer.from('{"pageBackgroundColor":"#101112","themeEnabled":true}', 'utf8').toString(
      'base64url'
    );
  const legacyDecoded = decodeWebsiteAppearanceShare(legacyShare);
  assert.deepEqual(legacyDecoded, {
    ...EXPECTED_DEFAULTS,
    textEnabled: true,
    pageColor: '#101112'
  });
  assertNoDeletedKeys(legacyDecoded, 'a decoded legacy share');
});

test('appearance share decoding rejects malformed input instead of guessing', async () => {
  const { decodeWebsiteAppearanceShare, encodeWebsiteAppearanceShare } = await settingsModule;
  const valid = encodeWebsiteAppearanceShare(EXPECTED_DEFAULTS);

  for (const value of [
    undefined,
    null,
    42,
    {},
    [],
    '',
    'wa1',
    'wa1.',
    'wa2.' + valid.slice(4),
    'gc1.' + valid.slice(4),
    valid.slice(4),
    ' ' + valid,
    'wa1.***',
    'wa1.' + Buffer.from('not json', 'utf8').toString('base64url'),
    'wa1.' + Buffer.from('[1,2,3]', 'utf8').toString('base64url'),
    'wa1.' + Buffer.from('"text"', 'utf8').toString('base64url'),
    'wa1.' + Buffer.from('null', 'utf8').toString('base64url'),
    'wa1.' + Buffer.from('7', 'utf8').toString('base64url')
  ]) {
    assert.equal(
      decodeWebsiteAppearanceShare(value),
      null,
      `${String(value)} must be rejected outright`
    );
  }
});
