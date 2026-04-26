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
import { registerRowService } from '../services/row-service';
import { registerTimestampEditService } from '../services/timestamp-edit-service';
import { registerHotkeysHelpService } from '../services/hotkeys-help-service';
import { registerTimelineSelectionService } from '../services/timeline-selection-service';
import { registerWaveformScaleService } from '../services/waveform-scale-service';
import { registerMagnifierService } from '../services/magnifier-service';
import { registerMinimapService } from '../services/minimap-service';
import { registerLifecycle } from './lifecycle';
import { createDisposerStack } from './disposables';
import type { FeatureContext, FeatureModule, ServiceRegistry } from './types';
import { createFeatureModules } from '../features';
import { createAnalyticsStore } from './analytics-store';

function cloneSettings(settings: ExtensionSettings): ExtensionSettings {
  return normalizeExtensionSettings(settings);
}

export function createHelperKernel() {
  const state = createState();
  let settings = cloneSettings(DEFAULT_EXTENSION_SETTINGS);
  const config = createConfig(settings.features);
  const analytics = createAnalyticsStore();

  const helper: any = {
    config,
    settings,
    state,
    analytics,
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
        return runFeatures('onLoaded');
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

  function registerServices() {
    registerRowService(helper);
    registerTimestampEditService(helper);

    if (helper.isFeatureEnabled('hotkeysHelp')) {
      registerHotkeysHelpService(helper);
    }

    if (helper.isFeatureEnabled('timelineSelection')) {
      registerTimelineSelectionService(helper);
    }

    if (helper.isFeatureEnabled('waveformScaleUnlock')) {
      registerWaveformScaleService(helper);
    }

    if (helper.isFeatureEnabled('magnifier')) {
      registerMagnifierService(helper);
    }

    if (helper.isFeatureEnabled('minimap')) {
      registerMinimapService(helper);
    }
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

  let features: FeatureModule[] = [];

  const runFeatures = async (method: 'register' | 'start' | 'stop' | 'onLoaded') => {
    for (const feature of features) {
      const fn = feature[method];
      if (typeof fn === 'function') {
        await fn(featureContext);
      }
    }
  };

  return {
    helper,
    async start() {
      const loadedSettings = await loadExtensionSettings();
      applySettings(loadedSettings);

      registerServices();
      features = createFeatureModules(helper.settings.features);

      await runFeatures('register');
      await runFeatures('start');
      registerLifecycle(helper);
    },
    async onLoaded() {
      await runFeatures('onLoaded');
    },
    async stop() {
      await runFeatures('stop');
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
