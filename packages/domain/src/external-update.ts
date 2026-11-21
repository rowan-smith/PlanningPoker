import type { FieldValue } from './estimate';
import { ensure } from './errors';

/** Independent of voting state: a ticket can be finalized even if the external write fails. */
export type SyncState =
  'not-required' | 'pending' | 'syncing' | 'succeeded' | 'failed' | 'conflict';

export type SyncOutcome = 'succeeded' | 'failed' | 'conflict';

export interface SyncAttempt {
  readonly attemptNumber: number;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly outcome: SyncOutcome | null;
  readonly message: string | null;
}

export interface ExternalUpdate {
  readonly state: SyncState;
  readonly fieldId: string | null;
  readonly value: FieldValue | null;
  /** Stable per ticket decision so retries never double-apply. */
  readonly idempotencyKey: string | null;
  /** Set when a moderator confirmed overwriting a conflicting external value. */
  readonly overwriteConfirmed: boolean;
  readonly attempts: readonly SyncAttempt[];
}

export const NO_EXTERNAL_UPDATE: ExternalUpdate = {
  state: 'not-required',
  fieldId: null,
  value: null,
  idempotencyKey: null,
  overwriteConfirmed: false,
  attempts: [],
};

export function pendingExternalUpdate(
  fieldId: string,
  value: FieldValue,
  idempotencyKey: string,
): ExternalUpdate {
  return {
    state: 'pending',
    fieldId,
    value,
    idempotencyKey,
    overwriteConfirmed: false,
    attempts: [],
  };
}

export function beginSync(update: ExternalUpdate, now: Date): ExternalUpdate {
  ensure(update.state === 'pending', 'INVALID_STATE', 'Only pending updates can start syncing.');

  return {
    ...update,
    state: 'syncing',
    attempts: [
      ...update.attempts,
      {
        attemptNumber: update.attempts.length + 1,
        startedAt: now,
        finishedAt: null,
        outcome: null,
        message: null,
      },
    ],
  };
}

export function completeSync(
  update: ExternalUpdate,
  outcome: SyncOutcome,
  message: string | null,
  now: Date,
): ExternalUpdate {
  ensure(update.state === 'syncing', 'INVALID_STATE', 'Only syncing updates can complete.');
  const current = update.attempts.at(-1);
  ensure(current !== undefined, 'INVALID_STATE', 'Sync has no attempt in progress.');

  return {
    ...update,
    state: outcome,
    attempts: [...update.attempts.slice(0, -1), { ...current, finishedAt: now, outcome, message }],
  };
}

/** Failed and conflicting updates may be retried. A conflict needs explicit overwrite confirmation. */
export function retrySync(update: ExternalUpdate, confirmOverwrite: boolean): ExternalUpdate {
  ensure(
    update.state === 'failed' || update.state === 'conflict',
    'INVALID_STATE',
    'Only failed or conflicting updates can be retried.',
  );
  ensure(
    update.state !== 'conflict' || confirmOverwrite,
    'CONFLICT',
    'The external value changed. Confirm overwriting it before retrying.',
  );

  return {
    ...update,
    state: 'pending',
    overwriteConfirmed: update.overwriteConfirmed || confirmOverwrite,
  };
}
