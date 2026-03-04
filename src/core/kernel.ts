import { createConfig } from './config';
import { createState } from './state-store';
import { createLogger } from './logger';
import { isEditable, isVisible, normalizeText, setEditableValue, dispatchClick, sleep, waitFor } from '../hooks/dom';
import { registerRowService } from '../services/row-service';
import { registerHotkeysHelpService } from '../services/hotkeys-help-service';
import { registerTimelineSelectionService } from '../services/timeline-selection-service';
import { registerMagnifierService } from '../services/magnifier-service';
import { registerLifecycle } from './lifecycle';
import { createDisposerStack } from './disposables';
import type { FeatureContext, FeatureModule, ServiceRegistry } from './types';
import { createFeatureModules } from '../features';

export function createHelperKernel() {
  const config = createConfig();
  const state = createState();

  const helper: any = {
    config,
    state,
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

  registerRowService(helper);
  registerHotkeysHelpService(helper);
  registerTimelineSelectionService(helper);
  registerMagnifierService(helper);

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
    magnifier: helper,
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

  const features = createFeatureModules();

  const runFeatures = async (method: 'register' | 'start' | 'stop') => {
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
      await runFeatures('register');
      await runFeatures('start');
      registerLifecycle(helper);
    },
    async stop() {
      await runFeatures('stop');
      disposerStack.flush();
      if (typeof helper.unbindCutPreview === 'function') {
        helper.unbindCutPreview();
      }
      if (typeof helper.unbindMagnifier === 'function') {
        helper.unbindMagnifier();
      }
      if (typeof helper.unbindRowTracking === 'function') {
        helper.unbindRowTracking();
      }
    }
  };
}
