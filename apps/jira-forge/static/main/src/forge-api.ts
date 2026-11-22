import { invoke, realtime } from '@forge/bridge';
import type { RealtimeSubscriptionView, ResolverResult } from '@planning-poker/contracts';
import type { PlanningPokerApi } from '@planning-poker/ui';
import { unwrap } from '@planning-poker/ui';

/** Renew the subscription this long before its token expires. */
const RENEW_BEFORE_EXPIRY_MS = 60_000;
/** After a failed subscribe, try again after this long (the room keeps polling meanwhile). */
const RETRY_AFTER_MS = 30_000;
const MIN_RENEW_DELAY_MS = 5_000;

type Subscription = Awaited<ReturnType<typeof realtime.subscribe>>;

async function call<T>(key: string, payload: unknown): Promise<T> {
  // The resolver returns ResolverResult for every key (see src/handlers.ts).
  const result = (await invoke(key, payload as Record<string, unknown>)) as ResolverResult<T>;

  return unwrap(result);
}

async function unsubscribeQuietly(subscription: Promise<Subscription> | null): Promise<void> {
  if (subscription === null) {
    return;
  }

  try {
    await (await subscription).unsubscribe();
  } catch {
    // Subscribing had failed, or the channel is already closed: nothing to release.
  }
}

/**
 * Subscribes to a session's channel with a token the resolver signs only for people allowed to
 * view the session, renews it before it expires, and resubscribes after errors. Every event only
 * means "re-fetch your view", so payloads are ignored; a missed event costs nothing more than the
 * room's fallback refresh.
 */
function subscribeToSession(sessionId: string, onChange: () => void): () => void {
  let active = true;
  // Read through a function: `active` changes while a request is awaited.
  const stopped = () => !active;
  let current: Promise<Subscription> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        void connect();
      },
      Math.max(delay, MIN_RENEW_DELAY_MS),
    );
  };

  const connect = async (): Promise<void> => {
    const previous = current;
    current = null;
    await unsubscribeQuietly(previous);

    if (!active) {
      return;
    }

    try {
      const access = await call<RealtimeSubscriptionView>('getRealtimeToken', { sessionId });

      if (stopped()) {
        return;
      }

      const subscription = realtime.subscribe(
        access.channel,
        (_payload, error) => {
          if (!active) {
            return;
          }

          if (error === undefined) {
            onChange();

            return;
          }

          // E.g. an expired token: resubscribe soon, and refresh in case events were missed.
          onChange();
          schedule(0);
        },
        access.token === null ? undefined : { token: access.token },
      );
      current = subscription;
      await subscription;

      if (access.expiresAt !== null) {
        schedule(Date.parse(access.expiresAt) - Date.now() - RENEW_BEFORE_EXPIRY_MS);
      }
    } catch {
      // Not allowed (any more), or realtime is unavailable: keep polling and try again later.
      schedule(RETRY_AFTER_MS);
    }
  };

  void connect();

  return () => {
    active = false;
    clearTimeout(timer);
    void unsubscribeQuietly(current);
  };
}

/** PlanningPokerApi backed by this app's Forge resolver and Forge Realtime. */
export const forgeApi: PlanningPokerApi = {
  async call(key, payload) {
    return await call<never>(key, payload);
  },

  subscribe: subscribeToSession,
};
