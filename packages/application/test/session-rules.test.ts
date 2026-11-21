import { describe, expect, it } from 'vitest';

import { asId } from '@planning-poker/domain';
import type { TenantId } from '@planning-poker/domain';

import { actor, publishedSession } from './support';

describe('concurrency', () => {
  it('preserves simultaneous votes and reveals exactly once', async () => {
    const h = await publishedSession({ voters: 6, autoFinalize: true });

    await Promise.all(
      h.voters.map(async (voter) => {
        await h.vote(voter, '5');
      }),
    );

    const ticket = await h.currentTicket();
    expect(ticket.round?.result?.voteCount).toBe(6);
    expect(ticket.votingState).toBe('finalized');
    expect(h.app.audit.events.filter((event) => event.type === 'round.revealed')).toHaveLength(1);
    expect(h.app.audit.events.filter((event) => event.type === 'estimate.finalized')).toHaveLength(
      1,
    );
  });

  it('keeps only the latest vote when a voter changes their mind before reveal', async () => {
    const h = await publishedSession({ voters: 2 });
    const [a, b] = h.voters;

    if (a === undefined || b === undefined) {
      throw new Error('setup');
    }

    await h.vote(a, '3');
    await h.vote(a, '8');
    expect((await h.currentTicket()).round?.votedCount).toBe(1);
    await h.vote(b, '8');

    expect((await h.currentTicket()).round?.result?.values).toEqual(['8', '8']);
    await expect(h.vote(a, '1')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('vote privacy', () => {
  it('shows each voter only their own choice and never pairs people with votes', async () => {
    const h = await publishedSession({ voters: 3 });
    const [a, b] = h.voters;

    if (a === undefined || b === undefined) {
      throw new Error('setup');
    }

    await h.vote(a, '13');
    expect((await h.currentTicket(a)).myVoteCardId).toBe(h.card('13'));
    expect((await h.currentTicket(b)).myVoteCardId).toBeNull();

    const moderatorView = await h.view(h.moderator);
    expect(JSON.stringify({ ...moderatorView, deck: [] })).not.toContain(h.card('13'));
    expect(moderatorView.participants.find((p) => p.userId === a.userId)?.voteStatus).toBe('voted');
    expect(moderatorView.participants.find((p) => p.userId === b.userId)?.voteStatus).toBe(
      'pending',
    );
    expect(h.app.events.published.map(({ event }) => JSON.stringify(event)).join()).not.toContain(
      h.card('13'),
    );
  });

  it('keeps future-ticket pre-votes hidden until that ticket reveals', async () => {
    const h = await publishedSession({ voters: 2, tickets: 2 });
    const [, second] = h.ticketIds;
    const [a, b] = h.voters;

    if (second === undefined || a === undefined || b === undefined) {
      throw new Error('setup');
    }

    await h.vote(a, '21', second);
    const future = (await h.view(h.moderator)).tickets.find((ticket) => ticket.id === second);
    expect(future?.round).toMatchObject({ status: 'pending', votedCount: 0, result: null });

    await h.service.setCurrentTicket(h.moderator, h.sessionId, second);
    expect((await h.currentTicket()).round).toMatchObject({ votedCount: 1, requiredCount: 2 });

    await h.vote(b, '21');
    expect((await h.currentTicket()).round?.result?.values).toEqual(['21', '21']);
  });
});

describe('authorization', () => {
  it('rejects moderator actions from members', async () => {
    const h = await publishedSession({ voters: 2 });
    const [a, b] = h.voters;

    if (a === undefined || b === undefined) {
      throw new Error('setup');
    }

    await expect(
      h.service.skipParticipant(a, h.sessionId, b.userId, 'ticket'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(h.service.complete(a, h.sessionId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('hides drafts from members and sessions from other tenants', async () => {
    const h = await publishedSession({ voters: 1 });
    const team = (await h.teamService.listTeams(h.moderator))[0];

    if (team === undefined) {
      throw new Error('setup');
    }

    const draft = await h.service.createDraft(h.moderator, {
      name: 'Next sprint',
      teamId: team.id,
    });
    const [voter] = h.voters;

    if (voter === undefined) {
      throw new Error('setup');
    }

    await h.service.inviteParticipant(h.moderator, draft.id, voter.userId, 'voter');
    await expect(h.service.getSessionView(voter, draft.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const outsider = {
      ...actor('moderator', 'administrator'),
      tenantId: asId<TenantId>('tenant-2'),
    };
    await expect(h.service.getSessionView(outsider, h.sessionId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('only lets administrators assign team moderators', async () => {
    const h = await publishedSession({ voters: 1 });
    const team = (await h.teamService.listTeams(h.moderator))[0];
    const [voter] = h.voters;

    if (team === undefined || voter === undefined) {
      throw new Error('setup');
    }

    await expect(
      h.teamService.assignModerator(h.moderator, team.id, voter.userId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await h.teamService.assignModerator(actor('admin', 'administrator'), team.id, voter.userId);
    expect((await h.teamService.getTeam(voter, team.id)).moderatorIds).toContain(voter.userId);
  });
});

describe('roles and lifecycle', () => {
  it('removes a voter turned observer from the open round', async () => {
    const h = await publishedSession({ voters: 2 });
    const [a, b] = h.voters;

    if (a === undefined || b === undefined) {
      throw new Error('setup');
    }

    await h.vote(a, '5');
    await h.service.changeParticipantRole(h.moderator, h.sessionId, b.userId, 'observer');

    expect((await h.currentTicket()).votingState).toBe('revealed');
    expect(h.app.audit.events.some((event) => event.type === 'participant.role-changed')).toBe(
      true,
    );
  });

  it('marks unfinished tickets unresolved when the session completes', async () => {
    const h = await publishedSession({ voters: 2, tickets: 2 });

    await h.service.complete(h.moderator, h.sessionId);
    const view = await h.view(h.moderator);

    expect(view.status).toBe('completed');
    expect(view.tickets.map((ticket) => ticket.votingState)).toEqual(['unresolved', 'unresolved']);
  });

  it('shows pending invitations on the invitee home and active sessions after joining', async () => {
    const h = await publishedSession({ voters: 1 });
    const guest = h.addUser('guest');

    await h.service.inviteParticipant(h.moderator, h.sessionId, guest.userId, 'observer');
    let home = await h.service.getHome(guest);
    expect(home.pendingInvitations).toHaveLength(1);
    expect(home.activeSessions).toHaveLength(0);

    await h.service.respondToInvitation(guest, h.sessionId, 'joined');
    home = await h.service.getHome(guest);
    expect(home.pendingInvitations).toHaveLength(0);
    expect(home.activeSessions.map((session) => session.myRole)).toEqual(['observer']);
  });
});
