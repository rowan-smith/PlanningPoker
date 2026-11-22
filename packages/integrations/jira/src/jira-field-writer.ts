/**
 * Writes final estimates to Jira issue fields, as the calling user (Milestone 7).
 *
 * Endpoints (Jira Cloud REST v3, checked against the OpenAPI spec):
 * - `GET /rest/api/3/issue/{issueIdOrKey}/editmeta` — which fields the user may edit on the
 *   issue, their operations and, for single-select fields, the allowed option values.
 * - `GET /rest/api/3/issue/{issueIdOrKey}?fields={fieldId}` — the field's current value.
 * - `PUT /rest/api/3/issue/{issueIdOrKey}` — `{ fields: { [fieldId]: value } }`.
 *
 * Field contexts and options (`/field/{id}/context/...`) need *Administer Jira* and the
 * `manage:jira-configuration` scope, so option values come from `editmeta` instead.
 *
 * Jira has no idempotency key for edits. Setting a field to a value is idempotent, and
 * `validate` treats a field that already holds the value as written, so a retry after an
 * interrupted attempt neither double-applies nor reports a conflict with itself.
 * Response bodies are never logged; only short, field-level messages reach the user.
 */
import { route } from '@forge/api';
import type {
  ExternalField,
  ExternalFieldOption,
  UpdateResult,
  UpdateValidation,
  WorkItemUpdateRequest,
} from '@planning-poker/application';
import type { FieldValue, WorkItemReference } from '@planning-poker/domain';

import type { JiraRequest, JiraResponse } from './jira-user-api';

/** Each ticket's editmeta is a request; options rarely differ beyond a few projects. */
const MAX_OPTION_SOURCES = 10;
const MAX_MESSAGE_LENGTH = 200;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

interface Failure {
  readonly status: 'forbidden' | 'invalid' | 'failed';
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOk(status: number): boolean {
  return status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;
}

/** Current value comparable with an estimate: numbers as-is, options by their value. */
export function jiraFieldValue(value: unknown): FieldValue | null {
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }

  return isRecord(value) && typeof value.value === 'string' ? value.value : null;
}

function describe(value: FieldValue | null): string {
  return value === null ? 'empty' : `“${String(value)}”`;
}

/** Maps non-success statuses shared by every call to a safe, user-facing failure. */
function httpFailure(status: number, key: string): Failure {
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
    return { status: 'forbidden', message: `You don't have permission to edit ${key} in Jira.` };
  }

  if (status === HTTP_NOT_FOUND) {
    return { status: 'invalid', message: `${key} was not found in Jira, or you can't see it.` };
  }

  if (status === HTTP_TOO_MANY_REQUESTS) {
    return { status: 'failed', message: 'Jira is rate limiting requests. Retry in a moment.' };
  }

  if (status >= HTTP_SERVER_ERROR) {
    return { status: 'failed', message: 'Jira is unavailable right now. Retry later.' };
  }

  return { status: 'failed', message: `Jira rejected the request (HTTP ${String(status)}).` };
}

/** The field's own error from an ErrorCollection body, trimmed; never the raw body. */
async function fieldError(response: JiraResponse, fieldId: string): Promise<string | null> {
  const body = await response.json().catch(() => null);

  if (!isRecord(body)) {
    return null;
  }

  const errors = isRecord(body.errors) ? body.errors : {};
  const own = errors[fieldId];
  const messages = Array.isArray(body.errorMessages) ? body.errorMessages : [];
  const text = typeof own === 'string' ? own : messages.find((m) => typeof m === 'string');

  return typeof text === 'string' && text.length > 0 ? text.slice(0, MAX_MESSAGE_LENGTH) : null;
}

interface EditableField {
  readonly operations: readonly string[];
  readonly options: readonly ExternalFieldOption[] | null;
}

type EditMeta =
  | { readonly ok: true; readonly fields: ReadonlyMap<string, EditableField> }
  | { readonly ok: false; readonly failure: Failure };

function parseOptions(allowedValues: unknown): ExternalFieldOption[] | null {
  if (!Array.isArray(allowedValues)) {
    return null;
  }

  return allowedValues.flatMap((entry: unknown): ExternalFieldOption[] =>
    isRecord(entry) && typeof entry.id === 'string' && typeof entry.value === 'string'
      ? [{ id: entry.id, value: entry.value }]
      : [],
  );
}

function parseEditMeta(body: unknown): Map<string, EditableField> {
  const fields = isRecord(body) && isRecord(body.fields) ? body.fields : {};

  return new Map(
    Object.entries(fields).flatMap(([id, meta]): [string, EditableField][] => {
      if (!isRecord(meta)) {
        return [];
      }

      const operations = Array.isArray(meta.operations)
        ? meta.operations.filter((op): op is string => typeof op === 'string')
        : [];

      return [[id, { operations, options: parseOptions(meta.allowedValues) }]];
    }),
  );
}

export class JiraFieldWriter {
  private readonly request: JiraRequest;
  private readonly fields: () => Promise<readonly ExternalField[]>;

  constructor(request: JiraRequest, fields: () => Promise<readonly ExternalField[]>) {
    this.request = request;
    this.fields = fields;
  }

  /** Union of a single-select field's allowed values on the given issues, by value. */
  async listFieldOptions(
    fieldId: string,
    items: readonly WorkItemReference[],
  ): Promise<readonly ExternalFieldOption[]> {
    const byValue = new Map<string, ExternalFieldOption>();

    for (const item of items.slice(0, MAX_OPTION_SOURCES)) {
      const meta = await this.editMeta(item);

      // Issues the user cannot edit simply contribute no options.
      for (const option of (meta.ok ? meta.fields.get(fieldId)?.options : null) ?? []) {
        if (!byValue.has(option.value)) {
          byValue.set(option.value, option);
        }
      }
    }

    return [...byValue.values()];
  }

  async validate(request: WorkItemUpdateRequest): Promise<UpdateValidation> {
    const { reference, fieldId, value } = request;
    const key = reference.displayKey;
    const name = await this.fieldName(fieldId);
    const meta = await this.editMeta(reference);

    if (!meta.ok) {
      return meta.failure;
    }

    if (meta.fields.size === 0) {
      return { status: 'forbidden', message: `You don't have permission to edit ${key} in Jira.` };
    }

    const editable = meta.fields.get(fieldId);

    if (editable?.operations.includes('set') !== true) {
      return {
        status: 'invalid',
        message: `${name} can't be edited on ${key}. Check that the field is on the issue's screen and available for its project and type.`,
      };
    }

    if (editable.options !== null && !editable.options.some((o) => o.value === value)) {
      return {
        status: 'invalid',
        message: `“${String(value)}” is not an option of ${name} on ${key}.`,
      };
    }

    const current = await this.currentValue(reference, fieldId);

    if (!current.ok) {
      return current.failure;
    }

    if (current.value === value) {
      return { status: 'ok' };
    }

    if (
      request.expectedCurrentValue !== undefined &&
      current.value !== request.expectedCurrentValue
    ) {
      return {
        status: 'conflict',
        message: `${name} on ${key} was changed in Jira to ${describe(current.value)} (it was ${describe(request.expectedCurrentValue)} when imported).`,
      };
    }

    return { status: 'ok' };
  }

  async update(request: WorkItemUpdateRequest): Promise<UpdateResult> {
    const { reference, fieldId, value } = request;
    const key = reference.displayKey;
    const isOption = (await this.fieldType(fieldId)) === 'option' || typeof value === 'string';
    const response = await this.request(route`/rest/api/3/issue/${reference.itemId}`, 'user', {
      method: 'PUT',
      body: { fields: { [fieldId]: isOption ? { value: String(value) } : value } },
    });

    if (isOk(response.status)) {
      return { status: 'succeeded' };
    }

    if (response.status === HTTP_BAD_REQUEST) {
      const detail = await fieldError(response, fieldId);

      return {
        status: 'failed',
        message: `Jira rejected the value for ${key}${detail === null ? '.' : `: ${detail}`}`,
      };
    }

    if (response.status === HTTP_CONFLICT) {
      return { status: 'failed', message: `${key} was being edited at the same time. Retry.` };
    }

    if (response.status === HTTP_UNPROCESSABLE) {
      return {
        status: 'failed',
        message: `A Jira configuration problem prevents updating ${key}.`,
      };
    }

    return { status: 'failed', message: httpFailure(response.status, key).message };
  }

  // -------------------------------------------------------------------------------------------

  private async editMeta(reference: WorkItemReference): Promise<EditMeta> {
    const response = await this.request(
      route`/rest/api/3/issue/${reference.itemId}/editmeta`,
      'user',
    );

    if (!isOk(response.status)) {
      return { ok: false, failure: httpFailure(response.status, reference.displayKey) };
    }

    return { ok: true, fields: parseEditMeta(await response.json()) };
  }

  private async currentValue(
    reference: WorkItemReference,
    fieldId: string,
  ): Promise<
    | { readonly ok: true; readonly value: FieldValue | null }
    | { readonly ok: false; readonly failure: Failure }
  > {
    const params = new URLSearchParams({ fields: fieldId });
    const response = await this.request(
      route`/rest/api/3/issue/${reference.itemId}?${params}`,
      'user',
    );

    if (!isOk(response.status)) {
      return { ok: false, failure: httpFailure(response.status, reference.displayKey) };
    }

    const body = await response.json();
    const fields = isRecord(body) && isRecord(body.fields) ? body.fields : {};

    return { ok: true, value: jiraFieldValue(fields[fieldId]) };
  }

  private async fieldName(fieldId: string): Promise<string> {
    return (await this.fields()).find((field) => field.fieldId === fieldId)?.name ?? fieldId;
  }

  private async fieldType(fieldId: string): Promise<ExternalField['valueType'] | undefined> {
    return (await this.fields()).find((field) => field.fieldId === fieldId)?.valueType;
  }
}
