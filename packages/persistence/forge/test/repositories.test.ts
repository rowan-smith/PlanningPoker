/**
 * Contract tests for the Forge repositories, run against InMemoryEntityStore, which mirrors the
 * entity store's conditional writes, partitioned indexes and cursor paging.
 */
import { describe, expect, it } from 'vitest';

import { ConcurrencyConflict } from '@planning-poker/application';
import type { AuditEvent, AuditEventId, TeamId, TenantId, UserId } from '@planning-poker/domain';
import { addTeamMember, asId, createTeam } from '@planning-poker/domain';

import {
  ForgeApplicationSettingsRepository,
  ForgeAtomicOperation,
  ForgeAuditRepository,
  ForgeTeamRepository,
} from '../src';
import { InMemoryEntityStore, MANIFEST_INDEXES } from '../src/testing';

const tenant = asId<TenantId>('ari:cloud:jira::site/1');
const otherTenant = asId<TenantId>('ari:cloud:jira::site/2');
const now = new Date('2026-03-01T10:00:00.000Z');
const user = (id: string) => asId<UserId>(id);

function newTeam(id: string, tenantId = tenant) {
  return createTeam({
    id: asId<TeamId>(id),
    tenantId,
    name: `Team ${id}`,
    createdBy: user('u1'),
    now,
  });
}

describe('ForgeTeamRepository', () => {
  it('round-trips a team, including dates and members', async () => {
    const repository = new ForgeTeamRepository(new InMemoryEntityStore(MANIFEST_INDEXES));
    const saved = await repository.save(addTeamMember(newTeam('t1'), user('u2'), now));

    expect(saved.version).toBe(1);
    expect(await repository.get(tenant, asId<TeamId>('t1'))).toEqual(saved);
  });

  it('rejects stale writes with ConcurrencyConflict', async () => {
    const repository = new ForgeTeamRepository(new InMemoryEntityStore(MANIFEST_INDEXES));
    const saved = await repository.save(newTeam('t1'));
    await repository.save({ ...saved, name: 'First writer' });

    await expect(repository.save({ ...saved, name: 'Second writer' })).rejects.toBeInstanceOf(
      ConcurrencyConflict,
    );
    await expect(repository.save(newTeam('t1'))).rejects.toBeInstanceOf(ConcurrencyConflict);
  });

  it('lists every page of a tenant’s teams and nothing from other tenants', async () => {
    const repository = new ForgeTeamRepository(new InMemoryEntityStore(MANIFEST_INDEXES, 2));

    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      await repository.save(newTeam(id));
    }

    await repository.save(newTeam('other', otherTenant));

    expect((await repository.listForTenant(tenant)).map((team) => team.id).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(await repository.get(tenant, asId<TeamId>('other'))).toBeNull();
  });
});

describe('ForgeApplicationSettingsRepository', () => {
  it('returns defaults, then saves with versions', async () => {
    const repository = new ForgeApplicationSettingsRepository(
      new InMemoryEntityStore(MANIFEST_INDEXES),
    );
    const initial = await repository.get(tenant);

    expect(initial).toEqual({
      tenantId: tenant,
      moderatorUserIds: [],
      writableFieldIds: [],
      version: 0,
    });

    const saved = await repository.save({
      ...initial,
      moderatorUserIds: [user('u1')],
      writableFieldIds: ['customfield_10016'],
    });
    expect(await repository.get(tenant)).toEqual(saved);
    await expect(repository.save(initial)).rejects.toBeInstanceOf(ConcurrencyConflict);
  });

  it('reads records saved before the writable-field allowlist existed', async () => {
    const store = new InMemoryEntityStore(MANIFEST_INDEXES);
    await store.create('appsettings', 'settings', {
      tenantId: tenant,
      version: 1,
      data: { moderatorUserIds: ['u1'] },
    });

    expect(await new ForgeApplicationSettingsRepository(store).get(tenant)).toEqual({
      tenantId: tenant,
      moderatorUserIds: [user('u1')],
      writableFieldIds: [],
      version: 1,
    });
  });
});

describe('ForgeAuditRepository', () => {
  it('stores events and lists them per team without leaking other tenants', async () => {
    const repository = new ForgeAuditRepository(new InMemoryEntityStore(MANIFEST_INDEXES));
    const event = (id: string, tenantId: TenantId): AuditEvent => ({
      id: asId<AuditEventId>(id),
      tenantId,
      type: 'team.created',
      actorId: user('u1'),
      teamId: asId<TeamId>('t1'),
      sessionId: null,
      ticketId: null,
      subjectUserId: null,
      details: { reason: 'test' },
      occurredAt: now,
    });
    await repository.append([event('e1', tenant), event('e2', otherTenant)]);

    expect(await repository.listForTeam(tenant, asId<TeamId>('t1'))).toEqual([event('e1', tenant)]);
  });
});

describe('ForgeAtomicOperation', () => {
  it('retries on ConcurrencyConflict and then gives up', async () => {
    const atomic = new ForgeAtomicOperation(3);
    let calls = 0;
    const result = await atomic.run('key', () => {
      calls += 1;

      return calls < 3 ? Promise.reject(new ConcurrencyConflict()) : Promise.resolve('done');
    });

    expect(result).toBe('done');
    await expect(
      atomic.run('key', () => Promise.reject(new ConcurrencyConflict())),
    ).rejects.toBeInstanceOf(ConcurrencyConflict);
  });

  it('does not retry other errors', async () => {
    const atomic = new ForgeAtomicOperation();
    let calls = 0;

    await expect(
      atomic.run('key', () => {
        calls += 1;

        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});
