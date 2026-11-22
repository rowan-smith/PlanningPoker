/**
 * Data shared between the backend and UI clients. Plain JSON-safe types only: dates are ISO
 * strings, IDs are strings. Nothing here may pair a person with a vote value.
 */

export type ApplicationRoleDto = 'administrator' | 'moderator' | 'member';
export type ParticipationRoleDto = 'voter' | 'observer';
export type InvitationStatusDto = 'invited' | 'joined' | 'declined' | 'revoked';
export type SessionStatusDto = 'draft' | 'ready' | 'active' | 'paused' | 'completed' | 'cancelled';
export type TicketVotingStateDto =
  'pending' | 'voting' | 'revealed' | 'revoting' | 'finalized' | 'skipped' | 'unresolved';
export type RoundStatusDto = 'pending' | 'open' | 'revealed' | 'superseded';
export type SyncStateDto =
  'not-required' | 'pending' | 'syncing' | 'succeeded' | 'failed' | 'conflict';
export type CardKindDto = 'numeric' | 'category' | 'special';

export interface CurrentUserView {
  readonly userId: string;
  readonly displayName: string;
  readonly role: ApplicationRoleDto;
}

export interface SessionSummaryView {
  readonly id: string;
  readonly name: string;
  readonly teamName: string;
  readonly status: SessionStatusDto;
  readonly currentTicketTitle: string | null;
  readonly myRole: ParticipationRoleDto | null;
  readonly canModerate: boolean;
}

export interface InvitationView {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly teamName: string;
  readonly role: ParticipationRoleDto;
  readonly invitedByName: string;
  readonly invitedAt: string;
}

export interface HomeView {
  readonly user: CurrentUserView;
  readonly activeSessions: readonly SessionSummaryView[];
  readonly pendingInvitations: readonly InvitationView[];
}

export interface CardView {
  readonly id: string;
  readonly label: string;
  readonly kind: CardKindDto;
}

export type VoteStatusDto = 'voted' | 'pending' | 'not-required';

export interface ParticipantView {
  readonly userId: string;
  readonly displayName: string;
  readonly role: ParticipationRoleDto;
  readonly isFacilitator: boolean;
  readonly invitationStatus: InvitationStatusDto;
  readonly skippedForSession: boolean;
  readonly skippedForCurrentTicket: boolean;
  /** Whether this person has voted in the current round. Never what they voted. */
  readonly voteStatus: VoteStatusDto;
}

export interface CardCountView {
  readonly cardId: string;
  readonly label: string;
  readonly count: number;
}

export interface RoundResultView {
  readonly outcome: 'unanimous' | 'disputed';
  readonly voteCount: number;
  readonly distribution: readonly CardCountView[];
  readonly values: readonly string[];
  readonly requiresModeratorResolution: boolean;
}

export interface RoundView {
  readonly roundId: string;
  readonly number: number;
  readonly status: RoundStatusDto;
  readonly requiredCount: number;
  readonly votedCount: number;
  readonly result: RoundResultView | null;
}

/** The write of a final estimate to the work item. Independent of the voting state. */
export interface SyncView {
  readonly state: SyncStateDto;
  readonly fieldName: string | null;
  /** The value being written, as text (a number or an option name). */
  readonly value: string | null;
  /** The last attempt's outcome message (failure or conflict reason). */
  readonly message: string | null;
  readonly attemptCount: number;
  /**
   * When a moderator may retry (ISO time), or null when retrying is not possible. Failed and
   * conflicting writes can be retried at once; a write stuck in `syncing` only after a timeout.
   */
  readonly retryAvailableAt: string | null;
}

export interface EstimateView {
  readonly label: string;
  readonly kind: 'consensus' | 'override';
  readonly reason: string | null;
}

export interface TicketView {
  readonly id: string;
  readonly order: number;
  readonly displayKey: string;
  readonly url: string | null;
  readonly title: string;
  /** Plain text. Render as text, never as HTML. */
  readonly description: string | null;
  readonly itemType: string | null;
  readonly status: string | null;
  readonly displayFields: Readonly<Record<string, string>>;
  readonly votingState: TicketVotingStateDto;
  readonly round: RoundView | null;
  /** The viewer's own choice for this ticket's latest round, visible only to them. */
  readonly myVoteCardId: string | null;
  readonly estimate: EstimateView | null;
  readonly syncState: SyncStateDto;
  /** Where and how the final estimate is being written (Milestone 7). */
  readonly sync: SyncView;
}

export interface SessionViewerView {
  readonly userId: string;
  readonly role: ParticipationRoleDto | null;
  /** Null for facilitators and people who are not on the roster. */
  readonly invitationStatus: InvitationStatusDto | null;
  readonly canVoteOnCurrentTicket: boolean;
  /** Whether the viewer may vote now on upcoming tickets (hidden until each one reveals). */
  readonly canPreVote: boolean;
  readonly canModerate: boolean;
}

export interface SessionView {
  readonly id: string;
  readonly name: string;
  readonly teamName: string;
  readonly status: SessionStatusDto;
  readonly deck: readonly CardView[];
  readonly participants: readonly ParticipantView[];
  readonly tickets: readonly TicketView[];
  readonly currentTicketId: string | null;
  readonly viewer: SessionViewerView;
}

/**
 * Realtime notifications. They carry no hidden state: clients re-fetch the authorized
 * session view when one arrives, and after reconnecting.
 */
export type SessionEvent =
  | { readonly type: 'session.activated' }
  | { readonly type: 'session.status-changed'; readonly status: SessionStatusDto }
  | { readonly type: 'participant.changed'; readonly userId: string }
  | {
      readonly type: 'vote.status';
      readonly ticketId: string;
      readonly votedCount: number;
      readonly requiredCount: number;
    }
  | { readonly type: 'ticket.current-changed'; readonly ticketId: string }
  | { readonly type: 'round.started'; readonly ticketId: string }
  | { readonly type: 'round.revealed'; readonly ticketId: string }
  | { readonly type: 'estimate.finalized'; readonly ticketId: string }
  | { readonly type: 'sync.completed'; readonly ticketId: string; readonly state: SyncStateDto };

// ---------------------------------------------------------------------------------------------
// Teams, users and settings
// ---------------------------------------------------------------------------------------------

export interface UserView {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface TeamSummaryView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly memberCount: number;
  readonly archived: boolean;
  readonly canManage: boolean;
}

export interface TeamMemberView extends UserView {
  readonly isModerator: boolean;
}

export interface TeamDetailView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly archived: boolean;
  readonly members: readonly TeamMemberView[];
  readonly canManage: boolean;
  readonly canAssignModerators: boolean;
}

export interface TeamListView {
  readonly teams: readonly TeamSummaryView[];
  readonly canCreateTeams: boolean;
}

export interface SettingsView {
  readonly canAdminister: boolean;
  readonly moderators: readonly UserView[];
}

// ---------------------------------------------------------------------------------------------
// Session builder
// ---------------------------------------------------------------------------------------------

export type DeckPresetDto = 'fibonacci' | 'modified-fibonacci' | 'powers-of-two' | 't-shirt';
export type SpecialCardDto = 'infinity' | 'unknown' | 'coffee';

export type DeckChoice =
  | { readonly kind: 'preset'; readonly preset: DeckPresetDto }
  | {
      readonly kind: 'custom';
      readonly name: string;
      readonly scale: 'numeric' | 'categorical';
      readonly labels: readonly string[];
    };

export interface ScoringSettingsView {
  readonly deck: DeckChoice;
  readonly deckName: string;
  readonly cards: readonly CardView[];
  readonly specialCards: readonly SpecialCardDto[];
  readonly autoFinalize: boolean;
  readonly autoAdvance: boolean;
  readonly allowInvitationsWhileActive: boolean;
}

export interface ReadinessIssueView {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface SessionBuilderView {
  readonly session: SessionView;
  readonly teamId: string;
  readonly scoring: ScoringSettingsView;
  readonly readiness: { readonly ready: boolean; readonly issues: readonly ReadinessIssueView[] };
  /** Team members not yet on the roster. */
  readonly suggestedParticipants: readonly UserView[];
}

export interface TeamOptionView {
  readonly id: string;
  readonly name: string;
}

export interface SessionListView {
  readonly sessions: readonly SessionSummaryView[];
  /** Teams the user can create sessions for; empty means they cannot create sessions. */
  readonly teams: readonly TeamOptionView[];
}

export interface WorkItemPreviewView {
  readonly key: string;
  readonly title: string;
  readonly itemType: string | null;
  readonly status: string | null;
  readonly alreadyAdded: boolean;
}

export interface WorkItemSearchView {
  readonly items: readonly WorkItemPreviewView[];
  readonly nextCursor: string | null;
}

export interface QuerySuggestionView {
  /** The complete query to use if this suggestion is picked. */
  readonly value: string;
  readonly displayName: string;
}

export interface FieldOptionView {
  readonly id: string;
  readonly name: string;
}

export interface DisplayFieldsView {
  readonly available: readonly FieldOptionView[];
  readonly selectedIds: readonly string[];
}

/** A work-item field estimates can be written to. */
export interface WritableFieldView {
  readonly id: string;
  readonly name: string;
  readonly valueType: 'number' | 'option';
}

/** The administrator's allowlist of fields that sessions may write estimates to. */
export interface FieldAllowlistView {
  /** Number and single-select fields discovered from the work-item provider. */
  readonly available: readonly WritableFieldView[];
  readonly selectedIds: readonly string[];
}

export interface DestinationFieldView {
  readonly fieldId: string;
  readonly fieldName: string;
  readonly valueType: 'number' | 'option';
  /** Card ID → option value, for single-select fields. */
  readonly optionByCardId: Readonly<Record<string, string>>;
}

export interface FieldMappingView {
  /** Allowlisted fields the moderator can choose from. */
  readonly allowed: readonly WritableFieldView[];
  readonly destination: DestinationFieldView | null;
  /** Option values the destination accepts on this session's tickets (single-select only). */
  readonly options: readonly string[];
}

export interface FieldMappingResultView {
  readonly builder: SessionBuilderView;
  readonly mapping: FieldMappingView;
}

export interface ImportTicketsView {
  readonly builder: SessionBuilderView;
  readonly missingKeys: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Resolver API
// ---------------------------------------------------------------------------------------------

export type EmptyPayload = Readonly<Record<string, never>>;

export interface TeamPayload {
  readonly teamId: string;
}

export interface TeamMemberPayload extends TeamPayload {
  readonly userId: string;
}

export interface SessionPayload {
  readonly sessionId: string;
}

export interface SessionParticipantPayload extends SessionPayload {
  readonly userId: string;
}

export interface SessionRolePayload extends SessionParticipantPayload {
  readonly role: ParticipationRoleDto;
}

export interface ScoringPayload extends SessionPayload {
  readonly deck: DeckChoice;
  readonly specialCards: readonly SpecialCardDto[];
  readonly autoFinalize: boolean;
  readonly autoAdvance: boolean;
  readonly allowInvitationsWhileActive: boolean;
}

export interface TeamDetailsPayload {
  readonly name: string;
  readonly description: string | null;
}

/**
 * Every backend function the UI can call: payload in, view out. The Forge resolver implements
 * these; any other backend can too.
 */
export interface PlanningPokerResolvers {
  getHome: (payload: EmptyPayload) => HomeView;
  listTeams: (payload: EmptyPayload) => TeamListView;
  getTeam: (payload: TeamPayload) => TeamDetailView;
  createTeam: (payload: TeamDetailsPayload) => TeamDetailView;
  updateTeam: (payload: TeamPayload & TeamDetailsPayload) => TeamDetailView;
  archiveTeam: (payload: TeamPayload) => TeamDetailView;
  addTeamMember: (payload: TeamMemberPayload) => TeamDetailView;
  removeTeamMember: (payload: TeamMemberPayload) => TeamDetailView;
  assignTeamModerator: (payload: TeamMemberPayload) => TeamDetailView;
  unassignTeamModerator: (payload: TeamMemberPayload) => TeamDetailView;
  searchUsers: (payload: { readonly query: string }) => readonly UserView[];
  getSettings: (payload: EmptyPayload) => SettingsView;
  assignAppModerator: (payload: { readonly userId: string }) => SettingsView;
  unassignAppModerator: (payload: { readonly userId: string }) => SettingsView;
  listSessions: (payload: EmptyPayload) => SessionListView;
  createSession: (payload: {
    readonly name: string;
    readonly teamId: string;
  }) => SessionBuilderView;
  getSessionBuilder: (payload: SessionPayload) => SessionBuilderView;
  renameSession: (payload: SessionPayload & { readonly name: string }) => SessionBuilderView;
  configureScoring: (payload: ScoringPayload) => SessionBuilderView;
  inviteParticipant: (payload: SessionRolePayload) => SessionBuilderView;
  changeParticipantRole: (payload: SessionRolePayload) => SessionBuilderView;
  removeParticipant: (payload: SessionParticipantPayload) => SessionBuilderView;
  importTickets: (
    payload: SessionPayload & { readonly keys: readonly string[] },
  ) => ImportTicketsView;
  removeTicket: (payload: SessionPayload & { readonly ticketId: string }) => SessionBuilderView;
  reorderTickets: (
    payload: SessionPayload & { readonly ticketIds: readonly string[] },
  ) => SessionBuilderView;
  searchWorkItems: (
    payload: SessionPayload & { readonly query: string; readonly cursor: string | null },
  ) => WorkItemSearchView;
  suggestQuery: (
    payload: SessionPayload & { readonly query: string },
  ) => readonly QuerySuggestionView[];
  getDisplayFields: (payload: SessionPayload) => DisplayFieldsView;
  setDisplayFields: (
    payload: SessionPayload & { readonly fieldIds: readonly string[] },
  ) => SessionBuilderView;
  submitVote: (
    payload: SessionPayload & { readonly ticketId: string; readonly cardId: string },
  ) => SessionView;
  advanceTicket: (payload: SessionPayload) => SessionView;
  publishSession: (payload: SessionPayload) => SessionView;
  cancelSession: (payload: SessionPayload) => SessionView;
  getSession: (payload: SessionPayload) => SessionView;
  respondToInvitation: (
    payload: SessionPayload & { readonly response: 'joined' | 'declined' },
  ) => HomeView;

  // Milestone 7 — Jira fields ------------------------------------------------------------------
  getFieldAllowlist: (payload: EmptyPayload) => FieldAllowlistView;
  setFieldAllowlist: (payload: { readonly fieldIds: readonly string[] }) => FieldAllowlistView;
  getFieldMapping: (payload: SessionPayload) => FieldMappingView;
  /** `fieldId: null` clears the destination. */
  setFieldMapping: (
    payload: SessionPayload & {
      readonly fieldId: string | null;
      readonly optionByCardId: Readonly<Record<string, string>>;
    },
  ) => FieldMappingResultView;
  retrySync: (
    payload: SessionPayload & { readonly ticketId: string; readonly confirmOverwrite: boolean },
  ) => SessionView;
}

export type ResolverKey = keyof PlanningPokerResolvers;
export type ResolverPayload<K extends ResolverKey> = Parameters<PlanningPokerResolvers[K]>[0];
export type ResolverValue<K extends ResolverKey> = ReturnType<PlanningPokerResolvers[K]>;

export type ErrorCode =
  | 'VALIDATION'
  | 'INVALID_STATE'
  | 'NOT_ELIGIBLE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'INTERNAL';

/** Resolvers never throw to the client: failures come back as a code and a safe message. */
export type ResolverResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } };

export const RESOLVER_KEYS = [
  'getHome',
  'listTeams',
  'getTeam',
  'createTeam',
  'updateTeam',
  'archiveTeam',
  'addTeamMember',
  'removeTeamMember',
  'assignTeamModerator',
  'unassignTeamModerator',
  'searchUsers',
  'getSettings',
  'assignAppModerator',
  'unassignAppModerator',
  'listSessions',
  'createSession',
  'getSessionBuilder',
  'renameSession',
  'configureScoring',
  'inviteParticipant',
  'changeParticipantRole',
  'removeParticipant',
  'importTickets',
  'removeTicket',
  'reorderTickets',
  'searchWorkItems',
  'suggestQuery',
  'getDisplayFields',
  'setDisplayFields',
  'submitVote',
  'advanceTicket',
  'publishSession',
  'cancelSession',
  'getSession',
  'respondToInvitation',
  // Milestone 7 — Jira fields
  'getFieldAllowlist',
  'setFieldAllowlist',
  'getFieldMapping',
  'setFieldMapping',
  'retrySync',
] as const satisfies readonly ResolverKey[];

/**
 * The realtime channel for one session. Events on it are notifications only: subscribers
 * re-fetch their own authorized view.
 */
export function sessionChannel(sessionId: string): string {
  return `planning-poker-session-${sessionId}`;
}
