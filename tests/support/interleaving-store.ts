/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- mirrors EntityStore's signatures. */
import type {
  EntityPage,
  EntityStore,
  IndexValue,
  TransactionCheck,
  TransactionWrite,
  VersionedRecord,
} from '@planning-poker/persistence-forge';

export type StoreOperation = 'get' | 'create' | 'replace' | 'put' | 'delete' | 'transact' | 'query';

/** A paused storage call: `reached` resolves when a request hits it; `release` lets it run. */
export interface Hold {
  readonly reached: Promise<void>;
  release(): void;
}

interface PendingHold {
  readonly matches: (operation: StoreOperation, entity: string) => boolean;
  readonly reach: () => void;
  readonly gate: Promise<void>;
}

/**
 * Wraps a store the way parallel Forge invocations see it. Every call first yields for a random
 * number of event-loop turns (deterministic per seed), so concurrent requests interleave between
 * their reads and writes. Tests can also `hold` the next matching call to force one exact
 * ordering — the way a race is reproduced deliberately rather than by luck.
 */
export class InterleavingEntityStore implements EntityStore {
  private readonly inner: EntityStore;
  private seed: number;
  private readonly maxTurns: number;
  private readonly holds: PendingHold[] = [];

  constructor(inner: EntityStore, seed = 1, maxTurns = 4) {
    this.inner = inner;
    this.seed = seed;
    this.maxTurns = maxTurns;
  }

  /** Pauses the next call matching one of `operations` on `entity` until released. */
  hold(operations: readonly StoreOperation[], entity: string): Hold {
    let reach: () => void = () => undefined;
    let release: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holds.push({
      matches: (candidate, candidateEntity) =>
        operations.includes(candidate) && candidateEntity === entity,
      reach,
      gate,
    });

    return { reached, release };
  }

  async get<T>(entity: string, key: string): Promise<T | undefined> {
    await this.before('get', entity);

    return await this.inner.get<T>(entity, key);
  }

  async create<T>(entity: string, key: string, value: T): Promise<void> {
    await this.before('create', entity);
    await this.inner.create(entity, key, value);
  }

  async replace<T extends VersionedRecord>(
    entity: string,
    key: string,
    value: T,
    expectedVersion: number,
  ): Promise<void> {
    await this.before('replace', entity);
    await this.inner.replace(entity, key, value, expectedVersion);
  }

  async put<T>(entity: string, key: string, value: T): Promise<void> {
    await this.before('put', entity);
    await this.inner.put(entity, key, value);
  }

  async delete(entity: string, key: string): Promise<void> {
    await this.before('delete', entity);
    await this.inner.delete(entity, key);
  }

  async transact(
    writes: readonly TransactionWrite[],
    checks: readonly TransactionCheck[],
  ): Promise<void> {
    await this.before('transact', writes[0]?.entity ?? '');
    await this.inner.transact(writes, checks);
  }

  async query<T>(
    entity: string,
    index: string,
    partition: readonly IndexValue[],
    cursor: string | null,
  ): Promise<EntityPage<T>> {
    await this.before('query', entity);

    return await this.inner.query<T>(entity, index, partition, cursor);
  }

  private async before(operation: StoreOperation, entity: string): Promise<void> {
    const index = this.holds.findIndex((pending) => pending.matches(operation, entity));

    if (index >= 0) {
      const [pending] = this.holds.splice(index, 1);

      if (pending !== undefined) {
        pending.reach();
        await pending.gate;

        return;
      }
    }

    await this.yieldTurns();
  }

  /** A small linear congruential generator: reproducible interleavings per seed. */
  private nextTurns(): number {
    const multiplier = 1_103_515_245;
    const increment = 12_345;
    const modulus = 2 ** 31;
    this.seed = (this.seed * multiplier + increment) % modulus;

    return Math.floor(this.seed / 65_536) % (this.maxTurns + 1);
  }

  private async yieldTurns(): Promise<void> {
    const turns = this.nextTurns();

    // Macrotask turns: every other pending request runs until its next storage call.
    for (let turn = 0; turn < turns; turn += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }
}
