import type { AuthorizationContext, Session, TicketId } from '@planning-poker/domain';

import { ReportService } from '../src';
import type { Harness } from './support';
import { publishedSession, TENANT } from './support';

/** A card label used only by the vote that is discarded when its voter is skipped. */
export const DISCARDED_VOTE_LABEL = '89';

export interface CompletedScenario {
  readonly h: Harness;
  readonly reports: ReportService;
  /** v1–v4 joined voters; v4 is skipped for the first ticket after voting. */
  readonly voters: readonly [
    AuthorizationContext,
    AuthorizationContext,
    AuthorizationContext,
    AuthorizationContext,
  ];
  readonly observer: AuthorizationContext;
  /** Invited as a voter and declined. */
  readonly decliner: AuthorizationContext;
  /** Invited as a voter, never responded, skipped for the session. */
  readonly absent: AuthorizationContext;
  /** A team member who is not on the session roster. */
  readonly outsider: AuthorizationContext;
  readonly tickets: {
    readonly unanimous: TicketId;
    readonly overridden: TicketId;
    readonly skipped: TicketId;
    readonly unresolved: TicketId;
  };
  stored(): Promise<Session>;
}

/**
 * A completed session covering every report category:
 * 1. unanimous "3" with v4 skipped for the ticket (after voting "89"), accepted;
 * 2. disputed, revoted, still disputed, overridden to "5" with a reason (absent skipped);
 * 3. skipped ticket; 4. left unresolved when the session completes.
 */
export async function completedScenario(): Promise<CompletedScenario> {
  const h = await publishedSession({ voters: 4, observers: 1, tickets: 4 });
  const [v1, v2, v3, v4] = h.voters;
  const [observer] = h.observers;
  const [unanimous, overridden, skipped, unresolved] = h.ticketIds;

  if (
    v1 === undefined ||
    v2 === undefined ||
    v3 === undefined ||
    v4 === undefined ||
    observer === undefined ||
    unanimous === undefined ||
    overridden === undefined ||
    skipped === undefined ||
    unresolved === undefined
  ) {
    throw new Error('setup');
  }

  const decliner = h.addUser('decliner');
  const absent = h.addUser('absent');
  const outsider = h.addUser('outsider');
  const team = (await h.app.teams.listForTenant(TENANT))[0];

  if (team === undefined) {
    throw new Error('setup');
  }

  await h.teamService.addMember(h.moderator, team.id, outsider.userId);
  await h.service.inviteParticipant(h.moderator, h.sessionId, decliner.userId, 'voter');
  await h.service.inviteParticipant(h.moderator, h.sessionId, absent.userId, 'voter');
  await h.service.respondToInvitation(decliner, h.sessionId, 'declined');

  // Ticket 1: v4 votes, then is skipped; their vote must never appear anywhere.
  await h.vote(v4, DISCARDED_VOTE_LABEL);
  await h.service.skipParticipant(h.moderator, h.sessionId, v4.userId, 'ticket');

  for (const voter of [v1, v2, v3]) {
    await h.vote(voter, '3');
  }

  await h.service.acceptConsensus(h.moderator, h.sessionId, unanimous);
  await h.service.advance(h.moderator, h.sessionId);

  // Ticket 2: the absent invitee is on the roster and must be skipped for the round to reveal.
  await h.service.skipParticipant(h.moderator, h.sessionId, absent.userId, 'session');
  await h.vote(v1, '3');
  await h.vote(v2, '5');
  await h.vote(v3, '5');
  await h.vote(v4, '8');
  await h.service.startNewRound(h.moderator, h.sessionId, overridden);
  await h.vote(v1, '5');
  await h.vote(v2, '5');
  await h.vote(v3, '5');
  await h.vote(v4, '8');
  await h.service.overrideEstimate(
    h.moderator,
    h.sessionId,
    overridden,
    h.card('5'),
    'The 8 assumed work already done.',
  );
  await h.service.advance(h.moderator, h.sessionId);

  // Ticket 3 skipped; ticket 4 left unresolved.
  await h.service.skipTicket(h.moderator, h.sessionId, skipped);
  await h.service.complete(h.moderator, h.sessionId);

  return {
    h,
    reports: new ReportService(h.app.deps),
    voters: [v1, v2, v3, v4],
    observer,
    decliner,
    absent,
    outsider,
    tickets: { unanimous, overridden, skipped, unresolved },
    async stored() {
      const session = await h.app.sessions.get(TENANT, h.sessionId);

      if (session === null) {
        throw new Error('missing session');
      }

      return session;
    },
  };
}
