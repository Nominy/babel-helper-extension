import type { FeatureSettings } from './settings';
import { DEFAULT_FEATURE_SETTINGS } from './settings';
import { getRegisteredHotkeysHelpRows, PLAYBACK_REWIND_SHORTCUTS } from '../features/registry';

function buildHotkeysHelpRows(featureSettings: FeatureSettings): Array<[string, string]> {
  return getRegisteredHotkeysHelpRows(featureSettings);
}

export function createConfig(featureSettings: FeatureSettings = DEFAULT_FEATURE_SETTINGS) {
  return {
    features: {
      ...featureSettings
    },
    rowTextareaSelector: 'textarea[placeholder^="What was said"]',
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
    actionPatterns: {
      deleteSegment: [/\bdelete(?:\s+segment)?\b/i, /\bremove(?:\s+segment)?\b/i],
      mergePrevious: [
        /\bmerge\b.*\b(previous|prev|above|before|up)\b/i,
        /\b(previous|prev|above|before|up)\b.*\b(merge|combine|join)\b/i,
        /\b(combine|join)\b.*\b(previous|prev|above|before|up)\b/i
      ],
      mergeNext: [
        /\bmerge\b.*\b(next|below|after|following|down)\b/i,
        /\b(next|below|after|following|down)\b.*\b(merge|combine|join)\b/i,
        /\b(combine|join)\b.*\b(next|below|after|following|down)\b/i
      ],
      mergeFallback: [/\bmerge\b/i, /\bcombine\b/i, /\bjoin\b/i]
    }
  };
}
