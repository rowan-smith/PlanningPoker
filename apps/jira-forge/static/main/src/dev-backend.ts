/**
 * Local mock backend: the real resolver handlers and application services running in the browser
 * against in-memory adapters. Pick who you are with `?as=admin|moderator|member|sam|observer`.
 */
import {
  ReportService,
  SessionService,
  SettingsService,
  TeamService,
} from '@planning-poker/application';
import { createInMemoryApplication } from '@planning-poker/application/testing';
import type { EventPublisher } from '@planning-poker/application';
import type { ResolverResult, SessionEvent } from '@planning-poker/contracts';
import type {
  ApplicationRole,
  CardId,
  SessionId,
  TenantId,
  TicketId,
  UserId,
} from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';
import type { PlanningPokerApi } from '@planning-poker/ui';
import { unwrap } from '@planning-poker/ui';

import { createHandlers } from '../../../src/handlers';
import { seedCompletedSession } from './dev-seed-reports';
import type { Logger } from '../../../src/logger';

const TENANT = asId<TenantId>('local-tenant');
const PEOPLE = {
  admin: { id: 'atlassian:ada', name: 'Ada Admin', role: 'administrator' },
  moderator: { id: 'atlassian:max', name: 'Max Moderator', role: 'moderator' },
  member: { id: 'atlassian:mia', name: 'Mia Member', role: 'member' },
  sam: { id: 'atlassian:sam', name: 'Sam Developer', role: 'member' },
  observer: { id: 'atlassian:lee', name: 'Lee Tester', role: 'member' },
} as const satisfies Record<string, { id: string; name: string; role: ApplicationRole }>;

/** A small fake Jira project; import these keys in the session builder. */
const ISSUES = [
  ['Sign in with SSO', 'Story'],
  ['Password reset email', 'Story'],
  ['Audit log export', 'Task'],
  ['Fix timezone bug on reports', 'Bug'],
  ['Team avatars', 'Story'],
  ['Rate-limit the public API', 'Task'],
  ['Dark mode for settings', 'Story'],
  ['Upgrade Node runtime', 'Task'],
] as const;

/** Extra teammates who appear only in the completed sample session (Milestone 8). */
const REPORT_EXTRA_PEOPLE = {
  noor: { id: 'atlassian:noor', name: 'Noor Designer', role: 'member' },
  raj: { id: 'atlassian:raj', name: 'Raj Engineer', role: 'member' },
} as const satisfies Record<string, { id: string; name: string; role: ApplicationRole }>;

/** Jira issue IDs are numeric and unrelated to keys; mimic that. */
const FIRST_ISSUE_ID = 10_001;

const devLogger: Logger = {
  error(message, error) {
    // eslint-disable-next-line no-console -- local preview only; surfaces handler failures.
    console.error(message, error);
  },
};

function actorFor(person: { id: string; role: ApplicationRole }) {
  return { userId: asId<UserId>(person.id), tenantId: TENANT, role: person.role };
}

/** In-process stand-in for Forge Realtime: same notifications, delivered within the page. */
class LocalEventBus implements EventPublisher {
  private readonly listeners = new Map<string, Set<() => void>>();

  publish(_tenantId: TenantId, sessionId: SessionId, _event: SessionEvent): Promise<void> {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener();
    }

    return Promise.resolve();
  }

  subscribe(sessionId: string, onChange: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(onChange);
    this.listeners.set(sessionId, listeners);

    return () => {
      listeners.delete(onChange);
    };
  }
}

export interface DevBackend {
  readonly api: PlanningPokerApi;
  /**
   * Demo only: everyone else who still has to vote on the current ticket of each active session
   * joins (if invited) and votes, so a single visitor can see rounds reveal.
   */
  readonly simulateTeammates: () => Promise<number>;
}

const SIMULATED_CARD_CHOICES = 3;

export async function createDevApi(search: string): Promise<DevBackend> {
  const app = createInMemoryApplication();
  const key = new URLSearchParams(search).get('as') ?? 'admin';
  const me = key in PEOPLE ? PEOPLE[key as keyof typeof PEOPLE] : PEOPLE.admin;

  for (const person of Object.values(PEOPLE)) {
    app.identity.add({
      id: asId<UserId>(person.id),
      tenantId: TENANT,
      displayName: person.name,
      externalIdentities: [],
    });
  }

  ISSUES.forEach(([title, itemType], index) => {
    const displayKey = `PP-${String(index + 1)}`;
    app.workItems.fieldTexts.set(displayKey, {
      priority: itemType === 'Bug' ? 'High' : 'Medium',
      labels: itemType === 'Bug' ? 'customer, regression' : 'roadmap',
    });
    app.workItems.add(displayKey, {
      reference: {
        provider: 'jira',
        installationId: 'local-site',
        itemId: String(FIRST_ISSUE_ID + index),
        displayKey,
        url: null,
      },
      snapshot: {
        title,
        description: `Local mock issue ${displayKey}.`,
        itemType,
        status: 'To Do',
        displayFields: {},
        fieldValues: {},
      },
    });
  });

  app.workItems.fields = [
    { fieldId: 'priority', name: 'Priority', valueType: 'unsupported', options: [] },
    { fieldId: 'labels', name: 'Labels', valueType: 'unsupported', options: [] },
    { fieldId: 'customfield_10016', name: 'Story points', valueType: 'number', options: [] },
  ];
  app.identity.actor = actorFor(me);
  const events = new LocalEventBus();
  const deps = { ...app.deps, events, settings: app.settings };
  const teams = new TeamService(deps);
  const settings = new SettingsService(deps);
  const sessions = new SessionService(deps);

  // Seed: Max moderates "Platform" (Mia, Sam, Lee) and has one published session and one draft.
  const admin = actorFor(PEOPLE.admin);
  const max = actorFor(PEOPLE.moderator);
  await settings.assignModerator(admin, asId<UserId>(PEOPLE.moderator.id));
  const platform = await teams.createTeam(max, {
    name: 'Platform',
    description: 'Payments and accounts',
  });

  for (const person of [PEOPLE.member, PEOPLE.sam, PEOPLE.observer]) {
    await teams.addMember(max, platform.id, asId<UserId>(person.id));
  }

  const live = await sessions.createDraft(max, { name: 'Sprint 42 planning', teamId: platform.id });
  await sessions.inviteParticipant(max, live.id, asId<UserId>(PEOPLE.member.id), 'voter');
  await sessions.inviteParticipant(max, live.id, asId<UserId>(PEOPLE.sam.id), 'voter');
  await sessions.inviteParticipant(max, live.id, asId<UserId>(PEOPLE.observer.id), 'observer');
  await sessions.importByKeys(max, live.id, ['PP-1', 'PP-2', 'PP-3']);
  await sessions.publish(max, live.id);
  await sessions.respondToInvitation(actorFor(PEOPLE.sam), live.id, 'joined');
  await sessions.createDraft(max, { name: 'Sprint 43 planning', teamId: platform.id });

  // Milestone 8: a completed earlier sprint, so History and Reports have data.
  for (const person of Object.values(REPORT_EXTRA_PEOPLE)) {
    app.identity.add({
      id: asId<UserId>(person.id),
      tenantId: TENANT,
      displayName: person.name,
      externalIdentities: [],
    });
    await teams.addMember(max, platform.id, asId<UserId>(person.id));
  }

  await seedCompletedSession({
    sessions,
    clock: app.clock,
    workItems: app.workItems,
    teamId: platform.id,
    issueKeys: ['PP-4', 'PP-5', 'PP-6', 'PP-7', 'PP-8', 'PP-3'],
    people: {
      moderator: max,
      voters: [actorFor(PEOPLE.member), actorFor(PEOPLE.sam), actorFor(REPORT_EXTRA_PEOPLE.noor)],
      decliner: actorFor(REPORT_EXTRA_PEOPLE.raj),
      observer: actorFor(PEOPLE.observer),
    },
  });

  const reports = new ReportService(deps);
  const handlers = createHandlers(
    { identity: app.identity, teams, settings, sessions, reports },
    devLogger,
  );
  const people = Object.values(PEOPLE);

  const simulateTeammates = async (): Promise<number> => {
    let votes = 0;
    const active = (await app.sessions.listForTeams(TENANT, [platform.id])).filter(
      (session) => session.status === 'active',
    );

    for (const session of active) {
      const view = await sessions.getSessionView(max, session.id);
      const ticketId = view.currentTicketId;
      const regular = view.deck.filter((card) => card.kind !== 'special').slice(1);

      if (ticketId === null || regular.length === 0) {
        continue;
      }

      for (const participant of view.participants) {
        const person = people.find((entry) => entry.id === participant.userId);

        if (participant.voteStatus !== 'pending' || participant.userId === me.id || !person) {
          continue;
        }

        const teammate = actorFor(person);

        if (participant.invitationStatus === 'invited') {
          await sessions.respondToInvitation(teammate, session.id, 'joined');
        }

        // Pick among a few neighbouring cards so rounds sometimes agree and sometimes differ.
        const card =
          regular[Math.floor(Math.random() * Math.min(SIMULATED_CARD_CHOICES, regular.length))];

        if (card !== undefined) {
          await sessions.submitVote(
            teammate,
            session.id,
            asId<TicketId>(ticketId),
            asId<CardId>(card.id),
          );
          votes += 1;
        }
      }
    }

    return votes;
  };

  return {
    api: {
      async call(key, payload) {
        const result = (await handlers[key](payload)) as ResolverResult<never>;

        return unwrap(result);
      },
      subscribe: (sessionId, onChange) => events.subscribe(sessionId, onChange),
    },
    simulateTeammates,
  };
}
