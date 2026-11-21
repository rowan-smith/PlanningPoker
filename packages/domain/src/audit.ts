import type { AuditEventId, SessionId, TeamId, TenantId, TicketId, UserId } from './ids';

export type AuditEventType =
  | 'team.created'
  | 'team.updated'
  | 'team.member-added'
  | 'team.member-removed'
  | 'team.moderator-assigned'
  | 'team.moderator-unassigned'
  | 'team.archived'
  | 'settings.moderator-assigned'
  | 'settings.moderator-unassigned'
  | 'session.created'
  | 'session.settings-changed'
  | 'session.published'
  | 'session.paused'
  | 'session.resumed'
  | 'session.completed'
  | 'session.cancelled'
  | 'participant.invited'
  | 'participant.responded'
  | 'participant.invitation-revoked'
  | 'participant.role-changed'
  | 'participant.skipped'
  | 'participant.restored'
  | 'ticket.added'
  | 'ticket.removed'
  | 'ticket.reordered'
  | 'ticket.current-changed'
  | 'ticket.skipped'
  | 'round.started'
  | 'round.revealed'
  | 'estimate.finalized'
  | 'estimate.overridden'
  | 'sync.completed'
  | 'sync.retried';

export type AuditDetailValue = string | number | boolean | null;

/**
 * An audit record of a privileged action. Details must never pair a user with a vote value.
 */
export interface AuditEvent {
  readonly id: AuditEventId;
  readonly tenantId: TenantId;
  readonly type: AuditEventType;
  /** `null` for actions the system took automatically. */
  readonly actorId: UserId | null;
  readonly teamId: TeamId | null;
  readonly sessionId: SessionId | null;
  readonly ticketId: TicketId | null;
  readonly subjectUserId: UserId | null;
  readonly details: Readonly<Record<string, AuditDetailValue>>;
  readonly occurredAt: Date;
}
