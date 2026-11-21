import type { SessionRepository } from '@planning-poker/application';
import type { Session, SessionId, TeamId, TenantId } from '@planning-poker/domain';

import type { EntityStore } from './entity-store';
import { queryAll } from './entity-store';
import type { Json } from './json-dates';
import { reviveDates, toJson } from './json-dates';
import { ENTITIES } from './schema';

/**
 * The whole session aggregate (roster, skips, tickets, rounds, decisions) in one versioned record,
 * so every session change is a single conditional write. Votes are stored separately.
 */
export interface SessionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly teamId: string;
  readonly status: string;
  readonly version: number;
  readonly updatedAt: number;
  readonly data: Json;
}

export function toSessionRecord(session: Session): SessionRecord {
  return {
    id: session.id,
    tenantId: session.tenantId,
    teamId: session.teamId,
    status: session.status,
    version: session.version,
    updatedAt: session.updatedAt.getTime(),
    data: toJson(session),
  };
}

export function fromSessionRecord(record: SessionRecord): Session {
  return { ...(reviveDates(record.data) as Session), version: record.version };
}

export class ForgeSessionRepository implements SessionRepository {
  private readonly store: EntityStore;

  constructor(store: EntityStore) {
    this.store = store;
  }

  async get(tenantId: TenantId, sessionId: SessionId): Promise<Session | null> {
    const record = await this.store.get<SessionRecord>(ENTITIES.session.name, sessionId);

    return record?.tenantId === tenantId ? fromSessionRecord(record) : null;
  }

  async save(session: Session): Promise<Session> {
    const saved: Session = { ...session, version: session.version + 1 };
    const record = toSessionRecord(saved);

    if (session.version === 0) {
      await this.store.create(ENTITIES.session.name, session.id, record);
    } else {
      await this.store.replace(ENTITIES.session.name, session.id, record, session.version);
    }

    return saved;
  }

  async listForTeams(tenantId: TenantId, teamIds: readonly TeamId[]): Promise<readonly Session[]> {
    const sessions: Session[] = [];

    for (const teamId of teamIds) {
      const records = await queryAll<SessionRecord>(
        this.store,
        ENTITIES.session.name,
        ENTITIES.session.byTeam,
        [teamId],
      );
      sessions.push(
        ...records.filter((record) => record.tenantId === tenantId).map(fromSessionRecord),
      );
    }

    return sessions;
  }

  async listByIds(
    tenantId: TenantId,
    sessionIds: readonly SessionId[],
  ): Promise<readonly Session[]> {
    const sessions = await Promise.all(sessionIds.map(async (id) => await this.get(tenantId, id)));

    return sessions.filter((session): session is Session => session !== null);
  }
}
