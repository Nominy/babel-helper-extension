import type { FeatureContext, FeatureModule } from '../core/types';
import { createFeatureModules } from '../features';
import type { Scope } from '../mod-platform/scope';
import { registerRecoveredEditorSnapshotService } from '../services/recovered-editor-snapshot-service';
import {
  disposeSessionServiceScopes,
  installHotkeysHelpServiceProvider,
  installMagnifierServiceProvider,
  installMinimapServiceProvider,
  installRowServiceProviders,
  installTimelineSelectionServiceProviders,
  installTimestampEditServiceProvider,
  installWaveformScaleServiceProvider,
  type SessionServiceScopes
} from '../services/builtin-service-adapters';

type SessionRuntime = {
  features: FeatureModule[];
  servicesRegistered: boolean;
  serviceScopes: SessionServiceScopes;
  started: boolean;
  activeFeatures: Set<string>;
  transitionRevision: number;
  transitionTail: Promise<void>;
  startPromise: Promise<boolean> | null;
  stopPromise: Promise<void> | null;
  stopping: boolean;
  stopped: boolean;
};

type FeatureHook = Exclude<keyof FeatureModule, 'id' | 'dependsOn'>;

const sessionRuntimes = new WeakMap<FeatureContext, SessionRuntime>();

function getRuntime(ctx: FeatureContext): SessionRuntime {
  let runtime = sessionRuntimes.get(ctx);
  if (!runtime) {
    runtime = {
      features: [],
      servicesRegistered: false,
      serviceScopes: [],
      started: false,
      activeFeatures: new Set(),
      transitionRevision: 0,
      transitionTail: Promise.resolve(),
      startPromise: null,
      stopPromise: null,
      stopping: false,
      stopped: false
    };
    sessionRuntimes.set(ctx, runtime);
  }
  return runtime;
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

async function registerSessionServices(ctx: FeatureContext): Promise<boolean> {
  const runtime = getRuntime(ctx);
  if (runtime.servicesRegistered) {
    return true;
  }

  const { helper } = ctx;
  let failures = 0;
  const register = (id: string, fn: () => Scope | SessionServiceScopes | void) => {
    try {
      const owned = fn();
      if (Array.isArray(owned)) {
        runtime.serviceScopes.push(...owned);
      } else if (owned) {
        runtime.serviceScopes.push(owned as Scope);
      }
    } catch (error: unknown) {
      failures += 1;
      reportRuntimeError(ctx, 'service.register', id, error);
    }
  };

  register('recovered-editor-snapshot', () => registerRecoveredEditorSnapshotService(helper));
  register('row', () => installRowServiceProviders(ctx));
  register('timestamp-edit', () => installTimestampEditServiceProvider(ctx));

  if (isFeatureEnabled(ctx, 'hotkeysHelp')) {
    register('hotkeys-help', () => installHotkeysHelpServiceProvider(ctx));
  }
  if (isFeatureEnabled(ctx, 'timelineSelection') || isFeatureEnabled(ctx, 'disableNativeTimelineDoubleClick')) {
    register('timeline-selection', () => installTimelineSelectionServiceProviders(ctx));
  }
  if (isFeatureEnabled(ctx, 'waveformScaleUnlock')) {
    register('waveform-scale', () => installWaveformScaleServiceProvider(ctx));
  }
  if (isFeatureEnabled(ctx, 'magnifier')) {
    register('magnifier', () => installMagnifierServiceProvider(ctx));
  }
  if (isFeatureEnabled(ctx, 'minimap')) {
    register('minimap', () => installMinimapServiceProvider(ctx));
  }

  runtime.servicesRegistered = failures === 0;
  if (failures > 0) {
    try {
      await disposeSessionServiceScopes(runtime.serviceScopes, 'service-registration-failed');
    } catch (error: unknown) {
      reportRuntimeError(ctx, 'service.dispose', 'registration-failed', error);
    }
  }
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
  const runtime = getRuntime(ctx);
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
  const runtime = getRuntime(ctx);
  if (runtime.stopping || runtime.stopped) {
    return false;
  }
  await registerSessionServices(ctx);

  if (!runtime.features.length) {
    runtime.features = createFeatureModules(ctx.helper.settings.features);
  }

  if (runtime.started) {
    return true;
  }
  if (!runtime.startPromise) {
    runtime.startPromise = (async () => {
      ctx.helper.perf?.mark?.('session-runtime-start');
      await runFeatures(ctx, 'load', reason);
      await runFeatures(ctx, 'register', reason);
      await runFeatures(ctx, 'start', reason);
      runtime.started = true;
      ctx.helper.perf?.measure?.('session-runtime-start', 'session-runtime-start');
      return !runtime.stopping && !runtime.stopped;
    })().finally(() => {
      runtime.startPromise = null;
    });
  }
  return runtime.startPromise;
}

function enqueueTransition<T>(runtime: SessionRuntime, operation: () => Promise<T>): Promise<T> {
  const result = runtime.transitionTail.then(operation);
  runtime.transitionTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function deactivateActiveFeatures(
  ctx: FeatureContext,
  runtime: SessionRuntime,
  reason: string
) {
  let changed = false;
  for (const feature of runtime.features) {
    if (!runtime.activeFeatures.has(feature.id)) {
      continue;
    }
    changed = true;
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
  return changed;
}

export function activateSessionFeatures(ctx: FeatureContext, reason = 'session-ready') {
  const runtime = getRuntime(ctx);
  const transitionRevision = ++runtime.transitionRevision;
  return enqueueTransition(runtime, async () => {
    if (
      runtime.stopping ||
      runtime.stopped ||
      transitionRevision !== runtime.transitionRevision
    ) {
      return false;
    }

    const ready = await ensureSessionRuntime(ctx, reason);
    if (
      !ready ||
      runtime.stopping ||
      runtime.stopped ||
      transitionRevision !== runtime.transitionRevision
    ) {
      return false;
    }

    await runFeatures(ctx, 'onLoaded', reason);
    for (const feature of runtime.features) {
      if (
        runtime.stopping ||
        runtime.stopped ||
        transitionRevision !== runtime.transitionRevision
      ) {
        break;
      }
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

    if (
      runtime.stopping ||
      runtime.stopped ||
      transitionRevision !== runtime.transitionRevision
    ) {
      await deactivateActiveFeatures(ctx, runtime, `stale:${reason}`);
      return false;
    }
    return true;
  });
}

export function deactivateSessionFeatures(ctx: FeatureContext, reason = 'session-clear') {
  const runtime = getRuntime(ctx);
  ++runtime.transitionRevision;
  return enqueueTransition(runtime, async () => {
    if (runtime.stopped) {
      return false;
    }
    await deactivateActiveFeatures(ctx, runtime, reason);
    return true;
  });
}

export function stopSessionRuntime(ctx: FeatureContext, reason = 'kernel-stop') {
  const runtime = getRuntime(ctx);
  if (runtime.stopPromise) {
    return runtime.stopPromise;
  }

  runtime.stopping = true;
  ++runtime.transitionRevision;
  runtime.stopPromise = enqueueTransition(runtime, async () => {
    if (runtime.startPromise) {
      await runtime.startPromise.catch(() => false);
    }
    await deactivateActiveFeatures(ctx, runtime, reason);
    if (runtime.started) {
      await runFeatures(ctx, 'stop', reason);
    }
    try {
      await disposeSessionServiceScopes(runtime.serviceScopes, reason);
    } catch (error: unknown) {
      reportRuntimeError(ctx, 'service.dispose', 'session', error);
    }
    runtime.started = false;
    runtime.servicesRegistered = false;
    runtime.features = [];
    runtime.activeFeatures.clear();
    runtime.stopped = true;
  });
  return runtime.stopPromise;
}
