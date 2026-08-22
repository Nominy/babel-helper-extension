import {
  createDisposableHandle,
  type DisposableHandle,
  type MaybePromise,
  type Scope
} from './scope';

export type EventListener<Event> = (event: Event) => MaybePromise<void>;

export interface EventListenerOptions {
  readonly once?: boolean;
  readonly priority?: number;
  readonly scope?: Scope;
  readonly signal?: AbortSignal;
}

interface ListenerEntry {
  readonly order: number;
  readonly priority: number;
  readonly once: boolean;
  readonly listener: EventListener<unknown>;
  active: boolean;
  dispose: DisposableHandle;
}

/** A deterministic event bus whose listeners are independently disposable. */
export class EventBus<Events extends object> {
  private readonly listeners = new Map<keyof Events, ListenerEntry[]>();
  private nextOrder = 0;

  on<Key extends keyof Events>(
    type: Key,
    listener: EventListener<Events[Key]>,
    options: EventListenerOptions = {}
  ): DisposableHandle {
    if (options.signal?.aborted) return createDisposableHandle(() => undefined);

    const entries = this.listeners.get(type) ?? [];
    if (!this.listeners.has(type)) this.listeners.set(type, entries);

    const entry: ListenerEntry = {
      order: this.nextOrder++,
      priority: options.priority ?? 0,
      once: options.once ?? false,
      listener: listener as EventListener<unknown>,
      active: true,
      dispose: createDisposableHandle(() => undefined)
    };

    const abort = () => entry.dispose();
    entry.dispose = createDisposableHandle(() => {
      if (!entry.active) return;
      entry.active = false;
      options.signal?.removeEventListener('abort', abort);

      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
      if (entries.length === 0) this.listeners.delete(type);
    });

    entries.push(entry);
    entries.sort(compareListeners);
    options.signal?.addEventListener('abort', abort, { once: true });
    options.scope?.add(entry.dispose);
    return entry.dispose;
  }

  once<Key extends keyof Events>(
    type: Key,
    listener: EventListener<Events[Key]>,
    options: Omit<EventListenerOptions, 'once'> = {}
  ): DisposableHandle {
    return this.on(type, listener, { ...options, once: true });
  }

  emit<Key extends keyof Events>(type: Key, event: Events[Key]): MaybePromise<void> {
    const entries = this.listeners.get(type);
    if (!entries || entries.length === 0) return;

    const snapshot = entries.slice();
    return dispatch(snapshot, event, 0);
  }

  async emitAsync<Key extends keyof Events>(type: Key, event: Events[Key]): Promise<void> {
    await this.emit(type, event);
  }

  clear<Key extends keyof Events>(type?: Key): void {
    if (type !== undefined) {
      const entries = this.listeners.get(type)?.slice() ?? [];
      for (const entry of entries) entry.dispose();
      return;
    }

    const entries = Array.from(this.listeners.values()).flat();
    for (const entry of entries) entry.dispose();
  }

  listenerCount<Key extends keyof Events>(type: Key): number {
    return this.listeners.get(type)?.length ?? 0;
  }
}

export function createEventBus<Events extends object>(): EventBus<Events> {
  return new EventBus<Events>();
}

function dispatch<Event>(
  entries: readonly ListenerEntry[],
  event: Event,
  index: number
): MaybePromise<void> {
  for (let cursor = index; cursor < entries.length; cursor += 1) {
    const entry = entries[cursor];
    if (!entry.active) continue;

    if (entry.once) entry.dispose();
    const result = entry.listener(event);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(() => dispatch(entries, event, cursor + 1));
    }
  }
}

function compareListeners(left: ListenerEntry, right: ListenerEntry): number {
  return right.priority - left.priority || left.order - right.order;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null && 'then' in value) ||
    (typeof value === 'function' && 'then' in value)
  );
}
