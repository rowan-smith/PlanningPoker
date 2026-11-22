import type { ParticipantRepository } from '@planning-poker/application';
import type { Session, SessionId, TenantId, UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import type { EntityStore } from './entity-store';
import { queryAll } from './entity-store';
import { ENTITIES } from './schema';
import type { SessionRecord } from './session-repository';
import { fromSessionRecord } from './session-repository';

/** One index row per roster entry, so "sessions for this user" is a single query. */
export interface SessionMemberRecord {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly userId: string;
}

/** Enough to catch up with a burst of concurrent saves; each pass re-reads the latest record. */
const MAX_INDEX_PASSES = 5;

function memberKey(sessionId: string, userId: string): string {
  return `${sessionId}:${userId}`;
}

/**
 * The session record is the source of truth; this index is derived from it and rewritten after
 * each save. Rows are idempotent, so a retried or repeated rewrite is harmless.
 *
 * Two saves of the same session can rewrite the index concurrently, and the older rewrite may
 * finish last. So every rewrite ends by re-reading the stored session (a strongly consistent
 * get) and, if a newer version was saved meanwhile, rewrites again from that version. The last
 * rewrite to finish is therefore always based on the latest roster. An extra stale row is
 * harmless (every read re-checks access against the session); a missing row would hide an
 * invitation, which this prevents.
 */
export class ForgeParticipantRepository implements ParticipantRepository {
  private readonly store: EntityStore;

  constructor(store: EntityStore) {
    this.store = store;
  }

  async replaceForSession(session: Session): Promise<void> {
    let basis = session;
    const written = new Set<string>();

    for (let pass = 1; pass <= MAX_INDEX_PASSES; pass += 1) {
      await this.rewrite(basis, written);
      const stored = await this.store.get<SessionRecord>(ENTITIES.session.name, session.id);

      if (stored === undefined || stored.version <= basis.version) {
        return;
      }

      basis = fromSessionRecord(stored);
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

  /** Writes a row per roster entry and deletes rows (seen or written earlier) no longer on it. */
  private async rewrite(session: Session, written: Set<string>): Promise<void> {
    const entity = ENTITIES.sessionMember.name;
    const existing = await queryAll<SessionMemberRecord>(
      this.store,
      entity,
      ENTITIES.sessionMember.bySession,
      [session.id],
    );
    const current = new Set<string>(session.participants.map((participant) => participant.userId));

    for (const userId of current) {
      const record: SessionMemberRecord = {
        tenantId: session.tenantId,
        sessionId: session.id,
        userId,
      };
      await this.store.put(entity, memberKey(session.id, userId), record);
      written.add(userId);
    }

    const candidates = new Set([...existing.map((record) => record.userId), ...written]);

    for (const userId of candidates) {
      if (!current.has(userId)) {
        await this.store.delete(entity, memberKey(session.id, userId));
        written.delete(userId);
      }
    }
  }
}
