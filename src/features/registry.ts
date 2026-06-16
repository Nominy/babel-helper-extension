import type { FeatureModule } from '../core/types';

import { createCustomLinterFeature } from './custom-linter';
import { createFocusToggleFeature } from './focus-toggle-feature';
import { createHotkeysHelpFeature } from './hotkeys-help-feature';
import { createMagnifierFeature } from './magnifier-feature';
import { createMinimapFeature } from './minimap-feature';
import { createQuickRegionAutocompleteFeature } from './quick-region-autocomplete-feature';
import { createRowActionsFeature } from './row-actions-feature';
import { createTextMoveFeature } from './text-move-feature';
import { createTimelineSelectionFeature } from './timeline-selection-feature';
import { createWavesurferTooltipEllipsisFeature } from './wavesurfer-tooltip-ellipsis-feature';

export type HotkeysHelpRow = [shortcut: string, description: string];
export type FeatureSettingsLike = Record<string, boolean | undefined>;
export type HotkeysHelpProvider =
  | HotkeysHelpRow[]
  | ((featureSettings: FeatureSettingsLike) => HotkeysHelpRow[]);

export type FeatureRegistration = {
  id: string;
  setting: {
    key: string;
    defaultEnabled: boolean;
    label: string;
    description: string;
  };
  createModule?: () => FeatureModule;
  moduleOrder?: number;
  hotkeysHelp?: HotkeysHelpProvider;
  hotkeysHelpOrder?: number;
};

export const PLAYBACK_REWIND_SHORTCUTS = [
  { code: 'KeyX', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, seconds: 1, label: 'Alt + X' }
];

function defineFeature<TRegistration extends FeatureRegistration>(registration: TRegistration): TRegistration {
  return registration;
}

export const FEATURE_REGISTRATIONS = [
  defineFeature({
    id: 'hotkeys-help',
    setting: {
      key: 'hotkeysHelp',
      defaultEnabled: true,
      label: 'Hotkeys Help',
      description: 'Enhances the keyboard shortcuts dialog with Babel Helper hints.'
    },
    moduleOrder: 10,
    createModule: createHotkeysHelpFeature
  }),
  defineFeature({
    id: 'row-actions',
    setting: {
      key: 'rowActions',
      defaultEnabled: true,
      label: 'Row Actions',
      description: 'Enable D and Alt + Shift + Arrow merge shortcuts.'
    },
    moduleOrder: 20,
    createModule: createRowActionsFeature,
    hotkeysHelpOrder: 30,
    hotkeysHelp: (featureSettings) => {
      const rows: HotkeysHelpRow[] = [];
      if (featureSettings.speakerWorkflowHotkeys) {
        rows.push(['Alt + 1 / Alt + 2', 'Switch active speaker workflow lane']);
        rows.push(['Alt + ~', 'Reset lanes: show both, unmute both, select All Tracks']);
      }
      for (const shortcut of PLAYBACK_REWIND_SHORTCUTS) {
        const milliseconds = Math.round(shortcut.seconds * 1000);
        rows.push([shortcut.label, 'Rewind playback ' + milliseconds + 'ms']);
      }
      if (featureSettings.playbackSpeedHotkeys) {
        rows.push(['Shift + 1 / Shift + 2', 'Increase / decrease playback speed']);
      }
      rows.push(['Right Shift + Left / Right', 'Focus previous / next segment from start']);
      rows.push(['Tab', 'Toggle active ghost cursor lane']);
      rows.push(['Alt + Shift + Up', 'Merge with previous segment']);
      rows.push(['Alt + Shift + Down', 'Merge with next segment']);
      rows.push(['D', 'Delete current segment when not typing']);
      return rows;
    }
  }),
  defineFeature({
    id: 'playback-speed-hotkeys',
    setting: {
      key: 'playbackSpeedHotkeys',
      defaultEnabled: true,
      label: 'Playback Speed Hotkeys',
      description: 'Enable Shift + 1 / Shift + 2 playback speed shortcuts.'
    }
  }),
  defineFeature({
    id: 'speaker-workflow-hotkeys',
    setting: {
      key: 'speakerWorkflowHotkeys',
      defaultEnabled: true,
      label: 'Speaker Workflow Hotkeys',
      description: 'Enable Alt + 1/2 speaker switch and Alt + ~ reset workflow shortcuts.'
    }
  }),
  defineFeature({
    id: 'selected-number-to-skaz',
    setting: {
      key: 'selectedNumberToSkaz',
      defaultEnabled: true,
      label: 'Selected Number to SKAZ',
      description:
        'Enable immediate digit-to-SKAZ conversion (Select text + type digit) and Alt + A to convert selected digits into `digits {СКАЗ: words}`.'
    },
    hotkeysHelpOrder: 40,
    hotkeysHelp: [
      ['Digit', 'Replace selection with `digit {СКАЗ: original}`'],
      ['Alt + A', 'Auto-convert selected digits into `digits {СКАЗ: words}`']
    ]
  }),
  defineFeature({
    id: 'text-move',
    setting: {
      key: 'textMove',
      defaultEnabled: true,
      label: 'Text Move',
      description: 'Enable Alt + [ and Alt + ] to move text between adjacent segments.'
    },
    moduleOrder: 30,
    createModule: createTextMoveFeature,
    hotkeysHelpOrder: 20,
    hotkeysHelp: [
      ['Alt + [ (Х)', 'Move text before caret to previous segment'],
      ['Alt + ] (Є)', 'Move text after caret to next segment']
    ]
  }),
  defineFeature({
    id: 'quick-region-autocomplete',
    setting: {
      key: 'quickRegionAutocomplete',
      defaultEnabled: true,
      label: 'Quick Region Autocomplete',
      description:
        'Reuse Babel tag autocomplete in quick region and row editors, including selected-text style tag wrapping.'
    },
    moduleOrder: 80,
    createModule: createQuickRegionAutocompleteFeature
  }),
  defineFeature({
    id: 'disable-native-arrow-seek',
    setting: {
      key: 'disableNativeArrowSeek',
      defaultEnabled: true,
      label: 'Disable Native Arrow Seek',
      description: 'Block Babel’s bare Left/Right Arrow segment-jump hotkeys while keeping normal caret movement.'
    }
  }),
  defineFeature({
    id: 'disable-native-timeline-double-click',
    setting: {
      key: 'disableNativeTimelineDoubleClick',
      defaultEnabled: true,
      label: 'Disable Native Timeline Double Click',
      description: 'Block Babel’s native timeline double-click jump to the beginning of a segment.'
    }
  }),
  defineFeature({
    id: 'focus-toggle',
    setting: {
      key: 'focusToggle',
      defaultEnabled: true,
      label: 'Focus Toggle',
      description: 'Enable Esc to pause and blur the active transcript textarea, then resume and restore it.'
    },
    moduleOrder: 40,
    createModule: createFocusToggleFeature,
    hotkeysHelpOrder: 10,
    hotkeysHelp: (featureSettings) => [
      [
        'Esc',
        'Pause and blur / resume and restore cursor' +
          (featureSettings.proportionalCursorRestore ? ' (proportional to playback position)' : '')
      ]
    ]
  }),
  defineFeature({
    id: 'timeline-selection',
    setting: {
      key: 'timelineSelection',
      defaultEnabled: true,
      label: 'Timeline Selection',
      description: 'Enable Alt + Drag cut preview and S/Shift + S/L timeline actions.'
    },
    moduleOrder: 50,
    createModule: createTimelineSelectionFeature
  }),
  defineFeature({
    id: 'audio-trim-outward-pass',
    setting: {
      key: 'audioTrimOutwardPass',
      defaultEnabled: true,
      label: 'Audio Trim Outward Pass',
      description:
        'When Alt + R cannot trim silence inward on a boundary, allow it to extend outward to the next quiet block and then refine inward.'
    }
  }),
  defineFeature({
    id: 'timeline-zoom-defaults',
    setting: {
      key: 'timelineZoomDefaults',
      defaultEnabled: true,
      label: 'Timeline Zoom Defaults',
      description: 'Remember last timeline zoom and apply it when a transcription session starts.'
    }
  }),
  defineFeature({
    id: 'waveform-scale-unlock',
    setting: {
      key: 'waveformScaleUnlock',
      defaultEnabled: true,
      label: 'Waveform Scale Unlock',
      description:
        'Raise Babel’s per-speaker waveform scale ceiling above 20x and keep the higher range patched after React re-renders.'
    }
  }),
  defineFeature({
    id: 'magnifier',
    setting: {
      key: 'magnifier',
      defaultEnabled: true,
      label: 'Magnifier',
      description: 'Show live waveform magnifier while dragging timeline segment edges.'
    },
    moduleOrder: 60,
    createModule: createMagnifierFeature
  }),
  defineFeature({
    id: 'minimap',
    setting: {
      key: 'minimap',
      defaultEnabled: true,
      label: 'Minimap',
      description: 'Show a full-timeline minimap with the current viewing window highlighted.'
    },
    moduleOrder: 70,
    createModule: createMinimapFeature
  }),
  defineFeature({
    id: 'custom-linter',
    setting: {
      key: 'customLinter',
      defaultEnabled: true,
      label: 'Custom Linter',
      description: 'Inject helper rules into Babel lintAnnotations results so issues appear in native linter UI.'
    },
    moduleOrder: 90,
    createModule: createCustomLinterFeature,
    hotkeysHelpOrder: 50,
    hotkeysHelp: [
      ['Alt + F', 'Auto-fix lint issues in current row'],
      ['Alt + Shift + F', 'Auto-fix lint issues in all rows']
    ]
  }),
  defineFeature({
    id: 'proportional-cursor-restore',
    setting: {
      key: 'proportionalCursorRestore',
      defaultEnabled: true,
      label: 'Proportional Cursor Restore',
      description:
        'When restoring focus after Esc, advance cursor to the text position proportional to playback progress (never backward from your last edit position).'
    }
  }),
  defineFeature({
    id: 'wavesurfer-tooltip-ellipsis',
    setting: {
      key: 'wavesurferTooltipEllipsis',
      defaultEnabled: true,
      label: 'Wavesurfer Tooltip Ellipsis',
      description:
        'Truncate long Wavesurfer region tooltip labels with an ellipsis. Edit the template in src/features/wavesurfer-tooltip-ellipsis-feature.ts.'
    },
    moduleOrder: 100,
    createModule: createWavesurferTooltipEllipsisFeature
  }),
  defineFeature({
    id: 'extended-diff-view',
    setting: {
      key: 'extendedDiffView',
      defaultEnabled: true,
      label: 'Extended Diff View',
      description:
        'Extend read-only feedback diff tables in place with extra text, punctuation, tag, segmentation, and timestamp details from Babel diff payloads.'
    }
  })
] as const;

export function getRegisteredFeatureModules(featureSettings: FeatureSettingsLike): FeatureModule[] {
  return (FEATURE_REGISTRATIONS as readonly FeatureRegistration[])
    .filter((registration) => registration.createModule)
    .filter((registration) => Boolean(featureSettings[registration.setting.key]))
    .slice()
    .sort((left, right) => (left.moduleOrder || 0) - (right.moduleOrder || 0))
    .map((registration) => registration.createModule?.())
    .filter((module): module is FeatureModule => Boolean(module));
}

export function getRegisteredHotkeysHelpRows(featureSettings: FeatureSettingsLike): HotkeysHelpRow[] {
  const rows: HotkeysHelpRow[] = [];
  for (const registration of (FEATURE_REGISTRATIONS as readonly FeatureRegistration[])
    .filter((entry) => entry.hotkeysHelp)
    .slice()
    .sort((left, right) => (left.hotkeysHelpOrder || 0) - (right.hotkeysHelpOrder || 0))) {
    const key = registration.setting.key;
    if (!featureSettings[key]) {
      continue;
    }

    const provider = registration.hotkeysHelp;
    if (!provider) {
      continue;
    }

    const nextRows = typeof provider === 'function' ? provider(featureSettings) : provider;
    rows.push(...nextRows);
  }

  return rows;
}
