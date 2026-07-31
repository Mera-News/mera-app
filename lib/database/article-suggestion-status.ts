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
//
//   unscored ─┐ a HARD "not interested" filter matched
//             ▼
//   excluded        TERMINAL. The user asked never to see this; it was screened
//                   out before any math/judge/reason work, so it carries
//                   relevance 0, no reason, and no scores. It is deliberately
//                   NOT `complete`: `complete` means "we scored it and it lost",
//                   `excluded` means "we never scored it, by request", and the
//                   two must stay distinguishable in the feed funnel.
//
//                   The ONE documented exit: retiring the filter that caused it
//                   (or unmuting the publication) runs the un-exclude sweep,
//                   which re-screens the row against every STILL-ACTIVE hard
//                   filter and, only if nothing else matches, resets it to
//                   `unscored` so it is scored fresh. It is never resurrected
//                   directly as a scored row.
//
// A row can be written `excluded` from `unscored` (the scoring orchestrators)
// or from any status (the retroactive purge sweep).
export const ArticleSuggestionStatus = {
  Unscored: 'unscored',
  ReasonPending: 'reason_pending',
  Complete: 'complete',
  Excluded: 'excluded',
} as const;

export type ArticleSuggestionStatus =
  (typeof ArticleSuggestionStatus)[keyof typeof ArticleSuggestionStatus];
