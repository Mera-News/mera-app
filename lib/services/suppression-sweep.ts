// suppression-sweep — hard "not interested" filters are RETROACTIVE.
//
// Adding a hard filter (or muting a publication) must not only change what the
// NEXT scoring pass keeps — it must also remove what is already stored and
// already on screen. Retiring one must give those articles a second chance.
// This module owns both directions:
//
//   purgeHardFilteredSuggestions()   — screen every stored row against the
//     currently-active hard filters, mark the matches terminal `excluded`, and
//     drop exactly those ids from the Feed tab's persisted order.
//
//   purgeHardFilteredByIds(ids)      — the same screen scoped to a known id set,
//     for the one path that writes a renderable score WITHOUT ever passing
//     through the scoring stage's hard screen: score propagation. See P9 note
//     below.
//
//   unexcludeRetiredHardFilters()    — the mirror. Re-screen the already-
//     excluded rows against every STILL-ACTIVE hard filter; the ones nothing
//     matches any more go back to `unscored` so the next pass scores them
//     fresh. A row blocked by two filters stays excluded until both are gone.
//
// All three read the persona snapshot LIVE, so the caller's only obligation is
// to have committed its suppression/publication-preference change first. None
// takes a filter as an argument — that is what makes the two-filter case
// correct for free.
//
// P9 — WHY THE SCOPED VARIANT EXISTS. `batchPropagateScores` copies a scored
// donor's relevance/reason onto its unscored siblings and marks them terminal
// `complete`. Those rows never enter computeMathStage/computeAndJudge, which is
// where `screenHardSuppressions` runs — so a hard-blocked article could inherit
// a passing score and render, defeating the "Blocked / never show me these at
// all" promise. Reconciling at the propagation callers closes that hole with
// the SAME matcher (one matcher is a load-bearing invariant of this wave)
// instead of adding a second screening path. It is scoped rather than a full
// `purgeHardFilteredSuggestions()` because feed-sync runs the gate once per
// hydrate CHUNK, so a full-table screen there would be O(chunks × all rows).
//
// WIRING: `persona-mutation-sweeps.ts` runs the two full sweeps for the
// persona-action executor (ADD_SUPPRESSION / RETIRE_SUPPRESSION /
// SET_PUBLICATION_PREF); the scoped variant is wired into the four propagation
// call sites (feed-sync-steps, run-inference-handler, scoring-pipeline ×2).

import logger from '@/lib/logger';
import {
  batchMarkExcluded,
  batchResetToUnscored,
  buildStageCandidateInput,
  getStageRowsByIds,
  getStageRowsForScreening,
  type TopicWeightInfo,
} from '@/lib/database/services/article-suggestion-service';
import type { StageCandidateRow } from '@/lib/news-harness/core/types';
import type { SoftSuppression } from '@/lib/news-harness/scoring-engine';
import { loadPersonaScoringContext } from '@/lib/mera-protocol/stage-scoring';
import { screenHardSuppressions } from '@/lib/news-harness/scoring-engine';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';

export interface HardFilterPurgeResult {
  /** Rows newly marked `excluded`. */
  excludedIds: string[];
  /** excluded id → display value of the filter that matched it. */
  valueById: Map<string, string>;
  /** How many of those were laid out in the Feed tab and evicted. */
  evictedFromFeed: number;
}

export interface HardFilterUnexcludeResult {
  /** Rows reset to `unscored` (nothing active matches them any more). */
  resetIds: string[];
  /** Rows left excluded because another active filter still matches. */
  stillExcluded: number;
}

/** Lazy require, mirroring scoring-pipeline's own refreshUi: a static import of
 *  SuggestionSyncService from here would close a load-time cycle. */
async function refreshUi(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('./SuggestionSyncService') as typeof import('./SuggestionSyncService');
  await mod.refreshSuggestionsInStoreUnsafe();
}

/**
 * D12a + D12b. Screen every stored suggestion that is not already excluded
 * against the live hard filters, mark the matches terminal, evict exactly those
 * ids from the Feed tab, and refresh the UI.
 *
 * Rehydration note: this reuses `buildStageCandidateInput` — the same pure
 * mapper `buildStageCandidates` uses — over the stored scorer columns. It
 * deliberately does NOT load `article_suggestion_facts`: the hard screen reads
 * only ScoredCandidateInput fields, and the fact links exist for the legacy
 * backstop LLM payload alone.
 */
export async function purgeHardFilteredSuggestions(
  nowMs: number = Date.now(),
): Promise<HardFilterPurgeResult> {
  const { persona, topicWeights } = await loadPersonaScoringContext(nowMs);
  if (!persona.hardSuppressions?.length) return EMPTY_PURGE();

  const rows = await getStageRowsForScreening();
  return screenExcludeAndEvict(
    rows,
    persona.hardSuppressions,
    topicWeights,
    nowMs,
    'purged hard-filtered suggestions',
  );
}

/**
 * P9. The SCOPED screen: same matcher, same exclusion, same eviction — but over
 * exactly `ids` instead of the whole table. Written for the score-propagation
 * reconcile (rows that were handed a donor's score without ever meeting the
 * scoring stage's hard screen).
 *
 * Ordered cheapest-check-first: an empty id list costs nothing, and no hard
 * filters costs one persona read and zero row reads — which is the overwhelming
 * majority of syncs.
 */
export async function purgeHardFilteredByIds(
  ids: string[],
  nowMs: number = Date.now(),
): Promise<HardFilterPurgeResult> {
  if (ids.length === 0) return EMPTY_PURGE();

  const { persona, topicWeights } = await loadPersonaScoringContext(nowMs);
  if (!persona.hardSuppressions?.length) return EMPTY_PURGE();

  const rows = await getStageRowsByIds(ids);
  return screenExcludeAndEvict(
    rows,
    persona.hardSuppressions,
    topicWeights,
    nowMs,
    'purged hard-filtered propagated rows',
  );
}

function EMPTY_PURGE(): HardFilterPurgeResult {
  return { excludedIds: [], valueById: new Map(), evictedFromFeed: 0 };
}

/**
 * The one screen-and-exclude body both purge entry points share, so there is
 * exactly ONE matcher call, ONE `batchMarkExcluded`, and ONE feed eviction rule
 * in this module. Callers differ only in which rows they hand it.
 */
async function screenExcludeAndEvict(
  rows: StageCandidateRow[],
  hard: SoftSuppression[],
  topicWeights: Map<string, TopicWeightInfo>,
  nowMs: number,
  logLabel: string,
): Promise<HardFilterPurgeResult> {
  if (rows.length === 0) return EMPTY_PURGE();

  const valueById = screenHardSuppressions(
    rows.map((r) => buildStageCandidateInput(r, topicWeights)),
    hard,
  );
  if (valueById.size === 0) return EMPTY_PURGE();

  const excludedIds = [...valueById.keys()];
  await batchMarkExcluded(excludedIds, nowMs);

  // Filter-scoped eviction: exactly these ids, nothing inferred.
  const orderBefore = useFeedOrderStore.getState().order.length;
  useFeedOrderStore.getState().removeIds(excludedIds);
  const evictedFromFeed = orderBefore - useFeedOrderStore.getState().order.length;

  logger.info(`[suppression-sweep] ${logLabel}`, {
    scanned: rows.length,
    excluded: excludedIds.length,
    evictedFromFeed,
    values: [...new Set(valueById.values())].slice(0, 10),
  });

  await refreshUi();
  return { excludedIds, valueById, evictedFromFeed };
}

/**
 * D12c. The un-exclude direction, run AFTER the filter has been retired /
 * unmuted. Every currently-excluded row is re-screened against the filters that
 * are STILL active; only rows nothing matches are reset to `unscored`.
 *
 * They come back as `unscored`, never resurrected as scored rows: the score
 * they would have had was never computed, and any stale one would be a lie.
 */
export async function unexcludeRetiredHardFilters(
  nowMs: number = Date.now(),
): Promise<HardFilterUnexcludeResult> {
  const rows = await getStageRowsForScreening({ excluded: true });
  if (rows.length === 0) return { resetIds: [], stillExcluded: 0 };

  const { persona, topicWeights } = await loadPersonaScoringContext(nowMs);
  // No active hard filters left ⇒ nothing can still be blocked ⇒ release all.
  const stillBlocked = persona.hardSuppressions?.length
    ? screenHardSuppressions(
        rows.map((r) => buildStageCandidateInput(r, topicWeights)),
        persona.hardSuppressions,
      )
    : new Map<string, string>();

  const resetIds = rows.map((r) => r.id).filter((id) => !stillBlocked.has(id));
  if (resetIds.length === 0) {
    return { resetIds: [], stillExcluded: stillBlocked.size };
  }

  await batchResetToUnscored(resetIds);
  logger.info('[suppression-sweep] released previously excluded suggestions', {
    scanned: rows.length,
    reset: resetIds.length,
    stillExcluded: stillBlocked.size,
  });

  await refreshUi();
  return { resetIds, stillExcluded: stillBlocked.size };
}
