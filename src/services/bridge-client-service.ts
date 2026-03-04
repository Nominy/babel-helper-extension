export function createBridgeClientService(helper: any) {
  return {
    call(operation: string, payload?: unknown) {
      if (typeof helper.callBridge === 'function') {
        return helper.callBridge(operation, payload);
      }
      return null;
    }
  };
}
