import type {
  CurrentUserView,
  ParticipantView,
  RoundView,
  SessionSummaryView,
  SessionView,
  TicketView,
} from '@planning-poker/contracts';
import type {
  AuthorizationContext,
  Session,
  SessionTicket,
  Team,
  UserId,
  UserIdentity,
  Vote,
} from '@planning-poker/domain';
import {
  currentTicket,
  describeParticipant,
  findParticipant,
  isRequiredVoter,
  latestRound,
  orderedTickets,
  roundProgress,
} from '@planning-poker/domain';

const UNKNOWN_USER = 'Unknown user';

export function displayName(users: ReadonlyMap<UserId, UserIdentity>, userId: UserId): string {
  return users.get(userId)?.displayName ?? UNKNOWN_USER;
}

export function currentUserView(
  actor: AuthorizationContext,
  users: ReadonlyMap<UserId, UserIdentity>,
): CurrentUserView {
  return { userId: actor.userId, displayName: displayName(users, actor.userId), role: actor.role };
}

function roundView(ticket: SessionTicket, votes: readonly Vote[]): RoundView | null {
  const round = latestRound(ticket);

  if (round === undefined) {
    return null;
  }

  // Vote counts are only meaningful once the roster is frozen; pre-votes stay invisible.
  const progress =
    round.status === 'pending'
      ? null
      : roundProgress(
          round,
          votes.filter((v) => v.roundId === round.id),
        );

  return {
    roundId: round.id,
    number: round.number,
    status: round.status,
    requiredCount: progress?.requiredCount ?? 0,
    votedCount: progress?.votedCount ?? 0,
    result:
      round.result === null
        ? null
        : {
            outcome: round.result.outcome,
            voteCount: round.result.voteCount,
            distribution: round.result.distribution.map((entry) => ({ ...entry })),
            values: [...round.result.values],
            requiresModeratorResolution: round.result.requiresModeratorResolution,
          },
  };
}

function ticketView(
  ticket: SessionTicket,
  currentRoundVotes: readonly Vote[],
  viewerVotes: readonly Vote[],
): TicketView {
  const round = latestRound(ticket);
  const myVote = viewerVotes.find((vote) => vote.roundId === round?.id);

  return {
    id: ticket.id,
    order: ticket.order,
    displayKey: ticket.reference.displayKey,
    url: ticket.reference.url,
    title: ticket.snapshot.title,
    description: ticket.snapshot.description,
    itemType: ticket.snapshot.itemType,
    status: ticket.snapshot.status,
    displayFields: { ...ticket.snapshot.displayFields },
    votingState: ticket.votingState,
    round: roundView(ticket, currentRoundVotes),
    myVoteCardId: myVote?.cardId ?? null,
    estimate:
      ticket.decision === null
        ? null
        : {
            label: ticket.decision.estimate.label,
            kind: ticket.decision.kind,
            reason: ticket.decision.reason,
          },
    syncState: ticket.externalUpdate.state,
  };
}

export interface SessionViewInput {
  readonly session: Session;
  readonly team: Team;
  readonly users: ReadonlyMap<UserId, UserIdentity>;
  /** Votes for the current ticket's latest round, used only for voted/pending status. */
  readonly currentRoundVotes: readonly Vote[];
  /** The viewer's own votes, so they can see their own selection. */
  readonly viewerVotes: readonly Vote[];
  readonly viewerId: UserId;
  readonly canModerate: boolean;
}

/** The only shape sessions leave the server in. Contains no identity-to-vote mapping. */
export function sessionView(input: SessionViewInput): SessionView {
  const { session } = input;
  const current = currentTicket(session);
  const currentRound = current === undefined ? undefined : latestRound(current);
  const progress =
    currentRound?.status === 'open' ? roundProgress(currentRound, input.currentRoundVotes) : null;
  const voted = new Set(progress?.votedUserIds ?? []);
  const participants: ParticipantView[] = session.participants.map((participant) => {
    const described = describeParticipant(session, participant.userId);
    const required =
      currentRound?.status === 'open' && isRequiredVoter(currentRound, participant.userId);

    return {
      userId: participant.userId,
      displayName: displayName(input.users, participant.userId),
      role: participant.role,
      isFacilitator: participant.isFacilitator,
      invitationStatus: described.status,
      skippedForSession: described.skippedForSession,
      skippedForCurrentTicket: described.skippedForCurrentTicket,
      voteStatus: required ? (voted.has(participant.userId) ? 'voted' : 'pending') : 'not-required',
    };
  });
  const viewer = findParticipant(session, input.viewerId);

  return {
    id: session.id,
    name: session.name,
    teamName: input.team.name,
    status: session.status,
    deck: [...session.settings.deck.cards]
      .sort((a, b) => a.order - b.order)
      .map((card) => ({ id: card.id, label: card.label, kind: card.kind })),
    participants,
    tickets: orderedTickets(session).map((ticket) =>
      ticketView(
        ticket,
        ticket.id === current?.id ? input.currentRoundVotes : [],
        input.viewerVotes,
      ),
    ),
    currentTicketId: session.currentTicketId,
    viewer: {
      role: viewer?.role ?? null,
      canVoteOnCurrentTicket:
        session.status === 'active' &&
        currentRound?.status === 'open' &&
        isRequiredVoter(currentRound, input.viewerId),
      canModerate: input.canModerate,
    },
  };
}

export function sessionSummaryView(
  session: Session,
  team: Team,
  viewerId: UserId,
  canModerate: boolean,
): SessionSummaryView {
  return {
    id: session.id,
    name: session.name,
    teamName: team.name,
    status: session.status,
    currentTicketTitle: currentTicket(session)?.snapshot.title ?? null,
    myRole: findParticipant(session, viewerId)?.role ?? null,
    canModerate,
  };
}
