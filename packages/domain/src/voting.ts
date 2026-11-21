import type { ScoringDeck } from './deck';
import { findCard } from './deck';
import type { CardId, RoundId, TicketId, UserId } from './ids';

/**
 * - `pending`: the ticket is not current yet; eligible voters may pre-vote.
 * - `open`: the roster is frozen and the round can reveal once every required voter has voted.
 * - `revealed`: results are public (anonymously) and immutable.
 * - `superseded`: replaced by a later round, skipped, or closed without reveal.
 */
export type RoundStatus = 'pending' | 'open' | 'revealed' | 'superseded';

export type ExclusionReason =
  'skipped-for-ticket' | 'skipped-for-session' | 'became-observer' | 'invitation-ended';

export interface RosterExclusion {
  readonly userId: UserId;
  readonly reason: ExclusionReason;
}

/**
 * The frozen set of voters for one round. Voters are only ever removed from an open round
 * (skip, role change, revoked invitation); new voters wait for the next round.
 */
export interface VotingRoster {
  readonly snapshotVoterIds: readonly UserId[];
  readonly exclusions: readonly RosterExclusion[];
  readonly frozenAt: Date;
}

export interface CardCount {
  readonly cardId: CardId;
  readonly label: string;
  readonly count: number;
}

export type RoundOutcome = 'unanimous' | 'disputed';

/** Anonymous by construction: holds values and counts, never voter identities. */
export interface RoundResult {
  readonly outcome: RoundOutcome;
  readonly voteCount: number;
  readonly distribution: readonly CardCount[];
  /** Every counted vote's label, ordered by deck order so it cannot reveal who voted what. */
  readonly values: readonly string[];
  readonly unanimousCardId: CardId | null;
  /** Disagreement, or agreement on a special card: a moderator must decide. */
  readonly requiresModeratorResolution: boolean;
}

export interface VotingRound {
  readonly id: RoundId;
  readonly ticketId: TicketId;
  readonly number: number;
  readonly status: RoundStatus;
  readonly roster: VotingRoster | null;
  readonly openedAt: Date | null;
  readonly revealedAt: Date | null;
  readonly result: RoundResult | null;
}

/** A private vote. Stored separately from the session and never sent to clients with its owner. */
export interface Vote {
  readonly roundId: RoundId;
  readonly userId: UserId;
  readonly cardId: CardId;
  readonly submittedAt: Date;
}

export interface RoundProgress {
  readonly requiredCount: number;
  readonly votedCount: number;
  readonly votedUserIds: readonly UserId[];
  readonly isComplete: boolean;
}

export function pendingRound(id: RoundId, ticketId: TicketId, number: number): VotingRound {
  return {
    id,
    ticketId,
    number,
    status: 'pending',
    roster: null,
    openedAt: null,
    revealedAt: null,
    result: null,
  };
}

export function requiredVoterIds(round: VotingRound): UserId[] {
  if (round.roster === null) {
    return [];
  }

  const excluded = new Set(round.roster.exclusions.map((exclusion) => exclusion.userId));

  return round.roster.snapshotVoterIds.filter((userId) => !excluded.has(userId));
}

export function isRequiredVoter(round: VotingRound, userId: UserId): boolean {
  return requiredVoterIds(round).includes(userId);
}

/** Votes that count for this round: one per required voter, ignoring excluded or foreign votes. */
export function countedVotes(round: VotingRound, votes: readonly Vote[]): Vote[] {
  const required = new Set(requiredVoterIds(round));
  const latestByUser = new Map<UserId, Vote>();

  for (const vote of votes) {
    if (vote.roundId !== round.id || !required.has(vote.userId)) {
      continue;
    }

    const existing = latestByUser.get(vote.userId);

    if (existing === undefined || existing.submittedAt <= vote.submittedAt) {
      latestByUser.set(vote.userId, vote);
    }
  }

  return [...latestByUser.values()];
}

export function roundProgress(round: VotingRound, votes: readonly Vote[]): RoundProgress {
  const requiredCount = requiredVoterIds(round).length;
  const counted = countedVotes(round, votes);

  return {
    requiredCount,
    votedCount: counted.length,
    votedUserIds: counted.map((vote) => vote.userId),
    // Zero required voters never completes a round: a moderator must act.
    isComplete: requiredCount > 0 && counted.length === requiredCount,
  };
}

export function computeResult(
  round: VotingRound,
  votes: readonly Vote[],
  deck: ScoringDeck,
): RoundResult {
  const counted = countedVotes(round, votes);
  const counts = new Map<CardId, number>();

  for (const vote of counted) {
    counts.set(vote.cardId, (counts.get(vote.cardId) ?? 0) + 1);
  }

  const distribution: CardCount[] = [...deck.cards]
    .sort((a, b) => a.order - b.order)
    .filter((card) => counts.has(card.id))
    .map((card) => ({ cardId: card.id, label: card.label, count: counts.get(card.id) ?? 0 }));
  const values = distribution.flatMap((entry) =>
    Array.from({ length: entry.count }, () => entry.label),
  );
  const [onlyEntry] = distribution;
  const unanimous = distribution.length === 1 && onlyEntry !== undefined;
  const unanimousCard = unanimous ? findCard(deck, onlyEntry.cardId) : undefined;

  return {
    outcome: unanimous ? 'unanimous' : 'disputed',
    voteCount: counted.length,
    distribution,
    values,
    unanimousCardId: unanimous ? onlyEntry.cardId : null,
    requiresModeratorResolution: !unanimous || unanimousCard?.kind === 'special',
  };
}
