import { recoverCycle } from '@/lib/services/cycle-state-machine';
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
  },
});
