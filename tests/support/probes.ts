/**
 * A valid probe payload and the roles allowed to call it, for every resolver key, plus a fresh
 * fixture world to run them in. Shared by the authorization matrix and the payload fuzzing.
 */
import type { ErrorCode, ResolverKey } from '@planning-poker/contracts';

import { STORY_POINTS } from './fake-jira';
import type { Caller } from './forge-backend';
import { ok, userId } from './forge-backend';
import type { World } from './world';
import {
  cardId,
  createWorld,
  currentTicketId,
  draftSession,
  ISSUES,
  liveSession,
  MIA,
  OUT,
  SAM,
} from './world';

export type Role =
  'admin' | 'moderator' | 'member' | 'invitedVoter' | 'observer' | 'outsider' | 'otherSite';

export const ROLES: readonly Role[] = [
  'admin',
  'moderator',
  'member',
  'invitedVoter',
  'observer',
  'outsider',
  'otherSite',
];

export interface Fixture {
  readonly world: World;
  readonly teamId: string;
  readonly sessionId: string;
  readonly draftId: string;
  readonly ticketId: string;
  readonly nextTicketId: string;
  readonly draftTicketId: string;
  readonly cardId: string;
}

export interface Probe {
  readonly payload: (fixture: Fixture) => unknown;
  readonly allowed: readonly Role[];
  /** Codes that count as a denial for this resolver (default NOT_FOUND, FORBIDDEN). */
  readonly denials?: readonly ErrorCode[];
}

const EVERYONE = ROLES;
const MANAGERS: readonly Role[] = ['admin', 'moderator'];
const ADMINS: readonly Role[] = ['admin', 'otherSite'];
const TEAM: readonly Role[] = ['admin', 'moderator', 'member'];
const ROSTER: readonly Role[] = ['admin', 'moderator', 'member', 'invitedVoter', 'observer'];
export const DENY = ['NOT_FOUND', 'FORBIDDEN'] as const;

const live = (f: Fixture) => ({ sessionId: f.sessionId });
const draft = (f: Fixture) => ({ sessionId: f.draftId });
const liveTicket = (f: Fixture) => ({ sessionId: f.sessionId, ticketId: f.ticketId });
const member = (f: Fixture) => ({ teamId: f.teamId, userId: userId(OUT) });

export const MATRIX: Readonly<Record<ResolverKey, Probe>> = {
  getHome: { payload: () => ({}), allowed: EVERYONE },
  listTeams: { payload: () => ({}), allowed: EVERYONE },
  getTeam: { payload: (f) => ({ teamId: f.teamId }), allowed: TEAM },
  // App moderators and administrators create teams (on their own site).
  createTeam: {
    payload: () => ({ name: 'New', description: null }),
    allowed: [...MANAGERS, 'otherSite'],
  },
  updateTeam: {
    payload: (f) => ({ teamId: f.teamId, name: 'Renamed', description: null }),
    allowed: MANAGERS,
  },
  archiveTeam: { payload: (f) => ({ teamId: f.teamId }), allowed: MANAGERS },
  addTeamMember: { payload: member, allowed: MANAGERS },
  removeTeamMember: {
    payload: (f) => ({ teamId: f.teamId, userId: userId(SAM) }),
    allowed: MANAGERS,
  },
  // Assumption 8: administrators only.
  assignTeamModerator: {
    payload: (f) => ({ teamId: f.teamId, userId: userId(MIA) }),
    allowed: ['admin'],
  },
  unassignTeamModerator: {
    payload: (f) => ({ teamId: f.teamId, userId: userId(MIA) }),
    allowed: ['admin'],
  },
  // Assumption 11: people who can manage a team or create teams.
  searchUsers: { payload: () => ({ query: 'a' }), allowed: [...MANAGERS, 'otherSite'] },
  // Everyone may ask; non-administrators get an empty view (asserted below).
  getSettings: { payload: () => ({}), allowed: EVERYONE },
  assignAppModerator: { payload: () => ({ userId: userId(MIA) }), allowed: ADMINS },
  unassignAppModerator: { payload: () => ({ userId: userId(MIA) }), allowed: ADMINS },
  listSessions: { payload: () => ({}), allowed: EVERYONE },
  createSession: { payload: (f) => ({ name: 'S', teamId: f.teamId }), allowed: MANAGERS },
  getSessionBuilder: { payload: draft, allowed: MANAGERS },
  renameSession: { payload: (f) => ({ ...draft(f), name: 'Renamed' }), allowed: MANAGERS },
  configureScoring: {
    payload: (f) => ({
      ...draft(f),
      deck: { kind: 'preset', preset: 't-shirt' },
      specialCards: [],
      autoFinalize: false,
      autoAdvance: false,
      allowInvitationsWhileActive: false,
    }),
    allowed: MANAGERS,
  },
  inviteParticipant: {
    payload: (f) => ({ ...draft(f), userId: userId(OUT), role: 'voter' }),
    allowed: MANAGERS,
  },
  changeParticipantRole: {
    payload: (f) => ({ ...draft(f), userId: userId(MIA), role: 'observer' }),
    allowed: MANAGERS,
  },
  removeParticipant: { payload: (f) => ({ ...draft(f), userId: userId(MIA) }), allowed: MANAGERS },
  importTickets: { payload: (f) => ({ ...draft(f), keys: [ISSUES.pp3.key] }), allowed: MANAGERS },
  removeTicket: { payload: (f) => ({ ...draft(f), ticketId: f.draftTicketId }), allowed: MANAGERS },
  reorderTickets: {
    payload: (f) => ({ ...draft(f), ticketIds: [f.draftTicketId] }),
    allowed: MANAGERS,
  },
  searchWorkItems: {
    payload: (f) => ({ ...draft(f), query: 'project = PP', cursor: null }),
    allowed: MANAGERS,
  },
  suggestQuery: { payload: (f) => ({ ...draft(f), query: 'pro' }), allowed: MANAGERS },
  getDisplayFields: { payload: draft, allowed: MANAGERS },
  setDisplayFields: { payload: (f) => ({ ...draft(f), fieldIds: ['labels'] }), allowed: MANAGERS },
  submitVote: {
    payload: (f) => ({ ...liveTicket(f), cardId: f.cardId }),
    allowed: ['member', 'invitedVoter'],
    // Facilitators observe by default; observers never vote.
    denials: [...DENY, 'NOT_ELIGIBLE'],
  },
  advanceTicket: { payload: live, allowed: MANAGERS },
  publishSession: { payload: draft, allowed: MANAGERS },
  cancelSession: { payload: live, allowed: MANAGERS },
  getSession: { payload: live, allowed: ROSTER },
  // Moderators who were not invited have no invitation to answer (NOT_FOUND).
  respondToInvitation: {
    payload: (f) => ({ ...live(f), response: 'declined' }),
    allowed: ['member', 'invitedVoter', 'observer'],
    // A facilitator is on the roster without an invitation: VALIDATION ("not invited").
    denials: [...DENY, 'VALIDATION'],
  },
  inviteToRoom: {
    payload: (f) => ({ ...live(f), userId: userId(OUT), role: 'observer' }),
    allowed: MANAGERS,
  },
  changeRoomRole: {
    payload: (f) => ({ ...live(f), userId: userId(MIA), role: 'observer' }),
    allowed: MANAGERS,
  },
  revokeRoomInvitation: {
    payload: (f) => ({ ...live(f), userId: userId(SAM) }),
    allowed: MANAGERS,
  },
  skipParticipant: {
    payload: (f) => ({ ...live(f), userId: userId(SAM), scope: 'ticket' }),
    allowed: MANAGERS,
  },
  restoreParticipant: { payload: (f) => ({ ...live(f), userId: userId(SAM) }), allowed: MANAGERS },
  revealRound: { payload: liveTicket, allowed: MANAGERS },
  startNewRound: { payload: liveTicket, allowed: MANAGERS },
  acceptConsensus: { payload: liveTicket, allowed: MANAGERS },
  overrideEstimate: {
    payload: (f) => ({ ...liveTicket(f), cardId: f.cardId, reason: 'Because' }),
    allowed: MANAGERS,
  },
  skipTicket: { payload: liveTicket, allowed: MANAGERS },
  setCurrentTicket: {
    payload: (f) => ({ sessionId: f.sessionId, ticketId: f.nextTicketId }),
    allowed: MANAGERS,
  },
  pauseSession: { payload: live, allowed: MANAGERS },
  resumeSession: { payload: live, allowed: MANAGERS },
  completeSession: { payload: live, allowed: MANAGERS },
  listSessionHistory: { payload: () => ({}), allowed: EVERYONE },
  getSessionSummary: { payload: live, allowed: ROSTER },
  getReportScope: { payload: () => ({}), allowed: EVERYONE },
  // Team reports: the team's moderators and administrators (assumption 36).
  getTeamReport: { payload: (f) => ({ teamId: f.teamId }), allowed: MANAGERS },
  getAppReport: { payload: () => ({}), allowed: ADMINS },
  // Assumption 38: session moderators only.
  listAuditEvents: { payload: live, allowed: MANAGERS },
  getFieldAllowlist: { payload: () => ({}), allowed: ADMINS },
  setFieldAllowlist: { payload: () => ({ fieldIds: [STORY_POINTS] }), allowed: ADMINS },
  getFieldMapping: { payload: draft, allowed: MANAGERS },
  setFieldMapping: {
    payload: (f) => ({ ...draft(f), fieldId: null, optionByCardId: {} }),
    allowed: MANAGERS,
  },
  retrySync: {
    payload: (f) => ({ ...liveTicket(f), confirmOverwrite: false }),
    allowed: MANAGERS,
  },
  getRealtimeToken: { payload: live, allowed: ROSTER },
};

export function callerFor(world: World, role: Role): Caller {
  const callers: Readonly<Record<Role, Caller>> = {
    admin: world.ada,
    moderator: world.max,
    member: world.mia,
    invitedVoter: world.ola,
    observer: world.lee,
    outsider: world.out,
    otherSite: world.eve,
  };

  return callers[role];
}

export async function fixture(): Promise<Fixture> {
  const world = await createWorld();
  const sessionId = await liveSession(world);
  const draftId = await draftSession(world, { keys: [ISSUES.pp1.key] });
  const view = ok(await world.max.getSession({ sessionId }));
  const ticketId = currentTicketId(view);
  const draftView = ok(await world.max.getSessionBuilder({ sessionId: draftId }));

  return {
    world,
    teamId: world.teamId,
    sessionId,
    draftId,
    ticketId,
    nextTicketId: view.tickets.find((ticket) => ticket.id !== ticketId)?.id ?? '',
    draftTicketId: draftView.session.tickets[0]?.id ?? '',
    cardId: cardId(view, '5'),
  };
}

/** Strings that only someone with access to the site-1 team or session may ever see. */
export function secretsOf(f: Fixture): string[] {
  return [f.sessionId, f.draftId, f.teamId, 'Sprint 42', 'Platform', 'Story 1', 'Details for'];
}
