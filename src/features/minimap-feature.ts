import type { FeatureModule } from '../core/types';

export function createMinimapFeature(): FeatureModule {
  return {
    id: 'minimap',
    start: async (context) => {
      // Basic initialization if needed
    },
    onLoaded: async (context) => {
      context.services.minimap.bindMinimap();
    },
    stop: async (context) => {
      context.services.minimap.unbindMinimap();
      context.services.minimap.clearMinimap();
    }
  };
}
