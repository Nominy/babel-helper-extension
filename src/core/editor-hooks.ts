export type EditorInputPhase = 'capture' | 'keydown' | 'bubble' | 'keyup';
export type EditorInputHandler = (event: KeyboardEvent) => boolean | void;

export interface EditorHooks {
  on(phase: EditorInputPhase, handler: EditorInputHandler, order?: number): () => void;
  dispatch(phase: EditorInputPhase, event: KeyboardEvent): boolean;
}

/** Ordered hooks shared by built-in features. Returning true owns the event. */
export function createEditorHooks(): EditorHooks {
  const handlers: Record<EditorInputPhase, Array<{ handler: EditorInputHandler; order: number }>> = { capture: [], keydown: [], bubble: [], keyup: [] };
  return {
    on(phase: EditorInputPhase, handler: EditorInputHandler, order = 100) {
      const entry = { handler, order };
      handlers[phase].push(entry);
      handlers[phase].sort((left, right) => left.order - right.order);
      return () => {
        const index = handlers[phase].indexOf(entry);
        if (index !== -1) handlers[phase].splice(index, 1);
      };
    },
    dispatch(phase: EditorInputPhase, event: KeyboardEvent) {
      for (const { handler } of [...handlers[phase]]) if (handler(event) === true) return true;
      return false;
    }
  };
}

