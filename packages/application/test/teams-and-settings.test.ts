/**
 * Milestone 2 acceptance: users can only manage authorized teams.
 */
import { describe, expect, it } from 'vitest';

import type { ApplicationRole, AuthorizationContext, UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import { SettingsService, TeamService } from '../src';
import { createInMemoryApplication } from '../src/testing';
import { actor, TENANT } from './support';

function setup() {
  const app = createInMemoryApplication();
  const deps = { ...app.deps, settings: app.settings };
  const people: Record<string, AuthorizationContext> = {};
  const person = (id: string, role: ApplicationRole = 'member'): AuthorizationContext => {
    app.identity.add({
      id: asId<UserId>(id),
      tenantId: TENANT,
      displayName: id,
      externalIdentities: [],
    });
    people[id] = actor(id, role);

    return actor(id, role);
  };

  return {
    app,
    teams: new TeamService(deps),
    settings: new SettingsService(deps),
    admin: person('admin', 'administrator'),
    alice: person('alice', 'moderator'),
    bob: person('bob', 'moderator'),
    carol: person('carol'),
    dave: person('dave'),
  };
}

describe('team permissions', () => {
  it('lets only administrators and application moderators create teams', async () => {
    const { teams, admin, alice, carol } = setup();

    await expect(teams.createTeam(carol, { name: 'Rogue' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await teams.createTeam(alice, { name: 'Alpha' })).moderatorIds).toEqual([alice.userId]);
    expect((await teams.createTeam(admin, { name: 'Admin team' })).name).toBe('Admin team');
  });

  it('stops a moderator managing a team they do not moderate', async () => {
    const { teams, alice, bob, carol } = setup();
    const alpha = await teams.createTeam(alice, { name: 'Alpha' });

    await expect(teams.addMember(bob, alpha.id, carol.userId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(teams.updateDetails(bob, alpha.id, { name: 'Taken' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lets members view their team but not change it', async () => {
    const { teams, alice, carol, dave } = setup();
    const alpha = await teams.createTeam(alice, { name: 'Alpha' });
    await teams.addMember(alice, alpha.id, carol.userId);

    const view = await teams.teamView(carol, await teams.getTeam(carol, alpha.id));
    expect(view).toMatchObject({ canManage: false, canAssignModerators: false });
    await expect(teams.addMember(carol, alpha.id, dave.userId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(teams.archive(carol, alpha.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('hides teams a user does not belong to', async () => {
    const { teams, alice, bob, carol } = setup();
    await teams.createTeam(alice, { name: 'Alpha' });
    await teams.createTeam(bob, { name: 'Bravo' });

    expect((await teams.listTeamViews(alice)).teams.map((team) => team.name)).toEqual(['Alpha']);
    expect((await teams.listTeamViews(carol)).teams).toEqual([]);
  });

  it('lets administrators manage every team and assign moderators', async () => {
    const { teams, admin, alice, carol } = setup();
    const alpha = await teams.createTeam(alice, { name: 'Alpha' });

    await teams.addMember(admin, alpha.id, carol.userId);
    await expect(teams.assignModerator(alice, alpha.id, carol.userId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const updated = await teams.assignModerator(admin, alpha.id, carol.userId);

    expect(updated.moderatorIds).toContain(carol.userId);
    expect((await teams.teamView(carol, updated)).canManage).toBe(true);
  });

  it('blocks changes to archived teams', async () => {
    const { teams, alice, carol } = setup();
    const alpha = await teams.createTeam(alice, { name: 'Alpha' });
    await teams.archive(alice, alpha.id);

    await expect(teams.addMember(alice, alpha.id, carol.userId)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('audits every team change with the acting user', async () => {
    const { app, teams, alice, carol } = setup();
    const alpha = await teams.createTeam(alice, { name: 'Alpha' });
    await teams.addMember(alice, alpha.id, carol.userId);
    await teams.removeMember(alice, alpha.id, carol.userId);

    expect(app.audit.events.map((event) => [event.type, event.actorId])).toEqual([
      ['team.created', alice.userId],
      ['team.member-added', alice.userId],
      ['team.member-removed', alice.userId],
    ]);
  });

  it('only lets team managers search the user directory', async () => {
    const { teams, alice, carol } = setup();

    await expect(teams.searchUsers(carol, 'da')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await teams.searchUsers(alice, 'da')).map((user) => user.userId)).toEqual(['dave']);
  });

  it('preserves both concurrent member additions', async () => {
    const { teams, alice, carol, dave } = setup();
    const alpha = await teams.createTeam(alice, { name: 'Alpha' });

    await Promise.all([
      teams.addMember(alice, alpha.id, carol.userId),
      teams.addMember(alice, alpha.id, dave.userId),
    ]);

    const members = (await teams.getTeam(alice, alpha.id)).members.map((member) => member.userId);
    expect(members).toEqual(expect.arrayContaining([alice.userId, carol.userId, dave.userId]));
  });
});

describe('application settings', () => {
  it('lets only administrators manage application moderators', async () => {
    const { settings, admin, alice, carol } = setup();

    await expect(settings.assignModerator(alice, carol.userId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await settings.getSettingsView(alice)).toEqual({ canAdminister: false, moderators: [] });

    const view = await settings.assignModerator(admin, carol.userId);
    expect(view.moderators.map((user) => user.userId)).toEqual([carol.userId]);

    const removed = await settings.unassignModerator(admin, carol.userId);
    expect(removed.moderators).toEqual([]);
  });

  it('treats assigning an existing moderator as a no-op', async () => {
    const { app, settings, admin, carol } = setup();
    await settings.assignModerator(admin, carol.userId);
    await settings.assignModerator(admin, carol.userId);

    expect(app.audit.events.filter((e) => e.type === 'settings.moderator-assigned')).toHaveLength(
      1,
    );
  });
});
