/**
 * Milestone 6 acceptance: observers never block reveal, skipped voters are excluded correctly,
 * and roster changes during an active round follow the frozen-roster rules. Also pins that the
 * facilitator controls are moderator-only and audited.
 */
import { describe, expect, it } from 'vitest';

import type { TicketId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import type { Harness } from './support';
import { publishedSession } from './support';

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index];

  if (item === undefined) {
    throw new Error(`setup: no item ${String(index)}`);
  }

  return item;
}

async function currentId(h: Harness): Promise<TicketId> {
  return asId<TicketId>((await h.currentTicket()).id);
}

describe('Milestone 6 — observers never block reveal', () => {
  it('reveals when every voter voted, however many observers are watching', async () => {
    const h = await publishedSession({ voters: 2, observers: 3 });

    expect((await h.currentTicket()).round?.requiredCount).toBe(2);
    await h.vote(pick(h.voters, 0), '3');
    await h.vote(pick(h.voters, 1), '5');

    expect((await h.currentTicket()).votingState).toBe('revealed');
  });

  it('unblocks an open round when a voter who has not voted becomes an observer', async () => {
    const h = await publishedSession({ voters: 3 });
    const late = pick(h.voters, 2);
    await h.vote(pick(h.voters, 0), '5');
    await h.vote(pick(h.voters, 1), '5');

    await h.service.changeParticipantRole(h.moderator, h.sessionId, late.userId, 'observer');
    const ticket = await h.currentTicket();

    expect(ticket.votingState).toBe('revealed');
    expect(ticket.round?.result).toMatchObject({ voteCount: 2, values: ['5', '5'] });
    expect((await h.view(late)).viewer).toMatchObject({
      role: 'observer',
      canVoteOnCurrentTicket: false,
      canPreVote: false,
    });
  });

  it('does not count observers invited mid-round, and refuses their votes', async () => {
    const h = await publishedSession({ voters: 1 });
    const watcher = h.addUser('watcher');
    await h.service.inviteParticipant(h.moderator, h.sessionId, watcher.userId, 'observer');
    await h.service.respondToInvitation(watcher, h.sessionId, 'joined');

    await expect(h.vote(watcher, '5')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    await h.vote(pick(h.voters, 0), '5');
    expect((await h.currentTicket()).votingState).toBe('revealed');
  });
});

describe('Milestone 6 — skipped voters are excluded correctly', () => {
  it('skips for this ticket only: the voter is required again on the next ticket', async () => {
    const h = await publishedSession({ voters: 3, tickets: 2 });
    const absent = pick(h.voters, 2);

    await h.service.skipParticipant(h.moderator, h.sessionId, absent.userId, 'ticket');
    expect((await h.currentTicket()).round?.requiredCount).toBe(2);
    const skippedRow = (await h.view(h.moderator)).participants.find(
      (p) => p.userId === absent.userId,
    );
    expect(skippedRow).toMatchObject({ skippedForCurrentTicket: true, skippedForSession: false });

    await h.vote(pick(h.voters, 0), '5');
    await h.vote(pick(h.voters, 1), '8');
    expect((await h.currentTicket()).round?.result?.voteCount).toBe(2);

    await h.service.advance(h.moderator, h.sessionId);
    expect((await h.currentTicket()).round).toMatchObject({ status: 'open', requiredCount: 3 });
    expect((await h.view(absent)).viewer.canVoteOnCurrentTicket).toBe(true);
  });

  it('skips for the rest of the session until restored, and keeps session access', async () => {
    const h = await publishedSession({ voters: 3, tickets: 3 });
    const away = pick(h.voters, 2);

    await h.service.skipParticipant(h.moderator, h.sessionId, away.userId, 'session');
    await h.service.advance(h.moderator, h.sessionId);
    expect((await h.currentTicket()).round?.requiredCount).toBe(2);
    expect((await h.view(away)).viewer).toMatchObject({
      canVoteOnCurrentTicket: false,
      canPreVote: false,
    });

    // Restoring during an open round makes them required again in that round.
    await h.service.restoreParticipant(h.moderator, h.sessionId, away.userId);
    expect((await h.currentTicket()).round?.requiredCount).toBe(3);
    await h.service.advance(h.moderator, h.sessionId);
    expect((await h.currentTicket()).round?.requiredCount).toBe(3);
  });

  it('drops a skipped vote from the result and makes a restored voter vote again', async () => {
    const h = await publishedSession({ voters: 3 });
    const [a, b, c] = [pick(h.voters, 0), pick(h.voters, 1), pick(h.voters, 2)];

    await h.vote(c, '13');
    await h.service.skipParticipant(h.moderator, h.sessionId, c.userId, 'ticket');
    await h.service.restoreParticipant(h.moderator, h.sessionId, c.userId);
    expect((await h.currentTicket(c)).myVoteCardId).toBeNull();

    await h.vote(a, '5');
    await h.vote(b, '5');
    expect((await h.currentTicket()).votingState).toBe('voting');
    await h.vote(c, '5');
    expect((await h.currentTicket()).round?.result?.values).toEqual(['5', '5', '5']);
  });

  it('audits whether a restore discarded a vote (regression: it said so even with no vote)', async () => {
    const h = await publishedSession({ voters: 3 });
    const [voted, silent] = [pick(h.voters, 0), pick(h.voters, 1)];

    await h.vote(voted, '8');
    await h.service.skipParticipant(h.moderator, h.sessionId, voted.userId, 'ticket');
    await h.service.restoreParticipant(h.moderator, h.sessionId, voted.userId);
    await h.service.skipParticipant(h.moderator, h.sessionId, silent.userId, 'ticket');
    await h.service.restoreParticipant(h.moderator, h.sessionId, silent.userId);

    const restores = h.app.audit.events.filter((event) => event.type === 'participant.restored');
    expect(restores.map((event) => [event.subjectUserId, event.details])).toEqual([
      [voted.userId, { voteDiscarded: true }],
      [silent.userId, { voteDiscarded: false }],
    ]);
    expect(JSON.stringify(h.app.audit.events)).not.toContain(h.card('8'));
  });

  it('refuses to skip observers or to skip someone twice', async () => {
    const h = await publishedSession({ voters: 2, observers: 1 });
    const voter = pick(h.voters, 0);

    await expect(
      h.service.skipParticipant(h.moderator, h.sessionId, pick(h.observers, 0).userId, 'ticket'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await h.service.skipParticipant(h.moderator, h.sessionId, voter.userId, 'ticket');
    await expect(
      h.service.skipParticipant(h.moderator, h.sessionId, voter.userId, 'ticket'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('Milestone 6 — roster changes during an active round', () => {
  it('lets a new voter join only from the next round, or when the moderator restarts it', async () => {
    const h = await publishedSession({ voters: 2, tickets: 2 });
    const late = h.addUser('late-voter');
    await h.service.inviteParticipant(h.moderator, h.sessionId, late.userId, 'voter');
    await h.service.respondToInvitation(late, h.sessionId, 'joined');

    expect((await h.currentTicket()).round?.requiredCount).toBe(2);
    await expect(h.vote(late, '5')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });

    await h.vote(pick(h.voters, 0), '5');
    await h.service.startNewRound(h.moderator, h.sessionId, await currentId(h));
    const restarted = await h.currentTicket();

    expect(restarted.round).toMatchObject({ number: 2, requiredCount: 3, votedCount: 0 });
    await h.vote(late, '5');
    expect((await h.currentTicket()).round?.votedCount).toBe(1);
  });

  it('keeps an observer made voter mid-round out of that round', async () => {
    const h = await publishedSession({ voters: 1, observers: 1 });
    const promoted = pick(h.observers, 0);

    await h.service.changeParticipantRole(h.moderator, h.sessionId, promoted.userId, 'voter');
    expect((await h.currentTicket()).round?.requiredCount).toBe(1);
    await expect(h.vote(promoted, '5')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });

    await h.vote(pick(h.voters, 0), '3');
    expect((await h.currentTicket()).votingState).toBe('revealed');
    await h.service.startNewRound(h.moderator, h.sessionId, await currentId(h));
    expect((await h.currentTicket()).round?.requiredCount).toBe(2);
  });

  it('removes a revoked voter from the open round so it can reveal', async () => {
    const h = await publishedSession({ voters: 2 });
    await h.vote(pick(h.voters, 0), '5');

    await h.service.revokeInvitation(h.moderator, h.sessionId, pick(h.voters, 1).userId);
    const view = await h.view(h.moderator);

    expect(view.tickets.find((t) => t.id === view.currentTicketId)?.votingState).toBe('revealed');
    expect(view.participants.find((p) => p.userId === pick(h.voters, 1).userId)).toMatchObject({
      invitationStatus: 'revoked',
    });
  });
});

describe('Milestone 6 — outcomes, progression and lifecycle', () => {
  it('accepts consensus, overrides with a reason, skips a ticket and moves to a chosen one', async () => {
    const h = await publishedSession({ voters: 2, tickets: 3 });
    const [first, second, third] = [
      pick(h.ticketIds, 0),
      pick(h.ticketIds, 1),
      pick(h.ticketIds, 2),
    ];

    await h.vote(pick(h.voters, 0), '5');
    await h.vote(pick(h.voters, 1), '5');
    await h.service.acceptConsensus(h.moderator, h.sessionId, first);
    expect((await h.currentTicket()).estimate).toMatchObject({ label: '5', kind: 'consensus' });

    await h.service.setCurrentTicket(h.moderator, h.sessionId, third);
    await h.vote(pick(h.voters, 0), '3');
    await h.vote(pick(h.voters, 1), '8');
    await expect(
      h.service.overrideEstimate(h.moderator, h.sessionId, third, h.card('5'), '   '),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      h.service.overrideEstimate(h.moderator, h.sessionId, third, h.card('?'), 'Unknown'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await h.service.overrideEstimate(h.moderator, h.sessionId, third, h.card('5'), ' Agreed ');
    expect((await h.currentTicket()).estimate).toEqual({
      label: '5',
      kind: 'override',
      reason: 'Agreed',
    });

    await h.service.skipTicket(h.moderator, h.sessionId, second);
    const view = await h.view(h.moderator);
    expect(view.tickets.map((t) => t.votingState)).toEqual(['finalized', 'skipped', 'finalized']);
  });

  it('pauses voting and reveals a round completed while paused once resumed', async () => {
    const h = await publishedSession({ voters: 2 });
    await h.vote(pick(h.voters, 0), '5');
    await h.service.pause(h.moderator, h.sessionId);

    await expect(h.vote(pick(h.voters, 1), '5')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await h.service.skipParticipant(h.moderator, h.sessionId, pick(h.voters, 1).userId, 'ticket');
    expect((await h.currentTicket()).votingState).toBe('voting');

    await h.service.resume(h.moderator, h.sessionId);
    expect((await h.currentTicket()).votingState).toBe('revealed');

    await h.service.complete(h.moderator, h.sessionId);
    const view = await h.view(h.moderator);
    expect(view.status).toBe('completed');
    expect(view.tickets.map((t) => t.votingState)).toEqual(['unresolved', 'unresolved']);
  });

  it('audits every moderator change to requirements, estimates and outcomes', async () => {
    const h = await publishedSession({ voters: 2, tickets: 2 });
    const [first, second] = [pick(h.ticketIds, 0), pick(h.ticketIds, 1)];
    const voter = pick(h.voters, 1);
    h.app.audit.events.length = 0;

    await h.service.skipParticipant(h.moderator, h.sessionId, voter.userId, 'ticket');
    await h.service.restoreParticipant(h.moderator, h.sessionId, voter.userId);
    await h.service.changeParticipantRole(h.moderator, h.sessionId, voter.userId, 'observer');
    await h.vote(pick(h.voters, 0), '5');
    await h.service.startNewRound(h.moderator, h.sessionId, first);
    await h.vote(pick(h.voters, 0), '8');
    await h.service.overrideEstimate(h.moderator, h.sessionId, first, h.card('8'), 'Spike done');
    await h.service.skipTicket(h.moderator, h.sessionId, second);
    await h.service.setCurrentTicket(h.moderator, h.sessionId, second);
    await h.service.pause(h.moderator, h.sessionId);
    await h.service.resume(h.moderator, h.sessionId);
    await h.service.complete(h.moderator, h.sessionId);

    const byModerator = h.app.audit.events
      .filter((event) => event.actorId === h.moderator.userId)
      .map((event) => event.type);
    expect(byModerator).toEqual([
      'participant.skipped',
      'participant.restored',
      'participant.role-changed',
      'round.started',
      'estimate.overridden',
      'ticket.skipped',
      'ticket.current-changed',
      'session.paused',
      'session.resumed',
      'session.completed',
    ]);
  });

  it('keeps every facilitator control moderator-only', async () => {
    const h = await publishedSession({ voters: 2 });
    const member = pick(h.voters, 0);
    const other = pick(h.voters, 1).userId;
    const ticketId = await currentId(h);
    const attempts: (() => Promise<unknown>)[] = [
      async () => await h.service.skipParticipant(member, h.sessionId, other, 'ticket'),
      async () => await h.service.restoreParticipant(member, h.sessionId, other),
      async () => await h.service.changeParticipantRole(member, h.sessionId, other, 'observer'),
      async () => await h.service.startNewRound(member, h.sessionId, ticketId),
      async () => await h.service.skipTicket(member, h.sessionId, ticketId),
      async () => await h.service.setCurrentTicket(member, h.sessionId, ticketId),
      async () => await h.service.pause(member, h.sessionId),
      async () => await h.service.complete(member, h.sessionId),
    ];

    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});
