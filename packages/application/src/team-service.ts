import type {
  TeamDetailView,
  TeamListView,
  TeamSummaryView,
  UserView,
} from '@planning-poker/contracts';
import type {
  AuditEventType,
  AuthorizationContext,
  Team,
  TeamId,
  UserId,
  UserIdentity,
} from '@planning-poker/domain';
import {
  addTeamMember,
  archiveTeam,
  asId,
  assignTeamModerator,
  createTeam,
  DomainError,
  isAdministrator,
  isTeamModerator,
  removeTeamMember,
  unassignTeamModerator,
  updateTeamDetails,
} from '@planning-poker/domain';

import { canCreateTeams, canManageTeam, canViewTeam, forbid } from './authorization';
import type { ApplicationDependencies } from './dependencies';
import { auditEvent } from './dependencies';
import { displayName } from './views';

const MAX_USER_SEARCH_LENGTH = 100;

export type TeamServiceDependencies = Pick<
  ApplicationDependencies,
  'teams' | 'audit' | 'atomic' | 'clock' | 'ids' | 'identity'
>;

export function userView(users: ReadonlyMap<UserId, UserIdentity>, userId: UserId): UserView {
  return {
    userId,
    displayName: displayName(users, userId),
    avatarUrl: users.get(userId)?.avatarUrl ?? null,
  };
}

export function teamSummaryView(actor: AuthorizationContext, team: Team): TeamSummaryView {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    memberCount: team.members.length,
    archived: team.archived,
    canManage: canManageTeam(actor, team),
  };
}

export function teamDetailView(
  actor: AuthorizationContext,
  team: Team,
  users: ReadonlyMap<UserId, UserIdentity>,
): TeamDetailView {
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    archived: team.archived,
    members: team.members
      .map((member) => ({
        ...userView(users, member.userId),
        isModerator: isTeamModerator(team, member.userId),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    canManage: canManageTeam(actor, team) && !team.archived,
    canAssignModerators: isAdministrator(actor) && !team.archived,
  };
}

/** Team management. Every change is authorized against stored team state and audited. */
export class TeamService {
  private readonly deps: TeamServiceDependencies;

  constructor(deps: TeamServiceDependencies) {
    this.deps = deps;
  }

  async createTeam(
    actor: AuthorizationContext,
    input: { readonly name: string; readonly description?: string | null },
  ): Promise<Team> {
    if (!canCreateTeams(actor)) {
      forbid('Only administrators and moderators can create teams.');
    }

    const team = createTeam({
      id: asId<TeamId>(this.deps.ids.next()),
      tenantId: actor.tenantId,
      name: input.name,
      description: input.description ?? null,
      createdBy: actor.userId,
      now: this.deps.clock.now(),
    });
    const saved = await this.deps.teams.save(team);
    await this.deps.audit.append([
      auditEvent(this.deps, {
        type: 'team.created',
        actor,
        tenantId: actor.tenantId,
        teamId: saved.id,
      }),
    ]);

    return saved;
  }

  async listTeams(actor: AuthorizationContext): Promise<readonly Team[]> {
    const teams = await this.deps.teams.listForTenant(actor.tenantId);

    return teams.filter((team) => canViewTeam(actor, team));
  }

  async getTeam(actor: AuthorizationContext, teamId: TeamId): Promise<Team> {
    const team = await this.deps.teams.get(actor.tenantId, teamId);

    // Same error for missing and unauthorized teams, so IDs cannot be probed.
    if (team === null || !canViewTeam(actor, team)) {
      throw new DomainError('NOT_FOUND', 'Team not found.');
    }

    return team;
  }

  async listTeamViews(actor: AuthorizationContext): Promise<TeamListView> {
    const teams = await this.listTeams(actor);

    return {
      teams: [...teams]
        .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name))
        .map((team) => teamSummaryView(actor, team)),
      canCreateTeams: canCreateTeams(actor),
    };
  }

  async teamView(actor: AuthorizationContext, team: Team): Promise<TeamDetailView> {
    const users = await this.deps.identity.getUsers(
      actor.tenantId,
      team.members.map((member) => member.userId),
    );

    return teamDetailView(actor, team, new Map(users.map((user) => [user.id, user])));
  }

  /** People who can be added to teams. Limited to users who can manage at least one team. */
  async searchUsers(actor: AuthorizationContext, query: string): Promise<readonly UserView[]> {
    const trimmed = query.trim().slice(0, MAX_USER_SEARCH_LENGTH);

    if (!(await this.canManageAnyTeam(actor))) {
      forbid('You cannot search for users.');
    }

    if (trimmed.length === 0) {
      return [];
    }

    const users = await this.deps.identity.searchUsers(actor.tenantId, trimmed);
    const byId = new Map(users.map((user) => [user.id, user]));

    return users.map((user) => userView(byId, user.id));
  }

  async updateDetails(
    actor: AuthorizationContext,
    teamId: TeamId,
    changes: { readonly name?: string; readonly description?: string | null },
  ): Promise<Team> {
    return await this.change(actor, teamId, 'team.updated', null, (team, now) =>
      updateTeamDetails(team, changes, now),
    );
  }

  async addMember(actor: AuthorizationContext, teamId: TeamId, userId: UserId): Promise<Team> {
    const [user] = await this.deps.identity.getUsers(actor.tenantId, [userId]);

    if (user === undefined) {
      throw new DomainError('NOT_FOUND', 'That user could not be found.');
    }

    return await this.change(actor, teamId, 'team.member-added', userId, (team, now) =>
      addTeamMember(team, userId, now),
    );
  }

  async removeMember(actor: AuthorizationContext, teamId: TeamId, userId: UserId): Promise<Team> {
    return await this.change(actor, teamId, 'team.member-removed', userId, (team, now) =>
      removeTeamMember(team, userId, now),
    );
  }

  /** Moderator assignment is an administrator action. */
  async assignModerator(
    actor: AuthorizationContext,
    teamId: TeamId,
    userId: UserId,
  ): Promise<Team> {
    if (!isAdministrator(actor)) {
      forbid('Only administrators can assign moderators.');
    }

    return await this.change(actor, teamId, 'team.moderator-assigned', userId, (team, now) =>
      assignTeamModerator(team, userId, now),
    );
  }

  async unassignModerator(
    actor: AuthorizationContext,
    teamId: TeamId,
    userId: UserId,
  ): Promise<Team> {
    if (!isAdministrator(actor)) {
      forbid('Only administrators can unassign moderators.');
    }

    return await this.change(actor, teamId, 'team.moderator-unassigned', userId, (team, now) =>
      unassignTeamModerator(team, userId, now),
    );
  }

  async archive(actor: AuthorizationContext, teamId: TeamId): Promise<Team> {
    return await this.change(actor, teamId, 'team.archived', null, (team, now) =>
      archiveTeam(team, now),
    );
  }

  private async canManageAnyTeam(actor: AuthorizationContext): Promise<boolean> {
    if (canCreateTeams(actor)) {
      return true;
    }

    const teams = await this.deps.teams.listForTenant(actor.tenantId);

    return teams.some((team) => canManageTeam(actor, team));
  }

  private async change(
    actor: AuthorizationContext,
    teamId: TeamId,
    type: AuditEventType,
    subjectUserId: UserId | null,
    apply: (team: Team, now: Date) => Team,
  ): Promise<Team> {
    return await this.deps.atomic.run(`team:${teamId}`, async () => {
      const team = await this.getTeam(actor, teamId);

      if (!canManageTeam(actor, team)) {
        forbid('You cannot manage this team.');
      }

      const updated = apply(team, this.deps.clock.now());

      if (updated === team) {
        return team;
      }

      const saved = await this.deps.teams.save(updated);
      await this.deps.audit.append([
        auditEvent(this.deps, { type, actor, tenantId: actor.tenantId, teamId, subjectUserId }),
      ]);

      return saved;
    });
  }
}
