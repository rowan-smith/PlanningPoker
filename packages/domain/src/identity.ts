import type { TenantId, UserId } from './ids';

/** A user's identity in an external system, e.g. an Atlassian account. */
export interface ExternalIdentity {
  readonly provider: string;
  readonly externalId: string;
}

export interface UserIdentity {
  readonly id: UserId;
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly externalIdentities: readonly ExternalIdentity[];
  readonly avatarUrl?: string | null;
}

/**
 * Application-wide role. Team moderation is granted per team; this role says who may administer
 * the app (`administrator`) or create teams (`administrator`, `moderator`).
 */
export type ApplicationRole = 'administrator' | 'moderator' | 'member';

/** Who is acting, resolved and verified by the server. Never built from client-supplied data. */
export interface AuthorizationContext {
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly role: ApplicationRole;
}

export function isAdministrator(actor: AuthorizationContext): boolean {
  return actor.role === 'administrator';
}
