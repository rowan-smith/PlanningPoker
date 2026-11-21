import type { TeamDetailView, TeamMemberView } from '@planning-poker/contracts';
import { useCallback, useId, useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { useAction, useLoad } from '../hooks';
import { Avatar, ErrorMessage, Loading } from './Feedback';
import { UserSearch } from './UserSearch';

export interface TeamDetailProps {
  readonly api: PlanningPokerApi;
  readonly teamId: string;
  readonly onBack: () => void;
}

export function TeamDetail({ api, teamId, onBack }: TeamDetailProps) {
  const load = useCallback(async () => await api.call('getTeam', { teamId }), [api, teamId]);
  const { state, replace } = useLoad<TeamDetailView>(load);
  const action = useAction();
  const apply = (work: () => Promise<TeamDetailView>) => {
    void action.run(async () => {
      replace(await work());
    });
  };

  return (
    <section className="pp-page" aria-labelledby="pp-team-title">
      <div>
        <button type="button" className="pp-button" onClick={onBack}>
          ← All teams
        </button>
      </div>
      {state.status === 'loading' && <Loading />}
      {state.status === 'failed' && <ErrorMessage message={state.message} />}
      {state.status === 'loaded' && (
        <>
          <h2 id="pp-team-title" className="pp-page-title">
            {state.value.name}
            {state.value.archived && <span className="pp-badge pp-badge-gap">Archived</span>}
          </h2>
          {state.value.description !== null && (
            <p className="pp-muted">{state.value.description}</p>
          )}
          <ErrorMessage message={action.error} />

          {state.value.canManage && (
            <TeamDetailsForm
              key={`${state.value.name}|${state.value.description ?? ''}`}
              team={state.value}
              pending={action.pending}
              onSave={(name, description) => {
                apply(async () => await api.call('updateTeam', { teamId, name, description }));
              }}
            />
          )}

          <section className="pp-card pp-stack" aria-labelledby="pp-members-title">
            <h3 id="pp-members-title" className="pp-section-title">
              Members ({state.value.members.length})
            </h3>
            <ul className="pp-list">
              {state.value.members.map((member) => (
                <MemberRow
                  key={member.userId}
                  member={member}
                  team={state.value}
                  pending={action.pending}
                  onRemove={() => {
                    apply(
                      async () =>
                        await api.call('removeTeamMember', { teamId, userId: member.userId }),
                    );
                  }}
                  onToggleModerator={() => {
                    apply(
                      async () =>
                        await api.call(
                          member.isModerator ? 'unassignTeamModerator' : 'assignTeamModerator',
                          { teamId, userId: member.userId },
                        ),
                    );
                  }}
                />
              ))}
            </ul>
            {state.value.canManage && (
              <UserSearch
                api={api}
                label="Add a member"
                actionLabel="Add"
                disabled={action.pending}
                excludeUserIds={state.value.members.map((member) => member.userId)}
                onSelect={(user) => {
                  apply(
                    async () => await api.call('addTeamMember', { teamId, userId: user.userId }),
                  );
                }}
              />
            )}
          </section>

          {state.value.canManage && (
            <ArchiveTeam
              pending={action.pending}
              onArchive={() => {
                apply(async () => await api.call('archiveTeam', { teamId }));
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function MemberRow({
  member,
  team,
  pending,
  onRemove,
  onToggleModerator,
}: {
  readonly member: TeamMemberView;
  readonly team: TeamDetailView;
  readonly pending: boolean;
  readonly onRemove: () => void;
  readonly onToggleModerator: () => void;
}) {
  return (
    <li className="pp-row">
      <Avatar name={member.displayName} url={member.avatarUrl} />
      <span className="pp-row-main">
        {member.displayName}
        {member.isModerator && <span className="pp-badge pp-badge-gap">Moderator</span>}
      </span>
      {team.canAssignModerators && (
        <button type="button" className="pp-button" disabled={pending} onClick={onToggleModerator}>
          {member.isModerator ? 'Remove moderator' : 'Make moderator'}
          <span className="pp-visually-hidden"> ({member.displayName})</span>
        </button>
      )}
      {team.canManage && (
        <button type="button" className="pp-button" disabled={pending} onClick={onRemove}>
          Remove
          <span className="pp-visually-hidden"> {member.displayName}</span>
        </button>
      )}
    </li>
  );
}

function TeamDetailsForm({
  team,
  pending,
  onSave,
}: {
  readonly team: TeamDetailView;
  readonly pending: boolean;
  readonly onSave: (name: string, description: string | null) => void;
}) {
  const nameId = useId();
  const descriptionId = useId();
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? '');

  return (
    <form
      className="pp-card pp-stack"
      aria-label="Team details"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(name, description.trim() === '' ? null : description);
      }}
    >
      <h3 className="pp-section-title">Details</h3>
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
      <div>
        <button type="submit" className="pp-button pp-button-primary" disabled={pending}>
          Save details
        </button>
      </div>
    </form>
  );
}

/** Two-step confirmation inline: browser dialogs are not available inside the Forge iframe. */
function ArchiveTeam({
  pending,
  onArchive,
}: {
  readonly pending: boolean;
  readonly onArchive: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="pp-card pp-stack" aria-label="Archive team">
      <h3 className="pp-section-title">Archive</h3>
      <p className="pp-muted">Archived teams stay in history but can no longer be changed.</p>
      <div className="pp-row">
        {confirming ? (
          <>
            <button
              type="button"
              className="pp-button pp-button-danger"
              disabled={pending}
              onClick={onArchive}
            >
              Yes, archive team
            </button>
            <button
              type="button"
              className="pp-button"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="pp-button"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Archive team
          </button>
        )}
      </div>
    </section>
  );
}
