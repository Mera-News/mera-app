import { AppScheduler } from '../AppScheduler';

// Fact-check reconcile on every foreground: re-reads the fact checks THIS
// device asked for that are still waiting, so a result that finished while the
// app was away lands in the local table (and its in-app notification row) as
// soon as the reader is back. The check itself completes asynchronously on the
// server; nothing pushes it to the device, so something has to ask.
//
// Event-driven (`frequency: 0`): the 5s tick skips frequency-0 tasks, so this
// runs only on a foreground (every return is a JS reload, and the boot's faked
// foreground counts) and on a network reconnect, which AppScheduler already
// rate-limits. No `markNoOp()`: "nothing pending" is the normal state, and
// suppressing the lastRun stamp for it would re-fire the task every tick.
//
// `reconcileAskedFactChecks` owns the "this device asked for it" rule (the
// local table also holds checks mirrored from articles other people had
// checked) and never throws. It is lazy-required so this task's import graph,
// and every scheduler suite that loads it, does not pull in the fact-check
// client and Apollo.

AppScheduler.register({
  name: 'fact-check-reconcile',
  displayName: 'Fact-check reconcile',
  frequency: 0,
  triggers: ['app-foreground', 'network-reconnect'],
  conditions: [{ type: 'db-ready' }, { type: 'network' }],
  timeout: 60_000,
  maxAttempts: 1,
  exclusive: true,
  handler: async (_input, ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { reconcileAskedFactChecks } = require('@/lib/fact-check/fact-check-graphql-client') as typeof import('@/lib/fact-check/fact-check-graphql-client');
    const waiting = await reconcileAskedFactChecks();
    ctx.log(`reconciled asked fact checks, ${waiting} still waiting`);
  },
});
