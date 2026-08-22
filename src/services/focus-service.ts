import type { FocusService } from '../core/service-contracts';

type FocusServiceHelper = {
  toggleEditorFocus?: () => unknown;
  focusRow?: (row: HTMLElement, options?: unknown) => unknown;
};

export function createFocusService(helper: FocusServiceHelper): FocusService {
  return {
    toggleEditorFocus() {
      return helper.toggleEditorFocus?.();
    },
    focusRow(row: HTMLElement, options?: unknown) {
      return helper.focusRow?.(row, options);
    }
  };
}
