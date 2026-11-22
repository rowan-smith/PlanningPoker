import { invoke, realtime } from '@forge/bridge';
import type { ResolverResult } from '@planning-poker/contracts';
import { sessionChannel } from '@planning-poker/contracts';
import type { PlanningPokerApi } from '@planning-poker/ui';
import { unwrap } from '@planning-poker/ui';

/** PlanningPokerApi backed by this app's Forge resolver and Forge Realtime. */
export const forgeApi: PlanningPokerApi = {
  async call(key, payload) {
    // The resolver returns ResolverResult for every key (see src/handlers.ts).
    const result = (await invoke(key, payload)) as ResolverResult<never>;

    return unwrap(result);
  },

  subscribe(sessionId, onChange) {
    let active = true;
    // Payloads are ignored on purpose: every event only means "re-fetch your view".
    const subscription = realtime.subscribe(sessionChannel(sessionId), (_payload, error) => {
      if (active && error === undefined) {
        onChange();
      }
    });

    return () => {
      active = false;
      void subscription.then(
        async (current) => {
          await current.unsubscribe();
        },
        // Subscribing failed; the room keeps refreshing on its fallback timer.
        () => undefined,
      );
    };
  },
};
