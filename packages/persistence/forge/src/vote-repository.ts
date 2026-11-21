import type { VoteRepository } from '@planning-poker/application';
import type { CardId, RoundId, TenantId, UserId, Vote } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import type { EntityStore } from './entity-store';
import { ENTITIES } from './schema';

/**
 * Private votes, keyed by round and voter so each person has exactly one vote per round. Stored
 * only in app storage — never in Jira issue properties or anything a client can read.
 */
export interface VoteRecord {
  readonly tenantId: string;
  readonly roundId: string;
  readonly userId: string;
  readonly cardId: string;
  readonly submittedAt: number;
}

function voteKey(roundId: string, userId: string): string {
  return `${roundId}:${userId}`;
}

function fromRecord(record: VoteRecord): Vote {
  return {
    roundId: asId<RoundId>(record.roundId),
    userId: asId<UserId>(record.userId),
    cardId: asId<CardId>(record.cardId),
    submittedAt: new Date(record.submittedAt),
  };
}

export class ForgeVoteRepository implements VoteRepository {
  private readonly store: EntityStore;

  constructor(store: EntityStore) {
    this.store = store;
  }

  async upsert(tenantId: TenantId, vote: Vote): Promise<void> {
    const record: VoteRecord = {
      tenantId,
      roundId: vote.roundId,
      userId: vote.userId,
      cardId: vote.cardId,
      submittedAt: vote.submittedAt.getTime(),
    };
    await this.store.put(ENTITIES.vote.name, voteKey(vote.roundId, vote.userId), record);
  }

  /** Key lookups, not an index query: entity gets are strongly consistent, queries are not. */
  async listForRound(
    tenantId: TenantId,
    roundId: RoundId,
    voterIds: readonly UserId[],
  ): Promise<readonly Vote[]> {
    return await this.getMany(
      tenantId,
      voterIds.map((userId) => voteKey(roundId, userId)),
    );
  }

  async listForVoter(
    tenantId: TenantId,
    userId: UserId,
    roundIds: readonly RoundId[],
  ): Promise<readonly Vote[]> {
    return await this.getMany(
      tenantId,
      roundIds.map((roundId) => voteKey(roundId, userId)),
    );
  }

  async remove(_tenantId: TenantId, roundId: RoundId, userId: UserId): Promise<void> {
    await this.store.delete(ENTITIES.vote.name, voteKey(roundId, userId));
  }

  private async getMany(tenantId: TenantId, keys: readonly string[]): Promise<Vote[]> {
    const records = await Promise.all(
      [...new Set(keys)].map(
        async (key) => await this.store.get<VoteRecord>(ENTITIES.vote.name, key),
      ),
    );

    return records
      .filter((record): record is VoteRecord => record?.tenantId === tenantId)
      .map(fromRecord);
  }
}
