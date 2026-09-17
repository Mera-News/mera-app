// mera-harness/eval — topic-set scoring, shared by Step A (the topic-prompt
// comparison) and G2 (the agent corpus). Pure.
//
// GATE ORDER IS LOAD-BEARING AND IT IS ENCODED HERE, not left to the caller's
// discretion. `scoreTopicRun` returns the gates in the order they must be read:
//
//   1. output integrity  - empty content / finish_reason
//   2. filter correctness - the place-name regression
//   3. S7                - within-set near duplicates, POST-FILTER (shipped)
//   4. everything else   - quality
//
// Because every quality number IMPROVES as output disappears. An arm that
// generated nothing has no duplicates, no em dashes, no over-long topics and a
// perfect S7 rate. Reading S7 before integrity rewards the arm that failed
// hardest, and reading it before filter correctness rewards a filter that
// bought its pass by eating ladder rungs.

import { filterNearDuplicates, type DedupeDrop, type DedupeResult } from '../core/topic-dedupe';
import { DETECT_JACCARD, contentJaccard, isSubsetTopic } from '../core/topic-similarity';
import type { Place } from './contract';

/**
 * The eval's OWN place vocabulary, for the eval's own check.
 *
 * Deliberately not core's `placeExclusionSet`. Gate 2 asks whether the shipped
 * filter damaged a ladder, and a check that borrows the filter's own notion of
 * a place name stops being independent of the thing it audits — it would go
 * quiet in exactly the case where the filter's definition is what is wrong.
 * Derived structurally from the fact's resolved chain, never from
 * capitalisation: this repo has already paid for that heuristic once, when it
 * stripped "Port" out of "Port of Rotterdam" and missed "Polish".
 */
function evalTokens(text: string, exclude: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const w of (text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w && !exclude.has(w)) out.add(w);
  }
  return out;
}

/** Jaccard with an exclusion set. Core dropped its `exclude` parameter when the
 *  place exclusion was removed from the shipped filter, but gate 2 still needs
 *  to ask "are these identical ONCE place words are ignored?" to detect a lost
 *  ladder rung. Eval-owned, for an eval-owned question. */
function evalJaccard(a: string, b: string, exclude: ReadonlySet<string>): number {
  const ta = evalTokens(a, exclude);
  const tb = evalTokens(b, exclude);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union === 0 ? 0 : shared / union;
}

function evalPlaceWords(place?: Place | null): ReadonlySet<string> {
  const out = new Set<string>();
  if (!place) return out;
  for (const field of [place.neighbourhood, place.locality, place.admin1, place.countryName]) {
    if (!field) continue;
    for (const word of field.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (word) out.add(word);
  }
  return out;
}
import { hasBannedDash, topicWordCountOk } from './copy-rules';

export interface TopicSetInput {
  factId: string;
  factStatement: string;
  factKind: string;
  placeChain?: Place | null;
  topics: string[];
  /** What the persona already holds, and what they have declined. Both are
   *  hard exclusions the skill bodies state explicitly. */
  existingTopics: readonly string[];
  declinedTopics: readonly string[];
  rawOutput: string;
  finishReason: string;
}

// ---------------------------------------------------------------------------
// Gate 1: output integrity
// ---------------------------------------------------------------------------

export interface IntegrityReport {
  calls: number;
  emptyContent: number;
  emptyRate: number;
  /**
   * NON-EMPTY output that yielded NO topics: the model wrote prose where the
   * contract wants a bare JSON array.
   *
   * ADDED BECAUSE THE PRE-REGISTERED GATE MISSED IT. The gate was worded as an
   * EMPTY-CONTENT rate, and measured 0.0% on an arm that was failing to
   * produce a usable topic set on 42% of calls: the bytes were there, the
   * shape was wrong. "Returned nothing" and "returned something unusable" are
   * the same outcome downstream and only one of them was being counted.
   */
  unparsedOutput: number;
  unparsedRate: number;
  /** No usable set, by either route. This is the number that matters. */
  noUsableSetRate: number;
  finishReasons: Record<string, number>;
  /** The gate AS PRE-REGISTERED: empty content above 2%. Kept exactly as
   *  agreed rather than silently widened, so the record stays honest. */
  passed: boolean;
  /** GATE 1b, at NO_USABLE_SET_GATE. Reported ALONGSIDE `passed`, never
   *  instead of it: the original wording stays on the record as agreed. */
  passedOnUsableSets: boolean;
}

export const EMPTY_CONTENT_GATE = 0.02;

/**
 * GATE 1b, PRE-REGISTERED FOR THE RE-RUN: no usable topic set, at or below 5%.
 *
 * Promoted from a reported number to a gate because the original wording
 * proved to be the wrong instrument: it asked for EMPTY CONTENT and read 0.0%
 * on an arm that produced no usable set on 42% of calls, the model having
 * written reasoning prose where the contract wants a bare JSON array. Empty
 * and unusable are the same outcome downstream.
 *
 * 5% rather than the 2% of the empty-content gate: this one counts a
 * strictly larger class of failure, and the number is fixed here BEFORE the
 * re-run rather than chosen once its table is visible.
 */
export const NO_USABLE_SET_GATE = 0.05;

export function integrityReport(sets: readonly TopicSetInput[]): IntegrityReport {
  const finishReasons: Record<string, number> = {};
  let emptyContent = 0;
  let unparsedOutput = 0;
  for (const s of sets) {
    finishReasons[s.finishReason] = (finishReasons[s.finishReason] ?? 0) + 1;
    const blank = s.rawOutput.trim().length === 0;
    if (blank) emptyContent += 1;
    else if (s.topics.length === 0) unparsedOutput += 1;
  }
  const n = sets.length;
  const emptyRate = n === 0 ? 0 : emptyContent / n;
  const unparsedRate = n === 0 ? 0 : unparsedOutput / n;
  return {
    calls: n,
    emptyContent,
    emptyRate,
    unparsedOutput,
    unparsedRate,
    noUsableSetRate: emptyRate + unparsedRate,
    finishReasons,
    passed: emptyRate <= EMPTY_CONTENT_GATE,
    passedOnUsableSets: emptyRate + unparsedRate <= NO_USABLE_SET_GATE,
  };
}

// ---------------------------------------------------------------------------
// Gate 2: filter correctness
// ---------------------------------------------------------------------------

/** P1's filter, re-exported rather than reimplemented. An eval that carries
 *  its own copy of the rule it is measuring stops measuring the shipped one
 *  the first time either side is edited. */
export type FilterDrop = DedupeDrop;
export type FilterResult = DedupeResult;
export const applyShippedFilter = filterNearDuplicates;

export interface FilterCorrectness {
  dropped: number;
  /** THE OLD DEDUPE'S FAILURE: a pair dropped whose only shared content was a
   *  place name. With the exclusion wired up this is impossible by
   *  construction, which is why it is a regression test rather than a
   *  discovery metric: it asserts the exclusion is applied, and its control is
   *  that with the exclusion removed the same pair DOES drop. */
  droppedOnPlaceNameAlone: FilterDrop[];
  /**
   * THE INVERSE FAILURE, KEPT AS INSURANCE AND CURRENTLY UNREACHABLE.
   *
   * When the filter excluded place names, two topics differing ONLY by rung
   * collapsed into one token set: "Barcelona rail strikes" and "Spain rail
   * strikes" both became {rail, strikes}, Jaccard 1.000, and the country rung
   * was dropped. That exclusion has been removed, so the pair now scores 0.5
   * and both survive.
   *
   * SAY PLAINLY WHAT THIS IS NOW. With no exclusion, a pair differing by one
   * token each cannot reach 0.75 at any topic length the 2-to-5 word rule
   * permits, so this list can no longer be produced by the shipped filter. It
   * is NOT an active gate and must not be quoted as one. It stays because it
   * costs nothing and because a reintroduced exclusion would revive the bug
   * silently; `droppedOnPlaceNameAlone` is the direction that remains live.
   */
  droppedDifferingOnlyByPlace: FilterDrop[];
  passed: boolean;
}

export function filterCorrectness(
  topics: readonly string[],
  placeChain?: Place | null,
): FilterCorrectness {
  const withExclusion = applyShippedFilter(topics);
  const placeWords = evalPlaceWords(placeChain);

  const droppedOnPlaceNameAlone = withExclusion.dropped.filter(
    (d) => d.overlap.length > 0 && d.overlap.every((w) => placeWords.has(w)),
  );

  // Identical ONLY once place words are removed: the two topics are distinct
  // rungs of one ladder and the filter could not tell them apart.
  const droppedDifferingOnlyByPlace = withExclusion.dropped.filter(
    (d) =>
      evalJaccard(d.topic, d.duplicateOf, placeWords) === 1 &&
      evalJaccard(d.topic, d.duplicateOf, new Set()) < 1,
  );

  return {
    dropped: withExclusion.dropped.length,
    droppedOnPlaceNameAlone,
    droppedDifferingOnlyByPlace,
    passed: droppedOnPlaceNameAlone.length === 0 && droppedDifferingOnlyByPlace.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Gate 3: S7, within-set near duplicates
// ---------------------------------------------------------------------------

export interface S7Report {
  /** The SHIPPED configuration: the filter ships ON, so this is the gated
   *  number. */
  postFilterRate: number;
  postFilterFlagged: number;
  /** The diagnostic. It separates two states the gate alone cannot: a
   *  generator that produced a clean set, and one rescued by the filter. */
  rawRate: number;
  rawFlagged: number;
  topics: number;
  /** Broken out by how many topics the call returned, because near-duplication
   *  is a COUNT effect first: measured ~40% at a requested total of 10 against
   *  ~10% at 4, dwarfing anything a prompt edit moved. A gate that failed at a
   *  high count and passed at a low one is a count result. */
  requestedCount: number;
}

export const S7_GATE = 0.1;

/** Fraction of topics that near-duplicate an EARLIER topic in the same set. */
export function nearDuplicateRate(topics: readonly string[]): { rate: number; flagged: number } {
  let flagged = 0;
  for (let i = 0; i < topics.length; i++) {
    for (let j = 0; j < i; j++) {
      if (
        contentJaccard(topics[i], topics[j]) >= DETECT_JACCARD ||
        isSubsetTopic(topics[i], topics[j]) ||
        isSubsetTopic(topics[j], topics[i])
      ) {
        flagged += 1;
        break;
      }
    }
  }
  return { rate: topics.length === 0 ? 0 : flagged / topics.length, flagged };
}

export function s7Report(set: TopicSetInput): S7Report {
  // The detector judges two topics the way a READER sees them, and a place
  // name is content to a reader. Core dropped its exclusion entirely, so the
  // two now agree on tokens and differ only where they are meant to: the
  // filter at 0.75 with no subset rule, the detector at 0.6 or on a subset.
  const raw = nearDuplicateRate(set.topics);
  const kept = applyShippedFilter(set.topics).kept;
  const post = nearDuplicateRate(kept);
  return {
    postFilterRate: post.rate,
    postFilterFlagged: post.flagged,
    rawRate: raw.rate,
    rawFlagged: raw.flagged,
    topics: set.topics.length,
    requestedCount: set.topics.length,
  };
}

// ---------------------------------------------------------------------------
// Gate 4: the shared quality rules
// ---------------------------------------------------------------------------

export interface SharedRuleReport {
  topics: number;
  duplicatesOfExisting: string[];
  duplicatesOfDeclined: string[];
  wordCountViolations: string[];
  bannedDash: string[];
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

export function sharedRules(set: TopicSetInput): SharedRuleReport {
  const existing = new Set(set.existingTopics.map(norm));
  const declined = new Set(set.declinedTopics.map(norm));
  return {
    topics: set.topics.length,
    duplicatesOfExisting: set.topics.filter((t) => existing.has(norm(t))),
    duplicatesOfDeclined: set.topics.filter((t) => declined.has(norm(t))),
    wordCountViolations: set.topics.filter((t) => !topicWordCountOk(t)),
    bannedDash: set.topics.filter((t) => hasBannedDash(t)),
  };
}


// ---------------------------------------------------------------------------
// Count-matched ladder comparison
// ---------------------------------------------------------------------------

/**
 * Score the ladder on cells where EVERY compared arm returned a set.
 *
 * WHY, AND IT IS NOT A DETAIL. Scoring each arm over whatever it happened to
 * produce gives the arms different denominators, and an arm that fails to
 * return a set on half its calls is then judged on the half it managed. Step A
 * round 1: the skill arm scored 33 rung-slots against one-shot's 63, so its
 * 75.8% was measured over a remnant roughly half the size and was not
 * comparable to the control's 88.9% at all.
 *
 * The dropout is itself a finding, which is what gate 1b is for. It must not
 * ALSO be allowed to flatter the quality number, so the unmatched count is
 * returned and the caller prints it beside the comparison.
 */
export interface ArmSetEntry {
  arm: string;
  /** Identifies the work unit, typically `${factId}|${repeat}`. */
  key: string;
  set: TopicSetInput;
}

export interface MatchedLadderReport {
  matchedCells: number;
  unmatchedCells: number;
  /** Which arm dropped out on each unmatched cell, so the dropout stays
   *  attributable rather than becoming a single excluded count. */
  droppedByArm: Record<string, number>;
  perArm: Record<
    string,
    {
      rungsCovered: number;
      rungsTotal: number;
      fieldGenericPresent: number;
      fieldGenericCases: number;
      /**
       * HOW MANY TOPICS THE ARM ACTUALLY PRODUCED, on the matched cells.
       *
       * The original user complaint was "too few, too local, no ladder, no
       * field-generic", and the first three gates and both floors measure the
       * last three while saying NOTHING about the first. An arm can cover
       * every rung with one topic each and still leave a thin feed.
       *
       * Counted on the MATCHED cells only, like everything else here, so the
       * arms are compared over the same work. A mean over whatever each arm
       * returned would reward the arm that skipped the hard facts.
       */
      topicsTotal: number;
      cells: number;
      /** Per-cell counts, kept so a median can be taken: a mean over topic
       *  counts is pulled around by one long set. */
      perCellCounts: number[];
    }
  >;
}

export function countMatchedLadder(
  entries: readonly ArmSetEntry[],
  scoreOne: (set: TopicSetInput) => {
    rungsCovered: number;
    rungsTotal: number;
    fieldGenericPresent: boolean | null;
  } | null,
): MatchedLadderReport {
  const arms = [...new Set(entries.map((e) => e.arm))];
  const byKey = new Map<string, Map<string, TopicSetInput>>();
  for (const e of entries) {
    const m = byKey.get(e.key) ?? new Map<string, TopicSetInput>();
    m.set(e.arm, e.set);
    byKey.set(e.key, m);
  }

  const perArm: MatchedLadderReport['perArm'] = {};
  for (const a of arms) {
    perArm[a] = {
      rungsCovered: 0, rungsTotal: 0, fieldGenericPresent: 0, fieldGenericCases: 0,
      topicsTotal: 0, cells: 0, perCellCounts: [],
    };
  }
  const droppedByArm: Record<string, number> = {};
  let matchedCells = 0;
  let unmatchedCells = 0;

  for (const [, m] of byKey) {
    const missing = arms.filter((a) => (m.get(a)?.topics.length ?? 0) === 0);
    if (missing.length > 0) {
      unmatchedCells += 1;
      for (const a of missing) droppedByArm[a] = (droppedByArm[a] ?? 0) + 1;
      continue;
    }
    matchedCells += 1;
    for (const a of arms) {
      const set = m.get(a) as TopicSetInput;
      perArm[a].topicsTotal += set.topics.length;
      perArm[a].cells += 1;
      perArm[a].perCellCounts.push(set.topics.length);
      const scored = scoreOne(set);
      if (!scored) continue;
      perArm[a].rungsCovered += scored.rungsCovered;
      perArm[a].rungsTotal += scored.rungsTotal;
      if (scored.fieldGenericPresent !== null) {
        perArm[a].fieldGenericCases += 1;
        if (scored.fieldGenericPresent) perArm[a].fieldGenericPresent += 1;
      }
    }
  }
  return { matchedCells, unmatchedCells, droppedByArm, perArm };
}
