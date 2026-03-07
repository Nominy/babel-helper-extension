import type { FeatureContext, FeatureModule } from '../core/types';

const BRIDGE_SCRIPT_PATH = 'dist/content/quick-region-autocomplete-bridge.js';
const TOGGLE_EVENT = 'babel-helper-quick-region-autocomplete-toggle';
const BRIDGE_SCRIPT_ATTR = 'data-babel-helper-quick-region-autocomplete-bridge';

function setBridgeEnabled(enabled: boolean): void {
  window.dispatchEvent(
    new CustomEvent(TOGGLE_EVENT, {
      detail: {
        enabled
      }
    })
  );
}

function injectBridge(): Promise<boolean> {
  if (document.querySelector(`script[${BRIDGE_SCRIPT_ATTR}="true"]`)) {
    return Promise.resolve(true);
  }

  const chromeApi = (globalThis as { chrome?: any }).chrome;
  if (!chromeApi || !chromeApi.runtime || typeof chromeApi.runtime.getURL !== 'function') {
    return Promise.resolve(false);
  }

  const root = document.documentElement || document.head || document.body;
  if (!(root instanceof HTMLElement)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.setAttribute(BRIDGE_SCRIPT_ATTR, 'true');
    script.src = chromeApi.runtime.getURL(BRIDGE_SCRIPT_PATH);
    script.async = false;
    script.onload = () => {
      resolve(true);
    };
    script.onerror = () => {
      script.remove();
      resolve(false);
    };

    root.appendChild(script);
  });
}

export function createQuickRegionAutocompleteFeature(): FeatureModule {
  let startPromise: Promise<boolean> | null = null;

  return {
    id: 'quick-region-autocomplete',
    async start(ctx: FeatureContext) {
      if (!startPromise) {
        startPromise = injectBridge();
      }

      const ready = await startPromise;
      if (!ready) {
        startPromise = null;
        ctx.logger.warn('Quick region autocomplete bridge did not load');
        return;
      }

      setBridgeEnabled(true);
    },
    stop() {
      setBridgeEnabled(false);
    }
  };
}
