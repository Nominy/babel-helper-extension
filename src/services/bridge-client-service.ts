import type { BridgeClientService } from '../core/service-contracts';

type BridgeClientServiceHelper = {
  callBridge?: (operation: string, payload?: unknown) => unknown;
};

export function createBridgeClientService(helper: BridgeClientServiceHelper): BridgeClientService {
  return {
    call(operation: string, payload?: unknown) {
      if (typeof helper.callBridge === 'function') {
        return helper.callBridge(operation, payload);
      }
      return null;
    }
  };
}

export function createMagnifierBridgeClient(requestPrefix: string) {
  const requestEvent = 'babel-helper-magnifier-request';
  const responseEvent = 'babel-helper-magnifier-response';
  let bridgeInjected = false;
  let bridgeLoadPromise: Promise<boolean> | null = null;
  let bridgeRequestId = 0;

  function injectBridge(): Promise<boolean> {
    if ('__babelHelperMagnifierBridge' in window && window.__babelHelperMagnifierBridge) {
      bridgeInjected = true;
      return Promise.resolve(true);
    }
    if (bridgeInjected) {
      return Promise.resolve(true);
    }
    if (bridgeLoadPromise) {
      return bridgeLoadPromise;
    }

    bridgeLoadPromise = new Promise((resolve) => {
      const parent = document.documentElement || document.head || document.body;
      // Chrome's extension API is not included in DOM typings.
      const chromeApi = (globalThis as typeof globalThis & {
        chrome?: { runtime?: { getURL?: (path: string) => string } };
      }).chrome;
      if (
        !parent ||
        !chromeApi?.runtime ||
        typeof chromeApi.runtime.getURL !== 'function'
      ) {
        bridgeLoadPromise = null;
        resolve(false);
        return;
      }

      const script = document.createElement('script');
      try {
        script.src = chromeApi.runtime.getURL('dist/content/magnifier-bridge.js');
      } catch {
        script.remove();
        bridgeLoadPromise = null;
        resolve(false);
        return;
      }
      script.async = false;
      script.onload = () => {
        script.remove();
        bridgeInjected = true;
        resolve(true);
      };
      script.onerror = () => {
        script.remove();
        bridgeLoadPromise = null;
        resolve(false);
      };
      parent.appendChild(script);
    });

    return bridgeLoadPromise;
  }

  return async function callBridge(operation: string, payload?: unknown): Promise<unknown> {
    const ready = await injectBridge();
    if (!ready) {
      return null;
    }

    return new Promise((resolve) => {
      const id = requestPrefix + ++bridgeRequestId;
      let settled = false;
      const finish = (result: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        window.removeEventListener(responseEvent, handleResponse, true);
        window.clearTimeout(timeoutId);
        resolve(result || null);
      };
      const handleResponse = (event: Event) => {
        const detail = (event as CustomEvent<{ id?: unknown; result?: unknown }>).detail || {};
        if (detail.id !== id) {
          return;
        }
        finish(detail.result || null);
      };
      const timeoutId = window.setTimeout(() => finish(null), 700);
      window.addEventListener(responseEvent, handleResponse, true);
      window.dispatchEvent(
        new CustomEvent(requestEvent, {
          detail: { id, operation, payload: payload || {} }
        })
      );
    });
  };
}
