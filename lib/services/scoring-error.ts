// Scoring-error classification for the For You header status row.
//
// When the cloud scoring pipeline fails (submission, fetch, or decode), we don't
// block the UI with a toast — we surface a short status in the same header area
// that otherwise shows "Calculating relevance" / "Writing notes for you". The
// banner reads `scoringError` from the For You store and renders the copy below.
// It's set on every failure (no waiting for repeated failures) and cleared at the
// start of the next sync cycle, so it always reflects the latest pipeline state.

import { useNetworkStore } from '@/lib/stores/network-store';

export type ScoringErrorKind = 'offline' | 'server' | 'generic';

/** i18n keys for each failure kind. `as const` keeps the literal types so the
 *  strongly-typed `t(...)` / `i18n.t(...)` accept them. Each has `.title`
 *  (short headline) and `.message` (one-line recovery hint). */
export const SCORING_ERROR_I18N_KEYS = {
  offline: {
    title: 'errors.scoring.offline.title',
    message: 'errors.scoring.offline.message',
  },
  server: {
    title: 'errors.scoring.server.title',
    message: 'errors.scoring.server.message',
  },
  generic: {
    title: 'errors.scoring.generic.title',
    message: 'errors.scoring.generic.message',
  },
} as const;

/**
 * Classify the current failure. We can't always tell exactly why the gateway was
 * unreachable, but device connectivity is the most useful signal: offline → the
 * user can fix it; connected → the service itself is the problem.
 */
export function classifyScoringError(): ScoringErrorKind {
  return useNetworkStore.getState().isConnected ? 'server' : 'offline';
}
