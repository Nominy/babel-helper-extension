import type { FeatureSettings } from '../core/settings';
import type { FeatureModule } from '../core/types';
import { createHotkeysHelpFeature } from './hotkeys-help-feature';
import { createRowActionsFeature } from './row-actions-feature';
import { createTextMoveFeature } from './text-move-feature';
import { createFocusToggleFeature } from './focus-toggle-feature';
import { createTimelineSelectionFeature } from './timeline-selection-feature';
import { createMagnifierFeature } from './magnifier-feature';
import { createMinimapFeature } from './minimap-feature';
import { createCustomLinterFeature } from './custom-linter-feature';
import { createQuickRegionAutocompleteFeature } from './quick-region-autocomplete-feature';
import { createWavesurferTooltipEllipsisFeature } from './wavesurfer-tooltip-ellipsis-feature';

const FEATURE_ID_TO_SETTING_KEY: Record<string, keyof FeatureSettings> = {
  'hotkeys-help': 'hotkeysHelp',
  'row-actions': 'rowActions',
  'text-move': 'textMove',
  'quick-region-autocomplete': 'quickRegionAutocomplete',
  'focus-toggle': 'focusToggle',
  'timeline-selection': 'timelineSelection',
  magnifier: 'magnifier',
  minimap: 'minimap',
  'custom-linter': 'customLinter',
  'wavesurfer-tooltip-ellipsis': 'wavesurferTooltipEllipsis'
};

export function createFeatureModules(featureSettings: FeatureSettings): FeatureModule[] {
  const modules = [
    createHotkeysHelpFeature(),
    createRowActionsFeature(),
    createTextMoveFeature(),
    createFocusToggleFeature(),
    createTimelineSelectionFeature(),
    createMagnifierFeature(),
    createMinimapFeature(),
    createCustomLinterFeature(),
    createQuickRegionAutocompleteFeature(),
    createWavesurferTooltipEllipsisFeature()
  ];

  return modules.filter((module) => {
    const settingKey = FEATURE_ID_TO_SETTING_KEY[module.id];
    if (!settingKey) {
      return true;
    }

    return featureSettings[settingKey];
  });
}
