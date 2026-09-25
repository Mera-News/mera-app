import { recoverCycle } from '@/lib/services/cycle-state-machine';
import { rescueStalePendingTopicFacts } from '@/lib/database/services/fact-service';
import { flushPendingDeletes } from '@/lib/database/services/topic-decline-service';
import { repairUnweightedTopics } from '@/lib/database/services/topic-service';
import { runPendingComboPass } from '@/lib/database/services/combo-pass-service';
import { recoverOpenFactsDraft } from '@/lib/services/facts-draft-service';
import logger from '@/lib/logger';
import { AppScheduler } from '../AppScheduler';

/**
 * First run in THIS JS context. A kill, a crash and a JS reload all start a new
 * context, and in every one of them the Profile chat is certainly closed, so
 * that first run may treat a still-open facts draft as abandoned. On a plain
 * foreground the chat may legitimately be open, so the draft is not touched.
 * Deliberately not `coldStart` from the scheduler: that is false on a JS reload,
 * which closes the chat just the same.
 */
let firstRunDone = false;

/** Test seam. */
export function __resetColdStartLatchForTests(): void {
  firstRunDone = false;
}

/**
 * Resume the combination pass. On the first run, a draft the Profile chat left
 * open with different facts becomes a pending pass first. Then a pending flag
 * becomes jobs (cloud) or a refresh (on-device); a pass already queued resumes
 * on its own once the queue runs.
 */
async function resumeComboPass(ctx: { log: (m: string) => void }): Promise<void> {
  try {
    if (!firstRunDone) {
      firstRunDone = true;
      if (await recoverOpenFactsDraft()) ctx.log('facts draft left open with changes');
    }
    const outcome = await runPendingComboPass();
    if (outcome !== 'none') ctx.log(`combination pass: ${outcome}`);
  } catch (err) {
    // Never fail recovery over it: the flag stays set and the next foreground
    // tries again.
    logger.captureException(err, { tags: { task: 'inference-recover', step: 'combo-pass' } });
  }
}

AppScheduler.register({
  name: 'inference-recover',
  displayName: 'Inference Recovery',
  frequency: 0,
  triggers: ['app-foreground'],
  // db-ready ONLY — deliberately NOT network/authenticated. Recovery re-arms the
  // scoring poller and aborts/finalizes a wedged LOCAL run; neither needs a live
  // session or network (the poller handles auth/network per-tick). A persisted
  // `needsReauth` window (r7 A) used to fail the `authenticated` gate and the
  // offline app failed the `network` gate — either one starved this task, so a
  // run left stuck 'running' had nothing to reset it and feed-sync (which skips
  // while scoring is in flight) never fetched again. Un-gating restores the
  // self-heal.
  conditions: [{ type: 'db-ready' }],
  timeout: 120_000,
  maxAttempts: 1,
  exclusive: true,
  handler: async (_input, ctx) => {
    ctx.log('recovering cycle');
    await recoverCycle();

    // Facts left 'pending' by a generation job that died. Deliberately here
    // and not only on InferenceQueue.start(): that path is reached from
    // useModelLifecycle and, in on-device mode, waits for the model to load,
    // so a device whose model never loads would never sweep.
    const rescued = await rescueStalePendingTopicFacts();
    if (rescued > 0) ctx.log(`rescued ${rescued} stale pending facts`);

    // Topics minted before `weight` was required on CreateTopicInput. A
    // weight of 0 is dropped by buildRetrievalProfile before the feed request
    // is built, so these render on the Profile and are never queried. Here
    // rather than in a migration: the repair needs no schema change, and a
    // version bump carrying a data-only fix cannot be walked back by an OTA
    // rollback without the adapter reaching for "resetting database instead".
    const reweighted = await repairUnweightedTopics();
    if (reweighted > 0) ctx.log(`re-weighted ${reweighted} unqueryable topics`);

    // Commit any topic delete staged before the app was killed or
    // backgrounded. This is the "app start and every foreground" half of the
    // flush contract — the service's 5s timer is only the fast path, and a
    // component must never own it.
    const committed = await flushPendingDeletes();
    if (committed > 0) ctx.log(`committed ${committed} staged topic deletes`);

    // After the flush, so the pass reads the persona the user actually sees.
    await resumeComboPass(ctx);

    // No ctx.markNoOp(): "nothing to rescue, nothing staged" is the NORMAL
    // state, and suppressing the lastRun stamp on a routine skip turns this
    // into a silent 5s infinite loop.
  },
});
