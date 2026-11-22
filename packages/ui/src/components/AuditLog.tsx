import type { AuditLogView } from '@planning-poker/contracts';
import { useCallback } from 'react';

import type { PlanningPokerApi } from '../api';
import { useLoad } from '../hooks';
import { auditLabel, formatDateTime } from '../report-labels';
import { EmptyState } from './EmptyState';
import { ErrorMessage, Loading } from './Feedback';

export interface AuditLogProps {
  readonly api: PlanningPokerApi;
  readonly sessionId: string;
}

/** A session's audit trail for moderators: who did what and when, never vote values. */
export function AuditLog({ api, sessionId }: AuditLogProps) {
  const load = useCallback(
    async () => await api.call('listAuditEvents', { sessionId }),
    [api, sessionId],
  );
  const { state } = useLoad<AuditLogView>(load);

  if (state.status === 'loading') {
    return <Loading />;
  }

  if (state.status === 'failed') {
    return <ErrorMessage message={state.message} />;
  }

  if (state.value.events.length === 0) {
    return <EmptyState title="No audit events" message="Nothing has been recorded yet." />;
  }

  return (
    <div className="pp-table-wrap">
      <table className="pp-table">
        <caption className="pp-visually-hidden">Audit events for {state.value.sessionName}</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Event</th>
            <th scope="col">By</th>
            <th scope="col">Person</th>
            <th scope="col">Ticket</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {state.value.events.map((event) => (
            <tr key={event.id}>
              <td>{formatDateTime(event.occurredAt)}</td>
              <th scope="row">{auditLabel(event.type)}</th>
              <td>{event.actorName ?? 'System'}</td>
              <td>{event.subjectName ?? '—'}</td>
              <td className="pp-mono">{event.ticketDisplayKey ?? '—'}</td>
              <td>
                {event.details.length === 0
                  ? '—'
                  : event.details.map((detail) => `${detail.key}: ${detail.value}`).join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
