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

export interface ExtensionSettings {
  features: FeatureSettings;
  highlightedWordsEnabled: boolean;
  highlightedWords: string[];
  customLinterDefaultsVersion: number;
  disabledCustomLinterRuleIds: string[];
  ghostCursor: GhostCursorSettings;
}

export const DEFAULT_GHOST_CURSOR_SETTINGS: GhostCursorSettings = {
  color: '#f59e0b',
  gradientColor: '#fb7185',
  gradientEnabled: false,
  thickness: 2,
  motion: 'slow'
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
  ghostCursor: { ...DEFAULT_GHOST_CURSOR_SETTINGS }
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
const GHOST_CURSOR_MOTIONS = new Set<GhostCursorMotion>(['slow', 'balanced', 'snappy']);

function normalizeGhostCursorColor(source: unknown, fallback: string): string {
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
    color: normalizeGhostCursorColor(incoming.color, DEFAULT_GHOST_CURSOR_SETTINGS.color),
    gradientColor: normalizeGhostCursorColor(
      incoming.gradientColor,
      DEFAULT_GHOST_CURSOR_SETTINGS.gradientColor
    ),
    gradientEnabled:
      typeof incoming.gradientEnabled === 'boolean'
        ? incoming.gradientEnabled
        : DEFAULT_GHOST_CURSOR_SETTINGS.gradientEnabled,
    thickness,
    motion: GHOST_CURSOR_MOTIONS.has(incoming.motion as GhostCursorMotion)
      ? (incoming.motion as GhostCursorMotion)
      : DEFAULT_GHOST_CURSOR_SETTINGS.motion
  };
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

function getExtensionStorage() {
  const chromeApi = (globalThis as { chrome?: any }).chrome;
  if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) {
    return null;
  }

  return chromeApi.storage.local;
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
    ghostCursor: normalizeGhostCursorSettings(rawGhostCursor)
  };
}

export async function loadExtensionSettings(): Promise<ExtensionSettings> {
  const storage = getExtensionStorage();
  if (!storage || typeof storage.get !== 'function') {
    return normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS);
  }

  return new Promise((resolve) => {
    try {
      storage.get(SETTINGS_STORAGE_KEY, (items: Record<string, unknown> | undefined) => {
        const runtime = (globalThis as { chrome?: any }).chrome;
        if (runtime?.runtime?.lastError) {
          resolve(normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS));
          return;
        }

        resolve(normalizeExtensionSettings(items?.[SETTINGS_STORAGE_KEY]));
      });
    } catch (_error) {
      resolve(normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS));
    }
  });
}

export async function saveExtensionSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const normalized = normalizeExtensionSettings(settings);
  const storage = getExtensionStorage();
  if (!storage || typeof storage.set !== 'function') {
    return normalized;
  }

  return new Promise((resolve) => {
    try {
      storage.set({ [SETTINGS_STORAGE_KEY]: normalized }, () => {
        const runtime = (globalThis as { chrome?: any }).chrome;
        if (runtime?.runtime?.lastError) {
          resolve(normalized);
          return;
        }

        resolve(normalized);
      });
    } catch (_error) {
      resolve(normalized);
    }
  });
}
