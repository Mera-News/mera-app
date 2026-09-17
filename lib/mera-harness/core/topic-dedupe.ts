// mera-harness/core — within-set near-duplicate filter. PURE, RN-free.
//
// Ships ON. The skill text is the first line of defence; this is the
// deterministic fallback behind it, and an arm switches it off for measurement
// (the switch lives at the CALL SITE, so this function has exactly one
// behaviour and the eval can apply it offline to collected output).

import {
  FILTER_DROP_JACCARD,
  contentJaccard,
  placeExclusionSet,
  sharedTokens,
} from './topic-similarity';

export interface DedupeDrop {
  topic: string;
  duplicateOf: string;
  /** The shared content words, not a score: a filter that reports "removed 3"
   *  cannot be audited, and a reader needs to see whether the 3 were real
   *  duplicates or ladder rungs. */
  overlap: string[];
}

export interface DedupeResult {
  kept: string[];
  dropped: DedupeDrop[];
}

/**
 * Drop a topic whose content-word Jaccard with an EARLIER KEPT topic is
 * >= FILTER_DROP_JACCARD (0.75).
 *
 * Earlier-kept, not pairwise-any, so the first occurrence always survives and
 * the output is order-deterministic.
 *
 * NEVER a subset rule. A ladder deliberately emits rungs that contain each
 * other, so dropping a topic because its tokens are a subset of a sibling's
 * kills exactly the structure the skill bodies exist to produce. The eval
 * scorer flags subsets; this filter does not act on them, and that gap is
 * deliberate (see topic-similarity.ts).
 *
 * Fails OPEN: anything it cannot judge comes back whole.
 */
export function filterNearDuplicates(
  topics: readonly string[],
  placeChain?: Parameters<typeof placeExclusionSet>[0],
): DedupeResult {
  const exclude = placeExclusionSet(placeChain);
  const kept: string[] = [];
  const dropped: DedupeDrop[] = [];

  for (const topic of topics) {
    const text = (topic ?? '').trim();
    if (!text) continue;
    let collidedWith: string | null = null;
    for (const earlier of kept) {
      if (contentJaccard(text, earlier, exclude) >= FILTER_DROP_JACCARD) {
        collidedWith = earlier;
        break;
      }
    }
    if (collidedWith) {
      dropped.push({
        topic: text,
        duplicateOf: collidedWith,
        overlap: sharedTokens(text, collidedWith, exclude),
      });
    } else {
      kept.push(text);
    }
  }

  return { kept, dropped };
}
