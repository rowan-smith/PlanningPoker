import type { ParticipantRepository } from '@planning-poker/application';
import type { Session, SessionId, TenantId, UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import type { EntityStore } from './entity-store';
import { queryAll } from './entity-store';
import { ENTITIES } from './schema';

/** One index row per roster entry, so "sessions for this user" is a single query. */
export interface SessionMemberRecord {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly userId: string;
}

function memberKey(sessionId: string, userId: string): string {
  return `${sessionId}:${userId}`;
}

/**
 * The session record is the source of truth; this index is derived from it and rewritten after
 * each save. Rows are idempotent, so a retried or repeated rewrite is harmless.
 */
export class ForgeParticipantRepository implements ParticipantRepository {
  private readonly store: EntityStore;

  constructor(store: EntityStore) {
    this.store = store;
  }

  async replaceForSession(session: Session): Promise<void> {
    const entity = ENTITIES.sessionMember.name;
    const existing = await queryAll<SessionMemberRecord>(
      this.store,
      entity,
      ENTITIES.sessionMember.bySession,
      [session.id],
    );
    const current = new Set(session.participants.map((participant) => participant.userId));

    for (const userId of current) {
      const record: SessionMemberRecord = {
        tenantId: session.tenantId,
        sessionId: session.id,
        userId,
      };
      await this.store.put(entity, memberKey(session.id, userId), record);
    }

    for (const record of existing) {
      if (!current.has(asId<UserId>(record.userId))) {
        await this.store.delete(entity, memberKey(record.sessionId, record.userId));
      }
    }
  }

  async listSessionIdsForUser(tenantId: TenantId, userId: UserId): Promise<readonly SessionId[]> {
    const records = await queryAll<SessionMemberRecord>(
      this.store,
      ENTITIES.sessionMember.name,
      ENTITIES.sessionMember.byUser,
      [userId],
    );

    return records
      .filter((record) => record.tenantId === tenantId)
      .map((record) => asId<SessionId>(record.sessionId));
  }
}
