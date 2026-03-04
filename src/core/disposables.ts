import type { Disposer } from './types';

export function createDisposerStack() {
  const disposers: Disposer[] = [];

  return {
    add(disposer: Disposer) {
      disposers.push(disposer);
    },
    flush() {
      while (disposers.length) {
        const disposer = disposers.pop();
        try {
          disposer?.();
        } catch (_error) {
          // Ignore cleanup errors in teardown paths.
        }
      }
    }
  };
}

