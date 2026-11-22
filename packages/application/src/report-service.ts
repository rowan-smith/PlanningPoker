import type {
  AppReportView,
  AuditDetailView,
  AuditEventView,
  AuditLogView,
  HistoryStatusDto,
  ParticipantCategoriesView,
  PersonView,
  ReportScopeView,
  ReportTotalsView,
  SessionHistoryItemView,
  SessionHistoryView,
  SessionReportView,
  TeamReportView,
  TicketSummaryView,
} from '@planning-poker/contracts';
import type {
  AuditDetailValue,
  AuditEvent,
  AuthorizationContext,
  ParticipantCategories,
  Session,
  SessionId,
  SessionSummary,
  SessionTotals,
  Team,
  TeamId,
  TicketSummary,
  UserId,
  UserIdentity,
} from '@planning-poker/domain';
import {
  combineTotals,
  disagreementHistory,
  DomainError,
  findTicket,
  isEditable,
  overrideHistory,
  participantCategories,
  participantStatistics,
  sessionDate,
  summarizeSession,
} from '@planning-poker/domain';

import {
  canModerateSession,
  canViewAppReport,
  canViewSession,
  canViewTeam,
  canViewTeamReport,
  forbid,
} from './authorization';
import type { ApplicationDependencies } from './dependencies';
import { displayName } from './views';
import { redactRestrictedTickets, redactRestrictedTicketsOf } from './work-item-visibility';

export interface DateRange {
  /** Inclusive start, or null for no lower bound. */
  readonly from: Date | null;
  /** Inclusive end, or null for no upper bound. */
  readonly to: Date | null;
}

export interface HistoryFilters extends DateRange {
  readonly teamId: TeamId | null;
  readonly status: HistoryStatusDto | null;
  /** Opaque paging cursor returned by the previous page. */
  readonly cursor: string | null;
  readonly limit: number;
}

export const DEFAULT_HISTORY_PAGE_SIZE = 25;
export const MAX_HISTORY_PAGE_SIZE = 100;

/**
 * Audit detail keys that could carry a card choice. Audit events never pair a person with a
 * vote, but views drop these keys anyway so a future event cannot leak one by accident.
 */
const VOTE_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'cardId',
  'card',
  'vote',
  'votes',
  'value',
  'values',
  'label',
]);

type ReportDependencies = Pick<
  ApplicationDependencies,
  'teams' | 'sessions' | 'participants' | 'audit' | 'identity' | 'workItems'
>;

type Users = ReadonlyMap<UserId, UserIdentity>;

function inRange(date: Date | null, range: DateRange): boolean {
  if (date === null) {
    return false;
  }

  return (range.from === null || date >= range.from) && (range.to === null || date <= range.to);
}

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

function person(users: Users, userId: UserId): PersonView {
  return { userId, displayName: displayName(users, userId) };
}

function people(users: Users, userIds: readonly UserId[]): PersonView[] {
  return userIds
    .map((userId) => person(users, userId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function categoriesView(
  users: Users,
  categories: ParticipantCategories,
): ParticipantCategoriesView {
  return {
    invited: people(users, categories.invited),
    joined: people(users, categories.joined),
    declined: people(users, categories.declined),
    revoked: people(users, categories.revoked),
    noResponse: people(users, categories.noResponse),
    voting: people(users, categories.voting),
    observing: people(users, categories.observing),
    skipped: people(users, categories.skipped),
    facilitators: people(users, categories.facilitators),
  };
}

function totalsView(totals: SessionTotals): ReportTotalsView {
  return { ...totals, sync: { ...totals.sync } };
}

function ticketView(users: Users, ticket: TicketSummary): TicketSummaryView {
  const { decision } = ticket;

  return {
    id: ticket.ticketId,
    order: ticket.order,
    displayKey: ticket.displayKey,
    url: ticket.url,
    title: ticket.title,
    outcome: ticket.outcome,
    revealedRounds: ticket.revealedRounds.map((round) => ({
      number: round.number,
      outcome: round.outcome,
      voteCount: round.voteCount,
      distribution: round.distribution.map((entry) => ({ ...entry })),
      revealedAt: iso(round.revealedAt),
    })),
    revotes: ticket.revotes,
    disagreements: ticket.disagreements,
    unanimous: ticket.unanimous,
    decision:
      decision === null
        ? null
        : {
            kind: decision.kind,
            label: decision.label,
            reason: decision.reason,
            decidedByName:
              decision.decidedBy === null ? null : displayName(users, decision.decidedBy),
            decidedAt: decision.decidedAt.toISOString(),
          },
    skippedVoters: people(users, ticket.skippedVoters),
    sync: { ...ticket.sync },
  };
}

function historyItem(
  session: Session,
  team: Team,
  summary: SessionSummary,
): SessionHistoryItemView {
  return {
    id: session.id,
    name: session.name,
    teamId: team.id,
    teamName: team.name,
    status: session.status,
    date: sessionDate(session).toISOString(),
    startedAt: iso(session.publishedAt),
    completedAt: iso(session.completedAt),
    tickets: summary.totals.tickets,
    estimated: summary.totals.estimated,
    skipped: summary.totals.skipped,
    unresolved: summary.totals.unresolved,
  };
}

function detailText(value: AuditDetailValue): string {
  if (value === null) {
    return '—';
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  return String(value);
}

export function safeAuditDetails(
  details: Readonly<Record<string, AuditDetailValue>>,
): AuditDetailView[] {
  return Object.entries(details)
    .filter(([key]) => !VOTE_DETAIL_KEYS.has(key))
    .map(([key, value]) => ({ key, value: detailText(value) }));
}

function parseCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }

  const offset = Number(cursor);

  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new DomainError('VALIDATION', 'Invalid cursor.');
  }

  return offset;
}

/** People who took part: everyone who joined, plus facilitators. */
function takingPart(categories: ParticipantCategories): UserId[] {
  return [...categories.joined, ...categories.facilitators];
}

/**
 * Session history, completed-session summaries, team and application reports, and audit logs.
 * Everything is computed from session aggregates and audit events; individual votes are never
 * read, so no report can pair a person with a vote value.
 */
export class ReportService {
  private readonly deps: ReportDependencies;

  constructor(deps: ReportDependencies) {
    this.deps = deps;
  }

  /** Published (and cancelled) sessions the actor can view, newest first, filtered and paged. */
  async listSessionHistory(
    actor: AuthorizationContext,
    filters: HistoryFilters,
  ): Promise<SessionHistoryView> {
    const offset = parseCursor(filters.cursor);
    const limit = Math.min(Math.max(1, filters.limit), MAX_HISTORY_PAGE_SIZE);
    const visible = (await this.visibleSessions(actor)).filter(
      ({ session }) => !isEditable(session),
    );
    const teamsById = new Map(visible.map(({ team }) => [team.id, team]));
    const matching = visible
      .filter(
        ({ session }) =>
          (filters.teamId === null || session.teamId === filters.teamId) &&
          (filters.status === null || session.status === filters.status) &&
          inRange(sessionDate(session), filters),
      )
      .sort((a, b) => sessionDate(b.session).getTime() - sessionDate(a.session).getTime());
    const page = matching.slice(offset, offset + limit);

    return {
      items: page.map(({ session, team }) => historyItem(session, team, summarizeSession(session))),
      total: matching.length,
      nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
      teams: [...teamsById.values()]
        .map((team) => ({ id: team.id, name: team.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** The summary of one published session, for anyone who can view the session. */
  async getSessionSummary(
    actor: AuthorizationContext,
    sessionId: SessionId,
  ): Promise<SessionReportView> {
    const loaded = await this.loadViewable(actor, sessionId);
    const { team } = loaded;
    const session = await redactRestrictedTicketsOf(this.deps.workItems, loaded.session);

    if (isEditable(session)) {
      throw new DomainError(
        'INVALID_STATE',
        'A summary is available once the session is published.',
      );
    }

    const summary = summarizeSession(session);
    const users = await this.usersById(actor, [
      session.createdBy,
      ...session.participants.map((participant) => participant.userId),
      ...summary.tickets.flatMap((ticket) => {
        const decidedBy = ticket.decision?.decidedBy ?? null;

        return decidedBy === null ? [] : [decidedBy];
      }),
    ]);

    return {
      id: session.id,
      name: session.name,
      teamId: team.id,
      teamName: team.name,
      status: session.status,
      moderator: person(users, summary.moderatorId),
      createdAt: summary.createdAt.toISOString(),
      startedAt: iso(summary.startedAt),
      completedAt: iso(summary.completedAt),
      participants: categoriesView(users, summary.participants),
      tickets: summary.tickets.map((ticket) => ticketView(users, ticket)),
      totals: totalsView(summary.totals),
      canViewAudit: canModerateSession(actor, session, team),
    };
  }

  /** Which reports the actor may open. */
  async getReportScope(actor: AuthorizationContext): Promise<ReportScopeView> {
    const teams = await this.deps.teams.listForTenant(actor.tenantId);

    return {
      teams: teams
        .filter((team) => canViewTeamReport(actor, team))
        .map((team) => ({ id: team.id, name: team.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      canViewAppReport: canViewAppReport(actor),
    };
  }

  /** Completed sessions of one team in a date range. Team moderators and administrators. */
  async getTeamReport(
    actor: AuthorizationContext,
    teamId: TeamId,
    range: DateRange,
  ): Promise<TeamReportView> {
    const team = await this.deps.teams.get(actor.tenantId, teamId);

    if (team === null || !canViewTeam(actor, team)) {
      throw new DomainError('NOT_FOUND', 'Team not found.');
    }

    if (!canViewTeamReport(actor, team)) {
      forbid('Only team moderators and administrators can see team reports.');
    }

    const sessions = await this.completedSessions(actor, [team.id], range);
    const summaries = sessions.map(summarizeSession);
    const statistics = participantStatistics(sessions);
    const disagreements = disagreementHistory(summaries);
    const overrides = overrideHistory(summaries);
    const names = new Map(sessions.map((session) => [session.id, session.name]));
    const users = await this.usersById(actor, [
      ...statistics.map((entry) => entry.userId),
      ...overrides.flatMap((entry) => (entry.decidedBy === null ? [] : [entry.decidedBy])),
    ]);
    const sessionName = (id: SessionId): string => names.get(id) ?? '';

    return {
      teamId: team.id,
      teamName: team.name,
      from: iso(range.from),
      to: iso(range.to),
      sessions: sessions.map((session) => historyItem(session, team, summarizeSession(session))),
      totals: totalsView(combineTotals(summaries.map((summary) => summary.totals))),
      participants: statistics
        .map(({ userId, ...counts }) => ({ person: person(users, userId), ...counts }))
        .sort((a, b) => a.person.displayName.localeCompare(b.person.displayName)),
      disagreements: disagreements.map((entry) => ({
        sessionId: entry.sessionId,
        sessionName: sessionName(entry.sessionId),
        displayKey: entry.displayKey,
        title: entry.title,
        disagreements: entry.disagreements,
        revotes: entry.revotes,
        outcome: entry.outcome,
        finalLabel: entry.finalLabel,
        decisionKind: entry.decisionKind,
      })),
      overrides: overrides.map((entry) => ({
        sessionId: entry.sessionId,
        sessionName: sessionName(entry.sessionId),
        displayKey: entry.displayKey,
        title: entry.title,
        label: entry.label,
        reason: entry.reason,
        decidedByName: entry.decidedBy === null ? null : displayName(users, entry.decidedBy),
        decidedAt: entry.decidedAt.toISOString(),
      })),
    };
  }

  /** Completed sessions across every team in a date range. Administrators only. */
  async getAppReport(actor: AuthorizationContext, range: DateRange): Promise<AppReportView> {
    if (!canViewAppReport(actor)) {
      forbid('Only administrators can see application reports.');
    }

    const teams = await this.deps.teams.listForTenant(actor.tenantId);
    const sessions = await this.completedSessions(
      actor,
      teams.map((team) => team.id),
      range,
    );
    const summaries = new Map(sessions.map((session) => [session.id, summarizeSession(session)]));
    const allParticipants = new Set<UserId>();
    const rows = teams.map((team) => {
      const teamSessions = sessions.filter((session) => session.teamId === team.id);
      const teamParticipants = new Set(
        teamSessions.flatMap((session) => takingPart(participantCategories(session))),
      );

      for (const userId of teamParticipants) {
        allParticipants.add(userId);
      }

      return {
        teamId: team.id,
        teamName: team.name,
        archived: team.archived,
        sessionCount: teamSessions.length,
        participantCount: teamParticipants.size,
        totals: totalsView(
          combineTotals(
            teamSessions.flatMap((session) => {
              const summary = summaries.get(session.id);

              return summary === undefined ? [] : [summary.totals];
            }),
          ),
        ),
      };
    });

    return {
      from: iso(range.from),
      to: iso(range.to),
      sessionCount: sessions.length,
      participantCount: allParticipants.size,
      totals: totalsView(combineTotals([...summaries.values()].map((summary) => summary.totals))),
      teams: rows.sort((a, b) => a.teamName.localeCompare(b.teamName)),
    };
  }

  /** A session's audit trail, oldest first. Moderators only; details never include votes. */
  async listAuditEvents(actor: AuthorizationContext, sessionId: SessionId): Promise<AuditLogView> {
    const { session, team } = await this.loadViewable(actor, sessionId);

    if (!canModerateSession(actor, session, team)) {
      forbid('Only moderators can see the audit log.');
    }

    const events = [...(await this.deps.audit.listForSession(actor.tenantId, session.id))].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
    const users = await this.usersById(
      actor,
      events.flatMap((event) =>
        [event.actorId, event.subjectUserId].filter((id): id is UserId => id !== null),
      ),
    );

    return {
      sessionId: session.id,
      sessionName: session.name,
      events: events.map((event) => this.auditView(session, users, event)),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private auditView(session: Session, users: Users, event: AuditEvent): AuditEventView {
    const ticket = event.ticketId === null ? undefined : findTicket(session, event.ticketId);

    return {
      id: event.id,
      type: event.type,
      actorName: event.actorId === null ? null : displayName(users, event.actorId),
      subjectName: event.subjectUserId === null ? null : displayName(users, event.subjectUserId),
      ticketDisplayKey: ticket?.reference.displayKey ?? null,
      occurredAt: event.occurredAt.toISOString(),
      details: safeAuditDetails(event.details),
    };
  }

  private async completedSessions(
    actor: AuthorizationContext,
    teamIds: readonly TeamId[],
    range: DateRange,
  ): Promise<Session[]> {
    const sessions = await this.deps.sessions.listForTeams(actor.tenantId, teamIds);
    const completed = sessions
      .filter((session) => session.status === 'completed' && inRange(session.completedAt, range))
      .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));

    // Reports list ticket titles (disagreements, overrides): only for items the actor can see.
    return await redactRestrictedTickets(this.deps.workItems, completed);
  }

  /** Same rule as the session list: moderated teams' sessions plus the actor's own sessions. */
  private async visibleSessions(
    actor: AuthorizationContext,
  ): Promise<{ session: Session; team: Team }[]> {
    const teams = await this.deps.teams.listForTenant(actor.tenantId);
    const teamsById = new Map(teams.map((team) => [team.id, team]));
    const moderatedTeamIds = teams
      .filter((team) => canViewTeamReport(actor, team))
      .map((team) => team.id);
    const participantSessionIds = await this.deps.participants.listSessionIdsForUser(
      actor.tenantId,
      actor.userId,
    );
    const candidates = [
      ...(await this.deps.sessions.listForTeams(actor.tenantId, moderatedTeamIds)),
      ...(await this.deps.sessions.listByIds(actor.tenantId, participantSessionIds)),
    ];
    const unique = [...new Map(candidates.map((session) => [session.id, session])).values()];

    return unique.flatMap((session) => {
      const team = teamsById.get(session.teamId);

      return team !== undefined && canViewSession(actor, session, team) ? [{ session, team }] : [];
    });
  }

  private async loadViewable(
    actor: AuthorizationContext,
    sessionId: SessionId,
  ): Promise<{ session: Session; team: Team }> {
    const session = await this.deps.sessions.get(actor.tenantId, sessionId);
    const team =
      session === null ? null : await this.deps.teams.get(actor.tenantId, session.teamId);

    // Same error for missing and unauthorized sessions, so IDs cannot be probed.
    if (session === null || team === null || !canViewSession(actor, session, team)) {
      throw new DomainError('NOT_FOUND', 'Session not found.');
    }

    return { session, team };
  }

  private async usersById(actor: AuthorizationContext, userIds: readonly UserId[]): Promise<Users> {
    const users = await this.deps.identity.getUsers(actor.tenantId, [...new Set(userIds)]);

    return new Map(users.map((user) => [user.id, user]));
  }
}
