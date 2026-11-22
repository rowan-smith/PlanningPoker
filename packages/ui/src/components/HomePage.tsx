import type { HomeView, SessionHistoryView } from '@planning-poker/contracts';
import { useCallback } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction, useLoad } from '../hooks';
import { STATUS_LABELS } from '../labels';
import { formatDate } from '../report-labels';
import { EmptyState } from './EmptyState';
import { ErrorMessage } from './Feedback';

const ROLE_LABELS = { voter: 'Voting', observer: 'Observing' } as const;
const RECENT_SESSION_LIMIT = 5;
const HISTORY_SAMPLE = 50;

function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/** Headline numbers from the home view and the viewer's own session history. */
function HomeStats({
  home,
  history,
}: {
  readonly home: HomeView;
  readonly history: SessionHistoryView | null;
}) {
  const completed = history?.items.filter((item) => item.status === 'completed') ?? [];
  const estimated = completed.reduce((sum, item) => sum + item.estimated, 0);
  const stats = [
    { label: 'Active sessions', value: home.activeSessions.length },
    { label: 'Pending invitations', value: home.pendingInvitations.length },
    { label: 'Completed sessions', value: history === null ? '–' : completed.length },
    { label: 'Tickets estimated', value: history === null ? '–' : estimated },
  ];

  return (
    <dl className="pp-stats pp-home-stats">
      {stats.map((stat) => (
        <div key={stat.label} className="pp-stat">
          <dt className="pp-stat-label">{stat.label}</dt>
          <dd className="pp-stat-value">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RecentSessions({ history }: { readonly history: SessionHistoryView }) {
  const recent = history.items.slice(0, RECENT_SESSION_LIMIT);

  return (
    <section className="pp-page" aria-labelledby="pp-recent-title">
      <h3 id="pp-recent-title" className="pp-section-title">
        Recent sessions
      </h3>
      {recent.length === 0 ? (
        <EmptyState
          title="No sessions yet"
          message="Sessions you take part in appear here once they start."
        />
      ) : (
        <ul className="pp-list pp-card pp-home-recent">
          {recent.map((item) => (
            <li key={item.id} className="pp-stack">
              <div className="pp-row">
                <h4 className="pp-list-item-title pp-row-main">{item.name}</h4>
                <span className="pp-badge" data-status={item.status}>
                  {STATUS_LABELS[item.status]}
                </span>
              </div>
              <p className="pp-muted">
                {item.teamName} · {formatDate(item.date)} · {item.estimated} of {item.tickets}{' '}
                estimated
              </p>
              <progress
                className="pp-progress"
                value={item.estimated}
                max={Math.max(item.tickets, 1)}
                aria-label={`${item.name}: ${String(item.estimated)} of ${String(item.tickets)} tickets estimated`}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface HomePageProps {
  readonly api: PlanningPokerApi;
  readonly home: HomeView;
  readonly onHomeChange: (home: HomeView) => void;
  readonly onOpenSession: (sessionId: string) => void;
}

export function HomePage({ api, home, onHomeChange, onOpenSession }: HomePageProps) {
  const action = useAction();
  const loadHistory = useCallback(
    async () =>
      await api.call('listSessionHistory', {
        teamId: null,
        status: null,
        from: null,
        to: null,
        cursor: null,
        limit: HISTORY_SAMPLE,
      }),
    [api],
  );
  const history = useLoad<SessionHistoryView>(loadHistory);
  const historyValue = history.state.status === 'loaded' ? history.state.value : null;
  const respond = (sessionId: string, response: 'joined' | 'declined') => {
    void action.run(async () => {
      onHomeChange(await api.call('respondToInvitation', { sessionId, response }));
    });
  };

  return (
    <section className="pp-page" aria-labelledby="pp-home-title">
      <div>
        <h2 id="pp-home-title" className="pp-page-title">
          Welcome back, {firstName(home.user.displayName)}
        </h2>
        <p className="pp-muted">Plan, estimate and align your team with planning poker.</p>
      </div>
      <ErrorMessage message={action.error} />
      <HomeStats home={home} history={historyValue} />

      {home.pendingInvitations.length > 0 && (
        <section className="pp-page" aria-labelledby="pp-invitations-title">
          <h3 id="pp-invitations-title" className="pp-section-title">
            Pending invitations
          </h3>
          <ul className="pp-list">
            {home.pendingInvitations.map((invitation) => (
              <li key={invitation.sessionId} className="pp-card pp-row">
                <div className="pp-row-main">
                  <h4 className="pp-list-item-title">{invitation.sessionName}</h4>
                  <p className="pp-muted">
                    {invitation.teamName} · Invited by {invitation.invitedByName} ·{' '}
                    <span className="pp-badge">{ROLE_LABELS[invitation.role]}</span>
                  </p>
                </div>
                <button
                  type="button"
                  className="pp-button pp-button-primary"
                  disabled={action.pending}
                  onClick={() => {
                    respond(invitation.sessionId, 'joined');
                  }}
                >
                  Join<span className="pp-visually-hidden"> {invitation.sessionName}</span>
                </button>
                <button
                  type="button"
                  className="pp-button"
                  disabled={action.pending}
                  onClick={() => {
                    respond(invitation.sessionId, 'declined');
                  }}
                >
                  Decline<span className="pp-visually-hidden"> {invitation.sessionName}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="pp-home-grid">
        <section className="pp-page" aria-labelledby="pp-active-title">
          <h3 id="pp-active-title" className="pp-section-title">
            Active planning sessions
          </h3>
          {home.activeSessions.length === 0 ? (
            <EmptyState
              title="No active planning sessions"
              message="There are no active planning sessions for your teams right now."
            />
          ) : (
            <ul className="pp-list">
              {home.activeSessions.map((session) => (
                <li key={session.id} className="pp-card pp-row">
                  <div className="pp-row-main">
                    <h4 className="pp-list-item-title">{session.name}</h4>
                    <p className="pp-muted">
                      {session.teamName}
                      {session.currentTicketTitle === null
                        ? ''
                        : ` · Now: ${session.currentTicketTitle}`}
                      {session.myRole === null ? null : (
                        <>
                          {' · '}
                          <span className="pp-badge">{ROLE_LABELS[session.myRole]}</span>
                        </>
                      )}
                      {session.status === 'paused' ? ' · Paused' : null}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="pp-button"
                    onClick={() => {
                      onOpenSession(session.id);
                    }}
                  >
                    Open<span className="pp-visually-hidden"> {session.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {historyValue !== null && <RecentSessions history={historyValue} />}
      </div>
    </section>
  );
}
