import {
  createDisposableHandle,
  type DisposableHandle,
  type DisposableValue,
  type MaybePromise,
  type Owner,
  type Scope
} from './scope';

type AnyMethod = (...args: never[]) => unknown;

type KnownMethodKeys<Service> = {
  [Key in keyof Service]-?: Service[Key] extends AnyMethod ? Key : never;
}[keyof Service];

export type MethodKeys<Service> = [keyof Service] extends [never]
  ? PropertyKey
  : KnownMethodKeys<Service>;

export type ServiceMethod<Service, Key extends MethodKeys<Service>> =
  Key extends keyof Service
    ? Extract<Service[Key], AnyMethod>
    : (...args: unknown[]) => unknown;

export interface ServiceRegistrationOptions {
  readonly owner?: Owner;
  readonly scope?: Scope;
  readonly priority?: number;
}

export interface ServiceFactoryContext<Services extends object, Key extends keyof Services> {
  readonly id: Key;
  readonly owner: Owner;
  readonly registry: ServiceRegistry<Services>;
}

export interface ServiceProvision<Service> {
  readonly value: Service;
  readonly dispose: DisposableValue;
}

export type ServiceSource<Services extends object, Key extends keyof Services> =
  | Services[Key]
  | ((context: ServiceFactoryContext<Services, Key>) =>
      | Services[Key]
      | ServiceProvision<Services[Key]>);

export type ServiceDecorator<Services extends object, Key extends keyof Services> = (
  service: Services[Key],
  context: ServiceFactoryContext<Services, Key>
) => Services[Key];

export interface ServiceInvocation<
  Service,
  Key extends MethodKeys<Service>
> {
  readonly service: Service;
  readonly args: Parameters<ServiceMethod<Service, Key>>;
  next(...args: Parameters<ServiceMethod<Service, Key>>): ReturnType<ServiceMethod<Service, Key>>;
}

export type ServiceInterceptor<Service, Key extends MethodKeys<Service>> = (
  invocation: ServiceInvocation<Service, Key>
) => ReturnType<ServiceMethod<Service, Key>>;

type LayerKind = 'provide' | 'replace' | 'decorate' | 'intercept';

interface LayerBase {
  readonly kind: LayerKind;
  readonly owner: Owner;
  readonly priority: number;
  readonly order: number;
  active: boolean;
  handle: DisposableHandle;
}

interface ProviderLayer<Services extends object> extends LayerBase {
  readonly kind: 'provide' | 'replace';
  source: ServiceSource<Services, keyof Services>;
  initialized: boolean;
  value?: Services[keyof Services];
  provisionDisposer?: DisposableValue;
}

interface DecoratorLayer<Services extends object> extends LayerBase {
  readonly kind: 'decorate';
  decorator: ServiceDecorator<Services, keyof Services>;
}

interface InterceptorLayer<Services extends object> extends LayerBase {
  readonly kind: 'intercept';
  method: PropertyKey;
  interceptor: (invocation: {
    readonly service: unknown;
    readonly args: readonly unknown[];
    next(...args: readonly unknown[]): unknown;
  }) => unknown;
}

type ServiceLayer<Services extends object> =
  | ProviderLayer<Services>
  | DecoratorLayer<Services>
  | InterceptorLayer<Services>;

interface ServiceState<Services extends object> {
  readonly layers: ServiceLayer<Services>[];
  effective?: Services[keyof Services];
  effectiveRevision: number;
}

interface HandleState {
  readonly proxy: object;
  readonly methods: Map<PropertyKey, (...args: unknown[]) => unknown>;
}

/**
 * A typed keyed service registry. `get()` returns a stable forwarding proxy:
 * method calls resolve the effective service and interceptor chain at call time.
 */
export class ServiceRegistry<Services extends object> {
  private readonly states = new Map<keyof Services, ServiceState<Services>>();
  private readonly handles = new Map<keyof Services, HandleState>();
  private nextOrder = 0;
  private currentRevision = 0;

  get revision(): number {
    return this.currentRevision;
  }

  has<Key extends keyof Services>(id: Key): boolean {
    return this.hasProvider(id);
  }

  get<Key extends keyof Services>(id: Key): Services[Key] {
    return this.forwardingHandle(id);
  }

  optional<Key extends keyof Services>(id: Key): Services[Key] | undefined {
    return this.hasProvider(id) ? this.forwardingHandle(id) : undefined;
  }

  provide<Key extends keyof Services>(
    id: Key,
    source: ServiceSource<Services, Key>,
    options: ServiceRegistrationOptions = {}
  ): DisposableHandle {
    return this.addProvider(id, 'provide', source, options);
  }

  replace<Key extends keyof Services>(
    id: Key,
    source: ServiceSource<Services, Key>,
    options: ServiceRegistrationOptions = {}
  ): DisposableHandle {
    return this.addProvider(id, 'replace', source, options);
  }

  decorate<Key extends keyof Services>(
    id: Key,
    decorator: ServiceDecorator<Services, Key>,
    options: ServiceRegistrationOptions = {}
  ): DisposableHandle {
    const layer = this.createLayer('decorate', options) as DecoratorLayer<Services>;
    layer.decorator = decorator as unknown as ServiceDecorator<Services, keyof Services>;
    return this.installLayer(id, layer, options.scope);
  }

  intercept<Key extends keyof Services, Method extends MethodKeys<Services[Key]>>(
    id: Key,
    method: Method,
    interceptor: ServiceInterceptor<Services[Key], Method>,
    options: ServiceRegistrationOptions = {}
  ): DisposableHandle {
    const layer = this.createLayer('intercept', options) as InterceptorLayer<Services>;
    layer.method = method as PropertyKey;
    layer.interceptor = interceptor as unknown as InterceptorLayer<Services>['interceptor'];
    return this.installLayer(id, layer, options.scope);
  }

  invoke<Key extends keyof Services, Method extends MethodKeys<Services[Key]>>(
    id: Key,
    method: Method,
    ...args: Parameters<ServiceMethod<Services[Key], Method>>
  ): ReturnType<ServiceMethod<Services[Key], Method>> {
    const service = this.resolve(id);
    const callable = Reflect.get(service as object, method, service);
    if (typeof callable !== 'function') {
      throw new TypeError(`Service ${String(id)} property ${String(method)} is not callable`);
    }

    const interceptors = this.interceptorLayers(id, method);
    if (interceptors.length === 0) {
      return Reflect.apply(callable, service, args) as ReturnType<ServiceMethod<Services[Key], Method>>;
    }

    const dispatch = (index: number, callArgs: readonly unknown[]): unknown => {
      const layer = interceptors[index];
      if (!layer) return Reflect.apply(callable, service, callArgs);

      return layer.interceptor({
        service,
        args: callArgs,
        next: (...nextArgs) => dispatch(index + 1, nextArgs)
      });
    };

    return dispatch(0, args) as ReturnType<ServiceMethod<Services[Key], Method>>;
  }

  removeOwner(owner: Owner): MaybePromise<void> {
    const handles: DisposableHandle[] = [];
    for (const state of this.states.values()) {
      for (const layer of state.layers) {
        if (layer.active && Object.is(layer.owner, owner)) handles.push(layer.handle);
      }
    }

    let asynchronous: Promise<void> | undefined;
    for (const handle of handles.reverse()) {
      if (asynchronous) {
        asynchronous = asynchronous.then(() => handle.dispose());
        continue;
      }
      const result = handle.dispose();
      if (isPromiseLike(result)) asynchronous = Promise.resolve(result);
    }
    return asynchronous;
  }

  clear(): MaybePromise<void> {
    const handles = Array.from(this.states.values())
      .flatMap((state) => state.layers)
      .filter((layer) => layer.active)
      .sort((left, right) => right.order - left.order)
      .map((layer) => layer.handle);

    let asynchronous: Promise<void> | undefined;
    for (const handle of handles) {
      if (asynchronous) {
        asynchronous = asynchronous.then(() => handle.dispose());
        continue;
      }
      const result = handle.dispose();
      if (isPromiseLike(result)) asynchronous = Promise.resolve(result);
    }
    return asynchronous;
  }

  private addProvider<Key extends keyof Services>(
    id: Key,
    kind: 'provide' | 'replace',
    source: ServiceSource<Services, Key>,
    options: ServiceRegistrationOptions
  ): DisposableHandle {
    const layer = this.createLayer(kind, options) as ProviderLayer<Services>;
    layer.source = source as ServiceSource<Services, keyof Services>;
    layer.initialized = false;
    return this.installLayer(id, layer, options.scope);
  }

  private createLayer(kind: LayerKind, options: ServiceRegistrationOptions): LayerBase {
    const priority = options.priority ?? 0;
    if (!Number.isFinite(priority)) throw new TypeError('Service layer priority must be finite');

    return {
      kind,
      owner: options.owner ?? options.scope?.owner ?? Symbol(kind),
      priority,
      order: this.nextOrder++,
      active: true,
      handle: createDisposableHandle(() => undefined)
    };
  }

  private installLayer<Key extends keyof Services>(
    id: Key,
    layer: ServiceLayer<Services>,
    scope: Scope | undefined
  ): DisposableHandle {
    const state = this.state(id);
    state.layers.push(layer);
    this.invalidate(state);

    layer.handle = createDisposableHandle(() => {
      const remove = () => {
        if (!layer.active) return;
        layer.active = false;
        const index = state.layers.indexOf(layer);
        if (index >= 0) state.layers.splice(index, 1);
        this.invalidate(state);
        if (state.layers.length === 0) this.states.delete(id);
      };

      if (layer.kind !== 'provide' && layer.kind !== 'replace') {
        remove();
        return;
      }

      const cleanup = layer.provisionDisposer;
      if (!cleanup) {
        remove();
        return;
      }

      const result = typeof cleanup === 'function' ? cleanup() : cleanup.dispose();
      if (isPromiseLike(result)) return Promise.resolve(result).then(remove);
      remove();
    });

    scope?.add(layer.handle);
    return layer.handle;
  }

  private state<Key extends keyof Services>(id: Key): ServiceState<Services> {
    let state = this.states.get(id);
    if (!state) {
      state = { layers: [], effectiveRevision: -1 };
      this.states.set(id, state);
    }
    return state;
  }

  private invalidate(state: ServiceState<Services>): void {
    this.currentRevision += 1;
    state.effective = undefined;
    state.effectiveRevision = -1;
  }

  private hasProvider<Key extends keyof Services>(id: Key): boolean {
    const layers = this.states.get(id)?.layers ?? [];
    return layers.some((layer) => layer.active && (layer.kind === 'provide' || layer.kind === 'replace'));
  }

  private resolve<Key extends keyof Services>(id: Key): Services[Key] {
    const state = this.states.get(id);
    if (!state || !this.hasProvider(id)) throw new Error(`Service ${String(id)} is not available`);
    if (state.effectiveRevision === this.currentRevision && state.effective !== undefined) {
      return state.effective as Services[Key];
    }

    const replacements = state.layers.filter(
      (layer): layer is ProviderLayer<Services> => layer.active && layer.kind === 'replace'
    );
    const providers = state.layers.filter(
      (layer): layer is ProviderLayer<Services> => layer.active && layer.kind === 'provide'
    );
    const provider = (replacements.length > 0 ? replacements : providers).sort(compareProviderPrecedence)[0];
    if (!provider) throw new Error(`Service ${String(id)} is not available`);

    let effective: Services[keyof Services] = this.providerValue(id, provider);
    const decorators = state.layers
      .filter((layer): layer is DecoratorLayer<Services> => layer.active && layer.kind === 'decorate')
      .sort(compareDecoratorApplication);

    for (const layer of decorators) {
      effective = layer.decorator(effective, { id, owner: layer.owner, registry: this });
      assertServiceObject(id, effective);
    }

    state.effective = effective;
    state.effectiveRevision = this.currentRevision;
    return effective as Services[Key];
  }

  private providerValue<Key extends keyof Services>(
    id: Key,
    layer: ProviderLayer<Services>
  ): Services[Key] {
    if (!layer.initialized) {
      const source = layer.source;
      const result =
        typeof source === 'function'
          ? (
              source as (
                context: ServiceFactoryContext<Services, keyof Services>
              ) => Services[keyof Services] | ServiceProvision<Services[keyof Services]>
            )({ id, owner: layer.owner, registry: this })
          : source;
      if (isServiceProvision<Services[keyof Services]>(result)) {
        layer.value = result.value;
        layer.provisionDisposer = result.dispose;
      } else {
        layer.value = result;
      }
      assertServiceObject(id, layer.value);
      layer.initialized = true;
    }
    return layer.value as Services[Key];
  }

  private interceptorLayers<Key extends keyof Services>(
    id: Key,
    method: PropertyKey
  ): InterceptorLayer<Services>[] {
    return (this.states.get(id)?.layers ?? [])
      .filter(
        (layer): layer is InterceptorLayer<Services> =>
          layer.active && layer.kind === 'intercept' && layer.method === method
      )
      .sort(compareInterceptorPrecedence);
  }

  private forwardingHandle<Key extends keyof Services>(id: Key): Services[Key] {
    let handle = this.handles.get(id);
    if (!handle) {
      const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
      const proxy = new Proxy(
        {},
        {
          get: (_target, property) => {
            const service = this.resolve(id);
            const value = Reflect.get(service as object, property, service);
            if (typeof value !== 'function') return value;

            let method = methods.get(property);
            if (!method) {
              method = (...args: unknown[]) =>
                this.invoke(
                  id,
                  property as MethodKeys<Services[Key]>,
                  ...(args as Parameters<ServiceMethod<Services[Key], MethodKeys<Services[Key]>>>)
                );
              methods.set(property, method);
            }
            return method;
          },
          set: (_target, property, value) => {
            const service = this.resolve(id);
            return Reflect.set(service as object, property, value, service);
          },
          has: (_target, property) => property in (this.resolve(id) as object)
        }
      );
      handle = { proxy, methods };
      this.handles.set(id, handle);
    }
    return handle.proxy as unknown as Services[Key];
  }
}

export function createServiceRegistry<Services extends object>(): ServiceRegistry<Services> {
  return new ServiceRegistry<Services>();
}

function compareProviderPrecedence(left: LayerBase, right: LayerBase): number {
  return right.priority - left.priority || right.order - left.order;
}

function compareDecoratorApplication(left: LayerBase, right: LayerBase): number {
  return left.priority - right.priority || right.order - left.order;
}

function compareInterceptorPrecedence(left: LayerBase, right: LayerBase): number {
  return right.priority - left.priority || left.order - right.order;
}

function assertServiceObject(id: PropertyKey, value: unknown): asserts value is object {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    throw new TypeError(`Service ${String(id)} must be an object or function`);
  }
}

function isServiceProvision<Service>(value: unknown): value is ServiceProvision<Service> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    'dispose' in value &&
    (typeof value.dispose === 'function' ||
      (typeof value.dispose === 'object' && value.dispose !== null && 'dispose' in value.dispose))
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    (typeof value === 'object' && value !== null && 'then' in value) ||
    (typeof value === 'function' && 'then' in value)
  );
}
