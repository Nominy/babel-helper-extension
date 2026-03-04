export function createActionMenuService(helper: any) {
  return {
    runRowAction(actionName: string, options?: unknown) {
      return helper.runRowAction?.(actionName, options);
    }
  };
}
