import { createConfig } from './config';
import { createState } from './state-store';
import { createLogger } from './logger';
import {
  DEFAULT_EXTENSION_SETTINGS,
  SETTINGS_STORAGE_KEY,
  type ExtensionSettings,
  type FeatureSettingKey,
  loadExtensionSettings,
  normalizeExtensionSettings
} from './settings';
import { isEditable, isVisible, normalizeText, setEditableValue, dispatchClick, sleep, waitFor } from '../hooks/dom';
import { registerLifecycle } from './lifecycle';
import type { FeatureContext } from './types';
import { createBuiltinServiceRegistry } from './service-registry';
import { createScope } from '../mod-platform/scope';
import { createAnalyticsStore } from './analytics-store';
import { createPerfRuntime } from './perf';
import { registerExtendedDiffViewService } from '../services/extended-diff-view-service';
import { registerRecoveredEditorSnapshotService } from '../services/recovered-editor-snapshot-service';
import { createSessionService } from '../services/session-service';
import type * as SessionRuntimeModule from '../content/lazy-session';
import { createModController } from '../content/mod-controller';

type LoadedSessionRuntimeModule = typeof SessionRuntimeModule;

type ChromeStorageChange = {
  newValue?: unknown;
};

type ChromeRuntimeHost = {
  runtime: {
    getURL: (path: string) => string;
  };
  storage?: {
    onChanged?: {
      addListener: (
        listener: (changes: Record<string, ChromeStorageChange>, areaName: string) => void
      ) => void;
      removeListener: (
        listener: (changes: Record<string, ChromeStorageChange>, areaName: string) => void
      ) => void;
    };
  };
};

function cloneSettings(settings: ExtensionSettings): ExtensionSettings {
  return normalizeExtensionSettings(settings);
}

function hasChromeRuntime(value: unknown): value is ChromeRuntimeHost {
  if (!value || typeof value !== 'object' || !('runtime' in value)) {
    return false;
  }

  const runtime = value.runtime;
  if (!runtime || typeof runtime !== 'object' || !('getURL' in runtime)) {
    return false;
  }

  return typeof runtime.getURL === 'function';
}

function getChromeApi(): ChromeRuntimeHost | null {
  // Chrome exposes the extension API as a global that is absent from DOM typings.
  const globalWithChrome = globalThis as typeof globalThis & { chrome?: unknown };
  const chromeApi = globalWithChrome.chrome;
  return hasChromeRuntime(chromeApi) ? chromeApi : null;
}

export function createHelperKernel() {
  const state = createState();
  let settings = cloneSettings(DEFAULT_EXTENSION_SETTINGS);
  const config = createConfig(settings.features);
  const analytics = createAnalyticsStore();
  const perf = createPerfRuntime();
  let sessionRuntimeModule: LoadedSessionRuntimeModule | null = null;
  let sessionRuntimeLoadPromise: Promise<LoadedSessionRuntimeModule> | null = null;
  const modController = createModController({ initialSettings: settings });
  const kernelScope = createScope(`builtin:kernel:${modController.generation}`);
  let startPromise: Promise<void> | null = null;
  let settingsListenerBound = false;

  const helper: any = {
    config,
    settings,
    state,
    analytics,
    perf,
    isFeatureEnabled(featureKey: FeatureSettingKey) {
      return Boolean(helper.settings?.features?.[featureKey]);
    },
    runtime: {
      clearRuntimeTimer() {
        const timer = helper.state.routeRefreshTimer;
        if (timer) {
          window.clearTimeout(timer);
        }
        helper.state.routeRefreshTimer = 0;
      },
      scheduleRouteRefresh() {
        return false;
      },
      refreshRouteSession() {
        return false;
      },
      isSessionInteractive() {
        return false;
      },
      onLoaded(reason?: string) {
        return helper.runtime.activateFeature('session', reason || 'on-loaded');
      },
      activateFeature(_id: string, reason?: string) {
        return activateSessionRuntime(reason || 'activate');
      },
      deactivateFeature(_id: string, reason?: string) {
        return deactivateSessionRuntime(reason || 'deactivate');
      },
      ensureSessionRuntime(reason?: string) {
        return ensureSessionRuntime(reason || 'session-ready');
      }
    },
    isEditable,
    isVisible,
    normalizeText,
    setEditableValue,
    dispatchClick,
    sleep,
    waitFor
  };

  function applySettings(nextSettings: ExtensionSettings, reason?: string) {
    settings = cloneSettings(nextSettings);
    helper.settings = settings;

    const nextConfig = createConfig(settings.features);
    Object.assign(helper.config, nextConfig);
    if (reason) {
      modController.updateSettings(settings, reason);
    }
  }

  const services = createBuiltinServiceRegistry();
  services.provide('session', createSessionService(helper), { scope: kernelScope });

  const logger = createLogger('kernel');
  const featureContext: FeatureContext = {
    helper,
    services,
    scope: kernelScope,
    state,
    config,
    runtime: helper.runtime,
    onDispose: (disposer) => {
      kernelScope.defer(disposer);
    },
    logger
  };

  function bindSettingsForwarding() {
    if (settingsListenerBound) {
      return;
    }
    const storageChanges = getChromeApi()?.storage?.onChanged;
    if (!storageChanges) {
      return;
    }

    const onSettingsChanged = (
      changes: Record<string, ChromeStorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local' || !(SETTINGS_STORAGE_KEY in changes)) {
        return;
      }
      applySettings(
        normalizeExtensionSettings(changes[SETTINGS_STORAGE_KEY]?.newValue),
        'storage-change'
      );
    };

    try {
      storageChanges.addListener(onSettingsChanged);
      settingsListenerBound = true;
      kernelScope.defer(() => {
        try {
          storageChanges.removeListener(onSettingsChanged);
        } finally {
          settingsListenerBound = false;
        }
      });
    } catch {
      try {
        storageChanges.removeListener(onSettingsChanged);
      } catch {
        // The extension context may already be invalidated; the listener is then gone with it.
      }
      settingsListenerBound = false;
    }
  }

  async function loadSessionRuntimeModule() {
    if (sessionRuntimeModule) {
      return sessionRuntimeModule;
    }
    if (!sessionRuntimeLoadPromise) {
      perf.mark('session-runtime-import');
      sessionRuntimeLoadPromise = (async () => {
        const chromeApi = getChromeApi();
        let url = './lazy-session.js';
        if (chromeApi) {
          try {
            url = chromeApi.runtime.getURL('dist/content/lazy-session.js');
          } catch {
            url = './lazy-session.js';
          }
        }
        // Dynamic extension URLs cannot be statically resolved; lazy-session owns this module shape.
        return import(url) as unknown as Promise<LoadedSessionRuntimeModule>;
      })();
    }
    try {
      sessionRuntimeModule = await sessionRuntimeLoadPromise;
    } catch (error: unknown) {
      sessionRuntimeLoadPromise = null;
      throw error;
    }
    perf.measure('session-runtime-import', 'session-runtime-import');
    return sessionRuntimeModule;
  }

  async function ensureSessionRuntime(reason: string) {
    const module = await loadSessionRuntimeModule();
    if (typeof module.ensureSessionRuntime !== 'function') {
      return true;
    }
    return module.ensureSessionRuntime(featureContext, reason);
  }

  function activateSessionRuntime(reason: string) {
    return modController.activateSession(reason, async () => {
      perf.setPhase('session-ready', { reason });
      const module = await loadSessionRuntimeModule();
      if (typeof module.activateSessionFeatures === 'function') {
        const activated = await module.activateSessionFeatures(featureContext, reason);
        if (!activated) {
          return false;
        }
      }
      perf.setPhase('active', { reason });
      return true;
    });
  }

  function deactivateSessionRuntime(reason: string) {
    return modController.deactivateSession(reason, async () => {
      if (
        sessionRuntimeModule &&
        typeof sessionRuntimeModule.deactivateSessionFeatures === 'function'
      ) {
        await sessionRuntimeModule.deactivateSessionFeatures(featureContext, reason);
      }
      perf.setPhase('route-ready', { reason });
      return true;
    });
  }

  function startKernel() {
    if (startPromise) {
      return startPromise;
    }

    modController.start('kernel-start');
    startPromise = (async () => {
      try {
        const loadedSettings = await loadExtensionSettings();
        applySettings(loadedSettings, 'settings-loaded');
        bindSettingsForwarding();

        perf.setPhase('route-ready', { reason: 'kernel-start' });
        registerLifecycle(helper);
        kernelScope.defer(() => {
          if (typeof helper.runtime.disposeLifecycle === 'function') {
            helper.runtime.disposeLifecycle();
          }
        });
        registerRecoveredEditorSnapshotService(helper);
        if (helper.isFeatureEnabled('extendedDiffView')) {
          registerExtendedDiffViewService(helper);
          kernelScope.defer(() => {
            if (typeof helper.unbindExtendedDiffView === 'function') {
              helper.unbindExtendedDiffView();
            }
          });
        }
        modController.ready('kernel-ready');
      } catch (error: unknown) {
        await stopKernel('kernel-start-error');
        throw error;
      }
    })();
    return startPromise;
  }

  function stopKernel(reason = 'kernel-stop') {
    return modController.stop(reason, async () => {
      if (sessionRuntimeModule && typeof sessionRuntimeModule.stopSessionRuntime === 'function') {
        await sessionRuntimeModule.stopSessionRuntime(featureContext, reason);
      }
      await kernelScope.dispose(reason);
    });
  }

  return {
    helper,
    controller: modController,
    generation: modController.generation,
    start: startKernel,
    onLoaded(reason?: string) {
      return activateSessionRuntime(reason || 'kernel-on-loaded');
    },
    stop: stopKernel
  };
}
