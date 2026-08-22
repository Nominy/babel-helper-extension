import type { Scope } from '../mod-platform/scope';
import type { BuiltinServiceRegistry } from './service-registry';

export type Disposer = () => void;

export interface FeatureContext {
  helper: any;
  services: ServiceRegistry;
  scope: Scope;
  state: any;
  config: any;
  runtime: any;
  onDispose: (disposer: Disposer) => void;
  logger: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface FeatureModule {
  id: string;
  dependsOn?: string[];
  load?: (ctx: FeatureContext) => void | Promise<void>;
  activate?: (ctx: FeatureContext, reason: string) => void | Promise<void>;
  deactivate?: (ctx: FeatureContext, reason: string) => void | Promise<void>;
  register?: (ctx: FeatureContext) => void;
  start?: (ctx: FeatureContext) => void | Promise<void>;
  onLoaded?: (ctx: FeatureContext) => void | Promise<void>;
  stop?: (ctx: FeatureContext) => void | Promise<void>;
}

export type ServiceRegistry = BuiltinServiceRegistry;

