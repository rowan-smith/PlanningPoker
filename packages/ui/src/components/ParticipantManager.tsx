import type {
  InvitationStatusDto,
  ParticipantView,
  ParticipationRoleDto,
  SessionView,
} from '@planning-poker/contracts';
import { useState } from 'react';

import type { PlanningPokerApi } from '../api';
import { ConfirmButton } from './ConfirmButton';
import type { SessionChange } from './ModeratorPanel';
import { UserSearch } from './UserSearch';

const INVITATION_LABELS: Readonly<Record<InvitationStatusDto, string>> = {
  invited: 'Invited',
  joined: 'Joined',
  declined: 'Declined',
  revoked: 'Revoked',
};

export interface ParticipantManagerProps {
  readonly api: PlanningPokerApi;
  readonly session: SessionView;
  readonly pending: boolean;
  readonly onChange: SessionChange;
}

function isActive(participant: ParticipantView): boolean {
  return participant.invitationStatus === 'invited' || participant.invitationStatus === 'joined';
}

/** Words for this person's state in the current round, so nothing relies on colour alone. */
function roundState(participant: ParticipantView, roundOpen: boolean): string | null {
  if (!isActive(participant)) {
    return null;
  }

  if (participant.skippedForSession) {
    return 'Skipped for the rest of the session';
  }

  if (participant.skippedForCurrentTicket) {
    return 'Skipped for this ticket';
  }

  if (participant.role === 'observer') {
    return 'Observing';
  }

  if (participant.voteStatus === 'voted') {
    return 'Voted';
  }

  if (participant.voteStatus === 'pending') {
    return participant.invitationStatus === 'invited'
      ? 'Required · has not joined yet'
      : 'Required · waiting for vote';
  }

  return roundOpen ? 'Not on this round · votes from the next round' : null;
}

/**
 * The moderator's participant panel: invite Jira users, switch voter ⇄ observer, skip a voter for
 * this ticket or the rest of the session, restore them, and remove an invitation.
 */
export function ParticipantManager({ api, session, pending, onChange }: ParticipantManagerProps) {
  const sessionId = session.id;
  const current = session.tickets.find((ticket) => ticket.id === session.currentTicketId);
  const round = current?.round ?? null;
  const roundOpen = round?.status === 'open';
  const counts = (['joined', 'invited', 'declined', 'revoked'] as const)
    .map((status) => ({
      status,
      count: session.participants.filter((p) => p.invitationStatus === status).length,
    }))
    .filter((entry) => entry.count > 0);

  return (
    <section className="pp-card pp-stack" aria-labelledby="pp-manage-title">
      <h3 id="pp-manage-title" className="pp-section-title">
        Manage participants
      </h3>
      <p className="pp-muted" role="status">
        {roundOpen
          ? `Required voters this round: ${String(round.requiredCount)}`
          : 'No round is open.'}
        {counts.map(({ status, count }) => ` · ${String(count)} ${status}`).join('')}
      </p>
      <p className="pp-muted">
        Changes never add anyone to an open round: new voters count from the next round.
      </p>
      <ul className="pp-list" aria-label="Session participants">
        {session.participants.map((participant) => (
          <ParticipantRow
            key={participant.userId}
            api={api}
            sessionId={sessionId}
            participant={participant}
            roundOpen={roundOpen}
            pending={pending}
            onChange={onChange}
          />
        ))}
      </ul>
      <Invite api={api} session={session} pending={pending} onChange={onChange} />
    </section>
  );
}

function ParticipantRow({
  api,
  sessionId,
  participant,
  roundOpen,
  pending,
  onChange,
}: {
  readonly api: PlanningPokerApi;
  readonly sessionId: string;
  readonly participant: ParticipantView;
  readonly roundOpen: boolean;
  readonly pending: boolean;
  readonly onChange: SessionChange;
}) {
  const { userId, displayName } = participant;
  const active = isActive(participant);
  const skipped = participant.skippedForSession || participant.skippedForCurrentTicket;
  const state = roundState(participant, roundOpen);
  const otherRole: ParticipationRoleDto = participant.role === 'voter' ? 'observer' : 'voter';

  return (
    <li className="pp-stack pp-participant">
      <div className="pp-row">
        <span className="pp-row-main">
          <strong>{displayName}</strong>
          {participant.isFacilitator && <span className="pp-muted"> · Facilitator</span>}
        </span>
        <span className="pp-badge" data-tone="neutral">
          {participant.role === 'voter' ? 'Voter' : 'Observer'}
        </span>
        {!participant.isFacilitator && (
          <span className="pp-badge" data-tone={active ? 'blue' : 'neutral'}>
            {INVITATION_LABELS[participant.invitationStatus]}
          </span>
        )}
      </div>
      {state !== null && (
        <p className="pp-muted" data-tone={skipped ? 'amber' : undefined}>
          {state}
        </p>
      )}
      {active && (
        <div className="pp-row">
          <button
            type="button"
            className="pp-button"
            disabled={pending}
            onClick={() => {
              onChange(
                async () =>
                  await api.call('changeRoomRole', { sessionId, userId, role: otherRole }),
              );
            }}
          >
            Make {otherRole}
            <span className="pp-visually-hidden"> ({displayName})</span>
          </button>
          {skipped ? (
            <button
              type="button"
              className="pp-button"
              disabled={pending}
              onClick={() => {
                onChange(async () => await api.call('restoreParticipant', { sessionId, userId }));
              }}
            >
              Restore voter<span className="pp-visually-hidden"> ({displayName})</span>
            </button>
          ) : (
            participant.role === 'voter' && (
              <SkipMember
                name={displayName}
                canSkipTicket={roundOpen}
                pending={pending}
                onSkip={(scope) => {
                  onChange(
                    async () => await api.call('skipParticipant', { sessionId, userId, scope }),
                  );
                }}
              />
            )
          )}
          {!participant.isFacilitator && (
            <ConfirmButton
              label={`Remove ${displayName}`}
              confirmLabel={`Yes, remove ${displayName}`}
              cancelLabel="Keep"
              warning="Their invitation is revoked and they leave any open round."
              disabled={pending}
              onConfirm={() => {
                onChange(async () => await api.call('revokeRoomInvitation', { sessionId, userId }));
              }}
            />
          )}
        </div>
      )}
    </li>
  );
}

/** "Skip member" asks how long for, so it is never confused with skipping the ticket. */
function SkipMember({
  name,
  canSkipTicket,
  pending,
  onSkip,
}: {
  readonly name: string;
  readonly canSkipTicket: boolean;
  readonly pending: boolean;
  readonly onSkip: (scope: 'ticket' | 'session') => void;
}) {
  const [choosing, setChoosing] = useState(false);

  if (!choosing) {
    return (
      <button
        type="button"
        className="pp-button"
        disabled={pending}
        onClick={() => {
          setChoosing(true);
        }}
      >
        Skip member<span className="pp-visually-hidden"> ({name})</span>
      </button>
    );
  }

  const choose = (scope: 'ticket' | 'session') => {
    setChoosing(false);
    onSkip(scope);
  };

  return (
    <span className="pp-row" role="group" aria-label={`Skip ${name} for how long?`}>
      <span className="pp-muted">Skip {name}:</span>
      <button
        type="button"
        className="pp-button"
        disabled={pending || !canSkipTicket}
        onClick={() => {
          choose('ticket');
        }}
      >
        This ticket
      </button>
      <button
        type="button"
        className="pp-button"
        disabled={pending}
        onClick={() => {
          choose('session');
        }}
      >
        Rest of session
      </button>
      <button
        type="button"
        className="pp-button"
        onClick={() => {
          setChoosing(false);
        }}
      >
        Don&apos;t skip
      </button>
    </span>
  );
}

function Invite({
  api,
  session,
  pending,
  onChange,
}: {
  readonly api: PlanningPokerApi;
  readonly session: SessionView;
  readonly pending: boolean;
  readonly onChange: SessionChange;
}) {
  const [role, setRole] = useState<ParticipationRoleDto>('voter');

  if (!session.viewer.canInvite) {
    return <p className="pp-muted">This session is not accepting new invitations.</p>;
  }

  const onRoster = session.participants
    .filter((participant) => participant.isFacilitator || isActive(participant))
    .map((participant) => participant.userId);

  return (
    <div className="pp-control-group pp-stack">
      <fieldset className="pp-fieldset pp-row">
        <legend className="pp-label">Invite as</legend>
        {(['voter', 'observer'] as const).map((option) => (
          <label key={option} className="pp-check">
            <input
              type="radio"
              name="pp-invite-role"
              value={option}
              checked={role === option}
              onChange={() => {
                setRole(option);
              }}
            />
            {option === 'voter' ? 'Voter' : 'Observer'}
          </label>
        ))}
      </fieldset>
      <UserSearch
        api={api}
        label="Invite people from Jira"
        actionLabel={`Invite as ${role}`}
        excludeUserIds={onRoster}
        disabled={pending}
        onSelect={(user) => {
          onChange(
            async () =>
              await api.call('inviteToRoom', {
                sessionId: session.id,
                userId: user.userId,
                role,
              }),
          );
        }}
      />
      {role === 'voter' && (
        <p className="pp-muted">New voters vote from the next round, once they join.</p>
      )}
    </div>
  );
}
