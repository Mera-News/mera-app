import { AppScheduler } from '../AppScheduler';

// Feedback requests: asks the server which questions are live, records them
// locally, writes one drawer row per new question, and (through the state
// write) wakes the auto-show host. See lib/feedback-requests/.
//
// Hourly plus every foreground and reconnect: a request runs for days, so an
// hour of lag is fine, and a push only reaches readers with notifications on,
// so the foreground is what reaches everyone else.
//
// No `markNoOp()`, ever. "No live requests" is the normal state on every
// device, and suppressing the lastRun stamp for it would re-fire this task
// every 5s tick forever. A failed fetch returns quietly too: the service has
// already breadcrumbed and the Apollo error link owns the Sentry capture, so
// throwing here would only add a second event per failure from the runner.
//
// The sync is lazy-required so this task's import graph, and every scheduler
// suite that loads it, does not pull in Apollo and the database.

AppScheduler.register({
  name: 'feedback-request-sync',
  displayName: 'Feedback requests',
  frequency: 60 * 60 * 1000,
  triggers: ['app-foreground', 'network-reconnect'],
  conditions: [{ type: 'network' }, { type: 'authenticated' }, { type: 'db-ready' }],
  timeout: 30_000,
  maxAttempts: 1,
  exclusive: true,
  handler: async (_input, ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { syncFeedbackRequests } = require('@/lib/feedback-requests/feedback-request-sync') as typeof import('@/lib/feedback-requests/feedback-request-sync');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useAppLanguageStore } = require('@/lib/stores/app-language-store') as typeof import('@/lib/stores/app-language-store');
    const result = await syncFeedbackRequests(useAppLanguageStore.getState().appLanguage);
    ctx.log(
      result.ok
        ? `feedback requests: ${result.fetched} live, ${result.newRows} new, ${result.answered} answered elsewhere`
        : 'feedback requests: fetch failed, next foreground retries',
    );
  },
});
