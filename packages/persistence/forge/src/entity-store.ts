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
