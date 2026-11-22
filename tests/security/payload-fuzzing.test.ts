/**
 * Malformed payloads for every resolver, sent by a caller who is allowed to use it: wrong types,
 * missing fields, oversized strings and lists, nested junk. The resolver must answer VALIDATION
 * or NOT_FOUND (or accept a harmless value), never INTERNAL, and must not log anything.
 */
import { describe, expect, it } from 'vitest';

import type { ResolverKey } from '@planning-poker/contracts';
import { RESOLVER_KEYS } from '@planning-poker/contracts';

import type { Fixture } from '../support/probes';
import { callerFor, fixture, MATRIX } from '../support/probes';

const HUGE = 'x'.repeat(100_000);
const MANY = Array.from({ length: 5_000 }, (_, index) => `item-${String(index)}`);

/** Replacement values for a single field. */
const JUNK: readonly unknown[] = [
  null,
  42,
  -1.5,
  // `true` is omitted: it is a valid value for every boolean field.
  '',
  HUGE,
  [],
  MANY,
  [HUGE],
  [{ nested: true }],
  {},
  { toString: 'boom', __proto__: { polluted: true } },
  Number.NaN,
];

/** Whole payloads that are not objects at all. */
const WHOLE: readonly unknown[] = [undefined, null, 0, 'payload', [], [1, 2], HUGE];

/** Codes a malformed request may produce. INVALID_STATE etc. would mean junk reached the domain. */
const ACCEPTABLE = ['VALIDATION', 'NOT_FOUND'];

/** Mutations that keep a field valid can legitimately succeed (e.g. `description: null`). */
function outcome(result: { ok: boolean; error?: { code: string } }): string {
  return result.ok ? 'ok' : (result.error?.code ?? 'unknown');
}

function mutations(payload: unknown): { label: string; payload: unknown }[] {
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const valid = payload as Record<string, unknown>;
  const cases: { label: string; payload: unknown }[] = [];

  for (const field of Object.keys(valid)) {
    const { [field]: _removed, ...without } = valid;
    cases.push({ label: `missing ${field}`, payload: without });

    for (const [index, value] of JUNK.entries()) {
      cases.push({
        label: `${field} = junk #${String(index)}`,
        payload: { ...valid, [field]: value },
      });
    }
  }

  return cases;
}

async function caseResults(key: ResolverKey, f: Fixture) {
  const probe = MATRIX[key];
  const role = probe.allowed.find((candidate) => candidate !== 'otherSite') ?? 'admin';
  const caller = callerFor(f.world, role);
  const valid = probe.payload(f);
  const results: { label: string; result: string }[] = [];

  for (const [index, payload] of WHOLE.entries()) {
    const result = await caller[key](payload);
    results.push({ label: `whole payload #${String(index)}`, result: outcome(result) });
  }

  for (const mutation of mutations(valid)) {
    const result = await caller[key](mutation.payload);
    results.push({ label: mutation.label, result: outcome(result) });
  }

  return results;
}

describe('malformed payloads', () => {
  for (const key of RESOLVER_KEYS) {
    it(`${key} rejects junk with VALIDATION or NOT_FOUND, never INTERNAL`, async () => {
      const f = await fixture();
      const results = await caseResults(key, f);
      const unexpected = results.filter(
        ({ result }) => result !== 'ok' && !ACCEPTABLE.includes(result),
      );

      expect(unexpected).toEqual([]);
      expect(f.world.backend.logged).toEqual([]);
    });
  }

  it('does not let a __proto__ key in a map pollute objects', async () => {
    const f = await fixture();
    const payload = JSON.parse(
      `{"sessionId":"${f.draftId}","fieldId":null,"optionByCardId":{"__proto__":{"polluted":"yes"}}}`,
    ) as unknown;

    await f.world.max.setFieldMapping(payload);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
