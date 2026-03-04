export type FeatureSettingKey =
  | 'hotkeysHelp'
  | 'rowActions'
  | 'textMove'
  | 'focusToggle'
  | 'timelineSelection'
  | 'magnifier';

export interface FeatureSettings {
  hotkeysHelp: boolean;
  rowActions: boolean;
  textMove: boolean;
  focusToggle: boolean;
  timelineSelection: boolean;
  magnifier: boolean;
}

export interface ExtensionSettings {
  features: FeatureSettings;
}

export interface FeatureSettingMeta {
  label: string;
  description: string;
}

export const SETTINGS_STORAGE_KEY = 'settings';

export const DEFAULT_FEATURE_SETTINGS: FeatureSettings = {
  hotkeysHelp: true,
  rowActions: true,
  textMove: true,
  focusToggle: true,
  timelineSelection: true,
  magnifier: true
};

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  features: DEFAULT_FEATURE_SETTINGS
};

export const FEATURE_KEYS: FeatureSettingKey[] = [
  'hotkeysHelp',
  'rowActions',
  'textMove',
  'focusToggle',
  'timelineSelection',
  'magnifier'
];

export const FEATURE_META: Record<FeatureSettingKey, FeatureSettingMeta> = {
  hotkeysHelp: {
    label: 'Hotkeys Help',
    description: 'Enhances the keyboard shortcuts dialog with Babel Helper hints.'
  },
  rowActions: {
    label: 'Row Actions',
    description: 'Enable Delete, D, and Alt + Shift + Arrow merge shortcuts.'
  },
  textMove: {
    label: 'Text Move',
    description: 'Enable Alt + [ and Alt + ] to move text between adjacent segments.'
  },
  focusToggle: {
    label: 'Focus Toggle',
    description: 'Enable Esc to blur and restore the active transcript textarea.'
  },
  timelineSelection: {
    label: 'Timeline Selection',
    description: 'Enable Alt + Drag cut preview and S/Shift + S/L timeline actions.'
  },
  magnifier: {
    label: 'Magnifier',
    description: 'Show live waveform magnifier while dragging timeline segment edges.'
  }
};

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
    features
  };
}

export async function loadExtensionSettings(): Promise<ExtensionSettings> {
  const storage = getExtensionStorage();
  if (!storage || typeof storage.get !== 'function') {
    return normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS);
  }

  return new Promise((resolve) => {
    storage.get(SETTINGS_STORAGE_KEY, (items: Record<string, unknown> | undefined) => {
      const runtime = (globalThis as { chrome?: any }).chrome;
      if (runtime?.runtime?.lastError) {
        resolve(normalizeExtensionSettings(DEFAULT_EXTENSION_SETTINGS));
        return;
      }

      resolve(normalizeExtensionSettings(items?.[SETTINGS_STORAGE_KEY]));
    });
  });
}

export async function saveExtensionSettings(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const normalized = normalizeExtensionSettings(settings);
  const storage = getExtensionStorage();
  if (!storage || typeof storage.set !== 'function') {
    return normalized;
  }

  return new Promise((resolve) => {
    storage.set({ [SETTINGS_STORAGE_KEY]: normalized }, () => {
      resolve(normalized);
    });
  });
}
