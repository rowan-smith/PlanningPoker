/**
 * Contract tests for the Milestone 9 storage guarantees: transactions, votes guarded by the
 * session version, reveals checked against the votes they counted, and conflict retries.
 */
import { describe, expect, it } from 'vitest';

import { ConcurrencyConflict } from '@planning-poker/application';
import type { CardId, RoundId, Session, SessionId, UserId, Vote } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import { ForgeAtomicOperation, ForgeSessionRepository, ForgeVoteRepository } from '../src';
import { InMemoryEntityStore, MANIFEST_INDEXES } from '../src/testing';

const tenant = 'tenant-1';

function vote(userId: string, cardId: string, at = 1000): Vote {
  return {
    roundId: asId<RoundId>('round-1'),
    userId: asId<UserId>(userId),
    cardId: asId<CardId>(cardId),
    submittedAt: new Date(at),
  };
}

/** Stores a minimal session record at the given version. */
function seedSession(store: InMemoryEntityStore, version: number): Session {
  const session = {
    id: asId<SessionId>('s1'),
    tenantId: tenant,
    teamId: 't1',
    status: 'active',
    version,
  } as unknown as Session;
  store.records.set('session/s1', {
    id: 's1',
    tenantId: tenant,
    teamId: 't1',
    status: 'active',
    version,
    updatedAt: 0,
    data: {},
  });

  return { ...session, updatedAt: new Date(0) };
}

describe('InMemoryEntityStore.transact', () => {
  it('writes everything only when every condition holds', async () => {
    const store = new InMemoryEntityStore(MANIFEST_INDEXES);
    await store.put('vote', 'a', { cardId: 'c1', submittedAt: 1 });

    await expect(
      store.transact(
        [{ entity: 'session', key: 'x', value: { version: 1 } }],
        [{ entity: 'vote', key: 'a', equals: { cardId: 'c2' } }],
      ),
    ).rejects.toBeInstanceOf(ConcurrencyConflict);
    expect(store.records.has('session/x')).toBe(false);

    await store.transact(
      [{ entity: 'session', key: 'x', value: { version: 1 } }],
      [{ entity: 'vote', key: 'a', equals: { cardId: 'c1', submittedAt: 1 } }],
    );
    expect(store.records.get('session/x')).toEqual({ version: 1 });
  });

  it('enforces Forge limits: 25 operations, each key once', async () => {
    const store = new InMemoryEntityStore(MANIFEST_INDEXES);
    const many = Array.from({ length: 26 }, (_, index) => ({
      entity: 'vote',
      key: String(index),
      value: {},
    }));

    await expect(store.transact(many, [])).rejects.toThrow('Invalid transaction.');
    await expect(
      store.transact(
        [{ entity: 'vote', key: 'a', value: {} }],
        [{ entity: 'vote', key: 'a', equals: {} }],
      ),
    ).rejects.toThrow('Invalid transaction.');
  });
});

describe('guarded votes', () => {
  it('commit only while the session is at the version the voter read', async () => {
    const store = new InMemoryEntityStore(MANIFEST_INDEXES);
    const votes = new ForgeVoteRepository(store);
    seedSession(store, 3);

    await votes.upsert(tenant as never, vote('ana', 'c1'), {
      sessionId: asId<SessionId>('s1'),
      sessionVersion: 3,
    });
    await expect(
      votes.upsert(tenant as never, vote('ana', 'c2'), {
        sessionId: asId<SessionId>('s1'),
        sessionVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ConcurrencyConflict);

    const [stored] = await votes.listForRound(tenant as never, asId<RoundId>('round-1'), [
      asId<UserId>('ana'),
    ]);
    expect(stored?.cardId).toBe('c1');
  });
});

describe('session saves that counted votes', () => {
  it('fail when a counted vote changed after it was read', async () => {
    const store = new InMemoryEntityStore(MANIFEST_INDEXES);
    const votes = new ForgeVoteRepository(store);
    const sessions = new ForgeSessionRepository(store);
    const session = seedSession(store, 3);
    const counted = vote('ana', 'c1');
    await votes.upsert(tenant as never, counted);
    // Ana changes her vote after the reveal read it.
    await votes.upsert(tenant as never, vote('ana', 'c2', 2000));

    await expect(sessions.save(session, { countedVotes: [counted] })).rejects.toBeInstanceOf(
      ConcurrencyConflict,
    );

    await votes.upsert(tenant as never, counted);
    await expect(sessions.save(session, { countedVotes: [counted] })).resolves.toMatchObject({
      version: 4,
    });
  });
});

describe('ForgeAtomicOperation', () => {
  it('retries conflicts with growing randomized backoff, then gives up', async () => {
    const delays: number[] = [];
    const atomic = new ForgeAtomicOperation(
      4,
      (milliseconds) => {
        delays.push(milliseconds);

        return Promise.resolve();
      },
      () => 0.5,
    );
    let attempts = 0;

    await expect(
      atomic.run('k', () => {
        attempts += 1;

        return Promise.reject(new ConcurrencyConflict());
      }),
    ).rejects.toBeInstanceOf(ConcurrencyConflict);
    expect(attempts).toBe(4);
    expect(delays).toEqual([7, 15, 30]);
  });

  it('does not retry other errors', async () => {
    const atomic = new ForgeAtomicOperation();
    let attempts = 0;

    await expect(
      atomic.run('k', () => {
        attempts += 1;

        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    expect(attempts).toBe(1);
  });
});
