import { describe, expect, it } from 'vitest';

import {
  addTickets,
  asId,
  assignTeamModerator,
  beginSync,
  checkReadiness,
  completeSync,
  computeResult,
  createDraftSession,
  createPresetDeck,
  createTeam,
  DomainError,
  inviteParticipant,
  pendingExternalUpdate,
  removeTeamMember,
  retryAvailableAt,
  retrySync,
  STUCK_SYNC_AFTER_MS,
  roundProgress,
  unassignTeamModerator,
} from '../src';
import type {
  CardId,
  DeckId,
  InvitationId,
  RoundId,
  SessionId,
  TeamId,
  TenantId,
  TicketId,
  UserId,
  Vote,
  VotingRound,
} from '../src';

const now = new Date('2026-01-01T09:00:00.000Z');
const tenantId = asId<TenantId>('tenant-1');
const user = (id: string): UserId => asId<UserId>(id);

describe('teams', () => {
  const team = createTeam({
    id: asId<TeamId>('team-1'),
    tenantId,
    name: '  Platform  ',
    createdBy: user('mod'),
    now,
  });

  it('trims names and makes the creator a moderator and member', () => {
    expect(team.name).toBe('Platform');
    expect(team.moderatorIds).toEqual([user('mod')]);
    expect(team.members.map((member) => member.userId)).toEqual([user('mod')]);
  });

  it('always keeps at least one moderator', () => {
    expect(() => unassignTeamModerator(team, user('mod'), now)).toThrow(DomainError);
    expect(() => removeTeamMember(team, user('mod'), now)).toThrow(DomainError);

    const twoModerators = assignTeamModerator(team, user('second'), now);
    expect(unassignTeamModerator(twoModerators, user('mod'), now).moderatorIds).toEqual([
      user('second'),
    ]);
  });
});

describe('round results', () => {
  const deck = createPresetDeck(asId<DeckId>('deck'), 'fibonacci', ['coffee']);
  const card = (label: string): CardId => {
    const found = deck.cards.find((entry) => entry.label === label);

    if (found === undefined) {
      throw new Error(`No card ${label}`);
    }

    return found.id;
  };
  const roundId = asId<RoundId>('round-1');
  const round: VotingRound = {
    id: roundId,
    ticketId: asId<TicketId>('ticket-1'),
    number: 1,
    status: 'open',
    roster: {
      snapshotVoterIds: [user('a'), user('b'), user('c'), user('d')],
      exclusions: [{ userId: user('d'), reason: 'skipped-for-ticket' }],
      frozenAt: now,
    },
    openedAt: now,
    revealedAt: null,
    result: null,
  };
  const vote = (userId: string, label: string): Vote => ({
    roundId,
    userId: user(userId),
    cardId: card(label),
    submittedAt: now,
  });

  it('counts only required voters and ignores excluded or outsider votes', () => {
    const votes = [vote('a', '5'), vote('b', '5'), vote('d', '13'), vote('outsider', '1')];
    const progress = roundProgress(round, votes);

    expect(progress).toMatchObject({ requiredCount: 3, votedCount: 2, isComplete: false });
  });

  it('produces an anonymous distribution ordered by deck, not by voter', () => {
    const result = computeResult(round, [vote('c', '8'), vote('a', '3'), vote('b', '8')], deck);

    expect(result.outcome).toBe('disputed');
    expect(result.values).toEqual(['3', '8', '8']);
    expect(result.distribution).toEqual([
      { cardId: card('3'), label: '3', count: 1 },
      { cardId: card('8'), label: '8', count: 2 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/"a"|"b"|"c"/);
  });

  it('flags a unanimous special card for moderator resolution', () => {
    const result = computeResult(round, [vote('a', '☕'), vote('b', '☕'), vote('c', '☕')], deck);

    expect(result.outcome).toBe('unanimous');
    expect(result.requiresModeratorResolution).toBe(true);
  });

  it('never completes a round with zero required voters', () => {
    const empty: VotingRound = {
      ...round,
      roster: {
        snapshotVoterIds: [user('a')],
        exclusions: [{ userId: user('a'), reason: 'skipped-for-session' }],
        frozenAt: now,
      },
    };

    expect(roundProgress(empty, []).isComplete).toBe(false);
  });
});

describe('external update state machine', () => {
  const pending = pendingExternalUpdate('customfield_1', 5, 'ticket-1:round-1');

  it('moves pending → syncing → failed → pending on retry', () => {
    const failed = completeSync(beginSync(pending, now), 'failed', 'Timeout', now);

    expect(failed.state).toBe('failed');
    expect(failed.attempts).toHaveLength(1);
    expect(retrySync(failed, false, now).state).toBe('pending');
  });

  it('requires explicit confirmation to retry a conflict', () => {
    const conflict = completeSync(beginSync(pending, now), 'conflict', 'Changed', now);

    expect(() => retrySync(conflict, false, now)).toThrow(/Confirm/);
    expect(retrySync(conflict, true, now)).toMatchObject({
      state: 'pending',
      overwriteConfirmed: true,
    });
  });

  it('lets a sync stuck in syncing be retried only after the timeout, closing the attempt', () => {
    const syncing = beginSync(pending, now);
    const early = new Date(now.getTime() + STUCK_SYNC_AFTER_MS - 1);
    const late = new Date(now.getTime() + STUCK_SYNC_AFTER_MS);

    expect(retryAvailableAt(syncing)).toEqual(late);
    expect(() => retrySync(syncing, false, early)).toThrow(/still in progress/);

    const retried = retrySync(syncing, false, late);

    expect(retried).toMatchObject({ state: 'pending', idempotencyKey: 'ticket-1:round-1' });
    expect(retried.attempts).toEqual([
      expect.objectContaining({ outcome: 'failed', finishedAt: late }),
    ]);
    expect(retryAvailableAt(pending)).toBeNull();
  });

  it('rejects out-of-order transitions', () => {
    expect(() => completeSync(pending, 'succeeded', null, now)).toThrow(DomainError);
    expect(() => retrySync(pending, true, now)).toThrow(DomainError);
  });
});

describe('session readiness', () => {
  const team = createTeam({
    id: asId<TeamId>('team-1'),
    tenantId,
    name: 'Team',
    createdBy: user('mod'),
    now,
  });
  const draft = createDraftSession({
    id: asId<SessionId>('session-1'),
    tenantId,
    name: 'Sprint 12',
    teamId: team.id,
    createdBy: user('mod'),
    deck: createPresetDeck(asId<DeckId>('deck'), 'fibonacci'),
    now,
  });

  it('starts the creator as a non-voting facilitator', () => {
    expect(draft.participants).toEqual([
      { userId: user('mod'), role: 'observer', isFacilitator: true, invitation: null },
    ]);
  });

  it('reports missing tickets and voters as errors', () => {
    const report = checkReadiness(draft, team);

    expect(report.ready).toBe(false);
    expect(
      report.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code),
    ).toEqual(['no-tickets', 'no-voters']);
  });

  it('is ready with a ticket and a voter, warning about the missing destination field', () => {
    const withVoter = inviteParticipant(draft, {
      invitationId: asId<InvitationId>('inv-1'),
      userId: user('alex'),
      role: 'voter',
      invitedBy: user('mod'),
      now,
    });
    const withTicket = addTickets(
      withVoter,
      [
        {
          id: asId<TicketId>('ticket-1'),
          firstRoundId: asId<RoundId>('round-1'),
          reference: {
            provider: 'jira',
            installationId: 'site',
            itemId: '10001',
            displayKey: 'PP-1',
            url: null,
          },
          snapshot: {
            title: 'Login',
            description: null,
            itemType: null,
            status: null,
            displayFields: {},
            fieldValues: {},
          },
        },
      ],
      now,
    );
    const report = checkReadiness(withTicket, team);

    expect(report.ready).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toEqual(['no-destination']);
  });

  it('ignores duplicate work items when adding tickets', () => {
    const reference = {
      provider: 'jira',
      installationId: 'site',
      itemId: '10001',
      displayKey: 'PP-1',
      url: null,
    };
    const snapshot = {
      title: 'Login',
      description: null,
      itemType: null,
      status: null,
      displayFields: {},
      fieldValues: {},
    };
    const once = addTickets(
      draft,
      [{ id: asId<TicketId>('t1'), firstRoundId: asId<RoundId>('r1'), reference, snapshot }],
      now,
    );
    const twice = addTickets(
      once,
      [{ id: asId<TicketId>('t2'), firstRoundId: asId<RoundId>('r2'), reference, snapshot }],
      now,
    );

    expect(twice.tickets).toHaveLength(1);
  });
});
