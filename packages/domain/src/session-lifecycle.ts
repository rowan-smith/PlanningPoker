import type { ScoringDeck } from './deck';
import { isRegularCard, validateDeck } from './deck';
import { ensure } from './errors';
import type { FieldMapping } from './estimate';
import { mapCardToField } from './estimate';
import type { Session } from './session';
import { ensureActive, intendedVoterIds, orderedTickets, touch } from './session';
import { setCurrentTicket } from './session-voting';
import type { Team } from './team';
import { isTicketClosed, latestRound } from './ticket';

export type ReadinessSeverity = 'error' | 'warning';

export interface ReadinessIssue {
  readonly code: string;
  readonly severity: ReadinessSeverity;
  readonly message: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly issues: readonly ReadinessIssue[];
}

function mappingIssues(deck: ScoringDeck, mapping: FieldMapping): ReadinessIssue[] {
  if (mapping.valueType === 'number' && deck.scale !== 'numeric') {
    return [
      {
        code: 'field-incompatible',
        severity: 'error',
        message: `${mapping.fieldName} is a number field but the ${deck.name} deck is not numeric.`,
      },
    ];
  }

  const unmapped = deck.cards
    .filter(isRegularCard)
    .filter((card) => !mapCardToField(card, mapping).ok)
    .map((card) => card.label);

  return unmapped.length === 0
    ? []
    : [
        {
          code: 'field-unmapped-cards',
          severity: 'error',
          message: `${mapping.fieldName} has no value for: ${unmapped.join(', ')}.`,
        },
      ];
}

/** Checks everything a moderator must fix (errors) or should know (warnings) before publishing. */
export function checkReadiness(session: Session, team: Team): ReadinessReport {
  const issues: ReadinessIssue[] = [];
  const add = (code: string, severity: ReadinessSeverity, message: string): void => {
    issues.push({ code, severity, message });
  };
  const { settings } = session;

  if (session.name.length === 0) {
    add('name-missing', 'error', 'Give the session a name.');
  }

  if (team.id !== session.teamId || team.archived) {
    add('team-invalid', 'error', 'Choose an active team.');
  }

  if (session.tickets.length === 0) {
    add('no-tickets', 'error', 'Add at least one ticket.');
  }

  for (const problem of validateDeck(settings.deck)) {
    add('deck-invalid', 'error', problem);
  }

  if (settings.destinationField === null) {
    add('no-destination', 'warning', 'Final estimates will not be saved to the work item.');
  }

  for (const mapping of [
    ...(settings.destinationField === null ? [] : [settings.destinationField]),
    ...settings.additionalWritableFields,
  ]) {
    issues.push(...mappingIssues(settings.deck, mapping));
  }

  if (intendedVoterIds(session).length === 0) {
    add('no-voters', 'error', 'Add at least one voter.');
  }

  const userIds = session.participants.map((participant) => participant.userId);

  if (new Set(userIds).size !== userIds.length) {
    add('duplicate-participants', 'error', 'Each person can appear on the roster only once.');
  }

  const inconsistent = session.participants.some(
    (participant) =>
      participant.invitation !== null &&
      (participant.invitation.role !== participant.role ||
        participant.invitation.invitedUserId !== participant.userId),
  );

  if (inconsistent) {
    add('roles-inconsistent', 'error', 'Some invitations do not match their participant role.');
  }

  if (!session.participants.some((participant) => participant.isFacilitator)) {
    add('no-facilitator', 'error', 'The session needs a facilitator.');
  }

  if (settings.deck.cards.some((card) => !isRegularCard(card))) {
    add('special-cards', 'warning', 'Agreement on a special card needs a moderator decision.');
  }

  if (settings.autoAdvance && !settings.autoFinalize) {
    add('auto-advance-unused', 'warning', 'Auto-advance only follows automatic finalization.');
  }

  return { ready: !issues.some((issue) => issue.severity === 'error'), issues };
}

export function markReady(session: Session, team: Team, now: Date): Session {
  ensure(session.status === 'draft', 'INVALID_STATE', 'Only draft sessions can be marked ready.');
  const report = checkReadiness(session, team);
  ensure(
    report.ready,
    'VALIDATION',
    report.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message)
      .join(' '),
  );

  return { ...touch(session, now), status: 'ready' };
}

/** Publishes a ready session and opens voting on its first ticket. */
export function publishSession(session: Session, now: Date): Session {
  ensure(session.status === 'ready', 'INVALID_STATE', 'Mark the session ready before publishing.');
  const [first] = orderedTickets(session);
  ensure(first !== undefined, 'VALIDATION', 'Add at least one ticket.');
  const active: Session = { ...touch(session, now), status: 'active', publishedAt: now };

  return setCurrentTicket(active, first.id, now);
}

export function pauseSession(session: Session, now: Date): Session {
  ensureActive(session);

  return { ...touch(session, now), status: 'paused' };
}

export function resumeSession(session: Session, now: Date): Session {
  ensure(session.status === 'paused', 'INVALID_STATE', 'The session is not paused.');

  return { ...touch(session, now), status: 'active' };
}

/** Completes the session. Tickets without an outcome become unresolved; open rounds close. */
export function completeSession(session: Session, now: Date): Session {
  ensure(
    session.status === 'active' || session.status === 'paused',
    'INVALID_STATE',
    'Only running sessions can be completed.',
  );

  return {
    ...touch(session, now),
    status: 'completed',
    completedAt: now,
    tickets: session.tickets.map((ticket) => {
      if (isTicketClosed(ticket)) {
        return ticket;
      }

      const round = latestRound(ticket);

      return {
        ...ticket,
        votingState: 'unresolved',
        rounds:
          round !== undefined && (round.status === 'open' || round.status === 'pending')
            ? [...ticket.rounds.slice(0, -1), { ...round, status: 'superseded' }]
            : ticket.rounds,
      };
    }),
  };
}

export function cancelSession(session: Session, now: Date): Session {
  ensure(
    session.status !== 'completed' && session.status !== 'cancelled',
    'INVALID_STATE',
    'The session is already closed.',
  );

  return { ...touch(session, now), status: 'cancelled' };
}
