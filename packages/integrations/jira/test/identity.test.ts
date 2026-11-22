/**
 * Contract tests for the Jira user API and AtlassianIdentityProvider, using recorded-shape
 * responses from the Jira Cloud REST v3 OpenAPI spec, plus malformed and failing ones.
 */
import { describe, expect, it } from 'vitest';

import type { Route } from '@forge/api';
import type { ApplicationSettingsRepository } from '@planning-poker/application';
import type { TenantId, UserId } from '@planning-poker/domain';
import { asId } from '@planning-poker/domain';

import type { JiraRequest } from '../src';
import {
  AtlassianIdentityProvider,
  ForgeJiraUserApi,
  JiraApiError,
  accountIdForUser,
  userIdForAccount,
} from '../src';

const tenant = asId<TenantId>('ari:cloud:jira::site/1');

function jiraUser(accountId: string, extra: Record<string, unknown> = {}) {
  return {
    accountId,
    accountType: 'atlassian',
    active: true,
    displayName: `User ${accountId}`,
    avatarUrls: { '48x48': `https://avatar.example/${accountId}.png` },
    ...extra,
  };
}

/** Fake Jira: answers by path prefix and records every request. */
function fakeJira(responses: Record<string, { status: number; body: unknown }>) {
  const calls: { path: string; as: 'app' | 'user' }[] = [];
  const request: JiraRequest = (path: Route, as) => {
    calls.push({ path: path.value, as });
    const match = Object.entries(responses).find(([prefix]) => path.value.startsWith(prefix));
    const response = match?.[1] ?? { status: 404, body: {} };

    return Promise.resolve({ status: response.status, json: () => Promise.resolve(response.body) });
  };

  return { request, calls };
}

function settingsWith(moderators: readonly string[]): ApplicationSettingsRepository {
  return {
    get: (tenantId) =>
      Promise.resolve({
        tenantId,
        moderatorUserIds: moderators.map((id) => asId<UserId>(id)),
        writableFieldIds: [],
        version: 1,
      }),
    save: (settings) => Promise.resolve(settings),
  };
}

describe('identity mapping', () => {
  it('derives a reversible internal ID from the Atlassian account', () => {
    const userId = userIdForAccount('5b10ac8d82e05b22cc7d4ef5');

    expect(userId).toBe('atlassian:5b10ac8d82e05b22cc7d4ef5');
    expect(accountIdForUser(userId)).toBe('5b10ac8d82e05b22cc7d4ef5');
    expect(accountIdForUser(asId<UserId>('github:42'))).toBeNull();
  });
});

describe('ForgeJiraUserApi', () => {
  it('fetches users in bulk with repeated accountId parameters, as the app', async () => {
    const jira = fakeJira({
      '/rest/api/3/user/bulk': { status: 200, body: { values: [jiraUser('a'), jiraUser('b')] } },
    });
    const users = await new ForgeJiraUserApi(jira.request).getUsers(['a', 'b', 'a']);

    expect(users.map((user) => user.accountId)).toEqual(['a', 'b']);
    expect(jira.calls).toEqual([
      { path: '/rest/api/3/user/bulk?maxResults=2&accountId=a&accountId=b', as: 'app' },
    ]);
  });

  it('skips malformed users instead of failing', async () => {
    const jira = fakeJira({
      '/rest/api/3/user/search': {
        status: 200,
        body: [
          jiraUser('a'),
          { displayName: 'No account' },
          null,
          jiraUser('b', { avatarUrls: 5 }),
        ],
      },
    });
    const users = await new ForgeJiraUserApi(jira.request).searchUsers('us');

    expect(users.map((user) => [user.accountId, user.avatarUrl])).toEqual([
      ['a', 'https://avatar.example/a.png'],
      ['b', null],
    ]);
  });

  it('reads the ADMINISTER permission as the calling user', async () => {
    const jira = fakeJira({
      '/rest/api/3/mypermissions': {
        status: 200,
        body: { permissions: { ADMINISTER: { key: 'ADMINISTER', havePermission: true } } },
      },
    });

    expect(await new ForgeJiraUserApi(jira.request).currentUserIsAdministrator()).toBe(true);
    expect(jira.calls[0]?.as).toBe('user');
  });

  it('treats a missing or malformed permission as not an administrator', async () => {
    const jira = fakeJira({
      '/rest/api/3/mypermissions': { status: 200, body: { permissions: [] } },
    });

    expect(await new ForgeJiraUserApi(jira.request).currentUserIsAdministrator()).toBe(false);
  });

  it('raises JiraApiError on failures, with a rate-limit message for 429', async () => {
    const jira = fakeJira({ '/rest/api/3/user/search': { status: 429, body: {} } });

    await expect(new ForgeJiraUserApi(jira.request).searchUsers('x')).rejects.toThrow(
      /rate limiting/,
    );
    await expect(
      new ForgeJiraUserApi(fakeJira({}).request).searchUsers('x'),
    ).rejects.toBeInstanceOf(JiraApiError);
  });
});

describe('AtlassianIdentityProvider', () => {
  const directory = fakeJira({
    '/rest/api/3/mypermissions': {
      status: 200,
      body: { permissions: { ADMINISTER: { havePermission: false } } },
    },
    '/rest/api/3/user/search': {
      status: 200,
      body: [
        jiraUser('person'),
        jiraUser('bot', { accountType: 'app' }),
        jiraUser('gone', { active: false }),
      ],
    },
  });

  it('resolves Jira administrators as application administrators', async () => {
    const admin = fakeJira({
      '/rest/api/3/mypermissions': {
        status: 200,
        body: { permissions: { ADMINISTER: { havePermission: true } } },
      },
    });
    const provider = new AtlassianIdentityProvider(
      { tenantId: tenant, accountId: 'boss' },
      new ForgeJiraUserApi(admin.request),
      settingsWith([]),
    );

    expect(await provider.currentActor()).toEqual({
      userId: 'atlassian:boss',
      tenantId: tenant,
      role: 'administrator',
    });
  });

  it('resolves configured users as moderators and everyone else as members', async () => {
    const api = new ForgeJiraUserApi(directory.request);
    const moderator = new AtlassianIdentityProvider(
      { tenantId: tenant, accountId: 'mod' },
      api,
      settingsWith(['atlassian:mod']),
    );
    const member = new AtlassianIdentityProvider(
      { tenantId: tenant, accountId: 'someone' },
      api,
      settingsWith(['atlassian:mod']),
    );

    expect((await moderator.currentActor()).role).toBe('moderator');
    expect((await member.currentActor()).role).toBe('member');
  });

  it('rejects requests without a signed-in account', async () => {
    const provider = new AtlassianIdentityProvider(
      { tenantId: tenant, accountId: undefined },
      new ForgeJiraUserApi(directory.request),
      settingsWith([]),
    );

    await expect(provider.currentActor()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('only offers active people from user search', async () => {
    const provider = new AtlassianIdentityProvider(
      { tenantId: tenant, accountId: 'mod' },
      new ForgeJiraUserApi(directory.request),
      settingsWith([]),
    );
    const users = await provider.searchUsers(tenant, 'p');

    expect(users.map((user) => user.id)).toEqual(['atlassian:person']);
  });

  it('ignores non-Atlassian user IDs when looking up users', async () => {
    const jira = fakeJira({});
    const provider = new AtlassianIdentityProvider(
      { tenantId: tenant, accountId: 'mod' },
      new ForgeJiraUserApi(jira.request),
      settingsWith([]),
    );

    expect(await provider.getUsers(tenant, [asId<UserId>('github:1')])).toEqual([]);
    expect(jira.calls).toEqual([]);
  });
});
