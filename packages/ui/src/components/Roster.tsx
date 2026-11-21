import type { InvitationStatusDto, ParticipantView } from '@planning-poker/contracts';

import { Avatar } from './Feedback';

export const INVITATION_LABELS: Readonly<Record<InvitationStatusDto, string>> = {
  invited: 'Invited',
  joined: 'Joined',
  declined: 'Declined',
  revoked: 'Revoked',
};

export interface RosterProps {
  readonly participants: readonly ParticipantView[];
  /** When given, moderators can switch roles and remove people. */
  readonly controls?: {
    readonly pending: boolean;
    readonly onRoleChange: (userId: string, role: 'voter' | 'observer') => void;
    readonly onRemove: (userId: string) => void;
    readonly removeLabel: string;
  };
}

/** The session roster. Roles and statuses are always written out, never shown by colour alone. */
export function Roster({ participants, controls }: RosterProps) {
  const voters = participants.filter((p) => p.role === 'voter').length;
  const observers = participants.length - voters;

  return (
    <div className="pp-stack">
      <p className="pp-muted">
        {voters === 1 ? '1 voter' : `${String(voters)} voters`} ·{' '}
        {observers === 1 ? '1 observer' : `${String(observers)} observers`}
      </p>
      <ul className="pp-list">
        {participants.map((participant) => {
          const inactive =
            participant.invitationStatus === 'declined' ||
            participant.invitationStatus === 'revoked';

          return (
            <li key={participant.userId} className="pp-row">
              <Avatar name={participant.displayName} url={null} />
              <span className="pp-row-main">
                {participant.displayName}
                {participant.isFacilitator && (
                  <span className="pp-badge pp-badge-gap">Facilitator</span>
                )}
                <span className="pp-badge pp-badge-gap">
                  {participant.role === 'voter' ? 'Voter' : 'Observer'}
                </span>
                {!participant.isFacilitator && (
                  <span className="pp-muted pp-inline-gap">
                    {INVITATION_LABELS[participant.invitationStatus]}
                  </span>
                )}
              </span>
              {controls !== undefined && !inactive && (
                <button
                  type="button"
                  className="pp-button"
                  disabled={controls.pending}
                  onClick={() => {
                    controls.onRoleChange(
                      participant.userId,
                      participant.role === 'voter' ? 'observer' : 'voter',
                    );
                  }}
                >
                  {participant.role === 'voter' ? 'Make observer' : 'Make voter'}
                  <span className="pp-visually-hidden"> ({participant.displayName})</span>
                </button>
              )}
              {controls !== undefined && !participant.isFacilitator && !inactive && (
                <button
                  type="button"
                  className="pp-button"
                  disabled={controls.pending}
                  onClick={() => {
                    controls.onRemove(participant.userId);
                  }}
                >
                  {controls.removeLabel}
                  <span className="pp-visually-hidden"> {participant.displayName}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
