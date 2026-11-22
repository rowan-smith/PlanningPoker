import { describe, expect, it } from 'vitest';

import {
  ConcurrencyConflict,
  ReportService,
  SessionService,
  SettingsService,
  TeamService,
} from '@planning-poker/application';
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
  const sessions = new SessionService(deps);
  const teams = new TeamService(deps);
  const handlers = createHandlers(
    {
      identity: app.identity,
      teams,
      settings: new SettingsService(deps),
      sessions,
      reports: new ReportService(deps),
    },
    logger,
  );

  return { app, handlers, logged, sessions, teams };
}

/** A published session moderated by "me", with "other" invited as a voter and one ticket. */
async function liveSession(context: ReturnType<typeof setup>) {
  const me = { userId: asId<UserId>('me'), tenantId: tenant, role: 'moderator' as const };
  const team = await context.teams.createTeam(me, { name: 'Alpha' });
  await context.teams.addMember(me, team.id, asId<UserId>('other'));
  const draft = await context.sessions.createDraft(me, { name: 'Sprint', teamId: team.id });
  await context.sessions.inviteParticipant(me, draft.id, asId<UserId>('other'), 'voter');
  const withTicket = await context.sessions.addTickets(me, draft.id, [
    {
      reference: {
        provider: 'fake',
        installationId: 'site',
        itemId: '1',
        displayKey: 'PP-1',
        url: null,
      },
      snapshot: {
        title: 'Ticket',
        description: null,
        itemType: null,
        status: null,
        displayFields: {},
        fieldValues: {},
      },
    },
  ]);
  await context.sessions.publish(me, draft.id);
  const [ticket] = withTicket.tickets;

  if (ticket === undefined) {
    throw new Error('setup');
  }

  return { sessionId: draft.id as string, ticketId: ticket.id as string };
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

  it('reports conflicts that outlast the retries as CONFLICT, without logging them', async () => {
    const { app, handlers, logged } = setup('moderator');
    app.deps.teams.save = () => Promise.reject(new ConcurrencyConflict());

    expect(await handlers.createTeam({ name: 'Alpha', description: null })).toEqual({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'Someone else changed this at the same time. Try again.',
      },
    });
    expect(logged).toEqual([]);
  });

  it('rejects empty identifiers before they reach a use case', async () => {
    const { handlers } = setup('moderator');

    for (const payload of [{ sessionId: '' }, { sessionId: 's', ticketId: '' }]) {
      expect(await handlers.revealRound(payload)).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION' },
      });
    }
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

  it('validates facilitator control payloads before touching the session', async () => {
    const { handlers } = setup('moderator');
    const base = { sessionId: 's', ticketId: 't' };

    expect(
      await handlers.skipParticipant({ sessionId: 's', userId: 'other', scope: 'forever' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'Invalid scope.' } });
    expect(await handlers.restoreParticipant({ sessionId: 's' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid userId.' },
    });
    expect(
      await handlers.changeRoomRole({ sessionId: 's', userId: 'other', role: 'moderator' }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'Invalid role.' } });
    expect(await handlers.revealRound({ sessionId: 's' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid ticketId.' },
    });
    expect(await handlers.overrideEstimate({ ...base, reason: 'Agreed' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid cardId.' },
    });
    expect(await handlers.overrideEstimate({ ...base, cardId: 'c', reason: '   ' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid reason.' },
    });
    expect(
      await handlers.overrideEstimate({ ...base, cardId: 'c', reason: 'x'.repeat(501) }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION', message: 'Invalid reason.' } });
    expect(await handlers.setCurrentTicket({ sessionId: 's', ticketId: 7 })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid ticketId.' },
    });
    expect(await handlers.pauseSession({})).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid sessionId.' },
    });
  });

  it('runs facilitator controls and returns the updated session view', async () => {
    const context = setup('moderator');
    const { handlers } = context;
    const { sessionId, ticketId } = await liveSession(context);

    expect(
      await handlers.skipParticipant({ sessionId, userId: 'other', scope: 'ticket' }),
    ).toMatchObject({
      ok: true,
      value: {
        participants: [{ userId: 'me' }, { userId: 'other', skippedForCurrentTicket: true }],
      },
    });
    expect(await handlers.restoreParticipant({ sessionId, userId: 'other' })).toMatchObject({
      ok: true,
      value: { participants: [{}, { skippedForCurrentTicket: false, voteStatus: 'pending' }] },
    });
    expect(await handlers.revealRound({ sessionId, ticketId })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE' },
    });
    expect(await handlers.pauseSession({ sessionId })).toMatchObject({
      ok: true,
      value: { status: 'paused' },
    });
    expect(await handlers.resumeSession({ sessionId })).toMatchObject({
      ok: true,
      value: { status: 'active', viewer: { canModerate: true, canInvite: true } },
    });
    expect(await handlers.skipTicket({ sessionId, ticketId })).toMatchObject({
      ok: true,
      value: { tickets: [{ votingState: 'skipped' }] },
    });
    expect(await handlers.completeSession({ sessionId })).toMatchObject({
      ok: true,
      value: { status: 'completed', viewer: { canInvite: false } },
    });
  });

  it('keeps facilitator controls moderator-only', async () => {
    const context = setup('moderator');
    const { sessionId, ticketId } = await liveSession(context);
    context.app.identity.actor = {
      userId: asId<UserId>('other'),
      tenantId: tenant,
      role: 'member',
    };

    expect(await context.handlers.skipTicket({ sessionId, ticketId })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await context.handlers.pauseSession({ sessionId })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
  });
});
