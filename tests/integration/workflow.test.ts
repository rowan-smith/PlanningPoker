/**
 * The whole workflow through the resolver handlers, on the Forge repositories (in-memory entity
 * store, ForgeAtomicOperation) and the real Jira adapters over a fake Jira site.
 */
import { describe, expect, it } from 'vitest';

import { STORY_POINTS } from '../support/fake-jira';
import { ok, userId } from '../support/forge-backend';
import {
  cardId,
  createWorld,
  currentTicketId,
  draftSession,
  ISSUES,
  MAX,
  MIA,
  SAM,
  ticketOf,
} from '../support/world';

describe('complete planning workflow (integration)', () => {
  it('runs from administrator setup to reports, writing estimates to Jira', async () => {
    const world = await createWorld();
    const { ada, max, mia, sam, ola, lee, backend } = world;
    const { jira } = backend;

    // Administrator: allowlist and app moderator (done by createWorld) are visible in Settings.
    const settings = ok(await ada.getSettings());
    expect(settings.moderators.map((person) => person.userId)).toContain(userId(MAX));
    expect(ok(await ada.getFieldAllowlist()).selectedIds).toEqual([STORY_POINTS]);

    // Team.
    const team = ok(await max.getTeam({ teamId: world.teamId }));
    expect(team.members.map((member) => member.userId).sort()).toEqual(
      [userId(MAX), userId(MIA), userId(SAM)].sort(),
    );

    // Draft with voters and observers, imported by key; then add one ticket found by JQL.
    const sessionId = await draftSession(world, { autoFinalize: true, keys: [ISSUES.pp1.key] });
    const search = ok(
      await max.searchWorkItems({ sessionId, query: 'project = PP', cursor: null }),
    );
    expect(search.items.map((item) => item.key)).toEqual(['PP-1', 'PP-2', 'PP-3']);
    expect(search.items.find((item) => item.key === 'PP-1')?.alreadyAdded).toBe(true);
    const imported = ok(await max.importTickets({ sessionId, keys: ['PP-2', 'NOPE-1'] }));
    expect(imported.missingKeys).toEqual(['NOPE-1']);

    // Field mapping, then readiness.
    const mapping = ok(await max.getFieldMapping({ sessionId }));
    expect(mapping.destination?.fieldId).toBe(STORY_POINTS);
    const builder = ok(await max.getSessionBuilder({ sessionId }));
    expect(builder.readiness.ready).toBe(true);
    expect(builder.session.tickets.map((ticket) => ticket.displayKey)).toEqual(['PP-1', 'PP-2']);

    // Drafts are hidden from invitees.
    expect(ok(await mia.getHome()).pendingInvitations).toEqual([]);
    expect(await mia.getSession({ sessionId })).toMatchObject({ error: { code: 'NOT_FOUND' } });

    // Publish → invitations appear → join.
    ok(await max.publishSession({ sessionId }));
    expect(ok(await mia.getHome()).pendingInvitations.map((item) => item.sessionId)).toEqual([
      sessionId,
    ]);

    for (const caller of [mia, sam, ola, lee]) {
      ok(await caller.respondToInvitation({ sessionId, response: 'joined' }));
    }

    let view = ok(await max.getSession({ sessionId }));
    const first = currentTicketId(view);
    const second = view.tickets.find((ticket) => ticket.id !== first)?.id ?? '';
    const five = cardId(view, '5');
    const eight = cardId(view, '8');

    // Pre-vote on the second ticket, then vote on the first.
    ok(await mia.submitVote({ sessionId, ticketId: second, cardId: five }));
    ok(await mia.submitVote({ sessionId, ticketId: first, cardId: five }));
    ok(await sam.submitVote({ sessionId, ticketId: first, cardId: eight }));
    // Observers cannot vote.
    expect(await lee.submitVote({ sessionId, ticketId: first, cardId: five })).toMatchObject({
      ok: false,
      error: { code: 'NOT_ELIGIBLE' },
    });
    view = ok(await mia.getSession({ sessionId }));
    expect(ticketOf(view, first).round).toMatchObject({ votedCount: 2, requiredCount: 3 });
    expect(ticketOf(view, first).round?.result).toBeNull();

    // The last vote reveals automatically; the result is disputed.
    ok(await ola.submitVote({ sessionId, ticketId: first, cardId: five }));
    view = ok(await lee.getSession({ sessionId }));
    expect(ticketOf(view, first).round?.result).toMatchObject({
      outcome: 'disputed',
      voteCount: 3,
      distribution: [
        { label: '5', count: 2 },
        { label: '8', count: 1 },
      ],
    });

    // Revote → unanimous → auto-finalized and written to Jira.
    ok(await max.startNewRound({ sessionId, ticketId: first }));

    // Mia votes last, so the automatic write runs with her Jira permissions (asUser).
    for (const caller of [ola, sam, mia]) {
      ok(await caller.submitVote({ sessionId, ticketId: first, cardId: five }));
    }

    view = ok(await max.getSession({ sessionId }));
    expect(ticketOf(view, first).estimate).toMatchObject({ label: '5', kind: 'consensus' });
    expect(ticketOf(view, first).sync.state).toBe('succeeded');
    expect(jira.issues.get(ISSUES.pp1.id)?.fields[STORY_POINTS]).toBe(5);

    // Second ticket: Jira fails the first write; the moderator retries successfully.
    ok(await max.advanceTicket({ sessionId }));
    jira.putFailures.push(503);
    ok(await sam.submitVote({ sessionId, ticketId: second, cardId: eight }));
    ok(await ola.submitVote({ sessionId, ticketId: second, cardId: five }));
    view = ok(await max.getSession({ sessionId }));
    expect(ticketOf(view, second).round?.result?.outcome).toBe('disputed');
    // Override with a reason.
    ok(
      await max.overrideEstimate({
        sessionId,
        ticketId: second,
        cardId: eight,
        reason: 'Includes the migration',
      }),
    );
    view = ok(await max.getSession({ sessionId }));
    expect(ticketOf(view, second).estimate).toMatchObject({ kind: 'override', label: '8' });
    expect(ticketOf(view, second).sync.state).toBe('failed');
    expect(ticketOf(view, second).sync.message).not.toContain('SECRET');
    ok(await max.retrySync({ sessionId, ticketId: second, confirmOverwrite: false }));
    view = ok(await max.getSession({ sessionId }));
    expect(ticketOf(view, second).sync.state).toBe('succeeded');
    expect(jira.issues.get(ISSUES.pp2.id)?.fields[STORY_POINTS]).toBe(8);

    // Exactly one successful PUT per decision, plus the failed one.
    const puts = jira.calls.filter((call) => call.method === 'PUT');
    expect(puts.map((call) => call.path)).toEqual([
      `/rest/api/3/issue/${ISSUES.pp1.id}`,
      `/rest/api/3/issue/${ISSUES.pp2.id}`,
      `/rest/api/3/issue/${ISSUES.pp2.id}`,
    ]);
    expect(puts.map((call) => [call.as, call.accountId])).toEqual([
      ['user', MIA],
      ['user', MAX],
      ['user', MAX],
    ]);

    // Complete → summary, history, team and app reports.
    ok(await max.completeSession({ sessionId }));
    const summary = ok(await mia.getSessionSummary({ sessionId }));
    expect(summary.status).toBe('completed');
    expect(summary.tickets.map((ticket) => ticket.outcome)).toEqual(['estimated', 'estimated']);
    expect(summary.canViewAudit).toBe(false);
    const history = ok(await mia.listSessionHistory({}));
    expect(history.items.map((item) => item.id)).toEqual([sessionId]);
    const report = ok(await max.getTeamReport({ teamId: world.teamId }));
    expect(report.sessions).toHaveLength(1);
    expect(report.overrides.map((entry) => entry.reason)).toEqual(['Includes the migration']);
    const appReport = ok(await ada.getAppReport({}));
    expect(appReport.sessionCount).toBe(1);
    expect(await max.getAppReport({})).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const audit = ok(await max.listAuditEvents({ sessionId }));
    expect(audit.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'session.published',
        'round.revealed',
        'round.started',
        'estimate.finalized',
        'estimate.overridden',
        'sync.retried',
        'sync.completed',
        'session.completed',
      ]),
    );
  });

  it('refuses to overwrite a value changed in Jira until the moderator confirms', async () => {
    const world = await createWorld();
    const { max, mia, sam, ola, backend } = world;
    const sessionId = await draftSession(world, { autoFinalize: true, keys: [ISSUES.pp3.key] });
    ok(await max.publishSession({ sessionId }));

    for (const caller of [mia, sam, ola]) {
      ok(await caller.respondToInvitation({ sessionId, response: 'joined' }));
    }

    let view = ok(await max.getSession({ sessionId }));
    const ticketId = currentTicketId(view);
    const three = cardId(view, '3');
    // Someone sets Story points in Jira after the import.
    backend.jira.setField(ISSUES.pp3.id, STORY_POINTS, 13);

    for (const caller of [ola, sam, mia]) {
      ok(await caller.submitVote({ sessionId, ticketId, cardId: three }));
    }

    view = ok(await max.getSession({ sessionId }));
    expect(ticketOf(view, ticketId).sync).toMatchObject({ state: 'conflict' });
    expect(backend.jira.issues.get(ISSUES.pp3.id)?.fields[STORY_POINTS]).toBe(13);
    expect(backend.jira.calls.some((call) => call.method === 'PUT')).toBe(false);

    ok(await max.retrySync({ sessionId, ticketId, confirmOverwrite: true }));
    view = ok(await max.getSession({ sessionId }));
    expect(ticketOf(view, ticketId).sync.state).toBe('succeeded');
    expect(backend.jira.issues.get(ISSUES.pp3.id)?.fields[STORY_POINTS]).toBe(3);
  });

  it('records a failed write when the voter who completed the round cannot edit the issue', async () => {
    // Automatic finalization writes as the person whose vote completed the round. Ola may vote
    // but cannot edit PP-1 in Jira, so the write fails visibly and the moderator retries it as
    // themselves (open decision in docs/PRODUCT_RULES.md).
    const world = await createWorld();
    const { max, mia, sam, ola, backend } = world;
    const sessionId = await draftSession(world, { autoFinalize: true, keys: [ISSUES.pp1.key] });
    ok(await max.publishSession({ sessionId }));

    for (const caller of [mia, sam, ola]) {
      ok(await caller.respondToInvitation({ sessionId, response: 'joined' }));
    }

    let view = ok(await max.getSession({ sessionId }));
    const ticketId = currentTicketId(view);

    for (const caller of [mia, sam, ola]) {
      ok(await caller.submitVote({ sessionId, ticketId, cardId: cardId(view, '2') }));
    }

    view = ok(await max.getSession({ sessionId }));
    expect(ticketOf(view, ticketId).sync).toMatchObject({
      state: 'failed',
      message: "You don't have permission to edit PP-1 in Jira.",
    });
    expect(backend.jira.calls.some((call) => call.method === 'PUT')).toBe(false);

    ok(await max.retrySync({ sessionId, ticketId, confirmOverwrite: false }));
    view = ok(await max.getSession({ sessionId }));
    expect(ticketOf(view, ticketId).sync.state).toBe('succeeded');
    expect(backend.jira.issues.get(ISSUES.pp1.id)?.fields[STORY_POINTS]).toBe(2);
  });

  it('notifies through realtime events that carry no votes, and signs tokens only for viewers', async () => {
    const world = await createWorld();
    const sessionId = await draftSession(world);
    ok(await world.max.publishSession({ sessionId }));
    ok(await world.mia.respondToInvitation({ sessionId, response: 'joined' }));

    const token = ok(await world.mia.getRealtimeToken({ sessionId }));
    expect(token).toMatchObject({ channel: `planning-poker-session-${sessionId}` });
    expect(token.token).toEqual(expect.any(String));
    expect(await world.out.getRealtimeToken({ sessionId })).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(world.backend.tokens.issued).toEqual([{ tenantId: 'site-1', sessionId }]);
  });
});
