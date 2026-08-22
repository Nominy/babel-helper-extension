export type MaybePromise<T> = T | PromiseLike<T>;
export type Disposer = () => MaybePromise<void>;
export interface Disposable {
  dispose(): MaybePromise<void>;
}
export interface DisposableHandle extends Disposable {
  (): MaybePromise<void>;
}
export type DisposableValue = Disposer | Disposable;
export type Owner = string | number | symbol | object;

export class ScopeDisposalError extends Error {
  readonly errors: readonly unknown[];

  constructor(owner: Owner, errors: readonly unknown[]) {
    super(`Failed to dispose ${errors.length} resource${errors.length === 1 ? '' : 's'} for scope ${describeOwner(owner)}`);
    this.name = 'ScopeDisposalError';
    this.errors = errors;
  }
}

/** An owner-scoped, idempotent, asynchronous LIFO disposal stack. */
export class Scope implements Disposable {
  readonly owner: Owner;

  private readonly controller = new AbortController();
  private readonly disposers: Disposer[] = [];
  private disposePromise: Promise<void> | undefined;

  constructor(owner: Owner = 'anonymous') {
    this.owner = owner;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get disposed(): boolean {
    return this.disposePromise !== undefined;
  }

  get size(): number {
    return this.disposers.length;
  }

  add<T extends DisposableValue>(value: T): T {
    if (this.disposed) {
      throw new Error(`Cannot add a resource to disposed scope ${describeOwner(this.owner)}`);
    }
    if (Object.is(value as unknown, this)) {
      throw new TypeError('A scope cannot own itself');
    }

    this.disposers.push(toDisposer(value));
    return value;
  }

  defer(disposer: Disposer): DisposableHandle {
    const handle = createDisposableHandle(disposer);
    this.add(handle);
    return handle;
  }

  child(owner: Owner = this.owner): Scope {
    const child = new Scope(owner);
    this.add(child);
    return child;
  }

  dispose(reason: unknown = 'scope disposed'): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    this.controller.abort(reason);
    const pending = this.disposers.splice(0).reverse();
    this.disposePromise = disposeAll(this.owner, pending);
    return this.disposePromise;
  }
}

export function createScope(owner: Owner = 'anonymous'): Scope {
  return new Scope(owner);
}

export function asDisposer(value: DisposableValue): Disposer {
  return toDisposer(value);
}

export function createDisposableHandle(value: DisposableValue): DisposableHandle {
  const dispose = toDisposer(value);
  let active = true;
  const handle = (() => {
    if (!active) return;
    active = false;
    return dispose();
  }) as DisposableHandle;
  handle.dispose = handle;
  return handle;
}

async function disposeAll(owner: Owner, disposers: readonly Disposer[]): Promise<void> {
  const errors: unknown[] = [];

  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) throw new ScopeDisposalError(owner, errors);
}

function toDisposer(value: DisposableValue): Disposer {
  if (typeof value === 'function') return value;
  if (value && typeof value.dispose === 'function') return () => value.dispose();
  throw new TypeError('Expected a disposer function or disposable object');
}

function describeOwner(owner: Owner): string {
  if (typeof owner === 'symbol') return owner.description ?? owner.toString();
  if (typeof owner === 'object') return Object.prototype.toString.call(owner);
  return String(owner);
}
