/** Milestone 8 — report resolvers: payload validation and permission codes. */
import { describe, expect, it } from 'vitest';

import {
  ReportService,
  SessionService,
  SettingsService,
  TeamService,
} from '@planning-poker/application';
import { createInMemoryApplication } from '@planning-poker/application/testing';
import { RESOLVER_KEYS } from '@planning-poker/contracts';
import type { ApplicationRole, TenantId, UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import { createHandlers } from '../src/handlers';

const tenant = asId<TenantId>('tenant');

function setup(role: ApplicationRole) {
  const app = createInMemoryApplication();
  app.identity.add({
    id: asId<UserId>('me'),
    tenantId: tenant,
    displayName: 'me',
    externalIdentities: [],
  });
  app.identity.actor = { userId: asId<UserId>('me'), tenantId: tenant, role };
  const deps = { ...app.deps, settings: app.settings };
  const handlers = createHandlers(
    {
      identity: app.identity,
      teams: new TeamService(deps),
      settings: new SettingsService(deps),
      sessions: new SessionService(deps),
      reports: new ReportService(deps),
    },
    { error: () => undefined },
  );

  return { app, handlers };
}

const NO_FILTERS = { teamId: null, status: null, from: null, to: null, cursor: null };

describe('report resolvers', () => {
  it('are all registered', () => {
    expect(RESOLVER_KEYS).toEqual(
      expect.arrayContaining([
        'listSessionHistory',
        'getSessionSummary',
        'getReportScope',
        'getTeamReport',
        'getAppReport',
        'listAuditEvents',
      ]),
    );
  });

  it('accepts empty filters, dates and omitted optional fields', async () => {
    const { handlers } = setup('member');

    expect(await handlers.listSessionHistory(NO_FILTERS)).toMatchObject({
      ok: true,
      value: { items: [], total: 0, nextCursor: null },
    });
    expect(await handlers.listSessionHistory({})).toMatchObject({ ok: true });
    expect(
      await handlers.listSessionHistory({
        ...NO_FILTERS,
        status: 'completed',
        from: '2026-01-01',
        to: '2026-01-31T12:00:00.000Z',
        limit: 10,
      }),
    ).toMatchObject({ ok: true });
  });

  it('rejects malformed history filters', async () => {
    const { handlers } = setup('member');
    const invalid = async (payload: Record<string, unknown>, message: string) => {
      expect(await handlers.listSessionHistory({ ...NO_FILTERS, ...payload })).toEqual({
        ok: false,
        error: { code: 'VALIDATION', message },
      });
    };

    await invalid({ status: 'draft' }, 'Invalid status.');
    await invalid({ teamId: 42 }, 'Invalid teamId.');
    await invalid({ from: 'yesterday' }, 'Invalid from.');
    await invalid({ to: '2026-02-31' }, 'Invalid to.');
    await invalid({ from: 'x'.repeat(41) }, 'Invalid from.');
    await invalid({ limit: 0 }, 'Invalid limit.');
    await invalid({ limit: 101 }, 'Invalid limit.');
    await invalid({ limit: 1.5 }, 'Invalid limit.');
    await invalid({ cursor: 'abc' }, 'Invalid cursor.');
    await invalid(
      { from: '2026-02-01', to: '2026-01-01' },
      'The start date must be on or before the end date.',
    );
  });

  it('validates summary, team report and audit payloads', async () => {
    const { handlers } = setup('administrator');

    expect(await handlers.getSessionSummary({})).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid sessionId.' },
    });
    expect(await handlers.getTeamReport({ from: null, to: null })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid teamId.' },
    });
    expect(await handlers.getAppReport({ from: 5, to: null })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid from.' },
    });
    expect(await handlers.listAuditEvents({ sessionId: ['s'] })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION', message: 'Invalid sessionId.' },
    });
  });

  it('returns permission codes from the service', async () => {
    const member = setup('member').handlers;
    const adminHandlers = setup('administrator').handlers;

    expect(await member.getAppReport({ from: null, to: null })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await adminHandlers.getAppReport({ from: '2026-01-01', to: null })).toMatchObject({
      ok: true,
      value: { sessionCount: 0, from: '2026-01-01T00:00:00.000Z' },
    });
    expect(await member.getSessionSummary({ sessionId: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await member.listAuditEvents({ sessionId: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await member.getTeamReport({ teamId: 'missing', from: null, to: null })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await member.getReportScope({})).toEqual({
      ok: true,
      value: { teams: [], canViewAppReport: false },
    });
  });
});
