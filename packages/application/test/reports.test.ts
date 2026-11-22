/**
 * Report authorization, session history and report privacy (Milestone 8).
 */
import { describe, expect, it } from 'vitest';

import type {
  AuthorizationContext,
  DomainErrorCode,
  TeamId,
  TenantId,
} from '@planning-poker/domain';
import { asId, DomainError } from '@planning-poker/domain';

import type { HistoryFilters } from '../src';
import { DEFAULT_HISTORY_PAGE_SIZE, safeAuditDetails } from '../src';
import type { CompletedScenario } from './report-support';
import { completedScenario, DISCARDED_VOTE_LABEL } from './report-support';
import { actor, workItem } from './support';

const ALL: HistoryFilters = {
  teamId: null,
  status: null,
  from: null,
  to: null,
  cursor: null,
  limit: DEFAULT_HISTORY_PAGE_SIZE,
};

async function failsWith(promise: Promise<unknown>, code: DomainErrorCode): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) => error instanceof DomainError && error.code === code,
  );
}

function admin(): AuthorizationContext {
  return actor('admin', 'administrator');
}

async function teamId(s: CompletedScenario) {
  const session = await s.stored();

  return session.teamId;
}

describe('session summary access', () => {
  it('is visible to roster members, moderators and administrators', async () => {
    const s = await completedScenario();
    const [v1] = s.voters;

    const asMember = await s.reports.getSessionSummary(v1, s.h.sessionId);
    const asModerator = await s.reports.getSessionSummary(s.h.moderator, s.h.sessionId);
    const asAdmin = await s.reports.getSessionSummary(admin(), s.h.sessionId);

    expect(asMember.canViewAudit).toBe(false);
    expect(asModerator.canViewAudit).toBe(true);
    expect(asAdmin.canViewAudit).toBe(true);
    expect(asMember.participants.voting.map((p) => p.displayName)).toEqual([
      'voter-1',
      'voter-2',
      'voter-3',
      'voter-4',
    ]);
    expect(asMember.moderator.displayName).toBe('moderator');
  });

  it('is hidden from team members who are not on the roster and from people who declined', async () => {
    const s = await completedScenario();

    await failsWith(s.reports.getSessionSummary(s.outsider, s.h.sessionId), 'NOT_FOUND');
    await failsWith(s.reports.getSessionSummary(s.decliner, s.h.sessionId), 'NOT_FOUND');
    await failsWith(
      s.reports.getSessionSummary(
        { ...s.h.moderator, tenantId: asId<TenantId>('other') },
        s.h.sessionId,
      ),
      'NOT_FOUND',
    );
  });

  it('is not available for drafts', async () => {
    const s = await completedScenario();
    const draft = await s.h.service.createDraft(s.h.moderator, {
      name: 'Next sprint',
      teamId: await teamId(s),
    });

    await failsWith(s.reports.getSessionSummary(s.h.moderator, draft.id), 'INVALID_STATE');
  });
});

describe('audit log access', () => {
  it('is for moderators only and never carries vote values', async () => {
    const s = await completedScenario();
    const log = await s.reports.listAuditEvents(s.h.moderator, s.h.sessionId);
    const types = log.events.map((event) => event.type);

    expect(types).toContain('participant.skipped');
    expect(types).toContain('estimate.overridden');
    expect(types).toContain('session.completed');
    expect(log.events.flatMap((event) => event.details.map((detail) => detail.key))).not.toContain(
      'cardId',
    );

    const skipped = log.events.find(
      (event) => event.type === 'participant.skipped' && event.subjectName === 'voter-4',
    );

    expect(skipped?.details).toEqual([
      { key: 'scope', value: 'ticket' },
      { key: 'hadVoted', value: 'Yes' },
    ]);
    await failsWith(s.reports.listAuditEvents(s.voters[0], s.h.sessionId), 'FORBIDDEN');
    await failsWith(s.reports.listAuditEvents(s.outsider, s.h.sessionId), 'NOT_FOUND');
  });

  it('drops any detail key that could hold a card choice', () => {
    expect(
      safeAuditDetails({ cardId: 'c-5', value: 5, label: '5', reason: 'Scope grew', ok: true }),
    ).toEqual([
      { key: 'reason', value: 'Scope grew' },
      { key: 'ok', value: 'Yes' },
    ]);
  });
});

describe('team and application report access', () => {
  it('lets team moderators and administrators see team reports', async () => {
    const s = await completedScenario();
    const id = await teamId(s);
    const report = await s.reports.getTeamReport(s.h.moderator, id, { from: null, to: null });

    expect(report.sessions.map((session) => session.id)).toEqual([s.h.sessionId]);
    expect(report.totals).toMatchObject({ tickets: 4, overrides: 1, disagreements: 2 });
    expect(report.overrides).toEqual([
      expect.objectContaining({ label: '5', decidedByName: 'moderator' }),
    ]);
    expect(report.disagreements).toHaveLength(1);
    expect(
      (await s.reports.getTeamReport(admin(), id, { from: null, to: null })).sessions,
    ).toHaveLength(1);
  });

  it('refuses team reports to members and to moderators of other teams', async () => {
    const s = await completedScenario();
    const id = await teamId(s);
    const otherModerator = s.h.addUser('other-moderator');
    const other = { ...otherModerator, role: 'moderator' as const };
    await s.h.teamService.createTeam(other, { name: 'Other team' });

    await failsWith(
      s.reports.getTeamReport(s.voters[0], id, { from: null, to: null }),
      'FORBIDDEN',
    );
    await failsWith(s.reports.getTeamReport(other, id, { from: null, to: null }), 'NOT_FOUND');
    expect((await s.reports.getReportScope(other)).teams.map((team) => team.name)).toEqual([
      'Other team',
    ]);
  });

  it('limits the application report to administrators', async () => {
    const s = await completedScenario();
    const report = await s.reports.getAppReport(admin(), { from: null, to: null });

    expect(report).toMatchObject({ sessionCount: 1, totals: { tickets: 4 } });
    // Joined voters and observer plus the facilitator.
    expect(report.participantCount).toBe(6);
    expect(report.teams).toEqual([
      expect.objectContaining({ teamName: 'Platform', sessionCount: 1, participantCount: 6 }),
    ]);
    await failsWith(s.reports.getAppReport(s.h.moderator, { from: null, to: null }), 'FORBIDDEN');
    await failsWith(s.reports.getAppReport(s.voters[0], { from: null, to: null }), 'FORBIDDEN');
  });

  it('describes which reports each person can open', async () => {
    const s = await completedScenario();

    expect(await s.reports.getReportScope(s.voters[0])).toEqual({
      teams: [],
      canViewAppReport: false,
    });
    expect(await s.reports.getReportScope(s.h.moderator)).toMatchObject({
      teams: [{ name: 'Platform' }],
      canViewAppReport: false,
    });
    expect((await s.reports.getReportScope(admin())).canViewAppReport).toBe(true);
  });

  it('filters reports by completion date', async () => {
    const s = await completedScenario();
    const id = await teamId(s);
    const completedAt = (await s.stored()).completedAt ?? new Date();
    const later = new Date(completedAt.getTime() + 1);

    expect(
      (await s.reports.getTeamReport(s.h.moderator, id, { from: later, to: null })).sessions,
    ).toEqual([]);
    expect(
      (await s.reports.getAppReport(admin(), { from: null, to: completedAt })).sessionCount,
    ).toBe(1);
  });
});

describe('session history', () => {
  async function withSecondSession(s: CompletedScenario) {
    const draft = await s.h.service.createDraft(s.h.moderator, {
      name: 'Sprint 13',
      teamId: await teamId(s),
    });
    await s.h.service.inviteParticipant(s.h.moderator, draft.id, s.voters[0].userId, 'voter');
    await s.h.service.addTickets(s.h.moderator, draft.id, [workItem(1)]);
    await s.h.service.markReady(s.h.moderator, draft.id);
    s.h.app.clock.advance(60_000);
    await s.h.service.publish(s.h.moderator, draft.id);
    await s.h.service.createDraft(s.h.moderator, { name: 'Unpublished', teamId: draft.teamId });

    return draft.id;
  }

  it('lists published sessions newest first and leaves drafts out', async () => {
    const s = await completedScenario();
    const active = await withSecondSession(s);
    const history = await s.reports.listSessionHistory(s.h.moderator, ALL);

    expect(history.items.map((item) => item.id)).toEqual([active, s.h.sessionId]);
    expect(history.total).toBe(2);
    expect(history.teams).toEqual([expect.objectContaining({ name: 'Platform' })]);
    expect(history.items[1]).toMatchObject({
      status: 'completed',
      tickets: 4,
      estimated: 2,
      skipped: 1,
      unresolved: 1,
    });
  });

  it('filters by status, team and date, and pages', async () => {
    const s = await completedScenario();
    await withSecondSession(s);
    const list = async (filters: Partial<HistoryFilters>) =>
      await s.reports.listSessionHistory(s.h.moderator, { ...ALL, ...filters });
    const completedAt = (await s.stored()).completedAt ?? new Date();

    expect((await list({ status: 'completed' })).items.map((item) => item.id)).toEqual([
      s.h.sessionId,
    ]);
    expect((await list({ status: 'cancelled' })).items).toEqual([]);
    expect((await list({ teamId: asId<TeamId>('other-team') })).items).toEqual([]);
    expect((await list({ to: completedAt })).items.map((item) => item.id)).toEqual([s.h.sessionId]);

    const first = await list({ limit: 1 });
    const second = await list({ limit: 1, cursor: first.nextCursor });

    expect(first.nextCursor).toBe('1');
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items]).toHaveLength(2);
    await failsWith(list({ cursor: 'abc' }), 'VALIDATION');
  });

  it('shows members only the sessions they can view', async () => {
    const s = await completedScenario();
    await withSecondSession(s);

    expect((await s.reports.listSessionHistory(s.voters[0], ALL)).total).toBe(2);
    expect((await s.reports.listSessionHistory(s.voters[1], ALL)).total).toBe(1);
    expect((await s.reports.listSessionHistory(s.outsider, ALL)).total).toBe(0);
    expect((await s.reports.listSessionHistory(admin(), ALL)).total).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Privacy: no summary, report or audit view pairs a person with a vote value.
// ---------------------------------------------------------------------------------------------

function strings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  return [];
}

/** Strings held directly by an object, plus audit `{ key, value }` detail values. */
function ownStrings(node: Record<string, unknown>): string[] {
  return Object.values(node).flatMap((value) => {
    if (Array.isArray(value)) {
      return value.flatMap((item: unknown) =>
        typeof item === 'object' && item !== null && 'key' in item && 'value' in item
          ? strings((item as { value: unknown }).value)
          : [],
      );
    }

    return strings(value);
  });
}

function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap(objects);
  }

  if (typeof value === 'object' && value !== null) {
    const node = value as Record<string, unknown>;

    return [node, ...Object.values(node).flatMap(objects)];
  }

  return [];
}

describe('report privacy', () => {
  it('never pairs a voter with a card, and never shows a discarded vote', async () => {
    const s = await completedScenario();
    const id = await teamId(s);
    const session = await s.stored();
    // In the harness a person's display name equals their user ID, so this covers both.
    const voterIdentities = new Set<string>(s.voters.map((voter) => voter.userId));
    const cardStrings = new Set(
      session.settings.deck.cards.flatMap((card) => [card.id, card.label]),
    );
    const views: unknown[] = [
      await s.reports.getSessionSummary(s.voters[0], s.h.sessionId),
      await s.reports.getSessionSummary(s.h.moderator, s.h.sessionId),
      await s.reports.getSessionSummary(admin(), s.h.sessionId),
      await s.reports.listSessionHistory(s.h.moderator, ALL),
      await s.reports.getTeamReport(s.h.moderator, id, { from: null, to: null }),
      await s.reports.getAppReport(admin(), { from: null, to: null }),
      await s.reports.listAuditEvents(s.h.moderator, s.h.sessionId),
    ];

    for (const view of views) {
      const json = JSON.stringify(view);

      expect(json).not.toContain(`"${DISCARDED_VOTE_LABEL}"`);
      expect(json).not.toContain('myVoteCardId');

      for (const node of objects(view)) {
        const own = ownStrings(node);

        if (own.some((value) => voterIdentities.has(value))) {
          expect(own.filter((value) => cardStrings.has(value))).toEqual([]);
          expect(Object.keys(node)).not.toContain('cardId');
        }
      }
    }
  });
});
