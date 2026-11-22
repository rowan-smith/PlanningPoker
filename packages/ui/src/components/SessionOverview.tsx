import type { SessionView } from '@planning-poker/contracts';
import { useCallback, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction, useLoad } from '../hooks';
import { ErrorMessage, Loading } from './Feedback';
import { Roster } from './Roster';
import { STATUS_LABELS } from '../labels';

export interface SessionOverviewProps {
  readonly api: PlanningPokerApi;
  readonly sessionId: string;
  readonly onBack: () => void;
}

/** Read-only view of a published session until the planning room arrives (Milestone 5). */
export function SessionOverview({ api, sessionId, onBack }: SessionOverviewProps) {
  const load = useCallback(
    async () => await api.call('getSession', { sessionId }),
    [api, sessionId],
  );
  const { state, replace } = useLoad<SessionView>(load);
  const action = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);

  return (
    <section className="pp-page" aria-labelledby="pp-overview-title">
      <div>
        <button type="button" className="pp-button" onClick={onBack}>
          ← All sessions
        </button>
      </div>
      {state.status === 'loading' && <Loading />}
      {state.status === 'failed' && <ErrorMessage message={state.message} />}
      {state.status === 'loaded' && (
        <>
          <h2 id="pp-overview-title" className="pp-page-title">
            {state.value.name}
            <span className="pp-badge pp-badge-gap" data-status={state.value.status}>
              {STATUS_LABELS[state.value.status]}
            </span>
          </h2>
          <p className="pp-muted">
            {state.value.teamName}
            {state.value.viewer.role === 'observer' && ' · Observing — voting disabled'}
          </p>
          <p className="pp-card pp-muted" role="note">
            The planning room (voting, reveal and moderator controls) arrives in Milestone 5.
          </p>

          <section className="pp-card pp-stack" aria-labelledby="pp-overview-tickets">
            <h3 id="pp-overview-tickets" className="pp-section-title">
              Tickets ({state.value.tickets.length})
            </h3>
            <ol className="pp-list">
              {state.value.tickets.map((ticket) => (
                <li key={ticket.id} className="pp-row">
                  <span className="pp-badge">{ticket.displayKey}</span>
                  <span className="pp-row-main">{ticket.title}</span>
                  {ticket.id === state.value.currentTicketId && (
                    <span className="pp-badge">Current</span>
                  )}
                </li>
              ))}
            </ol>
          </section>

          <section className="pp-card pp-stack" aria-labelledby="pp-overview-people">
            <h3 id="pp-overview-people" className="pp-section-title">
              Participants
            </h3>
            <Roster participants={state.value.participants} />
          </section>

          {state.value.viewer.canModerate &&
            (state.value.status === 'active' || state.value.status === 'paused') && (
              <section className="pp-card pp-stack" aria-label="Cancel session">
                <ErrorMessage message={action.error} />
                <div className="pp-row">
                  {confirmCancel ? (
                    <>
                      <button
                        type="button"
                        className="pp-button pp-button-danger"
                        disabled={action.pending}
                        onClick={() => {
                          void action.run(async () => {
                            replace(await api.call('cancelSession', { sessionId }));
                          });
                        }}
                      >
                        Yes, cancel session
                      </button>
                      <button
                        type="button"
                        className="pp-button"
                        onClick={() => {
                          setConfirmCancel(false);
                        }}
                      >
                        Keep session
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="pp-button"
                      onClick={() => {
                        setConfirmCancel(true);
                      }}
                    >
                      Cancel session
                    </button>
                  )}
                </div>
              </section>
            )}
        </>
      )}
    </section>
  );
}
