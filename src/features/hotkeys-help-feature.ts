import type { FeatureModule } from '../core/types';

export function createHotkeysHelpFeature(): FeatureModule {
  return {
    id: 'hotkeys-help',
    register(ctx) {
      if (!Array.isArray(ctx.config.hotkeysHelpRows)) {
        ctx.config.hotkeysHelpRows = [];
      }
    }
  };
}
