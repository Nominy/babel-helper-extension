import { FEATURE_REGISTRATIONS } from '../features/registry';
import { DEFAULT_HIGHLIGHTED_WORDS, normalizeHighlightedWords } from './highlighted-words';

export type FeatureSettingKey = (typeof FEATURE_REGISTRATIONS)[number]['setting']['key'];
export type FeatureSettings = Record<FeatureSettingKey, boolean>;

export interface ExtensionSettings {
  features: FeatureSettings;
  highlightedWordsEnabled: boolean;
  highlightedWords: string[];
}

export interface FeatureSettingMeta {
  label: string;
  description: string;
}

export const SETTINGS_STORAGE_KEY = 'settings';

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
  highlightedWords: normalizeHighlightedWords(DEFAULT_HIGHLIGHTED_WORDS)
};

export const FEATURE_KEYS: FeatureSettingKey[] = FEATURE_REGISTRATIONS.map(
  (registration) => registration.setting.key
);

export const FEATURE_META: Record<FeatureSettingKey, FeatureSettingMeta> = buildFeatureMeta();

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

  const features = {} as FeatureSettings;
  for (const key of FEATURE_KEYS) {
    const value = rawFeatures[key];
    features[key] = typeof value === 'boolean' ? value : DEFAULT_FEATURE_SETTINGS[key];
  }

  return {
    features,
    highlightedWordsEnabled:
      typeof incoming.highlightedWordsEnabled === 'boolean'
        ? incoming.highlightedWordsEnabled
        : DEFAULT_EXTENSION_SETTINGS.highlightedWordsEnabled,
    highlightedWords: normalizeHighlightedWords(incoming.highlightedWords)
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
