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
import V2 from './prompt-experiments-v2.json';

export const TOPICGEN_V1: PromptVariantId = 'topicgen-v1';
export const PERSONA_V1: PromptVariantId = 'persona-v1';

/**
 * Candidate arm, NOT a control: the shipped topic prompts with the residence
 * daily-life permission replaced by an explicit ban on the fixed
 * local-government / transport / housing triad, plus a scope-preservation rule.
 *
 * Both target failures a blind rater found in BOTH existing arms, so they are
 * not fixes for the v1-vs-baseline difference: the triad appeared identically
 * for Tallinn, Lyon, Rotterdam and Porto (a softened mandate read as a
 * template), and national-team facts drifted to clubs and leagues in every
 * cohort. The scope drift is also why part of the measured near-duplicate rate
 * is unreachable by the dedupe filter - "Primeira Liga transfers" shares no
 * token with "Portugal football", so only the prompt can prevent it.
 */
export const TOPICGEN_V2: PromptVariantId = 'topicgen-v2';

/** The archived texts, for pin tests and for callers that want the raw string. */
export const PROMPT_ARCHIVE_V1 = ARCHIVE;

/**
 * Register the wave's non-baseline arms: the two v1 CONTROLS and the
 * topicgen-v2 CANDIDATE.
 *
 * All three live behind one entry point because the runners call it once at
 * module scope; adding a second registration call would be a second thing to
 * forget, and a missing arm surfaces as "Unknown prompt variant" only after the
 * run starts.
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
    id: TOPICGEN_V2,
    description:
      'Candidate: no fixed daily-life triad for residence facts, plus scope preservation (national team not clubs, company not sector).',
    systemPrompts: {
      topicGenFactOnly: V2.topicGenFactOnly,
      topicGenCombo: V2.topicGenCombo,
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
