import type { FeatureSettings } from './settings';
import { DEFAULT_FEATURE_SETTINGS } from './settings';

const PLAYBACK_REWIND_SHORTCUTS = [
  { code: 'KeyX', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, seconds: 1, label: 'Alt + X' }
];

function buildHotkeysHelpRows(featureSettings: FeatureSettings): Array<[string, string]> {
  const rows: Array<[string, string]> = [];

  if (featureSettings.focusToggle) {
    rows.push(['Esc', 'Pause and blur / resume and restore cursor' +
      (featureSettings.proportionalCursorRestore ? ' (proportional to playback position)' : '')]);
  }

  if (featureSettings.textMove) {
    rows.push(['Alt + [ (РҐ)', 'Move text before caret to previous segment']);
    rows.push(['Alt + ] (РЄ)', 'Move text after caret to next segment']);
  }

  if (featureSettings.rowActions && featureSettings.speakerWorkflowHotkeys) {
    rows.push(['Alt + 1 / Alt + 2', 'Switch active speaker workflow lane']);
    rows.push(['Alt + ~', 'Reset lanes: show both, unmute both, select All Tracks']);
  }

  if (featureSettings.selectedNumberToSkaz) {
    rows.push(['Alt + A / Ctrl + Alt + A', 'Auto-convert selection into `digits {СКАЗ: words}`']);
  }

  if (featureSettings.rowActions) {
    for (const shortcut of PLAYBACK_REWIND_SHORTCUTS) {
      const milliseconds = Math.round(shortcut.seconds * 1000);
      rows.push([shortcut.label, 'Rewind playback ' + milliseconds + 'ms']);
    }
    rows.push(['Alt + Shift + Up', 'Merge with previous segment']);
    rows.push(['Alt + Shift + Down', 'Merge with next segment']);
    rows.push(['Del', 'Delete current segment']);
    rows.push(['D', 'Delete current segment when not typing']);
  }

  if (featureSettings.customLinter) {
    rows.push(['Alt + F', 'Auto-fix lint issues in current row']);
    rows.push(['Alt + Shift + F', 'Auto-fix lint issues in all rows']);
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
