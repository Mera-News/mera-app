// mera-harness/eval — P5's topic expectations: load, validate, score.
//
// The file lives at lib/mera-harness/skills/persona/expectations/topics.json.
// This module never reads it (no node builtins here); the CLI passes the parsed
// JSON in.
//
// WHAT IS SCORED HERE AND WHAT IS NOT. Only the FACT-DEPENDENT checks: count
// range, ladder rungs, field-generic, cross-products, must-not-contain. The
// shared rules — word count, punctuation, near-duplicates — are the same for
// every case and live in the metrics module, exactly as P5's own note says.

import type { TopicExpectationCase, TopicExpectations } from './types';

const MIN_PATTERN_CHARS = 3;

function lower(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Validates the whole file, throwing on the first violation.
 *
 * THE 3-CHARACTER FLOOR IS NOT STYLE. This is substring matching: "eu" matches
 * museum, euro and neural, so a two-character pattern scores a ladder rung as
 * covered on a topic that has nothing to do with it and the metric silently
 * reads high. Note P5 writes the EU bloc as "eu " with a trailing space for the
 * same reason, which is why the check counts characters rather than trimming
 * first.
 */
export function parseExpectations(raw: unknown): TopicExpectations {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!root) throw new Error('mera-harness/eval: expectations file is not an object.');
  const cases = Array.isArray(root.cases) ? root.cases : null;
  if (!cases || cases.length === 0) {
    throw new Error('mera-harness/eval: expectations file has no cases.');
  }

  const parsed: TopicExpectationCase[] = cases.map((c, i) => {
    const rec = c && typeof c === 'object' ? (c as Record<string, unknown>) : null;
    if (!rec || typeof rec.id !== 'string') {
      throw new Error(`mera-harness/eval: expectations case ${i} has no id.`);
    }
    const id = rec.id;

    const patterns = (label: string, list: unknown): string[] => {
      const arr = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
      for (const p of arr) {
        if (p.length < MIN_PATTERN_CHARS) {
          throw new Error(
            `mera-harness/eval: case '${id}' ${label} pattern ${JSON.stringify(p)} is shorter ` +
              `than ${MIN_PATTERN_CHARS} characters. Substring matching on a 2-character pattern ` +
              'scores unrelated topics as covered and the metric reads high with nothing visibly wrong.',
          );
        }
      }
      return arr.map((p) => p.toLowerCase());
    };

    const ladderRaw = (rec.ladder ?? {}) as Record<string, unknown>;
    const ladder: Record<string, string[]> = {};
    for (const [rung, list] of Object.entries(ladderRaw)) {
      ladder[rung] = patterns(`ladder.${rung}`, list);
    }

    const crossRaw = Array.isArray(rec.crossProducts) ? rec.crossProducts : [];
    const crossProducts = crossRaw.map((x, j) => {
      const xr = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
      return {
        a: patterns(`crossProducts[${j}].a`, xr.a),
        b: patterns(`crossProducts[${j}].b`, xr.b),
      };
    });

    const countRange = Array.isArray(rec.countRange) && rec.countRange.length === 2
      ? ([Number(rec.countRange[0]), Number(rec.countRange[1])] as [number, number])
      : null;

    return {
      id,
      factMatches: patterns('factMatches', rec.factMatches),
      countRange,
      ladder,
      fieldGeneric: rec.fieldGeneric == null ? null : patterns('fieldGeneric', rec.fieldGeneric),
      crossProducts,
      mustNotContain: patterns('mustNotContain', rec.mustNotContain),
    };
  });

  assertCasesAreMutuallyExclusive(parsed);
  return { version: typeof root.version === 'number' ? root.version : 1, cases: parsed };
}

/**
 * The STATIC half of mutual exclusivity: no case's factMatches term set may be
 * a subset of another's. `["india"]` beside `["india","expat"]` guarantees that
 * any fact matching the second also matches the first.
 *
 * This is necessary, not sufficient — fact text is model-authored and unknown
 * here — so `selectCase` below carries the runtime half.
 */
function assertCasesAreMutuallyExclusive(cases: TopicExpectationCase[]): void {
  for (const a of cases) {
    for (const b of cases) {
      if (a.id === b.id) continue;
      const aSet = new Set(a.factMatches);
      const bSet = new Set(b.factMatches);
      if (aSet.size === 0 || aSet.size > bSet.size) continue;
      let subset = true;
      for (const t of aSet) if (!bSet.has(t)) { subset = false; break; }
      if (subset) {
        throw new Error(
          `mera-harness/eval: case '${a.id}' factMatches is a subset of '${b.id}'. ` +
            'Every fact matching the second would also match the first, so a composed fact ' +
            'would be scored against two ladders.',
        );
      }
    }
  }
}

export type CaseSelection =
  | { kind: 'one'; case: TopicExpectationCase }
  | { kind: 'none' }
  /** Scored against NEITHER. Taking the first match in file order would judge a
   *  composed origin-plus-residence fact against one ladder chosen by
   *  whichever case happened to be written first. */
  | { kind: 'ambiguous'; caseIds: string[] };

export function selectCase(
  factStatement: string,
  cases: readonly TopicExpectationCase[],
): CaseSelection {
  const s = lower(factStatement);
  const hits = cases.filter((c) => c.factMatches.length > 0 && c.factMatches.every((t) => s.includes(t)));
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length > 1) return { kind: 'ambiguous', caseIds: hits.map((h) => h.id) };
  return { kind: 'one', case: hits[0] };
}

/**
 * Rungs that participate in the ORDERING requirement.
 *
 * `diaspora` is excluded deliberately: it is a SHAPE category in the origin
 * guideline ("visa rules, consular services, remittances"), not a rung of a
 * place ladder, so demanding it appear at a fixed position would score a
 * correct output as wrong.
 */
const NON_ORDERING_RUNGS = new Set(['diaspora']);

export interface LadderOrder {
  /** How many rungs the ordering applies to. */
  rungs: number;
  /** How many leading topics matched their rung, in declaration order, before
   *  the first miss. */
  matchedPrefix: number;
  /** The full prefix matched. REPORTED, never gated: P5 asked for a number,
   *  and a positional rule is the kind of thing that is right to watch before
   *  it is right to enforce. */
  ordered: boolean;
}

/**
 * Do the first K topics match the K ordering rungs, in declaration order?
 *
 * Reported rather than gated. A fixed position is a strong demand on a
 * generative output, and the honest first step is to see how often it already
 * holds.
 */
export function ladderOrder(topics: readonly string[], c: TopicExpectationCase): LadderOrder {
  const rungs = Object.entries(c.ladder).filter(([k]) => !NON_ORDERING_RUNGS.has(k));
  let matchedPrefix = 0;
  for (let i = 0; i < rungs.length; i++) {
    const t = topics[i];
    if (t === undefined) break;
    const [, pats] = rungs[i];
    if (!pats.some((p) => t.trim().toLowerCase().includes(p))) break;
    matchedPrefix += 1;
  }
  return { rungs: rungs.length, matchedPrefix, ordered: rungs.length > 0 && matchedPrefix === rungs.length };
}

export interface CaseScore {
  caseId: string;
  topicCount: number;
  countInRange: boolean | null;
  /** Per case, never pooled across cases: rung SETS differ between cases, so a
   *  run-wide percentage would sum different denominators. */
  rungsCovered: number;
  rungsTotal: number;
  missingRungs: string[];
  /** At-least-one. Null when the case does not test it. */
  fieldGenericPresent: boolean | null;
  crossProductsCovered: number;
  crossProductsTotal: number;
  mustNotContainHits: { topic: string; pattern: string }[];
}

/** A rung is covered when at least one topic matches any of its patterns. */
export function scoreCase(topics: readonly string[], c: TopicExpectationCase): CaseScore {
  const lowered = topics.map(lower);
  const anyTopicMatches = (pats: readonly string[]): boolean =>
    pats.some((p) => lowered.some((t) => t.includes(p)));

  const rungs = Object.entries(c.ladder);
  const missingRungs = rungs.filter(([, pats]) => !anyTopicMatches(pats)).map(([r]) => r);

  return {
    caseId: c.id,
    topicCount: topics.length,
    countInRange: c.countRange
      ? topics.length >= c.countRange[0] && topics.length <= c.countRange[1]
      : null,
    rungsCovered: rungs.length - missingRungs.length,
    rungsTotal: rungs.length,
    missingRungs,
    fieldGenericPresent: c.fieldGeneric == null ? null : anyTopicMatches(c.fieldGeneric),
    // PRESENCE ONLY: covered when ONE topic matches both sides. No rate, no
    // cap, no ratio — those live outside this check by decision.
    crossProductsCovered: c.crossProducts.filter((x) =>
      lowered.some((t) => x.a.some((p) => t.includes(p)) && x.b.some((p) => t.includes(p))),
    ).length,
    crossProductsTotal: c.crossProducts.length,
    mustNotContainHits: c.mustNotContain.flatMap((p) =>
      lowered.filter((t) => t.includes(p)).map((t) => ({ topic: t, pattern: p })),
    ),
  };
}
