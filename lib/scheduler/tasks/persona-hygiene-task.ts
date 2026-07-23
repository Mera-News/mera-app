// Weekly persona fact-hygiene sweep (Wave 11 U-B3/N6). Fires at most once per
// 7 days; the service-level guards inside runHygieneSweep (KV cooldown stamp +
// min-facts + min-persona-age) make every early/ineligible run a couple of
// cheap reads, so the recurring schedule is just the vehicle. When the sweep
// produces cleanups it stores them and fires ONE `hygiene` notification whose
// `review-hygiene` chip opens the dedicated review sheet.

import { runHygieneSweep } from '@/lib/database/services/hygiene-service';
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
  timeout: 30_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async (_input, ctx) => {
    const result = await runHygieneSweep();
    if (!result.ran) {
      ctx.log(`hygiene sweep skipped — ${result.reason ?? 'not-eligible'}`);
      return;
    }
    ctx.log(`hygiene sweep complete — ${result.proposalCount} proposal(s)`);
  },
});
