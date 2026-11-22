/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- storage returns untyped JSON; the type parameter names the record type the caller expects. */
import { kvs, Filter, FilterConditions } from '@forge/kvs';
import { ConcurrencyConflict } from '@planning-poker/application';

const QUERY_PAGE_SIZE = 50;

export type IndexValue = string | number | boolean;

export interface EntityPage<T> {
  readonly values: readonly T[];
  readonly nextCursor: string | null;
}

export interface VersionedRecord {
  readonly version: number;
}

/** One write in a transaction; with `expectedVersion` it commits only on that stored version. */
export interface TransactionWrite {
  readonly entity: string;
  readonly key: string;
  readonly value: unknown;
  readonly expectedVersion?: number;
}

/** A condition on a record that the transaction does not write: these attributes must match. */
export interface TransactionCheck {
  readonly entity: string;
  readonly key: string;
  readonly equals: Readonly<Record<string, IndexValue>>;
}

/** Forge allows 25 operations per transaction. */
export const MAX_TRANSACTION_OPERATIONS = 25;

/** Whether a stored record still satisfies a check. */
export function satisfies(record: unknown, check: TransactionCheck): boolean {
  if (typeof record !== 'object' || record === null) {
    return false;
  }

  const values = record as Record<string, unknown>;

  return Object.entries(check.equals).every(([attribute, value]) => values[attribute] === value);
}

/**
 * The small slice of the Forge Custom Entity Store the repositories need. Repositories depend on
 * this, so they can be contract-tested against `InMemoryEntityStore` without Forge.
 */
export interface EntityStore {
  get<T>(entity: string, key: string): Promise<T | undefined>;
  /** Creates a record; throws ConcurrencyConflict if the key already exists. */
  create<T>(entity: string, key: string, value: T): Promise<void>;
  /** Replaces a record only if its stored `version` equals `expectedVersion`. */
  replace<T extends VersionedRecord>(
    entity: string,
    key: string,
    value: T,
    expectedVersion: number,
  ): Promise<void>;
  /** Unconditional write, for append-only or index records. */
  put<T>(entity: string, key: string, value: T): Promise<void>;
  delete(entity: string, key: string): Promise<void>;
  /**
   * Applies every write only if every condition holds (each write's `expectedVersion` and each
   * check); otherwise writes nothing and throws ConcurrencyConflict. At most
   * MAX_TRANSACTION_OPERATIONS operations, each key at most once.
   */
  transact(writes: readonly TransactionWrite[], checks: readonly TransactionCheck[]): Promise<void>;
  query<T>(
    entity: string,
    index: string,
    partition: readonly IndexValue[],
    cursor: string | null,
  ): Promise<EntityPage<T>>;
}

/** Reads every page of an index query. */
export async function queryAll<T>(
  store: EntityStore,
  entity: string,
  index: string,
  partition: readonly IndexValue[],
): Promise<T[]> {
  const values: T[] = [];
  let cursor: string | null = null;

  do {
    const page: EntityPage<T> = await store.query<T>(entity, index, partition, cursor);
    values.push(...page.values);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return values;
}

/**
 * EntityStore backed by `@forge/kvs`. The KVS client does not expose a distinct error code for a
 * failed condition, so after a failed conditional write the record is re-read: if it now differs
 * from what the caller expected, the failure is reported as ConcurrencyConflict; otherwise the
 * original error is rethrown.
 */
export class KvsEntityStore implements EntityStore {
  async get<T>(entity: string, key: string): Promise<T | undefined> {
    return await kvs.entity<T>(entity).get(key);
  }

  async create<T>(entity: string, key: string, value: T): Promise<void> {
    try {
      await kvs.entity<T>(entity).set(key, value, { keyPolicy: 'FAIL_IF_EXISTS' });
    } catch (error: unknown) {
      if ((await this.get<T>(entity, key)) !== undefined) {
        throw new ConcurrencyConflict();
      }

      throw error;
    }
  }

  async replace<T extends VersionedRecord>(
    entity: string,
    key: string,
    value: T,
    expectedVersion: number,
  ): Promise<void> {
    try {
      await kvs
        .transact()
        .set(key, value, {
          entityName: entity,
          conditions: new Filter<T>().and('version', FilterConditions.equalTo(expectedVersion)),
        })
        .execute();
    } catch (error: unknown) {
      const current = await this.get<T>(entity, key);

      if (current?.version !== expectedVersion) {
        throw new ConcurrencyConflict();
      }

      throw error;
    }
  }

  async put<T>(entity: string, key: string, value: T): Promise<void> {
    await kvs.entity<T>(entity).set(key, value);
  }

  async transact(
    writes: readonly TransactionWrite[],
    checks: readonly TransactionCheck[],
  ): Promise<void> {
    let transaction = kvs.transact();

    for (const write of writes) {
      transaction = transaction.set<VersionedRecord>(
        write.key,
        write.value as VersionedRecord,
        write.expectedVersion === undefined
          ? { entityName: write.entity }
          : {
              entityName: write.entity,
              conditions: new Filter<VersionedRecord>().and(
                'version',
                FilterConditions.equalTo(write.expectedVersion),
              ),
            },
      );
    }

    for (const check of checks) {
      const [first, ...rest] = Object.entries(check.equals);

      if (first === undefined) {
        continue;
      }

      let conditions = new Filter<Record<string, IndexValue>>().and(
        first[0],
        FilterConditions.equalTo(first[1]),
      );

      for (const [attribute, value] of rest) {
        conditions = conditions.and(attribute, FilterConditions.equalTo(value));
      }

      transaction = transaction.check(check.key, { entityName: check.entity, conditions });
    }

    try {
      await transaction.execute();
    } catch (error: unknown) {
      // As for `replace`: a failed condition has no distinct error code, so re-read to decide.
      if (await this.anyConditionFails(writes, checks)) {
        throw new ConcurrencyConflict();
      }

      throw error;
    }
  }

  private async anyConditionFails(
    writes: readonly TransactionWrite[],
    checks: readonly TransactionCheck[],
  ): Promise<boolean> {
    for (const write of writes) {
      if (write.expectedVersion !== undefined) {
        const current = await this.get<VersionedRecord>(write.entity, write.key);

        if (current?.version !== write.expectedVersion) {
          return true;
        }
      }
    }

    for (const check of checks) {
      if (!satisfies(await this.get<unknown>(check.entity, check.key), check)) {
        return true;
      }
    }

    return false;
  }

  async delete(entity: string, key: string): Promise<void> {
    await kvs.entity(entity).delete(key);
  }

  async query<T>(
    entity: string,
    index: string,
    partition: readonly IndexValue[],
    cursor: string | null,
  ): Promise<EntityPage<T>> {
    const base = kvs
      .entity<T>(entity)
      .query()
      .index(index, { partition: [...partition] })
      .limit(QUERY_PAGE_SIZE);
    const page = await (cursor === null ? base : base.cursor(cursor)).getMany();

    return {
      values: page.results.map((result) => result.value),
      nextCursor: page.nextCursor ?? null,
    };
  }
}
