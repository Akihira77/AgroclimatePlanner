import { useCallback, useEffect, useState } from "react";

/**
 * One loader per screen, keyed by a string the page derives from its inputs.
 *
 * The key is the dependency: a loader is re-run when its key changes or `reload`
 * is called, never because the closure identity changed. That keeps a page's
 * fetch tied to the thing it is showing rather than to React's render count.
 *
 * `data` is **not** cleared when a later load fails, which splits into two cases. A
 * **key change** holds the previous key's data: nothing was written, so replacing
 * the page with the error is correct. A **`reload`** follows a write that may have
 * committed, so a page that replaces itself with the error is claiming that write
 * failed. A page that reloads must therefore test `data === null` before treating
 * `error` as fatal, and say "stale" when it keeps rendering.
 */
export interface AsyncState<T> {
  readonly data: T | null;
  readonly error: unknown;
  readonly loading: boolean;
  readonly reload: () => void;
}

export function useAsync<T>(key: string, load: () => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    load().then(
      (result) => {
        if (!alive) return;
        setData(result);
        setLoading(false);
      },
      (failure: unknown) => {
        if (!alive) return;
        setError(failure);
        setLoading(false);
      },
    );

    return () => {
      alive = false;
    };
    // `load` is deliberately not a dependency; `key` is the stated contract.
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((current) => current + 1), []);

  return { data, error, loading, reload };
}
