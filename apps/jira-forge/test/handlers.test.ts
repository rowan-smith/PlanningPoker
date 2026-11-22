import { describe, expect, it } from 'vitest';

import { SessionService, SettingsService, TeamService } from '@planning-poker/application';
import { createInMemoryApplication } from '@planning-poker/application/testing';
import type { ApplicationRole, TenantId, UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import { createHandlers } from '../src/handlers';
import type { Logger } from '../src/logger';

const tenant = asId<TenantId>('tenant');

function setup(role: ApplicationRole) {
  const app = createInMemoryApplication();
  const logged: string[] = [];
  const logger: Logger = {
    error(message, error) {
      logged.push(`${message} ${error instanceof Error ? error.message : ''}`);
    },
  };

  for (const id of ['me', 'other']) {
    app.identity.add({
      id: asId<UserId>(id),
      tenantId: tenant,
      displayName: id,
      externalIdentities: [],
    });
  }

  app.identity.actor = { userId: asId<UserId>('me'), tenantId: tenant, role };
  const deps = { ...app.deps, settings: app.settings };
  const handlers = createHandlers(
    {
      identity: app.identity,
      teams: new TeamService(deps),
      settings: new SettingsService(deps),
      sessions: new SessionService(deps),
    },
    logger,
  );

  return { app, handlers, logged };
}

describe('resolver handlers', () => {
  it('returns views on success', async () => {
    const { handlers } = setup('moderator');
    const created = await handlers.createTeam({ name: 'Alpha', description: null });

    expect(created).toMatchObject({ ok: true, value: { name: 'Alpha', canManage: true } });
  });

  it('rejects malformed payloads as validation errors', async () => {
    const { handlers } = setup('moderator');

    expect(await handlers.createTeam({ name: 42 })).toEqual({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid name.' },
    });
    expect(await handlers.getTeam(null)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(await handlers.getTeam({ teamId: 'x'.repeat(500) })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  });

  it('reports permission failures with their domain code', async () => {
    const { handlers } = setup('member');

    expect(await handlers.createTeam({ name: 'Alpha', description: null })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
  });

  it('hides unexpected errors behind a generic message and logs them', async () => {
    const { app, handlers, logged } = setup('moderator');
    app.identity.actor = null;

    expect(await handlers.listTeams({})).toEqual({
      ok: false,
      error: { code: 'INTERNAL', message: 'Something went wrong. Try again.' },
    });
    expect(logged).toEqual(['Resolver listTeams failed No actor configured.']);
  });

  it('uses the server-resolved actor, ignoring identity fields in the payload', async () => {
    const { handlers } = setup('member');
    const home = await handlers.getHome({ userId: 'other', role: 'administrator' });

    expect(home).toMatchObject({ ok: true, value: { user: { userId: 'me', role: 'member' } } });
  });

  it('validates session builder payloads before touching the session', async () => {
    const { handlers } = setup('moderator');
    const base = { sessionId: 's', autoFinalize: false, autoAdvance: false };

    expect(
      await handlers.configureScoring({
        ...base,
        allowInvitationsWhileActive: true,
        deck: { kind: 'preset', preset: 'roman-numerals' },
        specialCards: [],
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'Invalid preset.' } });
    expect(
      await handlers.configureScoring({
        ...base,
        allowInvitationsWhileActive: true,
        deck: { kind: 'preset', preset: 'fibonacci' },
        specialCards: ['joker'],
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'Invalid specialCards.' } });
    expect(
      await handlers.inviteParticipant({ sessionId: 's', userId: 'other', role: 'admin' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'Invalid role.' } });
    expect(await handlers.importTickets({ sessionId: 's', keys: 'PP-1' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid keys.' },
    });
  });

  it('validates import payloads', async () => {
    const { handlers } = setup('moderator');

    expect(await handlers.searchWorkItems({ sessionId: 's', query: 'x', cursor: 5 })).toMatchObject(
      {
        ok: false,
        error: { code: 'VALIDATION', message: 'Invalid cursor.' },
      },
    );
    expect(
      await handlers.searchWorkItems({ sessionId: 's', query: 'x'.repeat(1001), cursor: null }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'Invalid query.' } });
    expect(await handlers.setDisplayFields({ sessionId: 's', fieldIds: [1] })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid fieldIds.' },
    });
  });

  it('validates votes and keeps ticket progression for moderators', async () => {
    const { handlers } = setup('member');

    expect(await handlers.submitVote({ sessionId: 's', ticketId: 't' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid cardId.' },
    });
    expect(await handlers.advanceTicket({ sessionId: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});
