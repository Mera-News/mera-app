// Weekly persona fact-hygiene sweep (Wave 11 U-B3/N6). Fires at most once per
// 7 days; the service-level guards inside runHygieneSweep (KV cooldown stamp +
// min-facts + min-persona-age) make every early/ineligible run a couple of
// cheap reads, so the recurring schedule is just the vehicle. When the sweep
// produces cleanups it stores them and fires ONE `hygiene` notification whose
// `review-hygiene` chip opens the dedicated review sheet.

import { runHygieneSweep } from '@/lib/database/services/hygiene-service';
import { runTopicTopup } from '@/lib/database/services/topic-topup-service';
import { AppScheduler } from '../AppScheduler';
import { backgroundWorkIsIdle } from '../background-idle';

const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

AppScheduler.register({
  name: 'persona-hygiene',
  displayName: 'Persona Hygiene Sweep',
  frequency: WEEKLY_MS,
  triggers: [],
  // db-ready + idle: a low-priority sweep that defers to the feed sync /
  // inference queue and re-checks on the next tick when the app is busy.
  conditions: [{ type: 'db-ready' }, { type: 'custom', check: backgroundWorkIsIdle }],
  // 90s, raised from 30s for the r12 LLM topic-sanity audit (SANITY_RACE_MS is
  // 60s and sits inside this). Safe despite maxAttempts: the audit is wrapped in
  // a race that NEVER rejects, so a slow audit resolves to "no sanity proposals"
  // and the handler completes — the retry path is never entered, and a second
  // billed call can't happen.
  timeout: 90_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async (_input, ctx) => {
    const result = await runHygieneSweep();
    if (!result.ran) {
      ctx.log(`hygiene sweep skipped — ${result.reason ?? 'not-eligible'}`);
    } else {
      ctx.log(`hygiene sweep complete — ${result.proposalCount} proposal(s)`);
    }

    // Fact-combination top-up (r12 J-P3). FIRE-AND-FORGET on purpose: it only
    // mints rows, nothing downstream waits on it, and keeping it off the awaited
    // path means a slow generation can never push the handler past its timeout
    // into a retry (which would re-issue a billed batch). The cost is that a
    // backgrounded app loses the run — acceptable at a weekly cadence, since the
    // watermark is only advanced on a completed pass, so nothing is skipped.
    void runTopicTopup()
      .then((r) => {
        if (r.ran) ctx.log(`topic top-up — ${r.appended} appended across ${r.considered} fact(s)`);
      })
      .catch(() => {
        /* the service never throws; this is belt-and-braces */
      });
  },
});
