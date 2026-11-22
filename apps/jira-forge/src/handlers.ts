import type {
  DeckChoice,
  ErrorCode,
  HistoryStatusDto,
  ResolverKey,
  ResolverResult,
  ResolverValue,
  TeamDetailView,
} from '@planning-poker/contracts';
import type {
  DateRange,
  IdentityProvider,
  ReportService,
  SessionService,
  SettingsService,
  TeamService,
} from '@planning-poker/application';
import type {
  AuthorizationContext,
  CardId,
  DeckPreset,
  ParticipationRole,
  SessionId,
  SpecialCardType,
  Team,
  TeamId,
  TicketId,
  UserId,
} from '@planning-poker/domain';
import { asId, DECK_PRESETS, DomainError } from '@planning-poker/domain';
import { DEFAULT_HISTORY_PAGE_SIZE, MAX_HISTORY_PAGE_SIZE } from '@planning-poker/application';

import type { Logger } from './logger';

const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 2000;
const MAX_LIST_LENGTH = 200;
const MAX_QUERY_LENGTH = 1000;
const SPECIAL_CARDS: readonly SpecialCardType[] = ['infinity', 'unknown', 'coffee'];

export interface BackendServices {
  readonly identity: IdentityProvider;
  readonly teams: TeamService;
  readonly settings: SettingsService;
  readonly sessions: SessionService;
  readonly reports: ReportService;
}

export type Handlers = {
  readonly [K in ResolverKey]: (payload: unknown) => Promise<ResolverResult<ResolverValue<K>>>;
};

// ---------------------------------------------------------------------------------------------
// Payload validation: everything from the client is untrusted.
// ---------------------------------------------------------------------------------------------

function invalid(name: string): never {
  throw new DomainError('VALIDATION', `Invalid ${name}.`);
}

function field(payload: unknown, name: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[name]
    : undefined;
}

function text(payload: unknown, name: string, maxLength = MAX_TEXT_LENGTH): string {
  const value = field(payload, name);

  return typeof value === 'string' && value.length <= maxLength ? value : invalid(name);
}

function optionalText(payload: unknown, name: string): string | null {
  const value = field(payload, name);

  return value === null || value === undefined ? null : text(payload, name);
}

function bool(payload: unknown, name: string): boolean {
  const value = field(payload, name);

  return typeof value === 'boolean' ? value : invalid(name);
}

function oneOf<T extends string>(payload: unknown, name: string, allowed: readonly T[]): T {
  const value = field(payload, name);

  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : invalid(name);
}

function textList(payload: unknown, name: string, maxItems = MAX_LIST_LENGTH): string[] {
  const value = field(payload, name);
  const valid =
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_ID_LENGTH);

  return valid ? (value as string[]) : invalid(name);
}

function teamId(payload: unknown): TeamId {
  return asId<TeamId>(text(payload, 'teamId', MAX_ID_LENGTH));
}

function userId(payload: unknown): UserId {
  return asId<UserId>(text(payload, 'userId', MAX_ID_LENGTH));
}

function sessionId(payload: unknown): SessionId {
  return asId<SessionId>(text(payload, 'sessionId', MAX_ID_LENGTH));
}

function ticketId(payload: unknown): TicketId {
  return asId<TicketId>(text(payload, 'ticketId', MAX_ID_LENGTH));
}

function role(payload: unknown): ParticipationRole {
  return oneOf<ParticipationRole>(payload, 'role', ['voter', 'observer']);
}

function deckChoice(payload: unknown): DeckChoice {
  const deck = field(payload, 'deck');
  const kind = field(deck, 'kind');

  if (kind === 'preset') {
    return { kind, preset: oneOf<DeckPreset>(deck, 'preset', DECK_PRESETS) };
  }

  if (kind === 'custom') {
    return {
      kind,
      name: text(deck, 'name', MAX_ID_LENGTH),
      scale: oneOf(deck, 'scale', ['numeric', 'categorical'] as const),
      labels: textList(deck, 'labels'),
    };
  }

  return invalid('deck');
}

function specialCards(payload: unknown): SpecialCardType[] {
  const values = textList(payload, 'specialCards', SPECIAL_CARDS.length);

  return values.every((value) => (SPECIAL_CARDS as readonly string[]).includes(value))
    ? (values as SpecialCardType[])
    : invalid('specialCards');
}

// Milestone 8 — reports: filters and date ranges.

const MAX_DATE_LENGTH = 40;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_LENGTH = 10;
const HISTORY_STATUSES: readonly HistoryStatusDto[] = [
  'active',
  'paused',
  'completed',
  'cancelled',
];

/** `YYYY-MM-DD` is a whole UTC day (start for `from`, end for `to`); otherwise an ISO timestamp. */
function optionalDate(payload: unknown, name: 'from' | 'to'): Date | null {
  const value = field(payload, name);

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string' || value.length > MAX_DATE_LENGTH) {
    return invalid(name);
  }

  if (DATE_ONLY.test(value)) {
    const date = new Date(`${value}T${name === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`);

    // Rejects impossible days such as 2026-02-31, which Date would roll over.
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, DATE_ONLY_LENGTH) === value
      ? date
      : invalid(name);
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? invalid(name) : date;
}

function dateRange(payload: unknown): DateRange {
  const from = optionalDate(payload, 'from');
  const to = optionalDate(payload, 'to');

  if (from !== null && to !== null && from > to) {
    throw new DomainError('VALIDATION', 'The start date must be on or before the end date.');
  }

  return { from, to };
}

function optionalId(payload: unknown, name: string): string | null {
  const value = field(payload, name);

  return value === null || value === undefined ? null : text(payload, name, MAX_ID_LENGTH);
}

function pageSize(payload: unknown): number {
  const value = field(payload, 'limit');

  if (value === undefined || value === null) {
    return DEFAULT_HISTORY_PAGE_SIZE;
  }

  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_HISTORY_PAGE_SIZE
    ? value
    : invalid('limit');
}

function historyFilters(payload: unknown) {
  const team = optionalId(payload, 'teamId');
  const status = field(payload, 'status');

  return {
    ...dateRange(payload),
    teamId: team === null ? null : asId<TeamId>(team),
    status:
      status === null || status === undefined ? null : oneOf(payload, 'status', HISTORY_STATUSES),
    cursor: optionalId(payload, 'cursor'),
    limit: pageSize(payload),
  };
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'VALIDATION',
  'INVALID_STATE',
  'NOT_ELIGIBLE',
  'NOT_FOUND',
  'CONFLICT',
  'FORBIDDEN',
]);

/**
 * Maps each resolver key to a use case. Domain errors become safe messages; anything else is
 * logged (name and message only) and reported as an internal error.
 */
export function createHandlers(services: BackendServices, logger: Logger): Handlers {
  const { teams, settings, sessions, reports } = services;
  const run = async <T>(
    key: ResolverKey,
    work: (actor: AuthorizationContext) => Promise<T>,
  ): Promise<ResolverResult<T>> => {
    try {
      const actor = await services.identity.currentActor();

      return { ok: true, value: await work(actor) };
    } catch (error: unknown) {
      if (error instanceof DomainError && ERROR_CODES.has(error.code)) {
        return { ok: false, error: { code: error.code, message: error.message } };
      }

      logger.error(`Resolver ${key} failed`, error);

      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Something went wrong. Try again.' },
      };
    }
  };
  const teamResult = async (
    actor: AuthorizationContext,
    team: Promise<Team>,
  ): Promise<TeamDetailView> => await teams.teamView(actor, await team);
  /** Runs a session change, then returns the builder view the UI re-renders from. */
  const builderAfter =
    (
      key: ResolverKey,
      change: (actor: AuthorizationContext, id: SessionId, payload: unknown) => Promise<unknown>,
    ) =>
    async (payload: unknown) =>
      await run(key, async (actor) => {
        const id = sessionId(payload);
        await change(actor, id, payload);

        return await sessions.getBuilderView(actor, id);
      });

  return {
    getHome: async () => await run('getHome', async (actor) => await sessions.getHome(actor)),

    // Teams -----------------------------------------------------------------------------------
    listTeams: async () =>
      await run('listTeams', async (actor) => await teams.listTeamViews(actor)),
    getTeam: async (payload) =>
      await run(
        'getTeam',
        async (actor) => await teamResult(actor, teams.getTeam(actor, teamId(payload))),
      ),
    createTeam: async (payload) =>
      await run(
        'createTeam',
        async (actor) =>
          await teamResult(
            actor,
            teams.createTeam(actor, {
              name: text(payload, 'name'),
              description: optionalText(payload, 'description'),
            }),
          ),
      ),
    updateTeam: async (payload) =>
      await run(
        'updateTeam',
        async (actor) =>
          await teamResult(
            actor,
            teams.updateDetails(actor, teamId(payload), {
              name: text(payload, 'name'),
              description: optionalText(payload, 'description'),
            }),
          ),
      ),
    archiveTeam: async (payload) =>
      await run(
        'archiveTeam',
        async (actor) => await teamResult(actor, teams.archive(actor, teamId(payload))),
      ),
    addTeamMember: async (payload) =>
      await run(
        'addTeamMember',
        async (actor) =>
          await teamResult(actor, teams.addMember(actor, teamId(payload), userId(payload))),
      ),
    removeTeamMember: async (payload) =>
      await run(
        'removeTeamMember',
        async (actor) =>
          await teamResult(actor, teams.removeMember(actor, teamId(payload), userId(payload))),
      ),
    assignTeamModerator: async (payload) =>
      await run(
        'assignTeamModerator',
        async (actor) =>
          await teamResult(actor, teams.assignModerator(actor, teamId(payload), userId(payload))),
      ),
    unassignTeamModerator: async (payload) =>
      await run(
        'unassignTeamModerator',
        async (actor) =>
          await teamResult(actor, teams.unassignModerator(actor, teamId(payload), userId(payload))),
      ),
    searchUsers: async (payload) =>
      await run(
        'searchUsers',
        async (actor) => await teams.searchUsers(actor, text(payload, 'query')),
      ),

    // Settings --------------------------------------------------------------------------------
    getSettings: async () =>
      await run('getSettings', async (actor) => await settings.getSettingsView(actor)),
    assignAppModerator: async (payload) =>
      await run(
        'assignAppModerator',
        async (actor) => await settings.assignModerator(actor, userId(payload)),
      ),
    unassignAppModerator: async (payload) =>
      await run(
        'unassignAppModerator',
        async (actor) => await settings.unassignModerator(actor, userId(payload)),
      ),

    // Sessions --------------------------------------------------------------------------------
    listSessions: async () =>
      await run('listSessions', async (actor) => await sessions.listSessions(actor)),
    createSession: async (payload) =>
      await run('createSession', async (actor) => {
        const created = await sessions.createDraft(actor, {
          name: text(payload, 'name'),
          teamId: teamId(payload),
        });

        return await sessions.getBuilderView(actor, created.id);
      }),
    getSessionBuilder: builderAfter('getSessionBuilder', () => Promise.resolve()),
    renameSession: builderAfter(
      'renameSession',
      async (actor, id, payload) => await sessions.rename(actor, id, text(payload, 'name')),
    ),
    configureScoring: builderAfter(
      'configureScoring',
      async (actor, id, payload) =>
        await sessions.configureScoring(actor, id, {
          deck: deckChoice(payload),
          specialCards: specialCards(payload),
          autoFinalize: bool(payload, 'autoFinalize'),
          autoAdvance: bool(payload, 'autoAdvance'),
          allowInvitationsWhileActive: bool(payload, 'allowInvitationsWhileActive'),
        }),
    ),
    inviteParticipant: builderAfter(
      'inviteParticipant',
      async (actor, id, payload) =>
        await sessions.inviteParticipant(actor, id, userId(payload), role(payload)),
    ),
    changeParticipantRole: builderAfter(
      'changeParticipantRole',
      async (actor, id, payload) =>
        await sessions.changeParticipantRole(actor, id, userId(payload), role(payload)),
    ),
    removeParticipant: builderAfter(
      'removeParticipant',
      async (actor, id, payload) => await sessions.removeParticipant(actor, id, userId(payload)),
    ),
    importTickets: async (payload) =>
      await run('importTickets', async (actor) => {
        const id = sessionId(payload);
        const { missing } = await sessions.importByKeys(actor, id, textList(payload, 'keys'));

        return { builder: await sessions.getBuilderView(actor, id), missingKeys: missing };
      }),
    removeTicket: builderAfter(
      'removeTicket',
      async (actor, id, payload) => await sessions.removeTicket(actor, id, ticketId(payload)),
    ),
    reorderTickets: builderAfter(
      'reorderTickets',
      async (actor, id, payload) =>
        await sessions.reorderTickets(
          actor,
          id,
          textList(payload, 'ticketIds').map((entry) => asId<TicketId>(entry)),
        ),
    ),
    searchWorkItems: async (payload) =>
      await run('searchWorkItems', async (actor) => {
        const cursor = field(payload, 'cursor');

        return await sessions.searchWorkItems(
          actor,
          sessionId(payload),
          text(payload, 'query', MAX_QUERY_LENGTH),
          cursor === null ? null : text(payload, 'cursor', MAX_TEXT_LENGTH),
        );
      }),
    suggestQuery: async (payload) =>
      await run(
        'suggestQuery',
        async (actor) =>
          await sessions.suggestQuery(
            actor,
            sessionId(payload),
            text(payload, 'query', MAX_QUERY_LENGTH),
          ),
      ),
    getDisplayFields: async (payload) =>
      await run(
        'getDisplayFields',
        async (actor) => await sessions.getDisplayFields(actor, sessionId(payload)),
      ),
    setDisplayFields: builderAfter(
      'setDisplayFields',
      async (actor, id, payload) =>
        await sessions.setDisplayFields(actor, id, textList(payload, 'fieldIds')),
    ),
    submitVote: async (payload) =>
      await run('submitVote', async (actor) => {
        const id = sessionId(payload);
        await sessions.submitVote(
          actor,
          id,
          ticketId(payload),
          asId<CardId>(text(payload, 'cardId', MAX_ID_LENGTH)),
        );

        return await sessions.getSessionView(actor, id);
      }),
    advanceTicket: async (payload) =>
      await run('advanceTicket', async (actor) => {
        const id = sessionId(payload);
        await sessions.advance(actor, id);

        return await sessions.getSessionView(actor, id);
      }),
    publishSession: async (payload) =>
      await run('publishSession', async (actor) => {
        const id = sessionId(payload);
        await sessions.publish(actor, id);

        return await sessions.getSessionView(actor, id);
      }),
    cancelSession: async (payload) =>
      await run('cancelSession', async (actor) => {
        const id = sessionId(payload);
        await sessions.cancel(actor, id);

        return await sessions.getSessionView(actor, id);
      }),
    getSession: async (payload) =>
      await run(
        'getSession',
        async (actor) => await sessions.getSessionView(actor, sessionId(payload)),
      ),
    respondToInvitation: async (payload) =>
      await run('respondToInvitation', async (actor) => {
        const response = oneOf(payload, 'response', ['joined', 'declined'] as const);
        await sessions.respondToInvitation(actor, sessionId(payload), response);

        return await sessions.getHome(actor);
      }),

    // Milestone 8 — reports ---------------------------------------------------------------------
    listSessionHistory: async (payload) =>
      await run(
        'listSessionHistory',
        async (actor) => await reports.listSessionHistory(actor, historyFilters(payload)),
      ),
    getSessionSummary: async (payload) =>
      await run(
        'getSessionSummary',
        async (actor) => await reports.getSessionSummary(actor, sessionId(payload)),
      ),
    getReportScope: async () =>
      await run('getReportScope', async (actor) => await reports.getReportScope(actor)),
    getTeamReport: async (payload) =>
      await run(
        'getTeamReport',
        async (actor) => await reports.getTeamReport(actor, teamId(payload), dateRange(payload)),
      ),
    getAppReport: async (payload) =>
      await run(
        'getAppReport',
        async (actor) => await reports.getAppReport(actor, dateRange(payload)),
      ),
    listAuditEvents: async (payload) =>
      await run(
        'listAuditEvents',
        async (actor) => await reports.listAuditEvents(actor, sessionId(payload)),
      ),
  };
}
