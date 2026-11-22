import { useCallback, useEffect, useState } from 'react';

import { errorMessage } from './api';

export type Loadable<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly value: T }
  | { readonly status: 'failed'; readonly message: string };

export interface LoadOptions {
  /** On a failed reload, keep showing the last loaded value (background refreshes). */
  readonly keepLastValueOnError?: boolean;
}

/** Loads data on mount and whenever `load` changes; `reload` fetches again. */
export function useLoad<T>(
  load: () => Promise<T>,
  options: LoadOptions = {},
): {
  readonly state: Loadable<T>;
  readonly reload: () => void;
  readonly replace: (value: T) => void;
} {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const keepLastValue = options.keepLastValueOnError === true;

  useEffect(() => {
    let cancelled = false;

    load().then(
      (value) => {
        if (!cancelled) {
          setState({ status: 'loaded', value });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState((current) =>
            keepLastValue && current.status === 'loaded'
              ? current
              : { status: 'failed', message: errorMessage(error) },
          );
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [load, attempt, keepLastValue]);

  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);
  const replace = useCallback((value: T) => {
    setState({ status: 'loaded', value });
  }, []);

  return { state, reload, replace };
}

/** Runs one action at a time, exposing its pending state and last error message. */
export function useAction(): {
  readonly pending: boolean;
  readonly error: string | null;
  readonly run: (action: () => Promise<void>) => Promise<void>;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<void>) => {
    setPending(true);
    setError(null);

    try {
      await action();
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }, []);

  return { pending, error, run };
}
