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

/**
 * How long an attempt may stay in `syncing` before a moderator can retry it. An attempt that
 * outlives this most likely died mid-write (the process stopped); Forge functions time out long
 * before it. Retrying is safe because the provider treats a field that already holds the value
 * as written (idempotent).
 */
export const STUCK_SYNC_AFTER_MS = 120_000;

/** When a moderator may retry this update, or `null` when it cannot be retried. */
export function retryAvailableAt(update: ExternalUpdate): Date | null {
  const last = update.attempts.at(-1);

  if (update.state === 'failed' || update.state === 'conflict') {
    return last?.finishedAt ?? last?.startedAt ?? new Date(0);
  }

  if (update.state === 'syncing' && last !== undefined) {
    return new Date(last.startedAt.getTime() + STUCK_SYNC_AFTER_MS);
  }

  return null;
}

const INTERRUPTED_MESSAGE = 'The previous attempt did not finish.';

/**
 * Failed and conflicting updates may be retried, and so may an attempt stuck in `syncing` for
 * longer than STUCK_SYNC_AFTER_MS (it is closed as failed first). A conflict needs explicit
 * overwrite confirmation. Retries keep the idempotency key.
 */
export function retrySync(
  update: ExternalUpdate,
  confirmOverwrite: boolean,
  now: Date,
): ExternalUpdate {
  const availableAt = retryAvailableAt(update);
  ensure(
    availableAt !== null,
    'INVALID_STATE',
    'Only failed, conflicting or interrupted updates can be retried.',
  );
  ensure(
    availableAt.getTime() <= now.getTime(),
    'INVALID_STATE',
    'The update is still in progress. Try again in a few minutes.',
  );
  ensure(
    update.state !== 'conflict' || confirmOverwrite,
    'CONFLICT',
    'The external value changed. Confirm overwriting it before retrying.',
  );
  const closed =
    update.state === 'syncing' ? completeSync(update, 'failed', INTERRUPTED_MESSAGE, now) : update;

  return {
    ...closed,
    state: 'pending',
    overwriteConfirmed: closed.overwriteConfirmed || confirmOverwrite,
  };
}
