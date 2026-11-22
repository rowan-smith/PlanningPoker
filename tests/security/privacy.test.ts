/**
 * Restricted vote access, safe handling of Jira content, and log hygiene, checked against
 * everything the backend produces: every view, event, report, audit entry, stored record and log
 * line from a full session.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RESTRICTED_TITLE } from '@planning-poker/application';
import { clearVisibilityCache } from '@planning-poker/integration-jira';

import { consoleLogger } from '../../apps/jira-forge/src/logger';
import { STORY_POINTS } from '../support/fake-jira';
import { ok, userId } from '../support/forge-backend';
import type { World } from '../support/world';
import {
  cardId,
  createWorld,
  currentTicketId,
  ISSUES,
  LEE,
  liveSession,
  MAX,
  MIA,
  OLA,
  SAM,
  ticketOf,
} from '../support/world';

const ROOT = join(import.meta.dirname, '..', '..');

/** Every object node in a JSON-like value. */
function objects(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      objects(item, found);
    }
  } else if (typeof value === 'object' && value !== null) {
    found.push(value as Record<string, unknown>);

    for (const child of Object.values(value)) {
      objects(child, found);
    }
  }

  return found;
}

/**
 * Fails if any object names a person (by ID or display name) and, in its own fields, a card
 * someone voted — the shape an identity-to-vote mapping would take.
 */
function expectNoVotePairs(
  label: string,
  value: unknown,
  people: readonly string[],
  votedCards: readonly string[],
): void {
  for (const node of objects(value)) {
    const direct = Object.values(node).filter(
      (entry) => typeof entry === 'string' || typeof entry === 'number',
    );
    const namesPerson = direct.some((entry) => people.includes(String(entry)));
    const namesCard = direct.some((entry) => votedCards.includes(String(entry)));

    expect(namesPerson && namesCard, `${label}: ${JSON.stringify(node)}`).toBe(false);
  }
}

/** A session where each voter picks a different card, then revote, override and complete. */
async function playedSession(world: World) {
  const sessionId = await liveSession(world);
  const { max, mia, sam, ola } = world;
  let view = ok(await max.getSession({ sessionId }));
  const ticketId = currentTicketId(view);
  const picks = { [MIA]: cardId(view, '1'), [SAM]: cardId(view, '13'), [OLA]: cardId(view, '21') };
  ok(await mia.submitVote({ sessionId, ticketId, cardId: picks[MIA] }));
  ok(await sam.submitVote({ sessionId, ticketId, cardId: picks[SAM] }));
  ok(await ola.submitVote({ sessionId, ticketId, cardId: picks[OLA] }));
  ok(await max.skipParticipant({ sessionId, userId: userId(SAM), scope: 'session' }));
  ok(await max.startNewRound({ sessionId, ticketId }));
  ok(await mia.submitVote({ sessionId, ticketId, cardId: picks[MIA] }));
  ok(await ola.submitVote({ sessionId, ticketId, cardId: picks[OLA] }));
  view = ok(await max.getSession({ sessionId }));
  ok(
    await max.overrideEstimate({
      sessionId,
      ticketId,
      cardId: cardId(view, '8'),
      reason: 'Agreed',
    }),
  );
  ok(await max.completeSession({ sessionId }));

  return { sessionId, ticketId, picks };
}

describe('restricted vote access', () => {
  it('never pairs a person with a vote in any view, event, report, audit entry or record', async () => {
    const world = await createWorld();
    const { sessionId, picks } = await playedSession(world);
    const accounts = [MAX, MIA, SAM, OLA, LEE];
    const people = [
      ...accounts.map(userId),
      'Max Moderator',
      'Mia Member',
      'Sam Member',
      'Ola Invited',
      'Lee Observer',
    ];
    const view = ok(await world.max.getSession({ sessionId }));
    const votedCards = [
      ...Object.values(picks),
      ...Object.values(picks).map(
        (id) => view.deck.find((card) => card.id === id)?.label ?? 'missing',
      ),
    ];
    const outputs: Record<string, unknown> = {};

    for (const [name, caller] of Object.entries({
      max: world.max,
      ada: world.ada,
      mia: world.mia,
      sam: world.sam,
      ola: world.ola,
      lee: world.lee,
    })) {
      outputs[`${name}.getSession`] = await caller.getSession({ sessionId });
      outputs[`${name}.getHome`] = await caller.getHome();
      outputs[`${name}.listSessions`] = await caller.listSessions();
      outputs[`${name}.summary`] = await caller.getSessionSummary({ sessionId });
      outputs[`${name}.history`] = await caller.listSessionHistory({});
      outputs[`${name}.audit`] = await caller.listAuditEvents({ sessionId });
      outputs[`${name}.teamReport`] = await caller.getTeamReport({ teamId: world.teamId });
      outputs[`${name}.appReport`] = await caller.getAppReport({});
    }

    outputs.events = world.backend.events.published;
    // Stored records other than the private vote records themselves.
    outputs.records = [...world.backend.memory.records.entries()]
      .filter(([key]) => !key.startsWith('vote/'))
      .map(([, record]) => record);
    outputs.logs = world.backend.logged;

    for (const [label, value] of Object.entries(outputs)) {
      expectNoVotePairs(label, value, people, votedCards);
    }

    // Each person sees only their own choice, as `myVoteCardId`, in their own view.
    const own = ok(await world.mia.getSession({ sessionId }));
    const sams = ok(await world.sam.getSession({ sessionId }));
    expect(own.tickets[0]?.myVoteCardId).toBe(picks[MIA]);
    expect(sams.tickets[0]?.myVoteCardId).toBeNull();
    expect(ok(await world.lee.getSession({ sessionId })).tickets[0]?.myVoteCardId).toBeNull();
  });

  it('keeps realtime events to IDs and counts', async () => {
    const world = await createWorld();
    await playedSession(world);
    const allowedKeys = new Set([
      'type',
      'ticketId',
      'userId',
      'votedCount',
      'requiredCount',
      'status',
      'state',
    ]);

    for (const { event } of world.backend.events.published) {
      expect(Object.keys(event).filter((key) => !allowedKeys.has(key))).toEqual([]);
      expect(JSON.stringify(event)).not.toMatch(/cardId|label|value/);
    }
  });
});

describe('Jira content', () => {
  it('is stored and returned as plain text, exactly as typed in Jira', async () => {
    const world = await createWorld();
    const sessionId = await liveSession(world);
    const view = ok(await world.mia.getSession({ sessionId }));
    const ticket = view.tickets.find((candidate) => candidate.displayKey === 'PP-1');

    expect(ticket?.title).toBe('Story 1 <img src=x onerror=alert(1)>');
    expect(ticket?.description).toBe('Details for PP-1 <script>alert("x")</script>');
  });

  it('is never rendered as HTML by the UI', () => {
    const sources: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);

        if (entry === 'node_modules' || entry === 'build' || entry === 'dist') {
          continue;
        }

        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (/\.(ts|tsx|html)$/.test(entry)) {
          sources.push(path);
        }
      }
    };
    walk(join(ROOT, 'packages', 'ui', 'src'));
    walk(join(ROOT, 'apps', 'jira-forge', 'static'));
    const unsafe = sources.filter((path) =>
      /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(/.test(
        readFileSync(path, 'utf8'),
      ),
    );

    expect(unsafe).toEqual([]);
  });

  it('is hidden from invitees who cannot see the issue in Jira (an invitation grants no access)', async () => {
    const world = await createWorld();
    const sessionId = await liveSession(world, { keys: [ISSUES.sec1.key, ISSUES.pp1.key] });
    const asMax = ok(await world.max.getSession({ sessionId }));
    const asMia = ok(await world.mia.getSession({ sessionId }));
    const secret = asMia.tickets.find((ticket) => ticket.displayKey === 'SEC-1');

    expect(asMax.tickets.find((ticket) => ticket.displayKey === 'SEC-1')?.title).toBe(
      'Confidential security fix',
    );
    expect(secret).toMatchObject({
      title: RESTRICTED_TITLE,
      description: null,
      url: null,
      displayFields: {},
    });
    expect(asMia.tickets.find((ticket) => ticket.displayKey === 'PP-1')?.title).toContain(
      'Story 1',
    );

    // Nowhere else either: home, list, summary, history.
    const elsewhere = JSON.stringify([
      await world.mia.getHome(),
      await world.mia.listSessions(),
      await world.mia.getSessionSummary({ sessionId }),
      await world.mia.listSessionHistory({}),
    ]);
    expect(elsewhere).not.toMatch(/Confidential|Exploit/);
    expect(JSON.stringify(ok(await world.max.getHome()))).toContain('Confidential');
    expect(ticketOf(asMia, secret?.id ?? '').round).not.toBeNull();
  });

  it('is hidden once the issue is no longer visible, and when Jira cannot be asked', async () => {
    const world = await createWorld();
    const sessionId = await liveSession(world, { keys: [ISSUES.pp1.key] });
    const { jira } = world.backend;
    const original = jira.issues.get(ISSUES.pp1.id);
    // The issue is deleted or its permissions change after import (answers are cached briefly).
    jira.issues.delete(ISSUES.pp1.id);
    clearVisibilityCache();

    expect(ok(await world.max.getSession({ sessionId })).tickets[0]?.title).toBe(RESTRICTED_TITLE);

    // Jira errors: fail closed rather than show content nobody checked.
    if (original !== undefined) {
      jira.issues.set(ISSUES.pp1.id, original);
    }

    clearVisibilityCache();
    const request = jira.requestFor.bind(jira);
    jira.requestFor = (accountId) => async (path, as, init) =>
      path.value === '/rest/api/3/issue/bulkfetch'
        ? { status: 503, json: () => Promise.resolve({}) }
        : await request(accountId)(path, as, init);

    expect(ok(await world.max.getSession({ sessionId })).tickets[0]?.title).toBe(RESTRICTED_TITLE);
    expect(original?.fields[STORY_POINTS]).toBeNull();
  });
});

describe('logs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never contain tokens or raw Jira response bodies', async () => {
    const world = await createWorld();
    const sessionId = await liveSession(world, { autoFinalize: true, keys: [ISSUES.pp1.key] });
    const { jira } = world.backend;
    jira.putFailures.push(500, 400, 409, 422, 429);
    const view = ok(await world.max.getSession({ sessionId }));
    const ticketId = currentTicketId(view);

    for (const caller of [world.ola, world.sam, world.mia]) {
      ok(await caller.submitVote({ sessionId, ticketId, cardId: cardId(view, '3') }));
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await world.max.retrySync({ sessionId, ticketId, confirmOverwrite: false });
    }

    // An unexpected Jira failure reaches the logger as an internal error.
    const originalRequest = jira.requestFor.bind(jira);
    jira.requestFor = (accountId) => {
      const request = originalRequest(accountId);

      return async (path, as, init) =>
        path.value.startsWith('/rest/api/3/user/bulk')
          ? {
              status: 500,
              json: () => Promise.resolve({ message: 'Bearer SECRET-TOKEN-123 leaked' }),
            }
          : await request(path, as, init);
    };
    expect(await world.max.getSession({ sessionId })).toMatchObject({
      error: { code: 'INTERNAL', message: 'Something went wrong. Try again.' },
    });

    const logged = world.backend.logged.join('\n');
    expect(world.backend.logged.length).toBeGreaterThan(0);
    expect(logged).not.toMatch(/SECRET|Bearer|token=|jwt/i);
    jira.requestFor = originalRequest;
    // Nor do the messages shown to moderators.
    expect(JSON.stringify(ok(await world.max.getSession({ sessionId })))).not.toContain('SECRET');
  });

  it('write only an error’s name and message, never its other properties', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error('Jira request failed (bulkfetch, HTTP 500).'), {
      response: { body: 'SECRET-TOKEN-123' },
      headers: { authorization: 'Bearer SECRET' },
    });

    consoleLogger.error('Resolver getSession failed', error);
    consoleLogger.error('Something odd', { token: 'SECRET' });

    expect(spy.mock.calls).toEqual([
      ['Resolver getSession failed: Error: Jira request failed (bulkfetch, HTTP 500).'],
      ['Something odd: Unknown error'],
    ]);
  });
});
