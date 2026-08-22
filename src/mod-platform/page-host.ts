import { createContributionRegistry } from './contribution-registry';
import { createEventBus } from './event-bus';
import { createPatchStack } from './patch-stack';
import {
  BABEL_MOD_CONTROLLER_EVENT,
  BABEL_MOD_GLOBAL_NAME,
  BABEL_MOD_HOST_READY_EVENT,
  BABEL_MOD_QUEUE_NAME,
  CONTROLLER_PROTOCOL_VERSION,
  MOD_API_VERSION,
  isControllerTransition,
  type ControllerTransition,
  type HostReadyDetail
} from './protocol';
import { createScope, type DisposableValue, type MaybePromise, type Scope } from './scope';
import { createServiceRegistry } from './service-registry';

declare const __BABEL_MOD_INTERNALS_VERSION__: string;

const HOST_MARKER = Symbol.for('babel-mods.page-host');
const PENDING_REGISTRATION = Symbol.for('babel-mods.pending-registration');
const MAX_DIAGNOSTICS = 500;

type ServiceMap = Record<string, object>;
type EventMap = Record<string, unknown>;
type ContributionMap = Record<string, unknown>;
type DependencyInput = string | { readonly id: string; readonly version?: string };
type HookResult = void | DisposableValue;
type ModHook = (context: ModContext) => MaybePromise<HookResult>;
type TeardownHook = (context: ModContext) => MaybePromise<void>;
type DiagnosticLevel = 'info' | 'warning' | 'error';
type ExtensionState = 'stopped' | 'started' | 'ready';

export interface ModDefinition {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly apiVersion?: number;
  readonly requires?: readonly DependencyInput[];
  readonly optional?: readonly DependencyInput[];
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly setup?: ModHook;
  readonly activate?: ModHook;
  readonly deactivate?: TeardownHook;
  readonly dispose?: TeardownHook;
}

export interface ModMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: typeof MOD_API_VERSION;
  readonly requires: readonly Readonly<{ id: string; version?: string }>[];
  readonly optional: readonly Readonly<{ id: string; version?: string }>[];
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface ModContext {
  readonly mod: ModMetadata;
  readonly scope: Scope;
  readonly signal: AbortSignal;
  readonly events: Record<string, unknown>;
  readonly registries: Record<string, unknown>;
  readonly services: Record<string, unknown>;
  readonly logger: ModLogger;
  readonly unsafe: Record<string, unknown>;
}

export interface ModLogger {
  debug(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  error(message: string, ...details: unknown[]): void;
}

export interface ModDiagnostic {
  readonly sequence: number;
  readonly timestamp: number;
  readonly level: DiagnosticLevel;
  readonly code: string;
  readonly message: string;
  readonly modId?: string;
  readonly generation?: number;
  readonly error?: unknown;
}

export interface RegistrationHandle {
  dispose(): Promise<void>;
}

export interface BabelModsHost {
  readonly apiVersion: typeof MOD_API_VERSION;
  readonly internalsVersion: string;
  readonly diagnostics: {
    list(): readonly ModDiagnostic[];
    subscribe(listener: (diagnostic: ModDiagnostic) => void): { dispose(): void };
    clear(): void;
  };
  readonly unsafe: Record<string, unknown>;
  define<T extends ModDefinition>(definition: T): T & { apiVersion: typeof MOD_API_VERSION };
  register(definition: ModDefinition): RegistrationHandle;
  readonly registries: {
    get<T = unknown>(point: string): readonly T[];
  };
}

interface HostWindow extends Window {
  BabelMods?: BabelModsHost;
  __BABEL_MOD_QUEUE__?: ModDefinition[];
}

interface StoredMod {
  readonly definition: ModDefinition;
  readonly metadata: ModMetadata;
  readonly owner: symbol;
  readonly sequence: number;
  generation: number;
  status: 'registered' | 'setup' | 'active' | 'failed';
  generationScope?: Scope;
  generationContext?: ModContext;
  activationScope?: Scope;
  activationContext?: ModContext;
  disposed: boolean;
}

interface ResolvedOrder {
  readonly order: StoredMod[];
  readonly unavailable: ReadonlySet<StoredMod>;
}

export function defineMod<T extends ModDefinition>(definition: T): T & { apiVersion: typeof MOD_API_VERSION } {
  validateDefinition(definition);
  if (definition.apiVersion === MOD_API_VERSION) {
    return definition as T & { apiVersion: typeof MOD_API_VERSION };
  }
  return Object.assign({}, definition, { apiVersion: MOD_API_VERSION });
}

export function installPageHost(target: HostWindow = window): BabelModsHost {
  const existing = target[BABEL_MOD_GLOBAL_NAME];
  if (existing) {
    if (existing.apiVersion !== MOD_API_VERSION || !(HOST_MARKER in existing)) {
      throw new Error(`A conflicting ${BABEL_MOD_GLOBAL_NAME} global is already installed.`);
    }
    return existing;
  }

  const internalsVersion =
    typeof __BABEL_MOD_INTERNALS_VERSION__ === 'string'
      ? __BABEL_MOD_INTERNALS_VERSION__
      : 'development';
  const serviceRegistry = createServiceRegistry<ServiceMap>();
  const eventBus = createEventBus<EventMap>();
  const contributionRegistry = createContributionRegistry<ContributionMap>();
  const patchStack = createPatchStack();
  const records = new Map<string, StoredMod>();
  const diagnostics: ModDiagnostic[] = [];
  const diagnosticListeners = new Set<(diagnostic: ModDiagnostic) => void>();
  const reportedIssues = new Set<string>();
  let diagnosticSequence = 0;
  let registrationSequence = 0;
  let contributionSequence = 0;
  let generation = -1;
  let revision = -1;
  let settingsRevision = -1;
  let extensionState: ExtensionState = 'stopped';
  let sessionActive = false;
  let lastTransition: ControllerTransition | undefined;
  let work: Promise<void> = Promise.resolve();

  const report = (
    level: DiagnosticLevel,
    code: string,
    message: string,
    options: { modId?: string; error?: unknown; once?: string } = {}
  ): void => {
    const onceKey = options.once && `${generation}:${options.once}`;
    if (onceKey && reportedIssues.has(onceKey)) return;
    if (onceKey) reportedIssues.add(onceKey);
    const diagnostic: ModDiagnostic = Object.freeze({
      sequence: ++diagnosticSequence,
      timestamp: Date.now(),
      level,
      code,
      message,
      ...(options.modId ? { modId: options.modId } : {}),
      ...(generation >= 0 ? { generation } : {}),
      ...(options.error !== undefined ? { error: options.error } : {})
    });
    diagnostics.push(diagnostic);
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
    for (const listener of [...diagnosticListeners]) {
      try {
        listener(diagnostic);
      } catch (error) {
        console.error('[BabelMods] Diagnostic listener failed.', error);
      }
    }
  };

  const loggerFor = (modId: string): ModLogger => ({
    debug(message, ...details) {
      console.debug(`[BabelMods:${modId}] ${message}`, ...details);
    },
    info(message, ...details) {
      console.info(`[BabelMods:${modId}] ${message}`, ...details);
    },
    warn(message, ...details) {
      report('warning', 'mod-log', message, { modId });
      console.warn(`[BabelMods:${modId}] ${message}`, ...details);
    },
    error(message, ...details) {
      report('error', 'mod-log', message, { modId, error: details[0] });
      console.error(`[BabelMods:${modId}] ${message}`, ...details);
    }
  });

  const globalServices = {
    get: serviceRegistry.get.bind(serviceRegistry),
    optional: serviceRegistry.optional.bind(serviceRegistry),
    provide: serviceRegistry.provide.bind(serviceRegistry),
    replace: serviceRegistry.replace.bind(serviceRegistry),
    decorate: serviceRegistry.decorate.bind(serviceRegistry),
    intercept: serviceRegistry.intercept.bind(serviceRegistry),
    invoke: serviceRegistry.invoke.bind(serviceRegistry),
    removeOwner: serviceRegistry.removeOwner.bind(serviceRegistry)
  };
  const globalEvents = {
    on: eventBus.on.bind(eventBus),
    once: eventBus.once.bind(eventBus),
    emit: eventBus.emit.bind(eventBus),
    emitAsync: eventBus.emitAsync.bind(eventBus),
    clear: eventBus.clear.bind(eventBus)
  };
  const globalRegistries = {
    add: contributionRegistry.add.bind(contributionRegistry),
    register: contributionRegistry.register.bind(contributionRegistry),
    list: contributionRegistry.list.bind(contributionRegistry),
    snapshot: contributionRegistry.snapshot.bind(contributionRegistry),
    values: contributionRegistry.values.bind(contributionRegistry),
    removeOwner: contributionRegistry.removeOwner.bind(contributionRegistry)
  };
  const globalPatches = {
    patch: patchStack.patch.bind(patchStack),
    patchDescriptor: patchStack.patchDescriptor.bind(patchStack),
    replace: patchStack.replace.bind(patchStack),
    decorate: patchStack.decorate.bind(patchStack),
    removeOwner: patchStack.removeOwner.bind(patchStack)
  };

  const createContext = (record: StoredMod, scope: Scope): ModContext => {
    const owner = record.owner;
    const toHandle = (dispose: () => void): { dispose(): void } => ({ dispose });
    const scopedEvents = {
      on(
        type: string,
        listener: (event: unknown) => MaybePromise<void>,
        options: { once?: boolean; priority?: number; signal?: AbortSignal } = {}
      ) {
        return toHandle(eventBus.on(type, listener, { ...options, scope }));
      },
      once(
        type: string,
        listener: (event: unknown) => MaybePromise<void>,
        options: { priority?: number; signal?: AbortSignal } = {}
      ) {
        return toHandle(eventBus.once(type, listener, { ...options, scope }));
      },
      emit(type: string, event: unknown) {
        return eventBus.emit(type, event);
      }
    };
    const scopedRegistries = {
      add(point: string, value: unknown, options: { id?: string; priority?: number } = {}) {
        const id = options.id ?? `${record.metadata.id}:${point}:${++contributionSequence}`;
        return toHandle(
          contributionRegistry.add(point, {
            owner,
            id,
            value,
            priority: options.priority,
            scope
          })
        );
      },
      list(point: string) {
        return contributionRegistry.values(point);
      }
    };
    const ownedOptions = (options: { priority?: number } = {}) => ({ ...options, owner, scope });
    const scopedServices = {
      get: serviceRegistry.get.bind(serviceRegistry),
      optional: serviceRegistry.optional.bind(serviceRegistry),
      invoke: serviceRegistry.invoke.bind(serviceRegistry),
      provide(id: string, service: object | (() => object), options?: { priority?: number }) {
        return toHandle(serviceRegistry.provide(id, service, ownedOptions(options)));
      },
      replace(id: string, service: object | (() => object), options?: { priority?: number }) {
        return toHandle(serviceRegistry.replace(id, service, ownedOptions(options)));
      },
      decorate(id: string, decorator: (next: object) => object, options?: { priority?: number }) {
        return toHandle(serviceRegistry.decorate(id, decorator, ownedOptions(options)));
      },
      intercept(
        id: string,
        method: PropertyKey,
        interceptor: (call: { args: unknown[]; next(...args: unknown[]): unknown; service: object }) => unknown,
        options?: { priority?: number }
      ) {
        return toHandle(
          serviceRegistry.intercept(
            id,
            method,
            interceptor,
            ownedOptions(options)
          )
        );
      }
    };
    const scopedPatches = {
      patch(targetObject: object, key: PropertyKey, patcher: (next: unknown) => unknown, options?: { priority?: number }) {
        return toHandle(patchStack.patch(targetObject, key, patcher, ownedOptions(options)));
      },
      replace(targetObject: object, key: PropertyKey, value: unknown, options?: { priority?: number }) {
        return toHandle(patchStack.replace(targetObject, key, value, ownedOptions(options)));
      },
      decorate(targetObject: object, key: PropertyKey, patcher: (next: unknown) => unknown, options?: { priority?: number }) {
        return toHandle(patchStack.patch(targetObject, key, patcher, ownedOptions(options)));
      },
      patchDescriptor(
        targetObject: object,
        key: PropertyKey,
        patcher: (descriptor: Readonly<PropertyDescriptor>) => PropertyDescriptor,
        options?: { priority?: number }
      ) {
        return toHandle(patchStack.patchDescriptor(targetObject, key, patcher, ownedOptions(options)));
      }
    };
    const unsafe = Object.freeze({
      services: scopedServices,
      patches: scopedPatches,
      events: scopedEvents,
      registries: scopedRegistries,
      window: target
    });
    return Object.freeze({
      mod: record.metadata,
      scope,
      signal: scope.signal,
      events: scopedEvents,
      registries: scopedRegistries,
      services: scopedServices,
      logger: loggerFor(record.metadata.id),
      unsafe
    });
  };

  const callSetup = async (record: StoredMod): Promise<void> => {
    if (record.disposed || record.generation === generation || extensionState === 'stopped') return;
    const scope = createScope(record.owner);
    const context = createContext(record, scope);
    record.generation = generation;
    record.generationScope = scope;
    record.generationContext = context;
    try {
      if (record.definition.setup) {
        const result = await Reflect.apply(record.definition.setup, record.definition, [context]);
        if (result) scope.add(result);
      }
      record.status = 'setup';
    } catch (error) {
      record.status = 'failed';
      report('error', 'setup-failed', `Setup failed for ${record.metadata.id}.`, {
        modId: record.metadata.id,
        error
      });
      await disposeScope(record, scope, 'setup rollback');
      record.generationScope = undefined;
      record.generationContext = undefined;
    }
  };

  const callActivate = async (record: StoredMod): Promise<void> => {
    if (record.disposed || record.status !== 'setup' || record.activationScope || !sessionActive) return;
    const scope = record.generationScope?.child(`${record.metadata.id}:activation`);
    if (!scope) return;
    const context = createContext(record, scope);
    record.activationScope = scope;
    record.activationContext = context;
    try {
      if (record.definition.activate) {
        const result = await Reflect.apply(record.definition.activate, record.definition, [context]);
        if (result) scope.add(result);
      }
      record.status = 'active';
    } catch (error) {
      report('error', 'activate-failed', `Activation failed for ${record.metadata.id}.`, {
        modId: record.metadata.id,
        error
      });
      await disposeScope(record, scope, 'activation rollback');
      record.activationScope = undefined;
      record.activationContext = undefined;
      record.status = 'setup';
    }
  };

  const callDeactivate = async (record: StoredMod, reason: string): Promise<void> => {
    const scope = record.activationScope;
    const context = record.activationContext;
    if (!scope || !context) return;
    try {
      if (record.definition.deactivate) {
        await Reflect.apply(record.definition.deactivate, record.definition, [context]);
      }
    } catch (error) {
      report('error', 'deactivate-failed', `Deactivation failed for ${record.metadata.id}.`, {
        modId: record.metadata.id,
        error
      });
    }
    await disposeScope(record, scope, reason);
    record.activationScope = undefined;
    record.activationContext = undefined;
    if (record.status === 'active') record.status = 'setup';
  };

  const disposeGeneration = async (record: StoredMod, reason: string): Promise<void> => {
    await callDeactivate(record, reason);
    const scope = record.generationScope;
    const context = record.generationContext;
    if (scope && context) {
      try {
        if (record.definition.dispose) {
          await Reflect.apply(record.definition.dispose, record.definition, [context]);
        }
      } catch (error) {
        report('error', 'dispose-hook-failed', `Dispose hook failed for ${record.metadata.id}.`, {
          modId: record.metadata.id,
          error
        });
      }
      await disposeScope(record, scope, reason);
    }
    await serviceRegistry.removeOwner(record.owner);
    contributionRegistry.removeOwner(record.owner);
    patchStack.removeOwner(record.owner);
    record.generationScope = undefined;
    record.generationContext = undefined;
    record.activationScope = undefined;
    record.activationContext = undefined;
    record.generation = -1;
    if (!record.disposed) record.status = 'registered';
  };

  const disposeScope = async (record: StoredMod, scope: Scope, reason: string): Promise<void> => {
    try {
      await scope.dispose(reason);
    } catch (error) {
      report('error', 'scope-dispose-failed', `Owned cleanup failed for ${record.metadata.id}.`, {
        modId: record.metadata.id,
        error
      });
    }
  };

  const resolveOrder = (): ResolvedOrder => {
    const candidates = [...records.values()].filter((record) => !record.disposed);
    const unavailable = new Set<StoredMod>();
    for (const record of candidates) {
      for (const dependency of record.metadata.requires) {
        const provider = records.get(dependency.id);
        if (!provider || provider.disposed || !satisfiesVersion(provider.metadata.version, dependency.version)) {
          unavailable.add(record);
          report('warning', 'required-dependency-unavailable',
            `Mod ${record.metadata.id} requires ${formatDependency(dependency)}.`, {
              modId: record.metadata.id,
              once: `missing:${record.metadata.id}:${formatDependency(dependency)}`
            });
        }
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of candidates) {
        if (unavailable.has(record)) continue;
        if (record.metadata.requires.some((dependency) => {
          const provider = records.get(dependency.id);
          return provider ? unavailable.has(provider) : false;
        })) {
          unavailable.add(record);
          changed = true;
        }
      }
    }

    const available = candidates.filter((record) => !unavailable.has(record));
    const byId = new Map(available.map((record) => [record.metadata.id, record]));
    const edges = new Map(available.map((record) => [record, new Set<StoredMod>()]));
    const indegree = new Map(available.map((record) => [record, 0]));
    const addEdge = (from: StoredMod | undefined, to: StoredMod | undefined): void => {
      if (!from || !to || edges.get(from)?.has(to)) return;
      edges.get(from)?.add(to);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    };
    for (const record of available) {
      for (const dependency of [...record.metadata.requires, ...record.metadata.optional]) {
        const provider = byId.get(dependency.id);
        if (provider && satisfiesVersion(provider.metadata.version, dependency.version)) addEdge(provider, record);
      }
      for (const id of record.metadata.after) addEdge(byId.get(id), record);
      for (const id of record.metadata.before) addEdge(record, byId.get(id));
    }

    const ready = available.filter((record) => indegree.get(record) === 0).sort(compareRecords);
    const order: StoredMod[] = [];
    while (ready.length) {
      const record = ready.shift()!;
      order.push(record);
      for (const dependent of edges.get(record) ?? []) {
        const next = (indegree.get(dependent) ?? 1) - 1;
        indegree.set(dependent, next);
        if (next === 0) {
          ready.push(dependent);
          ready.sort(compareRecords);
        }
      }
    }
    if (order.length !== available.length) {
      const blocked = available.filter((record) => !order.includes(record));
      for (const record of blocked) unavailable.add(record);
      const ids = blocked.map((record) => record.metadata.id).sort();
      report('error', 'dependency-cycle', `Mod dependency cycle: ${ids.join(' -> ')}.`, {
        once: `cycle:${ids.join(',')}`
      });
    }
    return { order, unavailable };
  };

  const reconcile = async (): Promise<void> => {
    if (extensionState === 'stopped') return;
    const resolved = resolveOrder();
    for (const record of resolved.order) {
      const requiredFailed = record.metadata.requires.some((dependency) => {
        const provider = records.get(dependency.id);
        return provider?.generation === generation && provider.status === 'failed';
      });
      if (requiredFailed) {
        report('warning', 'required-dependency-failed', `A required dependency failed for ${record.metadata.id}.`, {
          modId: record.metadata.id,
          once: `failed-dependency:${record.metadata.id}`
        });
      } else if (record.generation !== generation) {
        await callSetup(record);
      }
    }
    if (!sessionActive) return;
    for (const record of resolved.order) {
      const requiredFailed = record.metadata.requires.some((dependency) => records.get(dependency.id)?.status === 'failed');
      if (!requiredFailed) await callActivate(record);
    }
  };

  const deactivateAll = async (reason: string): Promise<void> => {
    const order = resolveOrder().order;
    for (const record of [...order].reverse()) await callDeactivate(record, reason);
  };

  const disposeAll = async (reason: string): Promise<void> => {
    const resolved = resolveOrder().order;
    const remaining = [...records.values()].filter((record) => !resolved.includes(record)).sort(compareRecords);
    for (const record of [...resolved, ...remaining].reverse()) await disposeGeneration(record, reason);
  };

  const applyTransition = async (transition: ControllerTransition): Promise<void> => {
    if (!isControllerTransition(transition)) {
      report('warning', 'invalid-controller-transition', 'Ignored an invalid controller transition.');
      return;
    }
    if (
      transition.generation < generation ||
      (
        transition.generation === generation &&
        (
          transition.revision < revision ||
          (
            transition.revision === revision &&
            (transition.type !== 'settings:update' || transition.settingsRevision <= settingsRevision)
          )
        )
      )
    ) {
      return;
    }
    if (transition.generation > generation) {
      if (generation >= 0) {
        sessionActive = false;
        await disposeAll('kernel generation replaced');
      }
      generation = transition.generation;
      revision = -1;
      settingsRevision = -1;
      extensionState = 'stopped';
      sessionActive = false;
      reportedIssues.clear();
    }
    revision = Math.max(revision, transition.revision);
    settingsRevision = Math.max(settingsRevision, transition.settingsRevision);
    lastTransition = transition;

    switch (transition.type) {
      case 'extension:start':
        extensionState = 'started';
        await reconcile();
        break;
      case 'extension:ready':
        extensionState = 'ready';
        await reconcile();
        break;
      case 'settings:update':
        break;
      case 'session:activate':
        if (extensionState === 'stopped') extensionState = 'started';
        sessionActive = true;
        await reconcile();
        break;
      case 'session:deactivate':
        sessionActive = false;
        await deactivateAll(transition.reason);
        break;
      case 'extension:stop':
        sessionActive = false;
        await disposeAll(transition.reason);
        extensionState = 'stopped';
        break;
    }
    await eventBus.emitAsync('lifecycle', transition);
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = work.then(operation, operation);
    work = result.catch((error) => {
      report('error', 'host-operation-failed', 'A host operation failed.', { error });
    });
    return result;
  };

  const register = (input: ModDefinition): RegistrationHandle => {
    const definition = defineMod(input);
    if (records.has(definition.id)) {
      report('error', 'duplicate-mod-id', `A mod with id ${definition.id} is already registered.`, {
        modId: definition.id
      });
      throw new Error(`Duplicate Babel mod id: ${definition.id}`);
    }
    const metadata = normalizeMetadata(definition);
    const record: StoredMod = {
      definition,
      metadata,
      owner: Symbol(`mod:${metadata.id}`),
      sequence: ++registrationSequence,
      generation: -1,
      status: 'registered',
      disposed: false
    };
    records.set(metadata.id, record);
    if (extensionState !== 'stopped') void enqueue(reconcile);
    let disposePromise: Promise<void> | undefined;
    return {
      dispose() {
        if (disposePromise) return disposePromise;
        disposePromise = enqueue(async () => {
          if (record.disposed) return;
          const dependents = requiredDependentClosure(record, records);
          const resolved = resolveOrder().order;
          const affected = resolved.filter((candidate) => candidate === record || dependents.has(candidate));
          for (const candidate of [...affected].reverse()) await disposeGeneration(candidate, 'registration disposed');
          record.disposed = true;
          records.delete(record.metadata.id);
          if (extensionState !== 'stopped') await reconcile();
        });
        return disposePromise;
      }
    };
  };

  const lifecycle = Object.freeze({
    apply(transition: ControllerTransition) {
      return enqueue(() => applyTransition(transition));
    },
    idle() {
      return work;
    },
    snapshot() {
      return Object.freeze({
        generation,
        revision,
        settingsRevision,
        extensionState,
        sessionActive,
        lastTransition,
        mods: [...records.values()].sort(compareRecords).map((record) => Object.freeze({
          id: record.metadata.id,
          status: record.status,
          generation: record.generation
        }))
      });
    }
  });
  const registries = Object.freeze({
    get<T = unknown>(point: string): readonly T[] {
      return contributionRegistry.values(point) as readonly T[];
    }
  });


  const unsafe = Object.freeze({
    services: Object.freeze(globalServices),
    patches: Object.freeze(globalPatches),
    events: Object.freeze(globalEvents),
    registries: Object.freeze(globalRegistries),
    lifecycle,
    window: target
  });
  const host: BabelModsHost = Object.freeze({
    [HOST_MARKER]: true,
    apiVersion: MOD_API_VERSION,
    internalsVersion,
    define: defineMod,
    register,
    registries,
    diagnostics: Object.freeze({
      list: () => Object.freeze([...diagnostics]),
      subscribe(listener: (diagnostic: ModDiagnostic) => void) {
        diagnosticListeners.add(listener);
        let active = true;
        return {
          dispose() {
            if (!active) return;
            active = false;
            diagnosticListeners.delete(listener);
          }
        };
      },
      clear() {
        diagnostics.length = 0;
      }
    }),
    unsafe
  });

  target[BABEL_MOD_GLOBAL_NAME] = host;
  target.addEventListener(BABEL_MOD_CONTROLLER_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isControllerTransition(detail)) void lifecycle.apply(detail);
    else report('warning', 'invalid-controller-event', 'Ignored an invalid controller event.');
  });

  const queue = target[BABEL_MOD_QUEUE_NAME] ?? (target[BABEL_MOD_QUEUE_NAME] = []);
  const queued = queue.splice(0, queue.length);
  for (const definition of queued) {
    try {
      const handle = register(definition);
      const attach = (definition as ModDefinition & { [PENDING_REGISTRATION]?: (handle: RegistrationHandle) => void })[
        PENDING_REGISTRATION
      ];
      if (typeof attach === 'function') attach(handle);
    } catch (error) {
      report('error', 'queued-registration-failed', 'A queued mod could not be registered.', {
        modId: typeof definition?.id === 'string' ? definition.id : undefined,
        error
      });
    }
  }

  const readyDetail: HostReadyDetail = Object.freeze({
    protocolVersion: CONTROLLER_PROTOCOL_VERSION,
    apiVersion: MOD_API_VERSION,
    generation: Math.max(generation, 0),
    internalsVersion
  });
  target.dispatchEvent(new CustomEvent(BABEL_MOD_HOST_READY_EVENT, { detail: readyDetail }));
  return host;
}

function validateDefinition(definition: ModDefinition): void {
  if (!definition || typeof definition !== 'object') throw new TypeError('A mod definition must be an object.');
  if (typeof definition.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(definition.id)) {
    throw new TypeError('A mod definition requires a stable id containing only letters, numbers, dot, underscore, or dash.');
  }
  if (definition.apiVersion !== undefined && definition.apiVersion !== MOD_API_VERSION) {
    throw new Error(`Mod ${definition.id} targets unsupported API version ${String(definition.apiVersion)}.`);
  }
  for (const hook of ['setup', 'activate', 'deactivate', 'dispose'] as const) {
    if (definition[hook] !== undefined && typeof definition[hook] !== 'function') {
      throw new TypeError(`Mod ${definition.id} has a non-function ${hook} hook.`);
    }
  }
}

function normalizeMetadata(definition: ModDefinition): ModMetadata {
  const normalizeDependencies = (values: readonly DependencyInput[] | undefined): ReadonlyArray<Readonly<{ id: string; version?: string }>> =>
    Object.freeze((values ?? []).map((value) => {
      const dependency = typeof value === 'string' ? { id: value } : { id: value.id, version: value.version };
      if (typeof dependency.id !== 'string' || dependency.id.length === 0) {
        throw new TypeError(`Mod ${definition.id} contains an invalid dependency.`);
      }
      return Object.freeze(dependency);
    }));
  return Object.freeze({
    id: definition.id,
    name: definition.name ?? definition.id,
    version: definition.version ?? '0.0.0',
    apiVersion: MOD_API_VERSION,
    requires: normalizeDependencies(definition.requires),
    optional: normalizeDependencies(definition.optional),
    before: Object.freeze([...(definition.before ?? [])]),
    after: Object.freeze([...(definition.after ?? [])])
  });
}

function compareRecords(left: StoredMod, right: StoredMod): number {
  return left.sequence - right.sequence || left.metadata.id.localeCompare(right.metadata.id);
}

function requiredDependentClosure(root: StoredMod, records: ReadonlyMap<string, StoredMod>): Set<StoredMod> {
  const result = new Set<StoredMod>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records.values()) {
      if (record === root || result.has(record)) continue;
      if (record.metadata.requires.some((dependency) => dependency.id === root.metadata.id || result.has(records.get(dependency.id)!))) {
        result.add(record);
        changed = true;
      }
    }
  }
  return result;
}

function formatDependency(dependency: Readonly<{ id: string; version?: string }>): string {
  return dependency.version ? `${dependency.id}@${dependency.version}` : dependency.id;
}

function satisfiesVersion(actual: string, requirement: string | undefined): boolean {
  if (!requirement || requirement === '*') return true;
  const actualParts = parseVersion(actual);
  const raw = requirement.trim();
  if (raw.startsWith('>=')) return compareVersions(actualParts, parseVersion(raw.slice(2))) >= 0;
  if (raw.startsWith('^')) {
    const expected = parseVersion(raw.slice(1));
    return actualParts[0] === expected[0] && compareVersions(actualParts, expected) >= 0;
  }
  if (raw.startsWith('~')) {
    const expected = parseVersion(raw.slice(1));
    return actualParts[0] === expected[0] && actualParts[1] === expected[1] && compareVersions(actualParts, expected) >= 0;
  }
  return compareVersions(actualParts, parseVersion(raw)) === 0;
}

function parseVersion(version: string): readonly [number, number, number] {
  const [major = '0', minor = '0', patch = '0'] = version.replace(/^v/, '').split(/[.-]/, 3);
  return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

if (typeof window !== 'undefined') installPageHost(window as HostWindow);
