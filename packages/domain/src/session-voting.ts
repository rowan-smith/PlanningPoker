import { isRegularCard, requireCard } from './deck';
import { ensure } from './errors';
import type { ConsensusDecision } from './estimate';
import { estimateFromCard, mapCardToField } from './estimate';
import {
  beginSync,
  completeSync,
  NO_EXTERNAL_UPDATE,
  pendingExternalUpdate,
  retrySync,
} from './external-update';
import type { ExternalUpdate, SyncOutcome } from './external-update';
import type { CardId, RoundId, TicketId, UserId } from './ids';
import { participantStatus } from './participation';
import type { Session } from './session';
import {
  canPreVote,
  currentTicket,
  ensureActive,
  ensureRunning,
  findParticipant,
  freezeRoster,
  orderedTickets,
  replaceLatestRound,
  replaceTicket,
  requireTicket,
  touch,
} from './session';
import type { SessionTicket } from './ticket';
import { isTicketClosed, latestRound } from './ticket';
import type { Vote, VotingRound } from './voting';
import { computeResult, isRequiredVoter, roundProgress } from './voting';

function requireLatestRound(ticket: SessionTicket): VotingRound {
  const round = latestRound(ticket);
  ensure(round !== undefined, 'INVALID_STATE', 'The ticket has no voting round.');

  return round;
}

function openRound(session: Session, ticket: SessionTicket, now: Date): SessionTicket {
  return {
    ...replaceLatestRound(ticket, (round) => ({
      ...round,
      status: 'open',
      roster: freezeRoster(session, ticket.id, now),
      openedAt: now,
    })),
    votingState: ticket.rounds.length > 1 ? 'revoting' : 'voting',
  };
}

// ---------------------------------------------------------------------------------------------
// Ticket progression
// ---------------------------------------------------------------------------------------------

/** Makes a ticket the shared current ticket, opening its pending round with a frozen roster. */
export function setCurrentTicket(session: Session, ticketId: TicketId, now: Date): Session {
  ensureActive(session);
  const ticket = requireTicket(session, ticketId);
  const round = latestRound(ticket);
  const shouldOpen = !isTicketClosed(ticket) && round?.status === 'pending';
  const updated = shouldOpen
    ? replaceTicket(session, ticketId, (t) => openRound(session, t, now))
    : session;

  return { ...touch(updated, now), currentTicketId: ticketId };
}

export function nextOpenTicket(session: Session): SessionTicket | undefined {
  const current = currentTicket(session);

  return orderedTickets(session).find(
    (ticket) => !isTicketClosed(ticket) && (current === undefined || ticket.order > current.order),
  );
}

export function advanceToNextTicket(session: Session, now: Date): Session {
  const next = nextOpenTicket(session);
  ensure(next !== undefined, 'INVALID_STATE', 'There are no remaining tickets.');

  return setCurrentTicket(session, next.id, now);
}

/** Closes a ticket without an estimate. Distinct from skipping a member. */
export function skipTicket(session: Session, ticketId: TicketId, now: Date): Session {
  ensureRunning(session);
  const ticket = requireTicket(session, ticketId);
  ensure(!isTicketClosed(ticket), 'INVALID_STATE', 'That ticket is already closed.');

  return replaceTicket(touch(session, now), ticketId, (current) => ({
    ...replaceLatestRound(current, (round) =>
      round.status === 'open' || round.status === 'pending'
        ? { ...round, status: 'superseded' }
        : round,
    ),
    votingState: 'skipped',
  }));
}

// ---------------------------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------------------------

export interface SubmitVoteInput {
  readonly ticketId: TicketId;
  readonly userId: UserId;
  readonly cardId: CardId;
  readonly now: Date;
}

/**
 * Validates a vote and returns it for private storage. Voters may change their vote until the
 * round reveals; pre-votes on future tickets count only if the voter is on that round's roster.
 */
export function castVote(session: Session, input: SubmitVoteInput): Vote {
  ensureActive(session);
  const ticket = requireTicket(session, input.ticketId);
  ensure(!isTicketClosed(ticket), 'INVALID_STATE', 'Voting on this ticket is closed.');
  const round = requireLatestRound(ticket);
  requireCard(session.settings.deck, input.cardId);
  const participant = findParticipant(session, input.userId);
  ensure(
    participant !== undefined && participantStatus(participant) === 'joined',
    'NOT_ELIGIBLE',
    'Join the session before voting.',
  );

  if (round.status === 'open') {
    ensure(
      isRequiredVoter(round, input.userId),
      'NOT_ELIGIBLE',
      'You are not a voter in this round.',
    );
  } else {
    ensure(round.status === 'pending', 'INVALID_STATE', 'Voting on this round is closed.');
    ensure(
      canPreVote(session, input.userId, ticket.id),
      'NOT_ELIGIBLE',
      'You cannot vote on this ticket.',
    );
  }

  return { roundId: round.id, userId: input.userId, cardId: input.cardId, submittedAt: input.now };
}

export function canReveal(session: Session, ticketId: TicketId, votes: readonly Vote[]): boolean {
  const ticket = requireTicket(session, ticketId);
  const round = latestRound(ticket);

  return (
    session.status === 'active' &&
    session.currentTicketId === ticketId &&
    round?.status === 'open' &&
    roundProgress(round, votes).isComplete
  );
}

/** Reveals the anonymous result once every required voter has voted. Never with zero voters. */
export function revealRound(
  session: Session,
  ticketId: TicketId,
  votes: readonly Vote[],
  now: Date,
): Session {
  ensure(
    canReveal(session, ticketId, votes),
    'INVALID_STATE',
    'Results can be revealed once every required voter has voted.',
  );

  return replaceTicket(touch(session, now), ticketId, (ticket) => ({
    ...replaceLatestRound(ticket, (round) => ({
      ...round,
      status: 'revealed',
      revealedAt: now,
      result: computeResult(round, votes, session.settings.deck),
    })),
    votingState: 'revealed',
  }));
}

/** Starts a fresh round with a new roster: a revote after reveal, or a restart of an open round. */
export function startNewRound(
  session: Session,
  ticketId: TicketId,
  roundId: RoundId,
  now: Date,
): Session {
  ensureActive(session);
  ensure(
    session.currentTicketId === ticketId,
    'INVALID_STATE',
    'Only the current ticket can be revoted.',
  );
  const ticket = requireTicket(session, ticketId);
  ensure(!isTicketClosed(ticket), 'INVALID_STATE', 'That ticket is already closed.');
  const previous = requireLatestRound(ticket);

  return replaceTicket(touch(session, now), ticketId, (current) => {
    const closed = replaceLatestRound(current, (round) =>
      round.status === 'revealed' ? round : { ...round, status: 'superseded' },
    );
    const next: VotingRound = {
      id: roundId,
      ticketId,
      number: previous.number + 1,
      status: 'open',
      roster: freezeRoster(session, ticketId, now),
      openedAt: now,
      revealedAt: null,
      result: null,
    };

    return { ...closed, rounds: [...closed.rounds, next], votingState: 'revoting' };
  });
}

// ---------------------------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------------------------

function externalUpdateFor(
  session: Session,
  ticket: SessionTicket,
  cardId: CardId,
  roundId: RoundId,
): ExternalUpdate {
  const mapping = session.settings.destinationField;

  if (mapping === null) {
    return NO_EXTERNAL_UPDATE;
  }

  const mapped = mapCardToField(requireCard(session.settings.deck, cardId), mapping);
  ensure(mapped.ok, 'VALIDATION', mapped.ok ? '' : mapped.reason);

  return pendingExternalUpdate(mapping.fieldId, mapped.value, `${ticket.id}:${roundId}`);
}

function finalize(
  session: Session,
  ticketId: TicketId,
  decision: Omit<ConsensusDecision, 'ticketId' | 'roundId' | 'estimate'> & { cardId: CardId },
): Session {
  ensureRunning(session);
  const ticket = requireTicket(session, ticketId);
  ensure(ticket.decision === null, 'CONFLICT', 'This ticket already has a final estimate.');
  ensure(ticket.votingState === 'revealed', 'INVALID_STATE', 'Reveal the results first.');
  const round = requireLatestRound(ticket);
  const card = requireCard(session.settings.deck, decision.cardId);
  const externalUpdate = externalUpdateFor(session, ticket, card.id, round.id);

  return replaceTicket(touch(session, decision.decidedAt), ticketId, (current) => ({
    ...current,
    votingState: 'finalized',
    decision: {
      ticketId,
      roundId: round.id,
      kind: decision.kind,
      estimate: estimateFromCard(card),
      reason: decision.reason,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
    },
    externalUpdate,
  }));
}

/** True when a revealed round may finalize itself: unanimous, regular card, mappable value. */
export function canAutoFinalize(session: Session, ticketId: TicketId): boolean {
  const ticket = requireTicket(session, ticketId);
  const result = latestRound(ticket)?.result;

  if (!session.settings.autoFinalize || ticket.votingState !== 'revealed' || !result) {
    return false;
  }

  if (result.outcome !== 'unanimous' || result.unanimousCardId === null) {
    return false;
  }

  const card = requireCard(session.settings.deck, result.unanimousCardId);
  const mapping = session.settings.destinationField;

  return isRegularCard(card) && (mapping === null || mapCardToField(card, mapping).ok);
}

/** Accepts a unanimous regular result as the estimate. `decidedBy` is null when automatic. */
export function finalizeConsensus(
  session: Session,
  ticketId: TicketId,
  decidedBy: UserId | null,
  now: Date,
): Session {
  const result = latestRound(requireTicket(session, ticketId))?.result;
  ensure(
    result?.outcome === 'unanimous' && result.unanimousCardId !== null,
    'INVALID_STATE',
    'There is no consensus to accept.',
  );
  const card = requireCard(session.settings.deck, result.unanimousCardId);
  ensure(isRegularCard(card), 'VALIDATION', 'A special card needs a moderator decision.');

  return finalize(session, ticketId, {
    kind: 'consensus',
    cardId: card.id,
    reason: null,
    decidedBy,
    decidedAt: now,
  });
}

/** A moderator chooses the estimate after reveal. A reason is always required. */
export function overrideEstimate(
  session: Session,
  input: {
    readonly ticketId: TicketId;
    readonly cardId: CardId;
    readonly reason: string;
    readonly decidedBy: UserId;
    readonly now: Date;
  },
): Session {
  const reason = input.reason.trim();
  ensure(reason.length > 0, 'VALIDATION', 'Give a reason for the override.');
  const card = requireCard(session.settings.deck, input.cardId);
  ensure(isRegularCard(card), 'VALIDATION', 'Choose a regular card as the final estimate.');

  return finalize(session, input.ticketId, {
    kind: 'override',
    cardId: card.id,
    reason,
    decidedBy: input.decidedBy,
    decidedAt: input.now,
  });
}

// ---------------------------------------------------------------------------------------------
// External synchronization (independent of the voting state)
// ---------------------------------------------------------------------------------------------

function updateExternal(
  session: Session,
  ticketId: TicketId,
  now: Date,
  update: (current: ExternalUpdate) => ExternalUpdate,
): Session {
  ensure(session.status !== 'cancelled', 'INVALID_STATE', 'The session was cancelled.');

  return replaceTicket(touch(session, now), ticketId, (ticket) => ({
    ...ticket,
    externalUpdate: update(ticket.externalUpdate),
  }));
}

export function beginTicketSync(session: Session, ticketId: TicketId, now: Date): Session {
  return updateExternal(session, ticketId, now, (current) => beginSync(current, now));
}

export function completeTicketSync(
  session: Session,
  ticketId: TicketId,
  outcome: SyncOutcome,
  message: string | null,
  now: Date,
): Session {
  return updateExternal(session, ticketId, now, (current) =>
    completeSync(current, outcome, message, now),
  );
}

export function retryTicketSync(
  session: Session,
  ticketId: TicketId,
  confirmOverwrite: boolean,
  now: Date,
): Session {
  return updateExternal(session, ticketId, now, (current) => retrySync(current, confirmOverwrite));
}
