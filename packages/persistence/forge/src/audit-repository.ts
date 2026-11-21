import type { AuditRepository } from '@planning-poker/application';
import type {
  AuditDetailValue,
  AuditEvent,
  AuditEventId,
  AuditEventType,
  SessionId,
  TeamId,
  TenantId,
  TicketId,
  UserId,
} from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import type { EntityStore } from './entity-store';
import { queryAll } from './entity-store';
import { ENTITIES, NONE } from './schema';

export interface AuditRecord {
  readonly tenantId: string;
  readonly teamId: string;
  readonly sessionId: string;
  readonly occurredAt: number;
  readonly type: string;
  readonly data: {
    readonly id: string;
    readonly actorId: string | null;
    readonly ticketId: string | null;
    readonly subjectUserId: string | null;
    readonly details: Readonly<Record<string, AuditDetailValue>>;
  };
}

function toRecord(event: AuditEvent): AuditRecord {
  return {
    tenantId: event.tenantId,
    teamId: event.teamId ?? NONE,
    sessionId: event.sessionId ?? NONE,
    occurredAt: event.occurredAt.getTime(),
    type: event.type,
    data: {
      id: event.id,
      actorId: event.actorId,
      ticketId: event.ticketId,
      subjectUserId: event.subjectUserId,
      details: event.details,
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- selects the branded ID type.
function optional<T extends string>(value: string | null): T | null {
  return value === null || value === NONE ? null : (value as T);
}

function fromRecord(record: AuditRecord): AuditEvent {
  return {
    id: asId<AuditEventId>(record.data.id),
    tenantId: asId<TenantId>(record.tenantId),
    type: record.type as AuditEventType,
    actorId: optional<UserId>(record.data.actorId),
    teamId: optional<TeamId>(record.teamId),
    sessionId: optional<SessionId>(record.sessionId),
    ticketId: optional<TicketId>(record.data.ticketId),
    subjectUserId: optional<UserId>(record.data.subjectUserId),
    details: record.data.details,
    occurredAt: new Date(record.occurredAt),
  };
}

/** Append-only audit log. Event IDs are unique, so writes never conflict. */
export class ForgeAuditRepository implements AuditRepository {
  private readonly store: EntityStore;

  constructor(store: EntityStore) {
    this.store = store;
  }

  async append(events: readonly AuditEvent[]): Promise<void> {
    for (const event of events) {
      await this.store.put(ENTITIES.audit.name, event.id, toRecord(event));
    }
  }

  async listForSession(tenantId: TenantId, sessionId: SessionId): Promise<readonly AuditEvent[]> {
    const records = await queryAll<AuditRecord>(
      this.store,
      ENTITIES.audit.name,
      ENTITIES.audit.bySession,
      [sessionId],
    );

    return records.filter((record) => record.tenantId === tenantId).map(fromRecord);
  }

  async listForTeam(tenantId: TenantId, teamId: TeamId): Promise<readonly AuditEvent[]> {
    const records = await queryAll<AuditRecord>(
      this.store,
      ENTITIES.audit.name,
      ENTITIES.audit.byTeam,
      [teamId],
    );

    return records.filter((record) => record.tenantId === tenantId).map(fromRecord);
  }
}
