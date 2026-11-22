import type {
  ParticipantCategoriesView,
  ReportTotalsView,
  RoundSummaryView,
  SessionReportView,
  TicketSummaryView,
} from '@planning-poker/contracts';
import { useCallback, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useLoad } from '../hooks';
import { STATUS_LABELS } from '../labels';
import {
  formatDateTime,
  OUTCOME_LABELS,
  OUTCOME_TONES,
  PARTICIPANT_CATEGORY_LABELS,
  SYNC_LABELS,
} from '../report-labels';
import { AuditLog } from './AuditLog';
import { ErrorMessage, Loading } from './Feedback';

export interface SessionSummaryProps {
  readonly api: PlanningPokerApi;
  readonly sessionId: string;
  readonly onBack: () => void;
  /** Label for the back button, e.g. "Back to history". */
  readonly backLabel?: string;
}

/** The permanent summary of a session. Shows anonymous results only, never who voted what. */
export function SessionSummary({
  api,
  sessionId,
  onBack,
  backLabel = 'Back',
}: SessionSummaryProps) {
  const load = useCallback(
    async () => await api.call('getSessionSummary', { sessionId }),
    [api, sessionId],
  );
  const { state } = useLoad<SessionReportView>(load);

  return (
    <section className="pp-page" aria-labelledby="pp-summary-title">
      <div>
        <button type="button" className="pp-button" onClick={onBack}>
          <span aria-hidden="true">← </span>
          {backLabel}
        </button>
      </div>
      {state.status === 'loading' && <Loading />}
      {state.status === 'failed' && <ErrorMessage message={state.message} />}
      {state.status === 'loaded' && <SummaryContent api={api} report={state.value} />}
    </section>
  );
}

function SummaryContent({
  api,
  report,
}: {
  readonly api: PlanningPokerApi;
  readonly report: SessionReportView;
}) {
  const [showAudit, setShowAudit] = useState(false);

  return (
    <>
      <div>
        <h2 id="pp-summary-title" className="pp-page-title">
          {report.name}
          <span className="pp-badge pp-badge-gap" data-status={report.status}>
            {STATUS_LABELS[report.status]}
          </span>
        </h2>
        <p className="pp-muted">Session summary · {report.teamName}</p>
      </div>
      {report.status !== 'completed' && (
        <p className="pp-note" role="status">
          This session is not completed yet, so the summary may still change.
        </p>
      )}
      <div className="pp-card pp-stack">
        <h3 className="pp-section-title">Overview</h3>
        <dl className="pp-summary">
          <dt>Team</dt>
          <dd>{report.teamName}</dd>
          <dt>Moderator</dt>
          <dd>{report.moderator.displayName}</dd>
          <dt>Facilitators</dt>
          <dd>{names(report.participants.facilitators)}</dd>
          <dt>Started</dt>
          <dd>{formatDateTime(report.startedAt)}</dd>
          <dt>Completed</dt>
          <dd>{formatDateTime(report.completedAt)}</dd>
        </dl>
      </div>
      <div className="pp-card pp-stack">
        <h3 className="pp-section-title">Results</h3>
        <TotalsList totals={report.totals} />
      </div>
      <ParticipantsCard participants={report.participants} />
      <TicketsCard tickets={report.tickets} />
      {report.canViewAudit && (
        <div className="pp-card pp-stack">
          <div className="pp-row">
            <h3 className="pp-section-title pp-row-main">Audit log</h3>
            <button
              type="button"
              className="pp-button"
              aria-expanded={showAudit}
              onClick={() => {
                setShowAudit((current) => !current);
              }}
            >
              {showAudit ? 'Hide audit log' : 'Show audit log'}
            </button>
          </div>
          {showAudit && <AuditLog api={api} sessionId={report.id} />}
        </div>
      )}
    </>
  );
}

function names(list: readonly { readonly displayName: string }[]): string {
  return list.length === 0 ? '—' : list.map((entry) => entry.displayName).join(', ');
}

/** Ticket and outcome counts as a definition list. Shared with the reports page. */
export function TotalsList({ totals }: { readonly totals: ReportTotalsView }) {
  const entries: readonly (readonly [string, number])[] = [
    ['Tickets', totals.tickets],
    ['Estimated', totals.estimated],
    ['Skipped', totals.skipped],
    ['Unresolved', totals.unresolved],
    ...(totals.inProgress > 0 ? [['In progress', totals.inProgress] as const] : []),
    ['Unanimous', totals.unanimous],
    ['Disagreements', totals.disagreements],
    ['Revotes', totals.revotes],
    ['Overrides', totals.overrides],
    ['Saved to Jira', totals.sync.succeeded],
    ['Jira saves failed', totals.sync.failed],
    ['Changed in Jira', totals.sync.conflict],
    ['Waiting to save', totals.sync.pending + totals.sync.syncing],
  ];

  return (
    <dl className="pp-stats">
      {entries.map(([label, value]) => (
        <div key={label} className="pp-stat">
          <dt className="pp-stat-label">{label}</dt>
          <dd className="pp-stat-value">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ParticipantsCard({ participants }: { readonly participants: ParticipantCategoriesView }) {
  return (
    <div className="pp-card pp-stack">
      <h3 className="pp-section-title">Participants</h3>
      <p className="pp-muted">
        A person can appear in more than one group, for example a voter who was skipped for one
        ticket.
      </p>
      <dl className="pp-summary">
        {PARTICIPANT_CATEGORY_LABELS.filter(
          ({ key }) => key !== 'facilitators' && participants[key].length > 0,
        ).map(({ key, label, description }) => (
          <div key={key} className="pp-summary-row">
            <dt>
              {label} ({participants[key].length})
              <span className="pp-visually-hidden">: {description}</span>
            </dt>
            <dd>{names(participants[key])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function TicketsCard({ tickets }: { readonly tickets: readonly TicketSummaryView[] }) {
  return (
    <div className="pp-card pp-stack">
      <h3 className="pp-section-title">Tickets</h3>
      <div className="pp-table-wrap">
        <table className="pp-table">
          <caption className="pp-visually-hidden">Ticket outcomes</caption>
          <thead>
            <tr>
              <th scope="col">Ticket</th>
              <th scope="col">Outcome</th>
              <th scope="col">Final estimate</th>
              <th scope="col">Revealed rounds</th>
              <th scope="col">Disagreements</th>
              <th scope="col">Revotes</th>
              <th scope="col">Skipped voters</th>
              <th scope="col">Jira</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((ticket) => (
              <tr key={ticket.id}>
                <th scope="row">
                  <span className="pp-mono">{ticket.displayKey}</span> {ticket.title}
                </th>
                <td>
                  <span className="pp-badge" data-tone={OUTCOME_TONES[ticket.outcome]}>
                    {OUTCOME_LABELS[ticket.outcome]}
                  </span>
                  {ticket.unanimous && <span className="pp-muted"> · Unanimous</span>}
                </td>
                <td>
                  {ticket.decision === null ? (
                    '—'
                  ) : (
                    <>
                      <strong>{ticket.decision.label}</strong>
                      <span className="pp-muted">
                        {ticket.decision.kind === 'override' ? ' · Override' : ' · Consensus'}
                      </span>
                      {ticket.decision.reason !== null && (
                        <p className="pp-muted">Reason: {ticket.decision.reason}</p>
                      )}
                    </>
                  )}
                </td>
                <td>{ticket.revealedRounds.length}</td>
                <td>{ticket.disagreements}</td>
                <td>{ticket.revotes}</td>
                <td>{names(ticket.skippedVoters)}</td>
                <td>
                  {SYNC_LABELS[ticket.sync.state]}
                  {ticket.sync.lastMessage !== null && ticket.sync.state !== 'succeeded' && (
                    <p className="pp-muted">{ticket.sync.lastMessage}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {tickets
        .filter((ticket) => ticket.revealedRounds.length > 0)
        .map((ticket) => (
          <details key={ticket.id} className="pp-details">
            <summary>
              Results for <span className="pp-mono">{ticket.displayKey}</span> {ticket.title}
            </summary>
            {ticket.revealedRounds.map((round) => (
              <RoundResult key={round.number} round={round} />
            ))}
          </details>
        ))}
    </div>
  );
}

/** One revealed round: values and counts in deck order, never who voted what. */
function RoundResult({ round }: { readonly round: RoundSummaryView }) {
  return (
    <div className="pp-stack pp-round-result">
      <p className="pp-label">
        Round {round.number} · {round.outcome === 'unanimous' ? 'Unanimous' : 'Disagreement'} ·{' '}
        {round.voteCount} {round.voteCount === 1 ? 'vote' : 'votes'}
      </p>
      <ul className="pp-list" aria-label={`Round ${String(round.number)} distribution`}>
        {round.distribution.map((entry) => (
          <li key={entry.cardId} className="pp-distribution">
            <span className="pp-distribution-label">{entry.label}</span>
            <meter
              className="pp-distribution-bar"
              min={0}
              max={round.voteCount}
              value={entry.count}
              aria-label={`${entry.label}: ${String(entry.count)} of ${String(round.voteCount)}`}
            />
            <span className="pp-muted">{entry.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
