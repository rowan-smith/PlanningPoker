import type { Session, SessionTicket, WorkItemSnapshot } from '@planning-poker/domain';
import { currentTicket, workItemKey } from '@planning-poker/domain';

import type { WorkItemProvider } from './ports';

/** Shown in place of a ticket's title when the viewer cannot see the work item themselves. */
export const RESTRICTED_TITLE = 'Restricted work item';

const RESTRICTED_SNAPSHOT: WorkItemSnapshot = {
  title: RESTRICTED_TITLE,
  description: null,
  itemType: null,
  status: null,
  displayFields: {},
  fieldValues: {},
};

export type TicketScope = 'all' | 'current';

function ticketsIn(session: Session, scope: TicketScope): readonly SessionTicket[] {
  if (scope === 'all') {
    return session.tickets;
  }

  const current = currentTicket(session);

  return current === undefined ? [] : [current];
}

/**
 * Ticket snapshots are captured with the importing moderator's permissions. Before a session
 * reaches a view, every ticket the viewer cannot see in the provider loses its content (title,
 * description, type, status, fields, link); its key stays so people can still refer to it. A
 * failed visibility check hides everything: access is never granted by default.
 *
 * The returned sessions are for views only and must never be saved.
 */
export async function redactRestrictedTickets(
  workItems: WorkItemProvider,
  sessions: readonly Session[],
  scope: TicketScope = 'all',
): Promise<Session[]> {
  const references = sessions.flatMap((session) =>
    ticketsIn(session, scope).map((ticket) => ticket.reference),
  );

  if (references.length === 0) {
    return [...sessions];
  }

  let visible: ReadonlySet<string>;

  try {
    visible = await workItems.visibleItems(references);
  } catch {
    // Fail closed: without a working permission check, nobody sees ticket content.
    visible = new Set();
  }

  return sessions.map((session) => {
    const hidden = new Set(
      ticketsIn(session, scope)
        .filter((ticket) => !visible.has(workItemKey(ticket.reference)))
        .map((ticket) => ticket.id),
    );

    return hidden.size === 0
      ? session
      : {
          ...session,
          tickets: session.tickets.map((ticket) =>
            hidden.has(ticket.id)
              ? {
                  ...ticket,
                  reference: { ...ticket.reference, url: null },
                  snapshot: RESTRICTED_SNAPSHOT,
                }
              : ticket,
          ),
        };
  });
}

export async function redactRestrictedTicketsOf(
  workItems: WorkItemProvider,
  session: Session,
): Promise<Session> {
  const [redacted] = await redactRestrictedTickets(workItems, [session]);

  return redacted ?? session;
}
