import { createHelperKernel } from '../core/kernel';
import { bootstrapCustomLinterBridge, preloadCustomLinterBridge } from '../features/custom-linter';

declare global {
  interface Window {
    __babelHelperKernel?: {
      start: () => Promise<void>;
      stop: () => Promise<void>;
    };
  }
}

async function boot() {
  window.dispatchEvent(new CustomEvent('babel-helper-bridge-teardown'));
  document
    .querySelectorAll(
      'script[data-babel-helper-linter-bridge="true"], script[data-babel-helper-quick-region-autocomplete-bridge="true"]'
    )
    .forEach((script) => script.remove());
  const linterBridgePreload = preloadCustomLinterBridge();

  const previousKernel = window.__babelHelperKernel;
  if (previousKernel && typeof previousKernel.stop === 'function') {
    await previousKernel.stop().catch(() => {});
  }

  const kernel = createHelperKernel();
  window.__babelHelperKernel = kernel;

  await kernel.start().catch((error) => {
    if (window.__babelHelperKernel === kernel) {
      delete window.__babelHelperKernel;
    }
    throw error;
  });

  if (kernel.helper?.isFeatureEnabled?.('customLinter')) {
    void linterBridgePreload.finally(() => bootstrapCustomLinterBridge({ helper: kernel.helper }));
  }
}

void boot();
