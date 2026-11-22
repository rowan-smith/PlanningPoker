/**
 * In-memory adapters for tests and local development. They implement the same ports as the
 * Forge adapters, so every domain and application test runs without Jira or Forge.
 */
import type { SessionEvent } from '@planning-poker/contracts';
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
} from '@planning-poker/domain';
import { workItemKey } from '@planning-poker/domain';

import type { ApplicationDependencies } from '../dependencies';
import type {
  ApplicationSettings,
  ApplicationSettingsRepository,
  AtomicOperation,
  AuditRepository,
  Clock,
  EventPublisher,
  ExternalField,
  ExternalFieldOption,
  IdentityProvider,
  IdGenerator,
  ImportedWorkItem,
  ParticipantRepository,
  QuerySuggestion,
  SessionRepository,
  TeamRepository,
  UpdateResult,
  UpdateValidation,
  VoteRepository,
  WorkItemProvider,
  WorkItemSearchPage,
  WorkItemFieldSelection,
  WorkItemUpdateRequest,
} from '../ports';
import { ConcurrencyConflict } from '../ports';

const MAX_ATOMIC_ATTEMPTS = 3;
const FAKE_SEARCH_PAGE_SIZE = 5;
const QUERY_NOISE = new Set(['and', 'or', 'project', 'status', 'issuetype', 'order', 'by', 'text']);

function tenantKey(tenantId: TenantId, id: string): string {
  return `${tenantId}/${id}`;
}

export class FixedClock implements Clock {
  private current: Date;

  constructor(start = new Date('2026-01-01T09:00:00.000Z')) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class SequentialIds implements IdGenerator {
  private counter = 0;

  next(): string {
    this.counter += 1;

    return `id-${String(this.counter)}`;
  }
}

export class InMemoryTeamRepository implements TeamRepository {
  private readonly teams = new Map<string, Team>();

  get(tenantId: TenantId, teamId: TeamId): Promise<Team | null> {
    return Promise.resolve(this.teams.get(tenantKey(tenantId, teamId)) ?? null);
  }

  save(team: Team): Promise<Team> {
    const key = tenantKey(team.tenantId, team.id);
    const storedVersion = this.teams.get(key)?.version ?? 0;

    if (storedVersion !== team.version) {
      return Promise.reject(new ConcurrencyConflict());
    }

    const saved = { ...team, version: team.version + 1 };
    this.teams.set(key, saved);

    return Promise.resolve(saved);
  }

  listForTenant(tenantId: TenantId): Promise<readonly Team[]> {
    return Promise.resolve([...this.teams.values()].filter((team) => team.tenantId === tenantId));
  }
}

export class InMemoryApplicationSettingsRepository implements ApplicationSettingsRepository {
  private readonly byTenant = new Map<TenantId, ApplicationSettings>();

  get(tenantId: TenantId): Promise<ApplicationSettings> {
    return Promise.resolve(
      this.byTenant.get(tenantId) ?? {
        tenantId,
        moderatorUserIds: [],
        writableFieldIds: [],
        version: 0,
      },
    );
  }

  save(settings: ApplicationSettings): Promise<ApplicationSettings> {
    const storedVersion = this.byTenant.get(settings.tenantId)?.version ?? 0;

    if (storedVersion !== settings.version) {
      return Promise.reject(new ConcurrencyConflict());
    }

    const saved = { ...settings, version: settings.version + 1 };
    this.byTenant.set(settings.tenantId, saved);

    return Promise.resolve(saved);
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, Session>();

  get(tenantId: TenantId, sessionId: SessionId): Promise<Session | null> {
    return Promise.resolve(this.sessions.get(tenantKey(tenantId, sessionId)) ?? null);
  }

  save(session: Session): Promise<Session> {
    const key = tenantKey(session.tenantId, session.id);
    const storedVersion = this.sessions.get(key)?.version ?? 0;

    if (storedVersion !== session.version) {
      return Promise.reject(new ConcurrencyConflict());
    }

    const saved = { ...session, version: session.version + 1 };
    this.sessions.set(key, saved);

    return Promise.resolve(saved);
  }

  listForTeams(tenantId: TenantId, teamIds: readonly TeamId[]): Promise<readonly Session[]> {
    return Promise.resolve(
      [...this.sessions.values()].filter(
        (session) => session.tenantId === tenantId && teamIds.includes(session.teamId),
      ),
    );
  }

  listByIds(tenantId: TenantId, sessionIds: readonly SessionId[]): Promise<readonly Session[]> {
    return Promise.resolve(
      sessionIds.flatMap((id) => {
        const session = this.sessions.get(tenantKey(tenantId, id));

        return session === undefined ? [] : [session];
      }),
    );
  }
}

export class InMemoryParticipantRepository implements ParticipantRepository {
  private readonly bySession = new Map<string, readonly UserId[]>();

  replaceForSession(session: Session): Promise<void> {
    this.bySession.set(
      tenantKey(session.tenantId, session.id),
      session.participants.map((participant) => participant.userId),
    );

    return Promise.resolve();
  }

  listSessionIdsForUser(tenantId: TenantId, userId: UserId): Promise<readonly SessionId[]> {
    const prefix = `${tenantId}/`;

    return Promise.resolve(
      [...this.bySession.entries()]
        .filter(([key, userIds]) => key.startsWith(prefix) && userIds.includes(userId))
        .map(([key]) => key.slice(prefix.length) as SessionId),
    );
  }
}

export class InMemoryVoteRepository implements VoteRepository {
  private readonly votes = new Map<string, Vote>();

  upsert(tenantId: TenantId, vote: Vote): Promise<void> {
    this.votes.set(tenantKey(tenantId, `${vote.roundId}/${vote.userId}`), vote);

    return Promise.resolve();
  }

  listForRound(
    tenantId: TenantId,
    roundId: RoundId,
    voterIds: readonly UserId[],
  ): Promise<readonly Vote[]> {
    return this.listForVoters(tenantId, roundId, voterIds);
  }

  private listForVoters(
    tenantId: TenantId,
    roundId: RoundId,
    voterIds: readonly UserId[],
  ): Promise<readonly Vote[]> {
    return Promise.resolve(
      voterIds.flatMap((userId) => {
        const vote = this.votes.get(tenantKey(tenantId, `${roundId}/${userId}`));

        return vote === undefined ? [] : [vote];
      }),
    );
  }

  listForVoter(
    tenantId: TenantId,
    userId: UserId,
    roundIds: readonly RoundId[],
  ): Promise<readonly Vote[]> {
    return Promise.resolve(
      roundIds.flatMap((roundId) => {
        const vote = this.votes.get(tenantKey(tenantId, `${roundId}/${userId}`));

        return vote === undefined ? [] : [vote];
      }),
    );
  }

  remove(tenantId: TenantId, roundId: RoundId, userId: UserId): Promise<void> {
    this.votes.delete(tenantKey(tenantId, `${roundId}/${userId}`));

    return Promise.resolve();
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  readonly events: AuditEvent[] = [];

  append(events: readonly AuditEvent[]): Promise<void> {
    this.events.push(...events);

    return Promise.resolve();
  }

  listForSession(tenantId: TenantId, sessionId: SessionId): Promise<readonly AuditEvent[]> {
    return Promise.resolve(
      this.events.filter((event) => event.tenantId === tenantId && event.sessionId === sessionId),
    );
  }
}

export class RecordingEventPublisher implements EventPublisher {
  readonly published: { sessionId: SessionId; event: SessionEvent }[] = [];

  publish(_tenantId: TenantId, sessionId: SessionId, event: SessionEvent): Promise<void> {
    this.published.push({ sessionId, event });

    return Promise.resolve();
  }
}

/** Serializes operations per key and retries on version conflicts, like a conditional write. */
export class InMemoryAtomicOperation implements AtomicOperation {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const attempt = async (): Promise<T> => {
      for (let tries = 1; ; tries += 1) {
        try {
          return await operation();
        } catch (error: unknown) {
          if (!(error instanceof ConcurrencyConflict) || tries >= MAX_ATOMIC_ATTEMPTS) {
            throw error;
          }
        }
      }
    };
    const next = previous.then(attempt, attempt);
    this.tails.set(
      key,
      next.catch(() => undefined),
    );

    return await next;
  }
}

export class InMemoryIdentityProvider implements IdentityProvider {
  private readonly users = new Map<UserId, UserIdentity>();
  actor: AuthorizationContext | null = null;

  add(user: UserIdentity): void {
    this.users.set(user.id, user);
  }

  currentActor(): Promise<AuthorizationContext> {
    return this.actor === null
      ? Promise.reject(new Error('No actor configured.'))
      : Promise.resolve(this.actor);
  }

  getUsers(tenantId: TenantId, userIds: readonly UserId[]): Promise<readonly UserIdentity[]> {
    return Promise.resolve(
      userIds.flatMap((id) => {
        const user = this.users.get(id);

        return user?.tenantId === tenantId ? [user] : [];
      }),
    );
  }

  searchUsers(tenantId: TenantId, query: string): Promise<readonly UserIdentity[]> {
    const needle = query.toLowerCase();

    return Promise.resolve(
      [...this.users.values()].filter(
        (user) => user.tenantId === tenantId && user.displayName.toLowerCase().includes(needle),
      ),
    );
  }
}

/** A scriptable work-item provider. Records every update request it receives. */
export class FakeWorkItemProvider implements WorkItemProvider {
  readonly providerId = 'fake';
  readonly items = new Map<string, ImportedWorkItem>();
  readonly fieldValues = new Map<string, FieldValue | null>();
  readonly updates: WorkItemUpdateRequest[] = [];
  fields: ExternalField[] = [];
  /** Small pages so tests and the local preview exercise paging. */
  pageSize = FAKE_SEARCH_PAGE_SIZE;
  suggestions: string[] = ['project = PP', 'project = PP AND status = "To Do"', 'issuetype = Bug'];
  nextUpdateResult: UpdateResult = { status: 'succeeded' };
  nextValidation: UpdateValidation = { status: 'ok' };
  /** One-shot failure for the next write only (e.g. the local preview's "fail next write"). */
  private failNext: string | null = null;
  /**
   * Whether the calling user can see an item. Defaults to everything; tests replace it to model
   * Jira issue permissions (e.g. based on the current actor).
   */
  canSee: (reference: WorkItemReference) => boolean = () => true;

  /** Field values by item key and field ID, returned as display text when selected. */
  readonly fieldTexts = new Map<string, Readonly<Record<string, string>>>();

  add(key: string, item: ImportedWorkItem): void {
    this.items.set(key, item);
  }

  /** Simulates someone editing the field in the provider (e.g. in Jira). */
  setFieldValue(reference: WorkItemReference, fieldId: string, value: FieldValue | null): void {
    this.fieldValues.set(`${workItemKey(reference)}#${fieldId}`, value);
  }

  currentFieldValue(reference: WorkItemReference, fieldId: string): FieldValue | null {
    return this.fieldValues.get(`${workItemKey(reference)}#${fieldId}`) ?? null;
  }

  failNextUpdate(message: string): void {
    this.failNext = message;
  }

  private withFields(item: ImportedWorkItem, fields: WorkItemFieldSelection): ImportedWorkItem {
    const texts = this.fieldTexts.get(item.reference.displayKey) ?? {};
    const names = new Map(this.fields.map((field) => [field.fieldId, field.name]));
    const displayFields = Object.fromEntries(
      fields.displayFieldIds.flatMap((id) => {
        const value = texts[id];

        return value === undefined ? [] : [[names.get(id) ?? id, value]];
      }),
    );

    const fieldValues = Object.fromEntries(
      fields.valueFieldIds.map((id) => [id, this.currentFieldValue(item.reference, id)]),
    );

    return { ...item, snapshot: { ...item.snapshot, displayFields, fieldValues } };
  }

  /** Matches every word of the query against key, title, type and status. Pages by `pageSize`. */
  search(
    query: string,
    cursor: string | null,
    fields: WorkItemFieldSelection,
  ): Promise<WorkItemSearchPage> {
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((word) => word.length > 1 && !QUERY_NOISE.has(word));
    const matches = [...this.items.entries()]
      .filter(([key, item]) => {
        const haystack = [key, item.snapshot.title, item.snapshot.itemType, item.snapshot.status]
          .join(' ')
          .toLowerCase();

        return words.every((word) => haystack.includes(word));
      })
      .map(([, item]) => this.withFields(item, fields));
    const start = cursor === null ? 0 : Number(cursor);
    const end = start + this.pageSize;

    return Promise.resolve({
      items: matches.slice(start, end),
      nextCursor: end < matches.length ? String(end) : null,
    });
  }

  suggestQuery(partialQuery: string): Promise<readonly QuerySuggestion[]> {
    return Promise.resolve(
      this.suggestions
        .filter((suggestion) => suggestion.toLowerCase().startsWith(partialQuery.toLowerCase()))
        .map((value) => ({ value, displayName: value })),
    );
  }

  getItems(
    keys: readonly string[],
    fields: WorkItemFieldSelection,
  ): Promise<{ readonly found: readonly ImportedWorkItem[]; readonly missing: readonly string[] }> {
    const found = keys.flatMap((key) => {
      const item = this.items.get(key);

      return item === undefined ? [] : [this.withFields(item, fields)];
    });

    return Promise.resolve({ found, missing: keys.filter((key) => !this.items.has(key)) });
  }

  discoverFields(): Promise<readonly ExternalField[]> {
    return Promise.resolve(this.fields);
  }

  listFieldOptions(
    fieldId: string,
    items: readonly WorkItemReference[],
  ): Promise<readonly ExternalFieldOption[]> {
    const field = this.fields.find((entry) => entry.fieldId === fieldId);

    return Promise.resolve(items.length === 0 || field === undefined ? [] : field.options);
  }

  validateUpdate(request: WorkItemUpdateRequest): Promise<UpdateValidation> {
    const current = this.currentFieldValue(request.reference, request.fieldId);

    if (this.nextValidation.status === 'ok' && current === request.value) {
      // Already written (a retry after an interrupted attempt): idempotent.
      return Promise.resolve({ status: 'ok' });
    }

    if (
      this.nextValidation.status === 'ok' &&
      request.expectedCurrentValue !== undefined &&
      current !== request.expectedCurrentValue
    ) {
      return Promise.resolve({
        status: 'conflict',
        message: `The field was changed to ${String(current)} since import.`,
      });
    }

    return Promise.resolve(this.nextValidation);
  }

  visibleItems(items: readonly WorkItemReference[]): Promise<ReadonlySet<string>> {
    return Promise.resolve(
      new Set(items.filter((item) => this.canSee(item)).map((item) => workItemKey(item))),
    );
  }

  update(request: WorkItemUpdateRequest): Promise<UpdateResult> {
    this.updates.push(request);

    if (this.failNext !== null) {
      const message = this.failNext;
      this.failNext = null;

      return Promise.resolve({ status: 'failed', message });
    }

    if (this.nextUpdateResult.status === 'succeeded') {
      this.fieldValues.set(`${workItemKey(request.reference)}#${request.fieldId}`, request.value);
    }

    return Promise.resolve(this.nextUpdateResult);
  }
}

export interface InMemoryApplication {
  readonly deps: ApplicationDependencies;
  readonly teams: InMemoryTeamRepository;
  readonly sessions: InMemorySessionRepository;
  readonly votes: InMemoryVoteRepository;
  readonly audit: InMemoryAuditRepository;
  readonly events: RecordingEventPublisher;
  readonly clock: FixedClock;
  readonly identity: InMemoryIdentityProvider;
  readonly workItems: FakeWorkItemProvider;
  readonly settings: InMemoryApplicationSettingsRepository;
}

export function createInMemoryApplication(): InMemoryApplication {
  const teams = new InMemoryTeamRepository();
  const sessions = new InMemorySessionRepository();
  const votes = new InMemoryVoteRepository();
  const audit = new InMemoryAuditRepository();
  const events = new RecordingEventPublisher();
  const clock = new FixedClock();
  const identity = new InMemoryIdentityProvider();
  const workItems = new FakeWorkItemProvider();
  const settings = new InMemoryApplicationSettingsRepository();

  return {
    deps: {
      teams,
      sessions,
      participants: new InMemoryParticipantRepository(),
      votes,
      audit,
      events,
      atomic: new InMemoryAtomicOperation(),
      clock,
      ids: new SequentialIds(),
      identity,
      workItems,
      settings,
    },
    teams,
    sessions,
    votes,
    audit,
    events,
    clock,
    identity,
    workItems,
    settings,
  };
}
