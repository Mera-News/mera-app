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

// ---------------------------------------------------------------------------
// Capture guard
// ---------------------------------------------------------------------------

/**
 * The parameter set `persona-v1` was actually captured under.
 *
 * `systemPrompts.personaStatic` is ONE string and the builder takes six
 * parameters, so an arm answers with the same text for every surface, mode,
 * language, filter rung and question bank. Asked for an ONBOARDING or LOCAL
 * turn, `persona-v1` would return the CONFIG/CLOUD text and the run would report
 * the difference as a model effect. A control that silently answers the wrong
 * question is worse than no control, so the mismatch has to be an error.
 */
export const PERSONA_V1_CAPTURE = {
  surface: 'CONFIG',
  mode: 'CLOUD',
  // The runner sends 'English'. The first capture omitted it, which selects a
  // DIFFERENT language rule and a prompt 154 characters shorter - the control
  // would have differed from baseline by language instruction as well as the
  // edit under test.
  languageName: 'English',
  filterTools: 'full',
  deepMode: false,
} as const;

export interface PersonaCaptureParams {
  surface?: string;
  mode?: string;
  includeToolFormat?: boolean;
  languageName?: string;
  filterTools?: string;
  deepMode?: boolean;
}

/**
 * Throw unless `params` match the capture. Call it wherever `persona-v1` is
 * resolved; `includeToolFormat` is excluded because BOTH captures exist and
 * `registerV1ControlArms` picks between them.
 *
 * Returns void and throws rather than returning a boolean: a boolean invites a
 * call site that ignores it, which is the failure this exists to prevent.
 */
export function assertPersonaV1Capture(params: PersonaCaptureParams): void {
  const mismatches: string[] = [];
  const check = (key: keyof typeof PERSONA_V1_CAPTURE, actual: unknown) => {
    const expected = PERSONA_V1_CAPTURE[key];
    // An omitted parameter takes the builder's default, which is what the
    // capture recorded, so `undefined` matches.
    if (actual !== undefined && actual !== expected) {
      mismatches.push(`${key}: got ${String(actual)}, captured ${String(expected)}`);
    }
  };
  check('surface', params.surface);
  check('mode', params.mode);
  check('languageName', params.languageName);
  check('filterTools', params.filterTools);
  check('deepMode', params.deepMode);

  if (mismatches.length > 0) {
    throw new Error(
      `prompt variant '${PERSONA_V1}' was captured under ` +
        `${JSON.stringify(PERSONA_V1_CAPTURE)} and cannot answer for a different ` +
        `parameter set (${mismatches.join('; ')}). It is one fixed string, so it ` +
        'would return the captured text and the run would read the difference as a ' +
        'model effect. Capture a new arm for that parameter set instead.',
    );
  }
}
