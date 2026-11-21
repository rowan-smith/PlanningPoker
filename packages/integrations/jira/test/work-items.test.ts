/**
 * Contract tests for JiraWorkItemProvider, using response shapes from the Jira Cloud REST v3
 * OpenAPI spec (bulkfetch, search/jql, jql/autocompletedata, field), plus malformed and failing
 * responses.
 */
import { describe, expect, it } from 'vitest';

import type { Route } from '@forge/api';

import type { JiraRequest, JiraRequestInit } from '../src';
import {
  completionContext,
  fieldValueToText,
  JiraApiError,
  JiraWorkItemProvider,
  richTextToPlain,
} from '../src';

const noFields = { displayFieldIds: [], valueFieldIds: [] };

function issue(id: string, key: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    key,
    self: `https://acme.atlassian.net/rest/api/3/issue/${id}`,
    fields: {
      summary: `Summary ${key}`,
      issuetype: { name: 'Story' },
      status: { name: 'To Do' },
      ...fields,
    },
  };
}

interface Call {
  path: string;
  as: 'app' | 'user';
  init: JiraRequestInit | undefined;
}

function fakeJira(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const request: JiraRequest = (path: Route, as, init) => {
    const call = { path: path.value, as, init };
    calls.push(call);
    const response = handler(call);

    return Promise.resolve({ status: response.status, json: () => Promise.resolve(response.body) });
  };

  return { request, calls };
}

function provider(handler: (call: Call) => { status: number; body: unknown }) {
  const jira = fakeJira(handler);

  return { jira, provider: new JiraWorkItemProvider({ installationId: 'site-1' }, jira.request) };
}

describe('richTextToPlain', () => {
  it('flattens Atlassian Document Format into readable text', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'Goal' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ask ' },
            { type: 'mention', attrs: { text: '@Ada' } },
            { type: 'hardBreak' },
            { type: 'text', text: 'then ship' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }],
            },
          ],
        },
      ],
    };

    expect(richTextToPlain(doc)).toBe('Goal\n\nAsk @Ada\nthen ship\n\n• one\n• two');
  });

  it('accepts plain strings, keeps markup as literal text, and truncates', () => {
    expect(richTextToPlain('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
    expect(richTextToPlain('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(richTextToPlain({ type: 'doc', content: [] })).toBeNull();
    expect(richTextToPlain(null)).toBeNull();
  });

  it('turns common field values into display text', () => {
    expect(fieldValueToText({ name: 'High', id: '2' })).toBe('High');
    expect(fieldValueToText([{ value: 'a' }, 'b', null])).toBe('a, b');
    expect(fieldValueToText(8)).toBe('8');
    expect(fieldValueToText({ unexpected: true })).toBeNull();
  });
});

describe('completionContext', () => {
  it('detects a field name being typed', () => {
    expect(completionContext('project = PP AND sta')).toEqual({
      kind: 'field',
      prefix: 'project = PP AND ',
      partial: 'sta',
    });
  });

  it('detects a value being typed after an operator, with or without quotes', () => {
    expect(completionContext('project = PP AND status = "To')).toEqual({
      kind: 'value',
      prefix: 'project = PP AND status = ',
      field: 'status',
      partial: 'To',
    });
    expect(completionContext('assignee in (bob, al')).toMatchObject({
      kind: 'value',
      field: 'assignee',
      partial: 'al',
    });
  });

  it('offers nothing after keywords or spaces', () => {
    expect(completionContext('project = PP AND')).toEqual({ kind: 'none' });
    expect(completionContext('project = PP ')).toEqual({ kind: 'none' });
  });
});

describe('JiraWorkItemProvider.getItems', () => {
  it('bulk-fetches as the user and maps issues to provider-neutral references', async () => {
    const { jira, provider: jiraProvider } = provider(() => ({
      status: 200,
      body: {
        issues: [
          issue('10002', 'PP-2'),
          issue('10001', 'PP-1', {
            description: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
            },
          }),
        ],
        issueErrors: [],
      },
    }));
    const { found, missing } = await jiraProvider.getItems(['pp-1', ' PP-2 ', 'PP-1'], noFields);

    expect(missing).toEqual([]);
    expect(found.map((item) => item.reference.displayKey)).toEqual(['PP-1', 'PP-2']);
    expect(found[0]).toEqual({
      reference: {
        provider: 'jira',
        installationId: 'site-1',
        itemId: '10001',
        displayKey: 'PP-1',
        url: 'https://acme.atlassian.net/browse/PP-1',
      },
      snapshot: {
        title: 'Summary PP-1',
        description: 'Hi',
        itemType: 'Story',
        status: 'To Do',
        displayFields: {},
        fieldValues: {},
      },
    });
    expect(jira.calls).toHaveLength(1);
    expect(jira.calls[0]).toMatchObject({
      path: '/rest/api/3/issue/bulkfetch',
      as: 'user',
      init: {
        method: 'POST',
        body: {
          issueIdsOrKeys: ['PP-1', 'PP-2'],
          fields: ['summary', 'description', 'issuetype', 'status'],
        },
      },
    });
  });

  it('reports keys Jira silently omitted and keys that are malformed', async () => {
    const { jira, provider: jiraProvider } = provider(() => ({
      status: 200,
      body: { issues: [issue('1', 'PP-1')], issueErrors: [] },
    }));
    const { missing } = await jiraProvider.getItems(
      ['PP-1', 'PP-404', 'not a key', 'PP-0'],
      noFields,
    );

    expect(missing).toEqual(['PP-404', 'NOT A KEY', 'PP-0']);
    expect(jira.calls[0]?.init?.body).toMatchObject({ issueIdsOrKeys: ['PP-1', 'PP-404'] });
  });

  it('splits large imports into requests of 100', async () => {
    const { jira, provider: jiraProvider } = provider(() => ({
      status: 200,
      body: { issues: [] },
    }));
    const keys = Array.from({ length: 150 }, (_, index) => `PP-${String(index + 1)}`);
    await jiraProvider.getItems(keys, noFields);

    expect(jira.calls).toHaveLength(2);
  });

  it('captures display fields by name and raw values of writable fields', async () => {
    const { provider: jiraProvider } = provider((call) =>
      call.path === '/rest/api/3/field'
        ? {
            status: 200,
            body: [
              { id: 'priority', name: 'Priority', schema: { type: 'priority' } },
              { id: 'customfield_1', name: 'Story points', schema: { type: 'number' } },
            ],
          }
        : {
            status: 200,
            body: {
              issues: [issue('1', 'PP-1', { priority: { name: 'High' }, customfield_1: 5 })],
            },
          },
    );
    const { found } = await jiraProvider.getItems(['PP-1'], {
      displayFieldIds: ['priority'],
      valueFieldIds: ['customfield_1'],
    });

    expect(found[0]?.snapshot.displayFields).toEqual({ Priority: 'High' });
    expect(found[0]?.snapshot.fieldValues).toEqual({ customfield_1: 5 });
  });

  it('skips malformed issues instead of failing the import', async () => {
    const { provider: jiraProvider } = provider(() => ({
      status: 200,
      body: { issues: [issue('1', 'PP-1'), { key: 'PP-2' }, null, { id: 3, key: 'PP-3' }] },
    }));
    const { found, missing } = await jiraProvider.getItems(['PP-1', 'PP-2', 'PP-3'], noFields);

    expect(found.map((item) => item.reference.displayKey)).toEqual(['PP-1']);
    expect(missing).toEqual(['PP-2', 'PP-3']);
  });

  it('raises JiraApiError for server failures', async () => {
    const { provider: jiraProvider } = provider(() => ({ status: 503, body: {} }));

    await expect(jiraProvider.getItems(['PP-1'], noFields)).rejects.toBeInstanceOf(JiraApiError);
  });
});

describe('JiraWorkItemProvider.search', () => {
  it('pages with nextPageToken and stops on the last page', async () => {
    const { jira, provider: jiraProvider } = provider((call) => {
      const token = (call.init?.body as { nextPageToken?: string }).nextPageToken;

      return token === undefined
        ? {
            status: 200,
            body: { issues: [issue('1', 'PP-1')], nextPageToken: 'abc', isLast: false },
          }
        : { status: 200, body: { issues: [issue('2', 'PP-2')], isLast: true } };
    });
    const first = await jiraProvider.search('project = PP', null, noFields);
    const second = await jiraProvider.search('project = PP', first.nextCursor, noFields);

    expect(first.nextCursor).toBe('abc');
    expect(second.nextCursor).toBeNull();
    expect(jira.calls[0]).toMatchObject({
      path: '/rest/api/3/search/jql',
      as: 'user',
      init: { method: 'POST', body: { jql: 'project = PP', maxResults: 25 } },
    });
  });

  it("explains invalid JQL with Jira's own message", async () => {
    const { provider: jiraProvider } = provider(() => ({
      status: 400,
      body: { errorMessages: ["Field 'sprintz' does not exist or you do not have permission."] },
    }));

    await expect(jiraProvider.search('sprintz = 1', null, noFields)).rejects.toMatchObject({
      code: 'VALIDATION',
      message:
        "Jira could not run this query: Field 'sprintz' does not exist or you do not have permission.",
    });
  });

  it('falls back to a generic message when the 400 body is unreadable', async () => {
    const { provider: jiraProvider } = provider(() => ({ status: 400, body: 'nope' }));

    await expect(jiraProvider.search('x', null, noFields)).rejects.toMatchObject({
      message: 'Jira could not run this query. Check the JQL.',
    });
  });
});

describe('JiraWorkItemProvider.suggestQuery', () => {
  const autocomplete = {
    visibleFieldNames: [
      { value: 'status', displayName: 'Status' },
      { value: 'statusCategory', displayName: 'Status Category' },
      { value: 'project', displayName: 'Project' },
    ],
  };

  it('completes field names from autocompletedata, loaded once', async () => {
    const { jira, provider: jiraProvider } = provider(() => ({ status: 200, body: autocomplete }));
    const suggestions = await jiraProvider.suggestQuery('project = PP AND sta');
    await jiraProvider.suggestQuery('pro');

    expect(suggestions).toEqual([
      { value: 'project = PP AND status ', displayName: 'Status' },
      { value: 'project = PP AND statusCategory ', displayName: 'Status Category' },
    ]);
    expect(
      jira.calls.filter((call) => call.path === '/rest/api/3/jql/autocompletedata'),
    ).toHaveLength(1);
  });

  it('completes values, quoting ones with spaces and stripping highlight tags', async () => {
    const { jira, provider: jiraProvider } = provider(() => ({
      status: 200,
      body: {
        results: [
          { value: 'To Do', displayName: '<b>To</b> Do' },
          { value: 'Done', displayName: 'Done' },
        ],
      },
    }));
    const suggestions = await jiraProvider.suggestQuery('status = "To');

    expect(suggestions).toEqual([
      { value: 'status = "To Do"', displayName: 'To Do' },
      { value: 'status = Done', displayName: 'Done' },
    ]);
    expect(jira.calls[0]?.path).toBe(
      '/rest/api/3/jql/autocompletedata/suggestions?fieldName=status&fieldValue=To',
    );
  });
});

describe('JiraWorkItemProvider.discoverFields', () => {
  it('classifies number and option fields and ignores malformed entries', async () => {
    const { provider: jiraProvider } = provider(() => ({
      status: 200,
      body: [
        { id: 'customfield_1', name: 'Story points', schema: { type: 'number' } },
        { id: 'customfield_2', name: 'Size', schema: { type: 'option' } },
        { id: 'summary', name: 'Summary', schema: { type: 'string' } },
        { name: 'No id' },
      ],
    }));

    expect((await jiraProvider.discoverFields()).map((f) => [f.fieldId, f.valueType])).toEqual([
      ['customfield_1', 'number'],
      ['customfield_2', 'option'],
      ['summary', 'unsupported'],
    ]);
  });

  it('does not write estimates yet', async () => {
    const { provider: jiraProvider } = provider(() => ({ status: 200, body: {} }));

    await expect(jiraProvider.update()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});
