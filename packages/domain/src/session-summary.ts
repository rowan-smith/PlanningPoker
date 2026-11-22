import type { DecisionKind } from './estimate';
import type { SyncState } from './external-update';
import type { RoundId, SessionId, TeamId, TicketId, UserId } from './ids';
import type { InvitationStatus } from './participation';
import { participantStatus } from './participation';
import type { Session, SessionStatus } from './session';
import { orderedTickets } from './session';
import type { SessionTicket, TicketVotingState } from './ticket';
import type { CardCount, RoundOutcome, VotingRound } from './voting';
import { requiredVoterIds } from './voting';

/**
 * Who took part in a session, by category. Categories can overlap (a voter may also have been
 * skipped, or switched to observing after voting). Lists hold user IDs only, never votes.
 */
export interface ParticipantCategories {
  /** Everyone who had an invitation, whatever their response. Facilitators are not invited. */
  readonly invited: readonly UserId[];
  /** Invitees who accepted. */
  readonly joined: readonly UserId[];
  /** Invitees who declined. */
  readonly declined: readonly UserId[];
  /** Invitees whose invitation a moderator revoked. */
  readonly revoked: readonly UserId[];
  /** Invitees who never responded. */
  readonly noResponse: readonly UserId[];
  /** Voters who were required in at least one revealed round, so cast a counted vote. */
  readonly voting: readonly UserId[];
  /** Joined observers and facilitators who did not vote. */
  readonly observing: readonly UserId[];
  /** Anyone with a skip record (per ticket or for the session), even if later restored. */
  readonly skipped: readonly UserId[];
  readonly facilitators: readonly UserId[];
}

/** An anonymous revealed result: values and counts in deck order, never voters. */
export interface RoundSummary {
  readonly roundId: RoundId;
  readonly number: number;
  readonly outcome: RoundOutcome;
  readonly voteCount: number;
  readonly distribution: readonly CardCount[];
  readonly revealedAt: Date | null;
}

export type TicketOutcome = 'estimated' | 'skipped' | 'unresolved' | 'in-progress';

export interface TicketSummary {
  readonly ticketId: TicketId;
  readonly order: number;
  readonly displayKey: string;
  readonly url: string | null;
  readonly title: string;
  readonly votingState: TicketVotingState;
  readonly outcome: TicketOutcome;
  /** Revealed rounds only; rounds closed without reveal never had a counted result. */
  readonly revealedRounds: readonly RoundSummary[];
  /** Rounds started after the first. */
  readonly revotes: number;
  /** Revealed rounds whose votes differed. */
  readonly disagreements: number;
  /** The latest revealed round was unanimous. */
  readonly unanimous: boolean;
  readonly decision: {
    readonly kind: DecisionKind;
    readonly label: string;
    readonly reason: string | null;
    readonly decidedBy: UserId | null;
    readonly decidedAt: Date;
  } | null;
  /** Voters skipped for this ticket or for the session while this ticket was voted on. */
  readonly skippedVoters: readonly UserId[];
  readonly sync: {
    readonly state: SyncState;
    readonly attempts: number;
    readonly lastMessage: string | null;
  };
}

export interface SessionTotals {
  readonly tickets: number;
  readonly estimated: number;
  readonly skipped: number;
  readonly unresolved: number;
  readonly inProgress: number;
  readonly unanimous: number;
  readonly disagreements: number;
  readonly revotes: number;
  readonly overrides: number;
  readonly sync: Readonly<Record<SyncState, number>>;
}

/** The permanent record of a session. Contains no identity-to-vote mapping. */
export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly name: string;
  readonly teamId: TeamId;
  readonly status: SessionStatus;
  readonly moderatorId: UserId;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly participants: ParticipantCategories;
  readonly tickets: readonly TicketSummary[];
  readonly totals: SessionTotals;
}

const SKIP_EXCLUSIONS = new Set(['skipped-for-ticket', 'skipped-for-session']);

function unique(ids: Iterable<UserId>): UserId[] {
  return [...new Set(ids)];
}

function withInvitationStatus(session: Session, status: InvitationStatus): UserId[] {
  return session.participants
    .filter((participant) => participant.invitation?.status === status)
    .map((participant) => participant.userId);
}

function revealedRounds(ticket: SessionTicket): VotingRound[] {
  return ticket.rounds.filter((round) => round.status === 'revealed' && round.result !== null);
}

/**
 * A round reveals only once every required voter has voted, and revealed rounds never change,
 * so the required voters of revealed rounds are exactly the people whose votes were counted.
 */
export function countedVoterIds(session: Session): UserId[] {
  return unique(
    session.tickets.flatMap((ticket) => revealedRounds(ticket).flatMap(requiredVoterIds)),
  );
}

export function participantCategories(session: Session): ParticipantCategories {
  const voting = countedVoterIds(session);
  const voted = new Set(voting);

  return {
    invited: session.participants
      .filter((participant) => participant.invitation !== null)
      .map((participant) => participant.userId),
    joined: withInvitationStatus(session, 'joined'),
    declined: withInvitationStatus(session, 'declined'),
    revoked: withInvitationStatus(session, 'revoked'),
    noResponse: withInvitationStatus(session, 'invited'),
    voting,
    observing: session.participants
      .filter(
        (participant) =>
          !voted.has(participant.userId) &&
          (participant.isFacilitator ||
            (participant.role === 'observer' && participantStatus(participant) === 'joined')),
      )
      .map((participant) => participant.userId),
    skipped: unique(session.skips.map((skip) => skip.userId)),
    facilitators: session.participants
      .filter((participant) => participant.isFacilitator)
      .map((participant) => participant.userId),
  };
}

function ticketOutcome(state: TicketVotingState): TicketOutcome {
  switch (state) {
    case 'finalized':
      return 'estimated';
    case 'skipped':
      return 'skipped';
    case 'unresolved':
      return 'unresolved';
    default:
      return 'in-progress';
  }
}

function ticketSkippedVoters(session: Session, ticket: SessionTicket): UserId[] {
  const fromRosters = ticket.rounds.flatMap((round) =>
    (round.roster?.exclusions ?? [])
      .filter((exclusion) => SKIP_EXCLUSIONS.has(exclusion.reason))
      .map((exclusion) => exclusion.userId),
  );
  const fromRecords = session.skips
    .filter((skip) => skip.ticketId === ticket.id)
    .map((skip) => skip.userId);

  return unique([...fromRosters, ...fromRecords]);
}

export function summarizeTicket(session: Session, ticket: SessionTicket): TicketSummary {
  const revealed = revealedRounds(ticket);
  const lastRevealed = revealed.at(-1);
  const { decision, externalUpdate } = ticket;

  return {
    ticketId: ticket.id,
    order: ticket.order,
    displayKey: ticket.reference.displayKey,
    url: ticket.reference.url,
    title: ticket.snapshot.title,
    votingState: ticket.votingState,
    outcome: ticketOutcome(ticket.votingState),
    revealedRounds: revealed.map((round) => ({
      roundId: round.id,
      number: round.number,
      outcome: round.result?.outcome ?? 'disputed',
      voteCount: round.result?.voteCount ?? 0,
      distribution: (round.result?.distribution ?? []).map((entry) => ({ ...entry })),
      revealedAt: round.revealedAt,
    })),
    revotes: Math.max(0, ticket.rounds.length - 1),
    disagreements: revealed.filter((round) => round.result?.outcome === 'disputed').length,
    unanimous: lastRevealed?.result?.outcome === 'unanimous',
    decision:
      decision === null
        ? null
        : {
            kind: decision.kind,
            label: decision.estimate.label,
            reason: decision.reason,
            decidedBy: decision.decidedBy,
            decidedAt: decision.decidedAt,
          },
    skippedVoters: ticketSkippedVoters(session, ticket),
    sync: {
      state: externalUpdate.state,
      attempts: externalUpdate.attempts.length,
      lastMessage: externalUpdate.attempts.at(-1)?.message ?? null,
    },
  };
}

const NO_SYNC: Readonly<Record<SyncState, number>> = {
  'not-required': 0,
  pending: 0,
  syncing: 0,
  succeeded: 0,
  failed: 0,
  conflict: 0,
};

export function totalTickets(tickets: readonly TicketSummary[]): SessionTotals {
  const count = (predicate: (ticket: TicketSummary) => boolean): number =>
    tickets.filter(predicate).length;
  const sum = (value: (ticket: TicketSummary) => number): number =>
    tickets.reduce((total, ticket) => total + value(ticket), 0);
  const sync = { ...NO_SYNC };

  for (const ticket of tickets) {
    sync[ticket.sync.state] += 1;
  }

  return {
    tickets: tickets.length,
    estimated: count((ticket) => ticket.outcome === 'estimated'),
    skipped: count((ticket) => ticket.outcome === 'skipped'),
    unresolved: count((ticket) => ticket.outcome === 'unresolved'),
    inProgress: count((ticket) => ticket.outcome === 'in-progress'),
    unanimous: count((ticket) => ticket.unanimous),
    disagreements: sum((ticket) => ticket.disagreements),
    revotes: sum((ticket) => ticket.revotes),
    overrides: count((ticket) => ticket.decision?.kind === 'override'),
    sync,
  };
}

/** Summarizes a session from its aggregate alone. Works for running sessions too. */
export function summarizeSession(session: Session): SessionSummary {
  const tickets = orderedTickets(session).map((ticket) => summarizeTicket(session, ticket));

  return {
    sessionId: session.id,
    name: session.name,
    teamId: session.teamId,
    status: session.status,
    moderatorId: session.createdBy,
    createdAt: session.createdAt,
    startedAt: session.publishedAt,
    completedAt: session.completedAt,
    participants: participantCategories(session),
    tickets,
    totals: totalTickets(tickets),
  };
}

/** The date a session is filed under in history: completion, else publication, else creation. */
export function sessionDate(session: Session): Date {
  return session.completedAt ?? session.publishedAt ?? session.createdAt;
}
