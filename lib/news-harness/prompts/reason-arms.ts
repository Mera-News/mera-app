// Registered experiment arms for the REASON pass.
//
// WHY THIS IS ITS OWN FILE. The arms live where the truncation arms do in
// spirit, but not in `prompt-variants.ts`: that module is imported BY
// `prompts.ts`, so importing the shipped prompts back into it would close a
// cycle. `prompts.ts` only calls `resolvePromptVariant` from inside functions,
// so the cycle would not bite at import time today, but a v2 arm has to read
// `CLOUD_REASON_SYSTEM_PROMPT` at MODULE INIT to compose itself, and that is
// exactly the read that dies on a temporal-dead-zone error depending on which
// module the bundler happens to load first. A third file that imports both and
// is imported by neither cannot have that problem.
//
// COMPOSED FROM THE SHIPPED CONSTANT, NOT COPIED. The seam's rule is "a whole
// prompt string, never a transform", and this honours it: the arm IS a whole
// string, built by concatenating the exported shipped prompt with an appended
// block. That is different from the string surgery the seam exists to replace,
// which regex-matched into the live file's text and broke whenever that text
// moved. Concatenation keeps the arm in lockstep with the base, which is what
// you want for an arm that might be PROMOTED into the base later.
//
// THE OUTPUT CONTRACT IS RESTATED LAST. The base prompt ends with its own
// "Output:" line, so appending after it would leave three content rules as the
// last thing the model reads. `prompts.ts` documents that this family is
// sensitive to later-instruction-wins ordering, so the contract is repeated at
// the end verbatim and the new rules sit before it.

import {
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
} from './prompts';
import { registerPromptVariant } from './prompt-variants';

/**
 * The three rules, from a blind rater's read of 100 baseline reasons.
 *
 * Each one names a pattern the rater actually found, rather than a style
 * preference: calibration misses clustered entirely in the middle band, one
 * sentence skeleton bolted onto stories it did not fit, and invented context
 * whenever no listed fact bridged. Nothing here touches the low or high bands,
 * which the rater scored as correctly toned.
 */
const REASON_V2_RULES = `
## Three additional rules

**1. The middle of the scale has its own register.** Between 0.6 and 0.8 the
article genuinely touches something of yours, and it is not urgent. Say what the
mechanism is and leave the temperature down. Do not reach for "directly affects"
(that belongs above 0.9) and do not reach for "carries no direct stake" (that
belongs below 0.4). Worked example, at 0.7: "New EU cloud rules will apply to
the consumer apps you build, once they take effect next year." It names the real
link, it commits to it, and it stays calm.

**2. Never describe the feed or how this article was scored.** The reader sees a
sentence about their news, not about the system showing it. Never write that
something is relevant, highly relevant, a strong match, worth showing, or
deserving of any score or priority. Wrong: "Drought measures in Amsterdam affect
your home city, warranting a high-relevance feed score." Right: "Drought
measures start in Amsterdam this week, where you live."

**3. When no listed fact really bridges, say so plainly.** Name the closest fact
you were given and state that the connection is loose. Never invent a detail the
fact bank does not contain: not an employer, not a market, not a job, not a
circumstance, and above all not a place. Only name a city or country when THIS
article is about it. A story set in Washington, London or Berlin does not become
an Amsterdam story because the reader lives there. Wrong, on a US court ruling:
"US AI regulation may impact your consumer app development in Amsterdam."
Right: "A US court ruling on AI training data is close to your AI research
interest, though it applies only in the United States."

Output: single plain string, no prefixes, no markdown.`;

const REASON_V2_ID = 'reason-v2';

registerPromptVariant({
  id: REASON_V2_ID,
  description:
    'Reason prompt with a middle-band register, a ban on narrating the feed, and an honest-weak-link rule.',
  systemPrompts: {
    // Both reason slots move together. They share a base and they write the
    // same user-facing sentence, so fixing one and not the other would ship a
    // feed whose prose depends on how the article was retrieved.
    reason: `${CLOUD_REASON_SYSTEM_PROMPT}\n${REASON_V2_RULES}`,
    headlineReason: `${CLOUD_HEADLINE_REASON_SYSTEM_PROMPT}\n${REASON_V2_RULES}`,
  },
});

// LOCAL IS DELIBERATELY UNTOUCHED. `LOCAL_REASON_SYSTEM_PROMPT` is built on a
// different base and states its own voice rule inline rather than sharing the
// cloud constant, so nothing here can reach the on-device path. That is the
// intended scope, not an oversight: no runner exercises the local prompts, and
// an unmeasured change is not an improvement.

export { REASON_V2_ID, REASON_V2_RULES };
