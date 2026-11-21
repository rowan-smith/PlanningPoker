/**
 * Required acceptance scenarios A–J (spec §19). All run against in-memory adapters (Scenario J).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DomainError } from '@planning-poker/domain';
import type { TicketId } from '@planning-poker/domain';

import { publishedSession, STORY_POINTS } from './support';

describe('Scenario A — facilitator observes', () => {
  it('reveals once all three voters vote, without the moderator voting', async () => {
    const h = await publishedSession({ voters: 3 });
    const [a, b, c] = h.voters;

    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('setup');
    }

    expect((await h.view(h.moderator)).viewer).toMatchObject({
      role: 'observer',
      canModerate: true,
      canVoteOnCurrentTicket: false,
    });

    await h.vote(a, '5');
    await h.vote(b, '8');
    expect((await h.currentTicket()).round?.status).toBe('open');

    await h.vote(c, '5');
    const ticket = await h.currentTicket();

    expect(ticket.votingState).toBe('revealed');
    expect(ticket.round?.result?.values).toEqual(['5', '5', '8']);
  });
});

describe('Scenario B — member is absent', () => {
  it('reveals with three votes after the fourth voter is skipped for the ticket', async () => {
    const h = await publishedSession({ voters: 4 });
    const [a, b, c, absent] = h.voters;

    if (a === undefined || b === undefined || c === undefined || absent === undefined) {
      throw new Error('setup');
    }

    await h.vote(a, '3');
    await h.vote(b, '3');
    await h.vote(c, '5');
    expect((await h.currentTicket()).round).toMatchObject({ requiredCount: 4, votedCount: 3 });

    await h.service.skipParticipant(h.moderator, h.sessionId, absent.userId, 'ticket');
    const ticket = await h.currentTicket();

    expect(ticket.votingState).toBe('revealed');
    expect(ticket.round?.result?.voteCount).toBe(3);
    expect(ticket.round?.requiredCount).toBe(3);
  });
});

describe('Scenario C — skipped voter had already voted', () => {
  it('excludes the skipped vote from consensus and distribution without exposing it', async () => {
    const h = await publishedSession({ voters: 4 });
    const [a, b, skipped, last] = h.voters;

    if (a === undefined || b === undefined || skipped === undefined || last === undefined) {
      throw new Error('setup');
    }

    await h.vote(a, '5');
    await h.vote(b, '5');
    await h.vote(skipped, '13');
    await h.service.skipParticipant(h.moderator, h.sessionId, skipped.userId, 'ticket');
    await h.vote(last, '5');

    const view = await h.view(h.moderator);
    const ticket = view.tickets.find((entry) => entry.id === view.currentTicketId);

    expect(ticket?.round?.result).toMatchObject({
      outcome: 'unanimous',
      voteCount: 3,
      values: ['5', '5', '5'],
    });
    expect(JSON.stringify({ ...view, deck: [] })).not.toContain('"13"');

    const skipAudit = h.app.audit.events.find((event) => event.type === 'participant.skipped');
    expect(skipAudit?.details).toEqual({ scope: 'ticket', hadVoted: true });
    expect(JSON.stringify(h.app.audit.events)).not.toContain(h.card('13'));
  });
});

describe('Scenario D — observer invited during active session', () => {
  it('lets the observer watch but not vote, leaving requirements unchanged', async () => {
    const h = await publishedSession({ voters: 2 });
    const observer = h.addUser('late-observer');
    const before = (await h.currentTicket()).round?.requiredCount;

    await h.service.inviteParticipant(h.moderator, h.sessionId, observer.userId, 'observer');
    await h.service.respondToInvitation(observer, h.sessionId, 'joined');

    const view = await h.view(observer);
    expect(view.viewer).toMatchObject({ role: 'observer', canVoteOnCurrentTicket: false });
    expect((await h.currentTicket()).round?.requiredCount).toBe(before);
    await expect(h.vote(observer, '5')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
  });
});

describe('Scenario E — voter invited during active round', () => {
  it('keeps the frozen roster and includes the new voter from the next ticket', async () => {
    const h = await publishedSession({ voters: 2, tickets: 2 });
    const [a, b] = h.voters;
    const late = h.addUser('late-voter');

    if (a === undefined || b === undefined) {
      throw new Error('setup');
    }

    await h.service.inviteParticipant(h.moderator, h.sessionId, late.userId, 'voter');
    await h.service.respondToInvitation(late, h.sessionId, 'joined');

    expect((await h.currentTicket()).round?.requiredCount).toBe(2);
    await expect(h.vote(late, '5')).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });

    await h.vote(a, '5');
    await h.vote(b, '8');
    expect((await h.currentTicket()).votingState).toBe('revealed');

    await h.service.advance(h.moderator, h.sessionId);
    expect((await h.currentTicket()).round?.requiredCount).toBe(3);
  });

  it('includes the new voter when the moderator restarts the current round', async () => {
    const h = await publishedSession({ voters: 2 });
    const late = h.addUser('late-voter');
    const [ticketId] = h.ticketIds;

    if (ticketId === undefined) {
      throw new Error('setup');
    }

    await h.service.inviteParticipant(h.moderator, h.sessionId, late.userId, 'voter');
    await h.service.respondToInvitation(late, h.sessionId, 'joined');
    await h.service.startNewRound(h.moderator, h.sessionId, ticketId);

    const ticket = await h.currentTicket();
    expect(ticket.round).toMatchObject({ number: 2, status: 'open', requiredCount: 3 });
    expect(ticket.votingState).toBe('revoting');
  });
});

describe('Scenario F — voter restored', () => {
  it('requires a fresh vote from a voter restored before reveal', async () => {
    const h = await publishedSession({ voters: 3 });
    const [a, b, restored] = h.voters;

    if (a === undefined || b === undefined || restored === undefined) {
      throw new Error('setup');
    }

    await h.vote(restored, '8');
    await h.service.skipParticipant(h.moderator, h.sessionId, restored.userId, 'ticket');
    await h.vote(a, '5');
    await h.service.restoreParticipant(h.moderator, h.sessionId, restored.userId);
    await h.vote(b, '5');

    let ticket = await h.currentTicket();
    expect(ticket.votingState).toBe('voting');
    expect(ticket.round).toMatchObject({ requiredCount: 3, votedCount: 2 });
    expect((await h.currentTicket(restored)).myVoteCardId).toBeNull();

    await h.vote(restored, '5');
    ticket = await h.currentTicket();
    expect(ticket.votingState).toBe('revealed');
    expect(ticket.round?.result?.values).toEqual(['5', '5', '5']);
  });

  it('does not change a round that was already revealed', async () => {
    const h = await publishedSession({ voters: 2 });
    const [a, b] = h.voters;

    if (a === undefined || b === undefined) {
      throw new Error('setup');
    }

    await h.vote(a, '5');
    await h.service.skipParticipant(h.moderator, h.sessionId, b.userId, 'session');
    expect((await h.currentTicket()).votingState).toBe('revealed');

    await h.service.restoreParticipant(h.moderator, h.sessionId, b.userId);
    const ticket = await h.currentTicket();
    expect(ticket.votingState).toBe('revealed');
    expect(ticket.round?.result?.voteCount).toBe(1);
  });
});

describe('Scenario G — zero voters', () => {
  it('does not reveal, finalize or advance when every voter is skipped', async () => {
    const h = await publishedSession({
      voters: 2,
      autoFinalize: true,
      autoAdvance: true,
      tickets: 2,
    });
    const before = (await h.view(h.moderator)).currentTicketId;

    for (const voter of h.voters) {
      await h.service.skipParticipant(h.moderator, h.sessionId, voter.userId, 'ticket');
    }

    const view = await h.view(h.moderator);
    const ticket = view.tickets.find((entry) => entry.id === view.currentTicketId);

    expect(view.currentTicketId).toBe(before);
    expect(ticket).toMatchObject({ votingState: 'voting', estimate: null });
    expect(ticket?.round).toMatchObject({ status: 'open', requiredCount: 0, result: null });
    await expect(
      h.service.reveal(h.moderator, h.sessionId, view.currentTicketId as TicketId),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe('Scenario H — automatic Jira update', () => {
  it('finalizes a unanimous mapped score, writes it and advances after success', async () => {
    const h = await publishedSession({
      voters: 2,
      tickets: 2,
      autoFinalize: true,
      autoAdvance: true,
      destinationField: STORY_POINTS,
      fieldValues: { [STORY_POINTS.fieldId]: null },
    });
    const [first, second] = h.ticketIds;

    for (const voter of h.voters) {
      await h.vote(voter, '5');
    }

    const view = await h.view(h.moderator);
    const finalized = view.tickets.find((ticket) => ticket.id === first);

    expect(finalized).toMatchObject({
      votingState: 'finalized',
      syncState: 'succeeded',
      estimate: { label: '5', kind: 'consensus' },
    });
    expect(h.app.workItems.updates).toHaveLength(1);
    expect(h.app.workItems.updates[0]).toMatchObject({ fieldId: STORY_POINTS.fieldId, value: 5 });
    expect(view.currentTicketId).toBe(second);
  });

  it('keeps the ticket finalized, does not advance, and allows retry when the write fails', async () => {
    const h = await publishedSession({
      voters: 2,
      autoFinalize: true,
      autoAdvance: true,
      destinationField: STORY_POINTS,
      fieldValues: { [STORY_POINTS.fieldId]: null },
    });
    const [first] = h.ticketIds;

    if (first === undefined) {
      throw new Error('setup');
    }

    h.app.workItems.nextUpdateResult = { status: 'failed', message: 'Rate limited' };

    for (const voter of h.voters) {
      await h.vote(voter, '8');
    }

    let ticket = await h.currentTicket();
    expect(ticket).toMatchObject({ id: first, votingState: 'finalized', syncState: 'failed' });

    h.app.workItems.nextUpdateResult = { status: 'succeeded' };
    await h.service.retrySync(h.moderator, h.sessionId, first, false);
    const view = await h.view(h.moderator);
    ticket = view.tickets.find((entry) => entry.id === first) ?? ticket;

    expect(ticket.syncState).toBe('succeeded');
    expect(view.currentTicketId).not.toBe(first);
    expect(new Set(h.app.workItems.updates.map((update) => update.idempotencyKey)).size).toBe(1);
  });

  it('does not overwrite a value changed in Jira without confirmation', async () => {
    const h = await publishedSession({
      voters: 1,
      autoFinalize: true,
      destinationField: STORY_POINTS,
      fieldValues: { [STORY_POINTS.fieldId]: null },
    });
    const [first] = h.ticketIds;
    const [voter] = h.voters;

    if (first === undefined || voter === undefined) {
      throw new Error('setup');
    }

    h.app.workItems.fieldValues.set(`fake|site-1|10001#${STORY_POINTS.fieldId}`, 13);
    await h.vote(voter, '3');

    expect((await h.currentTicket()).syncState).toBe('conflict');
    expect(h.app.workItems.updates).toHaveLength(0);
    await expect(h.service.retrySync(h.moderator, h.sessionId, first, false)).rejects.toMatchObject(
      {
        code: 'CONFLICT',
      },
    );

    await h.service.retrySync(h.moderator, h.sessionId, first, true);
    expect((await h.currentTicket()).syncState).toBe('succeeded');
    expect(h.app.workItems.updates[0]?.value).toBe(3);
  });

  it('needs a moderator decision for a unanimous special card', async () => {
    const h = await publishedSession({
      voters: 2,
      autoFinalize: true,
      destinationField: STORY_POINTS,
    });

    for (const voter of h.voters) {
      await h.vote(voter, '☕');
    }

    const ticket = await h.currentTicket();
    expect(ticket.votingState).toBe('revealed');
    expect(ticket.round?.result).toMatchObject({
      outcome: 'unanimous',
      requiresModeratorResolution: true,
    });
    expect(h.app.workItems.updates).toHaveLength(0);
  });
});

describe('Scenario I — disagreement', () => {
  it('reveals anonymously and requires a revote or a reasoned override', async () => {
    const h = await publishedSession({
      voters: 3,
      autoFinalize: true,
      destinationField: STORY_POINTS,
    });
    const [first] = h.ticketIds;
    const [a, b, c] = h.voters;

    if (first === undefined || a === undefined || b === undefined || c === undefined) {
      throw new Error('setup');
    }

    await h.vote(a, '3');
    await h.vote(b, '5');
    await h.vote(c, '8');

    const ticket = await h.currentTicket();
    expect(ticket.votingState).toBe('revealed');
    expect(ticket.round?.result).toMatchObject({
      outcome: 'disputed',
      requiresModeratorResolution: true,
      values: ['3', '5', '8'],
    });
    expect(ticket.estimate).toBeNull();

    await expect(h.service.acceptConsensus(h.moderator, h.sessionId, first)).rejects.toBeInstanceOf(
      DomainError,
    );
    await expect(
      h.service.overrideEstimate(h.moderator, h.sessionId, first, h.card('5'), '   '),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      h.service.overrideEstimate(a, h.sessionId, first, h.card('5'), 'I am not a moderator'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await h.service.overrideEstimate(
      h.moderator,
      h.sessionId,
      first,
      h.card('5'),
      'Middle option agreed in discussion',
    );
    expect((await h.currentTicket()).estimate).toEqual({
      label: '5',
      kind: 'override',
      reason: 'Middle option agreed in discussion',
    });
    expect(h.app.audit.events.some((event) => event.type === 'estimate.overridden')).toBe(true);
  });

  it('starts another round on request', async () => {
    const h = await publishedSession({ voters: 2 });
    const [first] = h.ticketIds;
    const [a, b] = h.voters;

    if (first === undefined || a === undefined || b === undefined) {
      throw new Error('setup');
    }

    await h.vote(a, '3');
    await h.vote(b, '13');
    await h.service.startNewRound(h.moderator, h.sessionId, first);

    const ticket = await h.currentTicket(a);
    expect(ticket.round).toMatchObject({ number: 2, status: 'open', votedCount: 0, result: null });
    expect(ticket.myVoteCardId).toBeNull();
  });
});

describe('Scenario J — platform independence', () => {
  it('keeps the domain free of dependencies and the application free of platform packages', () => {
    const read = (path: string): { dependencies?: Record<string, string> } =>
      JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
    const domain = read('../../domain/package.json');
    const application = read('../package.json');

    expect(domain.dependencies ?? {}).toEqual({});
    expect(Object.keys(application.dependencies ?? {}).sort()).toEqual([
      '@planning-poker/contracts',
      '@planning-poker/domain',
    ]);
  });
});
