// The v1 control arms: the persona and topic-generation prompts exactly as they
// shipped at 68189e7, before the chatq prompt edits.
//
// WHY THIS EXISTS. Comparing an old prompt against a new one across two separate
// runs is confounded by NEAR's between-run drift — a control arm that cannot
// touch scoring moved a kept count by 7, above the within-run floor of 4. So an
// old-vs-new judgement has to be INTERLEAVED inside one run, which means the old
// text has to be a registerable arm rather than a git revision.
//
// The texts are GENERATED, never transcribed: `prompt-archive-v1.json` was
// produced by importing that revision of `persona-prompts.ts` and serialising
// what its builders actually returned. Transcribing 12KB of prompt by hand would
// put an escaping bug between the control and the thing it controls for, which
// is the one place a silent difference is fatal.
//
// NOT PART OF THE APP. Only the harness-local corpus runners import this, so the
// ~46KB of archived text never enters the bundle. Keep it that way: an app-side
// import would ship four dead prompts to every device.

import {
  BASELINE_VARIANT_ID,
  registerPromptVariant,
  type PromptVariantId,
} from './prompt-variants';
import ARCHIVE from './prompt-archive-v1.json';

export const TOPICGEN_V1: PromptVariantId = 'topicgen-v1';
export const PERSONA_V1: PromptVariantId = 'persona-v1';

/** The archived texts, for pin tests and for callers that want the raw string. */
export const PROMPT_ARCHIVE_V1 = ARCHIVE;

/**
 * Register both v1 control arms.
 *
 * Idempotent-by-refusal is the underlying contract: `registerPromptVariant`
 * throws on a duplicate id and refuses to replace `baseline` at all, so a runner
 * that calls this twice fails loudly rather than quietly redefining a control.
 * This wrapper therefore does NOT swallow that error.
 *
 * **`personaStatic` IS A SINGLE STRING, and the persona builder takes six
 * parameters.** An arm overrides the builder's output for EVERY surface, mode,
 * language, filter rung and question bank, so `persona-v1` is faithful only for
 * the parameter set it was captured under: CONFIG + CLOUD, no language override,
 * full filter tools, standard question bank. That is what the corpus runner
 * sends. Do not use this arm to judge an ONBOARDING turn, a LOCAL turn, or a
 * degraded filter rung — it would answer with the CONFIG/CLOUD text and the
 * difference would look like a model effect.
 */
export function registerV1ControlArms(options: { includeToolFormat?: boolean } = {}): void {
  const personaStatic = options.includeToolFormat
    ? ARCHIVE.personaStaticConfigCloudWithToolFormat
    : ARCHIVE.personaStaticConfigCloud;

  registerPromptVariant({
    id: TOPICGEN_V1,
    description:
      'Topic generation as shipped at 68189e7: residence mandate, the 18-topic Nieuw-West example, exact-count wording, no existing-topics section.',
    systemPrompts: {
      topicGenFactOnly: ARCHIVE.topicGenFactOnly,
      topicGenCombo: ARCHIVE.topicGenCombo,
    },
  });

  registerPromptVariant({
    id: PERSONA_V1,
    description:
      'Persona-update static prompt as shipped at 68189e7: no punctuation rule. CONFIG + CLOUD capture only.',
    systemPrompts: { personaStatic },
  });
}

/** Guard against the one mistake that would void every comparison. */
export function assertNotBaseline(id: PromptVariantId): void {
  if (id === BASELINE_VARIANT_ID) {
    throw new Error('v1 control arms must not be registered as the baseline.');
  }
}
