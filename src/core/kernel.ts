import { createConfig } from './config';
import { createState } from './state-store';
import { createLogger } from './logger';
import {
  DEFAULT_EXTENSION_SETTINGS,
  type ExtensionSettings,
  type FeatureSettingKey,
  loadExtensionSettings,
  normalizeExtensionSettings
} from './settings';
import { isEditable, isVisible, normalizeText, setEditableValue, dispatchClick, sleep, waitFor } from '../hooks/dom';
import { registerLifecycle } from './lifecycle';
import { createDisposerStack } from './disposables';
import type { FeatureContext, ServiceRegistry } from './types';
import { createAnalyticsStore } from './analytics-store';
import { createPerfRuntime } from './perf';

function cloneSettings(settings: ExtensionSettings): ExtensionSettings {
  return normalizeExtensionSettings(settings);
}

export function createHelperKernel() {
  const state = createState();
  let settings = cloneSettings(DEFAULT_EXTENSION_SETTINGS);
  const config = createConfig(settings.features);
  const analytics = createAnalyticsStore();
  const perf = createPerfRuntime();
  let sessionRuntimeModule: any = null;
  let sessionRuntimeLoadPromise: Promise<any> | null = null;

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
      onLoaded() {
        return helper.runtime.activateFeature('session', 'on-loaded');
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

  function applySettings(nextSettings: ExtensionSettings) {
    settings = cloneSettings(nextSettings);
    helper.settings = settings;

    const nextConfig = createConfig(settings.features);
    Object.assign(helper.config, nextConfig);
  }

  const services: ServiceRegistry = {
    session: {
      isInteractive: () => helper.runtime.isSessionInteractive()
    },
    rows: helper,
    actions: helper,
    focus: helper,
    hotkeysHelp: helper,
    timelineSelection: helper,
    smartSplit: helper,
    timestampEdit: helper,
    waveformScale: helper,
    magnifier: helper,
    minimap: helper,
    bridge: helper
  };

  const logger = createLogger('kernel');
  const disposerStack = createDisposerStack();
  const featureContext: FeatureContext = {
    helper,
    services,
    state,
    config,
    runtime: helper.runtime,
    onDispose: (disposer) => disposerStack.add(disposer),
    logger
  };

  async function loadSessionRuntimeModule() {
    if (sessionRuntimeModule) {
      return sessionRuntimeModule;
    }
    if (!sessionRuntimeLoadPromise) {
      perf.mark('session-runtime-import');
      sessionRuntimeLoadPromise = (async () => {
        const chromeApi = (globalThis as { chrome?: any }).chrome;
        const url =
          chromeApi?.runtime && typeof chromeApi.runtime.getURL === 'function'
            ? chromeApi.runtime.getURL('dist/content/lazy-session.js')
            : './lazy-session.js';
        return import(url);
      })();
    }
    sessionRuntimeModule = await sessionRuntimeLoadPromise;
    perf.measure('session-runtime-import', 'session-runtime-import');
    return sessionRuntimeModule;
  }

  async function ensureSessionRuntime(reason: string) {
    const module = await loadSessionRuntimeModule();
    if (typeof module.ensureSessionRuntime === 'function') {
      await module.ensureSessionRuntime(featureContext, reason);
    }
  }

  async function activateSessionRuntime(reason: string) {
    perf.setPhase('session-ready', { reason });
    const module = await loadSessionRuntimeModule();
    if (typeof module.activateSessionFeatures === 'function') {
      await module.activateSessionFeatures(featureContext, reason);
    }
    perf.setPhase('active', { reason });
  }

  async function deactivateSessionRuntime(reason: string) {
    if (!sessionRuntimeModule) {
      return;
    }
    if (typeof sessionRuntimeModule.deactivateSessionFeatures === 'function') {
      await sessionRuntimeModule.deactivateSessionFeatures(featureContext, reason);
    }
    perf.setPhase('route-ready', { reason });
  }

  return {
    helper,
    async start() {
      const loadedSettings = await loadExtensionSettings();
      applySettings(loadedSettings);

      perf.setPhase('route-ready', { reason: 'kernel-start' });
      registerLifecycle(helper);
    },
    async onLoaded() {
      await activateSessionRuntime('kernel-on-loaded');
    },
    async stop() {
      if (sessionRuntimeModule && typeof sessionRuntimeModule.stopSessionRuntime === 'function') {
        await sessionRuntimeModule.stopSessionRuntime(featureContext);
      }
      disposerStack.flush();
      if (typeof helper.runtime.disposeLifecycle === 'function') {
        helper.runtime.disposeLifecycle();
      }
      if (typeof helper.unbindCutPreview === 'function') {
        helper.unbindCutPreview();
      }
      if (typeof helper.unbindMagnifier === 'function') {
        helper.unbindMagnifier();
      }
      if (typeof helper.unbindWaveformScaleUnlock === 'function') {
        helper.unbindWaveformScaleUnlock();
      }
      if (typeof helper.unbindZoomPersistence === 'function') {
        helper.unbindZoomPersistence();
      }
      if (typeof helper.unbindRowTracking === 'function') {
        helper.unbindRowTracking();
      }
    }
  };
}
