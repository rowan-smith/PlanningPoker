/**
 * Concurrency under production semantics: the Forge repositories with ForgeAtomicOperation (no
 * lock, optimistic versions, retry on conflict) over a store that interleaves the storage calls
 * of concurrent requests at random points, for many seeds. Each scenario checks invariants that
 * must hold whatever the interleaving.
 */
import { describe, expect, it } from 'vitest';

import type { ResolverResult } from '@planning-poker/contracts';
import type { Session } from '@planning-poker/domain';

import { STORY_POINTS } from '../support/fake-jira';
import { ok, userId } from '../support/forge-backend';
import type { World } from '../support/world';
import {
  cardId,
  createWorld,
  currentTicketId,
  ISSUES,
  liveSession,
  MIA,
  OLA,
  OUT,
  SAM,
} from '../support/world';

const SEEDS = Array.from({ length: 25 }, (_, index) => index + 1);

function codeOf(result: ResolverResult<unknown>): string {
  return result.ok ? 'ok' : result.error.code;
}

/** The stored session record, read straight from storage. */
function storedSession(world: World, sessionId: string): Session {
  const record = world.backend.memory.records.get(`session/${sessionId}`) as
    { data: Session } | undefined;

  if (record === undefined) {
    throw new Error('missing session');
  }

  return record.data;
}

/** Stored vote records for a round, as `userId → cardId`. */
function storedVotes(world: World, roundId: string): Map<string, string> {
  const votes = new Map<string, string>();

  for (const [key, value] of world.backend.memory.records) {
    const vote = value as { roundId?: string; userId?: string; cardId?: string };

    if (key.startsWith('vote/') && vote.roundId === roundId) {
      votes.set(vote.userId ?? '', vote.cardId ?? '');
    }
  }

  return votes;
}

function auditCount(world: World, type: string): number {
  return [...world.backend.memory.records]
    .filter(([key]) => key.startsWith('auditevent/'))
    .filter(([, value]) => (value as { type?: string }).type === type).length;
}

function latestRound(session: Session, ticketId: string) {
  const ticket = session.tickets.find((candidate) => candidate.id === ticketId);

  return ticket?.rounds.at(-1);
}

/** The anonymous distribution a revealed round recorded, as `cardId → count`. */
function recordedCounts(session: Session, ticketId: string): Map<string, number> {
  const result = latestRound(session, ticketId)?.result;
  const counts = new Map<string, number>();

  for (const entry of result?.distribution ?? []) {
    counts.set(entry.cardId, entry.count);
  }

  return counts;
}

/** Counts of the stored votes of the round's frozen roster, minus voters skipped for it. */
function countedFromStore(
  world: World,
  session: Session,
  ticketId: string,
  skipped: readonly string[] = [],
): Map<string, number> {
  const round = latestRound(session, ticketId);
  const votes = storedVotes(world, round?.id ?? '');
  const counts = new Map<string, number>();
  const required = (round?.roster?.snapshotVoterIds ?? []).filter((id) => !skipped.includes(id));

  for (const voter of required) {
    const card = votes.get(voter);

    if (card !== undefined) {
      counts.set(card, (counts.get(card) ?? 0) + 1);
    }
  }

  return counts;
}

async function room(seed: number, options: { autoFinalize?: boolean } = {}) {
  const world = await createWorld({ interleaveSeed: seed });
  const sessionId = await liveSession(world, {
    keys: [ISSUES.pp1.key, ISSUES.pp2.key],
    ...options,
  });
  const view = ok(await world.max.getSession({ sessionId }));

  return { world, sessionId, view, ticketId: currentTicketId(view) };
}

function interleaving(world: World) {
  const store = world.backend.interleaving;

  if (store === null) {
    throw new Error('interleaving store expected');
  }

  return store;
}

describe('races reproduced in a forced order', () => {
  it('a vote changed while another vote reveals the round is counted, not lost', async () => {
    const { world, sessionId, view, ticketId } = await room(1);
    const store = interleaving(world);
    const changed = cardId(view, '13');
    ok(await world.mia.submitVote({ sessionId, ticketId, cardId: cardId(view, '1') }));
    ok(await world.sam.submitVote({ sessionId, ticketId, cardId: cardId(view, '5') }));

    // Ola's final vote has read every vote (Mia's old one included) and is about to save the reveal.
    const olaSave = store.hold(['replace', 'transact'], 'session');
    const ola = world.ola.submitVote({ sessionId, ticketId, cardId: cardId(view, '8') });
    await olaSave.reached;
    // Meanwhile Mia changes her vote and gets as far as saving her own reveal.
    const miaSave = store.hold(['replace', 'transact'], 'session');
    const mia = world.mia.submitVote({ sessionId, ticketId, cardId: changed });
    await miaSave.reached;
    olaSave.release();
    expect(codeOf(await ola)).toBe('ok');
    miaSave.release();
    expect(codeOf(await mia)).toBe('ok');

    const session = storedSession(world, sessionId);
    expect(recordedCounts(session, ticketId)).toEqual(countedFromStore(world, session, ticketId));
    expect(recordedCounts(session, ticketId).get(changed)).toBe(1);
  });

  it('a stale roster-index rewrite finishing last does not hide a newer invitation', async () => {
    const { world, sessionId } = await room(1);
    const store = interleaving(world);
    // A role change saves the session, then pauses before rewriting the roster index.
    const indexWrite = store.hold(['query'], 'sessionmember');
    const change = world.max.changeRoomRole({ sessionId, userId: userId(SAM), role: 'observer' });
    await indexWrite.reached;
    // A later invitation saves and indexes completely.
    ok(await world.max.inviteToRoom({ sessionId, userId: userId(OUT), role: 'voter' }));
    // The older rewrite now finishes last.
    indexWrite.release();
    ok(await change);

    const home = ok(await world.backend.as(OUT).getHome());
    expect(home.pendingInvitations.map((invitation) => invitation.sessionId)).toEqual([sessionId]);
  });
});

describe('concurrency under Forge semantics (no lock, conditional writes)', () => {
  it.each(SEEDS)(
    'simultaneous final votes reveal exactly once and lose no vote (seed %i)',
    async (seed) => {
      const { world, sessionId, view, ticketId } = await room(seed);
      const picks = [
        [world.mia, cardId(view, '3')],
        [world.sam, cardId(view, '5')],
        [world.ola, cardId(view, '8')],
      ] as const;

      const results = await Promise.all(
        picks.map(
          async ([caller, card]) => await caller.submitVote({ sessionId, ticketId, cardId: card }),
        ),
      );

      expect(results.map(codeOf)).toEqual(['ok', 'ok', 'ok']);
      const session = storedSession(world, sessionId);
      expect(latestRound(session, ticketId)?.status).toBe('revealed');
      expect(latestRound(session, ticketId)?.result?.voteCount).toBe(3);
      expect(auditCount(world, 'round.revealed')).toBe(1);
      expect(
        world.backend.events.published.filter(({ event }) => event.type === 'round.revealed'),
      ).toHaveLength(1);
      expect(recordedCounts(session, ticketId)).toEqual(countedFromStore(world, session, ticketId));
    },
  );

  it.each(SEEDS)(
    'a vote changed while the round reveals is either counted or refused (seed %i)',
    async (seed) => {
      const { world, sessionId, view, ticketId } = await room(seed);
      const first = cardId(view, '1');
      const changed = cardId(view, '13');
      ok(await world.mia.submitVote({ sessionId, ticketId, cardId: first }));
      ok(await world.sam.submitVote({ sessionId, ticketId, cardId: cardId(view, '5') }));

      const [change, last] = await Promise.all([
        world.mia.submitVote({ sessionId, ticketId, cardId: changed }),
        world.ola.submitVote({ sessionId, ticketId, cardId: cardId(view, '8') }),
      ]);

      expect(codeOf(last)).toBe('ok');
      expect(['ok', 'INVALID_STATE']).toContain(codeOf(change));
      const session = storedSession(world, sessionId);
      const counts = recordedCounts(session, ticketId);
      // What was revealed is exactly what is stored, and Mia's answer tells her which it was.
      expect(counts).toEqual(countedFromStore(world, session, ticketId));
      expect(counts.get(change.ok ? changed : first)).toBe(1);
      expect(auditCount(world, 'round.revealed')).toBe(1);
    },
  );

  it.each(SEEDS)(
    'voting while the moderator skips or restores the voter stays consistent (seed %i)',
    async (seed) => {
      const { world, sessionId, view, ticketId } = await room(seed);
      ok(await world.mia.submitVote({ sessionId, ticketId, cardId: cardId(view, '3') }));
      ok(await world.ola.submitVote({ sessionId, ticketId, cardId: cardId(view, '3') }));

      const [vote, skip] = await Promise.all([
        world.sam.submitVote({ sessionId, ticketId, cardId: cardId(view, '5') }),
        world.max.skipParticipant({ sessionId, userId: userId(SAM), scope: 'ticket' }),
      ]);

      // A per-ticket skip needs an open round (assumption 27): it fails if Sam's vote revealed first.
      expect(['ok', 'INVALID_STATE']).toContain(codeOf(skip));
      expect(['ok', 'NOT_ELIGIBLE', 'INVALID_STATE']).toContain(codeOf(vote));
      let session = storedSession(world, sessionId);
      const round = latestRound(session, ticketId);
      expect(round?.status).toBe('revealed');
      expect(auditCount(world, 'round.revealed')).toBe(1);
      // Sam's vote counts only if it completed the round before the skip; a vote that landed just
      // before the skip stops counting (it may still have been accepted).
      const voteCount = round?.result?.voteCount;
      expect([2, 3]).toContain(voteCount);
      expect(recordedCounts(session, ticketId)).toEqual(
        countedFromStore(world, session, ticketId, voteCount === 2 ? [userId(SAM)] : []),
      );

      if (voteCount === 3) {
        expect(vote.ok).toBe(true);
      } else {
        expect(skip.ok).toBe(true);
      }

      // Restore racing a new round's vote: never INTERNAL, never two rounds open.
      ok(await world.max.startNewRound({ sessionId, ticketId }));
      const [restore, again] = await Promise.all([
        world.max.restoreParticipant({ sessionId, userId: userId(SAM) }),
        world.mia.submitVote({ sessionId, ticketId, cardId: cardId(view, '8') }),
      ]);
      expect(codeOf(again)).toBe('ok');
      expect(['ok', 'INVALID_STATE']).toContain(codeOf(restore));
      session = storedSession(world, sessionId);
      const ticket = session.tickets.find((candidate) => candidate.id === ticketId);
      expect(
        ticket?.rounds.filter((candidate) => candidate.status === 'open').length,
      ).toBeLessThanOrEqual(1);
    },
  );

  it.each(SEEDS)(
    'concurrent finalization records one decision and writes Jira once (seed %i)',
    async (seed) => {
      const { world, sessionId, view, ticketId } = await room(seed);

      for (const caller of [world.mia, world.sam, world.ola]) {
        ok(await caller.submitVote({ sessionId, ticketId, cardId: cardId(view, '5') }));
      }

      const results = await Promise.all([
        world.max.acceptConsensus({ sessionId, ticketId }),
        world.ada.acceptConsensus({ sessionId, ticketId }),
        world.max.overrideEstimate({
          sessionId,
          ticketId,
          cardId: cardId(view, '8'),
          reason: 'Bigger',
        }),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      // The losers see the domain's "already has a final estimate" (CONFLICT) or a state error.
      for (const result of results.filter((candidate) => !candidate.ok)) {
        expect(['CONFLICT', 'INVALID_STATE']).toContain(codeOf(result));
      }

      const puts = world.backend.jira.calls.filter((call) => call.method === 'PUT');
      expect(puts).toHaveLength(1);
      expect(
        auditCount(world, 'estimate.finalized') + auditCount(world, 'estimate.overridden'),
      ).toBe(1);
      const ticket = storedSession(world, sessionId).tickets.find(
        (candidate) => candidate.id === ticketId,
      );
      expect(ticket?.externalUpdate.state).toBe('succeeded');
    },
  );

  it.each(SEEDS)(
    'duplicate sync claims make exactly one Jira write per decision (seed %i)',
    async (seed) => {
      const { world, sessionId, view, ticketId } = await room(seed);
      world.backend.jira.putFailures.push(503);

      for (const caller of [world.mia, world.sam, world.ola]) {
        ok(await caller.submitVote({ sessionId, ticketId, cardId: cardId(view, '5') }));
      }

      ok(await world.max.acceptConsensus({ sessionId, ticketId }));
      expect(storedSession(world, sessionId).tickets[0]?.externalUpdate.state).toBe('failed');

      const retries = await Promise.all([
        world.max.retrySync({ sessionId, ticketId, confirmOverwrite: false }),
        world.max.retrySync({ sessionId, ticketId, confirmOverwrite: false }),
        world.ada.retrySync({ sessionId, ticketId, confirmOverwrite: false }),
      ]);

      expect(retries.filter((result) => result.ok).length).toBeGreaterThanOrEqual(1);
      for (const result of retries.filter((candidate) => !candidate.ok)) {
        expect(['CONFLICT', 'INVALID_STATE']).toContain(codeOf(result));
      }

      // One failed write, then exactly one successful retry.
      const puts = world.backend.jira.calls.filter((call) => call.method === 'PUT');
      expect(puts).toHaveLength(2);
      expect(world.backend.jira.issues.get(ISSUES.pp1.id)?.fields[STORY_POINTS]).toBe(5);
      expect(storedSession(world, sessionId).tickets[0]?.externalUpdate.state).toBe('succeeded');
    },
  );

  it.each(SEEDS)('concurrent team edits lose no update (seed %i)', async (seed) => {
    const world = await createWorld({ interleaveSeed: seed });
    const additions = [OLA, OUT, 'lee-observer'].map(
      async (account) =>
        await world.max.addTeamMember({ teamId: world.teamId, userId: userId(account) }),
    );
    const [rename, ...added] = await Promise.all([
      world.ada.updateTeam({ teamId: world.teamId, name: 'Platform Core', description: 'Renamed' }),
      ...additions,
      world.max.removeTeamMember({ teamId: world.teamId, userId: userId(MIA) }),
    ]);

    expect([rename, ...added].map(codeOf)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    const team = ok(await world.ada.getTeam({ teamId: world.teamId }));
    expect(team.name).toBe('Platform Core');
    expect(team.members.map((member) => member.userId).sort()).toEqual(
      ['lee-observer', 'max-moderator', OLA, OUT, SAM].map(userId).sort(),
    );
  });

  it.each(SEEDS)('concurrent invitations all reach their invitees (seed %i)', async (seed) => {
    const { world, sessionId } = await room(seed);
    const outsider = world.backend.as(OUT);
    const results = await Promise.all([
      world.max.inviteToRoom({ sessionId, userId: userId(OUT), role: 'voter' }),
      world.ada.inviteToRoom({ sessionId, userId: userId('eve-other-site'), role: 'observer' }),
      world.max.revokeRoomInvitation({ sessionId, userId: userId(OLA) }),
      world.max.changeRoomRole({ sessionId, userId: userId(SAM), role: 'observer' }),
    ]);

    expect(results.map(codeOf)).toEqual(['ok', 'ok', 'ok', 'ok']);
    // The roster index converged on the final roster, so the invitation is listed.
    const home = ok(await outsider.getHome());
    expect(home.pendingInvitations.map((invitation) => invitation.sessionId)).toEqual([sessionId]);
    const view = ok(await world.max.getSession({ sessionId }));
    expect(view.participants.find((p) => p.userId === userId(OLA))?.invitationStatus).toBe(
      'revoked',
    );
    expect(view.participants.find((p) => p.userId === userId(SAM))?.role).toBe('observer');
  });
});
