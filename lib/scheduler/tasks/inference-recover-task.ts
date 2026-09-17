import { recoverCycle } from '@/lib/services/cycle-state-machine';
import { rescueStalePendingTopicFacts } from '@/lib/database/services/fact-service';
import { flushPendingDeletes } from '@/lib/database/services/topic-decline-service';
import { AppScheduler } from '../AppScheduler';

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

    // Commit any topic delete staged before the app was killed or
    // backgrounded. This is the "app start and every foreground" half of the
    // flush contract — the service's 5s timer is only the fast path, and a
    // component must never own it.
    const committed = await flushPendingDeletes();
    if (committed > 0) ctx.log(`committed ${committed} staged topic deletes`);

    // No ctx.markNoOp(): "nothing to rescue, nothing staged" is the NORMAL
    // state, and suppressing the lastRun stamp on a routine skip turns this
    // into a silent 5s infinite loop.
  },
});
