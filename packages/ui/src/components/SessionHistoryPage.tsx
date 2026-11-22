import type {
  HistoryStatusDto,
  SessionHistoryItemView,
  SessionHistoryPayload,
  SessionHistoryView,
} from '@planning-poker/contracts';
import { useCallback, useId, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction, useLoad } from '../hooks';
import { STATUS_LABELS } from '../labels';
import { formatDate, HISTORY_STATUS_LABELS } from '../report-labels';
import { EmptyState } from './EmptyState';
import { ErrorMessage, Loading } from './Feedback';
import { SessionSummary } from './SessionSummary';

export interface SessionHistoryPageProps {
  readonly api: PlanningPokerApi;
}

interface Filters {
  readonly teamId: string;
  readonly status: HistoryStatusDto | '';
  readonly from: string;
  readonly to: string;
}

const NO_FILTERS: Filters = { teamId: '', status: '', from: '', to: '' };

function payload(filters: Filters, cursor: string | null): SessionHistoryPayload {
  return {
    teamId: filters.teamId === '' ? null : filters.teamId,
    status: filters.status === '' ? null : filters.status,
    from: filters.from === '' ? null : filters.from,
    to: filters.to === '' ? null : filters.to,
    cursor,
  };
}

/** Published sessions the viewer can see, filtered by team, status and date. */
export function SessionHistoryPage({ api }: SessionHistoryPageProps) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [extra, setExtra] = useState<{
    readonly items: readonly SessionHistoryItemView[];
    readonly nextCursor: string | null;
  } | null>(null);
  const load = useCallback(
    async () => await api.call('listSessionHistory', payload(filters, null)),
    [api, filters],
  );
  const { state } = useLoad<SessionHistoryView>(load);
  const more = useAction();

  if (openedId !== null) {
    return (
      <SessionSummary
        api={api}
        sessionId={openedId}
        backLabel="Back to history"
        onBack={() => {
          setOpenedId(null);
        }}
      />
    );
  }

  const loaded = state.status === 'loaded' ? state.value : null;
  const items = [...(loaded?.items ?? []), ...(extra?.items ?? [])];
  const nextCursor = extra === null ? (loaded?.nextCursor ?? null) : extra.nextCursor;

  return (
    <section className="pp-page" aria-labelledby="pp-history-title">
      <h2 id="pp-history-title" className="pp-page-title">
        Session History
      </h2>
      <HistoryFilters
        teams={loaded?.teams ?? []}
        filters={filters}
        onChange={(next) => {
          setExtra(null);
          setFilters(next);
        }}
      />
      {state.status === 'loading' && <Loading />}
      {state.status === 'failed' && <ErrorMessage message={state.message} />}
      {loaded !== null && items.length === 0 && (
        <EmptyState
          title="No sessions found"
          message={
            filters === NO_FILTERS
              ? 'Published sessions you take part in or moderate appear here.'
              : 'Try different filters.'
          }
        />
      )}
      {loaded !== null && items.length > 0 && (
        <>
          <p className="pp-muted" role="status">
            Showing {items.length} of {loaded.total} {loaded.total === 1 ? 'session' : 'sessions'}
          </p>
          <HistoryTable
            items={items}
            onOpen={(id) => {
              setOpenedId(id);
            }}
          />
          <ErrorMessage message={more.error} />
          {nextCursor !== null && (
            <div>
              <button
                type="button"
                className="pp-button"
                disabled={more.pending}
                onClick={() => {
                  void more.run(async () => {
                    const page = await api.call('listSessionHistory', payload(filters, nextCursor));
                    setExtra({
                      items: [...(extra?.items ?? []), ...page.items],
                      nextCursor: page.nextCursor,
                    });
                  });
                }}
              >
                Show more
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function HistoryFilters({
  teams,
  filters,
  onChange,
}: {
  readonly teams: SessionHistoryView['teams'];
  readonly filters: Filters;
  readonly onChange: (filters: Filters) => void;
}) {
  const teamId = useId();
  const statusId = useId();
  const fromId = useId();
  const toId = useId();

  return (
    <form
      className="pp-card pp-filters"
      aria-label="Filter sessions"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="pp-stack">
        <label htmlFor={teamId} className="pp-label">
          Team
        </label>
        <select
          id={teamId}
          className="pp-input"
          value={filters.teamId}
          onChange={(event) => {
            onChange({ ...filters, teamId: event.target.value });
          }}
        >
          <option value="">All teams</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </div>
      <div className="pp-stack">
        <label htmlFor={statusId} className="pp-label">
          Status
        </label>
        <select
          id={statusId}
          className="pp-input"
          value={filters.status}
          onChange={(event) => {
            onChange({ ...filters, status: event.target.value as Filters['status'] });
          }}
        >
          <option value="">Any status</option>
          {Object.entries(HISTORY_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="pp-stack">
        <label htmlFor={fromId} className="pp-label">
          From
        </label>
        <input
          id={fromId}
          type="date"
          className="pp-input"
          value={filters.from}
          max={filters.to === '' ? undefined : filters.to}
          onChange={(event) => {
            onChange({ ...filters, from: event.target.value });
          }}
        />
      </div>
      <div className="pp-stack">
        <label htmlFor={toId} className="pp-label">
          To
        </label>
        <input
          id={toId}
          type="date"
          className="pp-input"
          value={filters.to}
          min={filters.from === '' ? undefined : filters.from}
          onChange={(event) => {
            onChange({ ...filters, to: event.target.value });
          }}
        />
      </div>
      <div className="pp-filters-actions">
        <button
          type="button"
          className="pp-button"
          onClick={() => {
            onChange(NO_FILTERS);
          }}
        >
          Clear filters
        </button>
      </div>
    </form>
  );
}

/** Session rows with a summary link. Shared with the team report. */
export function HistoryTable({
  items,
  onOpen,
  caption = 'Sessions',
}: {
  readonly items: readonly SessionHistoryItemView[];
  readonly onOpen: (sessionId: string) => void;
  readonly caption?: string;
}) {
  return (
    <div className="pp-table-wrap">
      <table className="pp-table">
        <caption className="pp-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Team</th>
            <th scope="col">Status</th>
            <th scope="col">Date</th>
            <th scope="col">Tickets</th>
            <th scope="col">Estimated</th>
            <th scope="col">Skipped</th>
            <th scope="col">Unresolved</th>
            <th scope="col">
              <span className="pp-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.name}</th>
              <td>{item.teamName}</td>
              <td>
                <span className="pp-badge" data-status={item.status}>
                  {STATUS_LABELS[item.status]}
                </span>
              </td>
              <td>{formatDate(item.date)}</td>
              <td>{item.tickets}</td>
              <td>{item.estimated}</td>
              <td>{item.skipped}</td>
              <td>{item.unresolved}</td>
              <td>
                <button
                  type="button"
                  className="pp-button"
                  onClick={() => {
                    onOpen(item.id);
                  }}
                >
                  Summary<span className="pp-visually-hidden"> of {item.name}</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
