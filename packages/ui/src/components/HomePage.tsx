import type { HomeView } from '@planning-poker/contracts';

import type { PlanningPokerApi } from '../api';
import { useAction } from '../hooks';
import { EmptyState } from './EmptyState';
import { ErrorMessage } from './Feedback';

const ROLE_LABELS = { voter: 'Voting', observer: 'Observing' } as const;

export interface HomePageProps {
  readonly api: PlanningPokerApi;
  readonly home: HomeView;
  readonly onHomeChange: (home: HomeView) => void;
  readonly onOpenSession: (sessionId: string) => void;
}

export function HomePage({ api, home, onHomeChange, onOpenSession }: HomePageProps) {
  const action = useAction();
  const respond = (sessionId: string, response: 'joined' | 'declined') => {
    void action.run(async () => {
      onHomeChange(await api.call('respondToInvitation', { sessionId, response }));
    });
  };

  return (
    <section className="pp-page" aria-labelledby="pp-home-title">
      <h2 id="pp-home-title" className="pp-page-title">
        Home
      </h2>
      <ErrorMessage message={action.error} />

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
    </section>
  );
}
