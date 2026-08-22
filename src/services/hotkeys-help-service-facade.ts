import type { HotkeysHelpService } from '../core/service-contracts';

type HotkeysHelpServiceHelper = {
  enhanceHotkeysDialog?: () => void;
};

export function createHotkeysHelpServiceFacade(
  helper: HotkeysHelpServiceHelper
): HotkeysHelpService {
  return {
    enhanceHotkeysDialog() {
      helper.enhanceHotkeysDialog?.();
    }
  };
}
