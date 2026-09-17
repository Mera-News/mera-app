// Registered experiment arms for the REASON pass.
//
// WHY THIS IS ITS OWN FILE. `prompt-variants.ts` is imported BY `prompts.ts`,
// so importing the shipped prompts back into it would close a cycle. It would
// not bite today (`prompts.ts` only calls `resolvePromptVariant` from inside
// functions) but an arm composing itself from a shipped prompt has to read it
// at MODULE INIT, which is exactly the read that dies on a temporal-dead-zone
// error depending on which module the bundler loads first. A third file that
// imports both and is imported by neither cannot have that problem.
//
// WHAT CHANGED WHEN reason-v2 WAS PROMOTED. Its rules now live in `prompts.ts`
// and ARE the shipped reason prompts, so there is no `reason-v2` arm any more:
// selecting it would mean selecting the default. What is registered instead is
// `reason-v1`, the text v2 beat. A promotion with no way back to the thing it
// beat is not a measurement, and re-deriving the old prompt by subtracting the
// rules from the new one would be exactly the string surgery this seam exists
// to replace.

import {
  CLOUD_REASON_SYSTEM_PROMPT_V1,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_V1,
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
  CLOUD_RELEVANCE_SYSTEM_PROMPT_PRE_GEO,
  CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT_PRE_GEO,
  CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO,
  CLOUD_REASON_SYSTEM_PROMPT_RESCORE,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_RESCORE,
} from './prompts';
import { registerPromptVariant } from './prompt-variants';

const REASON_V1_ID = 'reason-v1';
const REASON_V3_ID = 'reason-v3';
const PRE_GEO_CONTROL_ID = 'pre-geo-control';
const REASON_RESCORE_ID = 'reason-rescore';
const REASON_RESCORE_PRIOR_ID = 'reason-rescore-prior';
const RESCORE_DEMOTE_ONLY_ID = 'rescore-demote-only';
const NULL_CONTROL_ID = 'null-control';

/**
 * The control: the reason prompt exactly as it shipped before promotion.
 *
 * Kept registered so any later arm can be measured against the pre-v2 text as
 * well as the current one, and so the promotion itself stays falsifiable.
 */
registerPromptVariant({
  id: REASON_V1_ID,
  description:
    'The reason prompt as it shipped BEFORE reason-v2 was promoted. Control arm; '
    + 'v2 beat it on calibration 4.04 to 4.46 and linkage 4.73 to 4.98, blind rater, 80 rows per arm.',
  systemPrompts: {
    reason: CLOUD_REASON_SYSTEM_PROMPT_V1,
    headlineReason: CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_V1,
  },
});

/**
 * reason-v3: the ONE pattern v2 did not fix.
 *
 * The rater found the user's city stapled onto stories with no angle on it in
 * 47% of pre-v2 rows and 39% after, essentially unmoved. v2's rule 3 already
 * bans INVENTING a place, and the model obeys that: it is not fabricating a
 * Dutch connection, it is ending almost every sentence with the same clause
 * because the persona's city is the handiest thing to end on. So this is a
 * VOICE problem, not a truthfulness one, and v2's rule cannot reach it.
 *
 * Two rules, and the second matters as much as the first. Banning the place
 * without offering anywhere else to go would just move the tic somewhere else,
 * so the arm also asks for varied openings: a template is a shape, and you
 * replace a shape with another shape rather than with a prohibition.
 *
 * OUTCOME: REJECTED, and the reasoning above is the part that turned out wrong.
 * A blind rater over 168 rows could not tell v3 from v2 on any dimension, and
 * the opening-variety rule moved nothing at all (36 unique first words either
 * way; measured independently as distinct two-word openings, 75.8% vs 76.2%).
 * The place rule MAY have moved the stapling rate - three repeats of v3 all sat
 * below three repeats of v2 on an automated proxy - but the gap was 7.8 points
 * against a within-run floor of 8.3, so it did not clear the pre-registered bar
 * and the rater saw no difference at all. Two lessons worth more than the arm:
 * bundling two rules into one arm means a null result cannot be attributed, and
 * an automated proxy disagreeing with a calibrated rater is the proxy's problem.
 */
const REASON_V3_RULES = `
## Two more rules about how the sentence is built

**4. A place belongs in the sentence only when the ARTICLE has an angle on it.**
Ask whether this story would still be about that city or country if the reader
lived somewhere else. If it would, name the place. If it would not, leave it out
and make the link on the fact alone: the reader's profession, their field, their
holding, their family, the thing they follow. "EU transparency rules will apply
to the consumer apps you build" is complete. It does not need "in Amsterdam"
bolted on, and adding it implies a local angle the article does not have.

**5. Vary how the sentence opens.** Do not start every reason with the event and
end every one with the reader. Some should open on the reader's stake and then
name the event; some should open on the event; some should name the mechanism
between them first. The reader sees a column of these one under another, and
twenty sentences built to the same template read as generated even when each one
is accurate on its own.

Output: single plain string, no prefixes, no markdown.`;

registerPromptVariant({
  id: REASON_V3_ID,
  description:
    'v2 plus two sentence-construction rules, targeting the place-template pattern. '
    + 'MEASURED AND REJECTED: behaviourally indistinguishable from v2 under a blind rater over 168 '
    + 'rows (voice 3.06 vs 3.09, place-stapled 44% vs 45%, opening variety 36 vs 36, calibration '
    + 'identical). Rule 5 (vary the openings) produced NO measurable change and should be dropped, '
    + 'not reworded, if a v4 is ever authored. Kept registered so the question is reproducible, '
    + 'NOT because it is a candidate.',
  systemPrompts: {
    // Built on the SHIPPED prompt, which is now v2. So v3 is strictly v2 plus
    // these two rules, and a v3-versus-v2 comparison isolates them.
    reason: `${CLOUD_REASON_SYSTEM_PROMPT}\n${REASON_V3_RULES}`,
    headlineReason: `${CLOUD_HEADLINE_REASON_SYSTEM_PROMPT}\n${REASON_V3_RULES}`,
  },
});

// ---------------------------------------------------------------------------
// THE GEOFIX ARMS (2026-09-17). One promoted, three measured and kept.
//
// THE BUG THEY EXIST FOR. A Diário de Notícias story about Portugal's
// parental-leave vote rendered HIGH for a reader living in the Netherlands,
// reasoned as "Parliament's delay on parental leave directly affects your
// upcoming March birth in the Netherlands." The publication's country was in
// the prompt for both passes and the residence fact was attached; measured n=9,
// pass 1 still tagged it `home` 6 times out of 9. The reason pass was already
// saying "foreign-domestic, no tie" in prose and had no field to say it in.
//
// Two independent candidate fixes, deliberately NOT bundled: the article-scope
// rule states the missing constraint, the rescore gives pass 2 a score to state
// it WITH. Bundling them would mean a null result could not be attributed,
// which is what `reason-v3` above paid to learn. The rule won and is now the
// default; the rescore lost on recall and is kept registered, not shipped.
// ---------------------------------------------------------------------------

/**
 * THE COUNTERPART CONTROL to the promoted article-scope rule: all four scoring
 * prompts on the base as it stood BEFORE the rule.
 *
 * Same reason `reason-v1` is registered. A promotion with no way back to the
 * text it beat is not a measurement, and re-deriving the old base by deleting a
 * section from the new one is exactly the string surgery this seam replaces.
 */
registerPromptVariant({
  id: PRE_GEO_CONTROL_ID,
  description:
    'The four cloud scoring prompts on the PRE-GEO base: no article-scope rule. Control for the '
    + 'geofix2 promotion, which beat it on broad-set recall 0.459 to 0.406 at flat precision '
    + '(+27 true positives for +8 false, null floor 0.010 recall / 0.017 precision, goldset-348 x 3) '
    + 'and on the DN matrix 8 of 9 cells below the gate against 2 of 9.',
  systemPrompts: {
    relevance: CLOUD_RELEVANCE_SYSTEM_PROMPT_PRE_GEO,
    headlineRelevance: CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT_PRE_GEO,
    reason: CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO,
    headlineReason: CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO,
  },
});

/**
 * Pass 2 answers `{"k","s","reason"}` and its score replaces pass 1's.
 *
 * The prior-score line is DROPPED from the user message. Pass 2 is being asked
 * to re-derive the score, and handing it the number it is meant to re-derive is
 * an anchor rather than context. How much that matters is measured by
 * `reason-rescore-prior`, not assumed.
 */
registerPromptVariant({
  id: REASON_RESCORE_ID,
  description:
    'Pass 2 runs the full stake procedure on its one article and emits {"k","s","reason"}; the '
    + 'band-clamped `s` replaces the pass-1 score in BOTH directions. Prior-score line dropped '
    + 'from the user message. MEASURED AND REJECTED, goldset-348 x 3 on the shipped base: it parsed '
    + '259 of 259 and still cost recall, 0.703 against 0.784 at the 0.4 gate and 0.373 broad-set '
    + 'against 0.459, erasing the whole gain of the article-scope rule it sits on. 208 of 259 rows '
    + 'rescored, mean signed delta -0.102, band-down 63 against band-up 7. Kept registered so the '
    + 'question is reproducible, NOT because it is a candidate.',
  systemPrompts: {
    reason: CLOUD_REASON_SYSTEM_PROMPT_RESCORE,
    headlineReason: CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_RESCORE,
  },
  reasonPriorScoreLine: 'omit',
});

/**
 * `reason-rescore` with the prior score kept, relabelled for what it is.
 *
 * The ONLY difference from `reason-rescore` is that one line of the user
 * message, so the pair isolates the anchoring effect exactly.
 */
registerPromptVariant({
  id: REASON_RESCORE_PRIOR_ID,
  description:
    'reason-rescore with the pass-1 score kept in the user message, relabelled "First-pass score '
    + '(batched): X". Identical system prompt, so the pair measures the anchoring effect of that '
    + 'one line and nothing else. MEASURED on the PRE-GEO base: keeping the line more than halves '
    + 'the deflation (mean signed delta -0.027 against -0.102) and recovers most of the recall '
    + '(0.721 against 0.658), so the anchor is doing real work - but it still loses to not '
    + 'rescoring at all. Its prompt has since been rebased onto the shipped base, so the numbers '
    + 'above are not reproducible without `pre-geo-control`.',
  systemPrompts: {
    reason: CLOUD_REASON_SYSTEM_PROMPT_RESCORE,
    headlineReason: CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_RESCORE,
  },
  reasonPriorScoreLine: 'relabel',
});

/**
 * `reason-rescore`'s inflation guard: the rescore applies only when it LOWERS
 * the score.
 *
 * Same prompt and the same dropped line as `reason-rescore` — the arms differ
 * only in what the caller does with the number, which is why the policy is a
 * field on the arm and not a second prompt. It is the arm to promote if the
 * full rescore turns out to inflate.
 */
registerPromptVariant({
  id: RESCORE_DEMOTE_ONLY_ID,
  description:
    'reason-rescore, except the pass-2 score applies only when it is LOWER than pass 1. Identical '
    + 'prompt and user message to reason-rescore; the difference is the decode policy alone. '
    + 'MEASURED: the guard pointed the WRONG WAY. Pass 2 deflates, it does not inflate, so the '
    + 'policy had almost no work to do (140 of 259 rows moved, all downward). TRAP: neither the '
    + 'corpus runner nor its RESCORE REPORT applies a demote-only policy - both store the raw '
    + 'pass-2 score - so unless the analysis applies min(pass1, rescored) itself this arm is '
    + 'scored as a plain replace and reads as a duplicate of reason-rescore. Its one upside is '
    + 'that the duplication is a FREE second null-floor sample.',
  systemPrompts: {
    reason: CLOUD_REASON_SYSTEM_PROMPT_RESCORE,
    headlineReason: CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_RESCORE,
  },
  reasonPriorScoreLine: 'omit',
  rescorePolicy: 'demote-only',
});

/**
 * THE NULL FLOOR. Byte-identical to `baseline`, and registered anyway.
 *
 * Every acceptance bar in this wave is written as "at least baseline minus the
 * floor", and a floor is a measured number, not a guess. One `baseline` arm
 * gives one precision figure with nothing to subtract from it — so the run
 * carries a second arm that cannot possibly differ from it, and whatever gap
 * appears between the two IS the floor.
 *
 * It has to ride inside the SAME run. The measured trap this answers: a control
 * arm that could not affect scoring, on byte-identical prompts, still moved its
 * kept count by 7 between two runs half an hour apart, against a within-run
 * floor of 4. A floor computed across runs is not a floor.
 *
 * NO `systemPrompts`, NO `reasonPriorScoreLine`, NO `rescorePolicy`, on
 * purpose. `systemPromptForSlot` returns the shipped prompt for any slot an arm
 * does not name, so "identical to baseline" holds by construction rather than
 * by two strings being kept in sync. Do not give this arm a prompt, ever, not
 * even one copied from the shipped constant: the moment it has its own copy it
 * can drift, and a drifting floor is worse than no floor.
 */
registerPromptVariant({
  id: NULL_CONTROL_ID,
  description:
    'Byte-identical to baseline, by construction: it overrides no slot and carries no policy. '
    + 'Its gap against baseline within one run IS the noise floor every acceptance bar is judged '
    + 'against. Never give it a prompt of its own.',
});

// LOCAL IS STILL UNTOUCHED, through the promotion as well as the arms.
// `LOCAL_REASON_SYSTEM_PROMPT` is built on a different base and states its voice
// rule inline rather than sharing the cloud constant, so neither the promoted
// rules nor these reach the on-device path. That is the intended scope: no
// runner exercises the local prompts, and an unmeasured change is not an
// improvement.

export {
  REASON_V1_ID,
  REASON_V3_ID,
  REASON_V3_RULES,
  PRE_GEO_CONTROL_ID,
  REASON_RESCORE_ID,
  REASON_RESCORE_PRIOR_ID,
  RESCORE_DEMOTE_ONLY_ID,
  NULL_CONTROL_ID,
};
