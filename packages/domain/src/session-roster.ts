import { ensure } from './errors';
import type { InvitationId, RoundId, TicketId, UserId } from './ids';
import type { ParticipantSkip, ParticipationRole, SkipScope } from './participation';
import { hasActiveInvitation, isActiveSkip, participantStatus } from './participation';
import type { Session } from './session';
import {
  activeSessionSkip,
  activeTicketSkip,
  afterDraftEdit,
  currentTicket,
  ensureEditable,
  ensureRunning,
  findParticipant,
  isEditable,
  replaceParticipant,
  requireParticipant,
  touch,
} from './session';
import { latestRound } from './ticket';
import type { ExclusionReason, VotingRound } from './voting';

// ---------------------------------------------------------------------------------------------
// Open-round roster adjustments. Voters can leave an open round but never join one.
// ---------------------------------------------------------------------------------------------

function mapOpenRounds(
  session: Session,
  update: (round: VotingRound, ticketId: TicketId) => VotingRound,
  onlyTicketId?: TicketId,
): Session {
  return {
    ...session,
    tickets: session.tickets.map((ticket) => {
      const round = latestRound(ticket);

      if (round?.status !== 'open' || (onlyTicketId !== undefined && ticket.id !== onlyTicketId)) {
        return ticket;
      }

      return { ...ticket, rounds: [...ticket.rounds.slice(0, -1), update(round, ticket.id)] };
    }),
  };
}

function exclude(round: VotingRound, userId: UserId, reason: ExclusionReason): VotingRound {
  const roster = round.roster;

  if (
    roster === null ||
    !roster.snapshotVoterIds.includes(userId) ||
    roster.exclusions.some((exclusion) => exclusion.userId === userId)
  ) {
    return round;
  }

  return {
    ...round,
    roster: { ...roster, exclusions: [...roster.exclusions, { userId, reason }] },
  };
}

function excludeFromOpenRounds(
  session: Session,
  userId: UserId,
  reason: ExclusionReason,
  onlyTicketId?: TicketId,
): Session {
  return mapOpenRounds(session, (round) => exclude(round, userId, reason), onlyTicketId);
}

// ---------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------

export interface InviteParticipantInput {
  readonly invitationId: InvitationId;
  readonly userId: UserId;
  readonly role: ParticipationRole;
  readonly invitedBy: UserId;
  readonly now: Date;
}

/**
 * Invites someone to this session only (not to the team). New voters invited while a round is open
 * become required from the next round.
 */
export function inviteParticipant(session: Session, input: InviteParticipantInput): Session {
  ensure(
    isEditable(session) ||
      (session.status !== 'completed' &&
        session.status !== 'cancelled' &&
        session.settings.allowInvitationsWhileActive),
    'INVALID_STATE',
    'This session is not accepting invitations.',
  );
  const existing = findParticipant(session, input.userId);
  ensure(existing?.isFacilitator !== true, 'CONFLICT', 'Facilitators are already in the session.');
  ensure(
    existing === undefined || !hasActiveInvitation(existing),
    'CONFLICT',
    'That person is already invited.',
  );
  const invitation = {
    id: input.invitationId,
    sessionId: session.id,
    invitedUserId: input.userId,
    invitedByUserId: input.invitedBy,
    role: input.role,
    status: 'invited' as const,
    createdAt: input.now,
    respondedAt: null,
  };
  const participant = {
    userId: input.userId,
    role: input.role,
    isFacilitator: false,
    invitation,
  };
  const base = isEditable(session) ? afterDraftEdit(session, input.now) : touch(session, input.now);

  return {
    ...base,
    participants:
      existing === undefined
        ? [...session.participants, participant]
        : session.participants.map((current) =>
            current.userId === input.userId ? participant : current,
          ),
  };
}

export function respondToInvitation(
  session: Session,
  userId: UserId,
  response: 'joined' | 'declined',
  now: Date,
): Session {
  ensureRunning(session);
  const participant = requireParticipant(session, userId);
  const invitation = participant.invitation;
  ensure(invitation !== null, 'VALIDATION', 'Facilitators do not have an invitation.');
  ensure(
    invitation.status === 'invited' || (invitation.status === 'joined' && response === 'joined'),
    'INVALID_STATE',
    'This invitation can no longer be answered.',
  );

  if (invitation.status === response) {
    return session;
  }

  const updated = replaceParticipant(touch(session, now), userId, (current) => ({
    ...current,
    invitation: { ...invitation, status: response, respondedAt: now },
  }));

  return response === 'declined'
    ? excludeFromOpenRounds(updated, userId, 'invitation-ended')
    : updated;
}

export function revokeInvitation(session: Session, userId: UserId, now: Date): Session {
  ensure(
    session.status !== 'completed' && session.status !== 'cancelled',
    'INVALID_STATE',
    'The session is closed.',
  );
  const participant = requireParticipant(session, userId);
  const invitation = participant.invitation;
  ensure(invitation !== null, 'VALIDATION', 'Facilitators cannot be revoked.');
  ensure(hasActiveInvitation(participant), 'INVALID_STATE', 'The invitation is no longer active.');

  const base = isEditable(session) ? afterDraftEdit(session, now) : touch(session, now);
  const updated = replaceParticipant(base, userId, (current) => ({
    ...current,
    invitation: { ...invitation, status: 'revoked', respondedAt: now },
  }));

  return excludeFromOpenRounds(updated, userId, 'invitation-ended');
}

/** Removes a not-yet-published roster entry entirely. Once published, revoke instead. */
export function removeDraftParticipant(session: Session, userId: UserId, now: Date): Session {
  ensureEditable(session);
  const participant = requireParticipant(session, userId);
  ensure(!participant.isFacilitator, 'VALIDATION', 'Facilitators cannot be removed.');

  return {
    ...afterDraftEdit(session, now),
    participants: session.participants.filter((current) => current.userId !== userId),
  };
}

/**
 * Switches voter ⇄ observer. Becoming an observer removes the person from open rounds;
 * becoming a voter takes effect from the next round (frozen roster).
 */
export function changeParticipantRole(
  session: Session,
  userId: UserId,
  role: ParticipationRole,
  now: Date,
): Session {
  ensure(
    session.status !== 'completed' && session.status !== 'cancelled',
    'INVALID_STATE',
    'The session is closed.',
  );
  const participant = requireParticipant(session, userId);

  if (participant.role === role) {
    return session;
  }

  const base = isEditable(session) ? afterDraftEdit(session, now) : touch(session, now);
  const updated = replaceParticipant(base, userId, (current) => ({
    ...current,
    role,
    invitation: current.invitation === null ? null : { ...current.invitation, role },
  }));

  return role === 'observer' ? excludeFromOpenRounds(updated, userId, 'became-observer') : updated;
}

// ---------------------------------------------------------------------------------------------
// Skipping and restoring voters
// ---------------------------------------------------------------------------------------------

export interface SkipParticipantInput {
  readonly userId: UserId;
  readonly scope: SkipScope;
  readonly skippedBy: UserId;
  readonly now: Date;
}

/**
 * Excludes a voter from required voting without removing their access. A vote they already cast
 * in the affected round stops counting (it stays stored for restricted audit only).
 */
export function skipParticipant(session: Session, input: SkipParticipantInput): Session {
  ensureRunning(session);
  const participant = requireParticipant(session, input.userId);
  ensure(participant.role === 'voter', 'VALIDATION', 'Only voters can be skipped.');
  ensure(hasActiveInvitation(participant), 'VALIDATION', 'That person is no longer invited.');
  ensure(
    activeSessionSkip(session, input.userId) === undefined,
    'CONFLICT',
    'That voter is already skipped for the rest of the session.',
  );
  const ticket = currentTicket(session);

  if (input.scope === 'ticket') {
    ensure(ticket !== undefined, 'INVALID_STATE', 'There is no current ticket.');
    ensure(
      activeTicketSkip(session, input.userId, ticket.id) === undefined,
      'CONFLICT',
      'That voter is already skipped for this ticket.',
    );
    ensure(
      latestRound(ticket)?.status === 'open',
      'INVALID_STATE',
      'The current ticket is not open for voting.',
    );
  }

  const skip: ParticipantSkip = {
    userId: input.userId,
    scope: input.scope,
    ticketId: ticket?.id ?? null,
    skippedBy: input.skippedBy,
    skippedAt: input.now,
    restoredBy: null,
    restoredAt: null,
  };
  const updated: Session = { ...touch(session, input.now), skips: [...session.skips, skip] };

  return input.scope === 'ticket'
    ? excludeFromOpenRounds(updated, input.userId, 'skipped-for-ticket', ticket?.id)
    : excludeFromOpenRounds(updated, input.userId, 'skipped-for-session');
}

export interface RestoreResult {
  readonly session: Session;
  /** Votes the restored voter cast before being restored; they must vote again. */
  readonly discardedVotes: readonly { readonly roundId: RoundId; readonly userId: UserId }[];
}

/**
 * Restores a skipped voter. Open rounds require them again (with a fresh vote); revealed rounds
 * are never changed retroactively.
 */
export function restoreParticipant(
  session: Session,
  userId: UserId,
  restoredBy: UserId,
  now: Date,
): RestoreResult {
  ensureRunning(session);
  requireParticipant(session, userId);
  const ticket = currentTicket(session);
  const restorable = (skip: ParticipantSkip): boolean =>
    skip.userId === userId &&
    isActiveSkip(skip) &&
    (skip.scope === 'session' || skip.ticketId === ticket?.id);
  ensure(session.skips.some(restorable), 'INVALID_STATE', 'That voter is not skipped.');

  const discardedVotes: { roundId: RoundId; userId: UserId }[] = [];
  const withSkipsRestored: Session = {
    ...touch(session, now),
    skips: session.skips.map((skip) =>
      restorable(skip) ? { ...skip, restoredBy, restoredAt: now } : skip,
    ),
  };
  const participant = requireParticipant(withSkipsRestored, userId);
  const stillEligible = participant.role === 'voter' && hasActiveInvitation(participant);

  const restored = mapOpenRounds(withSkipsRestored, (round, ticketId) => {
    const roster = round.roster;
    const exclusion = roster?.exclusions.find((current) => current.userId === userId);
    const isSkipExclusion =
      exclusion?.reason === 'skipped-for-session' ||
      (exclusion?.reason === 'skipped-for-ticket' && ticketId === ticket?.id);

    if (roster === null || !isSkipExclusion || !stillEligible) {
      return round;
    }

    discardedVotes.push({ roundId: round.id, userId });

    return {
      ...round,
      roster: {
        ...roster,
        exclusions: roster.exclusions.filter((current) => current.userId !== userId),
      },
    };
  });

  return { session: restored, discardedVotes };
}

/** Roster entries a moderator sees: everyone, with invitation status and skip state. */
export function describeParticipant(
  session: Session,
  userId: UserId,
): {
  readonly status: ReturnType<typeof participantStatus>;
  readonly skippedForSession: boolean;
  readonly skippedForCurrentTicket: boolean;
} {
  const participant = requireParticipant(session, userId);
  const ticket = currentTicket(session);

  return {
    status: participantStatus(participant),
    skippedForSession: activeSessionSkip(session, userId) !== undefined,
    skippedForCurrentTicket:
      ticket !== undefined && activeTicketSkip(session, userId, ticket.id) !== undefined,
  };
}
