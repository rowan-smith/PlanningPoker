import type {
  AuditEvent,
  AuthorizationContext,
  FieldValue,
  RoundId,
  Session,
  SessionId,
  Team,
  TeamId,
  TenantId,
  UserId,
  UserIdentity,
  Vote,
  WorkItemReference,
  WorkItemSnapshot,
} from '@planning-poker/domain';
import type { SessionEvent } from '@planning-poker/contracts';

// ---------------------------------------------------------------------------------------------
// Work items (Jira first; any provider later)
// ---------------------------------------------------------------------------------------------

export interface ImportedWorkItem {
  readonly reference: WorkItemReference;
  readonly snapshot: WorkItemSnapshot;
}

export interface WorkItemSearchPage {
  readonly items: readonly ImportedWorkItem[];
  readonly nextCursor: string | null;
}

export interface QuerySuggestion {
  readonly value: string;
  readonly displayName: string;
}

export interface ExternalFieldOption {
  readonly id: string;
  readonly value: string;
}

export interface ExternalField {
  readonly fieldId: string;
  readonly name: string;
  readonly valueType: 'number' | 'option' | 'unsupported';
  /** May be empty when options depend on the item (see `listFieldOptions`). */
  readonly options: readonly ExternalFieldOption[];
}

export interface WorkItemUpdateRequest {
  readonly reference: WorkItemReference;
  readonly fieldId: string;
  readonly value: FieldValue;
  /**
   * The value the field had at import. The provider reports a conflict when the current value
   * differs from it. `undefined` means a moderator confirmed overwriting.
   */
  readonly expectedCurrentValue: FieldValue | null | undefined;
  readonly idempotencyKey: string;
}

/**
 * `ok` also covers a field that already holds the requested value (a retry of a write that
 * landed), so retries never report a conflict with themselves. `failed` is a transient problem
 * (rate limit, outage) worth retrying.
 */
export type UpdateValidation =
  | { readonly status: 'ok' }
  | {
      readonly status: 'forbidden' | 'invalid' | 'conflict' | 'failed';
      readonly message: string;
    };

export type UpdateResult =
  | { readonly status: 'succeeded' }
  | { readonly status: 'failed' | 'conflict'; readonly message: string };

/** Which extra fields to capture in each imported item's snapshot. */
export interface WorkItemFieldSelection {
  /** Shown on tickets; captured as display text keyed by field name. */
  readonly displayFieldIds: readonly string[];
  /** Fields estimates may be written to; captured raw to detect external changes later. */
  readonly valueFieldIds: readonly string[];
}

/**
 * A work-item source. Implementations act with the calling user's permissions, so nobody can
 * import an item they could not otherwise see.
 */
export interface WorkItemProvider {
  readonly providerId: string;
  /** `query` uses the provider's own language (JQL for Jira); the application never parses it. */
  search(
    query: string,
    cursor: string | null,
    fields: WorkItemFieldSelection,
  ): Promise<WorkItemSearchPage>;
  /** Completions for a partially typed query; `value` is the whole completed query. */
  suggestQuery(partialQuery: string): Promise<readonly QuerySuggestion[]>;
  /** Missing keys are ones that do not exist, are malformed or are not visible to the user. */
  getItems(
    keys: readonly string[],
    fields: WorkItemFieldSelection,
  ): Promise<{ readonly found: readonly ImportedWorkItem[]; readonly missing: readonly string[] }>;
  discoverFields(): Promise<readonly ExternalField[]>;
  /**
   * Option values a single-select field accepts on the given items, as the calling user sees
   * them (options can differ by project and item type). Values are unique by `value`.
   */
  listFieldOptions(
    fieldId: string,
    items: readonly WorkItemReference[],
  ): Promise<readonly ExternalFieldOption[]>;
  /** Checks edit permission, the value, and `expectedCurrentValue` (conflict) before a write. */
  validateUpdate(request: WorkItemUpdateRequest): Promise<UpdateValidation>;
  update(request: WorkItemUpdateRequest): Promise<UpdateResult>;
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

export interface IdentityProvider {
  /** The verified actor for the current request. */
  currentActor(): Promise<AuthorizationContext>;
  getUsers(tenantId: TenantId, userIds: readonly UserId[]): Promise<readonly UserIdentity[]>;
  searchUsers(tenantId: TenantId, query: string): Promise<readonly UserIdentity[]>;
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

/** Thrown by repositories when a save is based on a stale version. AtomicOperation retries it. */
export class ConcurrencyConflict extends Error {
  constructor(message = 'The record was changed by someone else.') {
    super(message);
    this.name = 'ConcurrencyConflict';
  }
}

export interface TeamRepository {
  get(tenantId: TenantId, teamId: TeamId): Promise<Team | null>;
  /** Saves if `team.version` matches the stored version; returns the saved (incremented) copy. */
  save(team: Team): Promise<Team>;
  listForTenant(tenantId: TenantId): Promise<readonly Team[]>;
}

export interface SessionRepository {
  get(tenantId: TenantId, sessionId: SessionId): Promise<Session | null>;
  /** Saves if `session.version` matches the stored version; returns the saved (incremented) copy. */
  save(session: Session): Promise<Session>;
  listForTeams(tenantId: TenantId, teamIds: readonly TeamId[]): Promise<readonly Session[]>;
  listByIds(tenantId: TenantId, sessionIds: readonly SessionId[]): Promise<readonly Session[]>;
}

/** Index of who is on which session roster, so a user's sessions and invitations can be found. */
export interface ParticipantRepository {
  replaceForSession(session: Session): Promise<void>;
  listSessionIdsForUser(tenantId: TenantId, userId: UserId): Promise<readonly SessionId[]>;
}

/** Private votes. Only the application reads individual records; clients never do. */
export interface VoteRepository {
  upsert(tenantId: TenantId, vote: Vote): Promise<void>;
  /**
   * Votes in a round from the given voters. Reads by voter so implementations can use strongly
   * consistent key lookups: the reveal check must never miss a vote that was already written.
   */
  listForRound(
    tenantId: TenantId,
    roundId: RoundId,
    voterIds: readonly UserId[],
  ): Promise<readonly Vote[]>;
  listForVoter(
    tenantId: TenantId,
    userId: UserId,
    roundIds: readonly RoundId[],
  ): Promise<readonly Vote[]>;
  remove(tenantId: TenantId, roundId: RoundId, userId: UserId): Promise<void>;
}

/** Application-wide configuration, kept per installation. */
export interface ApplicationSettings {
  readonly tenantId: TenantId;
  /** Users granted the application-level moderator role (may create teams). */
  readonly moderatorUserIds: readonly UserId[];
  /** Work-item fields moderators may write estimates to (the administrator's allowlist). */
  readonly writableFieldIds: readonly string[];
  readonly version: number;
}

export interface ApplicationSettingsRepository {
  get(tenantId: TenantId): Promise<ApplicationSettings>;
  /** Saves if `settings.version` matches the stored version; returns the saved copy. */
  save(settings: ApplicationSettings): Promise<ApplicationSettings>;
}

export interface AuditRepository {
  append(events: readonly AuditEvent[]): Promise<void>;
  listForSession(tenantId: TenantId, sessionId: SessionId): Promise<readonly AuditEvent[]>;
}

// ---------------------------------------------------------------------------------------------
// Coordination
// ---------------------------------------------------------------------------------------------

export interface EventPublisher {
  /** Publishes to subscribers authorized for the session. Events must carry no hidden state. */
  publish(tenantId: TenantId, sessionId: SessionId, event: SessionEvent): Promise<void>;
}

/**
 * Runs an operation exclusively per key (e.g. per session), retrying on ConcurrencyConflict.
 * Implementations may use locks or conditional writes.
 */
export interface AtomicOperation {
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
