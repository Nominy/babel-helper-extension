import type { BridgeClientService } from '../core/service-contracts';

type BridgeClientServiceHelper = {
  callBridge?: (operation: string, payload?: unknown) => unknown;
};

export function createBridgeClientService(helper: BridgeClientServiceHelper): BridgeClientService {
  return {
    call(operation: string, payload?: unknown) {
      if (typeof helper.callBridge === 'function') {
        return helper.callBridge(operation, payload);
      }
      return null;
    }
  };
}
