/**
 * Small, conservative JQL completion: field names while typing a clause, and field values after an
 * operator. Jira validates the query when it runs; this only helps people type it.
 */

export interface JqlField {
  readonly value: string;
  readonly displayName: string;
}

export type CompletionContext =
  | { readonly kind: 'field'; readonly prefix: string; readonly partial: string }
  | {
      readonly kind: 'value';
      readonly prefix: string;
      readonly field: string;
      readonly partial: string;
    }
  | { readonly kind: 'none' };

const MAX_SUGGESTIONS = 10;
const KEYWORDS: ReadonlySet<string> = new Set(['and', 'or', 'not', 'order', 'by', 'asc', 'desc']);

/**
 * `field <op> value` at the end of the query, where the value is either an open quoted string
 * (`"To`) or an unquoted word without spaces (`Do`). `in (a, b` lists are supported.
 */
const VALUE_AT_END =
  /^.*?([A-Za-z_][\w.]*|"[^"]+"|cf\[\d+\])\s*(?:=|!=|~|!~|\bin\s*\(|\bnot\s+in\s*\()(?:[^()]*,)?\s*(?:"([^"]*)|([^\s",()]*))$/i;
const WORD_AT_END = /^(.*?)([A-Za-z_][\w.]*)$/;

/** Works out what the user is typing at the end of the query. */
export function completionContext(query: string): CompletionContext {
  const value = VALUE_AT_END.exec(query);

  if (value !== null) {
    const [, rawField = '', quoted, unquoted] = value;
    const partial = quoted ?? unquoted ?? '';
    const typed = quoted === undefined ? partial.length : partial.length + 1;

    return {
      kind: 'value',
      prefix: query.slice(0, query.length - typed),
      field: rawField.replace(/^"|"$/g, ''),
      partial,
    };
  }

  const word = WORD_AT_END.exec(query);

  if (word !== null) {
    const [, prefix = '', partial = ''] = word;

    return KEYWORDS.has(partial.toLowerCase())
      ? { kind: 'none' }
      : { kind: 'field', prefix, partial };
  }

  return { kind: 'none' };
}

function quoteValue(value: string): string {
  return /^[\w.-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/** Jira highlights matches in suggestion labels with <b> tags; keep only the text. */
export function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

export function fieldCompletions(
  context: Extract<CompletionContext, { kind: 'field' }>,
  fields: readonly JqlField[],
): { value: string; displayName: string }[] {
  const partial = context.partial.toLowerCase();

  return fields
    .filter(
      (field) =>
        field.value.toLowerCase().startsWith(partial) ||
        stripTags(field.displayName).toLowerCase().includes(partial),
    )
    .slice(0, MAX_SUGGESTIONS)
    .map((field) => ({
      value: `${context.prefix}${field.value} `,
      displayName: stripTags(field.displayName),
    }));
}

export function valueCompletions(
  context: Extract<CompletionContext, { kind: 'value' }>,
  values: readonly { readonly value: string; readonly displayName: string }[],
): { value: string; displayName: string }[] {
  return values.slice(0, MAX_SUGGESTIONS).map((entry) => ({
    value: `${context.prefix}${quoteValue(entry.value)}`,
    displayName: stripTags(entry.displayName),
  }));
}
