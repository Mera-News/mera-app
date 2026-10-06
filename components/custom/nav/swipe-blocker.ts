import { createContext, useContext } from 'react';

import type { SwipeBlocker } from './types';

/** Provided by TabPages around its pages. */
export const SwipeBlockerContext = createContext<SwipeBlocker | null>(null);

/** Null outside a TabPages. See `SwipeBlocker`. */
export function useSwipeTabsBlocker(): SwipeBlocker | null {
  return useContext(SwipeBlockerContext);
}
