import type { ScoringDeck } from './deck';
import type { FieldMapping } from './estimate';
import { ensure } from './errors';
import { NO_EXTERNAL_UPDATE } from './external-update';
import type { RoundId, SessionId, TeamId, TenantId, TicketId, UserId } from './ids';
import type { ParticipantSkip, SessionParticipant } from './participation';
import { hasActiveInvitation, isActiveSkip, participantStatus } from './participation';
import type { SessionTicket, WorkItemReference, WorkItemSnapshot } from './ticket';
import { latestRound, workItemKey } from './ticket';
import type { RosterExclusion, VotingRound, VotingRoster } from './voting';
import { pendingRound } from './voting';

const MAX_SESSION_NAME_LENGTH = 120;

/** Draft → Ready → Active → Completed, with Active ⇄ Paused and Cancelled from any open state. */
export type SessionStatus = 'draft' | 'ready' | 'active' | 'paused' | 'completed' | 'cancelled';

export interface SessionSettings {
  readonly deck: ScoringDeck;
  /** Finalize automatically when every counted vote is the same regular, mappable card. */
  readonly autoFinalize: boolean;
  /** Move to the next ticket after an automatic finalization whose external update succeeded. */
  readonly autoAdvance: boolean;
  readonly allowInvitationsWhileActive: boolean;
  readonly destinationField: FieldMapping | null;
  readonly additionalWritableFields: readonly FieldMapping[];
  readonly displayFieldIds: readonly string[];
}

export interface Session {
  readonly id: SessionId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly teamId: TeamId;
  readonly status: SessionStatus;
  readonly createdBy: UserId;
  readonly settings: SessionSettings;
  readonly participants: readonly SessionParticipant[];
  readonly skips: readonly ParticipantSkip[];
  readonly tickets: readonly SessionTicket[];
  readonly currentTicketId: TicketId | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly publishedAt: Date | null;
  readonly completedAt: Date | null;
  /** Incremented by persistence on every save; used for optimistic concurrency. */
  readonly version: number;
}

export interface CreateDraftSessionInput {
  readonly id: SessionId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly teamId: TeamId;
  readonly createdBy: UserId;
  readonly deck: ScoringDeck;
  readonly now: Date;
}

function validName(name: string): string {
  const trimmed = name.trim();
  ensure(trimmed.length > 0, 'VALIDATION', 'Session name is required.');
  ensure(
    trimmed.length <= MAX_SESSION_NAME_LENGTH,
    'VALIDATION',
    `Session name must be at most ${String(MAX_SESSION_NAME_LENGTH)} characters.`,
  );

  return trimmed;
}

/** The creator joins as a non-voting facilitator. */
export function createDraftSession(input: CreateDraftSessionInput): Session {
  return {
    id: input.id,
    tenantId: input.tenantId,
    name: validName(input.name),
    teamId: input.teamId,
    status: 'draft',
    createdBy: input.createdBy,
    settings: {
      deck: input.deck,
      autoFinalize: false,
      autoAdvance: false,
      allowInvitationsWhileActive: true,
      destinationField: null,
      additionalWritableFields: [],
      displayFieldIds: [],
    },
    participants: [
      { userId: input.createdBy, role: 'observer', isFacilitator: true, invitation: null },
    ],
    skips: [],
    tickets: [],
    currentTicketId: null,
    createdAt: input.now,
    updatedAt: input.now,
    publishedAt: null,
    completedAt: null,
    version: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export function isEditable(session: Session): boolean {
  return session.status === 'draft' || session.status === 'ready';
}

export function isRunning(session: Session): boolean {
  return session.status === 'active' || session.status === 'paused';
}

/** Drafts and ready-to-publish sessions are hidden from ordinary members. */
export function isPublished(session: Session): boolean {
  return (
    session.status === 'active' || session.status === 'paused' || session.status === 'completed'
  );
}

export function findParticipant(session: Session, userId: UserId): SessionParticipant | undefined {
  return session.participants.find((participant) => participant.userId === userId);
}

export function requireParticipant(session: Session, userId: UserId): SessionParticipant {
  const participant = findParticipant(session, userId);
  ensure(participant !== undefined, 'NOT_FOUND', 'That person is not part of this session.');

  return participant;
}

export function findTicket(session: Session, ticketId: TicketId): SessionTicket | undefined {
  return session.tickets.find((ticket) => ticket.id === ticketId);
}

export function requireTicket(session: Session, ticketId: TicketId): SessionTicket {
  const ticket = findTicket(session, ticketId);
  ensure(ticket !== undefined, 'NOT_FOUND', 'That ticket is not part of this session.');

  return ticket;
}

export function currentTicket(session: Session): SessionTicket | undefined {
  return session.currentTicketId === null
    ? undefined
    : findTicket(session, session.currentTicketId);
}

export function orderedTickets(session: Session): SessionTicket[] {
  return [...session.tickets].sort((a, b) => a.order - b.order);
}

export function activeSessionSkip(session: Session, userId: UserId): ParticipantSkip | undefined {
  return session.skips.find(
    (skip) => skip.userId === userId && skip.scope === 'session' && isActiveSkip(skip),
  );
}

export function activeTicketSkip(
  session: Session,
  userId: UserId,
  ticketId: TicketId,
): ParticipantSkip | undefined {
  return session.skips.find(
    (skip) =>
      skip.userId === userId &&
      skip.scope === 'ticket' &&
      skip.ticketId === ticketId &&
      isActiveSkip(skip),
  );
}

/** Voters by role and invitation, before skips. This is who a new round's roster starts from. */
export function intendedVoterIds(session: Session): UserId[] {
  return session.participants
    .filter((participant) => participant.role === 'voter' && hasActiveInvitation(participant))
    .map((participant) => participant.userId);
}

/** Whether a user may vote on a ticket whose round has not opened yet (pre-voting). */
export function canPreVote(session: Session, userId: UserId, ticketId: TicketId): boolean {
  const participant = findParticipant(session, userId);

  return (
    participant?.role === 'voter' &&
    participantStatus(participant) === 'joined' &&
    activeSessionSkip(session, userId) === undefined &&
    activeTicketSkip(session, userId, ticketId) === undefined
  );
}

// ---------------------------------------------------------------------------------------------
// Internal helpers shared by the session modules
// ---------------------------------------------------------------------------------------------

export function touch(session: Session, now: Date): Session {
  return { ...session, updatedAt: now };
}

/** Any edit to a ready session sends it back to draft so it is validated again. */
export function afterDraftEdit(session: Session, now: Date): Session {
  return {
    ...session,
    status: session.status === 'ready' ? 'draft' : session.status,
    updatedAt: now,
  };
}

export function ensureEditable(session: Session): void {
  ensure(isEditable(session), 'INVALID_STATE', 'Only draft sessions can be edited.');
}

export function ensureActive(session: Session): void {
  ensure(session.status === 'active', 'INVALID_STATE', 'The session is not active.');
}

export function ensureRunning(session: Session): void {
  ensure(isRunning(session), 'INVALID_STATE', 'The session is not running.');
}

export function replaceTicket(
  session: Session,
  ticketId: TicketId,
  update: (ticket: SessionTicket) => SessionTicket,
): Session {
  requireTicket(session, ticketId);

  return {
    ...session,
    tickets: session.tickets.map((ticket) => (ticket.id === ticketId ? update(ticket) : ticket)),
  };
}

export function replaceLatestRound(
  ticket: SessionTicket,
  update: (round: VotingRound) => VotingRound,
): SessionTicket {
  const round = latestRound(ticket);
  ensure(round !== undefined, 'INVALID_STATE', 'The ticket has no voting round.');

  return { ...ticket, rounds: [...ticket.rounds.slice(0, -1), update(round)] };
}

export function replaceParticipant(
  session: Session,
  userId: UserId,
  update: (participant: SessionParticipant) => SessionParticipant,
): Session {
  requireParticipant(session, userId);

  return {
    ...session,
    participants: session.participants.map((participant) =>
      participant.userId === userId ? update(participant) : participant,
    ),
  };
}

/** Freezes who must vote: intended voters, with anyone currently skipped excluded. */
export function freezeRoster(session: Session, ticketId: TicketId, now: Date): VotingRoster {
  const snapshotVoterIds = intendedVoterIds(session);
  const exclusions = snapshotVoterIds.flatMap((userId): RosterExclusion[] => {
    if (activeSessionSkip(session, userId) !== undefined) {
      return [{ userId, reason: 'skipped-for-session' }];
    }

    if (activeTicketSkip(session, userId, ticketId) !== undefined) {
      return [{ userId, reason: 'skipped-for-ticket' }];
    }

    return [];
  });

  return { snapshotVoterIds, exclusions, frozenAt: now };
}

// ---------------------------------------------------------------------------------------------
// Draft editing
// ---------------------------------------------------------------------------------------------

export function renameSession(session: Session, name: string, now: Date): Session {
  ensure(session.status !== 'cancelled', 'INVALID_STATE', 'Cancelled sessions cannot be renamed.');

  return { ...touch(session, now), name: validName(name) };
}

export type SessionSettingsChanges = Partial<SessionSettings>;

export function updateSessionSettings(
  session: Session,
  changes: SessionSettingsChanges,
  now: Date,
): Session {
  ensureEditable(session);

  return { ...afterDraftEdit(session, now), settings: { ...session.settings, ...changes } };
}

export interface NewTicketInput {
  readonly id: TicketId;
  readonly firstRoundId: RoundId;
  readonly reference: WorkItemReference;
  readonly snapshot: WorkItemSnapshot;
}

/** Adds tickets in order, ignoring any work item already in the session (safe to retry). */
export function addTickets(
  session: Session,
  tickets: readonly NewTicketInput[],
  now: Date,
): Session {
  ensureEditable(session);
  const seen = new Set(session.tickets.map((ticket) => workItemKey(ticket.reference)));
  let nextOrder = session.tickets.reduce((max, ticket) => Math.max(max, ticket.order), -1) + 1;
  const added: SessionTicket[] = [];

  for (const input of tickets) {
    const key = workItemKey(input.reference);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    added.push({
      id: input.id,
      order: nextOrder,
      reference: input.reference,
      snapshot: input.snapshot,
      votingState: 'pending',
      rounds: [pendingRound(input.firstRoundId, input.id, 1)],
      decision: null,
      externalUpdate: NO_EXTERNAL_UPDATE,
    });
    nextOrder += 1;
  }

  return { ...afterDraftEdit(session, now), tickets: [...session.tickets, ...added] };
}

/**
 * Replaces the captured content of tickets already in a draft (e.g. after display fields change).
 * Items not in the session are ignored; votes and order are untouched.
 */
export function refreshTicketSnapshots(
  session: Session,
  items: readonly { readonly reference: WorkItemReference; readonly snapshot: WorkItemSnapshot }[],
  now: Date,
): Session {
  ensureEditable(session);
  const byKey = new Map(items.map((item) => [workItemKey(item.reference), item]));

  return {
    ...afterDraftEdit(session, now),
    tickets: session.tickets.map((ticket) => {
      const item = byKey.get(workItemKey(ticket.reference));

      return item === undefined
        ? ticket
        : { ...ticket, reference: item.reference, snapshot: item.snapshot };
    }),
  };
}

export function removeTicket(session: Session, ticketId: TicketId, now: Date): Session {
  ensureEditable(session);
  requireTicket(session, ticketId);

  return {
    ...afterDraftEdit(session, now),
    tickets: session.tickets.filter((ticket) => ticket.id !== ticketId),
  };
}

export function reorderTickets(
  session: Session,
  orderedIds: readonly TicketId[],
  now: Date,
): Session {
  ensureEditable(session);
  const current = new Set(session.tickets.map((ticket) => ticket.id));
  ensure(
    orderedIds.length === current.size &&
      new Set(orderedIds).size === current.size &&
      orderedIds.every((id) => current.has(id)),
    'VALIDATION',
    'The new order must list every ticket exactly once.',
  );
  const position = new Map(orderedIds.map((id, index) => [id, index]));

  return {
    ...afterDraftEdit(session, now),
    tickets: session.tickets.map((ticket) => ({
      ...ticket,
      order: position.get(ticket.id) ?? ticket.order,
    })),
  };
}
