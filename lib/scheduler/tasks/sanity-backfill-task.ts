// One-shot topic-sanity backfill (r12 K-P5). Modelled on persona-migration-task:
// a recurring schedule used purely as the retry/resume vehicle, with the real
// guard in the service — once `sanity_backfill_done_at` is stamped, every run is
// a single settings read.
//
// Deliberately NOT run on the upgrade launch itself: `app-foreground` fires on
// every foreground, and `backgroundWorkIsIdle` defers while the feed is syncing
// or the on-device inference queue is busy — which is exactly what a first
// launch after an update looks like. The first chunk therefore lands on a later,
// genuinely idle foreground.

import { runSanityBackfillChunk } from '@/lib/database/services/sanity-backfill-service';
import { AppScheduler } from '../AppScheduler';
import { backgroundWorkIsIdle } from '../background-idle';

AppScheduler.register({
  name: 'sanity-backfill',
  displayName: 'Topic Sanity Backfill',
  frequency: 6 * 60 * 60 * 1000,
  triggers: ['app-foreground'],
  conditions: [{ type: 'db-ready' }, { type: 'custom', check: backgroundWorkIsIdle }],
  // One chunk is 4 parallel reasoning completions in a single HTTP round trip;
  // 90s matches the hygiene sweep's budget for the same shape of work.
  timeout: 90_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async (_input, ctx) => {
    const result = await runSanityBackfillChunk();
    if (!result.ran) {
      ctx.log(`sanity backfill skipped — ${result.reason ?? 'retrying next tick'}`);
      return;
    }
    ctx.log(
      `sanity backfill chunk — ${result.audited} audited, ` +
        `${result.proposalsAdded} proposal(s)${result.done ? ', COMPLETE' : ''}`,
    );
  },
});
