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
//   excluded        TERMINAL — "this must never render", written by TWO causes:
//
//                   (a) HARD FILTER. The user asked never to see this; it was
//                   screened out before any math/judge/reason work, so it
//                   carries relevance 0, no reason, and no scores. It is
//                   deliberately NOT `complete`: `complete` means "we scored it
//                   and it lost", this means "we never scored it, by request",
//                   and the two must stay distinguishable in the feed funnel.
//
//                   (b) LOW-BAND HEADLINE CULL. A top-headline row
//                   (`headline_scope` set) whose SCORED relevance falls below
//                   the MEDIUM band — see
//                   lib/feed-ordering/importance-filter::isCulledHeadlineRelevance.
//                   Headlines exist to surface what matters in a region, so a
//                   LOW one is noise on every surface. Unlike (a) this row WAS
//                   scored; its scores are zeroed on the way in.
//
//                   The two are separable without a new column: headline rows
//                   are P6-EXEMPT from hard-filter exclusion, so (a) can never
//                   produce a row with `headline_scope` set and (b) always does.
//
//                   The ONE documented exit, and it belongs to (a) alone:
//                   retiring the filter that caused it (or unmuting the
//                   publication) runs the un-exclude sweep, which re-screens the
//                   row against every STILL-ACTIVE hard filter and, only if
//                   nothing else matches, resets it to `unscored` so it is
//                   scored fresh. It is never resurrected directly as a scored
//                   row. The sweep skips headline rows, so (b) has no exit —
//                   re-scoring one would only reproduce the same LOW verdict.
//
// A row can be written `excluded` from `unscored` (the scoring orchestrators)
// or from any status (the retroactive purge sweep).
//
//   unscored ─┐ the user ALREADY READ this story
//             ▼
//   already_read    TERMINAL — "this must never render", and deliberately NOT
//                   `excluded`, even though both are terminal-invisible:
//                   `excluded` means the user asked never to see this KIND of
//                   thing (a hard "not interested" filter), whereas this means
//                   they already tapped THIS story open and do not need it again.
//                   Keeping them apart is what lets the Observability funnel
//                   answer "why is the feed smaller?" — a hard filter is a
//                   standing preference, a read is a one-off — and stops the
//                   un-exclude sweep (which re-screens against still-active hard
//                   filters) from resurrecting rows it has no business touching.
//
//                   Written PRE-SCORING, by the two apply points of the
//                   already-read gate — feed-sync hydration and
//                   `gateUnscoredForScoring` — so the row is never sent to the
//                   LLM at all (see lib/feed-grouping/read-story-filter.ts for
//                   the matching rules and the measurements behind them). Like
//                   (a) above it carries relevance 0, no reason and no scores.
//
//                   NO EXIT. A read is a fact about the past; re-scoring the row
//                   would only re-derive the same "already read" verdict. The
//                   underlying impression TTLs out after 30 days, but the
//                   suggestion row is deleted by the 48h suggestion TTL long
//                   before that, so nothing accumulates.
//
//   reason_pending ─┐ the v4 tag reason-gate decided this story type is not
//                   │ worth a note for this user
//                   ▼
//   reason_skipped  TERMINAL — "we chose not to write a note", and deliberately
//                   NOT `complete`, `excluded` or a low score.
//
//                   It KEEPS ITS REAL RELEVANCE. That is the whole point: the
//                   row was scored by an LLM call we already paid for, and the
//                   gate is a decision about the NOTE, not about the score.
//                   This status used to be expressed by overwriting relevance
//                   with `feedVerifierDemoteScore` (0.28) — which destroyed the
//                   measured score and told every downstream reader "this scored
//                   badly" when what actually happened was "we declined to
//                   narrate it".
//
//                   NOT `complete`: a complete row renders, and a row with no
//                   note has nothing to show under its headline. Invisibility is
//                   BY CONSTRUCTION rather than by a filter — `isVisible` in
//                   stores/fact-rows-selector.ts requires `status === complete`,
//                   so a new status renders nowhere without anyone writing a
//                   rule. NOT `excluded`: the user asked for none of this; the
//                   product did, and conflating the two would corrupt the
//                   Observability funnel's "why is the feed smaller?" answer and
//                   expose the row to the un-exclude sweep.
//
//                   NO EXIT, and two queries enforce it:
//                   `getScoredSuggestionsWithoutReasons` selects `reason_pending`
//                   ONLY, so the orphaned-reason sweep can never re-elect it and
//                   re-spend the call the gate just saved; and
//                   `getScoredDonorRows` excludes it, so its real-but-noteless
//                   score is never propagated onto same-story siblings (which
//                   would hand a whole group a renderable score with a blank
//                   note — see lib/feed-grouping/score-propagation.ts).
//
// NOTE FOR SCHEMA WORK: `status` is a plain text column, so adding a value here
// needs NO migration — do not DROP+recreate `article_suggestions` for it.
export const ArticleSuggestionStatus = {
  Unscored: 'unscored',
  ReasonPending: 'reason_pending',
  Complete: 'complete',
  Excluded: 'excluded',
  AlreadyRead: 'already_read',
  ReasonSkipped: 'reason_skipped',
} as const;

export type ArticleSuggestionStatus =
  (typeof ArticleSuggestionStatus)[keyof typeof ArticleSuggestionStatus];
