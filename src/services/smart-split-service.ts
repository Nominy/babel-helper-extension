export function createSmartSplitService(helper: any) {
  return {
    commit(options?: unknown) {
      return helper.commitCutPreview?.(options);
    }
  };
}
