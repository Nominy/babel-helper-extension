import {
  createDisposableHandle,
  type DisposableHandle,
  type Owner,
  type Scope
} from './scope';

export interface ContributionRegistration<Value> {
  readonly owner: Owner;
  readonly id: string;
  readonly value: Value;
  readonly priority?: number;
  readonly scope?: Scope;
}

export interface ContributionEntry<Value> {
  readonly owner: Owner;
  readonly id: string;
  readonly value: Value;
  readonly priority: number;
}

interface StoredContribution<Value> extends ContributionEntry<Value> {
  readonly order: number;
  active: boolean;
  dispose: DisposableHandle;
}

/** Owner-aware contribution points ordered by priority then registration order. */
export class ContributionRegistry<Points extends object> {
  private readonly points = new Map<keyof Points, StoredContribution<unknown>[]>();
  private nextOrder = 0;

  add<Key extends keyof Points>(
    point: Key,
    registration: ContributionRegistration<Points[Key]>
  ): DisposableHandle {
    validateRegistration(registration);

    const entries = this.points.get(point) ?? [];
    if (!this.points.has(point)) this.points.set(point, entries);
    if (
      entries.some(
        (entry) =>
          entry.active &&
          entry.id === registration.id &&
          Object.is(entry.owner, registration.owner)
      )
    ) {
      throw new Error(
        `Contribution ${String(point)}:${registration.id} is already registered by this owner`
      );
    }

    const entry: StoredContribution<Points[Key]> = {
      owner: registration.owner,
      id: registration.id,
      value: registration.value,
      priority: registration.priority ?? 0,
      order: this.nextOrder++,
      active: true,
      dispose: createDisposableHandle(() => undefined)
    };

    entry.dispose = createDisposableHandle(() => {
      if (!entry.active) return;
      entry.active = false;

      const index = entries.indexOf(entry as StoredContribution<unknown>);
      if (index >= 0) entries.splice(index, 1);
      if (entries.length === 0) this.points.delete(point);
    });

    entries.push(entry as StoredContribution<unknown>);
    entries.sort(compareContributions);
    registration.scope?.add(entry.dispose);
    return entry.dispose;
  }

  register<Key extends keyof Points>(
    point: Key,
    registration: ContributionRegistration<Points[Key]>
  ): DisposableHandle {
    return this.add(point, registration);
  }
  list<Key extends keyof Points>(point: Key): readonly ContributionEntry<Points[Key]>[] {
    const entries = this.points.get(point) ?? [];
    return entries.map(({ owner, id, value, priority }) => ({
      owner,
      id,
      value: value as Points[Key],
      priority
    }));
  }

  snapshot<Key extends keyof Points>(point: Key): readonly ContributionEntry<Points[Key]>[] {
    return this.list(point);
  }

  values<Key extends keyof Points>(point: Key): readonly Points[Key][] {
    return (this.points.get(point) ?? []).map((entry) => entry.value as Points[Key]);
  }

  removeOwner(owner: Owner): void {
    const entries = Array.from(this.points.values()).flat();
    for (const entry of entries) {
      if (Object.is(entry.owner, owner)) entry.dispose();
    }
  }

  clear(): void {
    const entries = Array.from(this.points.values()).flat();
    for (const entry of entries) entry.dispose();
  }

  size<Key extends keyof Points>(point: Key): number {
    return this.points.get(point)?.length ?? 0;
  }
}

export function createContributionRegistry<Points extends object>(): ContributionRegistry<Points> {
  return new ContributionRegistry<Points>();
}

function compareContributions(
  left: StoredContribution<unknown>,
  right: StoredContribution<unknown>
): number {
  return right.priority - left.priority || left.order - right.order || left.id.localeCompare(right.id);
}

function validateRegistration<Value>(registration: ContributionRegistration<Value>): void {
  if (registration.id.length === 0) throw new TypeError('Contribution id must not be empty');
  if (!Number.isFinite(registration.priority ?? 0)) {
    throw new TypeError('Contribution priority must be a finite number');
  }
}
