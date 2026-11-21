import type { ApplicationSettingsRepository, IdentityProvider } from '@planning-poker/application';
import type {
  ApplicationRole,
  AuthorizationContext,
  TenantId,
  UserId,
  UserIdentity,
} from '@planning-poker/domain';
import { asId, DomainError } from '@planning-poker/domain';

import type { JiraUser, JiraUserApi } from './jira-user-api';

export const ATLASSIAN_PROVIDER = 'atlassian';
const USER_ID_PREFIX = `${ATLASSIAN_PROVIDER}:`;

/**
 * Identity mapping. Internal user IDs are derived from the provider and account ID, so the mapping
 * needs no stored record and cannot race. Other providers will use their own prefix.
 */
export function userIdForAccount(accountId: string): UserId {
  return asId<UserId>(`${USER_ID_PREFIX}${accountId}`);
}

export function accountIdForUser(userId: UserId): string | null {
  return userId.startsWith(USER_ID_PREFIX) ? userId.slice(USER_ID_PREFIX.length) : null;
}

function toIdentity(tenantId: TenantId, user: JiraUser): UserIdentity {
  return {
    id: userIdForAccount(user.accountId),
    tenantId,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    externalIdentities: [{ provider: ATLASSIAN_PROVIDER, externalId: user.accountId }],
  };
}

function isPerson(user: JiraUser): boolean {
  return user.active && user.accountType === 'atlassian';
}

export interface AtlassianRequestContext {
  readonly tenantId: TenantId;
  /** From Forge's invocation context — never from the client payload. */
  readonly accountId: string | undefined;
}

/**
 * Resolves the calling Atlassian user. Jira administrators (global ADMINISTER permission) are
 * application administrators; users listed in the app settings are application moderators.
 * Create one instance per request.
 */
export class AtlassianIdentityProvider implements IdentityProvider {
  private readonly context: AtlassianRequestContext;
  private readonly users: JiraUserApi;
  private readonly settings: ApplicationSettingsRepository;
  private actor: Promise<AuthorizationContext> | null = null;

  constructor(
    context: AtlassianRequestContext,
    users: JiraUserApi,
    settings: ApplicationSettingsRepository,
  ) {
    this.context = context;
    this.users = users;
    this.settings = settings;
  }

  async currentActor(): Promise<AuthorizationContext> {
    this.actor ??= this.resolveActor();

    return await this.actor;
  }

  async getUsers(tenantId: TenantId, userIds: readonly UserId[]): Promise<readonly UserIdentity[]> {
    const accountIds = userIds.flatMap((id) => {
      const accountId = accountIdForUser(id);

      return accountId === null ? [] : [accountId];
    });

    if (accountIds.length === 0) {
      return [];
    }

    const users = await this.users.getUsers(accountIds);

    return users.map((user) => toIdentity(tenantId, user));
  }

  async searchUsers(tenantId: TenantId, query: string): Promise<readonly UserIdentity[]> {
    const users = await this.users.searchUsers(query);

    return users.filter(isPerson).map((user) => toIdentity(tenantId, user));
  }

  private async resolveActor(): Promise<AuthorizationContext> {
    const { accountId, tenantId } = this.context;

    if (accountId === undefined) {
      throw new DomainError('FORBIDDEN', 'Sign in to Jira to use Planning Poker.');
    }

    const userId = userIdForAccount(accountId);
    const [isAdministrator, settings] = await Promise.all([
      this.users.currentUserIsAdministrator(),
      this.settings.get(tenantId),
    ]);
    let role: ApplicationRole = 'member';

    if (isAdministrator) {
      role = 'administrator';
    } else if (settings.moderatorUserIds.includes(userId)) {
      role = 'moderator';
    }

    return { userId, tenantId, role };
  }
}
