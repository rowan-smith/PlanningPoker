/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- storage returns untyped JSON; the type parameter names the record type the caller expects. */
import { ConcurrencyConflict } from '@planning-poker/application';

import type {
  EntityPage,
  EntityStore,
  IndexValue,
  TransactionCheck,
  TransactionWrite,
  VersionedRecord,
} from '../entity-store';
import { MAX_TRANSACTION_OPERATIONS, satisfies } from '../entity-store';

/** Round-trips through JSON, like values written to Forge storage. */
function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** Index definitions: index name → the record attributes forming its partition. */
export type IndexDefinitions = Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
>;

/**
 * Behaves like the Forge entity store for contract tests: conditional writes, partitioned
 * queries and cursor paging. Values are serialized like real storage, so tests catch shared state and non-JSON values.
 */
export class InMemoryEntityStore implements EntityStore {
  readonly records = new Map<string, unknown>();
  private readonly indexes: IndexDefinitions;
  private readonly pageSize: number;

  constructor(indexes: IndexDefinitions, pageSize = 2) {
    this.indexes = indexes;
    this.pageSize = pageSize;
  }

  get<T>(entity: string, key: string): Promise<T | undefined> {
    const value = this.records.get(`${entity}/${key}`);

    return Promise.resolve(value === undefined ? undefined : (clone(value) as T));
  }

  create<T>(entity: string, key: string, value: T): Promise<void> {
    if (this.records.has(`${entity}/${key}`)) {
      return Promise.reject(new ConcurrencyConflict());
    }

    this.records.set(`${entity}/${key}`, clone(value));

    return Promise.resolve();
  }

  replace<T extends VersionedRecord>(
    entity: string,
    key: string,
    value: T,
    expectedVersion: number,
  ): Promise<void> {
    const current = this.records.get(`${entity}/${key}`) as VersionedRecord | undefined;

    if (current?.version !== expectedVersion) {
      return Promise.reject(new ConcurrencyConflict());
    }

    this.records.set(`${entity}/${key}`, clone(value));

    return Promise.resolve();
  }

  put<T>(entity: string, key: string, value: T): Promise<void> {
    this.records.set(`${entity}/${key}`, clone(value));

    return Promise.resolve();
  }

  delete(entity: string, key: string): Promise<void> {
    this.records.delete(`${entity}/${key}`);

    return Promise.resolve();
  }

  /** All-or-nothing, with Forge's limits on operation count and repeated keys. */
  transact(
    writes: readonly TransactionWrite[],
    checks: readonly TransactionCheck[],
  ): Promise<void> {
    const keys = [...writes, ...checks].map((operation) => `${operation.entity}/${operation.key}`);

    if (keys.length > MAX_TRANSACTION_OPERATIONS || new Set(keys).size !== keys.length) {
      return Promise.reject(new Error('Invalid transaction.'));
    }

    const versionsHold = writes.every(
      (write) =>
        write.expectedVersion === undefined ||
        (this.records.get(`${write.entity}/${write.key}`) as VersionedRecord | undefined)
          ?.version === write.expectedVersion,
    );
    const checksHold = checks.every((check) =>
      satisfies(this.records.get(`${check.entity}/${check.key}`), check),
    );

    if (!versionsHold || !checksHold) {
      return Promise.reject(new ConcurrencyConflict());
    }

    for (const write of writes) {
      this.records.set(`${write.entity}/${write.key}`, clone(write.value));
    }

    return Promise.resolve();
  }

  query<T>(
    entity: string,
    index: string,
    partition: readonly IndexValue[],
    cursor: string | null,
  ): Promise<EntityPage<T>> {
    const attributes = this.indexes[entity]?.[index];

    if (attributes === undefined) {
      return Promise.reject(new Error(`Unknown index ${entity}.${index}`));
    }

    const matches = [...this.records.entries()]
      .filter(([key]) => key.startsWith(`${entity}/`))
      .map(([, value]) => value as Record<string, unknown>)
      .filter((value) => attributes.every((attribute, i) => value[attribute] === partition[i]));
    const start = cursor === null ? 0 : Number(cursor);
    const end = start + this.pageSize;

    return Promise.resolve({
      values: matches.slice(start, end).map((value) => clone(value) as T),
      nextCursor: end < matches.length ? String(end) : null,
    });
  }
}

/** Index definitions mirroring apps/jira-forge/manifest.yml. */
export const MANIFEST_INDEXES: IndexDefinitions = {
  team: { 'by-tenant': ['tenantId'] },
  auditevent: { 'by-team': ['teamId'], 'by-session': ['sessionId'] },
  session: { 'by-team': ['teamId'] },
  sessionmember: { 'by-user': ['userId'], 'by-session': ['sessionId'] },
  vote: { 'by-round': ['roundId'] },
};
