import type {
  AppReportView,
  DateRangePayload,
  ReportScopeView,
  TeamReportView,
} from '@planning-poker/contracts';
import { useCallback, useId, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useLoad } from '../hooks';
import { formatDateTime, OUTCOME_LABELS } from '../report-labels';
import { EmptyState } from './EmptyState';
import { ErrorMessage, Loading } from './Feedback';
import { HistoryTable } from './SessionHistoryPage';
import { SessionSummary, TotalsList } from './SessionSummary';

export interface ReportsPageProps {
  readonly api: PlanningPokerApi;
}

const APP_SCOPE = 'app';

interface Range {
  readonly from: string;
  readonly to: string;
}

function rangePayload(range: Range): DateRangePayload {
  return { from: range.from === '' ? null : range.from, to: range.to === '' ? null : range.to };
}

/** Team reports for team moderators and administrators; the application report for admins. */
export function ReportsPage({ api }: ReportsPageProps) {
  const load = useCallback(async () => await api.call('getReportScope', {}), [api]);
  const { state } = useLoad<ReportScopeView>(load);

  return (
    <section className="pp-page" aria-labelledby="pp-reports-title">
      <h2 id="pp-reports-title" className="pp-page-title">
        Reports
      </h2>
      {state.status === 'loading' && <Loading />}
      {state.status === 'failed' && <ErrorMessage message={state.message} />}
      {state.status === 'loaded' &&
        (state.value.teams.length === 0 && !state.value.canViewAppReport ? (
          <EmptyState
            title="No reports for you yet"
            message="Team moderators see reports for their teams; administrators see every team. Session summaries are in Session History."
          />
        ) : (
          <ReportsContent api={api} scope={state.value} />
        ))}
    </section>
  );
}

function ReportsContent({
  api,
  scope,
}: {
  readonly api: PlanningPokerApi;
  readonly scope: ReportScopeView;
}) {
  const scopeId = useId();
  const fromId = useId();
  const toId = useId();
  const [selected, setSelected] = useState(
    scope.canViewAppReport ? APP_SCOPE : (scope.teams[0]?.id ?? APP_SCOPE),
  );
  const [range, setRange] = useState<Range>({ from: '', to: '' });
  const [openedId, setOpenedId] = useState<string | null>(null);

  if (openedId !== null) {
    return (
      <SessionSummary
        api={api}
        sessionId={openedId}
        backLabel="Back to reports"
        onBack={() => {
          setOpenedId(null);
        }}
      />
    );
  }

  return (
    <>
      <form
        className="pp-card pp-filters"
        aria-label="Report options"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="pp-stack">
          <label htmlFor={scopeId} className="pp-label">
            Report
          </label>
          <select
            id={scopeId}
            className="pp-input"
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
            }}
          >
            {scope.canViewAppReport && <option value={APP_SCOPE}>All teams (application)</option>}
            {scope.teams.map((team) => (
              <option key={team.id} value={team.id}>
                Team: {team.name}
              </option>
            ))}
          </select>
        </div>
        <div className="pp-stack">
          <label htmlFor={fromId} className="pp-label">
            Completed from
          </label>
          <input
            id={fromId}
            type="date"
            className="pp-input"
            value={range.from}
            onChange={(event) => {
              setRange({ ...range, from: event.target.value });
            }}
          />
        </div>
        <div className="pp-stack">
          <label htmlFor={toId} className="pp-label">
            Completed to
          </label>
          <input
            id={toId}
            type="date"
            className="pp-input"
            value={range.to}
            onChange={(event) => {
              setRange({ ...range, to: event.target.value });
            }}
          />
        </div>
      </form>
      <p className="pp-muted">Reports include completed sessions only. Votes stay anonymous.</p>
      {selected === APP_SCOPE ? (
        <AppReport api={api} range={range} />
      ) : (
        <TeamReport api={api} teamId={selected} range={range} onOpenSession={setOpenedId} />
      )}
    </>
  );
}

function AppReport({ api, range }: { readonly api: PlanningPokerApi; readonly range: Range }) {
  const load = useCallback(
    async () => await api.call('getAppReport', rangePayload(range)),
    [api, range],
  );
  const { state } = useLoad<AppReportView>(load);

  if (state.status === 'loading') {
    return <Loading />;
  }

  if (state.status === 'failed') {
    return <ErrorMessage message={state.message} />;
  }

  const report = state.value;

  return (
    <>
      <div className="pp-card pp-stack">
        <h3 className="pp-section-title">All teams</h3>
        <dl className="pp-stats">
          <div className="pp-stat">
            <dt className="pp-stat-label">Completed sessions</dt>
            <dd className="pp-stat-value">{report.sessionCount}</dd>
          </div>
          <div className="pp-stat">
            <dt className="pp-stat-label">People who took part</dt>
            <dd className="pp-stat-value">{report.participantCount}</dd>
          </div>
        </dl>
        <TotalsList totals={report.totals} />
      </div>
      <div className="pp-card pp-stack">
        <h3 className="pp-section-title">By team</h3>
        <div className="pp-table-wrap">
          <table className="pp-table">
            <caption className="pp-visually-hidden">Completed sessions by team</caption>
            <thead>
              <tr>
                <th scope="col">Team</th>
                <th scope="col">Sessions</th>
                <th scope="col">People</th>
                <th scope="col">Tickets</th>
                <th scope="col">Estimated</th>
                <th scope="col">Disagreements</th>
                <th scope="col">Overrides</th>
                <th scope="col">Jira saves failed</th>
              </tr>
            </thead>
            <tbody>
              {report.teams.map((team) => (
                <tr key={team.teamId}>
                  <th scope="row">
                    {team.teamName}
                    {team.archived && <span className="pp-muted"> · Archived</span>}
                  </th>
                  <td>{team.sessionCount}</td>
                  <td>{team.participantCount}</td>
                  <td>{team.totals.tickets}</td>
                  <td>{team.totals.estimated}</td>
                  <td>{team.totals.disagreements}</td>
                  <td>{team.totals.overrides}</td>
                  <td>{team.totals.sync.failed + team.totals.sync.conflict}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function TeamReport({
  api,
  teamId,
  range,
  onOpenSession,
}: {
  readonly api: PlanningPokerApi;
  readonly teamId: string;
  readonly range: Range;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const load = useCallback(
    async () => await api.call('getTeamReport', { teamId, ...rangePayload(range) }),
    [api, teamId, range],
  );
  const { state } = useLoad<TeamReportView>(load);

  if (state.status === 'loading') {
    return <Loading />;
  }

  if (state.status === 'failed') {
    return <ErrorMessage message={state.message} />;
  }

  const report = state.value;

  if (report.sessions.length === 0) {
    return (
      <EmptyState
        title={`No completed sessions for ${report.teamName}`}
        message="Completed sessions in the chosen dates appear here."
      />
    );
  }

  return (
    <>
      <div className="pp-card pp-stack">
        <h3 className="pp-section-title">{report.teamName}</h3>
        <TotalsList totals={report.totals} />
      </div>
      <div className="pp-card pp-stack">
        <h3 className="pp-section-title">Completed sessions</h3>
        <HistoryTable items={report.sessions} onOpen={onOpenSession} caption="Completed sessions" />
      </div>
      <div className="pp-card pp-stack">
        <h3 className="pp-section-title">Participants</h3>
        <p className="pp-muted">How often each person took part. Never what anyone voted.</p>
        <div className="pp-table-wrap">
          <table className="pp-table">
            <caption className="pp-visually-hidden">Participant statistics</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Invited</th>
                <th scope="col">Joined</th>
                <th scope="col">Declined</th>
                <th scope="col">Voted in</th>
                <th scope="col">Observed</th>
                <th scope="col">Facilitated</th>
                <th scope="col">Times skipped</th>
                <th scope="col">Rounds voted</th>
              </tr>
            </thead>
            <tbody>
              {report.participants.map((entry) => (
                <tr key={entry.person.userId}>
                  <th scope="row">{entry.person.displayName}</th>
                  <td>{entry.sessionsInvited}</td>
                  <td>{entry.sessionsJoined}</td>
                  <td>{entry.sessionsDeclined}</td>
                  <td>{entry.sessionsVoted}</td>
                  <td>{entry.sessionsObserved}</td>
                  <td>{entry.sessionsFacilitated}</td>
                  <td>{entry.timesSkipped}</td>
                  <td>{entry.roundsVoted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="pp-card pp-stack">
        <h3 className="pp-section-title">Disagreements</h3>
        {report.disagreements.length === 0 ? (
          <p className="pp-muted">No disagreements in these sessions.</p>
        ) : (
          <div className="pp-table-wrap">
            <table className="pp-table">
              <caption className="pp-visually-hidden">Tickets with disagreements</caption>
              <thead>
                <tr>
                  <th scope="col">Ticket</th>
                  <th scope="col">Session</th>
                  <th scope="col">Disagreements</th>
                  <th scope="col">Revotes</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {report.disagreements.map((entry) => (
                  <tr key={`${entry.sessionId}-${entry.displayKey}`}>
                    <th scope="row">
                      <span className="pp-mono">{entry.displayKey}</span> {entry.title}
                    </th>
                    <td>{entry.sessionName}</td>
                    <td>{entry.disagreements}</td>
                    <td>{entry.revotes}</td>
                    <td>
                      {OUTCOME_LABELS[entry.outcome]}
                      {entry.finalLabel !== null &&
                        ` · ${entry.finalLabel}${entry.decisionKind === 'override' ? ' (override)' : ''}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="pp-card pp-stack">
        <h3 className="pp-section-title">Overrides</h3>
        {report.overrides.length === 0 ? (
          <p className="pp-muted">No moderator overrides in these sessions.</p>
        ) : (
          <div className="pp-table-wrap">
            <table className="pp-table">
              <caption className="pp-visually-hidden">Moderator overrides</caption>
              <thead>
                <tr>
                  <th scope="col">Ticket</th>
                  <th scope="col">Session</th>
                  <th scope="col">Estimate</th>
                  <th scope="col">Reason</th>
                  <th scope="col">By</th>
                  <th scope="col">When</th>
                </tr>
              </thead>
              <tbody>
                {report.overrides.map((entry) => (
                  <tr key={`${entry.sessionId}-${entry.displayKey}`}>
                    <th scope="row">
                      <span className="pp-mono">{entry.displayKey}</span> {entry.title}
                    </th>
                    <td>{entry.sessionName}</td>
                    <td>{entry.label}</td>
                    <td>{entry.reason ?? '—'}</td>
                    <td>{entry.decidedByName ?? 'System'}</td>
                    <td>{formatDateTime(entry.decidedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
