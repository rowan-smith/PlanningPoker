import type { SessionListView } from '@planning-poker/contracts';
import { useCallback, useId, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction, useLoad } from '../hooks';
import { EmptyState } from './EmptyState';
import { ErrorMessage, Loading } from './Feedback';
import { SessionBuilder } from './SessionBuilder';
import { PlanningRoom } from './PlanningRoom';
import { STATUS_LABELS } from '../labels';

export interface SessionsPageProps {
  readonly api: PlanningPokerApi;
  /** Session to open directly, e.g. from Home. */
  readonly initialSessionId?: string | null;
}

type Opened = { readonly id: string; readonly mode: 'builder' | 'overview' } | null;

export function SessionsPage({ api, initialSessionId = null }: SessionsPageProps) {
  const [opened, setOpened] = useState<Opened>(
    initialSessionId === null ? null : { id: initialSessionId, mode: 'overview' },
  );
  const load = useCallback(async () => await api.call('listSessions', {}), [api]);
  const { state, reload } = useLoad<SessionListView>(load);
  const back = () => {
    setOpened(null);
    reload();
  };

  if (opened?.mode === 'builder') {
    return (
      <SessionBuilder
        api={api}
        sessionId={opened.id}
        onBack={back}
        onPublished={() => {
          setOpened({ id: opened.id, mode: 'overview' });
        }}
      />
    );
  }

  if (opened?.mode === 'overview') {
    return <PlanningRoom api={api} sessionId={opened.id} onBack={back} />;
  }

  return (
    <section className="pp-page" aria-labelledby="pp-sessions-title">
      <h2 id="pp-sessions-title" className="pp-page-title">
        Planning Sessions
      </h2>
      {state.status === 'loading' && <Loading />}
      {state.status === 'failed' && <ErrorMessage message={state.message} />}
      {state.status === 'loaded' && (
        <>
          {state.value.teams.length > 0 && (
            <NewSessionForm
              api={api}
              teams={state.value.teams}
              onCreated={(id) => {
                setOpened({ id, mode: 'builder' });
              }}
            />
          )}
          {state.value.sessions.length === 0 ? (
            <EmptyState
              title="No planning sessions"
              message={
                state.value.teams.length > 0
                  ? 'Create a session to start planning.'
                  : 'Sessions you are invited to appear here.'
              }
            />
          ) : (
            <ul className="pp-list">
              {state.value.sessions.map((session) => {
                const editable =
                  session.canModerate && (session.status === 'draft' || session.status === 'ready');

                return (
                  <li key={session.id} className="pp-card pp-row">
                    <div className="pp-row-main">
                      <h3 className="pp-list-item-title">
                        {session.name}
                        <span className="pp-badge pp-badge-gap" data-status={session.status}>
                          {STATUS_LABELS[session.status]}
                        </span>
                      </h3>
                      <p className="pp-muted">
                        {session.teamName}
                        {session.currentTicketTitle === null
                          ? ''
                          : ` · Now: ${session.currentTicketTitle}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="pp-button"
                      onClick={() => {
                        setOpened({ id: session.id, mode: editable ? 'builder' : 'overview' });
                      }}
                    >
                      {editable ? 'Continue setup' : 'Open'}
                      <span className="pp-visually-hidden"> {session.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function NewSessionForm({
  api,
  teams,
  onCreated,
}: {
  readonly api: PlanningPokerApi;
  readonly teams: SessionListView['teams'];
  readonly onCreated: (sessionId: string) => void;
}) {
  const nameId = useId();
  const teamId = useId();
  const [name, setName] = useState('');
  const [team, setTeam] = useState(teams[0]?.id ?? '');
  const { pending, error, run } = useAction();

  return (
    <form
      className="pp-card pp-stack"
      aria-label="New planning session"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const created = await api.call('createSession', { name, teamId: team });
          onCreated(created.session.id);
        });
      }}
    >
      <h3 className="pp-section-title">New planning session</h3>
      <label htmlFor={nameId} className="pp-label">
        Session name
      </label>
      <input
        id={nameId}
        className="pp-input"
        required
        maxLength={120}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <label htmlFor={teamId} className="pp-label">
        Team
      </label>
      <select
        id={teamId}
        className="pp-input"
        value={team}
        onChange={(event) => {
          setTeam(event.target.value);
        }}
      >
        {teams.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      <ErrorMessage message={error} />
      <div>
        <button type="submit" className="pp-button pp-button-primary" disabled={pending}>
          Create draft
        </button>
      </div>
    </form>
  );
}
