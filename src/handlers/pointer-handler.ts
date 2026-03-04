export function createPointerHandler(helper: any) {
  return {
    onPointerDown(event: PointerEvent) {
      if (typeof helper.handlePointerDown === 'function') {
        helper.handlePointerDown(event);
      }
    },
    onPointerMove(event: PointerEvent) {
      if (typeof helper.handlePointerMove === 'function') {
        helper.handlePointerMove(event);
      }
    },
    onPointerUp(event: PointerEvent) {
      if (typeof helper.handlePointerEnd === 'function') {
        helper.handlePointerEnd(event);
      }
    }
  };
}
