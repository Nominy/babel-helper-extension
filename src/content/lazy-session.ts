import type { FeatureContext, FeatureModule } from '../core/types';
import { createFeatureModules } from '../features';
import { registerHotkeysHelpService } from '../services/hotkeys-help-service';
import { registerMagnifierService } from '../services/magnifier-service';
import { registerMinimapService } from '../services/minimap-service';
import { registerRowService } from '../services/row-service';
import { registerTimelineSelectionService } from '../services/timeline-selection-service';
import { registerTimestampEditService } from '../services/timestamp-edit-service';
import { registerWaveformScaleService } from '../services/waveform-scale-service';

type SessionRuntime = {
  features: FeatureModule[];
  servicesRegistered: boolean;
  started: boolean;
  activeFeatures: Set<string>;
};

declare global {
  interface Window {
    __babelHelperSessionRuntime?: SessionRuntime;
  }
}

function getRuntime(): SessionRuntime {
  if (!window.__babelHelperSessionRuntime) {
    window.__babelHelperSessionRuntime = {
      features: [],
      servicesRegistered: false,
      started: false,
      activeFeatures: new Set()
    };
  }
  return window.__babelHelperSessionRuntime;
}

function isFeatureEnabled(ctx: FeatureContext, key: string) {
  return typeof ctx.helper.isFeatureEnabled === 'function'
    ? ctx.helper.isFeatureEnabled(key)
    : true;
}

function registerSessionServices(ctx: FeatureContext) {
  const runtime = getRuntime();
  if (runtime.servicesRegistered) {
    return;
  }

  const { helper } = ctx;
  registerRowService(helper);
  registerTimestampEditService(helper);

  if (isFeatureEnabled(ctx, 'hotkeysHelp')) {
    registerHotkeysHelpService(helper);
  }
  if (isFeatureEnabled(ctx, 'timelineSelection')) {
    registerTimelineSelectionService(helper);
  }
  if (isFeatureEnabled(ctx, 'waveformScaleUnlock')) {
    registerWaveformScaleService(helper);
  }
  if (isFeatureEnabled(ctx, 'magnifier')) {
    registerMagnifierService(helper);
  }
  if (isFeatureEnabled(ctx, 'minimap')) {
    registerMinimapService(helper);
  }

  runtime.servicesRegistered = true;
  helper.perf?.count?.('session.services.registered');
}

async function runFeatures(ctx: FeatureContext, method: keyof FeatureModule, reason?: string) {
  const runtime = getRuntime();
  const activationReason = reason || String(method);
  for (const feature of runtime.features) {
    const fn = feature[method];
    if (typeof fn === 'function') {
      ctx.helper.perf?.count?.(`feature.${String(method)}`, { id: feature.id, reason: activationReason });
      await (fn as any)(ctx, activationReason);
    }
  }
}

export async function ensureSessionRuntime(ctx: FeatureContext, reason = 'session-ready') {
  const runtime = getRuntime();
  registerSessionServices(ctx);

  if (!runtime.features.length) {
    runtime.features = createFeatureModules(ctx.helper.settings.features);
  }

  if (runtime.started) {
    return;
  }

  ctx.helper.perf?.mark?.('session-runtime-start');
  await runFeatures(ctx, 'load', reason);
  await runFeatures(ctx, 'register', reason);
  await runFeatures(ctx, 'start', reason);
  runtime.started = true;
  ctx.helper.perf?.measure?.('session-runtime-start', 'session-runtime-start');
}

export async function activateSessionFeatures(ctx: FeatureContext, reason = 'session-ready') {
  const runtime = getRuntime();
  await ensureSessionRuntime(ctx, reason);
  await runFeatures(ctx, 'onLoaded', reason);
  for (const feature of runtime.features) {
    if (runtime.activeFeatures.has(feature.id)) {
      continue;
    }
    if (typeof feature.activate === 'function') {
      ctx.helper.perf?.count?.('feature.activate', { id: feature.id, reason });
      await feature.activate(ctx, reason);
    }
    runtime.activeFeatures.add(feature.id);
  }
}

export async function deactivateSessionFeatures(ctx: FeatureContext, reason = 'session-clear') {
  const runtime = getRuntime();
  for (const feature of runtime.features) {
    if (!runtime.activeFeatures.has(feature.id)) {
      continue;
    }
    if (typeof feature.deactivate === 'function') {
      ctx.helper.perf?.count?.('feature.deactivate', { id: feature.id, reason });
      await feature.deactivate(ctx, reason);
    }
    runtime.activeFeatures.delete(feature.id);
  }
}

export async function stopSessionRuntime(ctx: FeatureContext) {
  const runtime = getRuntime();
  await deactivateSessionFeatures(ctx, 'stop');
  await runFeatures(ctx, 'stop', 'stop');
  runtime.started = false;
  runtime.features = [];
  runtime.activeFeatures.clear();
}
