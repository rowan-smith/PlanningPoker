/**
 * Milestone 8 acceptance: completed sessions accurately distinguish invited, joined, observing,
 * voting and skipped participants, and produce a permanent, anonymous summary.
 */
import { describe, expect, it } from 'vitest';

import { completedScenario } from './report-support';

describe('Milestone 8 — completed session summary', () => {
  it('distinguishes invited, joined, observing, voting and skipped participants', async () => {
    const s = await completedScenario();
    const summary = await s.reports.getSessionSummary(s.h.moderator, s.h.sessionId);
    const names = (list: readonly { readonly displayName: string }[]) =>
      list.map((entry) => entry.displayName);

    expect(summary.status).toBe('completed');
    expect(names(summary.participants.invited)).toEqual([
      'absent',
      'decliner',
      'observer-1',
      'voter-1',
      'voter-2',
      'voter-3',
      'voter-4',
    ]);
    expect(names(summary.participants.joined)).toEqual([
      'observer-1',
      'voter-1',
      'voter-2',
      'voter-3',
      'voter-4',
    ]);
    expect(names(summary.participants.voting)).toEqual([
      'voter-1',
      'voter-2',
      'voter-3',
      'voter-4',
    ]);
    expect(names(summary.participants.observing)).toEqual(['moderator', 'observer-1']);
    expect(names(summary.participants.skipped)).toEqual(['absent', 'voter-4']);
    expect(names(summary.participants.declined)).toEqual(['decliner']);
    expect(names(summary.participants.noResponse)).toEqual(['absent']);
  });

  it('keeps outcomes, decisions, revotes, overrides and anonymous distributions', async () => {
    const s = await completedScenario();
    const summary = await s.reports.getSessionSummary(s.voters[0], s.h.sessionId);

    expect(summary.tickets.map((ticket) => ticket.outcome)).toEqual([
      'estimated',
      'estimated',
      'skipped',
      'unresolved',
    ]);
    expect(summary.tickets[1]).toMatchObject({
      revotes: 1,
      disagreements: 2,
      decision: { kind: 'override', label: '5', decidedByName: 'moderator' },
    });
    expect(summary.tickets[0]?.skippedVoters.map((p) => p.displayName)).toEqual(['voter-4']);
    expect(summary.tickets[0]?.revealedRounds[0]?.distribution).toEqual([
      expect.objectContaining({ label: '3', count: 3 }),
    ]);
    expect(summary.totals).toMatchObject({
      tickets: 4,
      estimated: 2,
      skipped: 1,
      unresolved: 1,
      unanimous: 1,
      overrides: 1,
    });
  });

  it('is permanent: later sessions do not change it', async () => {
    const s = await completedScenario();
    const before = await s.reports.getSessionSummary(s.h.moderator, s.h.sessionId);
    await s.h.service.createDraft(s.h.moderator, {
      name: 'Later',
      teamId: (await s.stored()).teamId,
    });

    expect(await s.reports.getSessionSummary(s.h.moderator, s.h.sessionId)).toEqual(before);
  });
});
