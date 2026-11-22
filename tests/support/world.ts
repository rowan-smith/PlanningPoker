/**
 * A Jira site with a cast covering every role the security tests need, and helpers that drive
 * the resolver API exactly as the Custom UI does.
 */
import type { SessionView } from '@planning-poker/contracts';

import { adf, FakeJira, STORY_POINTS } from './fake-jira';
import type { BackendOptions, Caller } from './forge-backend';
import { createForgeBackend, ok, SITE_2, userId } from './forge-backend';

/** Account IDs. */
export const ADA = 'ada-admin';
export const MAX = 'max-moderator';
export const MIA = 'mia-member';
export const SAM = 'sam-member';
export const OLA = 'ola-invited';
export const LEE = 'lee-observer';
export const OUT = 'oscar-outsider';
export const EVE = 'eve-other-site';

export const ISSUES = {
  pp1: { id: '10001', key: 'PP-1' },
  pp2: { id: '10002', key: 'PP-2' },
  pp3: { id: '10003', key: 'PP-3' },
  /** Only Max and Ada can browse it in Jira. */
  sec1: { id: '20001', key: 'SEC-1' },
} as const;

export function seedJira(jira = new FakeJira()): FakeJira {
  jira.addUser({ accountId: ADA, displayName: 'Ada Admin', administrator: true });
  jira.addUser({ accountId: MAX, displayName: 'Max Moderator' });
  jira.addUser({ accountId: MIA, displayName: 'Mia Member' });
  jira.addUser({ accountId: SAM, displayName: 'Sam Member' });
  jira.addUser({ accountId: OLA, displayName: 'Ola Invited' });
  jira.addUser({ accountId: LEE, displayName: 'Lee Observer' });
  jira.addUser({ accountId: OUT, displayName: 'Oscar Outsider' });
  jira.addUser({ accountId: EVE, displayName: 'Eve Elsewhere', administrator: true });

  for (const [index, issue] of [ISSUES.pp1, ISSUES.pp2, ISSUES.pp3].entries()) {
    jira.addIssue({
      ...issue,
      summary: `Story ${String(index + 1)} <img src=x onerror=alert(1)>`,
      description: adf(`Details for ${issue.key} <script>alert("x")</script>`),
      browsers: 'all',
      // Team members can edit; Ola (invited from outside the team) cannot.
      editors: [MAX, ADA, MIA, SAM],
      fields: { [STORY_POINTS]: null },
    });
  }

  jira.addIssue({
    ...ISSUES.sec1,
    summary: 'Confidential security fix',
    description: adf('Exploit details'),
    browsers: [MAX, ADA],
    editors: [MAX, ADA],
    fields: { [STORY_POINTS]: null },
  });

  return jira;
}

export interface World {
  readonly backend: ReturnType<typeof createForgeBackend>;
  readonly ada: Caller;
  readonly max: Caller;
  readonly mia: Caller;
  readonly sam: Caller;
  readonly ola: Caller;
  readonly lee: Caller;
  readonly out: Caller;
  /** A Jira administrator on another installation. */
  readonly eve: Caller;
  readonly teamId: string;
}

/**
 * Ada (Jira admin) allows Story points and makes Max an app moderator; Max creates the Platform
 * team with Mia and Sam. Ola, Lee and Oscar are not team members.
 */
export async function createWorld(options: BackendOptions = {}): Promise<World> {
  const backend = createForgeBackend({ ...options, jira: options.jira ?? seedJira() });
  const ada = backend.as(ADA);
  const max = backend.as(MAX);
  ok(await ada.setFieldAllowlist({ fieldIds: [STORY_POINTS] }));
  ok(await ada.assignAppModerator({ userId: userId(MAX) }));
  const team = ok(await max.createTeam({ name: 'Platform', description: 'Core team' }));
  ok(await max.addTeamMember({ teamId: team.id, userId: userId(MIA) }));
  ok(await max.addTeamMember({ teamId: team.id, userId: userId(SAM) }));

  return {
    backend,
    ada,
    max,
    mia: backend.as(MIA),
    sam: backend.as(SAM),
    ola: backend.as(OLA),
    lee: backend.as(LEE),
    out: backend.as(OUT),
    eve: backend.as(EVE, SITE_2),
    teamId: team.id,
  };
}

export interface DraftOptions {
  readonly keys?: readonly string[];
  readonly autoFinalize?: boolean;
  readonly autoAdvance?: boolean;
}

/**
 * Max drafts a session: Mia, Sam and Ola vote, Lee observes, tickets imported by key, Story
 * points mapped. Returns the session ID.
 */
export async function draftSession(world: World, options: DraftOptions = {}): Promise<string> {
  const { max } = world;
  const builder = ok(await max.createSession({ name: 'Sprint 42', teamId: world.teamId }));
  const sessionId = builder.session.id;

  for (const [account, role] of [
    [MIA, 'voter'],
    [SAM, 'voter'],
    [OLA, 'voter'],
    [LEE, 'observer'],
  ] as const) {
    ok(await max.inviteParticipant({ sessionId, userId: userId(account), role }));
  }

  ok(
    await max.importTickets({
      sessionId,
      keys: options.keys ?? [ISSUES.pp1.key, ISSUES.pp2.key],
    }),
  );
  ok(
    await max.configureScoring({
      sessionId,
      deck: { kind: 'preset', preset: 'fibonacci' },
      specialCards: ['infinity', 'unknown', 'coffee'],
      autoFinalize: options.autoFinalize ?? false,
      autoAdvance: options.autoAdvance ?? false,
      allowInvitationsWhileActive: true,
    }),
  );
  ok(await max.setFieldMapping({ sessionId, fieldId: STORY_POINTS, optionByCardId: {} }));

  return sessionId;
}

/** Drafts, publishes, and has every invitee join. */
export async function liveSession(world: World, options: DraftOptions = {}): Promise<string> {
  const sessionId = await draftSession(world, options);
  ok(await world.max.publishSession({ sessionId }));

  for (const caller of [world.mia, world.sam, world.ola, world.lee]) {
    ok(await caller.respondToInvitation({ sessionId, response: 'joined' }));
  }

  return sessionId;
}

export function cardId(view: SessionView, label: string): string {
  const card = view.deck.find((candidate) => candidate.label === label);

  if (card === undefined) {
    throw new Error(`No card ${label}`);
  }

  return card.id;
}

export function currentTicketId(view: SessionView): string {
  if (view.currentTicketId === null) {
    throw new Error('No current ticket');
  }

  return view.currentTicketId;
}

export function ticketOf(view: SessionView, ticketId: string) {
  const ticket = view.tickets.find((candidate) => candidate.id === ticketId);

  if (ticket === undefined) {
    throw new Error(`No ticket ${ticketId}`);
  }

  return ticket;
}
