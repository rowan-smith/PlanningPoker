/**
 * Milestone 3 acceptance: a moderator can create a session with voters and non-voting observers.
 */
import { describe, expect, it } from 'vitest';

import type { UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import { SessionService, TeamService } from '../src';
import { createInMemoryApplication } from '../src/testing';
import { actor, TENANT, workItem } from './support';

async function setup() {
  const app = createInMemoryApplication();
  const sessions = new SessionService(app.deps);
  const teams = new TeamService(app.deps);
  const person = (id: string) => {
    app.identity.add({
      id: asId<UserId>(id),
      tenantId: TENANT,
      displayName: id,
      externalIdentities: [],
    });

    return actor(id);
  };
  const moderator = { ...person('mod'), role: 'moderator' as const };
  const [ana, ben, cat, outsider] = [person('ana'), person('ben'), person('cat'), person('out')];
  const team = await teams.createTeam(moderator, { name: 'Platform' });

  for (const member of [ana, ben, cat]) {
    await teams.addMember(moderator, team.id, member.userId);
  }

  for (let index = 1; index <= 3; index += 1) {
    app.workItems.add(`PP-${String(index)}`, workItem(index));
  }

  return { app, sessions, teams, team, moderator, ana, ben, cat, outsider };
}

describe('Milestone 3 — session builder', () => {
  it('creates and publishes a session with voters and non-voting observers', async () => {
    const { sessions, team, moderator, ana, ben, cat } = await setup();
    const draft = await sessions.createDraft(moderator, { name: 'Sprint 1', teamId: team.id });

    let builder = await sessions.getBuilderView(moderator, draft.id);
    expect(builder.suggestedParticipants.map((user) => user.userId).sort()).toEqual([
      ana.userId,
      ben.userId,
      cat.userId,
    ]);

    await sessions.inviteParticipant(moderator, draft.id, ana.userId, 'voter');
    await sessions.inviteParticipant(moderator, draft.id, ben.userId, 'voter');
    await sessions.inviteParticipant(moderator, draft.id, cat.userId, 'observer');
    await sessions.importByKeys(moderator, draft.id, ['PP-1', 'PP-2']);
    builder = await sessions.getBuilderView(moderator, draft.id);

    expect(builder.suggestedParticipants).toEqual([]);
    expect(builder.readiness.ready).toBe(true);
    expect(builder.session.participants.map((p) => [p.userId, p.role, p.isFacilitator])).toEqual([
      [moderator.userId, 'observer', true],
      [ana.userId, 'voter', false],
      [ben.userId, 'voter', false],
      [cat.userId, 'observer', false],
    ]);

    const published = await sessions.publish(moderator, draft.id);
    expect(published.status).toBe('active');

    const view = await sessions.getSessionView(moderator, draft.id);
    const current = view.tickets.find((ticket) => ticket.id === view.currentTicketId);
    expect(current?.round).toMatchObject({ status: 'open', requiredCount: 2 });
  });

  it('blocks publishing without voters or tickets, with readable reasons', async () => {
    const { sessions, team, moderator, cat } = await setup();
    const draft = await sessions.createDraft(moderator, { name: 'Sprint 1', teamId: team.id });
    await sessions.inviteParticipant(moderator, draft.id, cat.userId, 'observer');

    const { readiness } = await sessions.getBuilderView(moderator, draft.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.issues.filter((i) => i.severity === 'error').map((i) => i.code)).toEqual([
      'no-tickets',
      'no-voters',
    ]);
    await expect(sessions.publish(moderator, draft.id)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('configures preset and custom decks, rejecting invalid custom cards', async () => {
    const { sessions, team, moderator } = await setup();
    const draft = await sessions.createDraft(moderator, { name: 'Sprint 1', teamId: team.id });
    const options = { autoFinalize: true, autoAdvance: false, allowInvitationsWhileActive: true };

    await sessions.configureScoring(moderator, draft.id, {
      deck: { kind: 'preset', preset: 't-shirt' },
      specialCards: ['coffee'],
      ...options,
    });
    let { scoring } = await sessions.getBuilderView(moderator, draft.id);
    expect(scoring.deck).toEqual({ kind: 'preset', preset: 't-shirt' });
    expect(scoring.specialCards).toEqual(['coffee']);
    expect(scoring.autoFinalize).toBe(true);

    await sessions.configureScoring(moderator, draft.id, {
      deck: { kind: 'custom', name: 'Hours', scale: 'numeric', labels: ['1', '2', '4', ' '] },
      specialCards: [],
      ...options,
    });
    ({ scoring } = await sessions.getBuilderView(moderator, draft.id));
    expect(scoring.deck).toEqual({
      kind: 'custom',
      name: 'Hours',
      scale: 'numeric',
      labels: ['1', '2', '4'],
    });

    await expect(
      sessions.configureScoring(moderator, draft.id, {
        deck: { kind: 'custom', name: 'Bad', scale: 'numeric', labels: ['1', 'big'] },
        specialCards: [],
        ...options,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('removes people from drafts but revokes invitations once published', async () => {
    const { sessions, team, moderator, ana, ben } = await setup();
    const draft = await sessions.createDraft(moderator, { name: 'Sprint 1', teamId: team.id });
    await sessions.inviteParticipant(moderator, draft.id, ana.userId, 'voter');
    await sessions.inviteParticipant(moderator, draft.id, ben.userId, 'voter');
    await sessions.removeParticipant(moderator, draft.id, ben.userId);
    await sessions.importByKeys(moderator, draft.id, ['PP-1']);

    let view = await sessions.getBuilderView(moderator, draft.id);
    expect(view.session.participants.map((p) => p.userId)).not.toContain(ben.userId);

    await sessions.publish(moderator, draft.id);
    await sessions.removeParticipant(moderator, draft.id, ana.userId);
    view = await sessions.getBuilderView(moderator, draft.id);
    expect(view.session.participants.find((p) => p.userId === ana.userId)?.invitationStatus).toBe(
      'revoked',
    );
  });

  it('shows drafts only to moderators and published sessions to invitees', async () => {
    const { sessions, team, moderator, ana, outsider } = await setup();
    const draft = await sessions.createDraft(moderator, { name: 'Sprint 1', teamId: team.id });
    await sessions.inviteParticipant(moderator, draft.id, ana.userId, 'voter');
    await sessions.importByKeys(moderator, draft.id, ['PP-1']);

    expect((await sessions.listSessions(moderator)).sessions).toHaveLength(1);
    expect((await sessions.listSessions(ana)).sessions).toEqual([]);
    await expect(sessions.getBuilderView(ana, draft.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    await sessions.publish(moderator, draft.id);
    expect((await sessions.listSessions(ana)).sessions.map((s) => s.status)).toEqual(['active']);
    expect((await sessions.listSessions(outsider)).sessions).toEqual([]);
    await expect(sessions.getBuilderView(ana, draft.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('offers session creation only for teams the user manages', async () => {
    const { sessions, team, moderator, ana } = await setup();

    expect((await sessions.listSessions(moderator)).teams).toEqual([
      { id: team.id, name: 'Platform' },
    ]);
    expect((await sessions.listSessions(ana)).teams).toEqual([]);
    await expect(
      sessions.createDraft(ana, { name: 'Mine', teamId: team.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('accepts and declines invitations only for the invited user', async () => {
    const { sessions, team, moderator, ana, ben } = await setup();
    const draft = await sessions.createDraft(moderator, { name: 'Sprint 1', teamId: team.id });
    await sessions.inviteParticipant(moderator, draft.id, ana.userId, 'voter');
    await sessions.importByKeys(moderator, draft.id, ['PP-1']);
    await sessions.publish(moderator, draft.id);

    await expect(sessions.respondToInvitation(ben, draft.id, 'joined')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await sessions.getHome(ana)).pendingInvitations).toHaveLength(1);
    await sessions.respondToInvitation(ana, draft.id, 'declined');
    expect((await sessions.getHome(ana)).pendingInvitations).toEqual([]);
  });
});
