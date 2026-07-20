// scoring-engine — the LLM JUDGE over the deterministic math score (Wave 7b).
//
// Pure/RN-free. Two pieces:
//   (1) summarizeComponents() — turns a RelevanceComponents breakdown into the
//       compact "why it scored" phrase the judge sees (top signals in words +
//       the winning matched-topic text). NO fact bank leaves the device.
//   (2) parseJudgeResponse() — decodes the combined {"j","s"?,"r"?} array with
//       the SAME conservative discipline as parseFeedVerifierResponse: on parse
//       failure / length mismatch / a malformed entry, the row falls back to its
//       computed math score (fail-open). "s" is still decoded across the whole
//       band (no ±clamp, per the 2026-07-17 decision).
//
// ROUND-3 A1 — the judge is ADVISORY. Its returned score (JudgeDecision.score)
// is NEVER applied: the callers (run-stage.computeAndJudge,
// judge-calls.decodeJudgeResults) persist the COMPUTED math score and expose the
// judge score only as an advisory value + the `override` flag (|judge −
// computed| > OVERRIDE_DELTA 0.3) that still feeds the calibration loop. The
// judge's `reason` remains the user-facing note. parseJudgeResponse itself is
// unchanged — the "never apply" rule lives in how the callers consume it.

import type { HarnessLogger } from '../core/ports';
import { NOOP_LOGGER } from '../core/ports';
import type { ScoringEngineConfig } from '../core/config';
import {
  modulatedTopicWeight,
  type MatchedTopicInput,
  type RelevanceComponents,
} from './relevance';
import type { PersonaLocationSnapshot } from './persona-context';

/** |judge − computed| beyond this magnitude counts as a real override (fed to
 *  the M-P5c calibration loop). Kept local to the judge (not a scoring weight). */
export const OVERRIDE_DELTA = 0.3;

export interface JudgeDecision {
  /** The judge's proposed score (ADVISORY — Round-3 A1). Equals `computed` on
   *  "ok" / fail-open, or the decoded "adj" value otherwise. Always in
   *  [BASE_MIN, BASE_MAX]. Callers NEVER apply this as the relevance; it only
   *  drives the `override` flag + the calibration case. */
  score: number;
  /** Judge-authored reason, when it returned one (computed ≥ 0.15 gate). */
  reason?: string;
  /** true when the judge overrode the math by more than OVERRIDE_DELTA. */
  override: boolean;
  /** true when the judge returned a well-formed "adj" that changed the score at
   *  all (any magnitude) — distinct from `override` (>0.3). */
  adjusted: boolean;
}

const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

/**
 * Compact human phrase describing WHY the math scored an article the way it did
 * — the judge's only context besides the article text. Lists the strongest
 * contributing signals (winning topic text + weight bucket, geo tier,
 * popularity, freshness) and any active penalty, in priority order.
 */
export function summarizeComponents(
  components: RelevanceComponents,
  matchedTopics: MatchedTopicInput[],
  locations?: PersonaLocationSnapshot[],
  config?: ScoringEngineConfig,
): string {
  const parts: string[] = [];

  // Winning matched topic (strongest by magnitude) + its text + weight bucket.
  // Wave 14: rank + bucket by the SAME HP/vectorScore-modulated weight the math
  // scores with (modulatedTopicWeight), so the "why" phrase names the topic
  // that actually dominates topicComp. Without a config (legacy callers) fall
  // back to the raw effectiveWeight.
  const weightOf = (t: MatchedTopicInput): number =>
    config ? modulatedTopicWeight(t, config) : t.effectiveWeight;
  const positive = matchedTopics.filter((t) => t.effectiveWeight > 0);
  if (positive.length > 0) {
    const winner = positive.reduce((a, b) =>
      Math.abs(weightOf(b)) > Math.abs(weightOf(a)) ? b : a,
    );
    const w = weightOf(winner);
    const strength = w >= 0.7 ? 'strong' : w >= 0.4 ? 'moderate' : 'weak';
    const label = winner.text ? `'${winner.text}'` : 'a topic';
    parts.push(`matched ${label} (${strength})`);
    if (positive.length > 1) parts.push(`${positive.length} topics matched`);
  } else {
    parts.push('no positive topic match');
  }

  // Geo alignment — include the matched location's ROLE + tier so the judge can
  // tell a meaningful place tie (your home city) from a coincidental one (an
  // interest country). The role is not sensitive persona data (no address/
  // weight) and rides inside the trusted E2EE judge call, not the retrieval
  // query — so the privacy-lean retrieval contract is untouched.
  if (components.geoAlignment !== 'NONE') {
    const loc = locations?.find((l) => l.id === components.matchedLocationId);
    const role = loc?.role ? ` to your ${loc.role} place` : '';
    parts.push(`location ${components.geoAlignment}-level match${role}`);
  }

  // Popularity (only when notable). Round-3 A2 removed the freshness clause
  // (age decay no longer contributes to the score).
  if (components.popComp >= 0.6) parts.push('widely covered');

  // Entity / publication signals.
  if (components.entityComp >= 0.4) parts.push('followed entity');
  if (components.pubComp > 0) parts.push('preferred publication');
  else if (components.pubComp < 0) parts.push('down-weighted publication');

  // Penalties (why a score is LOW despite a match).
  if (components.wrongLocationFlag === 1) parts.push('WRONG-location penalty (sibling city)');
  if (components.negTopicPenalty > 0) parts.push('negative-topic penalty');
  if (components.suppressPenalty > 0) parts.push('suppression penalty');
  if (components.seenPenalty > 0) parts.push('already-seen');

  return parts.join('; ');
}

interface ParsedJudgeEntry {
  j?: unknown;
  s?: unknown;
  r?: unknown;
}

/**
 * Decode a combined judge+reason batch response — a JSON array of N
 * {"j":"ok"|"adj","s"?,"r"?} objects in input order — against the per-article
 * computed scores (same order). Returns exactly `expectedCount` decisions.
 *
 * Conservative by contract (mirrors parseFeedVerifierResponse): parse failure,
 * length mismatch, or a malformed entry → that article (or the whole batch)
 * KEEPS its computed score, no override, no reason.
 */
export function parseJudgeResponse(
  output: string,
  computedScores: number[],
  config: ScoringEngineConfig,
  logger: HarnessLogger = NOOP_LOGGER,
  id?: string,
): JudgeDecision[] {
  const expectedCount = computedScores.length;
  const keepAll = (): JudgeDecision[] =>
    computedScores.map((s) => ({ score: s, override: false, adjusted: false }));

  const trimmed = output.trim();
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    logger.warn('Judge: no JSON array found — fail-open to computed scores', {
      output: trimmed.slice(0, 200),
      expected: expectedCount,
      id,
    });
    return keepAll();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    logger.warn('Judge: JSON parse failed — fail-open to computed scores', {
      output: trimmed.slice(0, 200),
      expected: expectedCount,
      id,
    });
    return keepAll();
  }

  if (!Array.isArray(parsed) || parsed.length !== expectedCount) {
    logger.warn('Judge: array length mismatch — fail-open to computed scores', {
      expected: expectedCount,
      got: Array.isArray(parsed) ? parsed.length : 'not-array',
      id,
    });
    return keepAll();
  }

  return parsed.map((entry, i) => {
    const computed = computedScores[i];
    const fallback: JudgeDecision = { score: computed, override: false, adjusted: false };
    if (!entry || typeof entry !== 'object') return fallback;
    const e = entry as ParsedJudgeEntry;

    const reason =
      typeof e.r === 'string' && e.r.trim().length > 0 ? e.r.trim() : undefined;

    const decision = String(e.j ?? '').toLowerCase().trim();
    if (decision === 'adj' && typeof e.s === 'number' && Number.isFinite(e.s)) {
      const s = clamp(e.s, config.BASE_MIN, config.BASE_MAX);
      return {
        score: s,
        reason,
        adjusted: true,
        override: Math.abs(s - computed) > OVERRIDE_DELTA,
      };
    }
    // "ok", missing, or malformed "adj" → keep computed (may still carry a reason).
    return { score: computed, reason, override: false, adjusted: false };
  });
}
