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
} from './prompts';
import { registerPromptVariant } from './prompt-variants';

const REASON_V1_ID = 'reason-v1';
const REASON_V3_ID = 'reason-v3';

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
    'v2 plus two sentence-construction rules, targeting the place-template pattern the rater '
    + 'found unmoved at 47% then 39% of rows. Voice only; makes no claim about calibration or linkage.',
  systemPrompts: {
    // Built on the SHIPPED prompt, which is now v2. So v3 is strictly v2 plus
    // these two rules, and a v3-versus-v2 comparison isolates them.
    reason: `${CLOUD_REASON_SYSTEM_PROMPT}\n${REASON_V3_RULES}`,
    headlineReason: `${CLOUD_HEADLINE_REASON_SYSTEM_PROMPT}\n${REASON_V3_RULES}`,
  },
});

// LOCAL IS STILL UNTOUCHED, through the promotion as well as the arms.
// `LOCAL_REASON_SYSTEM_PROMPT` is built on a different base and states its voice
// rule inline rather than sharing the cloud constant, so neither the promoted
// rules nor these reach the on-device path. That is the intended scope: no
// runner exercises the local prompts, and an unmeasured change is not an
// improvement.

export { REASON_V1_ID, REASON_V3_ID, REASON_V3_RULES };
