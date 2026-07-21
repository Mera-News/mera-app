// Daily feedback-optimisation cycle (Round-4 C5). Fires at most once per 24h; the
// service-level guards inside runOptimisationCycle (≥20h cooldown + a minimum
// number of unprocessed verdicts) make every early/ineligible tick a couple of
// cheap reads, so the recurring schedule is just the vehicle. When the digest
// finds actionable changes it stores ONE optimisation plan and fires an
// `optimisation_plan` notification whose `review-plan` chip opens Mera chat.

import { runOptimisationCycle } from '@/lib/database/services/optimisation-plan-service';
import { AppScheduler } from '../AppScheduler';

const DAILY_MS = 24 * 60 * 60 * 1000;

AppScheduler.register({
  name: 'feedback-cycle',
  displayName: 'Daily Feedback Optimisation',
  frequency: DAILY_MS,
  triggers: [],
  conditions: [{ type: 'db-ready' }],
  timeout: 30_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async (_input, ctx) => {
    const result = await runOptimisationCycle();
    if (!result.ran) {
      ctx.log(`optimisation cycle skipped — ${result.reason ?? 'not-eligible'}`);
      return;
    }
    ctx.log(
      `optimisation cycle complete — ${result.autoCount} auto + ${result.reviewCount} review`,
    );
  },
});
