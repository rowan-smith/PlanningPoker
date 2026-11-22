/**
 * Completed-session summary and statistics (Milestone 8). The scenario is driven through the
 * real services; the assertions exercise the pure domain functions on the stored aggregate.
 */
import { describe, expect, it } from 'vitest';

import type { SessionTotals, UserId } from '@planning-poker/domain';
import {
  combineTotals,
  disagreementHistory,
  overrideHistory,
  participantCategories,
  participantStatistics,
  sessionDate,
  summarizeSession,
} from '@planning-poker/domain';

import { completedScenario } from './report-support';

const sorted = (ids: readonly UserId[]): string[] => [...ids].sort();

describe('participant categories', () => {
  it('distinguishes invited, joined, voting, observing and skipped participants', async () => {
    const s = await completedScenario();
    const [v1, v2, v3, v4] = s.voters;
    const categories = participantCategories(await s.stored());

    expect(sorted(categories.invited)).toEqual(
      sorted([v1, v2, v3, v4, s.observer, s.decliner, s.absent].map((p) => p.userId)),
    );
    expect(sorted(categories.joined)).toEqual(
      sorted([v1, v2, v3, v4, s.observer].map((p) => p.userId)),
    );
    expect(categories.declined).toEqual([s.decliner.userId]);
    expect(categories.noResponse).toEqual([s.absent.userId]);
    expect(categories.revoked).toEqual([]);
    // v4 was skipped for one ticket but voted on another, so still counts as voting.
    expect(sorted(categories.voting)).toEqual(sorted([v1, v2, v3, v4].map((p) => p.userId)));
    expect(sorted(categories.observing)).toEqual(sorted([s.h.moderator.userId, s.observer.userId]));
    expect(sorted(categories.skipped)).toEqual(sorted([v4.userId, s.absent.userId]));
    expect(categories.facilitators).toEqual([s.h.moderator.userId]);
  });

  it('never counts invitees who declined or never answered as voting or observing', async () => {
    const s = await completedScenario();
    const categories = participantCategories(await s.stored());

    for (const person of [s.decliner, s.absent]) {
      expect(categories.voting).not.toContain(person.userId);
      expect(categories.observing).not.toContain(person.userId);
    }
  });
});

describe('session summary', () => {
  it('records ticket outcomes, decisions, revotes, disagreements and skipped voters', async () => {
    const s = await completedScenario();
    const summary = summarizeSession(await s.stored());
    const [first, second, third, fourth] = summary.tickets;

    expect(summary.status).toBe('completed');
    expect(summary.moderatorId).toBe(s.h.moderator.userId);
    expect(summary.startedAt).not.toBeNull();
    expect(summary.completedAt).not.toBeNull();

    expect(first).toMatchObject({
      outcome: 'estimated',
      unanimous: true,
      revotes: 0,
      disagreements: 0,
      decision: { kind: 'consensus', label: '3', reason: null },
      skippedVoters: [s.voters[3].userId],
    });
    expect(first?.revealedRounds).toEqual([
      expect.objectContaining({
        outcome: 'unanimous',
        voteCount: 3,
        distribution: [expect.objectContaining({ label: '3', count: 3 })],
      }),
    ]);

    expect(second).toMatchObject({
      outcome: 'estimated',
      unanimous: false,
      revotes: 1,
      disagreements: 2,
      decision: { kind: 'override', label: '5', reason: 'The 8 assumed work already done.' },
      skippedVoters: [s.absent.userId],
    });
    expect(second?.revealedRounds.map((round) => round.distribution)).toEqual([
      [
        expect.objectContaining({ label: '3', count: 1 }),
        expect.objectContaining({ label: '5', count: 2 }),
        expect.objectContaining({ label: '8', count: 1 }),
      ],
      [
        expect.objectContaining({ label: '5', count: 3 }),
        expect.objectContaining({ label: '8', count: 1 }),
      ],
    ]);

    expect(third).toMatchObject({ outcome: 'skipped', revealedRounds: [], decision: null });
    expect(fourth).toMatchObject({ outcome: 'unresolved', revealedRounds: [], decision: null });
  });

  it('totals the session', async () => {
    const summary = summarizeSession(await (await completedScenario()).stored());

    expect(summary.totals).toEqual({
      tickets: 4,
      estimated: 2,
      skipped: 1,
      unresolved: 1,
      inProgress: 0,
      unanimous: 1,
      disagreements: 2,
      revotes: 1,
      overrides: 1,
      sync: { 'not-required': 4, pending: 0, syncing: 0, succeeded: 0, failed: 0, conflict: 0 },
    } satisfies SessionTotals);
  });

  it('files sessions under their completion date', async () => {
    const session = await (await completedScenario()).stored();

    expect(sessionDate(session)).toEqual(session.completedAt);
    expect(sessionDate({ ...session, completedAt: null })).toEqual(session.publishedAt);
    expect(sessionDate({ ...session, completedAt: null, publishedAt: null })).toEqual(
      session.createdAt,
    );
  });
});

describe('statistics across sessions', () => {
  it('counts participation per person without any vote values', async () => {
    const s = await completedScenario();
    const session = await s.stored();
    const statistics = participantStatistics([session, session]);
    const v4 = statistics.find((entry) => entry.userId === s.voters[3].userId);
    const absent = statistics.find((entry) => entry.userId === s.absent.userId);
    const moderator = statistics.find((entry) => entry.userId === s.h.moderator.userId);

    expect(v4).toEqual({
      userId: s.voters[3].userId,
      sessionsInvited: 2,
      sessionsJoined: 2,
      sessionsDeclined: 0,
      sessionsVoted: 2,
      sessionsObserved: 0,
      sessionsFacilitated: 0,
      timesSkipped: 2,
      // Two revealed rounds on ticket 2 per session; ticket 1 was skipped for them.
      roundsVoted: 4,
    });
    expect(absent).toMatchObject({ sessionsVoted: 0, timesSkipped: 2, roundsVoted: 0 });
    expect(moderator).toMatchObject({ sessionsFacilitated: 2, sessionsObserved: 2 });
    expect(Object.keys(v4 ?? {})).not.toContain('cardId');
  });

  it('lists disagreements and overrides', async () => {
    const s = await completedScenario();
    const summary = summarizeSession(await s.stored());

    expect(disagreementHistory([summary])).toEqual([
      expect.objectContaining({
        ticketId: s.tickets.overridden,
        disagreements: 2,
        revotes: 1,
        outcome: 'estimated',
        finalLabel: '5',
        decisionKind: 'override',
      }),
    ]);
    expect(overrideHistory([summary])).toEqual([
      expect.objectContaining({
        ticketId: s.tickets.overridden,
        label: '5',
        reason: 'The 8 assumed work already done.',
        decidedBy: s.h.moderator.userId,
      }),
    ]);
  });

  it('combines totals', async () => {
    const { totals } = summarizeSession(await (await completedScenario()).stored());
    const combined = combineTotals([totals, totals]);

    expect(combined.tickets).toBe(8);
    expect(combined.overrides).toBe(2);
    expect(combined.sync['not-required']).toBe(8);
    expect(combineTotals([])).toMatchObject({ tickets: 0, disagreements: 0 });
  });
});
