import { createHelperKernel } from '../core/kernel';
import { bootstrapCustomLinterBridge, preloadCustomLinterBridge } from '../features/custom-linter';
import { showNativeAutomationFailure } from '../ui/native-automation-failure';

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
  // Drain feature-owned native restoration before removing its MAIN listeners.
  // A failed stop must retain its truthful audio state and block replacement.
  const previousKernel = window.__babelHelperKernel;
  if (previousKernel && typeof previousKernel.stop === 'function') {
    await previousKernel.stop('kernel-replaced');
  }
  window.dispatchEvent(new CustomEvent('babel-helper-bridge-teardown'));
  document
    .querySelectorAll(
      'script[data-babel-helper-linter-bridge="true"], script[data-babel-helper-quick-region-autocomplete-bridge="true"], script[data-babel-helper-recovered-editor-bridge="true"]'
    )
    .forEach((script) => script.remove());
  const linterBridgePreload = preloadCustomLinterBridge().catch(error => {
    console.error('[Babel Helper] Linter bridge preload failed:', error);
    showNativeAutomationFailure('Custom linter', String(error));
    return false;
  });


  const kernel = createHelperKernel();
  window.__babelHelperKernel = kernel;

  await kernel.start().catch(async error => {
    try {
      await kernel.stop('kernel-start-error');
    } catch (stopError) {
      // Keep ownership when native cleanup could not finish; never retry a new
      // kernel over an unresolved Original-audio restoration.
      console.error('[Babel Helper] Startup and native cleanup failed:', error, stopError);
      throw new Error(`Helper startup failed: ${String(error)}. Native cleanup also failed: ${String(stopError)}`);
    }
    if (window.__babelHelperKernel === kernel) delete window.__babelHelperKernel;
    throw error;
  });

  const enableLinter = Boolean(kernel.helper?.isFeatureEnabled?.('customLinter'));
  if (!await linterBridgePreload) {
    showNativeAutomationFailure('Custom linter', 'The MAIN-world linter bridge could not be loaded');
    return;
  }
  try {
    if (!await bootstrapCustomLinterBridge({ helper: kernel.helper }, { enableLinter })) {
      throw new Error('The MAIN-world linter bridge could not be configured');
    }
  } catch (error) {
    console.error('[Babel Helper] Linter bootstrap failed:', error);
    showNativeAutomationFailure('Custom linter', String(error));
  }
}

void boot().catch(error => {
  console.error('[Babel Helper] Startup stopped:', error);
  showNativeAutomationFailure('Helper startup', error instanceof Error ? error.message : String(error));
});
