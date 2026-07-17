// One-shot persona-v3 silent migration (Wave 6, M-P2). Runs after the DB is
// ready; the service's `persona_v3_migrated` settings guard makes every run
// after completion a single settings read, so the recurring schedule is just
// the retry/resume vehicle for interrupted runs.

import { runPersonaMigrationIfNeeded } from '@/lib/services/persona-migration-service';
import { AppScheduler } from '../AppScheduler';

AppScheduler.register({
  name: 'persona-migration',
  displayName: 'Persona v3 Migration',
  frequency: 6 * 60 * 60 * 1000,
  triggers: ['app-foreground'],
  conditions: [{ type: 'db-ready' }],
  timeout: 60_000,
  maxAttempts: 3,
  exclusive: true,
  handler: async (_input, ctx) => {
    const result = await runPersonaMigrationIfNeeded();
    if (result.ran) {
      ctx.log(
        `persona v3 migration complete — ${result.factsMigrated} facts, ` +
          `${result.topicsCreated} topics, ${result.locationsUpserted} locations`,
      );
    }
  },
});
