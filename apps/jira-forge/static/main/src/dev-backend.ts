/**
 * Local mock backend: the real resolver handlers and application services running in the browser
 * against in-memory adapters. Pick who you are with `?as=admin|moderator|member|sam|observer`.
 */
import { SessionService, SettingsService, TeamService } from '@planning-poker/application';
import { createInMemoryApplication } from '@planning-poker/application/testing';
import type { ResolverResult } from '@planning-poker/contracts';
import type { ApplicationRole, TenantId, UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';
import type { PlanningPokerApi } from '@planning-poker/ui';
import { unwrap } from '@planning-poker/ui';

import { createHandlers } from '../../../src/handlers';
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

export async function createDevApi(search: string): Promise<PlanningPokerApi> {
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
  const deps = { ...app.deps, settings: app.settings };
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

  const handlers = createHandlers({ identity: app.identity, teams, settings, sessions }, devLogger);

  return {
    async call(key, payload) {
      const result = (await handlers[key](payload)) as ResolverResult<never>;

      return unwrap(result);
    },
  };
}
