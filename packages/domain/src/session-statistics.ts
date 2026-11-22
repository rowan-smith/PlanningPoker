import type { DecisionKind } from './estimate';
import type { SyncState } from './external-update';
import type { SessionId, TicketId, UserId } from './ids';
import type { Session } from './session';
import type { SessionSummary, SessionTotals, TicketOutcome } from './session-summary';
import { participantCategories } from './session-summary';
import { requiredVoterIds } from './voting';

/** How often one person took part across sessions. Counts only; never what they voted. */
export interface ParticipantStatistics {
  readonly userId: UserId;
  readonly sessionsInvited: number;
  readonly sessionsJoined: number;
  readonly sessionsDeclined: number;
  readonly sessionsVoted: number;
  readonly sessionsObserved: number;
  readonly sessionsFacilitated: number;
  /** Skip records (per ticket or for the session), including ones later restored. */
  readonly timesSkipped: number;
  /** Revealed rounds in which this person's vote was counted. */
  readonly roundsVoted: number;
}

export interface DisagreementEntry {
  readonly sessionId: SessionId;
  readonly ticketId: TicketId;
  readonly displayKey: string;
  readonly title: string;
  readonly disagreements: number;
  readonly revotes: number;
  readonly outcome: TicketOutcome;
  readonly finalLabel: string | null;
  readonly decisionKind: DecisionKind | null;
}

export interface OverrideEntry {
  readonly sessionId: SessionId;
  readonly ticketId: TicketId;
  readonly displayKey: string;
  readonly title: string;
  readonly label: string;
  readonly reason: string | null;
  readonly decidedBy: UserId | null;
  readonly decidedAt: Date;
}

type MutableStatistics = { -readonly [K in keyof ParticipantStatistics]: ParticipantStatistics[K] };

function emptyStatistics(userId: UserId): MutableStatistics {
  return {
    userId,
    sessionsInvited: 0,
    sessionsJoined: 0,
    sessionsDeclined: 0,
    sessionsVoted: 0,
    sessionsObserved: 0,
    sessionsFacilitated: 0,
    timesSkipped: 0,
    roundsVoted: 0,
  };
}

/** Participation per person over the given sessions, ordered by user ID. */
export function participantStatistics(sessions: readonly Session[]): ParticipantStatistics[] {
  const byUser = new Map<UserId, MutableStatistics>();
  const entry = (userId: UserId): MutableStatistics => {
    const existing = byUser.get(userId);

    if (existing !== undefined) {
      return existing;
    }

    const created = emptyStatistics(userId);
    byUser.set(userId, created);

    return created;
  };
  const countEach = (userIds: readonly UserId[], key: keyof Omit<MutableStatistics, 'userId'>) => {
    for (const userId of userIds) {
      entry(userId)[key] += 1;
    }
  };

  for (const session of sessions) {
    const categories = participantCategories(session);
    countEach(categories.invited, 'sessionsInvited');
    countEach(categories.joined, 'sessionsJoined');
    countEach(categories.declined, 'sessionsDeclined');
    countEach(categories.voting, 'sessionsVoted');
    countEach(categories.observing, 'sessionsObserved');
    countEach(categories.facilitators, 'sessionsFacilitated');
    countEach(
      session.skips.map((skip) => skip.userId),
      'timesSkipped',
    );

    for (const ticket of session.tickets) {
      for (const round of ticket.rounds) {
        if (round.status === 'revealed' && round.result !== null) {
          countEach(requiredVoterIds(round), 'roundsVoted');
        }
      }
    }
  }

  return [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId));
}

/** Tickets with at least one disputed revealed round, in session then ticket order. */
export function disagreementHistory(summaries: readonly SessionSummary[]): DisagreementEntry[] {
  return summaries.flatMap((summary) =>
    summary.tickets
      .filter((ticket) => ticket.disagreements > 0)
      .map((ticket) => ({
        sessionId: summary.sessionId,
        ticketId: ticket.ticketId,
        displayKey: ticket.displayKey,
        title: ticket.title,
        disagreements: ticket.disagreements,
        revotes: ticket.revotes,
        outcome: ticket.outcome,
        finalLabel: ticket.decision?.label ?? null,
        decisionKind: ticket.decision?.kind ?? null,
      })),
  );
}

/** Every moderator override with its reason, in session then ticket order. */
export function overrideHistory(summaries: readonly SessionSummary[]): OverrideEntry[] {
  return summaries.flatMap((summary) =>
    summary.tickets.flatMap((ticket) =>
      ticket.decision?.kind === 'override'
        ? [
            {
              sessionId: summary.sessionId,
              ticketId: ticket.ticketId,
              displayKey: ticket.displayKey,
              title: ticket.title,
              label: ticket.decision.label,
              reason: ticket.decision.reason,
              decidedBy: ticket.decision.decidedBy,
              decidedAt: ticket.decision.decidedAt,
            },
          ]
        : [],
    ),
  );
}

/** Adds up session totals, e.g. for a team or the whole application. */
export function combineTotals(totals: readonly SessionTotals[]): SessionTotals {
  const sum = (value: (entry: SessionTotals) => number): number =>
    totals.reduce((total, entry) => total + value(entry), 0);
  const syncStates: readonly SyncState[] = [
    'not-required',
    'pending',
    'syncing',
    'succeeded',
    'failed',
    'conflict',
  ];

  return {
    tickets: sum((entry) => entry.tickets),
    estimated: sum((entry) => entry.estimated),
    skipped: sum((entry) => entry.skipped),
    unresolved: sum((entry) => entry.unresolved),
    inProgress: sum((entry) => entry.inProgress),
    unanimous: sum((entry) => entry.unanimous),
    disagreements: sum((entry) => entry.disagreements),
    revotes: sum((entry) => entry.revotes),
    overrides: sum((entry) => entry.overrides),
    sync: Object.fromEntries(
      syncStates.map((state) => [state, sum((entry) => entry.sync[state])]),
    ) as Record<SyncState, number>,
  };
}
