// use-feed-funnel-log — a DEV-ONLY Metro log explaining what the "For you" feed
// is actually rendering, and where everything else went.
//
// The header sentence counts ARTICLES and includes `reason_pending` rows; the
// feed gates on `complete` only and THEN collapses multi-source
// stories into one card. So "90 found relevant for you" and 23 visible cards can
// both be correct — but until you can see the funnel there is no way to tell that
// apart from a bug. This prints the whole chain, stage by stage, so the gap is
// either explained or obviously not.
//
// COST IN PRODUCTION: none. Every code path is behind `if (!__DEV__) return`,
// which Metro dead-code-eliminates from a release bundle — the same `__DEV__ &&`
// interlock used for the prompt dumps in lib/config/endpoints.ts. It also stays
// off the hot path in dev: `computeFeedFunnel` re-runs story grouping, so it only
// fires once the rendered count has settled (see SETTLE_MS).

import { useEffect, useRef } from 'react';
import logger from '@/lib/logger';
import { computeFeedCounts } from '@/lib/hooks/use-feed-counts';
import { computeFeedFunnel } from '@/lib/stores/feed-diagnostics';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { useForYouStore } from '@/lib/stores/for-you-store';
import type { FeedListItem } from '@/lib/stores/feed-list-selector';
import type { UserGeoLanguageContext } from '@/lib/feed-grouping/geo-language-priority';

const TAG = '[feed-funnel]';

/**
 * Trailing debounce: log once the rendered count has stopped moving for this
 * long. Deliberately trailing, not leading — during a sync the count climbs
 * 0 → 5 → 12 → 23, and a leading throttle would print the first of those and
 * swallow the settled one, which is the only number worth reading.
 */
const SETTLE_MS = 2500;

/** Max card lines printed before collapsing into a "+N more". */
const MAX_CARD_LINES = 60;

function title(item: FeedListItem): string {
  const raw = item.suggestion.title_en ?? item.suggestion.title_original ?? '(untitled)';
  return raw.length > 70 ? `${raw.slice(0, 70)}…` : raw;
}

/**
 * Log the feed funnel whenever the rendered card count changes.
 *
 * @param data       the rendered rows, in list order (already `order` → items).
 * @param dividerIdx index of the "All caught up" divider within `data`, i.e. how
 *                   many rows are above it. Rows at or after it are the seen block.
 * @param userCtx    the same geo/language context the screen feeds `buildFeedList`,
 *                   so the diagnostic groups exactly the way the feed did.
 */
export function useFeedFunnelLog(
  data: FeedListItem[],
  dividerIdx: number,
  userCtx: UserGeoLanguageContext | null,
): void {
  const lastEmittedCountRef = useRef(-1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The timer must read the LATEST args when it fires, not the ones captured by
  // whichever render happened to schedule it.
  const latestRef = useRef({ data, dividerIdx, userCtx });
  latestRef.current = { data, dividerIdx, userCtx };

  useEffect(() => {
    if (!__DEV__) return;
    // NON-RESETTING. `data` gets a fresh identity on every sync, so this effect
    // re-runs constantly. Restarting the timer here would starve it during a
    // sync burst — and returning a cleanup that cancels it is worse still,
    // because React runs the previous cleanup before each re-run, so the timer
    // would be cancelled and then never rescheduled. Schedule once, let it fire,
    // and decide at fire time whether there is anything worth printing.
    if (timerRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const { data: d, dividerIdx: divider, userCtx: ctx } = latestRef.current;
      if (d.length === lastEmittedCountRef.current) return;
      lastEmittedCountRef.current = d.length;
      emitFunnelLog(d, divider, ctx);
    }, SETTLE_MS);
  }, [data, dividerIdx, userCtx]);

  // Unmount-only cleanup — deliberately its own effect with an empty dep array,
  // so it cannot cancel a pending timer on a mere dependency change.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    },
    [],
  );
}

/** Build and print the report. Split out of the hook so the effect stays a
 *  plain debounce and this stays a plain function of its arguments. */
function emitFunnelLog(
  data: FeedListItem[],
  dividerIdx: number,
  userCtx: UserGeoLanguageContext | null,
): void {
  const now = Date.now();
  try {
    const fo = useFeedOrderStore.getState();
    const os = useOpenedStoriesStore.getState();
    const suggestions = useForYouStore.getState().suggestions;
    const header = computeFeedCounts(suggestions, {
      nowMs: now,
      openedArticleIds: os.articleIds,
    });

    const r = computeFeedFunnel({
      suggestions,
      openedArticleIds: os.articleIds,
      openedUnionIds: os.ids,
      order: fo.order,
      itemsById: fo.itemsById,
      cardStates: fo.cardStates,
      builtAt: fo.builtAt,
      orderHydrated: fo.hydrated,
      openedHydrated: os.hydrated,
      hydrateStats: fo.hydrateStats,
      headerAnalysedCount: header.analysedCount,
      headerRelevantCount: header.relevantCount,
      // A DB read would make this async; the report tolerates null and the
      // set sizes below already carry the useful part.
      openedStats: null,
      userCtx,
      nowMs: now,
    });

    const pct = (n: number) => (r.totals.rows > 0 ? ` (${Math.round((n / r.totals.rows) * 100)}%)` : '');
    const lines: string[] = [
      '',
      `${TAG} ── RENDERED ${data.length} cards (${dividerIdx} unseen · ${Math.max(0, data.length - dividerIdx)} seen) ──`,
      `  header says            : ${header.relevantCount} relevant / ${header.analysedCount} analysed / ${header.readCount} read  [48h window, includes reason_pending]`,
      `  suggestions in DB      : ${r.totals.rows}  (unscored ${r.totals.status.unscored} · reason_pending ${r.totals.status.reasonPending} · complete ${r.totals.status.complete})`,
      `  ── why rows never reached the feed (${Math.round(r.gates.renderWindowMs / 3_600_000)}h window + relevance > ${r.gates.renderGate}, complete only) ──`,
      `    not complete         : -${r.dropped.notComplete}${pct(r.dropped.notComplete)}`,
      `    below relevance gate : -${r.dropped.belowRelevanceGate}${pct(r.dropped.belowRelevanceGate)}`,
      `    outside the window   : -${r.dropped.outsideWindow}${pct(r.dropped.outsideWindow)}`,
      `    = visible rows       : ${r.visibleCount}`,
      `  ── grouping (ARTICLES become STORIES — one card per story) ──`,
      `    stories after group  : ${r.groups.count}   (${r.groups.collapseRatio} articles per card, biggest story ${r.groups.largestSize})`,
      `  ── order ──`,
      `    persisted order      : ${r.orderStage.length}  (rendered ${r.orderStage.renderedCount}, orphans ${r.orderStage.orphanCount})`,
      `    candidates missing   : ${r.candidatesNotInOrder.absent}`,
    ];

    for (const [reason, n] of Object.entries(r.candidatesNotInOrder.byReason)) {
      if (n > 0) lines.push(`      · ${reason}: ${n}`);
    }
    if (r.wouldBeBlockedByClusterGate > 0) {
      lines.push(`    rescued from the old cluster-wide gate: ${r.wouldBeBlockedByClusterGate}`);
    }
    if (r.launchWipeSuspected) {
      lines.push('    ⚠ launch wipe suspected — hydrate ran against an empty candidate pool');
    }
    const sums = r.sumsCheck;
    if (!sums.visibilityAttributionSums || !sums.memberSumMatchesVisible || !sums.orderReasonsSum) {
      lines.push('    ⚠ report inconsistent — feed-diagnostics is stale relative to the pipeline');
    }

    // Relevance distribution over EVERY row. `relevance` is what the render
    // gate filters on — it is NOT the composite `score` printed per card below.
    // Mass bunched just under the gate ⇒ the gate is mistuned; mass at ~0 ⇒
    // scoring simply is not matching the persona, and lowering the gate would
    // only admit noise.
    const buckets = new Array(11).fill(0);
    for (const s of suggestions) {
      const rel = Math.max(0, Math.min(1.0999, s.relevance ?? 0));
      buckets[Math.floor(rel * 10)]++;
    }
    lines.push(`  ── relevance distribution (gate is > ${r.gates.renderGate}) ──`);
    buckets.forEach((n, i) => {
      if (n === 0) return;
      const lo = (i / 10).toFixed(1);
      const hi = ((i + 1) / 10).toFixed(1);
      const mark = i / 10 < r.gates.renderGate ? 'cut ' : 'keep';
      lines.push(`    ${lo}-${hi} ${mark} ${'#'.repeat(Math.min(40, Math.ceil(n / 5))).padEnd(40)} ${n}`);
    });

    lines.push(`  ── the ${data.length} rendered cards ──`);
    lines.push('       idx  zone     state    rel  score  sources  title');
    data.slice(0, MAX_CARD_LINES).forEach((item, i) => {
      const zone = i < dividerIdx ? 'unseen' : ' seen ';
      const state = fo.cardStates[item.id]?.state ?? '-';
      const sources = item.memberCount > 1 ? ` +${item.memberCount - 1}src` : '';
      const rel = (item.suggestion.relevance ?? 0).toFixed(2);
      lines.push(
        `    ${String(i).padStart(3)} [${zone}] ${state.padEnd(7)} ${rel}  ${item.score.toFixed(2)}  ${sources.padEnd(7)}  ${title(item)}`,
      );
    });
    if (data.length > MAX_CARD_LINES) {
      lines.push(`    … +${data.length - MAX_CARD_LINES} more`);
    }

    logger.debug(lines.join('\n'));
  } catch (err) {
    // A diagnostic must never take the feed down with it.
    logger.warn(`${TAG} failed`, { error: String(err) });
  }
}
