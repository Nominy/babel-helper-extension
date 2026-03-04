export function createSessionService(helper: any) {
  return {
    isInteractive() {
      return Boolean(helper.runtime?.isSessionInteractive?.());
    }
  };
}
