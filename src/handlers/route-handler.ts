export function createRouteHandler(helper: any) {
  return {
    refresh(reason: string) {
      if (helper.runtime && typeof helper.runtime.refreshRouteSession === 'function') {
        return helper.runtime.refreshRouteSession(reason);
      }
      return false;
    }
  };
}
