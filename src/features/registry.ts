import type { FeatureModule } from '../core/types';
import { formatShortcut, type ShortcutSettings } from '../core/shortcuts';
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
  | ((featureSettings: FeatureSettingsLike, shortcuts?: ShortcutSettings) => HotkeysHelpRow[]);

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
      description: 'Enable configurable segment deletion, navigation, and merge shortcuts.'
    },
    moduleOrder: 20,
    createModule: createRowActionsFeature,
    hotkeysHelpOrder: 30,
    hotkeysHelp: (featureSettings, shortcuts) => {
      const rows: HotkeysHelpRow[] = [];
      const add = (id: string, description: string) => rows.push([formatShortcut(shortcuts, id), description]);
      if (featureSettings.speakerWorkflowHotkeys) {
        add('speaker.first', 'Switch to the first speaker workflow lane');
        add('speaker.second', 'Switch to the second speaker workflow lane');
        add('speaker.reset', 'Reset lanes: show both, unmute both, select All Tracks');
      }
      add('playback.rewind', 'Rewind playback 1000ms');
      if (featureSettings.playbackSpeedHotkeys) {
        add('playback.faster', 'Increase playback speed');
        add('playback.slower', 'Decrease playback speed');
      }
      add('row.previous', 'Focus previous segment from start');
      add('row.next', 'Focus next segment from start');
      add('ghost.lane', 'Toggle active ghost cursor lane');
      rows.push(['Alt + Click word', 'Seek playback to the word timestamp']);
      add('row.mergePrevious', 'Merge with previous segment');
      add('row.mergeNext', 'Merge with next segment');
      add('row.delete', 'Delete current segment when not typing');
      return rows;
    }
  }),
  defineFeature({
    id: 'playback-speed-hotkeys',
    setting: {
      key: 'playbackSpeedHotkeys',
      defaultEnabled: true,
      label: 'Playback Speed Hotkeys',
      description: 'Enable configurable playback speed shortcuts.'
    }
  }),
  defineFeature({
    id: 'speaker-workflow-hotkeys',
    setting: {
      key: 'speakerWorkflowHotkeys',
      defaultEnabled: true,
      label: 'Speaker Workflow Hotkeys',
      description: 'Enable configurable speaker lane switching and workflow reset shortcuts.'
    }
  }),
  defineFeature({
    id: 'selected-number-to-skaz',
    setting: {
      key: 'selectedNumberToSkaz',
      defaultEnabled: true,
      label: 'Selected Number to SKAZ',
      description:
        'Enable immediate digit-to-SKAZ conversion (Select text + type digit) and a configurable shortcut to convert selected digits into `digits {СКАЗ: words}`.'
    },
    hotkeysHelpOrder: 40,
    hotkeysHelp: (_featureSettings, shortcuts) => [
      ['Digit', 'Replace selection with `digit {СКАЗ: original}`'],
      [formatShortcut(shortcuts, 'number.convert'), 'Auto-convert selected digits into `digits {СКАЗ: words}`']
    ]
  }),
  defineFeature({
    id: 'text-move',
    setting: {
      key: 'textMove',
      defaultEnabled: true,
      label: 'Text Move',
      description: 'Enable configurable shortcuts to move text between adjacent segments.'
    },
    moduleOrder: 30,
    createModule: createTextMoveFeature,
    hotkeysHelpOrder: 20,
    hotkeysHelp: (_featureSettings, shortcuts) => [
      [formatShortcut(shortcuts, 'text.previous'), 'Move text before caret to previous segment'],
      [formatShortcut(shortcuts, 'text.next'), 'Move text after caret to next segment']
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
      description: 'Enable a configurable shortcut to pause and blur the active transcript textarea, then resume and restore it.'
    },
    moduleOrder: 40,
    createModule: createFocusToggleFeature,
    hotkeysHelpOrder: 10,
    hotkeysHelp: (featureSettings, shortcuts) => [
      [
        formatShortcut(shortcuts, 'focus.toggle'),
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
      description: 'Enable Alt + Drag cut preview and configurable timeline action shortcuts.'
    },
    moduleOrder: 50,
    createModule: createTimelineSelectionFeature,
    hotkeysHelpOrder: 60,
    hotkeysHelp: (_featureSettings, shortcuts) => [
      ['Alt + Drag', 'Select a timeline cut preview'],
      [formatShortcut(shortcuts, 'timeline.insert'), 'Insert a segment at the ghost cursor'],
      [formatShortcut(shortcuts, 'timeline.autoSegment'), 'Automatically segment the timeline'],
      [formatShortcut(shortcuts, 'timeline.transcribe'), 'Transcribe the current segment'],
      [formatShortcut(shortcuts, 'timeline.trimCurrent'), 'Trim silence in the current segment'],
      [formatShortcut(shortcuts, 'timeline.trimAll'), 'Trim silence in all visible segments'],
      [formatShortcut(shortcuts, 'preview.cancel'), 'Cancel cut preview'],
      [formatShortcut(shortcuts, 'preview.commitLeft'), 'Smart split / commit cut preview from the left'],
      [formatShortcut(shortcuts, 'preview.commit'), 'Commit cut preview'],
      [formatShortcut(shortcuts, 'preview.loop'), 'Toggle cut preview loop']
    ]
  }),
  defineFeature({
    id: 'audio-trim-outward-pass',
    setting: {
      key: 'audioTrimOutwardPass',
      defaultEnabled: true,
      label: 'Audio Trim Outward Pass',
      description:
        'When silence trimming cannot move a boundary inward, allow it to extend outward to the next quiet block and then refine inward.'
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
    hotkeysHelp: (_featureSettings, shortcuts) => [
      [formatShortcut(shortcuts, 'lint.current'), 'Auto-fix lint issues in current row'],
      [formatShortcut(shortcuts, 'lint.all'), 'Auto-fix lint issues in all rows']
    ]
  }),
  defineFeature({
    id: 'proportional-cursor-restore',
    setting: {
      key: 'proportionalCursorRestore',
      defaultEnabled: true,
      label: 'Proportional Cursor Restore',
      description:
        'When restoring focus with the focus-toggle shortcut, advance cursor to the text position proportional to playback progress (never backward from your last edit position).'
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
  }),
  defineFeature({
    id: 'feedback-draft-restore',
    setting: {
      key: 'feedbackDraftRestore',
      defaultEnabled: true,
      label: 'Feedback Draft Restore',
      description:
        'Hold the L2 feedback draft response until Babel has committed the form input definitions, so persisted ratings and comments survive a cold reload.'
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

export function getRegisteredHotkeysHelpRows(
  featureSettings: FeatureSettingsLike,
  shortcuts?: ShortcutSettings
): HotkeysHelpRow[] {
  const rows: HotkeysHelpRow[] = [
    [formatShortcut(shortcuts, 'appearance.toggle'), 'Toggle Website Appearance editor']
  ];
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

    const nextRows = typeof provider === 'function' ? provider(featureSettings, shortcuts) : provider;
    rows.push(...nextRows);
  }

  return rows;
}
