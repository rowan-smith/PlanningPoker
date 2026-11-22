/**
 * Milestone 7: the administrator's allowlist of writable fields, session field mappings, and
 * writing final estimates back with visible sync outcomes, conflicts and controlled retries.
 */
import { describe, expect, it } from 'vitest';

import type {
  ApplicationRole,
  AuthorizationContext,
  CardId,
  SessionId,
  TicketId,
  UserId,
} from '@planning-poker/domain';
import { asId, beginTicketSync, STUCK_SYNC_AFTER_MS } from '@planning-poker/domain';

import { SessionService, SettingsService, TeamService } from '../src';
import type { InMemoryApplication } from '../src/testing';
import { createInMemoryApplication } from '../src/testing';
import { actor, allowFields, TENANT, workItem } from './support';

const STORY_POINTS = 'customfield_10016';
const SIZE = 'customfield_10020';
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

interface Setup {
  readonly app: InMemoryApplication;
  readonly sessions: SessionService;
  readonly settings: SettingsService;
  readonly admin: AuthorizationContext;
  readonly moderator: AuthorizationContext;
  readonly voters: readonly AuthorizationContext[];
  readonly sessionId: SessionId;
  readonly ticketIds: readonly TicketId[];
  card(label: string): Promise<CardId>;
  publish(): Promise<void>;
  voteAll(label: string): Promise<void>;
  ticket(
    index?: number,
  ): Promise<Awaited<ReturnType<SessionService['getSessionView']>>['tickets'][number]>;
}

/** A draft with two voters and two tickets imported through the fake provider. */
async function draft(options: { readonly deck?: 't-shirt' } = {}): Promise<Setup> {
  const app = createInMemoryApplication();
  const sessions = new SessionService(app.deps);
  const settings = new SettingsService(app.deps);
  const teams = new TeamService(app.deps);
  const person = (id: string, role: ApplicationRole = 'member'): AuthorizationContext => {
    app.identity.add({
      id: asId<UserId>(id),
      tenantId: TENANT,
      displayName: id,
      externalIdentities: [],
    });

    return actor(id, role);
  };
  const admin = person('admin', 'administrator');
  const moderator = person('moderator', 'moderator');
  const voters = [person('voter-1'), person('voter-2')];
  app.workItems.fields = [
    { fieldId: 'priority', name: 'Priority', valueType: 'unsupported', options: [] },
    { fieldId: STORY_POINTS, name: 'Story points', valueType: 'number', options: [] },
    {
      fieldId: SIZE,
      name: 'T-shirt size',
      valueType: 'option',
      options: SIZES.map((value, index) => ({ id: String(100 + index), value })),
    },
  ];

  for (const index of [1, 2]) {
    app.workItems.add(`PP-${String(index)}`, workItem(index));
  }

  const team = await teams.createTeam(moderator, { name: 'Platform' });

  for (const voter of voters) {
    await teams.addMember(moderator, team.id, voter.userId);
  }

  const created = await sessions.createDraft(moderator, {
    name: 'Sprint 7',
    teamId: team.id,
    deckPreset: options.deck ?? 'fibonacci',
  });
  const sessionId = created.id;

  for (const voter of voters) {
    await sessions.inviteParticipant(moderator, sessionId, voter.userId, 'voter');
  }

  const { session } = await sessions.importByKeys(moderator, sessionId, ['PP-1', 'PP-2']);
  await sessions.updateSettings(moderator, sessionId, { autoFinalize: true, autoAdvance: true });
  const ticketIds = [...session.tickets].sort((a, b) => a.order - b.order).map((t) => t.id);
  const view = async () => await sessions.getSessionView(moderator, sessionId);
  const card = async (label: string): Promise<CardId> => {
    const found = (await view()).deck.find((entry) => entry.label === label);

    if (found === undefined) {
      throw new Error(`No card ${label}`);
    }

    return asId<CardId>(found.id);
  };

  return {
    app,
    sessions,
    settings,
    admin,
    moderator,
    voters,
    sessionId,
    ticketIds,
    card,
    async publish() {
      await sessions.publish(moderator, sessionId);

      for (const voter of voters) {
        await sessions.respondToInvitation(voter, sessionId, 'joined');
      }
    },
    async voteAll(label) {
      const current = (await view()).currentTicketId;

      if (current === null) {
        throw new Error('No current ticket');
      }

      const cardId = await card(label);

      for (const voter of voters) {
        await sessions.submitVote(voter, sessionId, asId<TicketId>(current), cardId);
      }
    },
    async ticket(index = 0) {
      const found = (await view()).tickets.find((entry) => entry.id === ticketIds[index]);

      if (found === undefined) {
        throw new Error('No ticket');
      }

      return found;
    },
  };
}

describe('administrator allowlist of writable fields', () => {
  it('offers only number and single-select fields and saves the choice', async () => {
    const s = await draft();
    const initial = await s.settings.getFieldAllowlist(s.admin);

    expect(initial.available.map((field) => [field.id, field.valueType])).toEqual([
      [STORY_POINTS, 'number'],
      [SIZE, 'option'],
    ]);
    expect(initial.selectedIds).toEqual([]);

    const saved = await s.settings.setFieldAllowlist(s.admin, [STORY_POINTS, STORY_POINTS]);

    expect(saved.selectedIds).toEqual([STORY_POINTS]);
    expect(s.app.audit.events.map((event) => event.type)).toContain(
      'settings.writable-fields-changed',
    );
  });

  it('rejects unsupported or unknown fields and non-administrators', async () => {
    const s = await draft();

    await expect(s.settings.setFieldAllowlist(s.admin, ['priority'])).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(s.settings.setFieldAllowlist(s.admin, ['customfield_999'])).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(s.settings.getFieldAllowlist(s.moderator)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(s.settings.setFieldAllowlist(s.moderator, [STORY_POINTS])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('session field mapping', () => {
  it('lets moderators choose only allowlisted fields', async () => {
    const s = await draft();

    await expect(
      s.sessions.setFieldMapping(s.moderator, s.sessionId, {
        fieldId: STORY_POINTS,
        optionByCardId: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await allowFields(s.app, [STORY_POINTS]);
    const mapping = await s.sessions.getFieldMapping(s.moderator, s.sessionId);
    expect(mapping.allowed.map((field) => field.id)).toEqual([STORY_POINTS]);

    await s.sessions.setFieldMapping(s.moderator, s.sessionId, {
      fieldId: STORY_POINTS,
      optionByCardId: {},
    });
    expect((await s.sessions.getFieldMapping(s.moderator, s.sessionId)).destination).toMatchObject({
      fieldId: STORY_POINTS,
      fieldName: 'Story points',
      valueType: 'number',
    });
    await expect(
      s.sessions.getFieldMapping(s.voters[0] ?? s.moderator, s.sessionId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps cards to options the field accepts and requires a complete mapping to publish', async () => {
    const s = await draft({ deck: 't-shirt' });
    await allowFields(s.app, [SIZE]);
    await s.sessions.setFieldMapping(s.moderator, s.sessionId, {
      fieldId: SIZE,
      optionByCardId: { [await s.card('M')]: 'M' },
    });

    const mapping = await s.sessions.getFieldMapping(s.moderator, s.sessionId);
    expect(mapping.options).toEqual(SIZES);
    expect(mapping.destination?.optionByCardId).toEqual({ [await s.card('M')]: 'M' });

    const report = await s.sessions.checkReadiness(s.moderator, s.sessionId);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'field-unmapped-cards', severity: 'error' }),
    );

    await expect(
      s.sessions.setFieldMapping(s.moderator, s.sessionId, {
        fieldId: SIZE,
        optionByCardId: { [await s.card('M')]: 'Medium' },
      }),
    ).rejects.toThrow(/"Medium" is not an option of T-shirt size/);
    await expect(
      s.sessions.setFieldMapping(s.moderator, s.sessionId, {
        fieldId: SIZE,
        optionByCardId: { 'not-a-card': 'M' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    const complete: Record<string, string> = {};

    for (const size of SIZES) {
      complete[await s.card(size)] = size;
    }

    await s.sessions.setFieldMapping(s.moderator, s.sessionId, {
      fieldId: SIZE,
      optionByCardId: complete,
    });
    expect((await s.sessions.checkReadiness(s.moderator, s.sessionId)).ready).toBe(true);
  });

  it('blocks publishing when the administrator removed the field from the allowlist', async () => {
    const s = await draft();
    await allowFields(s.app, [STORY_POINTS]);
    await s.sessions.setFieldMapping(s.moderator, s.sessionId, {
      fieldId: STORY_POINTS,
      optionByCardId: {},
    });
    await allowFields(s.app, []);

    expect((await s.sessions.checkReadiness(s.moderator, s.sessionId)).issues).toContainEqual(
      expect.objectContaining({ code: 'field-not-allowed', severity: 'error' }),
    );
    await expect(s.sessions.publish(s.moderator, s.sessionId)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('refreshes ticket baselines after a mapping change so conflicts can be detected', async () => {
    const s = await draft();
    const [first] = s.ticketIds;
    const reference = workItem(1).reference;
    s.app.workItems.setFieldValue(reference, STORY_POINTS, 2);
    await allowFields(s.app, [STORY_POINTS]);
    const session = await s.sessions.setFieldMapping(s.moderator, s.sessionId, {
      fieldId: STORY_POINTS,
      optionByCardId: {},
    });

    expect(session.tickets.find((t) => t.id === first)?.snapshot.fieldValues).toEqual({
      [STORY_POINTS]: 2,
    });
  });

  it('clears the destination', async () => {
    const s = await draft();
    await allowFields(s.app, [STORY_POINTS]);
    await s.sessions.setFieldMapping(s.moderator, s.sessionId, {
      fieldId: STORY_POINTS,
      optionByCardId: {},
    });
    await s.sessions.setFieldMapping(s.moderator, s.sessionId, {
      fieldId: null,
      optionByCardId: {},
    });

    expect((await s.sessions.getFieldMapping(s.moderator, s.sessionId)).destination).toBeNull();
  });
});

describe('writing final estimates', () => {
  async function mappedStoryPoints(): Promise<Setup> {
    const s = await draft();
    await allowFields(s.app, [STORY_POINTS]);
    await s.sessions.setFieldMapping(s.moderator, s.sessionId, {
      fieldId: STORY_POINTS,
      optionByCardId: {},
    });

    return s;
  }

  it('shows a failed write with its message and retries it with the same key', async () => {
    const s = await mappedStoryPoints();
    await s.publish();
    s.app.workItems.failNextUpdate('Jira is unavailable right now. Retry later.');
    await s.voteAll('5');

    const failed = await s.ticket();
    expect(failed).toMatchObject({ votingState: 'finalized', estimate: { label: '5' } });
    expect(failed.sync).toMatchObject({
      state: 'failed',
      fieldName: 'Story points',
      value: '5',
      message: 'Jira is unavailable right now. Retry later.',
      attemptCount: 1,
    });
    expect(failed.sync.retryAvailableAt).not.toBeNull();

    const [first] = s.ticketIds;

    if (first === undefined) {
      throw new Error('setup');
    }

    await s.sessions.retrySync(s.moderator, s.sessionId, first, false);
    expect((await s.ticket()).sync).toMatchObject({ state: 'succeeded', attemptCount: 2 });
    expect(s.app.workItems.currentFieldValue(workItem(1).reference, STORY_POINTS)).toBe(5);
    expect(new Set(s.app.workItems.updates.map((u) => u.idempotencyKey)).size).toBe(1);
  });

  it('only moderators can retry', async () => {
    const s = await mappedStoryPoints();
    await s.publish();
    s.app.workItems.failNextUpdate('Rate limited');
    await s.voteAll('3');
    const [first] = s.ticketIds;
    const [voter] = s.voters;

    if (first === undefined || voter === undefined) {
      throw new Error('setup');
    }

    await expect(s.sessions.retrySync(voter, s.sessionId, first, false)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('reports a conflict with the changed value and overwrites only once confirmed', async () => {
    const s = await mappedStoryPoints();
    await s.publish();
    s.app.workItems.setFieldValue(workItem(1).reference, STORY_POINTS, 13);
    await s.voteAll('8');
    const [first] = s.ticketIds;

    if (first === undefined) {
      throw new Error('setup');
    }

    expect((await s.ticket()).sync).toMatchObject({ state: 'conflict' });
    expect(s.app.workItems.updates).toHaveLength(0);
    await expect(
      s.sessions.retrySync(s.moderator, s.sessionId, first, false),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await s.sessions.retrySync(s.moderator, s.sessionId, first, true);
    expect((await s.ticket()).sync.state).toBe('succeeded');
    expect(s.app.workItems.currentFieldValue(workItem(1).reference, STORY_POINTS)).toBe(8);
  });

  it('fails the write when the field left the allowlist after publishing', async () => {
    const s = await mappedStoryPoints();
    await s.publish();
    await allowFields(s.app, []);
    await s.voteAll('2');

    const { sync } = await s.ticket();

    expect(sync.state).toBe('failed');
    expect(sync.message).toMatch(/no longer on the administrator's list/);
    expect(s.app.workItems.updates).toHaveLength(0);
  });

  it('recovers a write stuck in syncing after the timeout without double-applying', async () => {
    const s = await mappedStoryPoints();
    await s.publish();
    s.app.workItems.failNextUpdate('first attempt');
    await s.voteAll('5');
    const [first] = s.ticketIds;

    if (first === undefined) {
      throw new Error('setup');
    }

    // Simulate a process that claimed the write, wrote to Jira, then died before recording it.
    await s.sessions.retrySync(s.moderator, s.sessionId, first, false);
    const stored = await s.app.sessions.get(TENANT, s.sessionId);

    if (stored === null) {
      throw new Error('setup');
    }

    const reopened = {
      ...stored,
      tickets: stored.tickets.map((ticket) =>
        ticket.id === first
          ? {
              ...ticket,
              externalUpdate: {
                ...ticket.externalUpdate,
                state: 'pending' as const,
                attempts: ticket.externalUpdate.attempts.slice(0, 1),
              },
            }
          : ticket,
      ),
    };
    await s.app.sessions.save(beginTicketSync(reopened, first, s.app.clock.now()));
    expect((await s.ticket()).sync.state).toBe('syncing');

    await expect(
      s.sessions.retrySync(s.moderator, s.sessionId, first, false),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });

    s.app.clock.advance(STUCK_SYNC_AFTER_MS);
    const updatesBefore = s.app.workItems.updates.length;
    await s.sessions.retrySync(s.moderator, s.sessionId, first, false);

    // The value already landed, so the retry is recognised as written: no conflict.
    expect((await s.ticket()).sync).toMatchObject({ state: 'succeeded' });
    expect(s.app.workItems.updates.length - updatesBefore).toBe(1);
    expect(new Set(s.app.workItems.updates.map((u) => u.idempotencyKey)).size).toBe(1);
  });
});

describe('Milestone 7 acceptance — finalized estimates reach the configured Jira field', () => {
  it('writes a unanimous single-select estimate, or shows a visible sync error', async () => {
    const s = await draft({ deck: 't-shirt' });
    await s.settings.setFieldAllowlist(s.admin, [SIZE]);
    const mapping: Record<string, string> = {};

    for (const size of SIZES) {
      mapping[await s.card(size)] = size;
    }

    await s.sessions.setFieldMapping(s.moderator, s.sessionId, {
      fieldId: SIZE,
      optionByCardId: mapping,
    });
    await s.publish();

    // Ticket 1: unanimous → auto-finalized → written → auto-advanced.
    await s.voteAll('L');
    expect(await s.ticket(0)).toMatchObject({
      votingState: 'finalized',
      sync: { state: 'succeeded', fieldName: 'T-shirt size', value: 'L' },
    });
    expect(s.app.workItems.updates.at(-1)).toMatchObject({ fieldId: SIZE, value: 'L' });

    // Ticket 2: the write fails; the estimate stays final and the error is visible.
    s.app.workItems.failNextUpdate('You do not have permission to edit PP-2 in Jira.');
    await s.voteAll('S');
    expect(await s.ticket(1)).toMatchObject({
      votingState: 'finalized',
      estimate: { label: 'S' },
      sync: { state: 'failed', message: 'You do not have permission to edit PP-2 in Jira.' },
    });
  });
});
