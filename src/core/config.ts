import type { FeatureSettings } from './settings';
import { DEFAULT_FEATURE_SETTINGS } from './settings';
import { getRegisteredHotkeysHelpRows, PLAYBACK_REWIND_SHORTCUTS } from '../features/registry';
import { BABEL_ROW_ACTION_LABELS, BABEL_ROW_TEXTAREA_SELECTOR } from './babel-editor-contract';

function buildHotkeysHelpRows(featureSettings: FeatureSettings): Array<[string, string]> {
  return getRegisteredHotkeysHelpRows(featureSettings);
}

export function createConfig(featureSettings: FeatureSettings = DEFAULT_FEATURE_SETTINGS) {
  return {
    features: {
      ...featureSettings
    },
    rowTextareaSelector: BABEL_ROW_TEXTAREA_SELECTOR,
    actionTriggerSelector: 'button[aria-haspopup="menu"]',
    hotkeysHelpMarker: 'data-babel-helper-hotkeys',
    hotkeysDialogPatterns: [
      /\bkeyboard shortcuts\b/i,
      /\buse these shortcuts to navigate and control the transcription workbench\b/i,
      /\bhotkeys\b/i
    ],
    hotkeysHelpRows: buildHotkeysHelpRows(featureSettings),
    playbackRewindShortcuts: PLAYBACK_REWIND_SHORTCUTS.map((shortcut) => ({
      ...shortcut
    })),
    actionLabels: {
      ...BABEL_ROW_ACTION_LABELS
    }
  };
}
