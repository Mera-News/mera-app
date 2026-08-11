/**
 * Resume fact checks the app was killed in the middle of.
 *
 * WHY THIS EXISTS. The check is a background job whose only durable state is a
 * WatermelonDB row. `fact-check-queue.ts`'s in-flight map dies with the
 * process, so an app killed (or OOM'd, or backgrounded past the OS's patience)
 * mid-run leaves a row sitting at `processing` with nothing left that intends
 * to finish it. That is the exact silent failure the server-side pipeline's
 * retry cron existed to remove, moved one layer down — the row would simply
 * never resolve, and the panel would show "checking…" forever.
 *
 * `failed` is re-driven too. `fact-check-state.ts` is explicit that `failed` is
 * NOT terminal — it is "the pipeline will pick this up again" — and after the
 * pivot this task IS that pipeline. Without it a single transient model error
 * would strand the row just as permanently as a kill.
 *
 * Bounded on every axis: at most `MAX_PER_PASS` rows re-driven per foreground,
 * only rows whose current attempt has been running longer than `STALE_AFTER_MS`
 * (so a live run is never double-driven), never a row already in the in-flight
 * map, and never past `MAX_FACT_CHECK_ATTEMPTS` — at the cap the row is written
 * `blocked`, which is terminal AND verdict-free, rather than retried forever.
 */

import { getAiAccess } from '@/lib/stores/subscription-store';
import {
  listFactChecksByStatus,
  upsertFactCheck,
} from '@/lib/database/services/fact-check-record-service';
import {
  FACT_CHECK_STATUS,
  isFactCheckInFlight,
  redriveFactCheck,
} from '@/lib/fact-check/fact-check-queue';
import { MAX_FACT_CHECK_ATTEMPTS, type FactCheckPayload } from '@/lib/fact-check/fact-check-runner';
import { AppScheduler } from '../AppScheduler';

/**
 * How long an attempt may run before it counts as stranded.
 *
 * Well above the legitimate worst case: a ClaimReview lookup plus three web
 * searches plus a thinking synthesis on BIG_MODEL is tens of seconds, and the
 * runner's own synthesis deadline is 120s. Anything past five minutes is not
 * slow, it is dead.
 */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** Re-drives per foreground. Three concurrent BIG_MODEL streams is already more
 *  than a phone waking up should be spending. */
export const MAX_PER_PASS = 3;

const RECOVERABLE = [FACT_CHECK_STATUS.processing, FACT_CHECK_STATUS.failed];

/** Exported for the test suite — the selection rule is the whole task. */
export function isStranded(
  row: { status: string; payload: Partial<FactCheckPayload> | null; requestedAt: number },
  nowMs: number,
): boolean {
  if (!RECOVERABLE.includes(row.status as (typeof RECOVERABLE)[number])) return false;
  // `requested_at` is insert-only, so a re-driven row keeps its original value
  // and cannot say how long the CURRENT attempt has been going. `startedAt` is
  // re-stamped by the runner on every attempt and is the only honest clock; the
  // fallback covers a row written before that field existed.
  const startedAt = typeof row.payload?.startedAt === 'number'
    ? row.payload.startedAt
    : row.requestedAt;
  return nowMs - startedAt >= STALE_AFTER_MS;
}

AppScheduler.register({
  name: 'fact-check-recover',
  displayName: 'Fact Check Recovery',
  frequency: 0,
  triggers: ['app-foreground'],
  conditions: [
    { type: 'network' },
    { type: 'authenticated' },
    { type: 'db-ready' },
    // Same gate the feed sync uses, and the same reasoning: `!== 'locked'`
    // rather than `=== 'entitled'`, so a cold start that has not heard back
    // about billing yet still recovers a paying user's stranded check.
    { type: 'custom', check: () => getAiAccess() !== 'locked' },
  ],
  timeout: 60_000,
  maxAttempts: 1,
  exclusive: true,
  handler: async (_input, ctx) => {
    const now = Date.now();
    const candidates = (
      await Promise.all(RECOVERABLE.map((status) => listFactChecksByStatus(status)))
    ).flat();

    let driven = 0;
    for (const row of candidates) {
      if (driven >= MAX_PER_PASS) break;
      if (!isStranded(row, now)) continue;
      if (row.claimKey && isFactCheckInFlight(row.articleId, row.claimKey)) continue;

      const payload = (row.payload ?? null) as Partial<FactCheckPayload> | null;
      const attempts = typeof payload?.attempts === 'number' ? payload.attempts : 0;
      if (attempts >= MAX_FACT_CHECK_ATTEMPTS) {
        // Terminal and verdict-free. A row we could not finish must say "we
        // could not finish", never carry an answer we never established.
        ctx.log(`capping ${row.articleId} at ${attempts} attempts`);
        await upsertFactCheck({
          articleId: row.articleId,
          factCheckId: row.factCheckId,
          articleTitle: row.articleTitle,
          claim: row.claim,
          claimKey: row.claimKey,
          status: FACT_CHECK_STATUS.blocked,
          verdict: null,
          payload: { ...(payload ?? {}), status: FACT_CHECK_STATUS.blocked, verdict: null, blockedReason: 'attempts-exhausted' },
        });
        continue;
      }

      if (redriveFactCheck(row)) driven++;
    }

    ctx.log(`re-drove ${driven} stranded fact check(s)`);
    // Nothing to do is not work: leave `lastRun` unstamped so the next
    // foreground is free to look again immediately.
    if (driven === 0) ctx.markNoOp();
  },
});
