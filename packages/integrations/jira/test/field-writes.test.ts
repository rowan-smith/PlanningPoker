/**
 * Contract tests for writing estimates back to Jira (Milestone 7). Response shapes follow the
 * Jira Cloud REST v3 OpenAPI spec: `IssueUpdateMetadata` from GET /issue/{id}/editmeta,
 * `IssueBean` from GET /issue/{id}?fields=…, 204 / `ErrorCollection` from PUT /issue/{id}.
 */
import { describe, expect, it } from 'vitest';

import type { Route } from '@forge/api';
import type { WorkItemUpdateRequest } from '@planning-poker/application';
import type { WorkItemReference } from '@planning-poker/domain';

import type { JiraRequest, JiraRequestInit } from '../src';
import { JiraWorkItemProvider } from '../src';

const STORY_POINTS = 'customfield_10016';
const SIZE = 'customfield_10020';

interface Call {
  path: string;
  as: 'app' | 'user';
  init: JiraRequestInit | undefined;
}

interface Reply {
  status: number;
  body?: unknown;
}

/** The message of a non-ok result, for pattern assertions. */
function messageOf(result: { status: string; message?: string }): string {
  return result.message ?? '';
}

const FIELDS: Reply = {
  status: 200,
  body: [
    { id: STORY_POINTS, name: 'Story points', schema: { type: 'number' } },
    { id: SIZE, name: 'T-shirt size', schema: { type: 'option' } },
  ],
};

function editMeta(fields: Record<string, unknown>): Reply {
  return { status: 200, body: { fields } };
}

const NUMBER_META = {
  required: false,
  schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' },
  name: 'Story points',
  key: STORY_POINTS,
  operations: ['set'],
};

function optionMeta(values: readonly string[]) {
  return {
    required: false,
    schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
    name: 'T-shirt size',
    key: SIZE,
    operations: ['set'],
    allowedValues: values.map((value, index) => ({
      self: `https://acme.atlassian.net/rest/api/3/customFieldOption/${String(100 + index)}`,
      value,
      id: String(100 + index),
    })),
  };
}

function issueValue(fieldId: string, value: unknown): Reply {
  return { status: 200, body: { id: '10001', key: 'PP-1', fields: { [fieldId]: value } } };
}

/** Routes each request by path; unmatched paths fail loudly so tests notice extra calls. */
function fakeJira(routes: {
  editmeta?: Reply | ((itemId: string) => Reply);
  issue?: Reply;
  put?: Reply;
}) {
  const calls: Call[] = [];
  const request: JiraRequest = (path: Route, as, init) => {
    const call = { path: path.value, as, init };
    calls.push(call);
    let reply: Reply | undefined;

    if (call.path === '/rest/api/3/field') {
      reply = FIELDS;
    } else if (call.path.endsWith('/editmeta')) {
      const itemId = call.path.split('/')[5] ?? '';
      reply = typeof routes.editmeta === 'function' ? routes.editmeta(itemId) : routes.editmeta;
    } else if (init?.method === 'PUT') {
      reply = routes.put;
    } else if (call.path.startsWith('/rest/api/3/issue/')) {
      reply = routes.issue;
    }

    if (reply === undefined) {
      return Promise.reject(new Error(`Unexpected request ${call.path}`));
    }

    const body = reply.body;

    return Promise.resolve({
      status: reply.status,
      json: () =>
        body === undefined ? Promise.reject(new Error('No body')) : Promise.resolve(body),
    });
  };

  return {
    calls,
    provider: new JiraWorkItemProvider({ installationId: 'site-1' }, request),
  };
}

function reference(itemId = '10001', displayKey = 'PP-1'): WorkItemReference {
  return { provider: 'jira', installationId: 'site-1', itemId, displayKey, url: null };
}

function request(overrides: Partial<WorkItemUpdateRequest> = {}): WorkItemUpdateRequest {
  return {
    reference: reference(),
    fieldId: STORY_POINTS,
    value: 5,
    expectedCurrentValue: null,
    idempotencyKey: 'ticket-1:round-1',
    ...overrides,
  };
}

describe('conflict baseline at import', () => {
  it('captures numbers as-is and single-select options by value', async () => {
    const calls: string[] = [];
    const jira = new JiraWorkItemProvider({ installationId: 'site-1' }, (path: Route) => {
      calls.push(path.value);
      const body = {
        issues: [
          {
            id: '10001',
            key: 'PP-1',
            fields: {
              summary: 'Sign in',
              [STORY_POINTS]: 3,
              [SIZE]: { self: 'x', value: 'M', id: '101' },
            },
          },
        ],
      };

      return Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
    });
    const { found } = await jira.getItems(['PP-1'], {
      displayFieldIds: [],
      valueFieldIds: [STORY_POINTS, SIZE],
    });

    expect(found[0]?.snapshot.fieldValues).toEqual({ [STORY_POINTS]: 3, [SIZE]: 'M' });
    expect(calls).toEqual(['/rest/api/3/issue/bulkfetch']);
  });
});

describe('JiraWorkItemProvider.listFieldOptions', () => {
  it('collects allowed values from each issue’s editmeta as the user, unique by value', async () => {
    const jira = fakeJira({
      editmeta: (itemId) =>
        itemId === '10001'
          ? editMeta({ [SIZE]: optionMeta(['S', 'M']) })
          : editMeta({ [SIZE]: optionMeta(['M', 'L']) }),
    });
    const options = await jira.provider.listFieldOptions(SIZE, [
      reference('10001', 'PP-1'),
      reference('10002', 'PP-2'),
    ]);

    expect(options.map((option) => option.value)).toEqual(['S', 'M', 'L']);
    expect(jira.calls.every((call) => call.as === 'user')).toBe(true);
    expect(jira.calls[0]?.path).toBe('/rest/api/3/issue/10001/editmeta');
  });

  it('skips issues the user cannot see and malformed option entries', async () => {
    const jira = fakeJira({
      editmeta: (itemId) =>
        itemId === '10001'
          ? { status: 404, body: { errorMessages: ['Issue does not exist'] } }
          : editMeta({
              [SIZE]: { ...optionMeta(['XL']), allowedValues: [{ value: 'XL', id: '7' }, 'bad'] },
            }),
    });

    expect(
      await jira.provider.listFieldOptions(SIZE, [reference('10001'), reference('10002')]),
    ).toEqual([{ id: '7', value: 'XL' }]);
  });

  it('returns nothing without tickets', async () => {
    const jira = fakeJira({});

    expect(await jira.provider.listFieldOptions(SIZE, [])).toEqual([]);
    expect(jira.calls).toHaveLength(0);
  });
});

describe('JiraWorkItemProvider.validateUpdate', () => {
  it('accepts an editable number field whose value is unchanged since import', async () => {
    const jira = fakeJira({
      editmeta: editMeta({ [STORY_POINTS]: NUMBER_META }),
      issue: issueValue(STORY_POINTS, null),
    });

    expect(await jira.provider.validateUpdate(request())).toEqual({ status: 'ok' });
    expect(jira.calls.map((call) => call.path)).toContain(
      `/rest/api/3/issue/10001?fields=${STORY_POINTS}`,
    );
    expect(jira.calls.every((call) => call.as === 'user')).toBe(true);
  });

  it('reports a conflict when the value changed in Jira since import', async () => {
    const jira = fakeJira({
      editmeta: editMeta({ [STORY_POINTS]: NUMBER_META }),
      issue: issueValue(STORY_POINTS, 13),
    });
    const result = await jira.provider.validateUpdate(request({ expectedCurrentValue: 3 }));

    expect(result).toMatchObject({ status: 'conflict' });
    expect(messageOf(result)).toMatch(/Story points.*“13”.*“3”/);
  });

  it('overwrites a changed value once confirmed (expectedCurrentValue undefined)', async () => {
    const jira = fakeJira({
      editmeta: editMeta({ [STORY_POINTS]: NUMBER_META }),
      issue: issueValue(STORY_POINTS, 13),
    });

    expect(
      await jira.provider.validateUpdate(request({ expectedCurrentValue: undefined })),
    ).toEqual({ status: 'ok' });
  });

  it('treats a field that already holds the value as written (idempotent retry)', async () => {
    const jira = fakeJira({
      editmeta: editMeta({ [STORY_POINTS]: NUMBER_META }),
      issue: issueValue(STORY_POINTS, 5),
    });

    expect(await jira.provider.validateUpdate(request({ expectedCurrentValue: 2 }))).toEqual({
      status: 'ok',
    });
  });

  it('compares single-select fields by option value and rejects unknown options', async () => {
    const jira = fakeJira({
      editmeta: editMeta({ [SIZE]: optionMeta(['S', 'M', 'L']) }),
      issue: issueValue(SIZE, { self: 'x', value: 'S', id: '100' }),
    });

    expect(
      await jira.provider.validateUpdate(
        request({ fieldId: SIZE, value: 'M', expectedCurrentValue: 'S' }),
      ),
    ).toEqual({ status: 'ok' });
    const unknown = await jira.provider.validateUpdate(
      request({ fieldId: SIZE, value: 'XXL', expectedCurrentValue: 'S' }),
    );

    expect(unknown.status).toBe('invalid');
    expect(messageOf(unknown)).toMatch(/XXL.*T-shirt size/);
  });

  it('is forbidden when editmeta lists no editable fields (no Edit issues permission)', async () => {
    const jira = fakeJira({ editmeta: editMeta({}) });

    expect(await jira.provider.validateUpdate(request())).toMatchObject({ status: 'forbidden' });
  });

  it('is invalid when the field is not editable on the issue', async () => {
    const jira = fakeJira({ editmeta: editMeta({ summary: { ...NUMBER_META, key: 'summary' } }) });

    const result = await jira.provider.validateUpdate(request());

    expect(result.status).toBe('invalid');
    expect(messageOf(result)).toMatch(/Story points can't be edited on PP-1/);
  });

  it.each([
    [401, 'forbidden'],
    [403, 'forbidden'],
    [404, 'invalid'],
    [429, 'failed'],
    [503, 'failed'],
  ] as const)('maps HTTP %i from editmeta to %s', async (status, expected) => {
    const jira = fakeJira({ editmeta: { status, body: { errorMessages: ['secret detail'] } } });
    const result = await jira.provider.validateUpdate(request());

    expect(result.status).toBe(expected);
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });

  it('maps a failing current-value read', async () => {
    const jira = fakeJira({
      editmeta: editMeta({ [STORY_POINTS]: NUMBER_META }),
      issue: { status: 429 },
    });

    const result = await jira.provider.validateUpdate(request());

    expect(result.status).toBe('failed');
    expect(messageOf(result)).toMatch(/rate limiting/);
  });
});

describe('JiraWorkItemProvider.update', () => {
  it('PUTs a number as the user and succeeds on 204', async () => {
    const jira = fakeJira({ put: { status: 204 } });

    expect(await jira.provider.update(request())).toEqual({ status: 'succeeded' });
    const put = jira.calls.find((call) => call.init?.method === 'PUT');
    expect(put).toMatchObject({
      path: '/rest/api/3/issue/10001',
      as: 'user',
      init: { method: 'PUT', body: { fields: { [STORY_POINTS]: 5 } } },
    });
  });

  it('writes single-select fields by option value', async () => {
    const jira = fakeJira({ put: { status: 204 } });
    await jira.provider.update(request({ fieldId: SIZE, value: 'M' }));

    expect(jira.calls.find((call) => call.init?.method === 'PUT')?.init?.body).toEqual({
      fields: { [SIZE]: { value: 'M' } },
    });
  });

  it("reports Jira's field error for an invalid value (400 ErrorCollection)", async () => {
    const jira = fakeJira({
      put: {
        status: 400,
        body: { errorMessages: [], errors: { [STORY_POINTS]: 'Number value expected.' } },
      },
    });

    expect(await jira.provider.update(request())).toEqual({
      status: 'failed',
      message: 'Jira rejected the value for PP-1: Number value expected.',
    });
  });

  it('copes with an unreadable 400 body', async () => {
    const jira = fakeJira({ put: { status: 400 } });

    expect(await jira.provider.update(request())).toEqual({
      status: 'failed',
      message: 'Jira rejected the value for PP-1.',
    });
  });

  it.each([
    [403, /permission/],
    [404, /not found/],
    [409, /edited at the same time/],
    [422, /configuration problem/],
    [429, /rate limiting/],
    [500, /unavailable/],
  ] as const)('maps HTTP %i to a retryable failure', async (status, message) => {
    const jira = fakeJira({ put: { status, body: { errorMessages: ['token=abc'] } } });
    const result = await jira.provider.update(request());

    expect(result.status).toBe('failed');
    expect(messageOf(result)).toMatch(message);
    expect(JSON.stringify(result)).not.toContain('token=abc');
  });
});
