// scoring-engine — the ONE kind-aware suppression matcher.
//
// Pure, RN-free. Both suppression paths run through here so they can never
// diverge:
//
//   - SOFT (strength < HARD_SUPPRESSION_STRENGTH) → a capped score penalty,
//     applied by relevance.ts::suppressionPenalty.
//   - HARD (strength ≥ HARD_SUPPRESSION_STRENGTH) → the candidate is screened
//     OUT before any math/judge work (screenHardSuppressions), invoked from
//     both orchestrator convergence points.
//
// The hard/soft partition itself happens ONCE, in the RN-side persona loader
// (mera-protocol/stage-scoring::loadPersonaScoringContext) — this module only
// matches whatever list it is handed. There is deliberately no new harness
// config constant: the threshold is a database-service concern, not a tunable
// scoring weight.
//
// BYTE-IDENTITY CONTRACT: for `keyword` (and NULL-kind, which reads as
// keyword) suppressions this module reproduces the historical matcher exactly —
// normalized substring over `title + '  ' + description + '  ' + entities`,
// with the `kk.length > 0` guard that makes a blank keyword match NOTHING
// (`haystack.includes('')` would otherwise be true for every article). A
// 1000-article corpus diff gates this; do not "simplify" the guard away.

import { normText, normCountry, type SoftSuppression } from './persona-context';
// Type-only (erased at runtime) — keeps relevance.ts ⇄ suppression.ts free of
// a real import cycle while relevance.ts imports the matcher for real.
import type { ScoredCandidateInput } from './relevance';

/** Every kind that compares against the single `value` column. Anything not in
 *  here (including a kind a NEWER build wrote) falls back to keyword. */
const STRUCTURED_KINDS: ReadonlySet<string> = new Set([
  'category',
  'event_type',
  'entity',
  'publication',
  'place',
  'topic',
]);

/**
 * The haystack the `keyword` kind matches against: normalized title,
 * description and entities joined by two spaces. Reproduced byte-for-byte from
 * the pre-wave inline implementation in relevance.ts.
 */
export function buildSuppressionHaystack(candidate: ScoredCandidateInput): string {
  return [
    normText(candidate.titleEn ?? ''),
    normText(candidate.descriptionEn ?? ''),
    ...(candidate.entities ?? []).map(normText),
  ].join('  ');
}

/** Historical keyword semantics: any non-empty keyword as a normalized
 *  substring of the haystack. */
function matchesKeywords(keywords: string[] | undefined, haystack: string): boolean {
  if (!keywords?.length) return false;
  return keywords.some((k) => {
    const kk = normText(k);
    return kk.length > 0 && haystack.includes(kk);
  });
}

/**
 * Does this suppression match this candidate?
 *
 * `haystack` is an optional precomputed `buildSuppressionHaystack(candidate)` —
 * pass it when screening one candidate against many suppressions.
 *
 * An empty/absent `value` on a non-keyword kind matches NOTHING (never
 * everything) — the same defensive posture as the blank-keyword guard.
 * An unknown/future `kind` falls back to keyword semantics when the row has
 * keywords, else matches nothing. This function never throws.
 */
export function suppressionMatchesCandidate(
  candidate: ScoredCandidateInput,
  s: SoftSuppression,
  haystack?: string,
): boolean {
  const kind = s.kind ?? 'keyword';

  // keyword (incl. NULL kind) — and any unknown/future kind, which degrades to
  // keyword semantics rather than throwing or blocking. Checked BEFORE the
  // empty-value guard so an unknown kind with keywords still matches.
  if (kind === 'keyword' || !STRUCTURED_KINDS.has(kind)) {
    return matchesKeywords(s.keywords, haystack ?? buildSuppressionHaystack(candidate));
  }

  const value = normText(s.value ?? '');
  if (value.length === 0) return false;

  switch (kind) {
    case 'category':
      return normText(candidate.category ?? '') === value;

    case 'event_type':
      return normText(candidate.eventType ?? '') === value;

    case 'entity':
      return (candidate.entities ?? []).some((e) => normText(e) === value);

    case 'publication':
      return normText(candidate.publicationName ?? '') === value;

    case 'place': {
      // Only the article's GEO TAGS count. The top-level countryCode is the
      // PUBLISHING country, not what the story is about — muting "France"
      // must not kill every AFP wire story.
      const country = normCountry(s.value ?? '');
      return (candidate.geoTags ?? []).some(
        (g) =>
          normText(g.city ?? '') === value ||
          normText(g.region ?? '') === value ||
          normCountry(g.countryCode ?? '') === country,
      );
    }

    case 'topic':
      return (candidate.matchedTopics ?? []).some(
        (t) => t.text != null && normText(t.text) === value,
      );

    default:
      // Unreachable (STRUCTURED_KINDS gate above), but exhaustive-safe.
      return false;
  }
}

/**
 * Screen a batch of candidates against the HARD filters.
 *
 * Returns candidateId → the user-facing display value of the FIRST matching
 * filter (`value` ?? `pattern` ?? first keyword), so the caller can log/report
 * *why* a row was dropped without re-running the match. Ids absent from the map
 * survive.
 */
export function screenHardSuppressions(
  candidates: ScoredCandidateInput[],
  hard: SoftSuppression[] | undefined,
): Map<string, string> {
  const excluded = new Map<string, string>();
  if (!hard?.length || !candidates.length) return excluded;
  for (const candidate of candidates) {
    const haystack = buildSuppressionHaystack(candidate);
    for (const s of hard) {
      if (suppressionMatchesCandidate(candidate, s, haystack)) {
        excluded.set(candidate.id, suppressionDisplayValue(s));
        break;
      }
    }
  }
  return excluded;
}

/** What to show the user for a filter: its structured value, else its pattern,
 *  else its first keyword, else a stable placeholder. */
export function suppressionDisplayValue(s: SoftSuppression): string {
  const value = (s.value ?? '').trim();
  if (value) return value;
  const pattern = (s.pattern ?? '').trim();
  if (pattern) return pattern;
  const keyword = (s.keywords ?? []).find((k) => (k ?? '').trim().length > 0);
  return keyword?.trim() ?? 'filter';
}
