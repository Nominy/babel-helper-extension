import type { ActionMenuService } from '../core/service-contracts';

type ActionMenuServiceHelper = {
  runRowAction?: (actionName: string, options?: unknown) => unknown;
};

export function createActionMenuService(helper: ActionMenuServiceHelper): ActionMenuService {
  return {
    runRowAction(actionName: string, options?: unknown) {
      return helper.runRowAction?.(actionName, options);
    }
  };
}
