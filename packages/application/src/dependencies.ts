import type {
  AuditDetailValue,
  AuditEvent,
  AuditEventId,
  AuditEventType,
  AuthorizationContext,
  SessionId,
  TeamId,
  TicketId,
  UserId,
} from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import type {
  AtomicOperation,
  AuditRepository,
  Clock,
  EventPublisher,
  IdentityProvider,
  IdGenerator,
  ParticipantRepository,
  SessionRepository,
  TeamRepository,
  VoteRepository,
  WorkItemProvider,
} from './ports';

export interface ApplicationDependencies {
  readonly teams: TeamRepository;
  readonly sessions: SessionRepository;
  readonly participants: ParticipantRepository;
  readonly votes: VoteRepository;
  readonly audit: AuditRepository;
  readonly events: EventPublisher;
  readonly atomic: AtomicOperation;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly identity: IdentityProvider;
  readonly workItems: WorkItemProvider;
}

export interface AuditInput {
  readonly type: AuditEventType;
  readonly actor: AuthorizationContext | null;
  readonly tenantId: AuthorizationContext['tenantId'];
  readonly teamId?: TeamId | null;
  readonly sessionId?: SessionId | null;
  readonly ticketId?: TicketId | null;
  readonly subjectUserId?: UserId | null;
  readonly details?: Readonly<Record<string, AuditDetailValue>>;
}

export function auditEvent(
  deps: Pick<ApplicationDependencies, 'ids' | 'clock'>,
  input: AuditInput,
): AuditEvent {
  return {
    id: asId<AuditEventId>(deps.ids.next()),
    tenantId: input.tenantId,
    type: input.type,
    actorId: input.actor?.userId ?? null,
    teamId: input.teamId ?? null,
    sessionId: input.sessionId ?? null,
    ticketId: input.ticketId ?? null,
    subjectUserId: input.subjectUserId ?? null,
    details: input.details ?? {},
    occurredAt: deps.clock.now(),
  };
}
