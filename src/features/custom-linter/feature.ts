import { matchesShortcut } from '../../core/shortcuts';
import type { FeatureContext, FeatureModule } from '../../core/types';
import { normalizeHighlightedWords } from '../../core/highlighted-words';
import { BABEL_MOD_CONTROLLER_EVENT, isControllerTransition } from '../../mod-platform/protocol';
import type { EditorHooks } from '../../core/editor-hooks';
import type { EditorInputState } from '../editor-input';

const BRIDGE_SCRIPT_PATH = 'dist/content/linter-bridge.js';
const TOGGLE_EVENT = 'babel-helper-linter-bridge-toggle';
const CONFIG_EVENT = 'babel-helper-linter-bridge-config';
const BRIDGE_SCRIPT_ATTR = 'data-babel-helper-linter-bridge';
const AUTOFIX_REQUEST_EVENT = 'babel-helper-linter-autofix';
const AUTOFIX_RESPONSE_EVENT = 'babel-helper-linter-autofix-response';
const AUTOFIX_TIMEOUT_MS = 2000;

let bridgeLoadPromise: Promise<boolean> | null = null;
let bridgeLoaded = false;

function setBridgeEnabled(enabled: boolean): void {
  window.dispatchEvent(
    new CustomEvent(TOGGLE_EVENT, {
      detail: {
        enabled
      }
    })
  );
}

function setBridgeConfig(ctx: Pick<FeatureContext, 'helper'>): void {
  window.dispatchEvent(
    new CustomEvent(CONFIG_EVENT, {
      detail: {
        highlightedWordsEnabled: ctx.helper?.settings?.highlightedWordsEnabled !== false,
        highlightedWords: normalizeHighlightedWords(ctx.helper?.settings?.highlightedWords),
        disabledCustomLinterRuleIds: Array.isArray(ctx.helper?.settings?.disabledCustomLinterRuleIds)
          ? ctx.helper.settings.disabledCustomLinterRuleIds
          : [],
        feedbackDraftRestoreEnabled: ctx.helper?.settings?.features?.feedbackDraftRestore !== false
      }
    })
  );
}

export function registerCustomLinterSettingsForwarding(
  ctx: Pick<FeatureContext, 'helper'>
): () => void {
  const onControllerTransition = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isControllerTransition(detail) && detail.type === 'settings:update') {
      setBridgeConfig(ctx);
    }
  };
  window.addEventListener(BABEL_MOD_CONTROLLER_EVENT, onControllerTransition);
  return () => window.removeEventListener(BABEL_MOD_CONTROLLER_EVENT, onControllerTransition);
}

function injectBridge(): Promise<boolean> {
  if (bridgeLoadPromise) {
    return bridgeLoadPromise;
  }

  const existingScript = document.querySelector(`script[${BRIDGE_SCRIPT_ATTR}="true"]`);
  if (bridgeLoaded && existingScript) {
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

  bridgeLoadPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.setAttribute(BRIDGE_SCRIPT_ATTR, 'true');
    try {
      script.src = chromeApi.runtime.getURL(BRIDGE_SCRIPT_PATH);
    } catch (_error) {
      script.remove();
      bridgeLoadPromise = null;
      bridgeLoaded = false;
      resolve(false);
      return;
    }
    script.async = false;
    script.onload = () => {
      bridgeLoaded = true;
      bridgeLoadPromise = null;
      resolve(true);
    };
    script.onerror = () => {
      script.remove();
      bridgeLoadPromise = null;
      bridgeLoaded = false;
      resolve(false);
    };

    root.appendChild(script);
  });
  return bridgeLoadPromise;
}

export function preloadCustomLinterBridge(): Promise<boolean> {
  return injectBridge();
}

/**
 * The bridge script and the stored settings load concurrently, so the config
 * that `settings:update` already forwarded may have been dispatched before the
 * bridge could listen. Re-send it once the bridge is up; the linter itself is
 * only switched on when its feature is enabled.
 */
export async function bootstrapCustomLinterBridge(
  ctx: Pick<FeatureContext, 'helper'>,
  options: { enableLinter: boolean }
): Promise<boolean> {
  const ready = await injectBridge();
  if (!ready) {
    return false;
  }

  setBridgeConfig(ctx);
  if (options.enableLinter) {
    setBridgeEnabled(true);
  }
  return true;
}

export function requestAutoFix(scope: 'current' | 'all'): Promise<{ ok: boolean;[key: string]: unknown }> {
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
  let bridgeReady = false;

  async function ensureBridgeReady(ctx: FeatureContext): Promise<boolean> {
    if (!startPromise) {
      startPromise = injectBridge();
    }

    const ready = await startPromise;
    if (!ready) {
      startPromise = null;
      bridgeReady = false;
      ctx.logger.warn('Custom linter bridge did not load');
      return false;
    }

    bridgeReady = true;
    return true;
  }

  return {
    id: 'custom-linter',
    start(ctx: FeatureContext) {
      ctx.helper.requestAutoFix = requestAutoFix;
    },
    async onLoaded(ctx: FeatureContext) {
      const ready = bridgeReady || (await ensureBridgeReady(ctx));
      if (!ready) {
        return;
      }

      setBridgeConfig(ctx);
      setBridgeEnabled(true);
    },
    async activate(ctx: FeatureContext, reason: string) {
      if (!bridgeReady) {
        const ready = await ensureBridgeReady(ctx);
        if (!ready) {
          return;
        }
      }

      ctx.helper.perf?.count?.('bridge.inject.enabled', { id: 'custom-linter', reason });
      setBridgeConfig(ctx);
      setBridgeEnabled(true);
    },
    deactivate() {
      setBridgeEnabled(false);
    },
    stop(ctx: FeatureContext) {
      bridgeReady = false;
      setBridgeEnabled(false);
      if (ctx.helper.requestAutoFix === requestAutoFix) {
        delete ctx.helper.requestAutoFix;
      }
    }
  };
}

export function registerLinterInput(helper: any, hooks: EditorHooks, input: EditorInputState) {
  const { isFeatureEnabled } = input;

  hooks.on('keydown', (event) => {
    if (!isFeatureEnabled('customLinter')) return false;
    const scope = matchesShortcut(helper.config?.shortcuts, 'lint.all', event, helper.state?.rightShiftPressed)
      ? 'all'
      : matchesShortcut(helper.config?.shortcuts, 'lint.current', event, helper.state?.rightShiftPressed)
        ? 'current'
        : null;
    let handled = false;
    if (scope) {
      handled = true;
      const requestAutoFix =
        typeof helper.requestAutoFix === 'function'
          ? helper.requestAutoFix
          : null;
      void (requestAutoFix
        ? requestAutoFix(scope)
        : Promise.resolve({ ok: false, reason: 'linter-not-ready' })
      ).then((result: Record<string, unknown>) => {
        if (helper.analytics) {
          helper.analytics.record('hotkey:lint-autofix', { scope, ...result });
        }
      });
    }
    if (handled) { event.preventDefault(); event.stopPropagation(); }
    return handled;
  }, 97);
}
