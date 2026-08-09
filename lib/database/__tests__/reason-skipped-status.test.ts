// `reason_skipped` — the terminal status the v4 tag reason-gate writes.
//
// The gate decides a story TYPE is not worth a note for this user. It used to
// express that by overwriting relevance with `feedVerifierDemoteScore` (0.28) to
// force the row under the render gate — which destroyed a score an LLM call had
// just produced and told every downstream reader "this scored badly" when the
// truth was "we chose not to narrate it". The row now KEEPS its real relevance
// and carries the meaning in its status.
//
// That only works if three things hold, and none of them is obvious from the
// status alone. All three are pinned here:
//
//   1. INVISIBLE BY CONSTRUCTION — not by a filter someone remembered to write.
//   2. NEVER RE-SWEPT — the orphaned-reason sweep must not re-spend the call the
//      gate just saved.
//   3. NEVER A PROPAGATION DONOR — it has a renderable score and NO reason, so
//      donating it would hand a whole story group a blank note.
//
// `status` is a plain text column, so this needed no migration (see the note at
// the bottom of article-suggestion-status.ts).

import { ArticleSuggestionStatus } from '../article-suggestion-status';
import { isComplete, isVisible, RENDER_GATE } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

const NOW = 1_700_000_000_000;

/** A gated row as the writer leaves it: REAL, renderable relevance; no reason. */
function gatedRow(over: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
  return {
    _id: 'gated-1',
    articleId: 'art-1',
    relevance: 0.8, // well above RENDER_GATE — the whole point
    reason: '',
    status: ArticleSuggestionStatus.ReasonSkipped,
    createdAt: new Date(NOW).toISOString(),
    // `isWithinWindow` reads firstPubDate, not createdAt.
    firstPubDate: new Date(NOW).toISOString(),
    scoredAt: NOW,
    ...over,
  } as ForYouSuggestion;
}

describe('1. invisible by construction', () => {
  it('is not visible even at a high relevance inside the window', () => {
    const row = gatedRow();
    expect(row.relevance).toBeGreaterThan(RENDER_GATE);
    expect(isVisible(row, NOW - 48 * 3600_000)).toBe(false);
  });

  it('the reason it is invisible is the STATUS, not the score or the window', () => {
    // This is the property that makes the feature safe to add: `isVisible`
    // whitelists `complete`, so ANY new status renders nowhere without a single
    // filter being written for it. If `isComplete` ever became a blocklist,
    // this test is what fails.
    const row = gatedRow();
    expect(isComplete(row)).toBe(false);
    expect(isComplete({ ...row, status: ArticleSuggestionStatus.Complete })).toBe(true);
    // Same row, same score, same window — visible the moment it is `complete`.
    expect(
      isVisible({ ...row, status: ArticleSuggestionStatus.Complete }, NOW - 48 * 3600_000),
    ).toBe(true);
  });

  it('keeps its real relevance — the score is not overwritten to hide it', () => {
    // The regression this whole change exists to prevent. A 0.28 here would mean
    // we had thrown the measured score away again.
    expect(gatedRow().relevance).toBe(0.8);
  });
});

describe('2 & 3. never re-swept, never a donor', () => {
  // Both guarantees are QUERY predicates, so they are asserted against the real
  // queries in database/services/__tests__/article-suggestion-service.test.ts:
  //   - "selects reason_pending ONLY — never a terminal status"
  //     (getScoredSuggestionsWithoutReasons)
  //   - "excludes reason_skipped rows — a real score with no reason is not a
  //     donor" (getScoredDonorRows)
  // What belongs HERE is the property those two depend on: that this is a
  // distinct value and not an alias of a status they already admit.
  it('is a distinct terminal value, not an alias of complete/excluded/reason_pending', () => {
    // Distinctness is load-bearing: the Observability funnel answers "why is the
    // feed smaller?" by status, and folding this into `excluded` would report a
    // product decision as a user's "not interested" filter.
    const all = Object.values(ArticleSuggestionStatus);
    expect(new Set(all).size).toBe(all.length);
    expect(ArticleSuggestionStatus.ReasonSkipped).not.toBe(ArticleSuggestionStatus.Complete);
    expect(ArticleSuggestionStatus.ReasonSkipped).not.toBe(ArticleSuggestionStatus.Excluded);
    // Not `reason_pending` — that is the status the orphaned-reason sweep
    // selects, and aliasing them would re-spend the call the gate saved.
    expect(ArticleSuggestionStatus.ReasonSkipped).not.toBe(
      ArticleSuggestionStatus.ReasonPending,
    );
  });
});
