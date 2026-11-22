/**
 * Local mock seed for Milestone 8: one completed session with history worth reporting on —
 * unanimous, disputed-then-revoted, overridden, skipped and unresolved tickets, a skipped voter,
 * a declined invitation and a failed Jira write. Driven through the real services.
 */
import type { SessionService } from '@planning-poker/application';
import type { FakeWorkItemProvider, FixedClock } from '@planning-poker/application/testing';
import type {
  AuthorizationContext,
  CardId,
  SessionId,
  TeamId,
  TicketId,
} from '@planning-poker/domain';
import { orderedTickets } from '@planning-poker/domain';

const MINUTE = 60_000;

export interface ReportSeedPeople {
  readonly moderator: AuthorizationContext;
  /** Joined voters, in the order they vote. */
  readonly voters: readonly AuthorizationContext[];
  /** Declines the invitation. */
  readonly decliner: AuthorizationContext;
  /** Joins as an observer. */
  readonly observer: AuthorizationContext;
}

export interface ReportSeedContext {
  readonly sessions: SessionService;
  readonly clock: FixedClock;
  readonly workItems: FakeWorkItemProvider;
  readonly teamId: TeamId;
  readonly people: ReportSeedPeople;
  /** Six issue keys: unanimous, revote, override, skipped voter, skipped ticket, unresolved. */
  readonly issueKeys: readonly [string, string, string, string, string, string];
}

export async function seedCompletedSession(context: ReportSeedContext): Promise<SessionId> {
  const { sessions, clock, people } = context;
  const { moderator, voters } = people;
  const [mia, sam, noor] = voters;

  if (mia === undefined || sam === undefined || noor === undefined) {
    throw new Error('The report seed needs three voters.');
  }

  const draft = await sessions.createDraft(moderator, {
    name: 'Sprint 41 planning',
    teamId: context.teamId,
  });
  const id = draft.id;

  for (const voter of [...voters, people.decliner]) {
    await sessions.inviteParticipant(moderator, id, voter.userId, 'voter');
  }

  await sessions.inviteParticipant(moderator, id, people.observer.userId, 'observer');
  await sessions.importByKeys(moderator, id, [...context.issueKeys]);
  await sessions.updateSettings(moderator, id, {
    destinationField: {
      fieldId: 'customfield_10016',
      fieldName: 'Story points',
      valueType: 'number',
      optionByCardId: {},
    },
  });
  await sessions.markReady(moderator, id);
  const session = await sessions.publish(moderator, id);
  clock.advance(MINUTE);

  for (const person of [...voters, people.observer]) {
    await sessions.respondToInvitation(person, id, 'joined');
  }

  await sessions.respondToInvitation(people.decliner, id, 'declined');

  const tickets = orderedTickets(session).map((ticket) => ticket.id);
  const [unanimous, revoted, overridden, skippedVoter, skippedTicket] = tickets;

  if (
    unanimous === undefined ||
    revoted === undefined ||
    overridden === undefined ||
    skippedVoter === undefined ||
    skippedTicket === undefined
  ) {
    throw new Error('The report seed needs six tickets.');
  }

  const card = (label: string): CardId => {
    const found = session.settings.deck.cards.find((entry) => entry.label === label);

    if (found === undefined) {
      throw new Error(`No card labelled ${label}`);
    }

    return found.id;
  };
  const voteAll = async (ticketId: TicketId, labels: readonly string[], who = voters) => {
    for (const [index, voter] of who.entries()) {
      const label = labels[index];

      if (label !== undefined) {
        clock.advance(MINUTE);
        await sessions.submitVote(voter, id, ticketId, card(label));
      }
    }
  };

  // 1. Everyone agrees; the moderator accepts.
  await voteAll(unanimous, ['3', '3', '3']);
  await sessions.acceptConsensus(moderator, id, unanimous);
  await sessions.advance(moderator, id);

  // 2. A disagreement, then a revote that agrees.
  await voteAll(revoted, ['3', '5', '8']);
  await sessions.startNewRound(moderator, id, revoted);
  await voteAll(revoted, ['5', '5', '5']);
  await sessions.acceptConsensus(moderator, id, revoted);
  await sessions.advance(moderator, id);

  // 3. A disagreement the moderator settles with an override; the Jira write fails.
  await voteAll(overridden, ['5', '8', '13']);
  context.workItems.nextUpdateResult = { status: 'failed', message: 'Jira is unavailable.' };
  await sessions.overrideEstimate(
    moderator,
    id,
    overridden,
    card('8'),
    'Includes the data migration the team discussed.',
  );
  context.workItems.nextUpdateResult = { status: 'succeeded' };
  await sessions.advance(moderator, id);

  // 4. Noor is away: skipped for this ticket; the other two agree.
  await sessions.skipParticipant(moderator, id, noor.userId, 'ticket');
  await voteAll(skippedVoter, ['2', '2'], [mia, sam]);
  await sessions.acceptConsensus(moderator, id, skippedVoter);
  await sessions.advance(moderator, id);

  // 5. The team decides not to estimate this one. The last ticket is left unresolved.
  await sessions.skipTicket(moderator, id, skippedTicket);
  clock.advance(MINUTE);
  await sessions.complete(moderator, id);

  return id;
}
