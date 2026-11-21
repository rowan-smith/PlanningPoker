import api, { route } from '@forge/api';
import type { Route } from '@forge/api';

/** Jira Cloud REST v3 limits /user/bulk pages; ask for this many accounts per request. */
const BULK_CHUNK_SIZE = 50;
const SEARCH_LIMIT = 20;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_TOO_MANY_REQUESTS = 429;

export interface JiraUser {
  readonly accountId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly active: boolean;
  /** `atlassian` for people; `app` and `customer` accounts are excluded from rosters. */
  readonly accountType: string;
}

export interface JiraUserApi {
  getUsers(accountIds: readonly string[]): Promise<readonly JiraUser[]>;
  searchUsers(query: string): Promise<readonly JiraUser[]>;
  /** Whether the calling user holds Jira's global ADMINISTER permission. */
  currentUserIsAdministrator(): Promise<boolean>;
}

export interface JiraResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export interface JiraRequestInit {
  readonly method: 'GET' | 'POST';
  /** Serialized as JSON. */
  readonly body?: unknown;
}

/** Sends a request as the app or as the calling user. Injected so tests run without Forge. */
export type JiraRequest = (
  path: Route,
  as: 'app' | 'user',
  init?: JiraRequestInit,
) => Promise<JiraResponse>;

export class JiraApiError extends Error {
  readonly status: number;

  constructor(operation: string, status: number) {
    super(
      status === HTTP_TOO_MANY_REQUESTS
        ? `Jira is rate limiting requests (${operation}). Try again shortly.`
        : `Jira request failed (${operation}, HTTP ${String(status)}).`,
    );
    this.name = 'JiraApiError';
    this.status = status;
  }
}

export const forgeJiraRequest: JiraRequest = async (path, as, init) => {
  const client = as === 'app' ? api.asApp() : api.asUser();

  if (init?.method === 'POST') {
    return await client.requestJira(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(init.body ?? {}),
    });
  }

  return await client.requestJira(path, { headers: { Accept: 'application/json' } });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Maps one Jira user object; returns null for anything malformed. */
export function parseJiraUser(value: unknown): JiraUser | null {
  if (!isRecord(value) || typeof value.accountId !== 'string') {
    return null;
  }

  const avatars = isRecord(value.avatarUrls) ? value.avatarUrls : {};
  const avatar = avatars['48x48'] ?? avatars['24x24'];

  return {
    accountId: value.accountId,
    displayName: typeof value.displayName === 'string' ? value.displayName : value.accountId,
    avatarUrl: typeof avatar === 'string' ? avatar : null,
    active: value.active !== false,
    accountType: typeof value.accountType === 'string' ? value.accountType : 'atlassian',
  };
}

function parseUsers(values: unknown): JiraUser[] {
  return Array.isArray(values)
    ? values.map(parseJiraUser).filter((user): user is JiraUser => user !== null)
    : [];
}

export class ForgeJiraUserApi implements JiraUserApi {
  private readonly request: JiraRequest;

  constructor(request: JiraRequest = forgeJiraRequest) {
    this.request = request;
  }

  async getUsers(accountIds: readonly string[]): Promise<readonly JiraUser[]> {
    const unique = [...new Set(accountIds)];
    const users: JiraUser[] = [];

    for (let start = 0; start < unique.length; start += BULK_CHUNK_SIZE) {
      const chunk = unique.slice(start, start + BULK_CHUNK_SIZE);
      const params = new URLSearchParams({ maxResults: String(chunk.length) });

      for (const accountId of chunk) {
        params.append('accountId', accountId);
      }

      const body = await this.getJson(route`/rest/api/3/user/bulk?${params}`, 'app', 'user/bulk');
      users.push(...parseUsers(isRecord(body) ? body.values : undefined));
    }

    return users;
  }

  async searchUsers(query: string): Promise<readonly JiraUser[]> {
    const params = new URLSearchParams({ query, maxResults: String(SEARCH_LIMIT) });
    const body = await this.getJson(route`/rest/api/3/user/search?${params}`, 'app', 'user/search');

    return parseUsers(body);
  }

  async currentUserIsAdministrator(): Promise<boolean> {
    const body = await this.getJson(
      route`/rest/api/3/mypermissions?permissions=ADMINISTER`,
      'user',
      'mypermissions',
    );
    const permissions = isRecord(body) && isRecord(body.permissions) ? body.permissions : {};
    const administer = permissions.ADMINISTER;

    return isRecord(administer) && administer.havePermission === true;
  }

  private async getJson(path: Route, as: 'app' | 'user', operation: string): Promise<unknown> {
    const response = await this.request(path, as);

    if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
      throw new JiraApiError(operation, response.status);
    }

    return await response.json();
  }
}
