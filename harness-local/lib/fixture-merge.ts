// harness-local — pure merge for adding publication fields to a frozen goldset
// fixture without disturbing the labels.
//
// A goldset's ids and verdicts are load-bearing (they ARE the label set —
// see goldset-348.json's `_provenance.adjudication`), so this merge only ever
// ADDS `publicationName`/`languageCode` by id; it never re-derives, drops, or
// reorders a row, and it throws rather than write a fixture whose labels moved.

export interface FixtureArticleCore {
  articleId: string;
  verdict?: string | null;
  jComp?: number | null;
  v1Relevance?: number | null;
  publicationName?: string | null;
  languageCode?: string | null;
  // Every other fixture field (title, description, countryCode,
  // relatedFacts, ...) rides through untouched via the spread below.
  [key: string]: unknown;
}

export interface FetchedPublicationInfo {
  articleId: string;
  publicationName: string | null;
  languageCode: string | null;
}

export interface MergePublicationFieldsResult {
  articles: FixtureArticleCore[];
  /** Ids in `existing` for which `fetched` carried a row. Staging retention is
   *  days, not the weeks-to-months a frozen goldset can sit for, so this is
   *  routinely well below `total` — the caller must report it, never assume a
   *  full match. */
  matched: number;
  total: number;
  unmatchedIds: string[];
}

/**
 * Merges publication fields by `articleId`. Never changes row count, id set,
 * `verdict`, `jComp`, or `v1Relevance` — throws instead of returning a
 * fixture where any of those moved, since a fixture with a silently-shifted
 * label is worse than a merge that refused to run.
 */
export function mergePublicationFields(
  existing: FixtureArticleCore[],
  fetched: FetchedPublicationInfo[],
): MergePublicationFieldsResult {
  const byId = new Map(fetched.map((f) => [f.articleId, f]));
  const unmatchedIds: string[] = [];
  let matched = 0;

  const merged = existing.map((row) => {
    const hit = byId.get(row.articleId);
    if (!hit) {
      unmatchedIds.push(row.articleId);
      return row;
    }
    matched += 1;
    return { ...row, publicationName: hit.publicationName, languageCode: hit.languageCode };
  });

  if (merged.length !== existing.length) {
    throw new Error(
      `harness-local: mergePublicationFields changed row count (${existing.length} -> ${merged.length}), refusing to write.`,
    );
  }
  for (let i = 0; i < existing.length; i++) {
    const before = existing[i];
    const after = merged[i];
    if (before.articleId !== after.articleId) {
      throw new Error(
        `harness-local: mergePublicationFields reordered row ${i} (${before.articleId} -> ${after.articleId}), refusing to write.`,
      );
    }
    if (
      (before.verdict ?? null) !== (after.verdict ?? null) ||
      (before.jComp ?? null) !== (after.jComp ?? null) ||
      (before.v1Relevance ?? null) !== (after.v1Relevance ?? null)
    ) {
      throw new Error(
        `harness-local: mergePublicationFields altered a labelled field on ${before.articleId}, refusing to write.`,
      );
    }
  }

  return { articles: merged, matched, total: existing.length, unmatchedIds };
}
