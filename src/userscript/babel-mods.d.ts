export {};

declare global {
  type BabelModsMaybePromise<T> = T | Promise<T>;
  type BabelModsDisposer = () => BabelModsMaybePromise<void>;
  type BabelModsDisposable = BabelModsDisposer | { dispose(): BabelModsMaybePromise<void> };
  type BabelModsDependency = string | { id: string; version?: string };

  interface BabelModsScope {
    readonly signal: AbortSignal;
    add<T extends BabelModsDisposable>(disposable: T): T;
    child(label?: string): BabelModsScope;
    dispose(): Promise<void>;
  }

  interface BabelModsLogger {
    debug(message: string, ...details: unknown[]): void;
    info(message: string, ...details: unknown[]): void;
    warn(message: string, ...details: unknown[]): void;
    error(message: string, ...details: unknown[]): void;
  }

  interface BabelModsEventBus {
    on<T = unknown>(type: string, listener: (payload: T) => void, options?: { signal?: AbortSignal }): { dispose(): void };
    emit<T = unknown>(type: string, payload: T): void;
  }

  interface BabelModsContributionRegistry {
    add<T>(registry: string, contribution: T, options?: { id?: string; priority?: number }): { dispose(): void };
    list<T>(registry: string): readonly T[];
  }

  interface BabelModsServiceAccess {
    get<T extends object = Record<string, unknown>>(id: string): T;
    optional<T extends object = Record<string, unknown>>(id: string): T | undefined;
    invoke<TResult = unknown>(id: string, method: PropertyKey, ...args: unknown[]): TResult;
  }

  interface BabelModsServiceControl extends BabelModsServiceAccess {
    provide<T extends object>(id: string, service: T | (() => T), options?: { priority?: number }): { dispose(): void };
    replace<T extends object>(id: string, service: T | (() => T), options?: { priority?: number }): { dispose(): void };
    decorate<T extends object>(id: string, decorator: (next: T) => T, options?: { priority?: number }): { dispose(): void };
    intercept<TArgs extends unknown[], TResult>(
      id: string,
      method: PropertyKey,
      interceptor: (call: {
        args: TArgs;
        next(...args: TArgs): TResult;
        service: object;
      }) => TResult,
      options?: { priority?: number }
    ): { dispose(): void };
  }

  interface BabelModsPatchStack {
    patch<T extends object, K extends keyof T>(
      target: T,
      key: K,
      patcher: (next: T[K]) => T[K],
      options?: { priority?: number }
    ): { dispose(): void };
    decorate<T extends object, K extends keyof T>(
      target: T,
      key: K,
      patcher: (next: T[K]) => T[K],
      options?: { priority?: number }
    ): { dispose(): void };
    patchDescriptor<T extends object, K extends keyof T>(
      target: T,
      key: K,
      patcher: (descriptor: Readonly<PropertyDescriptor>) => PropertyDescriptor,
      options?: { priority?: number }
    ): { dispose(): void };
    replace<T extends object, K extends keyof T>(
      target: T,
      key: K,
      value: T[K],
      options?: { priority?: number }
    ): { dispose(): void };
  }

  interface BabelModsUnsafeApi {
    readonly services: BabelModsServiceControl;
    readonly patches: BabelModsPatchStack;
    readonly events: BabelModsEventBus;
    readonly registries: BabelModsContributionRegistry;
    readonly window: Window;
  }

  interface BabelModMetadata {
    readonly id: string;
    readonly name?: string;
    readonly version?: string;
    readonly apiVersion: 1;
    readonly requires?: readonly BabelModsDependency[];
    readonly optional?: readonly BabelModsDependency[];
    readonly before?: readonly string[];
    readonly after?: readonly string[];
  }

  interface BabelModContext {
    readonly mod: Readonly<BabelModMetadata>;
    readonly scope: BabelModsScope;
    readonly signal: AbortSignal;
    readonly events: BabelModsEventBus;
    readonly registries: BabelModsContributionRegistry;
    readonly services: BabelModsServiceAccess & BabelModsServiceControl;
    readonly logger: BabelModsLogger;
    readonly unsafe: BabelModsUnsafeApi;
  }

  interface BabelModDefinition {
    id: string;
    name?: string;
    version?: string;
    apiVersion?: 1;
    requires?: readonly BabelModsDependency[];
    optional?: readonly BabelModsDependency[];
    before?: readonly string[];
    after?: readonly string[];
    setup?(context: BabelModContext): BabelModsMaybePromise<void | BabelModsDisposable>;
    activate?(context: BabelModContext): BabelModsMaybePromise<void | BabelModsDisposable>;
    deactivate?(context: BabelModContext): BabelModsMaybePromise<void>;
    dispose?(context: BabelModContext): BabelModsMaybePromise<void>;
  }

  interface BabelModsDiagnostic {
    readonly sequence: number;
    readonly timestamp: number;
    readonly level: 'info' | 'warning' | 'error';
    readonly code: string;
    readonly message: string;
    readonly modId?: string;
    readonly generation?: number;
    readonly error?: unknown;
  }

  interface BabelModsDiagnostics {
    list(): readonly BabelModsDiagnostic[];
    subscribe(listener: (diagnostic: BabelModsDiagnostic) => void): { dispose(): void };
    clear(): void;
  }

  interface BabelModsRegistration {
    dispose(): void | Promise<void>;
  }

  interface BabelModsHost {
    readonly apiVersion: 1;
    readonly internalsVersion: string;
    readonly unsafe: BabelModsUnsafeApi;
    readonly registries: {
      get<T = unknown>(registry: string): readonly T[];
    };
    readonly diagnostics: BabelModsDiagnostics;
    define<T extends BabelModDefinition>(definition: T): T & { apiVersion: 1 };
    register(definition: BabelModDefinition): BabelModsRegistration;
  }

  interface BabelModsClient {
    readonly apiVersion: 1;
    define<T extends BabelModDefinition>(definition: T): T & { apiVersion: 1 };
    defineMod<T extends BabelModDefinition>(definition: T): T & { apiVersion: 1 };
    registerMod(definition: BabelModDefinition): BabelModsRegistration;
    register(definition: BabelModDefinition): BabelModsRegistration;
    getHost(): BabelModsHost | undefined;
    isCompatible(host?: Pick<BabelModsHost, 'apiVersion'>): boolean;
    requireCompatible(host?: Pick<BabelModsHost, 'apiVersion'>): BabelModsHost;
  }

  interface Window {
    BabelMods?: BabelModsHost;
    BabelModsSDK?: BabelModsClient;
    __BABEL_MOD_QUEUE__?: BabelModDefinition[];
  }

  const BabelModsSDK: BabelModsClient;
}
