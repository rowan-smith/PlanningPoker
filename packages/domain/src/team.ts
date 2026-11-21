import { ensure } from './errors';
import type { TeamId, TenantId, UserId } from './ids';

const MAX_TEAM_NAME_LENGTH = 100;

export interface TeamMember {
  readonly userId: UserId;
  readonly addedAt: Date;
}

export interface Team {
  readonly id: TeamId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly description: string | null;
  readonly members: readonly TeamMember[];
  readonly moderatorIds: readonly UserId[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archived: boolean;
  /** Incremented by persistence on every save; used for optimistic concurrency. */
  readonly version: number;
}

export interface CreateTeamInput {
  readonly id: TeamId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly description?: string | null;
  readonly createdBy: UserId;
  readonly now: Date;
}

function validName(name: string): string {
  const trimmed = name.trim();
  ensure(trimmed.length > 0, 'VALIDATION', 'Team name is required.');
  ensure(
    trimmed.length <= MAX_TEAM_NAME_LENGTH,
    'VALIDATION',
    `Team name must be at most ${String(MAX_TEAM_NAME_LENGTH)} characters.`,
  );

  return trimmed;
}

function ensureNotArchived(team: Team): void {
  ensure(!team.archived, 'INVALID_STATE', 'Archived teams cannot be changed.');
}

/** Creates a team. The creator becomes its first moderator and member. */
export function createTeam(input: CreateTeamInput): Team {
  return {
    id: input.id,
    tenantId: input.tenantId,
    name: validName(input.name),
    description: input.description?.trim() ?? null,
    members: [{ userId: input.createdBy, addedAt: input.now }],
    moderatorIds: [input.createdBy],
    createdAt: input.now,
    updatedAt: input.now,
    archived: false,
    version: 0,
  };
}

export function updateTeamDetails(
  team: Team,
  changes: { readonly name?: string; readonly description?: string | null },
  now: Date,
): Team {
  ensureNotArchived(team);

  return {
    ...team,
    name: changes.name === undefined ? team.name : validName(changes.name),
    description:
      changes.description === undefined ? team.description : (changes.description?.trim() ?? null),
    updatedAt: now,
  };
}

export function isTeamMember(team: Team, userId: UserId): boolean {
  return team.members.some((member) => member.userId === userId);
}

export function isTeamModerator(team: Team, userId: UserId): boolean {
  return team.moderatorIds.includes(userId);
}

export function addTeamMember(team: Team, userId: UserId, now: Date): Team {
  ensureNotArchived(team);

  if (isTeamMember(team, userId)) {
    return team;
  }

  return { ...team, members: [...team.members, { userId, addedAt: now }], updatedAt: now };
}

export function removeTeamMember(team: Team, userId: UserId, now: Date): Team {
  ensureNotArchived(team);
  ensure(
    !(isTeamModerator(team, userId) && team.moderatorIds.length === 1),
    'INVALID_STATE',
    'A team must keep at least one moderator.',
  );

  return {
    ...team,
    members: team.members.filter((member) => member.userId !== userId),
    moderatorIds: team.moderatorIds.filter((id) => id !== userId),
    updatedAt: now,
  };
}

/** Moderators are also members, so assigning a moderator adds them to the team. */
export function assignTeamModerator(team: Team, userId: UserId, now: Date): Team {
  const withMember = addTeamMember(team, userId, now);

  if (isTeamModerator(withMember, userId)) {
    return withMember;
  }

  return { ...withMember, moderatorIds: [...withMember.moderatorIds, userId], updatedAt: now };
}

export function unassignTeamModerator(team: Team, userId: UserId, now: Date): Team {
  ensureNotArchived(team);

  if (!isTeamModerator(team, userId)) {
    return team;
  }

  ensure(team.moderatorIds.length > 1, 'INVALID_STATE', 'A team must keep at least one moderator.');

  return { ...team, moderatorIds: team.moderatorIds.filter((id) => id !== userId), updatedAt: now };
}

export function archiveTeam(team: Team, now: Date): Team {
  return team.archived ? team : { ...team, archived: true, updatedAt: now };
}
