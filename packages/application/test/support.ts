import type { SessionView } from '@planning-poker/contracts';
import type {
  ApplicationRole,
  AuthorizationContext,
  CardId,
  FieldMapping,
  SessionId,
  SpecialCardType,
  TenantId,
  TicketId,
  UserId,
} from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import type { ImportedWorkItem } from '../src';
import { SessionService, TeamService } from '../src';
import type { InMemoryApplication } from '../src/testing';
import { createInMemoryApplication } from '../src/testing';

export const TENANT = asId<TenantId>('tenant-1');

export function actor(id: string, role: ApplicationRole = 'member'): AuthorizationContext {
  return { userId: asId<UserId>(id), tenantId: TENANT, role };
}

export function workItem(
  index: number,
  fieldValues: Record<string, number | null> = {},
): ImportedWorkItem {
  return {
    reference: {
      provider: 'fake',
      installationId: 'site-1',
      itemId: String(10_000 + index),
      displayKey: `PP-${String(index)}`,
      url: `https://example.test/browse/PP-${String(index)}`,
    },
    snapshot: {
      title: `Ticket ${String(index)}`,
      description: 'Plain <b>text</b> description',
      itemType: 'Story',
      status: 'To Do',
      displayFields: {},
      fieldValues,
    },
  };
}

export const STORY_POINTS: FieldMapping = {
  fieldId: 'customfield_10016',
  fieldName: 'Story points',
  valueType: 'number',
  optionByCardId: {},
};

export interface SessionSetup {
  readonly voters?: number;
  readonly observers?: number;
  readonly tickets?: number;
  readonly autoFinalize?: boolean;
  readonly autoAdvance?: boolean;
  readonly destinationField?: FieldMapping | null;
  readonly specialCards?: readonly SpecialCardType[];
  readonly fieldValues?: Record<string, number | null>;
}

export interface Harness {
  readonly app: InMemoryApplication;
  readonly service: SessionService;
  readonly teamService: TeamService;
  readonly moderator: AuthorizationContext;
  readonly voters: readonly AuthorizationContext[];
  readonly observers: readonly AuthorizationContext[];
  readonly sessionId: SessionId;
  readonly ticketIds: readonly TicketId[];
  view(as: AuthorizationContext): Promise<SessionView>;
  card(label: string): CardId;
  vote(as: AuthorizationContext, label: string, ticketId?: TicketId): Promise<void>;
  currentTicket(as?: AuthorizationContext): Promise<SessionView['tickets'][number]>;
  addUser(id: string): AuthorizationContext;
}

/** Creates a published session: a moderator (facilitator, observing), voters and observers who joined. */
export async function publishedSession(setup: SessionSetup = {}): Promise<Harness> {
  const app = createInMemoryApplication();
  const service = new SessionService(app.deps);
  const teamService = new TeamService(app.deps);
  const addUser = (id: string): AuthorizationContext => {
    app.identity.add({
      id: asId<UserId>(id),
      tenantId: TENANT,
      displayName: id,
      externalIdentities: [],
    });

    return actor(id);
  };
  addUser('moderator');
  const moderator = actor('moderator', 'moderator');
  const voters = Array.from({ length: setup.voters ?? 3 }, (_, index) =>
    addUser(`voter-${String(index + 1)}`),
  );
  const observers = Array.from({ length: setup.observers ?? 0 }, (_, index) =>
    addUser(`observer-${String(index + 1)}`),
  );
  const team = await teamService.createTeam(moderator, { name: 'Platform' });

  for (const person of [...voters, ...observers]) {
    await teamService.addMember(moderator, team.id, person.userId);
  }

  const draft = await service.createDraft(moderator, {
    name: 'Sprint 12',
    teamId: team.id,
    specialCards: setup.specialCards ?? ['infinity', 'unknown', 'coffee'],
  });
  const sessionId = draft.id;

  for (const voter of voters) {
    await service.inviteParticipant(moderator, sessionId, voter.userId, 'voter');
  }

  for (const observer of observers) {
    await service.inviteParticipant(moderator, sessionId, observer.userId, 'observer');
  }

  const withTickets = await service.addTickets(
    moderator,
    sessionId,
    Array.from({ length: setup.tickets ?? 2 }, (_, index) =>
      workItem(index + 1, setup.fieldValues),
    ),
  );
  await service.updateSettings(moderator, sessionId, {
    autoFinalize: setup.autoFinalize ?? false,
    autoAdvance: setup.autoAdvance ?? false,
    destinationField: setup.destinationField ?? null,
  });
  await service.markReady(moderator, sessionId);
  await service.publish(moderator, sessionId);

  for (const person of [...voters, ...observers]) {
    await service.respondToInvitation(person, sessionId, 'joined');
  }

  const ticketIds = [...withTickets.tickets].sort((a, b) => a.order - b.order).map((t) => t.id);
  const deck = withTickets.settings.deck;
  const card = (label: string): CardId => {
    const found = deck.cards.find((entry) => entry.label === label);

    if (found === undefined) {
      throw new Error(`No card labelled ${label}`);
    }

    return found.id;
  };
  const view = async (as: AuthorizationContext): Promise<SessionView> =>
    await service.getSessionView(as, sessionId);

  return {
    app,
    service,
    teamService,
    moderator,
    voters,
    observers,
    sessionId,
    ticketIds,
    view,
    card,
    addUser,
    async vote(as, label, ticketId) {
      const target = ticketId ?? (await view(moderator)).currentTicketId;

      if (target === null) {
        throw new Error('No current ticket');
      }

      await service.submitVote(as, sessionId, asId<TicketId>(target), card(label));
    },
    async currentTicket(as = moderator) {
      const current = await view(as);
      const ticket = current.tickets.find((entry) => entry.id === current.currentTicketId);

      if (ticket === undefined) {
        throw new Error('No current ticket');
      }

      return ticket;
    },
  };
}
