import { route } from '@forge/api';
import type { Route } from '@forge/api';
import type {
  ExternalField,
  ImportedWorkItem,
  QuerySuggestion,
  UpdateResult,
  UpdateValidation,
  WorkItemFieldSelection,
  WorkItemProvider,
  WorkItemSearchPage,
} from '@planning-poker/application';
import type { FieldValue } from '@planning-poker/domain';
import { DomainError } from '@planning-poker/domain';

import { fieldValueToText, richTextToPlain } from './adf';
import type { JqlField } from './jql-autocomplete';
import {
  completionContext,
  fieldCompletions,
  stripTags,
  valueCompletions,
} from './jql-autocomplete';
import type { JiraRequest, JiraRequestInit } from './jira-user-api';
import { forgeJiraRequest, JiraApiError } from './jira-user-api';

export const JIRA_PROVIDER = 'jira';

/** Jira's documented limit for POST /issue/bulkfetch when listing fields. */
const BULK_FETCH_LIMIT = 100;
const SEARCH_PAGE_SIZE = 25;
const MAX_ERROR_LENGTH = 300;
const HTTP_BAD_REQUEST = 400;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;
const CORE_FIELDS = ['summary', 'description', 'issuetype', 'status'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function namedField(value: unknown): string | null {
  return isRecord(value) ? stringField(value.name) : null;
}

/** Raw value captured for writable fields, used later to detect changes made in Jira. */
function rawFieldValue(value: unknown): FieldValue | null {
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }

  return isRecord(value) && typeof value.id === 'string' ? value.id : null;
}

function issueUrl(self: unknown, key: string): string | null {
  if (typeof self !== 'string') {
    return null;
  }

  try {
    return `${new URL(self).origin}/browse/${encodeURIComponent(key)}`;
  } catch {
    // A malformed `self` only costs the link; the ticket is still imported.
    return null;
  }
}

export interface JiraWorkItemContext {
  /** Identifies the Jira site (the Forge installation) in provider-neutral references. */
  readonly installationId: string;
}

/**
 * Imports Jira issues as the calling user, so Jira's own issue permissions decide what can be
 * imported. Writing estimates back arrives in Milestone 7.
 */
export class JiraWorkItemProvider implements WorkItemProvider {
  readonly providerId = JIRA_PROVIDER;
  private readonly context: JiraWorkItemContext;
  private readonly request: JiraRequest;
  private fields: Promise<readonly ExternalField[]> | null = null;
  private jqlFields: Promise<readonly JqlField[]> | null = null;

  constructor(context: JiraWorkItemContext, request: JiraRequest = forgeJiraRequest) {
    this.context = context;
    this.request = request;
  }

  async getItems(
    keys: readonly string[],
    selection: WorkItemFieldSelection,
  ): Promise<{ readonly found: readonly ImportedWorkItem[]; readonly missing: readonly string[] }> {
    const normalized = [...new Set(keys.map((key) => key.trim().toUpperCase()))];
    const valid = normalized.filter((key) => ISSUE_KEY.test(key));
    const names = await this.fieldNames(selection);
    const found: ImportedWorkItem[] = [];

    for (let start = 0; start < valid.length; start += BULK_FETCH_LIMIT) {
      const body = await this.json(route`/rest/api/3/issue/bulkfetch`, 'bulkfetch', {
        method: 'POST',
        body: {
          issueIdsOrKeys: valid.slice(start, start + BULK_FETCH_LIMIT),
          fields: this.fieldList(selection),
        },
      });
      found.push(...this.mapIssues(isRecord(body) ? body.issues : undefined, selection, names));
    }

    // Jira omits issues that do not exist or that the user cannot see, without an error.
    const returned = new Set(found.map((item) => item.reference.displayKey.toUpperCase()));
    const order = new Map(valid.map((key, index) => [key, index]));

    return {
      found: found.sort(
        (a, b) =>
          (order.get(a.reference.displayKey.toUpperCase()) ?? 0) -
          (order.get(b.reference.displayKey.toUpperCase()) ?? 0),
      ),
      missing: normalized.filter((key) => !returned.has(key)),
    };
  }

  async search(
    query: string,
    cursor: string | null,
    selection: WorkItemFieldSelection,
  ): Promise<WorkItemSearchPage> {
    const names = await this.fieldNames(selection);
    const response = await this.request(route`/rest/api/3/search/jql`, 'user', {
      method: 'POST',
      body: {
        jql: query,
        maxResults: SEARCH_PAGE_SIZE,
        fields: this.fieldList(selection),
        ...(cursor === null ? {} : { nextPageToken: cursor }),
      },
    });

    if (response.status === HTTP_BAD_REQUEST) {
      throw new DomainError('VALIDATION', await this.jqlErrorMessage(response.json()));
    }

    const body = await this.checked(response, 'search/jql');
    const items = this.mapIssues(isRecord(body) ? body.issues : undefined, selection, names);
    const token = isRecord(body) ? stringField(body.nextPageToken) : null;
    const isLast = isRecord(body) && body.isLast === true;

    return { items, nextCursor: isLast ? null : token };
  }

  async suggestQuery(partialQuery: string): Promise<readonly QuerySuggestion[]> {
    const context = completionContext(partialQuery);

    if (context.kind === 'field') {
      return fieldCompletions(context, await this.jqlFieldNames());
    }

    if (context.kind === 'value') {
      const params = new URLSearchParams({ fieldName: context.field, fieldValue: context.partial });
      const body = await this.json(
        route`/rest/api/3/jql/autocompletedata/suggestions?${params}`,
        'jql suggestions',
      );
      const results = isRecord(body) && Array.isArray(body.results) ? body.results : [];

      return valueCompletions(
        context,
        results.flatMap((entry: unknown) => {
          const value = isRecord(entry) ? stringField(entry.value) : null;

          return value === null || !isRecord(entry)
            ? []
            : [{ value, displayName: stringField(entry.displayName) ?? value }];
        }),
      );
    }

    return [];
  }

  async discoverFields(): Promise<readonly ExternalField[]> {
    this.fields ??= this.loadFields();

    return await this.fields;
  }

  validateUpdate(): Promise<UpdateValidation> {
    return Promise.reject(notYetWritable());
  }

  update(): Promise<UpdateResult> {
    return Promise.reject(notYetWritable());
  }

  // -------------------------------------------------------------------------------------------

  private fieldList(selection: WorkItemFieldSelection): string[] {
    return [...new Set([...CORE_FIELDS, ...selection.displayFieldIds, ...selection.valueFieldIds])];
  }

  private async fieldNames(
    selection: WorkItemFieldSelection,
  ): Promise<ReadonlyMap<string, string>> {
    if (selection.displayFieldIds.length === 0) {
      return new Map();
    }

    const fields = await this.discoverFields();

    return new Map(fields.map((field) => [field.fieldId, field.name]));
  }

  private mapIssues(
    issues: unknown,
    selection: WorkItemFieldSelection,
    names: ReadonlyMap<string, string>,
  ): ImportedWorkItem[] {
    if (!Array.isArray(issues)) {
      return [];
    }

    return issues.flatMap((issue: unknown) => {
      const item = this.mapIssue(issue, selection, names);

      return item === null ? [] : [item];
    });
  }

  /** Maps one issue; returns null for anything malformed rather than failing the whole import. */
  private mapIssue(
    issue: unknown,
    selection: WorkItemFieldSelection,
    names: ReadonlyMap<string, string>,
  ): ImportedWorkItem | null {
    if (!isRecord(issue) || typeof issue.id !== 'string' || typeof issue.key !== 'string') {
      return null;
    }

    const fields = isRecord(issue.fields) ? issue.fields : {};
    const displayFields: Record<string, string> = {};

    for (const fieldId of selection.displayFieldIds) {
      const text = fieldValueToText(fields[fieldId]);

      if (text !== null) {
        displayFields[names.get(fieldId) ?? fieldId] = text;
      }
    }

    return {
      reference: {
        provider: JIRA_PROVIDER,
        installationId: this.context.installationId,
        itemId: issue.id,
        displayKey: issue.key,
        url: issueUrl(issue.self, issue.key),
      },
      snapshot: {
        title: stringField(fields.summary) ?? issue.key,
        description: richTextToPlain(fields.description),
        itemType: namedField(fields.issuetype),
        status: namedField(fields.status),
        displayFields,
        fieldValues: Object.fromEntries(
          selection.valueFieldIds.map((fieldId) => [fieldId, rawFieldValue(fields[fieldId])]),
        ),
      },
    };
  }

  private async loadFields(): Promise<readonly ExternalField[]> {
    const body = await this.json(route`/rest/api/3/field`, 'field');

    if (!Array.isArray(body)) {
      return [];
    }

    return body.flatMap((entry: unknown): ExternalField[] => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string') {
        return [];
      }

      const type = isRecord(entry.schema) ? entry.schema.type : undefined;
      let valueType: ExternalField['valueType'] = 'unsupported';

      if (type === 'number') {
        valueType = 'number';
      } else if (type === 'option') {
        valueType = 'option';
      }

      return [{ fieldId: entry.id, name: entry.name, valueType, options: [] }];
    });
  }

  private async jqlFieldNames(): Promise<readonly JqlField[]> {
    this.jqlFields ??= this.json(route`/rest/api/3/jql/autocompletedata`, 'jql autocomplete').then(
      (body) => {
        const fields =
          isRecord(body) && Array.isArray(body.visibleFieldNames) ? body.visibleFieldNames : [];

        return fields.flatMap((entry: unknown): JqlField[] => {
          const value = isRecord(entry) ? stringField(entry.value) : null;

          return value === null || !isRecord(entry)
            ? []
            : [{ value, displayName: stripTags(stringField(entry.displayName) ?? value) }];
        });
      },
    );

    return await this.jqlFields;
  }

  private async jqlErrorMessage(body: Promise<unknown>): Promise<string> {
    const parsed = await body.catch(() => null);
    const messages =
      isRecord(parsed) && Array.isArray(parsed.errorMessages)
        ? parsed.errorMessages.filter((message): message is string => typeof message === 'string')
        : [];
    const detail = messages.join(' ').slice(0, MAX_ERROR_LENGTH);

    return detail.length > 0
      ? `Jira could not run this query: ${detail}`
      : 'Jira could not run this query. Check the JQL.';
  }

  private async json(path: Route, operation: string, init?: JiraRequestInit): Promise<unknown> {
    return await this.checked(await this.request(path, 'user', init), operation);
  }

  private async checked(
    response: { readonly status: number; json(): Promise<unknown> },
    operation: string,
  ): Promise<unknown> {
    if (response.status < HTTP_OK_MIN || response.status > HTTP_OK_MAX) {
      throw new JiraApiError(operation, response.status);
    }

    return await response.json();
  }
}

function notYetWritable(): DomainError {
  return new DomainError('INVALID_STATE', 'Saving estimates to Jira arrives in Milestone 7.');
}
