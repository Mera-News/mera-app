// Drift guard for the persona + topic-generation prompts.
//
// These constants moved out of `prompts/prompts.ts` into
// `prompts/persona-prompts.ts` so the persona/chat area and the article-
// pipeline area stop sharing one 1,956-line file. The move was byte-for-byte;
// this file is what keeps it that way, and it is NEW protection: before the
// split `golden-prompts.test.ts` pinned the four ARTICLE prompts and nothing
// pinned these at all, so a persona prompt could grow by a kilobyte with every
// suite green.
//
// It pins three different things, and they fail for different reasons:
//
//  1. TOKEN SIZES. Measured with the same `estimateTokens` the article pins
//     use. A failure here means a prompt's text changed. That is allowed — but
//     it has to be deliberate, and the new number has to be written down, which
//     is the whole point of a pinned literal over a range.
//
//  2. RE-EXPORT IDENTITY. `prompts/prompts.ts` re-exports this module so no
//     import site changed. The assertions compare by REFERENCE (`toBe`), which
//     is what distinguishes a live re-export from someone copying a prompt back
//     into the old file — two equal strings would pass a value check and hide
//     exactly the duplication the split exists to prevent.
//
//  3. THE DELIBERATE ALIASES. Two pairs are the SAME string on purpose
//     (`TOPIC_GENERATION_SYSTEM_PROMPT` is the legacy name for the cloud one;
//     the local noise prompt is deliberately the cloud one). Pinned so a future
//     edit to one half cannot silently fork them.
import { estimateTokens } from '@/lib/llm/tokens';
import * as viaBarrel from '../prompts/prompts';
import {
  CLOUD_TOPIC_GEN_RULES_SNIPPET,
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  LOCAL_TOPIC_GEN_RULES_SNIPPET,
  LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT,
  LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  TOPIC_SANITY_SYSTEM_PROMPT,
  TOPIC_GENERATION_SYSTEM_PROMPT,
  NOISE_GENERATION_SYSTEM_PROMPT,
  LOCAL_NOISE_GENERATION_SYSTEM_PROMPT,
  buildToolDefinitions,
  buildToolFormatSection,
  buildPersonaUpdateStaticPrompt,
  type FilterToolsVariant,
} from '../prompts/persona-prompts';

/** MEASURED at the split (nothing was edited to produce these — they are what
 *  the pre-split file already held). Restate a value here only alongside the
 *  edit that moved it. */
const PINNED_TOKENS: Record<string, [string, number]> = {
  CLOUD_TOPIC_GEN_RULES_SNIPPET: [CLOUD_TOPIC_GEN_RULES_SNIPPET, 3116],
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT: [CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT, 3171],
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT: [
    CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
    3113,
  ],
  LOCAL_TOPIC_GEN_RULES_SNIPPET: [LOCAL_TOPIC_GEN_RULES_SNIPPET, 1883],
  LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT: [LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT, 1937],
  LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT: [
    LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
    1601,
  ],
  TOPIC_SANITY_SYSTEM_PROMPT: [TOPIC_SANITY_SYSTEM_PROMPT, 518],
  NOISE_GENERATION_SYSTEM_PROMPT: [NOISE_GENERATION_SYSTEM_PROMPT, 1109],
};

const VARIANTS: FilterToolsVariant[] = ['full', 'compact', 'off'];
const SURFACES = ['ONBOARDING', 'CONFIG'] as const;

describe('persona prompts — measured sizes', () => {
  it.each(Object.entries(PINNED_TOKENS))(
    'pins the estimated token size of %s',
    (_name, [prompt, tokens]) => {
      expect(estimateTokens(prompt)).toBe(tokens);
    },
  );

  it('keeps every pinned prompt non-empty (guards a constant that became ``)', () => {
    for (const [name, [prompt]] of Object.entries(PINNED_TOKENS)) {
      expect(prompt.length).toBeGreaterThan(0);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('keeps the LOCAL topic prompts smaller than their CLOUD twins', () => {
    // The on-device model loses calibration on a prompt the cloud model holds
    // fine, so the local family is deliberately the shorter one. A local prompt
    // that grew past its cloud twin is a real regression, not a style change.
    expect(estimateTokens(LOCAL_TOPIC_GEN_RULES_SNIPPET)).toBeLessThan(
      estimateTokens(CLOUD_TOPIC_GEN_RULES_SNIPPET),
    );
    expect(estimateTokens(LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT)).toBeLessThan(
      estimateTokens(CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT),
    );
    expect(estimateTokens(LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT)).toBeLessThan(
      estimateTokens(CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT),
    );
  });
});

describe('persona prompts — deliberate aliases', () => {
  it('TOPIC_GENERATION_SYSTEM_PROMPT is the cloud prompt, by reference', () => {
    expect(TOPIC_GENERATION_SYSTEM_PROMPT).toBe(CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT);
  });

  it('the local noise prompt is the cloud noise prompt, by reference', () => {
    expect(LOCAL_NOISE_GENERATION_SYSTEM_PROMPT).toBe(NOISE_GENERATION_SYSTEM_PROMPT);
  });

  it('the cloud topic prompt embeds the shared rules snippet verbatim', () => {
    // The snippet is the single source of truth for anchoring and granularity.
    // A cloud topic prompt that stopped containing it has forked the rules.
    expect(CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT).toContain(CLOUD_TOPIC_GEN_RULES_SNIPPET);
  });

  it('the NOISE prompt does NOT embed the snippet, whatever the comment says', () => {
    // `CLOUD_TOPIC_GEN_RULES_SNIPPET`'s own doc comment claims it is "embedded
    // by both CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT and
    // NOISE_GENERATION_SYSTEM_PROMPT". That is FALSE and was caught by this
    // test when it was first written to trust it: the snippet is 12,461 chars
    // and the whole noise prompt is 4,435, so it cannot contain it. The noise
    // prompt carries its own condensed substitution rules instead.
    //
    // Pinned as the measured truth rather than silently dropped, so whoever
    // fixes that comment finds the assertion that disagrees with it. If the two
    // are ever genuinely unified, this is the test that should fail and be
    // replaced by the `toContain` it currently contradicts.
    expect(NOISE_GENERATION_SYSTEM_PROMPT).not.toContain(CLOUD_TOPIC_GEN_RULES_SNIPPET);
    expect(NOISE_GENERATION_SYSTEM_PROMPT.length).toBeLessThan(
      CLOUD_TOPIC_GEN_RULES_SNIPPET.length,
    );
  });
});

describe('persona prompts — re-export identity', () => {
  // By REFERENCE on purpose: an equal-valued copy left behind in prompts.ts
  // would pass a value comparison and defeat the split.
  it.each(Object.keys(PINNED_TOKENS))(
    '%s resolves to the same object through prompts.ts',
    (name) => {
      expect((viaBarrel as Record<string, unknown>)[name]).toBe(PINNED_TOKENS[name][0]);
    },
  );

  it('re-exports the persona builders too', () => {
    expect(viaBarrel.buildToolDefinitions).toBe(buildToolDefinitions);
    expect(viaBarrel.buildToolFormatSection).toBe(buildToolFormatSection);
    expect(viaBarrel.buildPersonaUpdateStaticPrompt).toBe(buildPersonaUpdateStaticPrompt);
    expect(viaBarrel.TOPIC_GENERATION_SYSTEM_PROMPT).toBe(TOPIC_GENERATION_SYSTEM_PROMPT);
  });

  it('leaves the ARTICLE prompts where they were (the split moved nothing else)', () => {
    expect(typeof viaBarrel.CLOUD_RELEVANCE_SYSTEM_PROMPT).toBe('string');
    expect(typeof viaBarrel.CLOUD_REASON_SYSTEM_PROMPT).toBe('string');
    expect(typeof viaBarrel.buildBatchScoringUserMessage).toBe('function');
  });
});

describe('persona prompts — tool builders are deterministic per variant', () => {
  it.each(SURFACES)('%s: every filter variant builds and is stable', (surface) => {
    for (const variant of VARIANTS) {
      const a = buildToolDefinitions(surface, variant);
      const b = buildToolDefinitions(surface, variant);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(a.length).toBeGreaterThan(0);

      const fa = buildToolFormatSection(surface, variant);
      expect(buildToolFormatSection(surface, variant)).toBe(fa);
    }
  });

  it("'off' is the smallest rung on both axes, on both surfaces", () => {
    // The `off` rung exists to be byte-identical to the pre-filters prompt, so
    // it must never carry more tools or more text than a richer rung.
    for (const surface of SURFACES) {
      const off = buildToolDefinitions(surface, 'off');
      const compact = buildToolDefinitions(surface, 'compact');
      const full = buildToolDefinitions(surface, 'full');
      expect(off.length).toBeLessThanOrEqual(compact.length);
      expect(compact.length).toBeLessThanOrEqual(full.length);

      expect(buildToolFormatSection(surface, 'off').length).toBeLessThanOrEqual(
        buildToolFormatSection(surface, 'full').length,
      );
    }
  });
});
