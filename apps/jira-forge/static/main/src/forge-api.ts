import { invoke } from '@forge/bridge';
import type { ResolverResult } from '@planning-poker/contracts';
import type { PlanningPokerApi } from '@planning-poker/ui';
import { unwrap } from '@planning-poker/ui';

/** PlanningPokerApi backed by this app's Forge resolver. */
export const forgeApi: PlanningPokerApi = {
  async call(key, payload) {
    // The resolver returns ResolverResult for every key (see src/handlers.ts).
    const result = (await invoke(key, payload)) as ResolverResult<never>;

    return unwrap(result);
  },
};
