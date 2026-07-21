import type { FeatureContext, FeatureModule } from '../core/types';
import { createFeatureModules } from '../features';
import { registerHotkeysHelpService } from '../services/hotkeys-help-service';
import { registerMagnifierService } from '../services/magnifier-service';
import { registerMinimapService } from '../services/minimap-service';
import { registerRecoveredEditorSnapshotService } from '../services/recovered-editor-snapshot-service';
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

type FeatureHook = Exclude<keyof FeatureModule, 'id' | 'dependsOn'>;

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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportRuntimeError(ctx: FeatureContext, stage: string, id: string, error: unknown) {
  const message = getErrorMessage(error);
  ctx.helper.perf?.count?.('session-runtime.error', { stage, id, message });
  ctx.logger?.warn?.('[babel-helper] session runtime error', stage, id, message);
}

function registerSessionServices(ctx: FeatureContext): boolean {
  const runtime = getRuntime();
  if (runtime.servicesRegistered) {
    return true;
  }

  const { helper } = ctx;
  let failures = 0;
  const register = (id: string, fn: () => void) => {
    try {
      fn();
    } catch (error: unknown) {
      failures += 1;
      reportRuntimeError(ctx, 'service.register', id, error);
    }
  };

  register('recovered-editor-snapshot', () => registerRecoveredEditorSnapshotService(helper));
  register('row', () => registerRowService(helper));
  register('timestamp-edit', () => registerTimestampEditService(helper));

  if (isFeatureEnabled(ctx, 'hotkeysHelp')) {
    register('hotkeys-help', () => registerHotkeysHelpService(helper));
  }
  if (isFeatureEnabled(ctx, 'timelineSelection') || isFeatureEnabled(ctx, 'disableNativeTimelineDoubleClick')) {
    register('timeline-selection', () => registerTimelineSelectionService(helper));
  }
  if (isFeatureEnabled(ctx, 'waveformScaleUnlock')) {
    registerWaveformScaleService(helper);
  }
  if (isFeatureEnabled(ctx, 'magnifier')) {
    register('magnifier', () => registerMagnifierService(helper));
  }
  if (isFeatureEnabled(ctx, 'minimap')) {
    register('minimap', () => registerMinimapService(helper));
  }

  runtime.servicesRegistered = failures === 0;
  helper.perf?.count?.('session.services.registered', { failures });
  return runtime.servicesRegistered;
}

async function invokeFeatureHook(
  ctx: FeatureContext,
  feature: FeatureModule,
  method: FeatureHook,
  reason: string
) {
  switch (method) {
    case 'load':
      await feature.load?.(ctx);
      return;
    case 'register':
      feature.register?.(ctx);
      return;
    case 'start':
      await feature.start?.(ctx);
      return;
    case 'onLoaded':
      await feature.onLoaded?.(ctx);
      return;
    case 'activate':
      await feature.activate?.(ctx, reason);
      return;
    case 'deactivate':
      await feature.deactivate?.(ctx, reason);
      return;
    case 'stop':
      await feature.stop?.(ctx);
      return;
  }
}

async function runFeatures(ctx: FeatureContext, method: FeatureHook, reason?: string) {
  const runtime = getRuntime();
  const activationReason = reason || String(method);
  for (const feature of runtime.features) {
    const hook = feature[method];
    if (typeof hook !== 'function') {
      continue;
    }
    ctx.helper.perf?.count?.(`feature.${String(method)}`, { id: feature.id, reason: activationReason });
    try {
      await invokeFeatureHook(ctx, feature, method, activationReason);
    } catch (error: unknown) {
      reportRuntimeError(ctx, `feature.${String(method)}`, feature.id, error);
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
    try {
      if (typeof feature.activate === 'function') {
        ctx.helper.perf?.count?.('feature.activate', { id: feature.id, reason });
        await feature.activate(ctx, reason);
      }
      runtime.activeFeatures.add(feature.id);
    } catch (error: unknown) {
      reportRuntimeError(ctx, 'feature.activate', feature.id, error);
    }
  }
}

export async function deactivateSessionFeatures(ctx: FeatureContext, reason = 'session-clear') {
  const runtime = getRuntime();
  for (const feature of runtime.features) {
    if (!runtime.activeFeatures.has(feature.id)) {
      continue;
    }
    try {
      if (typeof feature.deactivate === 'function') {
        ctx.helper.perf?.count?.('feature.deactivate', { id: feature.id, reason });
        await feature.deactivate(ctx, reason);
      }
    } catch (error: unknown) {
      reportRuntimeError(ctx, 'feature.deactivate', feature.id, error);
    } finally {
      runtime.activeFeatures.delete(feature.id);
    }
  }
}

export async function stopSessionRuntime(ctx: FeatureContext) {
  const runtime = getRuntime();
  await deactivateSessionFeatures(ctx, 'stop');
  await runFeatures(ctx, 'stop', 'stop');
  runtime.started = false;
  runtime.servicesRegistered = false;
  runtime.features = [];
  runtime.activeFeatures.clear();
}
