import type { SmartSplitService } from '../core/service-contracts';

type SmartSplitServiceHelper = {
  commitCutPreview?: (options?: unknown) => unknown;
};

export function createSmartSplitService(helper: SmartSplitServiceHelper): SmartSplitService {
  return {
    commit(options?: unknown) {
      return helper.commitCutPreview?.(options);
    }
  };
}
