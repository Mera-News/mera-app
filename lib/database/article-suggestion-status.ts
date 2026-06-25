// Article-suggestion pipeline state machine.
//
// A single `status` column on `article_suggestions` replaces the old pair of
// `relevance_generation_completed` / `reason_generation_completed` booleans —
// they encoded one finite-state machine smeared across two columns (and allowed
// impossible combinations like relevance-incomplete + reason-complete).
//
// Lifecycle:
//   unscored        relevance not generated yet (initial state)
//        │  relevance scored
//        ▼
//   reason_pending  scored; reason generation pending / in flight (UI: loading
//        │          dots). Stays here when a reason attempt fails — the retry
//        │          sweep re-fetches it, and pipeline-level failures are
//        │          surfaced to the user as a toast (see runScoringPass).
//        │ reason ok
//        ▼
//   complete        terminal; covers both "reason text present" and "reason
//                   deliberately skipped" (sub-threshold / ineligible) — the
//                   presence of reason text decides whether the card shows the
//                   reason or its fact chips.
export const ArticleSuggestionStatus = {
  Unscored: 'unscored',
  ReasonPending: 'reason_pending',
  Complete: 'complete',
} as const;

export type ArticleSuggestionStatus =
  (typeof ArticleSuggestionStatus)[keyof typeof ArticleSuggestionStatus];
