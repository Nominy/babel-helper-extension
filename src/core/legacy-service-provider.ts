import type { BuiltinServiceMap } from './service-contracts';
import type { FeatureContext } from './types';
import type { Scope } from '../mod-platform/scope';

/**
 * Enrolls an existing helper-mutating registration in an owned service scope.
 * The helper stays an implementation detail; consumers only receive the typed facade.
 */
export function installLegacyServiceProvider<K extends keyof BuiltinServiceMap>(
  ctx: FeatureContext,
  key: K,
  register: (() => void) | undefined,
  createFacade: () => BuiltinServiceMap[K],
  cleanupMethods: readonly string[] = []
): Scope {
  const scope = ctx.scope.child(`builtin:${String(key)}`);
  try {
    register?.();
    const helper = ctx.helper as Record<string, unknown>;
    for (const method of cleanupMethods) {
      scope.defer(() => {
        const cleanup = helper[method];
        if (typeof cleanup === 'function') {
          Reflect.apply(cleanup, ctx.helper, []);
        }
      });
    }
    ctx.services.provide(key, createFacade(), { scope });
    return scope;
  } catch (error: unknown) {
    void scope.dispose('service-registration-failed');
    throw error;
  }
}
