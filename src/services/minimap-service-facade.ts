import type { MinimapService } from '../core/service-contracts';

type MinimapServiceHelper = {
  bindMinimap?: () => void;
  unbindMinimap?: () => void;
  clearMinimap?: () => void;
};

export function createMinimapServiceFacade(helper: MinimapServiceHelper): MinimapService {
  return {
    bindMinimap() {
      helper.bindMinimap?.();
    },
    unbindMinimap() {
      helper.unbindMinimap?.();
    },
    clearMinimap() {
      helper.clearMinimap?.();
    }
  };
}
