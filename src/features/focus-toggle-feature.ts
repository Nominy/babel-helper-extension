import type { FeatureModule } from '../core/types';

export function createFocusToggleFeature(): FeatureModule {
  return {
    id: 'focus-toggle'
  };
}
