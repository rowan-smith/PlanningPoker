/**
 * Every resolver, called by every kind of user, on the production wiring (Forge repositories,
 * Jira adapters). Allowed callers never get NOT_FOUND/FORBIDDEN; everyone else gets exactly one
 * of those (or NOT_ELIGIBLE for voting), never INTERNAL, and never any of the session's data.
 *
 * `MATRIX` is typed by ResolverKey, so adding a resolver without a row here fails type checking.
 */
import { describe, expect, it } from 'vitest';

import { RESOLVER_KEYS } from '@planning-poker/contracts';

import { ok, userId } from '../support/forge-backend';
import { callerFor, DENY, fixture, MATRIX, ROLES, secretsOf } from '../support/probes';
import { MIA } from '../support/world';

describe('authorization matrix', () => {
  it('covers every resolver key', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...RESOLVER_KEYS].sort());
  });

  for (const key of RESOLVER_KEYS) {
    describe(key, () => {
      for (const role of ROLES) {
        const probe = MATRIX[key];
        const allowed = probe.allowed.includes(role);

        it(`${allowed ? 'allows' : 'denies'} ${role}`, async () => {
          const f = await fixture();
          const result = await callerFor(f.world, role)[key](probe.payload(f));
          const serialized = JSON.stringify(result);

          if (!result.ok) {
            expect(result.error.code).not.toBe('INTERNAL');
          }

          if (allowed) {
            expect(result.ok ? 'ok' : result.error.code).not.toMatch(/^(NOT_FOUND|FORBIDDEN)$/);

            return;
          }

          expect(result.ok).toBe(false);
          expect(result.ok ? null : result.error.code).toBeOneOf([...(probe.denials ?? DENY)]);

          for (const secret of secretsOf(f)) {
            expect(serialized).not.toContain(secret);
          }
        });
      }
    });
  }

  it('never lets another installation see this site’s data, even as an administrator', async () => {
    const f = await fixture();
    const { eve } = f.world;

    for (const key of [
      'getHome',
      'listTeams',
      'listSessions',
      'listSessionHistory',
      'getReportScope',
      'getAppReport',
    ] as const) {
      const serialized = JSON.stringify(await eve[key]({}));

      for (const secret of secretsOf(f)) {
        expect(serialized, key).not.toContain(secret);
      }
    }
  });

  it('audits privileged actions with the acting user', async () => {
    const f = await fixture();
    ok(await f.world.ada.assignTeamModerator({ teamId: f.teamId, userId: userId(MIA) }));
    ok(await f.world.max.archiveTeam({ teamId: f.teamId }));
    const audit = [...f.world.backend.memory.records]
      .filter(([key]) => key.startsWith('auditevent/'))
      .map(([, record]) => record as { type: string; data: { actorId: string | null } });
    const actorOf = (type: string) =>
      audit.filter((event) => event.type === type).map((event) => event.data.actorId);

    expect(actorOf('settings.moderator-assigned')).toEqual([userId('ada-admin')]);
    expect(actorOf('settings.writable-fields-changed')).toEqual([userId('ada-admin')]);
    expect(actorOf('team.created')).toEqual([userId('max-moderator')]);
    expect(actorOf('team.moderator-assigned')).toEqual([userId('ada-admin')]);
    expect(actorOf('team.archived')).toEqual([userId('max-moderator')]);
    expect(actorOf('session.published')).toEqual([userId('max-moderator')]);
  });

  it('shows settings only to administrators', async () => {
    const f = await fixture();

    for (const caller of [f.world.max, f.world.mia, f.world.out]) {
      expect(ok(await caller.getSettings())).toEqual({ canAdminister: false, moderators: [] });
    }

    expect(ok(await f.world.ada.getSettings()).canAdminister).toBe(true);
  });

  it('does not trust roles, user IDs or voting state sent by the client', async () => {
    const f = await fixture();
    const { mia } = f.world;
    // Extra fields claiming privileges are ignored: Mia is still a member.
    const forged = {
      sessionId: f.sessionId,
      role: 'administrator',
      userId: userId('max-moderator'),
      canModerate: true,
    };

    expect(await mia.completeSession(forged)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await mia.listAuditEvents(forged)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    // A vote is always cast as the caller, whatever userId the payload names.
    ok(await mia.submitVote({ ...forged, ticketId: f.ticketId, cardId: f.cardId }));
    const view = ok(await f.world.max.getSession({ sessionId: f.sessionId }));
    const voted = view.participants.filter((participant) => participant.voteStatus === 'voted');
    expect(voted.map((participant) => participant.userId)).toEqual([userId(MIA)]);
  });
});
