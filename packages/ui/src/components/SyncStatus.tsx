import type { SessionView, SyncView, TicketView } from '@planning-poker/contracts';
import { useEffect, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction } from '../hooks';
import { ErrorMessage } from './Feedback';

/** Re-check whether a stuck write has become retryable this often. */
const CLOCK_TICK_MS = 15_000;

export interface SyncStatusProps {
  readonly api: PlanningPokerApi;
  readonly sessionId: string;
  readonly ticket: TicketView;
  readonly canModerate: boolean;
}

const TONES: Readonly<Record<SyncView['state'], string>> = {
  'not-required': 'neutral',
  pending: 'neutral',
  syncing: 'neutral',
  succeeded: 'green',
  failed: 'amber',
  conflict: 'amber',
};

const BADGES: Readonly<Record<SyncView['state'], string>> = {
  'not-required': '',
  pending: 'Waiting to save',
  syncing: 'Saving',
  succeeded: 'Saved',
  failed: 'Not saved',
  conflict: 'Changed in Jira',
};

function describe(sync: SyncView, stuck: boolean): string {
  const target = sync.fieldName ?? 'the work item';
  const value = sync.value ?? '';

  if (sync.state === 'succeeded') {
    return `${value} was saved to ${target}.`;
  }

  if (sync.state === 'failed') {
    return `${value} could not be saved to ${target}. ${sync.message ?? ''}`.trim();
  }

  if (sync.state === 'conflict') {
    return `${sync.message ?? `${target} was changed in Jira.`} It was not overwritten.`;
  }

  if (stuck) {
    return `Saving ${value} to ${target} did not finish.`;
  }

  return `Saving ${value} to ${target}…`;
}

/** Ticks while an update is in progress so a stuck write becomes retryable without a reload. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, CLOCK_TICK_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [active]);

  return now;
}

/**
 * The write of a ticket's final estimate to the work item: saved, failed (with the reason),
 * or changed in Jira (a conflict that is never overwritten without confirmation). Moderators can
 * retry; the result arrives through the session's live refresh.
 */
export function SyncStatus({ api, sessionId, ticket, canModerate }: SyncStatusProps) {
  const { sync } = ticket;
  const action = useAction();
  const [confirming, setConfirming] = useState(false);
  const now = useNow(sync.state === 'syncing');

  if (sync.state === 'not-required') {
    return null;
  }

  const retryAt = sync.retryAvailableAt === null ? null : Date.parse(sync.retryAvailableAt);
  // Failed and conflicting writes are retryable at once; only a stuck write waits (server time).
  const stuck = sync.state === 'syncing' && retryAt !== null && retryAt <= now;
  const canRetry = canModerate && (sync.state === 'failed' || sync.state === 'conflict' || stuck);
  const retry = (confirmOverwrite: boolean) => {
    void action.run(async () => {
      await api.call('retrySync', { sessionId, ticketId: ticket.id, confirmOverwrite });
      setConfirming(false);
    });
  };

  return (
    <div className="pp-note pp-stack" role="status" aria-label="Saving to Jira">
      <p className="pp-row">
        <span className="pp-badge" data-tone={TONES[sync.state]}>
          {BADGES[sync.state]}
        </span>
        <span className="pp-row-main">{describe(sync, stuck)}</span>
      </p>
      {canRetry && sync.state !== 'conflict' && (
        <div className="pp-row">
          <button
            type="button"
            className="pp-button"
            disabled={action.pending}
            onClick={() => {
              retry(false);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {canRetry && sync.state === 'conflict' && !confirming && (
        <div className="pp-row">
          <button
            type="button"
            className="pp-button"
            disabled={action.pending}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Overwrite Jira value
          </button>
        </div>
      )}
      {canRetry && sync.state === 'conflict' && confirming && (
        <div className="pp-row">
          <span className="pp-row-main">
            Replace the value in Jira with {sync.value ?? 'the estimate'}?
          </span>
          <button
            type="button"
            className="pp-button pp-button-danger"
            disabled={action.pending}
            onClick={() => {
              retry(true);
            }}
          >
            Yes, overwrite
          </button>
          <button
            type="button"
            className="pp-button"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Keep Jira value
          </button>
        </div>
      )}
      <ErrorMessage message={action.error} />
    </div>
  );
}

export interface SyncIssuesProps {
  readonly api: PlanningPokerApi;
  readonly session: SessionView;
}

/** Earlier tickets whose estimate is not saved yet, so moderators can fix them after moving on. */
export function SyncIssues({ api, session }: SyncIssuesProps) {
  const tickets = session.tickets.filter(
    (ticket) =>
      ticket.id !== session.currentTicketId &&
      (ticket.sync.state === 'failed' ||
        ticket.sync.state === 'conflict' ||
        ticket.sync.state === 'syncing'),
  );

  if (tickets.length === 0) {
    return null;
  }

  return (
    <section className="pp-card pp-stack" aria-labelledby="pp-sync-issues-title">
      <h3 id="pp-sync-issues-title" className="pp-section-title">
        Jira updates ({tickets.length})
      </h3>
      <ul className="pp-list">
        {tickets.map((ticket) => (
          <li key={ticket.id} className="pp-stack">
            <div className="pp-row">
              <span className="pp-badge">{ticket.displayKey}</span>
              <span className="pp-row-main">{ticket.title}</span>
            </div>
            <SyncStatus
              api={api}
              sessionId={session.id}
              ticket={ticket}
              canModerate={session.viewer.canModerate}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
