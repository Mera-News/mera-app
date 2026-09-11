// Weekly persona fact-hygiene sweep (Wave 11 U-B3/N6). Fires at most once per
// 7 days; the service-level guards inside runHygieneSweep (KV cooldown stamp +
// min-facts + min-persona-age) make every early/ineligible run a couple of
// cheap reads, so the recurring schedule is just the vehicle. When the sweep
// produces cleanups it stores them and fires ONE `hygiene` notification whose
// `review-hygiene` chip opens the dedicated review sheet.

import { authClient } from '@/lib/auth-client';
import { runHygieneSweep } from '@/lib/database/services/hygiene-service';
import { runTopicTopup } from '@/lib/database/services/topic-topup-service';
import { AppScheduler } from '../AppScheduler';
import { backgroundWorkIsIdle } from '../background-idle';

/**
 * Is there a session credential on this device right now?
 *
 * `authClient.getCookie()` is the same LOCAL keychain read the Apollo auth link
 * uses on every request — synchronous, no network, no billing. Deliberately not
 * `getJwtToken()`, which is a network round trip and would put an auth call on
 * the front of a weekly background sweep.
 *
 * Throws on a locked keychain (pre-first-unlock on a background wake), which is
 * read as "no credential" — the right answer for a sweep, which can simply run
 * later.
 */
function hasLocalCredential(): boolean {
  try {
    const cookie = authClient.getCookie();
    return typeof cookie === 'string' && cookie.length > 0;
  } catch {
    return false;
  }
}

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
    // No credential, no sweep. The audit inside runHygieneSweep is a BILLED
    // cloud batch that cannot succeed without one, and failing it costs the
    // user a week: the cooldown stamp would arm off a run that did nothing.
    //
    // markNoOp so `lastRun` is NOT stamped either — the weekly frequency gate
    // must not be armed by a run that accomplished nothing, so the next tick
    // retries as soon as a credential exists. Nothing is billed on this path,
    // so retrying freely is safe.
    //
    // This is the cheap gate; topic-sanity-service additionally returns
    // `skipped` for a credential that disappears MID-RUN, which the sweep
    // handles by withholding its cooldown stamp while still letting the
    // scheduler stamp lastRun.
    if (!hasLocalCredential()) {
      ctx.log('hygiene sweep skipped — no local session credential');
      ctx.markNoOp();
      return;
    }

    const result = await runHygieneSweep();
    if (result.sanitySkipped) {
      ctx.log('sanity audit skipped — no E2EE credential; cooldown not stamped');
    }
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
