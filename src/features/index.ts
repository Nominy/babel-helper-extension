import type { FeatureSettings } from '../core/settings';
import type { FeatureModule } from '../core/types';
import { getRegisteredFeatureModules } from './registry';

export function createFeatureModules(featureSettings: FeatureSettings): FeatureModule[] {
  return getRegisteredFeatureModules(featureSettings);
}
