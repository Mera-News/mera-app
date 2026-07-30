// Daily persona geo-derivation sweep. Derives `locations` rows from persona
// facts on an ONGOING basis — before this task the only fact→location writer
// was the run-once persona-v3 migration, so on a device where that migration
// had already completed no new fact ever produced a country again.
//
// The service-level guards inside runGeoDerivationSweep (24h cooldown KV +
// fact-fingerprint KV) make every ineligible run a couple of cheap reads, so
// the recurring schedule is just the vehicle. Silent by design: additive,
// non-destructive writes, no notification.
//
// Deliberately NO `{ type: 'network' }` condition — tier 1 is fully
// offline-capable and the LLM tier already fails soft.
//
// NOTE: ineligible runs only `ctx.log`, they never call `ctx.markNoOp()`.
// markNoOp suppresses the `lastRun` stamp so the next tick can retry
// immediately (scheduler-types.ts:20-25); on a ROUTINE skip that means the 24h
// frequency gate never arms and this task re-fires every 5 seconds forever.
// Reserve markNoOp for aborts and genuine failures. Same rule as
// persona-hygiene-task.

import { runGeoDerivationSweep } from '@/lib/database/services/geo-derivation-service';
import { AppScheduler } from '../AppScheduler';
import { backgroundWorkIsIdle } from '../background-idle';

const DAILY_MS = 24 * 60 * 60 * 1000;

AppScheduler.register({
  name: 'persona-geo',
  displayName: 'Persona Location Derivation',
  frequency: DAILY_MS,
  triggers: ['app-foreground'],
  // db-ready + idle: a low-priority sweep that defers to the feed sync /
  // inference queue and re-checks on the next tick when the app is busy.
  conditions: [{ type: 'db-ready' }, { type: 'custom', check: backgroundWorkIsIdle }],
  timeout: 30_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async (_input, ctx) => {
    const result = await runGeoDerivationSweep();
    if (!result.ran) {
      ctx.log(`geo derivation skipped — ${result.reason ?? 'not-eligible'}`);
      return;
    }
    ctx.log(
      `geo derivation complete — ${result.added} added, ${result.reweighted} reweighted`,
    );
  },
});
