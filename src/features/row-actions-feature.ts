import type { FeatureModule } from '../core/types';

export function createRowActionsFeature(): FeatureModule {
  return {
    id: 'row-actions',
    register(ctx) {
      if (typeof ctx.services.rows.getTranscriptRows !== 'function') {
        ctx.logger.warn('Row service is missing getTranscriptRows');
      }
    }
  };
}
