import type { FieldAllowlistView, SettingsView } from '@planning-poker/contracts';
import type { AuditEventType, AuthorizationContext, UserId } from '@planning-poker/domain';
import { DomainError, isAdministrator } from '@planning-poker/domain';

import { forbid } from './authorization';
import type { ApplicationDependencies } from './dependencies';
import { auditEvent } from './dependencies';
import { allowlistView, validateAllowlist } from './field-mapping';
import type { ApplicationSettings } from './ports';
import { userView } from './team-service';

export type SettingsServiceDependencies = Pick<
  ApplicationDependencies,
  'audit' | 'atomic' | 'clock' | 'ids' | 'identity' | 'settings' | 'workItems'
>;

/** Administrator-only application settings, starting with the application moderator role. */
export class SettingsService {
  private readonly deps: SettingsServiceDependencies;

  constructor(deps: SettingsServiceDependencies) {
    this.deps = deps;
  }

  async getSettingsView(actor: AuthorizationContext): Promise<SettingsView> {
    if (!isAdministrator(actor)) {
      return { canAdminister: false, moderators: [] };
    }

    return await this.toView(await this.deps.settings.get(actor.tenantId));
  }

  async assignModerator(actor: AuthorizationContext, userId: UserId): Promise<SettingsView> {
    const [user] = await this.deps.identity.getUsers(actor.tenantId, [userId]);

    if (user === undefined) {
      throw new DomainError('NOT_FOUND', 'That user could not be found.');
    }

    return await this.change(actor, userId, 'settings.moderator-assigned', (ids) =>
      ids.includes(userId) ? ids : [...ids, userId],
    );
  }

  async unassignModerator(actor: AuthorizationContext, userId: UserId): Promise<SettingsView> {
    return await this.change(actor, userId, 'settings.moderator-unassigned', (ids) =>
      ids.filter((id) => id !== userId),
    );
  }

  /** Number and single-select fields, and which of them sessions may write estimates to. */
  async getFieldAllowlist(actor: AuthorizationContext): Promise<FieldAllowlistView> {
    if (!isAdministrator(actor)) {
      forbid('Only administrators can change settings.');
    }

    const [settings, fields] = await Promise.all([
      this.deps.settings.get(actor.tenantId),
      this.deps.workItems.discoverFields(),
    ]);

    return allowlistView(fields, settings.writableFieldIds);
  }

  async setFieldAllowlist(
    actor: AuthorizationContext,
    fieldIds: readonly string[],
  ): Promise<FieldAllowlistView> {
    if (!isAdministrator(actor)) {
      forbid('Only administrators can change settings.');
    }

    const fields = await this.deps.workItems.discoverFields();
    const writableFieldIds = validateAllowlist(fields, fieldIds);
    const saved = await this.deps.atomic.run(`settings:${actor.tenantId}`, async () => {
      const current = await this.deps.settings.get(actor.tenantId);
      const unchanged =
        writableFieldIds.length === current.writableFieldIds.length &&
        writableFieldIds.every((id) => current.writableFieldIds.includes(id));

      if (unchanged) {
        return current;
      }

      const next = await this.deps.settings.save({ ...current, writableFieldIds });
      await this.deps.audit.append([
        auditEvent(this.deps, {
          type: 'settings.writable-fields-changed',
          actor,
          tenantId: actor.tenantId,
          details: { fieldIds: writableFieldIds.join(',') },
        }),
      ]);

      return next;
    });

    return allowlistView(fields, saved.writableFieldIds);
  }

  private async change(
    actor: AuthorizationContext,
    userId: UserId,
    type: AuditEventType,
    update: (moderatorIds: readonly UserId[]) => readonly UserId[],
  ): Promise<SettingsView> {
    if (!isAdministrator(actor)) {
      forbid('Only administrators can change settings.');
    }

    const saved = await this.deps.atomic.run(`settings:${actor.tenantId}`, async () => {
      const current = await this.deps.settings.get(actor.tenantId);
      const moderatorUserIds = update(current.moderatorUserIds);

      const unchanged =
        moderatorUserIds.length === current.moderatorUserIds.length &&
        moderatorUserIds.every((id) => current.moderatorUserIds.includes(id));

      if (unchanged) {
        return current;
      }

      const next = await this.deps.settings.save({ ...current, moderatorUserIds });
      await this.deps.audit.append([
        auditEvent(this.deps, { type, actor, tenantId: actor.tenantId, subjectUserId: userId }),
      ]);

      return next;
    });

    return await this.toView(saved);
  }

  private async toView(settings: ApplicationSettings): Promise<SettingsView> {
    const users = await this.deps.identity.getUsers(settings.tenantId, settings.moderatorUserIds);
    const byId = new Map(users.map((user) => [user.id, user]));

    return {
      canAdminister: true,
      moderators: settings.moderatorUserIds
        .map((id) => userView(byId, id))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  }
}
