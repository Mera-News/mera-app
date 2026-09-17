// harness-local — local adapter over the pass-2 reason decoder.
//
// P2 owns lib/news-harness and is landing a NEW export there:
//
//   export interface ReasonRescore { k: string; s: number; score: number }
//   export function parseReasonResult(
//     output: string, id: string, prompt?: string, logger?: HarnessLogger
//   ): { reason: string; rescore?: ReasonRescore };
//
// (`rescore.score` = clampToStakeBand(s, k) — the band-clamped final value.
// `rescore` is absent whenever k/s did not parse: fail open, pass-1 stands.)
// `parseReasonResponse` (bare-string return) is UNCHANGED and keeps shipping
// alongside it.
//
// Until that commit lands, `parseReasonResult` is not an exported member of
// lib/news-harness and importing it would fail to compile. This file is the
// one seam: it wraps today's `parseReasonResponse` in the FINAL shape, so
// every caller in this directory already codes against the object contract.
//
// SWITCH-OVER, once P2 commits (one line, marked below):
//   import { parseReasonResult } from '../../lib/news-harness';
//   export const decodeReason = parseReasonResult;
// and this whole adapter body goes away.

import { parseReasonResponse, type HarnessLogger } from '../../lib/news-harness';

export interface ReasonRescore {
  k: string;
  s: number;
  /** Band-clamped final value (clampToStakeBand(s, k) on the production
   *  path). Equal to `s` here until P2's decoder lands, since this adapter
   *  never produces a rescore at all (see decodeReason below). */
  score: number;
}

export interface DecodedReason {
  reason: string;
  rescore?: ReasonRescore;
}

/**
 * Decodes one reason-call response into `{ reason, rescore? }`.
 *
 * PRE-P2: always returns `{ reason }` with no `rescore` — `parseReasonResponse`
 * has nothing to parse a score out of yet, so every consumer downstream (the
 * gate-vs-final join, the rescore summary) sees exactly what "no rescore
 * parsed" looks like post-P2 too. Nothing here fakes a score.
 */
export function decodeReason(
  output: string,
  id: string,
  prompt?: string,
  logger?: HarnessLogger,
): DecodedReason {
  const reason = parseReasonResponse(output, id, prompt, logger);
  return { reason };
}
