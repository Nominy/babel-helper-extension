import type { TimelineSelectionService } from '../core/service-contracts';

type TimelineSelectionServiceHelper = {
  bindCutPreview?: () => void;
  unbindCutPreview?: () => void;
  clearCutPreview?: () => void;
};

export function createTimelineSelectionServiceFacade(
  helper: TimelineSelectionServiceHelper
): TimelineSelectionService {
  return {
    bind() {
      helper.bindCutPreview?.();
    },
    unbind() {
      helper.unbindCutPreview?.();
    },
    clear() {
      helper.clearCutPreview?.();
    }
  };
}
