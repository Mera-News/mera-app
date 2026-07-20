// Triage-mode tuning knobs (app-rethink wave, the one-card review surface).
//
// These are the per-verdict topic-weight nudges applied when the user gives a
// Good/Bad verdict on a card in triage. They are deliberately SMALL and
// ASYMMETRIC toward the negative signal (a Bad pushes harder than a Good pulls)
// — a calibration-era default while we watch how a single explicit tap should
// move the persona. Runaway loops are impossible: every nudge routes through
// `applyPersonaAction` → mutation-rails, whose daily per-topic budget clamps the
// cumulative effect regardless of how many cards the user triages.
export const TRIAGE_GOOD_DELTA = 0.04;
export const TRIAGE_BAD_DELTA = 0.06;

/** Cap on how many of a suggestion's matched topics a single verdict nudges —
 *  keeps one tap from fanning a weight change across a long topic list. */
export const TRIAGE_MAX_NUDGED_TOPICS = 3;
