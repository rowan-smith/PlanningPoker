import type {
  HistoryStatusDto,
  ParticipantCategoriesView,
  SyncStateDto,
  TicketOutcomeDto,
} from '@planning-poker/contracts';

export const OUTCOME_LABELS: Readonly<Record<TicketOutcomeDto, string>> = {
  estimated: 'Estimated',
  skipped: 'Skipped',
  unresolved: 'Unresolved',
  'in-progress': 'In progress',
};

/** Badge tones reuse the ticket-state tones from the planning room. */
export const OUTCOME_TONES: Readonly<Record<TicketOutcomeDto, string>> = {
  estimated: 'finalized',
  skipped: 'skipped',
  unresolved: 'unresolved',
  'in-progress': 'voting',
};

export const SYNC_LABELS: Readonly<Record<SyncStateDto, string>> = {
  'not-required': 'Not saved to Jira',
  pending: 'Waiting to save',
  syncing: 'Saving',
  succeeded: 'Saved to Jira',
  failed: 'Save failed',
  conflict: 'Changed in Jira',
};

export const HISTORY_STATUS_LABELS: Readonly<Record<HistoryStatusDto, string>> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const PARTICIPANT_CATEGORY_LABELS: readonly {
  readonly key: keyof ParticipantCategoriesView;
  readonly label: string;
  readonly description: string;
}[] = [
  { key: 'invited', label: 'Invited', description: 'Everyone who received an invitation' },
  { key: 'joined', label: 'Joined', description: 'Accepted their invitation' },
  { key: 'voting', label: 'Voted', description: 'Had a vote counted in at least one round' },
  { key: 'observing', label: 'Observed', description: 'Observers and non-voting facilitators' },
  { key: 'skipped', label: 'Skipped', description: 'Skipped for a ticket or the session' },
  { key: 'declined', label: 'Declined', description: 'Declined their invitation' },
  { key: 'revoked', label: 'Removed', description: 'Invitation revoked by a moderator' },
  { key: 'noResponse', label: 'No response', description: 'Never answered their invitation' },
  { key: 'facilitators', label: 'Facilitators', description: 'Ran the session' },
];

/** Plain-language names for audit event types; unknown types fall back to the raw type. */
const AUDIT_LABELS: Readonly<Record<string, string>> = {
  'session.created': 'Session created',
  'session.settings-changed': 'Settings changed',
  'session.published': 'Session published',
  'session.paused': 'Session paused',
  'session.resumed': 'Session resumed',
  'session.completed': 'Session completed',
  'session.cancelled': 'Session cancelled',
  'participant.invited': 'Invited',
  'participant.responded': 'Responded to invitation',
  'participant.invitation-revoked': 'Invitation revoked',
  'participant.role-changed': 'Role changed',
  'participant.skipped': 'Member skipped',
  'participant.restored': 'Member restored',
  'ticket.added': 'Tickets added',
  'ticket.removed': 'Ticket removed',
  'ticket.reordered': 'Tickets reordered',
  'ticket.current-changed': 'Current ticket changed',
  'ticket.skipped': 'Ticket skipped',
  'round.started': 'New round started',
  'round.revealed': 'Results revealed',
  'estimate.finalized': 'Estimate accepted',
  'estimate.overridden': 'Estimate overridden',
  'sync.completed': 'Jira update finished',
  'sync.retried': 'Jira update retried',
};

export function auditLabel(type: string): string {
  return AUDIT_LABELS[type] ?? type;
}

export function formatDateTime(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleString();
}

export function formatDate(iso: string | null): string {
  return iso === null ? '—' : new Date(iso).toLocaleDateString();
}
