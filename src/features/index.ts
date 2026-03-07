import type { FeatureSettings } from '../core/settings';
import type { FeatureModule } from '../core/types';
import { createHotkeysHelpFeature } from './hotkeys-help-feature';
import { createRowActionsFeature } from './row-actions-feature';
import { createTextMoveFeature } from './text-move-feature';
import { createFocusToggleFeature } from './focus-toggle-feature';
import { createTimelineSelectionFeature } from './timeline-selection-feature';
import { createMagnifierFeature } from './magnifier-feature';
import { createCustomLinterFeature } from './custom-linter-feature';
import { createQuickRegionAutocompleteFeature } from './quick-region-autocomplete-feature';

const FEATURE_ID_TO_SETTING_KEY: Record<string, keyof FeatureSettings> = {
  'hotkeys-help': 'hotkeysHelp',
  'row-actions': 'rowActions',
  'text-move': 'textMove',
  'focus-toggle': 'focusToggle',
  'timeline-selection': 'timelineSelection',
  magnifier: 'magnifier',
  'custom-linter': 'customLinter'
};

export function createFeatureModules(featureSettings: FeatureSettings): FeatureModule[] {
  const modules = [
    createHotkeysHelpFeature(),
    createRowActionsFeature(),
    createTextMoveFeature(),
    createFocusToggleFeature(),
    createTimelineSelectionFeature(),
    createMagnifierFeature(),
    createCustomLinterFeature(),
    createQuickRegionAutocompleteFeature()
  ];

  return modules.filter((module) => {
    const settingKey = FEATURE_ID_TO_SETTING_KEY[module.id];
    if (!settingKey) {
      return true;
    }

    return featureSettings[settingKey];
  });
}
