/**
 * Contract tests for session, roster-index and vote storage, run through the real application
 * services so the stored shapes are exactly what production writes.
 */
import { describe, expect, it } from 'vitest';

import { ConcurrencyConflict, SessionService, TeamService } from '@planning-poker/application';
import { createInMemoryApplication } from '@planning-poker/application/testing';
import type { RoundId, TenantId, UserId } from '@planning-poker/domain';
import { asId, latestRound } from '@planning-poker/domain';

import {
  ForgeParticipantRepository,
  ForgeSessionRepository,
  ForgeTeamRepository,
  ForgeVoteRepository,
} from '../src';
import { InMemoryEntityStore, MANIFEST_INDEXES } from '../src/testing';

const tenant = asId<TenantId>('tenant-1');
const user = (id: string) => asId<UserId>(id);

async function forgeBackedApp() {
  const app = createInMemoryApplication();
  const store = new InMemoryEntityStore(MANIFEST_INDEXES, 2);
  const deps = {
    ...app.deps,
    teams: new ForgeTeamRepository(store),
    sessions: new ForgeSessionRepository(store),
    participants: new ForgeParticipantRepository(store),
    votes: new ForgeVoteRepository(store),
  };

  for (const id of ['mod', 'ana', 'ben']) {
    app.identity.add({ id: user(id), tenantId: tenant, displayName: id, externalIdentities: [] });
  }

  app.workItems.add('PP-1', {
    reference: {
      provider: 'jira',
      installationId: 's',
      itemId: '1',
      displayKey: 'PP-1',
      url: null,
    },
    snapshot: {
      title: 'One',
      description: null,
      itemType: null,
      status: null,
      displayFields: {},
      fieldValues: {},
    },
  });
  const mod = { userId: user('mod'), tenantId: tenant, role: 'moderator' as const };
  const ana = { userId: user('ana'), tenantId: tenant, role: 'member' as const };
  const team = await new TeamService(deps).createTeam(mod, { name: 'Platform' });

  return { store, deps, sessions: new SessionService(deps), team, mod, ana };
}

describe('ForgeSessionRepository', () => {
  it('round-trips a published session with every nested date intact', async () => {
    const { deps, sessions, team, mod, ana } = await forgeBackedApp();
    const draft = await sessions.createDraft(mod, { name: 'Sprint', teamId: team.id });
    await sessions.inviteParticipant(mod, draft.id, ana.userId, 'voter');
    await sessions.importByKeys(mod, draft.id, ['PP-1']);
    await sessions.publish(mod, draft.id);
    await sessions.respondToInvitation(ana, draft.id, 'joined');

    const stored = await deps.sessions.get(tenant, draft.id);
    const round = stored?.tickets[0] === undefined ? undefined : latestRound(stored.tickets[0]);

    expect(stored?.status).toBe('active');
    expect(stored?.publishedAt).toBeInstanceOf(Date);
    expect(stored?.participants[1]?.invitation?.respondedAt).toBeInstanceOf(Date);
    expect(round?.roster?.frozenAt).toBeInstanceOf(Date);
    expect(stored?.settings.deck.cards.length).toBeGreaterThan(0);
  });

  it('rejects stale saves and keeps tenants apart', async () => {
    const { deps, sessions, team, mod } = await forgeBackedApp();
    const draft = await sessions.createDraft(mod, { name: 'Sprint', teamId: team.id });
    await deps.sessions.save({ ...draft, name: 'First' });

    await expect(deps.sessions.save({ ...draft, name: 'Second' })).rejects.toBeInstanceOf(
      ConcurrencyConflict,
    );
    expect(await deps.sessions.get(asId<TenantId>('other'), draft.id)).toBeNull();
    expect(await deps.sessions.listForTeams(tenant, [team.id])).toHaveLength(1);
  });
});

describe('ForgeParticipantRepository', () => {
  it('indexes roster members and drops people removed from a draft', async () => {
    const { deps, sessions, team, mod, ana } = await forgeBackedApp();
    const draft = await sessions.createDraft(mod, { name: 'Sprint', teamId: team.id });
    await sessions.inviteParticipant(mod, draft.id, ana.userId, 'voter');

    expect(await deps.participants.listSessionIdsForUser(tenant, ana.userId)).toEqual([draft.id]);

    await sessions.removeParticipant(mod, draft.id, ana.userId);
    expect(await deps.participants.listSessionIdsForUser(tenant, ana.userId)).toEqual([]);
    expect(await deps.participants.listSessionIdsForUser(tenant, mod.userId)).toEqual([draft.id]);
  });
});

describe('ForgeVoteRepository', () => {
  const vote = (roundId: string, userId: string, cardId: string) => ({
    roundId: asId<RoundId>(roundId),
    userId: user(userId),
    cardId: cardId as never,
    submittedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

  it('keeps one vote per voter per round and reads by roster', async () => {
    const votes = new ForgeVoteRepository(new InMemoryEntityStore(MANIFEST_INDEXES));
    await votes.upsert(tenant, vote('r1', 'ana', 'card:1'));
    await votes.upsert(tenant, vote('r1', 'ana', 'card:2'));
    await votes.upsert(tenant, vote('r1', 'ben', 'card:3'));
    await votes.upsert(tenant, vote('r2', 'ana', 'card:4'));

    const round = await votes.listForRound(tenant, asId<RoundId>('r1'), [user('ana'), user('cat')]);
    expect(round.map((v) => [v.userId, v.cardId])).toEqual([['ana', 'card:2']]);
    expect(
      (await votes.listForVoter(tenant, user('ana'), [asId<RoundId>('r1'), asId<RoundId>('r2')]))
        .length,
    ).toBe(2);

    await votes.remove(tenant, asId<RoundId>('r1'), user('ana'));
    expect(await votes.listForRound(tenant, asId<RoundId>('r1'), [user('ana')])).toEqual([]);
  });

  it('never returns votes stored for another tenant', async () => {
    const votes = new ForgeVoteRepository(new InMemoryEntityStore(MANIFEST_INDEXES));
    await votes.upsert(asId<TenantId>('other'), vote('r1', 'ana', 'card:1'));

    expect(await votes.listForRound(tenant, asId<RoundId>('r1'), [user('ana')])).toEqual([]);
  });
});
