/**
 * Milestone 4: importing work items by key and by query, with previews, ordering and display
 * fields. Runs against the in-memory provider.
 */
import { describe, expect, it } from 'vitest';

import type { UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import { SessionService, TeamService } from '../src';
import { createInMemoryApplication } from '../src/testing';
import { actor, TENANT, workItem } from './support';

async function setup() {
  const app = createInMemoryApplication();
  const sessions = new SessionService(app.deps);
  app.identity.add({
    id: asId<UserId>('mod'),
    tenantId: TENANT,
    displayName: 'Mod',
    externalIdentities: [],
  });
  const moderator = actor('mod', 'moderator');
  const member = actor('mem');
  const team = await new TeamService(app.deps).createTeam(moderator, { name: 'Platform' });
  const draft = await sessions.createDraft(moderator, { name: 'Sprint', teamId: team.id });

  for (let index = 1; index <= 7; index += 1) {
    const key = `PP-${String(index)}`;
    app.workItems.add(key, workItem(index));
    app.workItems.fieldTexts.set(key, { priority: index === 1 ? 'High' : 'Low' });
  }

  app.workItems.fields = [
    { fieldId: 'priority', name: 'Priority', valueType: 'unsupported', options: [] },
  ];

  return { app, sessions, moderator, member, sessionId: draft.id };
}

describe('Milestone 4 — ticket import', () => {
  it('imports by key, skips duplicates and reports unknown keys', async () => {
    const { sessions, moderator, sessionId } = await setup();
    const first = await sessions.importByKeys(moderator, sessionId, ['PP-1', ' PP-2 ', 'PP-1']);
    const second = await sessions.importByKeys(moderator, sessionId, ['PP-2', 'PP-99']);

    expect(first.missing).toEqual([]);
    expect(second.missing).toEqual(['PP-99']);
    expect(second.session.tickets.map((ticket) => ticket.reference.displayKey)).toEqual([
      'PP-1',
      'PP-2',
    ]);
  });

  it('searches with previews, paging, and marks items already added', async () => {
    const { sessions, moderator, sessionId } = await setup();
    await sessions.importByKeys(moderator, sessionId, ['PP-2']);

    const page = await sessions.searchWorkItems(moderator, sessionId, 'project = PP', null);
    expect(page.items).toHaveLength(5);
    expect(page.items.find((item) => item.key === 'PP-2')?.alreadyAdded).toBe(true);
    expect(page.items[0]).toMatchObject({ key: 'PP-1', title: 'Ticket 1', status: 'To Do' });

    const next = await sessions.searchWorkItems(
      moderator,
      sessionId,
      'project = PP',
      page.nextCursor,
    );
    expect(next.items.map((item) => item.key)).toEqual(['PP-6', 'PP-7']);
    expect(next.nextCursor).toBeNull();
    await expect(sessions.searchWorkItems(moderator, sessionId, '  ', null)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('only lets moderators search, suggest or import', async () => {
    const { sessions, member, sessionId } = await setup();

    await expect(sessions.searchWorkItems(member, sessionId, 'x', null)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(sessions.suggestQuery(member, sessionId, 'pro')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(sessions.importByKeys(member, sessionId, ['PP-1'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('caps a single key import at 100 keys', async () => {
    const { sessions, moderator, sessionId } = await setup();
    const keys = Array.from({ length: 101 }, (_, index) => `PP-${String(index + 1)}`);

    await expect(sessions.importByKeys(moderator, sessionId, keys)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('shows chosen display fields and refreshes tickets already imported', async () => {
    const { sessions, moderator, sessionId } = await setup();
    await sessions.importByKeys(moderator, sessionId, ['PP-1']);

    expect((await sessions.getDisplayFields(moderator, sessionId)).available).toEqual([
      { id: 'priority', name: 'Priority' },
    ]);

    const updated = await sessions.setDisplayFields(moderator, sessionId, ['priority']);
    expect(updated.settings.displayFieldIds).toEqual(['priority']);
    expect(updated.tickets[0]?.snapshot.displayFields).toEqual({ Priority: 'High' });

    await sessions.importByKeys(moderator, sessionId, ['PP-2']);
    const view = await sessions.getBuilderView(moderator, sessionId);
    expect(view.session.tickets.map((ticket) => ticket.displayFields)).toEqual([
      { Priority: 'High' },
      { Priority: 'Low' },
    ]);
  });

  it('rejects unknown or too many display fields', async () => {
    const { sessions, moderator, sessionId } = await setup();

    await expect(sessions.setDisplayFields(moderator, sessionId, ['nope'])).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(
      sessions.setDisplayFields(moderator, sessionId, ['a', 'b', 'c', 'd', 'e', 'f']),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('keeps imported tickets in the moderator’s chosen order', async () => {
    const { sessions, moderator, sessionId } = await setup();
    const { session } = await sessions.importByKeys(moderator, sessionId, ['PP-1', 'PP-2', 'PP-3']);
    const [one, two, three] = [...session.tickets].sort((a, b) => a.order - b.order);

    if (one === undefined || two === undefined || three === undefined) {
      throw new Error('setup');
    }

    await sessions.reorderTickets(moderator, sessionId, [three.id, one.id, two.id]);
    const view = await sessions.getBuilderView(moderator, sessionId);

    expect(view.session.tickets.map((ticket) => ticket.displayKey)).toEqual([
      'PP-3',
      'PP-1',
      'PP-2',
    ]);
  });
});
