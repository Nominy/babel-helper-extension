export function createTimelineSelectionServiceFacade(helper: any) {
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
