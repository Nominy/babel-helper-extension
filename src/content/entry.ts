import { createHelperKernel } from '../core/kernel';
import { bootstrapCustomLinterBridge, preloadCustomLinterBridge } from '../features/custom-linter';

declare global {
  interface Window {
    __babelHelperKernel?: {
      generation: number;
      helper?: {
        isFeatureEnabled?: (featureKey: string) => boolean;
      };
      start: () => Promise<void>;
      stop: (reason?: string) => Promise<void>;
    };
  }
}

async function boot() {
  window.dispatchEvent(new CustomEvent('babel-helper-bridge-teardown'));
  document
    .querySelectorAll(
      'script[data-babel-helper-linter-bridge="true"], script[data-babel-helper-quick-region-autocomplete-bridge="true"], script[data-babel-helper-recovered-editor-bridge="true"]'
    )
    .forEach((script) => script.remove());
  const linterBridgePreload = preloadCustomLinterBridge();

  const previousKernel = window.__babelHelperKernel;
  if (previousKernel && typeof previousKernel.stop === 'function') {
    await previousKernel.stop('kernel-replaced').catch(() => {});
  }

  const kernel = createHelperKernel();
  window.__babelHelperKernel = kernel;

  await kernel.start().catch((error) => {
    if (window.__babelHelperKernel === kernel) {
      delete window.__babelHelperKernel;
    }
    void kernel.stop('kernel-start-error').catch(() => {});
    throw error;
  });

  if (kernel.helper?.isFeatureEnabled?.('customLinter')) {
    void linterBridgePreload
      .then(
        () => bootstrapCustomLinterBridge({ helper: kernel.helper }),
        () => bootstrapCustomLinterBridge({ helper: kernel.helper })
      )
      .catch(() => {});
  }
}

function scheduleBootRetry() {
  window.setTimeout(() => {
    void boot().catch(scheduleBootRetry);
  }, 1000);
}

void boot().catch(scheduleBootRetry);
