import {
  createServiceRegistry,
  type ServiceRegistry as SharedServiceRegistry
} from '../mod-platform/service-registry';
import { BUILTIN_SERVICE_KEYS, type BuiltinServiceMap } from './service-contracts';

export type BuiltinServiceHandles = {
  readonly [K in keyof BuiltinServiceMap]: BuiltinServiceMap[K];
};

export type BuiltinServiceRegistry = SharedServiceRegistry<BuiltinServiceMap> & BuiltinServiceHandles;

/**
 * Presents the shared keyed registry through the historical property-shaped feature API.
 * Each property is a captured late-bound handle, not the provider that happened to be
 * installed when the kernel was created.
 */
export function createBuiltinServiceRegistry(
  registry: SharedServiceRegistry<BuiltinServiceMap> = createServiceRegistry<BuiltinServiceMap>()
): BuiltinServiceRegistry {
  const handles = Object.create(null) as Record<keyof BuiltinServiceMap, unknown>;
  for (const key of BUILTIN_SERVICE_KEYS) {
    handles[key] = registry.get(key);
  }

  const boundMethods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(registry, {
    get(target, property) {
      if (typeof property === 'string' && Object.prototype.hasOwnProperty.call(handles, property)) {
        return handles[property as keyof BuiltinServiceMap];
      }

      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }

      const existing = boundMethods.get(property);
      if (existing) {
        return existing;
      }

      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      boundMethods.set(property, bound);
      return bound;
    }
  }) as BuiltinServiceRegistry;
}
