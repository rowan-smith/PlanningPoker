/**
 * Milestone 5 acceptance: concurrent votes are preserved and hidden until reveal conditions are
 * met, with progress and realtime notifications that never carry hidden state.
 */
import { describe, expect, it } from 'vitest';

import { publishedSession } from './support';

describe('Milestone 5 — voting and realtime', () => {
  it('preserves concurrent votes and hides them from everyone until reveal', async () => {
    const h = await publishedSession({ voters: 5 });
    const [first, ...others] = h.voters;

    if (first === undefined) {
      throw new Error('setup');
    }

    // Four voters vote at the same moment; the fifth has not voted yet.
    await Promise.all(
      others.map(async (voter, index) => {
        await h.vote(voter, index % 2 === 0 ? '5' : '8');
      }),
    );

    for (const viewer of [h.moderator, first, ...others]) {
      const ticket = await h.currentTicket(viewer);

      expect(ticket.round).toMatchObject({ status: 'open', votedCount: 4, result: null });
    }

    const moderatorView = await h.view(h.moderator);
    const withoutDeck = JSON.stringify({ ...moderatorView, deck: [] });
    expect(withoutDeck).not.toContain(h.card('5'));
    expect(withoutDeck).not.toContain(h.card('8'));

    await h.vote(first, '5');
    const revealed = await h.currentTicket();
    expect(revealed.round?.result).toMatchObject({
      voteCount: 5,
      values: ['5', '5', '5', '8', '8'],
    });
  });

  it('publishes vote progress and reveal notifications without any vote values', async () => {
    const h = await publishedSession({ voters: 2 });
    const [a, b] = h.voters;

    if (a === undefined || b === undefined) {
      throw new Error('setup');
    }

    h.app.events.published.length = 0;
    await h.vote(a, '13');
    await h.vote(b, '13');
    const events = h.app.events.published.map(({ event }) => event);

    expect(events.map((event) => event.type)).toEqual([
      'vote.status',
      'vote.status',
      'round.revealed',
    ]);
    expect(events[0]).toMatchObject({ votedCount: 1, requiredCount: 2 });
    expect(JSON.stringify(events)).not.toContain(h.card('13'));
    expect(JSON.stringify(events)).not.toContain(a.userId);
  });

  it('tells each viewer what they can do', async () => {
    const h = await publishedSession({ voters: 1, observers: 1 });
    const late = h.addUser('late');
    await h.service.inviteParticipant(h.moderator, h.sessionId, late.userId, 'voter');
    const [voter] = h.voters;
    const [observer] = h.observers;

    if (voter === undefined || observer === undefined) {
      throw new Error('setup');
    }

    expect((await h.view(voter)).viewer).toMatchObject({
      role: 'voter',
      invitationStatus: 'joined',
      canVoteOnCurrentTicket: true,
      canPreVote: true,
    });
    expect((await h.view(observer)).viewer).toMatchObject({
      role: 'observer',
      canVoteOnCurrentTicket: false,
      canPreVote: false,
    });
    expect((await h.view(late)).viewer).toMatchObject({
      invitationStatus: 'invited',
      canVoteOnCurrentTicket: false,
      canPreVote: false,
    });
    expect((await h.view(h.moderator)).viewer).toMatchObject({
      invitationStatus: null,
      canModerate: true,
      canVoteOnCurrentTicket: false,
    });
  });

  it('counts a pre-vote once its ticket opens, without revealing it earlier', async () => {
    const h = await publishedSession({ voters: 2, tickets: 2 });
    const [a, b] = h.voters;
    const second = h.ticketIds[1];

    if (a === undefined || b === undefined || second === undefined) {
      throw new Error('setup');
    }

    await h.vote(a, '3', second);
    await h.vote(b, '3', second);
    const before = (await h.view(h.moderator)).tickets.find((ticket) => ticket.id === second);
    expect(before?.round).toMatchObject({ status: 'pending', votedCount: 0, result: null });

    await h.service.advance(h.moderator, h.sessionId);
    const after = await h.currentTicket();
    expect(after.id).toBe(second);
    expect(after.round?.result).toMatchObject({ outcome: 'unanimous', voteCount: 2 });
  });
});
