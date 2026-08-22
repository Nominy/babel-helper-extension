import type { ServiceOptions, TimestampEditService } from '../core/service-contracts';

type TimestampEditServiceHelper = {
  setSegmentBoundaryTime?: (options: ServiceOptions) => Promise<unknown>;
  splitSegmentAtTime?: (options: ServiceOptions) => Promise<unknown>;
  mergeSegmentWithNativeAction?: (options: ServiceOptions) => Promise<unknown>;
  createSegmentWithNativeAction?: (options: ServiceOptions) => Promise<unknown>;
  deleteSegmentWithNativeAction?: (options: ServiceOptions) => Promise<unknown>;
};

function unavailable(method: string): Promise<never> {
  return Promise.reject(new Error(`Timestamp edit service method is unavailable: ${method}`));
}

export function createTimestampEditServiceFacade(
  helper: TimestampEditServiceHelper
): TimestampEditService {
  return {
    setSegmentBoundaryTime(options) {
      return helper.setSegmentBoundaryTime?.(options) ?? unavailable('setSegmentBoundaryTime');
    },
    splitSegmentAtTime(options) {
      return helper.splitSegmentAtTime?.(options) ?? unavailable('splitSegmentAtTime');
    },
    mergeSegmentWithNativeAction(options) {
      return helper.mergeSegmentWithNativeAction?.(options) ?? unavailable('mergeSegmentWithNativeAction');
    },
    createSegmentWithNativeAction(options) {
      return helper.createSegmentWithNativeAction?.(options) ?? unavailable('createSegmentWithNativeAction');
    },
    deleteSegmentWithNativeAction(options) {
      return helper.deleteSegmentWithNativeAction?.(options) ?? unavailable('deleteSegmentWithNativeAction');
    }
  };
}
