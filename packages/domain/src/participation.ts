import type { InvitationId, SessionId, TicketId, UserId } from './ids';

/** Whether a session participant votes. Separate from application permissions (admin/moderator). */
export type ParticipationRole = 'voter' | 'observer';

export type InvitationStatus = 'invited' | 'joined' | 'declined' | 'revoked';

export interface SessionInvitation {
  readonly id: InvitationId;
  readonly sessionId: SessionId;
  readonly invitedUserId: UserId;
  readonly invitedByUserId: UserId;
  readonly role: ParticipationRole;
  readonly status: InvitationStatus;
  readonly createdAt: Date;
  readonly respondedAt: Date | null;
}

/**
 * A person on a session's roster. Facilitators manage the session and have no invitation;
 * they default to observing but may be included as voters.
 */
export interface SessionParticipant {
  readonly userId: UserId;
  readonly role: ParticipationRole;
  readonly isFacilitator: boolean;
  readonly invitation: SessionInvitation | null;
}

export type SkipScope = 'ticket' | 'session';

/** A record of a moderator excluding a voter. Kept after restore for reporting and audit. */
export interface ParticipantSkip {
  readonly userId: UserId;
  readonly scope: SkipScope;
  /** The ticket the skip applies to (for `ticket` scope) or was made on (for `session` scope). */
  readonly ticketId: TicketId | null;
  readonly skippedBy: UserId;
  readonly skippedAt: Date;
  readonly restoredBy: UserId | null;
  readonly restoredAt: Date | null;
}

export function participantStatus(participant: SessionParticipant): InvitationStatus {
  return participant.invitation?.status ?? 'joined';
}

/** Invited (not yet responded) and joined participants still belong to the session. */
export function hasActiveInvitation(participant: SessionParticipant): boolean {
  const status = participantStatus(participant);

  return status === 'invited' || status === 'joined';
}

export function isActiveSkip(skip: ParticipantSkip): boolean {
  return skip.restoredAt === null;
}
