import type { TeamListView } from '@planning-poker/contracts';
import { useCallback, useId, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction, useLoad } from '../hooks';
import { EmptyState } from './EmptyState';
import { ErrorMessage, Loading } from './Feedback';
import { TeamDetail } from './TeamDetail';

export interface TeamsPageProps {
  readonly api: PlanningPokerApi;
}

export function TeamsPage({ api }: TeamsPageProps) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const load = useCallback(async () => await api.call('listTeams', {}), [api]);
  const { state, reload } = useLoad<TeamListView>(load);

  if (selectedTeamId !== null) {
    return (
      <TeamDetail
        api={api}
        teamId={selectedTeamId}
        onBack={() => {
          setSelectedTeamId(null);
          reload();
        }}
      />
    );
  }

  return (
    <section className="pp-page" aria-labelledby="pp-teams-title">
      <h2 id="pp-teams-title" className="pp-page-title">
        Teams
      </h2>
      {state.status === 'loading' && <Loading />}
      {state.status === 'failed' && <ErrorMessage message={state.message} />}
      {state.status === 'loaded' && (
        <>
          {state.value.canCreateTeams && (
            <CreateTeamForm
              api={api}
              onCreated={(teamId) => {
                setSelectedTeamId(teamId);
              }}
            />
          )}
          {state.value.teams.length === 0 ? (
            <EmptyState
              title="No teams yet"
              message={
                state.value.canCreateTeams
                  ? 'Create a team to start planning.'
                  : 'Ask a moderator to add you to a team.'
              }
            />
          ) : (
            <ul className="pp-list">
              {state.value.teams.map((team) => (
                <li key={team.id} className="pp-card pp-row">
                  <div className="pp-row-main">
                    <h3 className="pp-list-item-title">
                      {team.name}
                      {team.archived && <span className="pp-badge pp-badge-gap">Archived</span>}
                    </h3>
                    <p className="pp-muted">
                      {team.memberCount === 1 ? '1 member' : `${String(team.memberCount)} members`}
                      {team.description === null ? '' : ` · ${team.description}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="pp-button"
                    onClick={() => {
                      setSelectedTeamId(team.id);
                    }}
                  >
                    {team.canManage ? 'Manage' : 'View'}
                    <span className="pp-visually-hidden"> {team.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function CreateTeamForm({
  api,
  onCreated,
}: {
  readonly api: PlanningPokerApi;
  readonly onCreated: (teamId: string) => void;
}) {
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { pending, error, run } = useAction();

  return (
    <form
      className="pp-card pp-stack"
      aria-label="Create team"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          const team = await api.call('createTeam', {
            name,
            description: description.trim() === '' ? null : description,
          });
          onCreated(team.id);
        });
      }}
    >
      <h3 className="pp-section-title">Create team</h3>
      <label htmlFor={nameId} className="pp-label">
        Name
      </label>
      <input
        id={nameId}
        className="pp-input"
        required
        maxLength={100}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <label htmlFor={descriptionId} className="pp-label">
        Description (optional)
      </label>
      <input
        id={descriptionId}
        className="pp-input"
        value={description}
        onChange={(event) => {
          setDescription(event.target.value);
        }}
      />
      <ErrorMessage message={error} />
      <div>
        <button type="submit" className="pp-button pp-button-primary" disabled={pending}>
          Create team
        </button>
      </div>
    </form>
  );
}
