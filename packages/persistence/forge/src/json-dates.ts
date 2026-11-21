/**
 * Domain records hold Dates; Forge stores JSON. Dates are written as ISO strings and revived on
 * read for the field names the domain uses for timestamps.
 */
const DATE_FIELDS: ReadonlySet<string> = new Set([
  'addedAt',
  'completedAt',
  'createdAt',
  'decidedAt',
  'finishedAt',
  'frozenAt',
  'openedAt',
  'publishedAt',
  'respondedAt',
  'restoredAt',
  'revealedAt',
  'skippedAt',
  'startedAt',
  'submittedAt',
  'updatedAt',
]);

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export function reviveDates(value: Json, key?: string): unknown {
  if (typeof value === 'string' && key !== undefined && DATE_FIELDS.has(key)) {
    return new Date(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => reviveDates(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [entryKey, reviveDates(entry, entryKey)]),
    );
  }

  return value;
}
