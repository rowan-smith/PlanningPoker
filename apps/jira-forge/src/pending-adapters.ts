import type { EventPublisher } from '@planning-poker/application';

/**
 * Stand-ins for adapters that later milestones deliver. They make the gap explicit instead of
 * faking behaviour.
 */

/** Milestone 5 replaces this with Forge Realtime. Clients re-fetch views until then. */
export const pendingRealtimePublisher: EventPublisher = {
  publish: () => Promise.resolve(),
};
