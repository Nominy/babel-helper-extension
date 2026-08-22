import { installLegacyServiceProvider } from '../core/legacy-service-provider';
import type { FeatureContext } from '../core/types';
import type { Scope } from '../mod-platform/scope';
import { createActionMenuService } from './action-menu-service';
import { createBridgeClientService } from './bridge-client-service';
import { createFocusService } from './focus-service';
import { registerHotkeysHelpService } from './hotkeys-help-service';
import { createHotkeysHelpServiceFacade } from './hotkeys-help-service-facade';
import { registerMagnifierService } from './magnifier-service';
import { createMagnifierServiceFacade } from './magnifier-service-facade';
import { registerMinimapService } from './minimap-service';
import { createMinimapServiceFacade } from './minimap-service-facade';
import { registerRowService } from './row-service';
import { createRowServiceFacade } from './row-service-facade';
import { createSmartSplitService } from './smart-split-service';
import { registerTimelineSelectionService } from './timeline-selection-service';
import { createTimelineSelectionServiceFacade } from './timeline-selection-service-facade';
import { registerTimestampEditService } from './timestamp-edit-service';
import { createTimestampEditServiceFacade } from './timestamp-edit-service-facade';
import { registerWaveformScaleService } from './waveform-scale-service';
import { createWaveformScaleServiceFacade } from './waveform-scale-service-facade';

export type SessionServiceScopes = Scope[];

export function installRowServiceProviders(ctx: FeatureContext): SessionServiceScopes {
  return [
    installLegacyServiceProvider(
      ctx,
      'rows',
      () => registerRowService(ctx.helper),
      () => createRowServiceFacade(ctx.helper),
      ['unbindRowTracking']
    ),
    installLegacyServiceProvider(ctx, 'actions', undefined, () => createActionMenuService(ctx.helper)),
    installLegacyServiceProvider(ctx, 'focus', undefined, () => createFocusService(ctx.helper)),
    installLegacyServiceProvider(ctx, 'bridge', undefined, () => createBridgeClientService(ctx.helper))
  ];
}

export function installHotkeysHelpServiceProvider(ctx: FeatureContext): Scope {
  return installLegacyServiceProvider(
    ctx,
    'hotkeysHelp',
    () => registerHotkeysHelpService(ctx.helper),
    () => createHotkeysHelpServiceFacade(ctx.helper)
  );
}

export function installTimelineSelectionServiceProviders(ctx: FeatureContext): SessionServiceScopes {
  return [
    installLegacyServiceProvider(
      ctx,
      'timelineSelection',
      () => registerTimelineSelectionService(ctx.helper),
      () => createTimelineSelectionServiceFacade(ctx.helper),
      ['clearCutPreview', 'unbindCutPreview', 'unbindNativeTimelineDoubleClickBlocker', 'unbindZoomPersistence']
    ),
    installLegacyServiceProvider(ctx, 'smartSplit', undefined, () => createSmartSplitService(ctx.helper))
  ];
}

export function installTimestampEditServiceProvider(ctx: FeatureContext): Scope {
  return installLegacyServiceProvider(
    ctx,
    'timestampEdit',
    () => registerTimestampEditService(ctx.helper),
    () => createTimestampEditServiceFacade(ctx.helper)
  );
}

export function installWaveformScaleServiceProvider(ctx: FeatureContext): Scope {
  return installLegacyServiceProvider(
    ctx,
    'waveformScale',
    () => registerWaveformScaleService(ctx.helper),
    () => createWaveformScaleServiceFacade(ctx.helper),
    ['unbindWaveformScaleUnlock']
  );
}

export function installMagnifierServiceProvider(ctx: FeatureContext): Scope {
  return installLegacyServiceProvider(
    ctx,
    'magnifier',
    () => registerMagnifierService(ctx.helper),
    () => createMagnifierServiceFacade(ctx.helper),
    ['clearMagnifier', 'unbindMagnifier']
  );
}

export function installMinimapServiceProvider(ctx: FeatureContext): Scope {
  return installLegacyServiceProvider(
    ctx,
    'minimap',
    () => registerMinimapService(ctx.helper),
    () => createMinimapServiceFacade(ctx.helper),
    ['clearMinimap', 'unbindMinimap']
  );
}

export async function disposeSessionServiceScopes(
  scopes: SessionServiceScopes,
  reason = 'session-services-dispose'
): Promise<void> {
  const errors: unknown[] = [];
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    try {
      await scopes[index].dispose(reason);
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  scopes.length = 0;
  if (errors.length) {
    throw errors[0];
  }
}
