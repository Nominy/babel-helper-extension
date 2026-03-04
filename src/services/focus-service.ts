export function createFocusService(helper: any) {
  return {
    toggleEditorFocus() {
      return helper.toggleEditorFocus?.();
    },
    focusRow(row: HTMLElement, options?: unknown) {
      return helper.focusRow?.(row, options);
    }
  };
}
