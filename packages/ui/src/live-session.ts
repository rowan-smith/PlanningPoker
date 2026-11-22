import type { SessionView } from '@planning-poker/contracts';
import { useCallback, useEffect } from 'react';

import type { PlanningPokerApi } from './api';
import type { Loadable } from './hooks';
import { useLoad } from './hooks';

/** Safety net when no realtime channel is available, or a notification was missed. */
const FALLBACK_REFRESH_MS = 30_000;
const REALTIME_FALLBACK_REFRESH_MS = 120_000;

/**
 * Loads a session and keeps it current: re-fetches on realtime notifications, when the page
 * becomes visible again (recovering after sleep or reconnects), and on a slow timer.
 */
export function useLiveSession(
  api: PlanningPokerApi,
  sessionId: string,
): {
  readonly state: Loadable<SessionView>;
  readonly replace: (view: SessionView) => void;
  readonly refresh: () => void;
} {
  const load = useCallback(
    async () => await api.call('getSession', { sessionId }),
    [api, sessionId],
  );
  const { state, reload, replace } = useLoad<SessionView>(load, { keepLastValueOnError: true });

  useEffect(() => {
    const unsubscribe = api.subscribe?.(sessionId, reload);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        reload();
      }
    };
    const timer = setInterval(
      reload,
      unsubscribe === undefined ? FALLBACK_REFRESH_MS : REALTIME_FALLBACK_REFRESH_MS,
    );
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      unsubscribe?.();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [api, sessionId, reload]);

  return { state, replace, refresh: reload };
}
