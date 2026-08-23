import { FEATURE_REGISTRATIONS } from '../features/registry';
import { DEFAULT_HIGHLIGHTED_WORDS, normalizeHighlightedWords } from './highlighted-words';

export type FeatureSettingKey = (typeof FEATURE_REGISTRATIONS)[number]['setting']['key'];
export type FeatureSettings = Record<FeatureSettingKey, boolean>;

export type CustomLinterRuleSetting = {
  id: string;
  label: string;
  description: string;
  enabledByDefault: boolean;
};

export type GhostCursorMotion = 'slow' | 'balanced' | 'snappy';

export interface GhostCursorSettings {
  color: string;
  gradientColor: string;
  gradientEnabled: boolean;
  thickness: number;
  motion: GhostCursorMotion;
}

export type WebsiteGradientSpeed = 'slow' | 'balanced' | 'fast';

/**
 * Speaker lanes rotate over a fixed three-slot palette, so persisted speaker
 * colors are a tuple addressed by `(laneOrder - 1) % WEBSITE_APPEARANCE_SPEAKER_SLOT_COUNT`.
 */
export type WebsiteAppearanceSpeakerColors = [string, string, string];

export const WEBSITE_APPEARANCE_SPEAKER_SLOT_COUNT = 3;

/**
 * The stored appearance record is the core palette and nothing else: every
 * `--bh-*` variable and every app design token is derived from these fields at
 * runtime, never persisted.
 */
export interface WebsiteAppearanceSettings {
  enabled: boolean;
  textEnabled: boolean;
  textSizePx: number;
  tableTextSizePx: number;
  themeEnabled: boolean;
  pageColor: string;
  surfaceColor: string;
  textColor: string;
  mutedTextColor: string;
  accentColor: string;
  accentTextColor: string;
  borderColor: string;
  activeRowColor: string;
  activeRowTextColor: string;
  waveColor: string;
  speakerColors: WebsiteAppearanceSpeakerColors;
  dangerColor: string;
  warningColor: string;
  successColor: string;
  gradientEnabled: boolean;
  gradientColors: [string, string, string];
  gradientAngle: number;
  gradientSpeed: WebsiteGradientSpeed;
  customCssEnabled: boolean;
  customCss: string;
}

export interface ExtensionSettings {
  features: FeatureSettings;
  highlightedWordsEnabled: boolean;
  highlightedWords: string[];
  customLinterDefaultsVersion: number;
  disabledCustomLinterRuleIds: string[];
  ghostCursor: GhostCursorSettings;
  websiteAppearance: WebsiteAppearanceSettings;
}

export const DEFAULT_GHOST_CURSOR_SETTINGS: GhostCursorSettings = {
  color: '#f59e0b',
  gradientColor: '#fb7185',
  gradientEnabled: false,
  thickness: 2,
  motion: 'slow'
};

export const DEFAULT_WEBSITE_APPEARANCE_SETTINGS: WebsiteAppearanceSettings = {
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

export interface FeatureSettingMeta {
  label: string;
  description: string;
}

export const SETTINGS_STORAGE_KEY = 'settings';
export const CUSTOM_LINTER_DEFAULTS_VERSION = 1;

const DEFAULT_DISABLED_CUSTOM_LINTER_RULE_IDS = [
  'curly-tag-trailing-punctuation',
  'angle-tag-trailing-punctuation',
  'square-bracket-tag-trailing-punctuation'
] as const;

export const CUSTOM_LINTER_RULE_SETTINGS: CustomLinterRuleSetting[] = [
  {
    id: 'leading-trailing-spaces',
    label: 'Leading/trailing spaces',
    description: 'Warns when a segment starts or ends with extra whitespace.',
    enabledByDefault: true
  },
  {
    id: 'double-spaces',
    label: 'Double spaces',
    description: 'Warns when a segment contains repeated spaces.',
    enabledByDefault: true
  },
  {
    id: 'comma-spacing',
    label: 'Comma spacing',
    description: 'Requires commas to be followed by one space.',
    enabledByDefault: true
  },
  {
    id: 'period-spacing',
    label: 'Period spacing',
    description: 'Requires periods to be followed by one space.',
    enabledByDefault: true
  },
  {
    id: 'angle-tag-spacing',
    label: 'Angle tag spacing',
    description: 'Checks spacing around angle tags.',
    enabledByDefault: true
  },
  {
    id: 'square-bracket-tag-spacing',
    label: 'Square bracket tag spacing',
    description: 'Checks spacing around square bracket tags.',
    enabledByDefault: true
  },
  {
    id: 'quote-balance',
    label: 'Quote balance',
    description: 'Warns when double quotes are unbalanced.',
    enabledByDefault: true
  },
  {
    id: 'unicode-quotes',
    label: 'Unicode quotes',
    description: 'Warns when typographic quotes should be ASCII quotes.',
    enabledByDefault: true
  },
  {
    id: 'unicode-dashes',
    label: 'Unicode dashes',
    description: 'Warns when typographic dashes should be ASCII hyphens.',
    enabledByDefault: true
  },
  {
    id: 'curly-tag-trailing-punctuation',
    label: 'Curly tag punctuation',
    description: 'Moves punctuation before curly tags.',
    enabledByDefault: false
  },
  {
    id: 'angle-tag-trailing-punctuation',
    label: 'Angle tag punctuation',
    description: 'Checks punctuation around angle tags.',
    enabledByDefault: false
  },
  {
    id: 'square-bracket-tag-trailing-punctuation',
    label: 'Square bracket punctuation',
    description: 'Moves punctuation before square bracket tags.',
    enabledByDefault: false
  },
  {
    id: 'free-mid-sentence-double-dash',
    label: 'Free double dash',
    description: 'Warns on free-floating mid-sentence double dashes.',
    enabledByDefault: true
  },
  {
    id: 'double-dash-punctuation',
    label: 'Double dash punctuation',
    description: 'Warns on punctuation immediately after double dashes.',
    enabledByDefault: true
  },
  {
    id: 'single-dash-punctuation',
    label: 'Single dash punctuation',
    description: 'Warns on punctuation immediately after single dashes.',
    enabledByDefault: true
  },
  {
    id: 'terminal-punctuation',
    label: 'Terminal punctuation',
    description: 'Requires segments to end with an allowed punctuation mark.',
    enabledByDefault: true
  },
  {
    id: 'incorrect-interjection-forms',
    label: 'Interjection spelling',
    description: 'Warns on known non-canonical interjection spellings.',
    enabledByDefault: true
  },
  {
    id: 'normalized-stutters',
    label: 'Normalized stutters',
    description: 'Warns when stutter fragments are not substrings of the following word.',
    enabledByDefault: true
  },
  {
    id: 'highlighted-words',
    label: 'Highlighted words',
    description: 'Warns when a segment contains a configured highlighted word.',
    enabledByDefault: true
  },
  {
    id: 'sentence-boundary-capitalization',
    label: 'Sentence capitalization',
    description: 'Warns when words after sentence endings are not uppercase.',
    enabledByDefault: true
  },
  {
    id: 'polite-pronoun-case',
    label: 'Polite pronoun case',
    description: 'Warns when Russian polite pronouns are uppercase mid-sentence.',
    enabledByDefault: true
  },
  {
    id: 'segment-start-capitalization',
    label: 'Segment start capitalization',
    description: 'Checks capitalization at the start of a segment.',
    enabledByDefault: true
  }
];

const CUSTOM_LINTER_RULE_IDS = new Set(CUSTOM_LINTER_RULE_SETTINGS.map((rule) => rule.id));

function buildFeatureSettings(): FeatureSettings {
  const features = {} as FeatureSettings;
  for (const registration of FEATURE_REGISTRATIONS) {
    features[registration.setting.key] = registration.setting.defaultEnabled;
  }
  return features;
}

function buildFeatureMeta(): Record<FeatureSettingKey, FeatureSettingMeta> {
  const meta = {} as Record<FeatureSettingKey, FeatureSettingMeta>;
  for (const registration of FEATURE_REGISTRATIONS) {
    meta[registration.setting.key] = {
      label: registration.setting.label,
      description: registration.setting.description
    };
  }
  return meta;
}

export const DEFAULT_FEATURE_SETTINGS: FeatureSettings = buildFeatureSettings();

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  features: DEFAULT_FEATURE_SETTINGS,
  highlightedWordsEnabled: true,
  highlightedWords: normalizeHighlightedWords(DEFAULT_HIGHLIGHTED_WORDS),
  customLinterDefaultsVersion: CUSTOM_LINTER_DEFAULTS_VERSION,
  disabledCustomLinterRuleIds: [...DEFAULT_DISABLED_CUSTOM_LINTER_RULE_IDS],
  ghostCursor: { ...DEFAULT_GHOST_CURSOR_SETTINGS },
  websiteAppearance: cloneWebsiteAppearanceSettings(DEFAULT_WEBSITE_APPEARANCE_SETTINGS)
};

export const FEATURE_KEYS: FeatureSettingKey[] = FEATURE_REGISTRATIONS.map(
  (registration) => registration.setting.key
);

export const FEATURE_META: Record<FeatureSettingKey, FeatureSettingMeta> = buildFeatureMeta();

function normalizeDisabledCustomLinterRuleIds(source: unknown): string[] {
  if (!Array.isArray(source)) {
    return [];
  }

  const disabledRuleIds: string[] = [];
  const seen = new Set<string>();
  for (const value of source) {
    if (typeof value !== 'string' || !CUSTOM_LINTER_RULE_IDS.has(value) || seen.has(value)) {
      continue;
    }

    seen.add(value);
    disabledRuleIds.push(value);
  }

  return disabledRuleIds;
}

const SAFE_HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const GHOST_CURSOR_MOTIONS: Record<GhostCursorMotion, true> = {
  slow: true,
  balanced: true,
  snappy: true
};

function normalizeHexColor(source: unknown, fallback: string): string {
  return typeof source === 'string' && SAFE_HEX_COLOR.test(source) ? source.toLowerCase() : fallback;
}

export function normalizeGhostCursorSettings(source: unknown): GhostCursorSettings {
  const incoming =
    source && typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {};
  const thickness =
    typeof incoming.thickness === 'number' && Number.isFinite(incoming.thickness)
      ? Math.round(Math.min(8, Math.max(1, incoming.thickness)))
      : DEFAULT_GHOST_CURSOR_SETTINGS.thickness;

  return {
    color: normalizeHexColor(incoming.color, DEFAULT_GHOST_CURSOR_SETTINGS.color),
    gradientColor: normalizeHexColor(
      incoming.gradientColor,
      DEFAULT_GHOST_CURSOR_SETTINGS.gradientColor
    ),
    gradientEnabled:
      typeof incoming.gradientEnabled === 'boolean'
        ? incoming.gradientEnabled
        : DEFAULT_GHOST_CURSOR_SETTINGS.gradientEnabled,
    thickness,
    motion:
      typeof incoming.motion === 'string' &&
      Object.prototype.hasOwnProperty.call(GHOST_CURSOR_MOTIONS, incoming.motion)
        ? (incoming.motion as GhostCursorMotion)
        : DEFAULT_GHOST_CURSOR_SETTINGS.motion
  };
}

/**
 * Keys that only ever existed in the pre-palette schema. Their presence marks a
 * stored record as legacy; none of them are ever written back.
 */
const WEBSITE_APPEARANCE_LEGACY_KEYS = [
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
] as const;
const WEBSITE_GRADIENT_SPEEDS: Record<WebsiteGradientSpeed, true> = {
  slow: true,
  balanced: true,
  fast: true
};
const WEBSITE_TEXT_SIZE_MIN_PX = 10;
const WEBSITE_TEXT_SIZE_MAX_PX = 30;
export const WEBSITE_CUSTOM_CSS_MAX_LENGTH = 50_000;
const BLOCKED_CSS_URL_FUNCTIONS = new Map([
  ['url', 'url'],
  ['src', 'src'],
  ['image', 'image'],
  ['image-set', 'image-set'],
  ['-webkit-image-set', 'image-set']
]);

function normalizeSteppedNumber(
  source: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  step: number
): number {
  if (typeof source !== 'number' || !Number.isFinite(source)) {
    return fallback;
  }

  return Math.round(Math.min(maximum, Math.max(minimum, source)) / step) * step;
}

function normalizeWebsiteTextSizePx(source: unknown, fallback: number): number {
  if (typeof source !== 'number' || !Number.isFinite(source)) {
    return fallback;
  }

  return Math.round(
    Math.min(WEBSITE_TEXT_SIZE_MAX_PX, Math.max(WEBSITE_TEXT_SIZE_MIN_PX, source))
  );
}

function normalizeWebsiteTextSize(incoming: Record<string, unknown>): number {
  const fallback = DEFAULT_WEBSITE_APPEARANCE_SETTINGS.textSizePx;

  if (Object.prototype.hasOwnProperty.call(incoming, 'textSizePx')) {
    return normalizeWebsiteTextSizePx(incoming.textSizePx, fallback);
  }

  // Legacy records stored a percentage of the original 15px editor base.
  if (typeof incoming.textSizePercent === 'number') {
    return normalizeWebsiteTextSizePx((15 * incoming.textSizePercent) / 100, fallback);
  }

  return fallback;
}

function isLegacyWebsiteAppearanceRecord(incoming: Record<string, unknown>): boolean {
  for (const key of WEBSITE_APPEARANCE_LEGACY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) {
      return true;
    }
  }

  return false;
}

type WebsiteAppearancePaletteKey =
  | 'pageColor'
  | 'surfaceColor'
  | 'textColor'
  | 'mutedTextColor'
  | 'accentColor'
  | 'accentTextColor'
  | 'borderColor'
  | 'activeRowColor'
  | 'activeRowTextColor'
  | 'waveColor'
  | 'dangerColor'
  | 'warningColor'
  | 'successColor';

const WEBSITE_APPEARANCE_PALETTE_KEYS = [
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
] as const satisfies readonly WebsiteAppearancePaletteKey[];

/**
 * The only pre-palette colors that survive migration: each maps one-to-one onto
 * a palette entry. Every other palette entry resets to its new default rather
 * than guessing an equivalent out of the retired nine-group model.
 */
const WEBSITE_APPEARANCE_LEGACY_PALETTE_SOURCES: Partial<
  Record<WebsiteAppearancePaletteKey, readonly string[]>
> = {
  pageColor: ['pageBackgroundColor'],
  surfaceColor: ['surfaceColor'],
  textColor: ['textColor'],
  mutedTextColor: ['mutedTextColor'],
  borderColor: ['borderColor'],
  accentColor: ['primaryColor', 'accentColor'],
  accentTextColor: ['primaryTextColor']
};

function readWebsiteAppearancePalette(
  incoming: Record<string, unknown>,
  legacy: boolean
): Pick<WebsiteAppearanceSettings, WebsiteAppearancePaletteKey> {
  const defaults = DEFAULT_WEBSITE_APPEARANCE_SETTINGS;
  const palette = {} as Pick<WebsiteAppearanceSettings, WebsiteAppearancePaletteKey>;

  for (const key of WEBSITE_APPEARANCE_PALETTE_KEYS) {
    if (!legacy) {
      palette[key] = normalizeHexColor(incoming[key], defaults[key]);
      continue;
    }

    let value = defaults[key];
    for (const source of WEBSITE_APPEARANCE_LEGACY_PALETTE_SOURCES[key] ?? []) {
      value = normalizeHexColor(incoming[source], value);
    }

    palette[key] = value;
  }

  return palette;
}

function normalizeWebsiteAppearanceSpeakerColors(
  source: unknown,
  legacy: boolean
): WebsiteAppearanceSpeakerColors {
  const defaults = DEFAULT_WEBSITE_APPEARANCE_SETTINGS.speakerColors;
  // Retired lane tuples carried seven dials each and have no one-to-one mapping.
  const incoming = !legacy && Array.isArray(source) ? source : [];
  return defaults.map((fallback, index) =>
    normalizeHexColor(incoming[index], fallback)
  ) as WebsiteAppearanceSpeakerColors;
}

/** Deep copy so callers can never share the mutable gradient or speaker containers. */
function cloneWebsiteAppearanceSettings(
  settings: WebsiteAppearanceSettings
): WebsiteAppearanceSettings {
  return {
    ...settings,
    gradientColors: [...settings.gradientColors],
    speakerColors: [...settings.speakerColors]
  };
}

export function normalizeWebsiteAppearanceSettings(source: unknown): WebsiteAppearanceSettings {
  const incoming =
    source && typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {};
  const defaults = DEFAULT_WEBSITE_APPEARANCE_SETTINGS;
  const legacy = isLegacyWebsiteAppearanceRecord(incoming);
  const incomingColors = Array.isArray(incoming.gradientColors) ? incoming.gradientColors : [];
  const gradientColors = defaults.gradientColors.map((fallback, index) =>
    normalizeHexColor(incomingColors[index], fallback)
  ) as [string, string, string];

  return {
    enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : defaults.enabled,
    // A legacy record only survives as text theming: every color group stays off.
    textEnabled: legacy ? true : incoming.textEnabled === true,
    textSizePx: normalizeWebsiteTextSize(incoming),
    tableTextSizePx: normalizeWebsiteTextSizePx(
      incoming.tableTextSizePx,
      defaults.tableTextSizePx
    ),
    themeEnabled: legacy ? false : incoming.themeEnabled === true,
    ...readWebsiteAppearancePalette(incoming, legacy),
    speakerColors: normalizeWebsiteAppearanceSpeakerColors(incoming.speakerColors, legacy),
    gradientEnabled: legacy ? false : incoming.gradientEnabled === true,
    gradientColors,
    gradientAngle: normalizeSteppedNumber(incoming.gradientAngle, defaults.gradientAngle, 0, 360, 15),
    gradientSpeed:
      typeof incoming.gradientSpeed === 'string' &&
      Object.prototype.hasOwnProperty.call(WEBSITE_GRADIENT_SPEEDS, incoming.gradientSpeed)
        ? (incoming.gradientSpeed as WebsiteGradientSpeed)
        : defaults.gradientSpeed,
    customCssEnabled: legacy ? false : incoming.customCssEnabled === true,
    customCss:
      typeof incoming.customCss === 'string'
        ? incoming.customCss.slice(0, WEBSITE_CUSTOM_CSS_MAX_LENGTH)
        : defaults.customCss
  };
}

function isCssWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\t' ||
    character === '\n' ||
    character === '\r' ||
    character === '\f'
  );
}

function isCssHexDigit(character: string): boolean {
  return (
    (character >= '0' && character <= '9') ||
    (character >= 'a' && character <= 'f') ||
    (character >= 'A' && character <= 'F')
  );
}

function isCssNameCharacter(character: string): boolean {
  if (!character) {
    return false;
  }

  const codePoint = character.charCodeAt(0);
  return (
    (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    (character >= '0' && character <= '9') ||
    character === '-' ||
    character === '_' ||
    codePoint >= 0x80
  );
}

function readCssIdentifier(
  source: string,
  start: number
): { identifier: string; nextIndex: number; danglingEscape: boolean } {
  let identifier = '';
  let index = start;
  let danglingEscape = false;

  while (index < source.length) {
    const character = source[index];
    if (isCssNameCharacter(character)) {
      identifier += character.toLowerCase();
      index += 1;
      continue;
    }

    if (character !== '\\') {
      break;
    }
    if (index + 1 >= source.length) {
      index += 1;
      danglingEscape = true;
      break;
    }

    index += 1;
    if (isCssHexDigit(source[index])) {
      const hexStart = index;
      let hexLength = 0;
      while (index < source.length && hexLength < 6 && isCssHexDigit(source[index])) {
        index += 1;
        hexLength += 1;
      }
      const codePoint = Number.parseInt(source.slice(hexStart, index), 16);
      if (codePoint > 0 && codePoint <= 0x7f) {
        identifier += String.fromCodePoint(codePoint).toLowerCase();
      } else {
        identifier += '\ufffd';
      }
      if (index < source.length && isCssWhitespace(source[index])) {
        index += 1;
      }
      continue;
    }

    identifier += source[index].toLowerCase();
    index += 1;
  }

  return { identifier, nextIndex: index, danglingEscape };
}

function startsStyleTag(source: string, start: number): boolean {
  let index = start + 1;
  if (source[index] === '/') {
    index += 1;
  }

  if (source.slice(index, index + 5).toLowerCase() !== 'style') {
    return false;
  }

  const boundary = source[index + 5];
  return !boundary || boundary === '>' || boundary === '/' || isCssWhitespace(boundary);
}

export function validateWebsiteCustomCss(
  source: unknown
): { valid: boolean; message: string } {
  if (typeof source !== 'string') {
    return { valid: false, message: 'Custom CSS must be text.' };
  }
  if (source.length > WEBSITE_CUSTOM_CSS_MAX_LENGTH) {
    return {
      valid: false,
      message: `Custom CSS must be ${WEBSITE_CUSTOM_CSS_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`
    };
  }

  const expectedClosers: string[] = [];
  const matchingCloser: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (character === '/' && nextCharacter === '*') {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        index += 1;
      }
      if (index >= source.length) {
        return { valid: false, message: 'Custom CSS contains an unclosed comment.' };
      }
      index += 1;
      continue;
    }
    if (character === '*' && nextCharacter === '/' && source[index + 2] !== '*') {
      return { valid: false, message: 'Custom CSS contains an unmatched comment closer.' };
    }

    if (character === '"' || character === "'") {
      const quote = character;
      let closed = false;
      while (index + 1 < source.length) {
        index += 1;
        if (source[index] === '\\') {
          index += 1;
          if (source[index] === '\r' && source[index + 1] === '\n') {
            index += 1;
          }
          continue;
        }
        if (
          source[index] === '\n' ||
          source[index] === '\r' ||
          source[index] === '\f'
        ) {
          return {
            valid: false,
            message: 'Custom CSS contains an unescaped line break in a string.'
          };
        }
        if (source[index] === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        return { valid: false, message: 'Custom CSS contains an unclosed string.' };
      }
      continue;
    }

    if (character === '<' && startsStyleTag(source, index)) {
      return { valid: false, message: 'Style tags are not allowed in custom CSS.' };
    }

    if (character === '@') {
      const atRule = readCssIdentifier(source, index + 1);
      if (atRule.danglingEscape) {
        return { valid: false, message: 'Custom CSS contains an incomplete escape.' };
      }
      if (atRule.identifier === 'import') {
        return { valid: false, message: '@import is not allowed in custom CSS.' };
      }
      index = atRule.nextIndex - 1;
      continue;
    }

    if (isCssNameCharacter(character) || character === '\\') {
      const token = readCssIdentifier(source, index);
      if (token.danglingEscape) {
        return { valid: false, message: 'Custom CSS contains an incomplete escape.' };
      }
      let nextIndex = token.nextIndex;
      while (nextIndex < source.length && isCssWhitespace(source[nextIndex])) {
        nextIndex += 1;
      }
      const blockedFunction = BLOCKED_CSS_URL_FUNCTIONS.get(token.identifier);
      if (blockedFunction && source[nextIndex] === '(') {
        return { valid: false, message: `${blockedFunction}() is not allowed in custom CSS.` };
      }
      index = token.nextIndex - 1;
      continue;
    }

    if (matchingCloser[character]) {
      expectedClosers.push(matchingCloser[character]);
      continue;
    }
    if (character === '}' || character === ']' || character === ')') {
      if (expectedClosers.pop() !== character) {
        return { valid: false, message: 'Custom CSS contains unbalanced delimiters.' };
      }
    }
  }

  if (expectedClosers.length > 0) {
    return { valid: false, message: 'Custom CSS contains unbalanced delimiters.' };
  }
  return { valid: true, message: 'Custom CSS is valid.' };
}

const GHOST_CURSOR_SHARE_PREFIX = 'gc1.';

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeGhostCursorSettingsShare(settings: GhostCursorSettings): string {
  const normalized = normalizeGhostCursorSettings(settings);
  return (
    GHOST_CURSOR_SHARE_PREFIX +
    encodeBase64Url(
      JSON.stringify({
        c: normalized.color,
        g: normalized.gradientColor,
        e: normalized.gradientEnabled,
        w: normalized.thickness,
        m: normalized.motion
      })
    )
  );
}

export function decodeGhostCursorSettingsShare(value: unknown): GhostCursorSettings | null {
  if (typeof value !== 'string' || !value.startsWith(GHOST_CURSOR_SHARE_PREFIX)) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(value.slice(GHOST_CURSOR_SHARE_PREFIX.length)));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const source = payload as Record<string, unknown>;
    return normalizeGhostCursorSettings({
      color: source.c,
      gradientColor: source.g,
      gradientEnabled: source.e,
      thickness: source.w,
      motion: source.m
    });
  } catch {
    return null;
  }
}

export const WEBSITE_APPEARANCE_SHARE_PREFIX = 'wa1.';

export function encodeWebsiteAppearanceShare(settings: WebsiteAppearanceSettings): string {
  return (
    WEBSITE_APPEARANCE_SHARE_PREFIX +
    encodeBase64Url(JSON.stringify(normalizeWebsiteAppearanceSettings(settings)))
  );
}

export function decodeWebsiteAppearanceShare(value: unknown): WebsiteAppearanceSettings | null {
  if (typeof value !== 'string' || !value.startsWith(WEBSITE_APPEARANCE_SHARE_PREFIX)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      decodeBase64Url(value.slice(WEBSITE_APPEARANCE_SHARE_PREFIX.length))
    );
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    return normalizeWebsiteAppearanceSettings(payload);
  } catch {
    return null;
  }
}

type ExtensionStorageArea = {
  get?: (key: string, callback: (items: Record<string, unknown> | undefined) => void) => void;
  set?: (items: Record<string, unknown>, callback: () => void) => void;
};

type ChromeGlobalScope = {
  chrome?: {
    storage?: { local?: ExtensionStorageArea };
    runtime?: { lastError?: { message?: string } };
  };
};

const STORAGE_UNAVAILABLE_MESSAGE = 'Extension storage is unavailable.';
const LOAD_FAILURE_MESSAGE = 'Could not load settings.';
const SAVE_FAILURE_MESSAGE = 'Could not save settings.';

function getExtensionStorage(): ExtensionStorageArea | null {
  const chromeApi = (globalThis as ChromeGlobalScope).chrome;
  return chromeApi?.storage?.local ?? null;
}

export function normalizeExtensionSettings(source: unknown): ExtensionSettings {
  const incoming =
    source && typeof source === 'object' && source !== null ? (source as Record<string, unknown>) : {};
  const rawFeatures =
    incoming.features && typeof incoming.features === 'object'
      ? (incoming.features as Record<string, unknown>)
      : {};
  const rawGhostCursor =
    incoming.ghostCursor && typeof incoming.ghostCursor === 'object'
      ? incoming.ghostCursor
      : {};
  const rawWebsiteAppearance =
    incoming.websiteAppearance && typeof incoming.websiteAppearance === 'object'
      ? incoming.websiteAppearance
      : {};
  const features = {} as FeatureSettings;
  for (const key of FEATURE_KEYS) {
    const value = rawFeatures[key];
    features[key] = typeof value === 'boolean' ? value : DEFAULT_FEATURE_SETTINGS[key];
  }

  const incomingCustomLinterDefaultsVersion =
    typeof incoming.customLinterDefaultsVersion === 'number' &&
    Number.isInteger(incoming.customLinterDefaultsVersion)
      ? incoming.customLinterDefaultsVersion
      : 0;
  const disabledCustomLinterRuleIds = normalizeDisabledCustomLinterRuleIds(
    incoming.disabledCustomLinterRuleIds
  );
  if (incomingCustomLinterDefaultsVersion < CUSTOM_LINTER_DEFAULTS_VERSION) {
    const disabledRuleIds = new Set(disabledCustomLinterRuleIds);
    for (const ruleId of DEFAULT_DISABLED_CUSTOM_LINTER_RULE_IDS) {
      if (disabledRuleIds.has(ruleId)) {
        continue;
      }

      disabledRuleIds.add(ruleId);
      disabledCustomLinterRuleIds.push(ruleId);
    }
  }

  return {
    features,
    highlightedWordsEnabled:
      typeof incoming.highlightedWordsEnabled === 'boolean'
        ? incoming.highlightedWordsEnabled
        : DEFAULT_EXTENSION_SETTINGS.highlightedWordsEnabled,
    highlightedWords: normalizeHighlightedWords(incoming.highlightedWords),
    customLinterDefaultsVersion: CUSTOM_LINTER_DEFAULTS_VERSION,
    disabledCustomLinterRuleIds,
    ghostCursor: normalizeGhostCursorSettings(rawGhostCursor),
    websiteAppearance: normalizeWebsiteAppearanceSettings(rawWebsiteAppearance)
  };
}

export interface LoadSettingsResult {
  loaded: boolean;
  settings: ExtensionSettings;
  error?: string;
}

export async function loadExtensionSettings(): Promise<LoadSettingsResult> {
  const storage = getExtensionStorage();
  const read = storage?.get;
  if (!storage || typeof read !== 'function') {
    return {
      loaded: false,
      settings: normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS),
      error: STORAGE_UNAVAILABLE_MESSAGE
    };
  }

  return new Promise<LoadSettingsResult>((resolve) => {
    try {
      read.call(storage, SETTINGS_STORAGE_KEY, (items) => {
        const chromeApi = (globalThis as ChromeGlobalScope).chrome;
        const lastError = chromeApi?.runtime?.lastError;
        if (lastError) {
          resolve({
            loaded: false,
            settings: normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS),
            error: lastError.message || LOAD_FAILURE_MESSAGE
          });
          return;
        }

        resolve({
          loaded: true,
          settings: normalizeExtensionSettings(items?.[SETTINGS_STORAGE_KEY])
        });
      });
    } catch (error) {
      resolve({
        loaded: false,
        settings: normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS),
        error: (error instanceof Error && error.message) || LOAD_FAILURE_MESSAGE
      });
    }
  });
}

export async function saveExtensionSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const normalized = normalizeExtensionSettings(settings);
  const storage = getExtensionStorage();
  const write = storage?.set;
  if (!storage || typeof write !== 'function') {
    return normalized;
  }

  const failureDetail = await new Promise<string | null>((resolve) => {
    try {
      write.call(storage, { [SETTINGS_STORAGE_KEY]: normalized }, () => {
        const chromeApi = (globalThis as ChromeGlobalScope).chrome;
        const lastError = chromeApi?.runtime?.lastError;
        resolve(lastError ? lastError.message ?? '' : null);
      });
    } catch (error) {
      resolve(error instanceof Error ? error.message : '');
    }
  });
  if (failureDetail === null) {
    return normalized;
  }

  throw new Error(
    failureDetail ? `Could not save settings: ${failureDetail}` : SAVE_FAILURE_MESSAGE
  );
}
