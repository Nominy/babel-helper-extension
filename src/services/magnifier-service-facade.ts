import type { MagnifierService } from '../core/service-contracts';

type MagnifierServiceHelper = {
  bindMagnifier?: () => void;
  unbindMagnifier?: () => void;
  clearMagnifier?: () => void;
};

export function createMagnifierServiceFacade(helper: MagnifierServiceHelper): MagnifierService {
  return {
    bind() {
      helper.bindMagnifier?.();
    },
    unbind() {
      helper.unbindMagnifier?.();
    },
    clear() {
      helper.clearMagnifier?.();
    }
  };
}
