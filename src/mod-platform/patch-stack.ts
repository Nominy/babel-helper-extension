import {
  createDisposableHandle,
  type DisposableHandle,
  type Owner,
  type Scope
} from './scope';

export interface PatchOptions {
  readonly owner?: Owner;
  readonly priority?: number;
  readonly scope?: Scope;
}

export type DescriptorPatch = (descriptor: Readonly<PropertyDescriptor>) => PropertyDescriptor;

interface PatchLayer {
  readonly owner: Owner;
  readonly priority: number;
  readonly order: number;
  readonly transform: DescriptorPatch;
  active: boolean;
  handle: DisposableHandle;
}

interface PatchRecord {
  readonly target: object;
  readonly key: PropertyKey;
  readonly hadOwnDescriptor: boolean;
  readonly originalDescriptor?: PropertyDescriptor;
  readonly baseDescriptor: PropertyDescriptor;
  readonly layers: PatchLayer[];
}

/** Descriptor-aware property patches rebuilt from the original on every change. */
export class PatchStack {
  private readonly targets = new WeakMap<object, Map<PropertyKey, PatchRecord>>();
  private readonly records = new Set<PatchRecord>();
  private nextOrder = 0;

  patchDescriptor<Target extends object, Key extends PropertyKey>(
    target: Target,
    key: Key,
    transform: DescriptorPatch,
    options: PatchOptions = {}
  ): DisposableHandle {
    const priority = options.priority ?? 0;
    if (!Number.isFinite(priority)) throw new TypeError('Patch priority must be finite');

    const record = this.record(target, key);
    const layer: PatchLayer = {
      owner: options.owner ?? options.scope?.owner ?? Symbol(String(key)),
      priority,
      order: this.nextOrder++,
      transform,
      active: true,
      handle: createDisposableHandle(() => undefined)
    };

    record.layers.push(layer);
    try {
      this.apply(record);
    } catch (error) {
      record.layers.pop();
      this.releaseEmptyRecord(record);
      throw error;
    }

    layer.handle = createDisposableHandle(() => {
      if (!layer.active) return;
      const index = record.layers.indexOf(layer);
      if (index < 0) return;

      record.layers.splice(index, 1);
      try {
        this.apply(record);
      } catch (error) {
        record.layers.splice(index, 0, layer);
        throw error;
      }

      layer.active = false;
      this.releaseEmptyRecord(record);
    });

    options.scope?.add(layer.handle);
    return layer.handle;
  }

  patch<Target extends object, Key extends PropertyKey>(
    target: Target,
    key: Key,
    transform: (
      value: Key extends keyof Target ? Target[Key] : unknown
    ) => Key extends keyof Target ? Target[Key] : unknown,
    options: PatchOptions = {}
  ): DisposableHandle {
    return this.patchDescriptor(
      target,
      key,
      (descriptor) => {
        if ('value' in descriptor) {
          return { ...descriptor, value: transform(descriptor.value) };
        }

        const previousGet = descriptor.get;
        return {
          ...descriptor,
          get: function (this: Target) {
            return transform(previousGet?.call(this));
          }
        };
      },
      options
    );
  }

  replace<Target extends object, Key extends PropertyKey>(
    target: Target,
    key: Key,
    value: Key extends keyof Target ? Target[Key] : unknown,
    options: PatchOptions = {}
  ): DisposableHandle {
    return this.patchDescriptor(
      target,
      key,
      (descriptor) => {
        if ('value' in descriptor) return { ...descriptor, value };
        return { ...descriptor, get: () => value };
      },
      options
    );
  }

  decorate<Target extends object, Key extends keyof Target>(
    target: Target,
    key: Key,
    transform: (value: Target[Key]) => Target[Key],
    options: PatchOptions = {}
  ): DisposableHandle {
    return this.patch(
      target,
      key,
      transform as (value: Key extends keyof Target ? Target[Key] : unknown) =>
        Key extends keyof Target ? Target[Key] : unknown,
      options
    );
  }

  removeOwner(owner: Owner): void {
    const layers = Array.from(this.records)
      .flatMap((record) => record.layers)
      .filter((layer) => layer.active && Object.is(layer.owner, owner))
      .sort((left, right) => right.order - left.order);
    for (const layer of layers) layer.handle.dispose();
  }

  clear(): void {
    const layers = Array.from(this.records)
      .flatMap((record) => record.layers)
      .filter((layer) => layer.active)
      .sort((left, right) => right.order - left.order);
    for (const layer of layers) layer.handle.dispose();
  }

  layerCount(target?: object, key?: PropertyKey): number {
    if (target === undefined) {
      let count = 0;
      for (const record of this.records) count += record.layers.length;
      return count;
    }

    const records = this.targets.get(target);
    if (!records) return 0;
    if (key !== undefined) return records.get(key)?.layers.length ?? 0;

    let count = 0;
    for (const record of records.values()) count += record.layers.length;
    return count;
  }

  private record(target: object, key: PropertyKey): PatchRecord {
    let targetRecords = this.targets.get(target);
    if (!targetRecords) {
      targetRecords = new Map();
      this.targets.set(target, targetRecords);
    }

    let record = targetRecords.get(key);
    if (record) return record;

    const originalDescriptor = Object.getOwnPropertyDescriptor(target, key);
    const inheritedDescriptor = originalDescriptor ? undefined : findInheritedDescriptor(target, key);
    const baseDescriptor = originalDescriptor
      ? cloneDescriptor(originalDescriptor)
      : inheritedDescriptor
        ? { ...cloneDescriptor(inheritedDescriptor), configurable: true }
        : { configurable: true, enumerable: true, writable: true, value: undefined };

    record = {
      target,
      key,
      hadOwnDescriptor: originalDescriptor !== undefined,
      originalDescriptor: originalDescriptor && cloneDescriptor(originalDescriptor),
      baseDescriptor,
      layers: []
    };
    targetRecords.set(key, record);
    this.records.add(record);
    return record;
  }

  private apply(record: PatchRecord): void {
    if (record.layers.length === 0) {
      if (record.hadOwnDescriptor && record.originalDescriptor) {
        Object.defineProperty(record.target, record.key, cloneDescriptor(record.originalDescriptor));
      } else if (!Reflect.deleteProperty(record.target, record.key)) {
        throw new TypeError(`Unable to restore absent property ${String(record.key)}`);
      }
      return;
    }

    let descriptor = cloneDescriptor(record.baseDescriptor);
    const layers = record.layers
      .filter((layer) => layer.active)
      .sort((left, right) => left.priority - right.priority || left.order - right.order);

    for (const layer of layers) {
      const transformed = layer.transform(Object.freeze(cloneDescriptor(descriptor)));
      if (!transformed || typeof transformed !== 'object') {
        throw new TypeError(`Patch for ${String(record.key)} must return a property descriptor`);
      }
      descriptor = cloneDescriptor(transformed);
    }

    Object.defineProperty(record.target, record.key, descriptor);
  }

  private releaseEmptyRecord(record: PatchRecord): void {
    if (record.layers.length > 0) return;
    this.records.delete(record);

    const targetRecords = this.targets.get(record.target);
    targetRecords?.delete(record.key);
    if (targetRecords?.size === 0) this.targets.delete(record.target);
  }
}

export function createPatchStack(): PatchStack {
  return new PatchStack();
}

function findInheritedDescriptor(target: object, key: PropertyKey): PropertyDescriptor | undefined {
  let prototype = Object.getPrototypeOf(target) as object | null;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor) return descriptor;
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return undefined;
}

function cloneDescriptor(descriptor: PropertyDescriptor): PropertyDescriptor {
  const clone: PropertyDescriptor = {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable
  };
  if ('value' in descriptor || 'writable' in descriptor) {
    clone.value = descriptor.value;
    clone.writable = descriptor.writable;
  } else {
    clone.get = descriptor.get;
    clone.set = descriptor.set;
  }
  return clone;
}
