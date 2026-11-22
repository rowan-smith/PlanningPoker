import type { AuthorizationContext, Session, Team } from '@planning-poker/domain';
import {
  DomainError,
  findParticipant,
  hasActiveInvitation,
  isAdministrator,
  isPublished,
  isTeamMember,
  isTeamModerator,
} from '@planning-poker/domain';

export function forbid(message = 'You do not have permission to do that.'): never {
  throw new DomainError('FORBIDDEN', message);
}

function sameTenant(actor: AuthorizationContext, tenantId: Team['tenantId']): boolean {
  return actor.tenantId === tenantId;
}

export function canCreateTeams(actor: AuthorizationContext): boolean {
  return actor.role === 'administrator' || actor.role === 'moderator';
}

export function canManageTeam(actor: AuthorizationContext, team: Team): boolean {
  return (
    sameTenant(actor, team.tenantId) &&
    (isAdministrator(actor) || isTeamModerator(team, actor.userId))
  );
}

export function canViewTeam(actor: AuthorizationContext, team: Team): boolean {
  return (
    canManageTeam(actor, team) ||
    (sameTenant(actor, team.tenantId) && isTeamMember(team, actor.userId))
  );
}

/** Administrators, the team's moderators and the session's facilitators may moderate it. */
export function canModerateSession(
  actor: AuthorizationContext,
  session: Session,
  team: Team,
): boolean {
  if (!sameTenant(actor, session.tenantId)) {
    return false;
  }

  return (
    canManageTeam(actor, team) || findParticipant(session, actor.userId)?.isFacilitator === true
  );
}

/** Ordinary members see a session once it is published and they hold an active invitation. */
export function canViewSession(actor: AuthorizationContext, session: Session, team: Team): boolean {
  if (canModerateSession(actor, session, team)) {
    return true;
  }

  const participant = findParticipant(session, actor.userId);

  return (
    sameTenant(actor, session.tenantId) &&
    isPublished(session) &&
    participant !== undefined &&
    hasActiveInvitation(participant)
  );
}

/** Team reports: the team's moderators and administrators. */
export function canViewTeamReport(actor: AuthorizationContext, team: Team): boolean {
  return canManageTeam(actor, team);
}

/** Application-wide reports: administrators only. */
export function canViewAppReport(actor: AuthorizationContext): boolean {
  return isAdministrator(actor);
}
