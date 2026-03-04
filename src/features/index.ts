import type { FeatureModule } from '../core/types';
import { createHotkeysHelpFeature } from './hotkeys-help-feature';
import { createRowActionsFeature } from './row-actions-feature';
import { createTextMoveFeature } from './text-move-feature';
import { createFocusToggleFeature } from './focus-toggle-feature';
import { createTimelineSelectionFeature } from './timeline-selection-feature';
import { createMagnifierFeature } from './magnifier-feature';

export function createFeatureModules(): FeatureModule[] {
  return [
    createHotkeysHelpFeature(),
    createRowActionsFeature(),
    createTextMoveFeature(),
    createFocusToggleFeature(),
    createTimelineSelectionFeature(),
    createMagnifierFeature()
  ];
}
