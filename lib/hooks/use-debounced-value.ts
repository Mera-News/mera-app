// use-debounced-value — trailing-edge debounce for a changing value.
//
// Returns a copy of `value` that only updates after it has stopped changing for
// `delayMs`. Used by the locations add-flow type-ahead so a `placeSearch`
// GraphQL round-trip fires once the user pauses, not on every keystroke.

import { useEffect, useState } from 'react';

/** Default debounce window (ms) — tuned for a search type-ahead. */
export const DEFAULT_DEBOUNCE_MS = 250;

export function useDebouncedValue<T>(value: T, delayMs: number = DEFAULT_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}

export default useDebouncedValue;
