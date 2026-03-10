import type { FeatureContext, FeatureModule } from '../core/types';

const BRIDGE_SCRIPT_PATH = 'dist/content/linter-bridge.js';
const TOGGLE_EVENT = 'babel-helper-linter-bridge-toggle';
const BRIDGE_SCRIPT_ATTR = 'data-babel-helper-linter-bridge';
const AUTOFIX_REQUEST_EVENT = 'babel-helper-linter-autofix';
const AUTOFIX_RESPONSE_EVENT = 'babel-helper-linter-autofix-response';
const AUTOFIX_TIMEOUT_MS = 2000;

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

export function requestAutoFix(scope: 'current' | 'all'): Promise<{ ok: boolean; [key: string]: unknown }> {
  return new Promise((resolve) => {
    let settled = false;

    const handleResponse = (event: Event) => {
      if (settled) {
        return;
      }

      settled = true;
      window.removeEventListener(AUTOFIX_RESPONSE_EVENT, handleResponse, true);
      window.clearTimeout(timeoutId);
      const detail = (event as CustomEvent).detail || {};
      resolve(detail);
    };

    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      window.removeEventListener(AUTOFIX_RESPONSE_EVENT, handleResponse, true);
      resolve({ ok: false, reason: 'timeout' });
    }, AUTOFIX_TIMEOUT_MS);

    window.addEventListener(AUTOFIX_RESPONSE_EVENT, handleResponse, true);
    window.dispatchEvent(
      new CustomEvent(AUTOFIX_REQUEST_EVENT, {
        detail: { scope }
      })
    );
  });
}

export function createCustomLinterFeature(): FeatureModule {
  let startPromise: Promise<boolean> | null = null;

  return {
    id: 'custom-linter',
    async start(ctx: FeatureContext) {
      if (!startPromise) {
        startPromise = injectBridge();
      }

      const ready = await startPromise;
      if (!ready) {
        startPromise = null;
        ctx.logger.warn('Custom linter bridge did not load');
        return;
      }

      setBridgeEnabled(true);
    },
    stop() {
      setBridgeEnabled(false);
    }
  };
}
