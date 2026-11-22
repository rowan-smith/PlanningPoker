/**
 * An in-memory Jira Cloud site behind the adapters' injectable `JiraRequest`. Response bodies
 * follow the Jira Cloud REST v3 OpenAPI shapes the adapters read: `User` (/user/bulk →
 * `PageBeanUser`, /user/search → `User[]`), `Permissions` (/mypermissions), `BulkIssueResults`
 * (/issue/bulkfetch), `SearchAndReconcileResults` (/search/jql), `FieldDetails[]` (/field),
 * `IssueUpdateMetadata` (/issue/{id}/editmeta), `IssueBean` (/issue/{id}) and 204 /
 * `ErrorCollection` (PUT /issue/{id}). Permissions are per user: who can browse and who can edit
 * each issue, and who is a Jira administrator.
 */
import type { Route } from '@forge/api';
import type { JiraRequest, JiraRequestInit, JiraResponse } from '@planning-poker/integration-jira';

export const STORY_POINTS = 'customfield_10016';
export const SITE = 'https://acme.atlassian.net';

export interface FakeJiraUser {
  readonly accountId: string;
  readonly displayName: string;
  readonly administrator?: boolean;
}

export interface FakeIssue {
  readonly id: string;
  readonly key: string;
  readonly summary: string;
  /** Atlassian Document Format, as Jira returns it. */
  readonly description: unknown;
  /** Account IDs that may browse the issue; `all` for everyone. */
  readonly browsers: readonly string[] | 'all';
  /** Account IDs that may edit the issue. */
  readonly editors: readonly string[];
  readonly fields: Record<string, unknown>;
}

export interface RecordedCall {
  readonly accountId: string;
  readonly as: 'app' | 'user';
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;

function reply(status: number, body?: unknown): JiraResponse {
  return {
    status,
    json: () =>
      body === undefined ? Promise.reject(new Error('No content')) : Promise.resolve(body),
  };
}

function userBody(user: FakeJiraUser) {
  return {
    self: `${SITE}/rest/api/3/user?accountId=${user.accountId}`,
    accountId: user.accountId,
    accountType: 'atlassian',
    displayName: user.displayName,
    active: true,
    avatarUrls: { '48x48': `${SITE}/avatar/${user.accountId}.png` },
  };
}

export class FakeJira {
  readonly users = new Map<string, FakeJiraUser>();
  readonly issues = new Map<string, FakeIssue>();
  readonly calls: RecordedCall[] = [];
  /** HTTP statuses (with ErrorCollection bodies) for the next PUTs, in order. */
  readonly putFailures: number[] = [];

  addUser(user: FakeJiraUser): void {
    this.users.set(user.accountId, user);
  }

  addIssue(issue: FakeIssue): void {
    this.issues.set(issue.id, issue);
  }

  /** Someone edits the issue in Jira. */
  setField(issueId: string, fieldId: string, value: unknown): void {
    const issue = this.issues.get(issueId);

    if (issue !== undefined) {
      issue.fields[fieldId] = value;
    }
  }

  /** The request function an adapter uses for one signed-in user (Forge's `asUser`). */
  requestFor(accountId: string | undefined): JiraRequest {
    return (path: Route, as, init) => {
      const caller = accountId ?? 'anonymous';
      const url = new URL(path.value, SITE);
      this.calls.push({
        accountId: caller,
        as,
        method: init?.method ?? 'GET',
        path: path.value,
        body: init?.body,
      });

      return Promise.resolve(this.route(url, as, caller, init));
    };
  }

  private canBrowse(issue: FakeIssue, accountId: string): boolean {
    return issue.browsers === 'all' || issue.browsers.includes(accountId);
  }

  private issueBody(issue: FakeIssue, fields: readonly string[]) {
    const all: Record<string, unknown> = {
      summary: issue.summary,
      description: issue.description,
      issuetype: { id: '10001', name: 'Story' },
      status: { id: '1', name: 'To Do' },
      ...issue.fields,
    };

    return {
      id: issue.id,
      key: issue.key,
      self: `${SITE}/rest/api/3/issue/${issue.id}`,
      fields: Object.fromEntries(
        fields.filter((name) => name in all).map((name) => [name, all[name]]),
      ),
    };
  }

  private route(
    url: URL,
    as: 'app' | 'user',
    caller: string,
    init?: JiraRequestInit,
  ): JiraResponse {
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = (init?.body ?? {}) as Record<string, unknown>;

    if (path === '/rest/api/3/user/bulk') {
      const ids = url.searchParams.getAll('accountId');
      const values = ids.flatMap((id) => {
        const user = this.users.get(id);

        return user === undefined ? [] : [userBody(user)];
      });

      return reply(HTTP_OK, {
        isLast: true,
        maxResults: ids.length,
        startAt: 0,
        total: values.length,
        values,
      });
    }

    if (path === '/rest/api/3/user/search') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();

      return reply(
        HTTP_OK,
        [...this.users.values()]
          .filter((user) => user.displayName.toLowerCase().includes(query))
          .map(userBody),
      );
    }

    if (path === '/rest/api/3/mypermissions') {
      const administrator = as === 'user' && this.users.get(caller)?.administrator === true;

      return reply(HTTP_OK, {
        permissions: {
          ADMINISTER: { id: '0', key: 'ADMINISTER', type: 'GLOBAL', havePermission: administrator },
        },
      });
    }

    if (path === '/rest/api/3/jql/autocompletedata') {
      return reply(HTTP_OK, {
        visibleFieldNames: [
          { value: 'project', displayName: 'project', operators: ['=', '!='] },
          { value: 'status', displayName: 'status', operators: ['=', '!='] },
        ],
        visibleFunctionNames: [],
        jqlReservedWords: ['and', 'or', 'order', 'by'],
      });
    }

    if (path === '/rest/api/3/jql/autocompletedata/suggestions') {
      return reply(HTTP_OK, {
        results: [{ value: 'PP', displayName: '<b>P</b>lanning <b>P</b>oker (PP)' }],
      });
    }

    if (path === '/rest/api/3/field') {
      return reply(HTTP_OK, [
        { id: 'summary', name: 'Summary', schema: { type: 'string', system: 'summary' } },
        {
          id: STORY_POINTS,
          name: 'Story points',
          custom: true,
          schema: {
            type: 'number',
            custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
          },
        },
        {
          id: 'labels',
          name: 'Labels',
          schema: { type: 'array', items: 'string', system: 'labels' },
        },
      ]);
    }

    if (path === '/rest/api/3/issue/bulkfetch' && method === 'POST') {
      const wanted = Array.isArray(body.issueIdsOrKeys) ? (body.issueIdsOrKeys as string[]) : [];
      const fields = Array.isArray(body.fields) ? (body.fields as string[]) : [];
      const issues = wanted.flatMap((idOrKey) => {
        const issue = [...this.issues.values()].find(
          (candidate) => candidate.id === idOrKey || candidate.key === idOrKey.toUpperCase(),
        );

        return issue !== undefined && this.canBrowse(issue, caller)
          ? [this.issueBody(issue, fields)]
          : [];
      });

      return reply(HTTP_OK, { expand: 'schema,names', issues, issueErrors: [] });
    }

    if (path === '/rest/api/3/search/jql' && method === 'POST') {
      const jql = typeof body.jql === 'string' ? body.jql : '';
      const fields = Array.isArray(body.fields) ? (body.fields as string[]) : [];
      const project = /project\s*=\s*"?(\w+)"?/i.exec(jql)?.[1]?.toUpperCase();
      const issues = [...this.issues.values()]
        .filter((issue) => this.canBrowse(issue, caller))
        .filter((issue) => project === undefined || issue.key.startsWith(`${project}-`))
        .map((issue) => this.issueBody(issue, fields));

      return reply(HTTP_OK, { issues, isLast: true });
    }

    const match = /^\/rest\/api\/3\/issue\/([^/]+)(\/editmeta)?$/.exec(path);
    const issue = match?.[1] === undefined ? undefined : this.issues.get(match[1]);

    if (match === null || issue === undefined || !this.canBrowse(issue, caller)) {
      return reply(HTTP_NOT_FOUND, {
        errorMessages: ['Issue does not exist or you do not have permission to see it.'],
        errors: {},
      });
    }

    if (match[2] === '/editmeta') {
      const editable = issue.editors.includes(caller);

      return reply(HTTP_OK, {
        fields: editable
          ? {
              [STORY_POINTS]: {
                required: false,
                schema: {
                  type: 'number',
                  custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float',
                },
                name: 'Story points',
                key: STORY_POINTS,
                operations: ['set'],
              },
            }
          : {},
      });
    }

    if (method === 'PUT') {
      const failure = this.putFailures.shift();

      if (failure !== undefined) {
        // Error bodies can echo request details; the adapters must never log them.
        return reply(failure, {
          errorMessages: ['Internal failure. Request token=SECRET-TOKEN-123'],
          errors: {},
        });
      }

      const fields = (body.fields ?? {}) as Record<string, unknown>;

      for (const [fieldId, value] of Object.entries(fields)) {
        issue.fields[fieldId] = value;
      }

      return reply(HTTP_NO_CONTENT);
    }

    const requested = (url.searchParams.get('fields') ?? '')
      .split(',')
      .filter((name) => name !== '');

    return reply(HTTP_OK, this.issueBody(issue, requested));
  }
}

/** A short ADF document, as Jira returns descriptions. */
export function adf(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}
