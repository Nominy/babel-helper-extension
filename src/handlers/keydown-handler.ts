export function createKeydownHandler(helper: any) {
  return (event: KeyboardEvent) => {
    if (typeof helper.handleKeydown === 'function') {
      helper.handleKeydown(event);
    }
  };
}
