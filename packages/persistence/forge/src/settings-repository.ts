import type {
  ApplicationSettings,
  ApplicationSettingsRepository,
} from '@planning-poker/application';
import type { TenantId, UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import type { EntityStore } from './entity-store';
import { ENTITIES } from './schema';

/** Forge storage is already scoped to one installation, so a single record holds the settings. */
const SETTINGS_KEY = 'settings';

export interface SettingsRecord {
  readonly tenantId: string;
  readonly version: number;
  readonly data: {
    readonly moderatorUserIds: readonly string[];
    /** Added in Milestone 7; absent in records saved before it. */
    readonly writableFieldIds?: readonly string[];
  };
}

export class ForgeApplicationSettingsRepository implements ApplicationSettingsRepository {
  private readonly store: EntityStore;

  constructor(store: EntityStore) {
    this.store = store;
  }

  async get(tenantId: TenantId): Promise<ApplicationSettings> {
    const record = await this.store.get<SettingsRecord>(ENTITIES.settings.name, SETTINGS_KEY);

    if (record?.tenantId !== tenantId) {
      return { tenantId, moderatorUserIds: [], writableFieldIds: [], version: 0 };
    }

    return {
      tenantId,
      moderatorUserIds: record.data.moderatorUserIds.map((id) => asId<UserId>(id)),
      writableFieldIds: [...(record.data.writableFieldIds ?? [])],
      version: record.version,
    };
  }

  async save(settings: ApplicationSettings): Promise<ApplicationSettings> {
    const saved: ApplicationSettings = { ...settings, version: settings.version + 1 };
    const record: SettingsRecord = {
      tenantId: settings.tenantId,
      version: saved.version,
      data: {
        moderatorUserIds: [...settings.moderatorUserIds],
        writableFieldIds: [...settings.writableFieldIds],
      },
    };

    if (settings.version === 0) {
      await this.store.create(ENTITIES.settings.name, SETTINGS_KEY, record);
    } else {
      await this.store.replace(ENTITIES.settings.name, SETTINGS_KEY, record, settings.version);
    }

    return saved;
  }
}
