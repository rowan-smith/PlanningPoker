import type { ConsensusDecision } from './estimate';
import type { ExternalUpdate } from './external-update';
import type { TicketId } from './ids';
import type { VotingRound } from './voting';

/**
 * Provider-neutral identity of an external work item. The provider's display key (e.g. a Jira
 * issue key) is for display only and never used as an identifier.
 */
export interface WorkItemReference {
  readonly provider: string;
  readonly installationId: string;
  readonly itemId: string;
  readonly displayKey: string;
  readonly url: string | null;
}

export function workItemKey(reference: WorkItemReference): string {
  return [reference.provider, reference.installationId, reference.itemId].join('|');
}

/** Ticket content captured at import. Description is plain text; render it as text, never HTML. */
export interface WorkItemSnapshot {
  readonly title: string;
  readonly description: string | null;
  readonly itemType: string | null;
  readonly status: string | null;
  readonly displayFields: Readonly<Record<string, string>>;
  /** Values of writable fields at import time, used to detect external changes before writing. */
  readonly fieldValues: Readonly<Record<string, string | number | null>>;
}

export type TicketVotingState =
  'pending' | 'voting' | 'revealed' | 'revoting' | 'finalized' | 'skipped' | 'unresolved';

export interface SessionTicket {
  readonly id: TicketId;
  readonly order: number;
  readonly reference: WorkItemReference;
  readonly snapshot: WorkItemSnapshot;
  readonly votingState: TicketVotingState;
  readonly rounds: readonly VotingRound[];
  readonly decision: ConsensusDecision | null;
  readonly externalUpdate: ExternalUpdate;
}

export function latestRound(ticket: SessionTicket): VotingRound | undefined {
  return ticket.rounds.at(-1);
}

export function isTicketClosed(ticket: SessionTicket): boolean {
  return (
    ticket.votingState === 'finalized' ||
    ticket.votingState === 'skipped' ||
    ticket.votingState === 'unresolved'
  );
}
