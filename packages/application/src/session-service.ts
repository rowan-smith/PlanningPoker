import type {
  DeckChoice,
  DisplayFieldsView,
  HomeView,
  InvitationView,
  SessionBuilderView,
  SessionEvent,
  SessionListView,
  SessionView,
  WorkItemSearchView,
} from '@planning-poker/contracts';
import type {
  AuditEventType,
  AuthorizationContext,
  CardId,
  DeckId,
  DeckPreset,
  InvitationId,
  ParticipationRole,
  ReadinessReport,
  RoundId,
  Session,
  SessionId,
  SessionSettingsChanges,
  SkipScope,
  SpecialCardType,
  Team,
  TicketId,
  UserId,
  UserIdentity,
  Vote,
  VotingRound,
} from '@planning-poker/domain';
import {
  addTickets,
  advanceToNextTicket,
  asId,
  beginTicketSync,
  canAutoFinalize,
  cancelSession,
  canReveal,
  castVote,
  changeParticipantRole,
  checkReadiness,
  completeSession,
  completeTicketSync,
  createDraftSession,
  createPresetDeck,
  currentTicket,
  DomainError,
  finalizeConsensus,
  findParticipant,
  findTicket,
  inviteParticipant,
  isEditable,
  isRunning,
  latestRound,
  markReady,
  nextOpenTicket,
  overrideEstimate,
  participantStatus,
  pauseSession,
  publishSession,
  refreshTicketSnapshots,
  removeDraftParticipant,
  removeTicket,
  renameSession,
  reorderTickets,
  requireTicket,
  respondToInvitation,
  restoreParticipant,
  resumeSession,
  retryTicketSync,
  revealRound,
  revokeInvitation,
  roundProgress,
  setCurrentTicket,
  skipParticipant,
  skipTicket,
  startNewRound,
  updateSessionSettings,
  workItemKey,
} from '@planning-poker/domain';

import { canManageTeam, canModerateSession, canViewSession, forbid } from './authorization';
import type { ApplicationDependencies, AuditInput } from './dependencies';
import { auditEvent } from './dependencies';
import type {
  ImportedWorkItem,
  QuerySuggestion,
  UpdateResult,
  WorkItemFieldSelection,
  WorkItemUpdateRequest,
} from './ports';
import { deckFromChoice, scoringSettingsView } from './decks';
import { userView } from './team-service';
import { currentUserView, displayName, sessionSummaryView, sessionView } from './views';

type Access = 'moderate' | 'view';

type PendingAudit = Omit<AuditInput, 'actor' | 'tenantId'> & { readonly system?: boolean };

interface MutationContext {
  readonly session: Session;
  readonly team: Team;
  readonly now: Date;
}

interface MutationOutcome {
  readonly session: Session;
  readonly audit?: readonly PendingAudit[];
  readonly events?: readonly SessionEvent[];
}

const MAX_IMPORT_KEYS = 100;
const MAX_DISPLAY_FIELDS = 5;

function fieldSelection(session: Session): WorkItemFieldSelection {
  const { destinationField, additionalWritableFields, displayFieldIds } = session.settings;

  return {
    displayFieldIds,
    valueFieldIds: [
      ...(destinationField === null ? [] : [destinationField.fieldId]),
      ...additionalWritableFields.map((field) => field.fieldId),
    ],
  };
}

const SYNC_FAILURE_MESSAGE = 'The work item could not be updated. Try again later.';

/**
 * Session use cases. Every state change runs inside AtomicOperation for the session, is
 * authorized against server state, audited, and followed by an authorized realtime notification.
 */
export class SessionService {
  private readonly deps: ApplicationDependencies;

  constructor(deps: ApplicationDependencies) {
    this.deps = deps;
  }

  // -------------------------------------------------------------------------------------------
  // Draft building
  // -------------------------------------------------------------------------------------------

  async createDraft(
    actor: AuthorizationContext,
    input: {
      readonly name: string;
      readonly teamId: Team['id'];
      readonly deckPreset?: DeckPreset;
      readonly specialCards?: readonly SpecialCardType[];
    },
  ): Promise<Session> {
    const team = await this.deps.teams.get(actor.tenantId, input.teamId);

    if (team === null) {
      throw new DomainError('NOT_FOUND', 'Team not found.');
    }

    if (!canManageTeam(actor, team) || team.archived) {
      forbid('You cannot create sessions for this team.');
    }

    const now = this.deps.clock.now();
    const session = createDraftSession({
      id: asId<SessionId>(this.deps.ids.next()),
      tenantId: actor.tenantId,
      name: input.name,
      teamId: team.id,
      createdBy: actor.userId,
      deck: createPresetDeck(
        asId<DeckId>(this.deps.ids.next()),
        input.deckPreset ?? 'fibonacci',
        input.specialCards ?? [],
      ),
      now,
    });
    const saved = await this.deps.sessions.save(session);
    await this.deps.participants.replaceForSession(saved);
    await this.deps.audit.append([
      auditEvent(this.deps, {
        type: 'session.created',
        actor,
        tenantId: actor.tenantId,
        teamId: team.id,
        sessionId: saved.id,
      }),
    ]);

    return saved;
  }

  /** Team members not yet on the roster, offered as default participants. */
  async suggestedParticipants(
    actor: AuthorizationContext,
    sessionId: SessionId,
  ): Promise<readonly UserId[]> {
    const { session, team } = await this.loadAuthorized(actor, sessionId, 'moderate');

    return team.members
      .map((member) => member.userId)
      .filter((userId) => findParticipant(session, userId) === undefined);
  }

  async rename(actor: AuthorizationContext, sessionId: SessionId, name: string): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: renameSession(session, name, now),
      audit: [{ type: 'session.settings-changed', details: { field: 'name' } }],
    }));
  }

  async updateSettings(
    actor: AuthorizationContext,
    sessionId: SessionId,
    changes: SessionSettingsChanges,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: updateSessionSettings(session, changes, now),
      audit: [
        { type: 'session.settings-changed', details: { fields: Object.keys(changes).join(',') } },
      ],
    }));
  }

  async addTickets(
    actor: AuthorizationContext,
    sessionId: SessionId,
    items: readonly ImportedWorkItem[],
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => {
      const updated = addTickets(
        session,
        items.map((item) => ({
          id: asId<TicketId>(this.deps.ids.next()),
          firstRoundId: asId<RoundId>(this.deps.ids.next()),
          reference: item.reference,
          snapshot: item.snapshot,
        })),
        now,
      );

      return {
        session: updated,
        audit: [
          {
            type: 'ticket.added',
            details: { count: updated.tickets.length - session.tickets.length },
          },
        ],
      };
    });
  }

  /** Looks up keys with the work-item provider and adds the ones found. Safe to retry. */
  async importByKeys(
    actor: AuthorizationContext,
    sessionId: SessionId,
    keys: readonly string[],
  ): Promise<{ readonly session: Session; readonly missing: readonly string[] }> {
    const { session: current } = await this.loadAuthorized(actor, sessionId, 'moderate');
    const unique = [...new Set(keys.map((key) => key.trim()).filter((key) => key.length > 0))];

    if (unique.length > MAX_IMPORT_KEYS) {
      throw new DomainError(
        'VALIDATION',
        `Import at most ${String(MAX_IMPORT_KEYS)} keys at once.`,
      );
    }

    const { found, missing } = await this.deps.workItems.getItems(unique, fieldSelection(current));
    const session = await this.addTickets(actor, sessionId, found);

    return { session, missing };
  }

  /** Searches the work-item provider as the moderator, marking items already in the session. */
  async searchWorkItems(
    actor: AuthorizationContext,
    sessionId: SessionId,
    query: string,
    cursor: string | null,
  ): Promise<WorkItemSearchView> {
    const { session } = await this.loadAuthorized(actor, sessionId, 'moderate');
    const trimmed = query.trim();

    if (trimmed.length === 0) {
      throw new DomainError('VALIDATION', 'Enter a search query.');
    }

    const page = await this.deps.workItems.search(trimmed, cursor, fieldSelection(session));
    const existing = new Set(session.tickets.map((ticket) => workItemKey(ticket.reference)));

    return {
      items: page.items.map((item) => ({
        key: item.reference.displayKey,
        title: item.snapshot.title,
        itemType: item.snapshot.itemType,
        status: item.snapshot.status,
        alreadyAdded: existing.has(workItemKey(item.reference)),
      })),
      nextCursor: page.nextCursor,
    };
  }

  async suggestQuery(
    actor: AuthorizationContext,
    sessionId: SessionId,
    partialQuery: string,
  ): Promise<readonly QuerySuggestion[]> {
    await this.loadAuthorized(actor, sessionId, 'moderate');

    return await this.deps.workItems.suggestQuery(partialQuery);
  }

  async getDisplayFields(
    actor: AuthorizationContext,
    sessionId: SessionId,
  ): Promise<DisplayFieldsView> {
    const { session } = await this.loadAuthorized(actor, sessionId, 'moderate');
    const fields = await this.deps.workItems.discoverFields();

    return {
      available: fields
        .map((field) => ({ id: field.fieldId, name: field.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      selectedIds: [...session.settings.displayFieldIds],
    };
  }

  /** Chooses the extra fields shown on tickets and refreshes tickets already in the draft. */
  async setDisplayFields(
    actor: AuthorizationContext,
    sessionId: SessionId,
    fieldIds: readonly string[],
  ): Promise<Session> {
    const unique = [...new Set(fieldIds)];

    if (unique.length > MAX_DISPLAY_FIELDS) {
      throw new DomainError('VALIDATION', `Choose at most ${String(MAX_DISPLAY_FIELDS)} fields.`);
    }

    const known = new Set((await this.deps.workItems.discoverFields()).map((f) => f.fieldId));

    if (!unique.every((id) => known.has(id))) {
      throw new DomainError('VALIDATION', 'Choose fields from the list.');
    }

    const updated = await this.updateSettings(actor, sessionId, { displayFieldIds: unique });

    if (updated.tickets.length === 0) {
      return updated;
    }

    const { found } = await this.deps.workItems.getItems(
      updated.tickets.map((ticket) => ticket.reference.displayKey),
      fieldSelection(updated),
    );

    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: refreshTicketSnapshots(session, found, now),
    }));
  }

  async removeTicket(
    actor: AuthorizationContext,
    sessionId: SessionId,
    ticketId: TicketId,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: removeTicket(session, ticketId, now),
      audit: [{ type: 'ticket.removed', ticketId }],
    }));
  }

  async reorderTickets(
    actor: AuthorizationContext,
    sessionId: SessionId,
    orderedIds: readonly TicketId[],
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: reorderTickets(session, orderedIds, now),
      audit: [{ type: 'ticket.reordered' }],
    }));
  }

  async checkReadiness(
    actor: AuthorizationContext,
    sessionId: SessionId,
  ): Promise<ReadinessReport> {
    const { session, team } = await this.loadAuthorized(actor, sessionId, 'moderate');

    return checkReadiness(session, team);
  }

  async markReady(actor: AuthorizationContext, sessionId: SessionId): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, team, now }) => ({
      session: markReady(session, team, now),
    }));
  }

  async publish(actor: AuthorizationContext, sessionId: SessionId): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, team, now }) => {
      const report = checkReadiness(session, team);

      if (!report.ready) {
        throw new DomainError('VALIDATION', 'Fix the readiness errors before publishing.');
      }

      // A draft that passes readiness is marked ready and published in one step.
      const ready = session.status === 'draft' ? markReady(session, team, now) : session;
      const published = publishSession(ready, now);

      return {
        session: published,
        audit: [{ type: 'session.published' }],
        events: [
          { type: 'session.activated' },
          { type: 'ticket.current-changed', ticketId: published.currentTicketId ?? '' },
        ],
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Participants
  // -------------------------------------------------------------------------------------------

  async inviteParticipant(
    actor: AuthorizationContext,
    sessionId: SessionId,
    userId: UserId,
    role: ParticipationRole,
  ): Promise<Session> {
    const [user] = await this.deps.identity.getUsers(actor.tenantId, [userId]);

    if (user === undefined) {
      throw new DomainError('NOT_FOUND', 'That user could not be found.');
    }

    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: inviteParticipant(session, {
        invitationId: asId<InvitationId>(this.deps.ids.next()),
        userId,
        role,
        invitedBy: actor.userId,
        now,
      }),
      audit: [{ type: 'participant.invited', subjectUserId: userId, details: { role } }],
      events: [{ type: 'participant.changed', userId }],
    }));
  }

  async removeDraftParticipant(
    actor: AuthorizationContext,
    sessionId: SessionId,
    userId: UserId,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: removeDraftParticipant(session, userId, now),
      audit: [{ type: 'participant.invitation-revoked', subjectUserId: userId }],
    }));
  }

  async revokeInvitation(
    actor: AuthorizationContext,
    sessionId: SessionId,
    userId: UserId,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: revokeInvitation(session, userId, now),
      audit: [{ type: 'participant.invitation-revoked', subjectUserId: userId }],
      events: [{ type: 'participant.changed', userId }],
    }));
  }

  /** The invited user accepts or declines. Only they can answer their invitation. */
  async respondToInvitation(
    actor: AuthorizationContext,
    sessionId: SessionId,
    response: 'joined' | 'declined',
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'view', ({ session, now }) => ({
      session: respondToInvitation(session, actor.userId, response, now),
      audit: [
        { type: 'participant.responded', subjectUserId: actor.userId, details: { response } },
      ],
      events: [{ type: 'participant.changed', userId: actor.userId }],
    }));
  }

  async changeParticipantRole(
    actor: AuthorizationContext,
    sessionId: SessionId,
    userId: UserId,
    role: ParticipationRole,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: changeParticipantRole(session, userId, role, now),
      audit: [{ type: 'participant.role-changed', subjectUserId: userId, details: { role } }],
      events: [{ type: 'participant.changed', userId }],
    }));
  }

  async skipParticipant(
    actor: AuthorizationContext,
    sessionId: SessionId,
    userId: UserId,
    scope: SkipScope,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', async ({ session, now }) => {
      const round = currentTicket(session)?.rounds.at(-1);
      const votes = round === undefined ? [] : await this.roundVotes(session, round);
      // Restricted audit: whether a vote existed, never its value.
      const hadVoted = votes.some((vote) => vote.userId === userId);

      return {
        session: skipParticipant(session, { userId, scope, skippedBy: actor.userId, now }),
        audit: [
          {
            type: 'participant.skipped',
            subjectUserId: userId,
            ticketId: session.currentTicketId,
            details: { scope, hadVoted },
          },
        ],
        events: [{ type: 'participant.changed', userId }],
      };
    });
  }

  async restoreParticipant(
    actor: AuthorizationContext,
    sessionId: SessionId,
    userId: UserId,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', async ({ session, now }) => {
      const result = restoreParticipant(session, userId, actor.userId, now);
      // The domain lists every open round the voter rejoins; only some hold an earlier vote.
      let voteDiscarded = false;

      for (const discarded of result.discardedVotes) {
        const existing = await this.deps.votes.listForRound(session.tenantId, discarded.roundId, [
          discarded.userId,
        ]);
        voteDiscarded ||= existing.length > 0;
        await this.deps.votes.remove(session.tenantId, discarded.roundId, discarded.userId);
      }

      return {
        session: result.session,
        audit: [
          {
            type: 'participant.restored',
            subjectUserId: userId,
            ticketId: session.currentTicketId,
            details: { voteDiscarded },
          },
        ],
        events: [{ type: 'participant.changed', userId }],
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Voting
  // -------------------------------------------------------------------------------------------

  async submitVote(
    actor: AuthorizationContext,
    sessionId: SessionId,
    ticketId: TicketId,
    cardId: CardId,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'view', async ({ session, now }) => {
      const current = latestRound(requireTicket(session, ticketId));

      if (current?.status === 'revealed') {
        // A retry after a concurrent reveal: the vote already counted, so succeed quietly.
        const [stored] = await this.deps.votes.listForRound(session.tenantId, current.id, [
          actor.userId,
        ]);

        if (stored?.cardId === cardId) {
          return { session };
        }
      }

      const vote = castVote(session, { ticketId, userId: actor.userId, cardId, now });
      await this.deps.votes.upsert(session.tenantId, vote);
      const round = latestRound(requireTicket(session, ticketId));
      const events: SessionEvent[] = [];

      if (round?.status === 'open') {
        const progress = roundProgress(round, await this.roundVotes(session, round));
        events.push({
          type: 'vote.status',
          ticketId,
          votedCount: progress.votedCount,
          requiredCount: progress.requiredCount,
        });
      }

      // Votes are not audited individually; the session's state is unchanged by a vote.
      return { session, events };
    });
  }

  /** Manual reveal; only possible once every required voter has voted. */
  async reveal(
    actor: AuthorizationContext,
    sessionId: SessionId,
    ticketId: TicketId,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', async ({ session, now }) => {
      const round = latestRound(requireTicket(session, ticketId));
      const votes = round === undefined ? [] : await this.roundVotes(session, round);

      return {
        session: revealRound(session, ticketId, votes, now),
        audit: [{ type: 'round.revealed', ticketId }],
        events: [{ type: 'round.revealed', ticketId }],
      };
    });
  }

  async startNewRound(
    actor: AuthorizationContext,
    sessionId: SessionId,
    ticketId: TicketId,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: startNewRound(session, ticketId, asId<RoundId>(this.deps.ids.next()), now),
      audit: [{ type: 'round.started', ticketId }],
      events: [{ type: 'round.started', ticketId }],
    }));
  }

  async acceptConsensus(
    actor: AuthorizationContext,
    sessionId: SessionId,
    ticketId: TicketId,
  ): Promise<Session> {
    const saved = await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: finalizeConsensus(session, ticketId, actor.userId, now),
      audit: [{ type: 'estimate.finalized', ticketId, details: { kind: 'consensus' } }],
      events: [{ type: 'estimate.finalized', ticketId }],
    }));

    return await this.syncIfPending(saved, ticketId);
  }

  async overrideEstimate(
    actor: AuthorizationContext,
    sessionId: SessionId,
    ticketId: TicketId,
    cardId: CardId,
    reason: string,
  ): Promise<Session> {
    const saved = await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: overrideEstimate(session, {
        ticketId,
        cardId,
        reason,
        decidedBy: actor.userId,
        now,
      }),
      audit: [
        { type: 'estimate.overridden', ticketId, details: { cardId, reason: reason.trim() } },
      ],
      events: [{ type: 'estimate.finalized', ticketId }],
    }));

    return await this.syncIfPending(saved, ticketId);
  }

  async skipTicket(
    actor: AuthorizationContext,
    sessionId: SessionId,
    ticketId: TicketId,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: skipTicket(session, ticketId, now),
      audit: [{ type: 'ticket.skipped', ticketId }],
      events: [{ type: 'round.started', ticketId }],
    }));
  }

  async setCurrentTicket(
    actor: AuthorizationContext,
    sessionId: SessionId,
    ticketId: TicketId,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: setCurrentTicket(session, ticketId, now),
      audit: [{ type: 'ticket.current-changed', ticketId }],
      events: [{ type: 'ticket.current-changed', ticketId }],
    }));
  }

  async advance(actor: AuthorizationContext, sessionId: SessionId): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => {
      const advanced = advanceToNextTicket(session, now);
      const ticketId = advanced.currentTicketId ?? '';

      return {
        session: advanced,
        audit: [{ type: 'ticket.current-changed', ticketId: advanced.currentTicketId }],
        events: [{ type: 'ticket.current-changed', ticketId }],
      };
    });
  }

  async retrySync(
    actor: AuthorizationContext,
    sessionId: SessionId,
    ticketId: TicketId,
    confirmOverwrite: boolean,
  ): Promise<Session> {
    const saved = await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => ({
      session: retryTicketSync(session, ticketId, confirmOverwrite, now),
      audit: [{ type: 'sync.retried', ticketId, details: { confirmOverwrite } }],
    }));

    return await this.syncIfPending(saved, ticketId);
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  async pause(actor: AuthorizationContext, sessionId: SessionId): Promise<Session> {
    return await this.lifecycle(actor, sessionId, 'session.paused', pauseSession);
  }

  async resume(actor: AuthorizationContext, sessionId: SessionId): Promise<Session> {
    return await this.lifecycle(actor, sessionId, 'session.resumed', resumeSession);
  }

  async complete(actor: AuthorizationContext, sessionId: SessionId): Promise<Session> {
    return await this.lifecycle(actor, sessionId, 'session.completed', completeSession);
  }

  async cancel(actor: AuthorizationContext, sessionId: SessionId): Promise<Session> {
    return await this.lifecycle(actor, sessionId, 'session.cancelled', cancelSession);
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  async getSessionView(actor: AuthorizationContext, sessionId: SessionId): Promise<SessionView> {
    const { session, team } = await this.loadAuthorized(actor, sessionId, 'view');
    const round = currentTicket(session)?.rounds.at(-1);
    const currentRoundVotes = round === undefined ? [] : await this.roundVotes(session, round);
    const latestRoundIds = session.tickets.flatMap((ticket) => {
      const latest = latestRound(ticket);

      return latest === undefined ? [] : [latest.id];
    });
    const viewerVotes = await this.deps.votes.listForVoter(
      session.tenantId,
      actor.userId,
      latestRoundIds,
    );
    const users = await this.usersById(
      actor,
      session.participants.map((participant) => participant.userId),
    );

    return sessionView({
      session,
      team,
      users,
      currentRoundVotes,
      viewerVotes,
      viewerId: actor.userId,
      canModerate: canModerateSession(actor, session, team),
    });
  }

  async getHome(actor: AuthorizationContext): Promise<HomeView> {
    const { visible } = await this.visibleSessions(actor);
    const pending = visible.flatMap(({ session, team }) => {
      const invitation = findParticipant(session, actor.userId)?.invitation;

      return isRunning(session) && invitation?.status === 'invited'
        ? [{ session, team, invitation }]
        : [];
    });
    const users = await this.usersById(actor, [
      actor.userId,
      ...pending.map(({ invitation }) => invitation.invitedByUserId),
    ]);
    const pendingInvitations: InvitationView[] = pending.map(({ session, team, invitation }) => ({
      sessionId: session.id,
      sessionName: session.name,
      teamName: team.name,
      role: invitation.role,
      invitedByName: displayName(users, invitation.invitedByUserId),
      invitedAt: invitation.createdAt.toISOString(),
    }));

    return {
      user: currentUserView(actor, users),
      activeSessions: visible
        .filter(({ session }) => {
          const participant = findParticipant(session, actor.userId);

          return (
            isRunning(session) &&
            (participant === undefined || participantStatus(participant) !== 'invited')
          );
        })
        .map(({ session, team }) =>
          sessionSummaryView(session, team, actor.userId, canModerateSession(actor, session, team)),
        ),
      pendingInvitations,
    };
  }

  /** Sessions the user can see (drafts only for their moderators) and teams they can plan for. */
  async listSessions(actor: AuthorizationContext): Promise<SessionListView> {
    const { visible, teams } = await this.visibleSessions(actor);
    const order: Readonly<Record<Session['status'], number>> = {
      active: 0,
      paused: 1,
      draft: 2,
      ready: 3,
      completed: 4,
      cancelled: 5,
    };

    return {
      sessions: [...visible]
        .sort(
          (a, b) =>
            order[a.session.status] - order[b.session.status] ||
            b.session.updatedAt.getTime() - a.session.updatedAt.getTime(),
        )
        .map(({ session, team }) =>
          sessionSummaryView(session, team, actor.userId, canModerateSession(actor, session, team)),
        ),
      teams: teams
        .filter((team) => !team.archived && canManageTeam(actor, team))
        .map((team) => ({ id: team.id, name: team.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Everything the five-step session builder shows. Moderators only. */
  async getBuilderView(
    actor: AuthorizationContext,
    sessionId: SessionId,
  ): Promise<SessionBuilderView> {
    const { session, team } = await this.loadAuthorized(actor, sessionId, 'moderate');
    const suggestedIds = team.members
      .map((member) => member.userId)
      .filter((userId) => findParticipant(session, userId) === undefined);
    const users = await this.usersById(actor, [
      ...session.participants.map((participant) => participant.userId),
      ...suggestedIds,
    ]);
    const report = checkReadiness(session, team);

    return {
      session: sessionView({
        session,
        team,
        users,
        currentRoundVotes: [],
        viewerVotes: [],
        viewerId: actor.userId,
        canModerate: true,
      }),
      teamId: team.id,
      scoring: scoringSettingsView(session.settings),
      readiness: { ready: report.ready, issues: report.issues.map((issue) => ({ ...issue })) },
      suggestedParticipants: suggestedIds
        .map((userId) => userView(users, userId))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    };
  }

  /** Sets the deck (preset or custom, plus special cards) and the voting options of a draft. */
  async configureScoring(
    actor: AuthorizationContext,
    sessionId: SessionId,
    input: {
      readonly deck: DeckChoice;
      readonly specialCards: readonly SpecialCardType[];
      readonly autoFinalize: boolean;
      readonly autoAdvance: boolean;
      readonly allowInvitationsWhileActive: boolean;
    },
  ): Promise<Session> {
    const deck = deckFromChoice(asId<DeckId>(this.deps.ids.next()), input.deck, input.specialCards);

    return await this.updateSettings(actor, sessionId, {
      deck,
      autoFinalize: input.autoFinalize,
      autoAdvance: input.autoAdvance,
      allowInvitationsWhileActive: input.allowInvitationsWhileActive,
    });
  }

  /** Drafts drop the person from the roster; published sessions revoke their invitation. */
  async removeParticipant(
    actor: AuthorizationContext,
    sessionId: SessionId,
    userId: UserId,
  ): Promise<Session> {
    const { session } = await this.loadAuthorized(actor, sessionId, 'moderate');

    return isEditable(session)
      ? await this.removeDraftParticipant(actor, sessionId, userId)
      : await this.revokeInvitation(actor, sessionId, userId);
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /** Votes of the round's roster, read per voter (strongly consistent in Forge storage). */
  private async roundVotes(session: Session, round: VotingRound): Promise<readonly Vote[]> {
    return await this.deps.votes.listForRound(
      session.tenantId,
      round.id,
      round.roster?.snapshotVoterIds ?? [],
    );
  }

  private async visibleSessions(actor: AuthorizationContext): Promise<{
    visible: { session: Session; team: Team }[];
    teams: readonly Team[];
  }> {
    const teams = await this.deps.teams.listForTenant(actor.tenantId);
    const teamsById = new Map(teams.map((team) => [team.id, team]));
    const moderatedTeamIds = teams
      .filter((team) => canManageTeam(actor, team))
      .map((team) => team.id);
    const participantSessionIds = await this.deps.participants.listSessionIdsForUser(
      actor.tenantId,
      actor.userId,
    );
    const candidates = [
      ...(await this.deps.sessions.listForTeams(actor.tenantId, moderatedTeamIds)),
      ...(await this.deps.sessions.listByIds(actor.tenantId, participantSessionIds)),
    ];
    const unique = [...new Map(candidates.map((session) => [session.id, session])).values()];
    const visible = unique.flatMap((session) => {
      const team = teamsById.get(session.teamId);

      return team !== undefined && canViewSession(actor, session, team) ? [{ session, team }] : [];
    });

    return { visible, teams };
  }

  private async usersById(
    actor: AuthorizationContext,
    userIds: readonly UserId[],
  ): Promise<ReadonlyMap<UserId, UserIdentity>> {
    const users = await this.deps.identity.getUsers(actor.tenantId, [...new Set(userIds)]);

    return new Map(users.map((user) => [user.id, user]));
  }

  private async loadAuthorized(
    actor: AuthorizationContext,
    sessionId: SessionId,
    access: Access,
  ): Promise<{ session: Session; team: Team }> {
    const session = await this.deps.sessions.get(actor.tenantId, sessionId);
    const team =
      session === null ? null : await this.deps.teams.get(actor.tenantId, session.teamId);

    // Same error for missing and unauthorized sessions, so IDs cannot be probed.
    if (session === null || team === null || !canViewSession(actor, session, team)) {
      throw new DomainError('NOT_FOUND', 'Session not found.');
    }

    if (access === 'moderate' && !canModerateSession(actor, session, team)) {
      forbid('Only moderators can do that.');
    }

    return { session, team };
  }

  private async lifecycle(
    actor: AuthorizationContext,
    sessionId: SessionId,
    type: AuditEventType,
    transition: (session: Session, now: Date) => Session,
  ): Promise<Session> {
    return await this.mutate(actor, sessionId, 'moderate', ({ session, now }) => {
      const updated = transition(session, now);

      return {
        session: updated,
        audit: [{ type }],
        events: [{ type: 'session.status-changed', status: updated.status }],
      };
    });
  }

  /**
   * Runs a change atomically, then settles the current round (auto-reveal and auto-finalize),
   * persists, audits and notifies. Any pending external update is synced afterwards.
   */
  private async mutate(
    actor: AuthorizationContext,
    sessionId: SessionId,
    access: Access,
    change: (context: MutationContext) => MutationOutcome | Promise<MutationOutcome>,
  ): Promise<Session> {
    const result = await this.deps.atomic.run(`session:${sessionId}`, async () => {
      const { session, team } = await this.loadAuthorized(actor, sessionId, access);
      const now = this.deps.clock.now();
      const outcome = await change({ session, team, now });
      const settled = await this.settle(outcome.session, now);
      const audit = [...(outcome.audit ?? []), ...settled.audit];
      const events = [...(outcome.events ?? []), ...settled.events];
      const saved =
        settled.session === session ? session : await this.deps.sessions.save(settled.session);

      if (saved !== session) {
        await this.deps.participants.replaceForSession(saved);
      }

      await this.deps.audit.append(
        audit.map((entry) =>
          auditEvent(this.deps, {
            ...entry,
            actor: entry.system === true ? null : actor,
            tenantId: actor.tenantId,
            teamId: team.id,
            sessionId,
          }),
        ),
      );

      return { saved, events, finalizedTicketId: settled.finalizedTicketId };
    });

    await this.notify(result.saved, result.events);

    return result.finalizedTicketId === null
      ? result.saved
      : await this.syncIfPending(result.saved, result.finalizedTicketId);
  }

  /** Reveals the current round once complete, and auto-finalizes unanimous results if enabled. */
  private async settle(
    session: Session,
    now: Date,
  ): Promise<{
    session: Session;
    audit: PendingAudit[];
    events: SessionEvent[];
    finalizedTicketId: TicketId | null;
  }> {
    const ticket = currentTicket(session);
    const round = ticket === undefined ? undefined : latestRound(ticket);
    const nothing = { session, audit: [], events: [], finalizedTicketId: null };

    if (ticket === undefined || round?.status !== 'open') {
      return nothing;
    }

    const votes = await this.roundVotes(session, round);

    if (!canReveal(session, ticket.id, votes)) {
      return nothing;
    }

    const audit: PendingAudit[] = [{ type: 'round.revealed', ticketId: ticket.id, system: true }];
    const events: SessionEvent[] = [{ type: 'round.revealed', ticketId: ticket.id }];
    let updated = revealRound(session, ticket.id, votes, now);

    if (!canAutoFinalize(updated, ticket.id)) {
      return { session: updated, audit, events, finalizedTicketId: null };
    }

    updated = finalizeConsensus(updated, ticket.id, null, now);
    audit.push({
      type: 'estimate.finalized',
      ticketId: ticket.id,
      system: true,
      details: { kind: 'consensus', automatic: true },
    });
    events.push({ type: 'estimate.finalized', ticketId: ticket.id });

    if (findTicket(updated, ticket.id)?.externalUpdate.state === 'not-required') {
      const advanced = this.autoAdvance(updated, ticket.id, now);

      if (advanced !== updated) {
        events.push({ type: 'ticket.current-changed', ticketId: advanced.currentTicketId ?? '' });
        audit.push({
          type: 'ticket.current-changed',
          ticketId: advanced.currentTicketId,
          system: true,
        });
        // The next ticket may already be complete through pre-votes.
        const next = await this.settle(advanced, now);

        return {
          session: next.session,
          audit: [...audit, ...next.audit],
          events: [...events, ...next.events],
          finalizedTicketId: next.finalizedTicketId,
        };
      }
    }

    return { session: updated, audit, events, finalizedTicketId: ticket.id };
  }

  /** Auto-advance applies only to automatic finalization, when enabled, after a successful write. */
  private autoAdvance(session: Session, ticketId: TicketId, now: Date): Session {
    const ticket = findTicket(session, ticketId);
    const syncOk =
      ticket?.externalUpdate.state === 'succeeded' ||
      ticket?.externalUpdate.state === 'not-required';

    if (
      session.status !== 'active' ||
      !session.settings.autoAdvance ||
      session.currentTicketId !== ticketId ||
      ticket?.decision?.decidedBy !== null ||
      !syncOk ||
      nextOpenTicket(session) === undefined
    ) {
      return session;
    }

    return advanceToNextTicket(session, now);
  }

  /**
   * Writes a finalized estimate to the work item. The claim (pending → syncing) happens inside
   * the session lock so concurrent callers cannot double-write; the provider call runs outside it.
   */
  private async syncIfPending(session: Session, ticketId: TicketId): Promise<Session> {
    if (findTicket(session, ticketId)?.externalUpdate.state !== 'pending') {
      return session;
    }

    const key = `session:${session.id}`;
    const claimed = await this.deps.atomic.run(key, async () => {
      const latest = await this.deps.sessions.get(session.tenantId, session.id);
      const ticket = latest === null ? undefined : findTicket(latest, ticketId);

      if (latest === null || ticket?.externalUpdate.state !== 'pending') {
        return null;
      }

      const saved = await this.deps.sessions.save(
        beginTicketSync(latest, ticketId, this.deps.clock.now()),
      );

      return { saved, ticket: requireTicket(saved, ticketId) };
    });

    if (claimed === null) {
      return (await this.deps.sessions.get(session.tenantId, session.id)) ?? session;
    }

    const { externalUpdate, reference, snapshot } = claimed.ticket;
    const { fieldId, value, idempotencyKey } = externalUpdate;

    if (fieldId === null || value === null || idempotencyKey === null) {
      throw new DomainError('INVALID_STATE', 'The pending update is incomplete.');
    }

    const request: WorkItemUpdateRequest = {
      reference,
      fieldId,
      value,
      expectedCurrentValue: externalUpdate.overwriteConfirmed
        ? undefined
        : (snapshot.fieldValues[fieldId] ?? null),
      idempotencyKey,
    };
    const result = await this.writeToProvider(request);

    const final = await this.deps.atomic.run(key, async () => {
      const latest = await this.deps.sessions.get(session.tenantId, session.id);

      if (latest === null) {
        throw new DomainError('NOT_FOUND', 'Session not found.');
      }

      const now = this.deps.clock.now();
      const message = result.status === 'succeeded' ? null : result.message;
      const completed = completeTicketSync(latest, ticketId, result.status, message, now);
      const advanced = this.autoAdvance(completed, ticketId, now);
      const events: SessionEvent[] = [{ type: 'sync.completed', ticketId, state: result.status }];
      const audit: PendingAudit[] = [
        { type: 'sync.completed', ticketId, system: true, details: { outcome: result.status } },
      ];
      let next: Awaited<ReturnType<SessionService['settle']>> = {
        session: advanced,
        audit: [],
        events: [],
        finalizedTicketId: null,
      };

      if (advanced !== completed) {
        events.push({ type: 'ticket.current-changed', ticketId: advanced.currentTicketId ?? '' });
        audit.push({
          type: 'ticket.current-changed',
          ticketId: advanced.currentTicketId,
          system: true,
        });
        next = await this.settle(advanced, now);
      }

      const saved = await this.deps.sessions.save(next.session);
      await this.deps.audit.append(
        [...audit, ...next.audit].map((entry) =>
          auditEvent(this.deps, {
            ...entry,
            actor: null,
            tenantId: session.tenantId,
            teamId: session.teamId,
            sessionId: session.id,
          }),
        ),
      );

      return {
        saved,
        events: [...events, ...next.events],
        finalizedTicketId: next.finalizedTicketId,
      };
    });

    await this.notify(final.saved, final.events);

    return final.finalizedTicketId === null
      ? final.saved
      : await this.syncIfPending(final.saved, final.finalizedTicketId);
  }

  private async writeToProvider(request: WorkItemUpdateRequest): Promise<UpdateResult> {
    try {
      const validation = await this.deps.workItems.validateUpdate(request);

      if (validation.status !== 'ok') {
        return {
          status: validation.status === 'conflict' ? 'conflict' : 'failed',
          message: validation.message,
        };
      }

      return await this.deps.workItems.update(request);
    } catch (error: unknown) {
      // Recorded as a failed sync the moderator can retry; provider details may hold secrets.
      const detail = error instanceof Error ? ` (${error.name})` : '';

      return { status: 'failed', message: `${SYNC_FAILURE_MESSAGE}${detail}` };
    }
  }

  private async notify(session: Session, events: readonly SessionEvent[]): Promise<void> {
    for (const event of events) {
      await this.deps.events.publish(session.tenantId, session.id, event);
    }
  }
}
