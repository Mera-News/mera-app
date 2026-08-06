// coldstart-timeline — a DEV-ONLY, single-anchor timeline of the cold-start and
// post-cache-clear path, so "why did the Feed take N seconds to show a card" is
// answerable from one Metro scroll instead of switching tabs and diffing
// wall-clock timestamps by hand.
//
// WHY logger.info AND NOT logger.debug. `logger.debug` only reaches the console
// when EXPO_PUBLIC_VERBOSE_LOGS === 'true' (see lib/logger.ts) — and turning
// that on unleashes ~78 debug calls in lib/services/scoring-pipeline.ts alone,
// which is exactly the noise this file exists to escape. `logger.info` prints
// under plain __DEV__. One line per event, ever.
//
// COST IN PRODUCTION: none. Both exports return immediately on `if (!__DEV__)`,
// which Metro constant-folds and dead-code-eliminates from a release bundle —
// the same interlock components/custom/feed/use-feed-funnel-log.ts uses. So this
// is PERMANENTLY HARMLESS rather than something that has to be torn out later;
// and if you do want it gone, `git grep coldstart-timeline` is the complete
// removal list (one import + one call per site).

import logger from '@/lib/logger';

const TAG = '[timeline]';

/** t0 for the current run. Module-eval time IS app launch: app/_layout.tsx
 *  imports this file for its side effect, so the anchor is bundle evaluation
 *  rather than whichever screen happens to touch it first. */
let t0 = Date.now();

/** Event names already emitted this run — one line per event, at most. */
const fired = new Set<string>();

/**
 * Re-anchor t0 and RE-ARM every event. Called at an in-app cache clear so the
 * repopulation that follows gets its own clean timeline.
 *
 * `fired.clear()` is load-bearing: without it the launch run has already
 * consumed every event name, and the cache-clear run — the primary use case —
 * would print nothing at all.
 */
export function arm(label: string): void {
  if (!__DEV__) return;
  t0 = Date.now();
  fired.clear();
  logger.info(`${TAG} +0ms t0 (${label})`);
}

/** Emit one line, at most once per run. `detail` is appended verbatim. */
export function mark(event: string, detail?: string): void {
  if (!__DEV__) return;
  if (fired.has(event)) return;
  fired.add(event);
  logger.info(`${TAG} +${Date.now() - t0}ms ${event}${detail ? ` ${detail}` : ''}`);
}
