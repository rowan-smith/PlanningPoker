import type { TeamRepository } from '@planning-poker/application';
import type { Team, TeamId, TenantId, UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import type { EntityStore } from './entity-store';
import { queryAll } from './entity-store';
import { ENTITIES } from './schema';

interface StoredTeamData {
  readonly description: string | null;
  readonly members: readonly { readonly userId: string; readonly addedAt: string }[];
  readonly moderatorIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Top-level attributes are indexed or used in write conditions; `data` holds the rest. */
export interface TeamRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly archived: boolean;
  readonly version: number;
  readonly data: StoredTeamData;
}

export function toTeamRecord(team: Team): TeamRecord {
  return {
    id: team.id,
    tenantId: team.tenantId,
    name: team.name,
    archived: team.archived,
    version: team.version,
    data: {
      description: team.description,
      members: team.members.map((member) => ({
        userId: member.userId,
        addedAt: member.addedAt.toISOString(),
      })),
      moderatorIds: [...team.moderatorIds],
      createdAt: team.createdAt.toISOString(),
      updatedAt: team.updatedAt.toISOString(),
    },
  };
}

export function fromTeamRecord(record: TeamRecord): Team {
  return {
    id: asId<TeamId>(record.id),
    tenantId: asId<TenantId>(record.tenantId),
    name: record.name,
    description: record.data.description,
    members: record.data.members.map((member) => ({
      userId: asId<UserId>(member.userId),
      addedAt: new Date(member.addedAt),
    })),
    moderatorIds: record.data.moderatorIds.map((id) => asId<UserId>(id)),
    createdAt: new Date(record.data.createdAt),
    updatedAt: new Date(record.data.updatedAt),
    archived: record.archived,
    version: record.version,
  };
}

export class ForgeTeamRepository implements TeamRepository {
  private readonly store: EntityStore;

  constructor(store: EntityStore) {
    this.store = store;
  }

  async get(tenantId: TenantId, teamId: TeamId): Promise<Team | null> {
    const record = await this.store.get<TeamRecord>(ENTITIES.team.name, teamId);

    return record?.tenantId === tenantId ? fromTeamRecord(record) : null;
  }

  async save(team: Team): Promise<Team> {
    const saved: Team = { ...team, version: team.version + 1 };
    const record = toTeamRecord(saved);

    if (team.version === 0) {
      await this.store.create(ENTITIES.team.name, team.id, record);
    } else {
      await this.store.replace(ENTITIES.team.name, team.id, record, team.version);
    }

    return saved;
  }

  async listForTenant(tenantId: TenantId): Promise<readonly Team[]> {
    const records = await queryAll<TeamRecord>(
      this.store,
      ENTITIES.team.name,
      ENTITIES.team.byTenant,
      [tenantId],
    );

    return records.filter((record) => record.tenantId === tenantId).map(fromTeamRecord);
  }
}
