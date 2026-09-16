// The persona and topic-gen arm seam.
//
// The property that lets this sit on the PRODUCTION path is that 'baseline' is
// a no-op, byte for byte. If that ever stops holding, every shipped prompt has
// silently changed, so it is asserted first and for every mode.

import {
  buildPersonaUpdateStaticPrompt,
  buildTopicGenSystemPrompt,
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
} from '../prompts/persona-prompts';
import {
  registerPromptVariant,
  resetPromptVariantsForTest,
} from '../prompts/prompt-variants';

afterEach(() => resetPromptVariantsForTest());

const MODES = [
  ['CONFIG', 'CLOUD'],
  ['CONFIG', 'LOCAL'],
  ['ONBOARDING', 'CLOUD'],
  ['ONBOARDING', 'LOCAL'],
] as const;

describe('baseline is a no-op', () => {
  it.each(MODES)('persona %s/%s is byte-identical with and without the param', (surface, mode) => {
    const shipped = buildPersonaUpdateStaticPrompt({ surface, mode });
    expect(buildPersonaUpdateStaticPrompt({ surface, mode, promptVariant: 'baseline' })).toBe(
      shipped,
    );
  });

  it('topic-gen returns the shipped constants BY REFERENCE', () => {
    // By reference, not by value: the golden pin asserts re-export identity, and
    // an accidental copy would pass a value check while breaking that.
    expect(buildTopicGenSystemPrompt('factOnly')).toBe(CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT);
    expect(buildTopicGenSystemPrompt('combo')).toBe(
      CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
    );
  });
});

describe('an arm replaces exactly its own slot', () => {
  it('personaStatic overrides both CLOUD and LOCAL, so the two cannot drift', () => {
    registerPromptVariant({
      id: 'arm-persona',
      description: 'test',
      systemPrompts: { personaStatic: 'REPLACED' },
    });
    for (const [surface, mode] of MODES) {
      expect(
        buildPersonaUpdateStaticPrompt({ surface, mode, promptVariant: 'arm-persona' }),
      ).toBe('REPLACED');
    }
  });

  it('topicGenFactOnly does not perturb the combo half', () => {
    registerPromptVariant({
      id: 'arm-fact-only',
      description: 'test',
      systemPrompts: { topicGenFactOnly: 'REPLACED' },
    });
    expect(buildTopicGenSystemPrompt('factOnly', 'arm-fact-only')).toBe('REPLACED');
    expect(buildTopicGenSystemPrompt('combo', 'arm-fact-only')).toBe(
      CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
    );
  });

  it('an arm naming a SCORING slot leaves the persona prompt alone', () => {
    registerPromptVariant({
      id: 'arm-relevance',
      description: 'test',
      systemPrompts: { relevance: 'REPLACED' },
    });
    const shipped = buildPersonaUpdateStaticPrompt({ surface: 'CONFIG', mode: 'CLOUD' });
    expect(
      buildPersonaUpdateStaticPrompt({
        surface: 'CONFIG',
        mode: 'CLOUD',
        promptVariant: 'arm-relevance',
      }),
    ).toBe(shipped);
  });
});

describe('an unknown arm throws rather than scoring the control', () => {
  it('throws from the persona builder', () => {
    expect(() =>
      buildPersonaUpdateStaticPrompt({ surface: 'CONFIG', mode: 'CLOUD', promptVariant: 'nope' }),
    ).toThrow(/Unknown prompt variant 'nope'/);
  });

  it('throws from the topic-gen builder', () => {
    expect(() => buildTopicGenSystemPrompt('factOnly', 'nope')).toThrow(
      /Unknown prompt variant 'nope'/,
    );
  });
});
