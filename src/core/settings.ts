export type FeatureSettingKey =
  | 'hotkeysHelp'
  | 'rowActions'
  | 'speakerWorkflowHotkeys'
  | 'textMove'
  | 'quickRegionAutocomplete'
  | 'disableNativeArrowSeek'
  | 'focusToggle'
  | 'timelineSelection'
  | 'timelineZoomDefaults'
  | 'magnifier'
  | 'customLinter'
  | 'proportionalCursorRestore';

export interface FeatureSettings {
  hotkeysHelp: boolean;
  rowActions: boolean;
  speakerWorkflowHotkeys: boolean;
  textMove: boolean;
  quickRegionAutocomplete: boolean;
  disableNativeArrowSeek: boolean;
  focusToggle: boolean;
  timelineSelection: boolean;
  timelineZoomDefaults: boolean;
  magnifier: boolean;
  customLinter: boolean;
  proportionalCursorRestore: boolean;
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
  speakerWorkflowHotkeys: true,
  textMove: true,
  quickRegionAutocomplete: true,
  disableNativeArrowSeek: true,
  focusToggle: true,
  timelineSelection: true,
  timelineZoomDefaults: true,
  magnifier: true,
  customLinter: true,
  proportionalCursorRestore: true
};

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  features: DEFAULT_FEATURE_SETTINGS
};

export const FEATURE_KEYS: FeatureSettingKey[] = [
  'hotkeysHelp',
  'rowActions',
  'speakerWorkflowHotkeys',
  'textMove',
  'quickRegionAutocomplete',
  'disableNativeArrowSeek',
  'focusToggle',
  'timelineSelection',
  'timelineZoomDefaults',
  'magnifier',
  'customLinter',
  'proportionalCursorRestore'
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
  speakerWorkflowHotkeys: {
    label: 'Speaker Workflow Hotkeys',
    description: 'Enable Alt + 1/2 speaker switch and Alt + ~ reset workflow shortcuts.'
  },
  textMove: {
    label: 'Text Move',
    description: 'Enable Alt + [ and Alt + ] to move text between adjacent segments.'
  },
  quickRegionAutocomplete: {
    label: 'Quick Region Autocomplete',
    description: 'Reuse Babel tag autocomplete in quick region and row editors, including selected-text style tag wrapping.'
  },
  disableNativeArrowSeek: {
    label: 'Disable Native Arrow Seek',
    description: 'Block Babel’s bare Left/Right Arrow segment-jump hotkeys while keeping normal caret movement.'
  },
  focusToggle: {
    label: 'Focus Toggle',
    description: 'Enable Esc to pause and blur the active transcript textarea, then resume and restore it.'
  },
  timelineSelection: {
    label: 'Timeline Selection',
    description: 'Enable Alt + Drag cut preview and S/Shift + S/L timeline actions.'
  },
  timelineZoomDefaults: {
    label: 'Timeline Zoom Defaults',
    description: 'Remember last timeline zoom and apply it when a transcription session starts.'
  },
  magnifier: {
    label: 'Magnifier',
    description: 'Show live waveform magnifier while dragging timeline segment edges.'
  },
  customLinter: {
    label: 'Custom Linter',
    description: 'Inject helper rules into Babel lintAnnotations results so issues appear in native linter UI.'
  },
  proportionalCursorRestore: {
    label: 'Proportional Cursor Restore',
    description: 'When restoring focus after Esc, place cursor at the text position proportional to playback progress within the segment.'
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
