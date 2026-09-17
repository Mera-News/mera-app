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
import {
  DETECT_JACCARD,
  contentJaccard,
  isSubsetTopic,
  placeExclusionSet,
} from '../core/topic-similarity';
import type { Place } from './contract';
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
  finishReasons: Record<string, number>;
  /** Pre-registered: empty above 2% is a hard fail. */
  passed: boolean;
}

export const EMPTY_CONTENT_GATE = 0.02;

export function integrityReport(sets: readonly TopicSetInput[]): IntegrityReport {
  const finishReasons: Record<string, number> = {};
  let emptyContent = 0;
  for (const s of sets) {
    finishReasons[s.finishReason] = (finishReasons[s.finishReason] ?? 0) + 1;
    if (s.rawOutput.trim().length === 0) emptyContent += 1;
  }
  const emptyRate = sets.length === 0 ? 0 : emptyContent / sets.length;
  return {
    calls: sets.length,
    emptyContent,
    emptyRate,
    finishReasons,
    passed: emptyRate <= EMPTY_CONTENT_GATE,
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
   * THE NEW FILTER'S OWN FAILURE, and it is the INVERSE of the one above.
   *
   * Excluding place names collapses two topics that differ ONLY by their rung
   * into the same token set. "Barcelona rail strikes" and "Spain rail strikes"
   * both reduce to {rail, strikes}, Jaccard 1.000, so the filter drops the
   * country rung — the exact ladder damage the exclusion was added to prevent,
   * now caused by it. MEASURED, not hypothesised: see the fixture in
   * __tests__/topic-metrics.test.ts.
   *
   * The residence guideline makes this reachable rather than exotic: it asks
   * for a transport topic at the city rung AND one at the country rung, so a
   * model that words them alike loses one while following the instruction.
   */
  droppedDifferingOnlyByPlace: FilterDrop[];
  passed: boolean;
}

export function filterCorrectness(
  topics: readonly string[],
  placeChain?: Place | null,
): FilterCorrectness {
  const withExclusion = applyShippedFilter(topics, placeChain);
  const placeWords = placeExclusionSet(placeChain ?? null);

  const droppedOnPlaceNameAlone = withExclusion.dropped.filter(
    (d) => d.overlap.length > 0 && d.overlap.every((w) => placeWords.has(w)),
  );

  // Identical ONLY once place words are removed: the two topics are distinct
  // rungs of one ladder and the filter could not tell them apart.
  const droppedDifferingOnlyByPlace = withExclusion.dropped.filter(
    (d) =>
      contentJaccard(d.topic, d.duplicateOf, placeWords) === 1 &&
      contentJaccard(d.topic, d.duplicateOf, new Set()) < 1,
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
export function nearDuplicateRate(
  topics: readonly string[],
  exclude: ReadonlySet<string>,
): { rate: number; flagged: number } {
  let flagged = 0;
  for (let i = 0; i < topics.length; i++) {
    for (let j = 0; j < i; j++) {
      if (
        contentJaccard(topics[i], topics[j], exclude) >= DETECT_JACCARD ||
        isSubsetTopic(topics[i], topics[j], exclude) ||
        isSubsetTopic(topics[j], topics[i], exclude)
      ) {
        flagged += 1;
        break;
      }
    }
  }
  return { rate: topics.length === 0 ? 0 : flagged / topics.length, flagged };
}

export function s7Report(set: TopicSetInput): S7Report {
  const exclude = placeExclusionSet(set.placeChain ?? null);
  const raw = nearDuplicateRate(set.topics, exclude);
  const kept = applyShippedFilter(set.topics, set.placeChain).kept;
  const post = nearDuplicateRate(kept, exclude);
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
