import type { FeatureSettings } from './settings';
import { DEFAULT_FEATURE_SETTINGS } from './settings';

function buildHotkeysHelpRows(featureSettings: FeatureSettings): Array<[string, string]> {
  const rows: Array<[string, string]> = [];

  if (featureSettings.focusToggle) {
    rows.push(['Esc', 'Toggle blur and restore cursor']);
  }

  if (featureSettings.textMove) {
    rows.push(['Alt + [ (РҐ)', 'Move text before caret to previous segment']);
    rows.push(['Alt + ] (РЄ)', 'Move text after caret to next segment']);
  }

  if (featureSettings.rowActions) {
    rows.push(['Alt + Shift + Up', 'Merge with previous segment']);
    rows.push(['Alt + Shift + Down', 'Merge with next segment']);
    rows.push(['Del', 'Delete current segment']);
    rows.push(['D', 'Delete current segment when not typing']);
  }

  return rows;
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
