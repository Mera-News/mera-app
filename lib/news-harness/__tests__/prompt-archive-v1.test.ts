// The v1 control arms must be the OLD text, exactly.
//
// A control that has silently drifted toward the treatment is worse than no
// control: every interleaved comparison in the run is then measuring a smaller
// difference than it reports, and nothing in the run would say so. The token
// sizes below are the measured sizes at 68189e7 and are the tripwire.

import { estimateTokens } from '@/lib/llm/tokens';
import {
  assertPersonaV1Capture,
  PROMPT_ARCHIVE_V1,
  PERSONA_V1,
  TOPICGEN_V1,
  registerV1ControlArms,
} from '../prompts/prompt-archive-v1';
import {
  buildPersonaUpdateStaticPrompt,
  buildTopicGenSystemPrompt,
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
} from '../prompts/persona-prompts';
import { resetPromptVariantsForTest } from '../prompts/prompt-variants';

afterEach(() => resetPromptVariantsForTest());

describe('the archived v1 texts are the 68189e7 sizes', () => {
  it.each([
    ['topicGenFactOnly', 3167],
    ['topicGenCombo', 3113],
    ['personaStaticConfigCloud', 2477],
    ['personaStaticConfigCloudWithToolFormat', 2998],
  ])('%s is %i tokens', (key, tokens) => {
    expect(estimateTokens((PROMPT_ARCHIVE_V1 as Record<string, string>)[key])).toBe(tokens);
  });
});

describe('v1 is genuinely DIFFERENT from the shipped prompts', () => {
  // The whole point of the arm. If an edit is ever reverted, this goes red and
  // says the control has become a duplicate of the treatment.
  it('the topic-gen texts differ from what ships today', () => {
    expect(PROMPT_ARCHIVE_V1.topicGenFactOnly).not.toBe(CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT);
    expect(PROMPT_ARCHIVE_V1.topicGenFactOnly).not.toContain('## Existing topics');
    expect(PROMPT_ARCHIVE_V1.topicGenFactOnly).toContain('Residence requirement');
  });

  it('the persona text carries no punctuation rule, which today it does', () => {
    expect(PROMPT_ARCHIVE_V1.personaStaticConfigCloud).not.toContain('PUNCTUATION');
    expect(buildPersonaUpdateStaticPrompt({ surface: 'CONFIG', mode: 'CLOUD' })).toContain(
      'PUNCTUATION',
    );
  });

  it('the combo prompt is unchanged by this wave, so v1 and shipped MATCH there', () => {
    // Stated rather than assumed: the combo half was deliberately not edited, so
    // an arm that replaced it with different text would be a bug in the archive.
    expect(PROMPT_ARCHIVE_V1.topicGenCombo).toBe(CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT);
  });
});

describe('the capture matches what run-persona-corpus.ts actually sends', () => {
  // This is the check that caught a real defect: the first capture omitted
  // languageName, and the runner sends 'English'. The two prompts differ by 154
  // characters and carry DIFFERENT language rules, so the control arm would have
  // differed from baseline by language instruction on top of the em-dash rule
  // and the run would have attributed both to the prompt edit.
  it('rejects a parameter set the arm was not captured under', () => {
    expect(() => assertPersonaV1Capture({ surface: 'ONBOARDING' })).toThrow(/captured under/);
    expect(() => assertPersonaV1Capture({ mode: 'LOCAL' })).toThrow(/captured under/);
    expect(() => assertPersonaV1Capture({ languageName: 'Dutch' })).toThrow(/captured under/);
    expect(() => assertPersonaV1Capture({ filterTools: 'compact' })).toThrow(/captured under/);
    expect(() => assertPersonaV1Capture({ deepMode: true })).toThrow(/captured under/);
  });

  it('accepts the runner set, including the SILENT defaults', () => {
    // filterTools and deepMode are the ones the runner never passes, so they are
    // the ones a capture drifts on without anyone noticing.
    expect(() =>
      assertPersonaV1Capture({
        surface: 'CONFIG',
        mode: 'CLOUD',
        includeToolFormat: false,
        languageName: 'English',
      }),
    ).not.toThrow();
  });

  it('an omitted parameter matches the builder default it was captured with', () => {
    expect(() => assertPersonaV1Capture({})).not.toThrow();
  });
});

describe('registration', () => {
  it('routes each arm to its own slots and leaves baseline alone', () => {
    const shippedFactOnly = buildTopicGenSystemPrompt('factOnly');
    registerV1ControlArms();

    expect(buildTopicGenSystemPrompt('factOnly', TOPICGEN_V1)).toBe(
      PROMPT_ARCHIVE_V1.topicGenFactOnly,
    );
    expect(buildPersonaUpdateStaticPrompt({ surface: 'CONFIG', mode: 'CLOUD', promptVariant: PERSONA_V1 })).toBe(
      PROMPT_ARCHIVE_V1.personaStaticConfigCloud,
    );
    // baseline still returns the shipped text, by reference.
    expect(buildTopicGenSystemPrompt('factOnly')).toBe(shippedFactOnly);
  });

  it('the persona arm does NOT change topic generation, and vice versa', () => {
    registerV1ControlArms();
    expect(buildTopicGenSystemPrompt('factOnly', PERSONA_V1)).toBe(
      CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
    );
    expect(
      buildPersonaUpdateStaticPrompt({ surface: 'CONFIG', mode: 'CLOUD', promptVariant: TOPICGEN_V1 }),
    ).toBe(buildPersonaUpdateStaticPrompt({ surface: 'CONFIG', mode: 'CLOUD' }));
  });

  it('refuses a double registration rather than quietly redefining a control', () => {
    registerV1ControlArms();
    expect(() => registerV1ControlArms()).toThrow(/already registered/);
  });

  it('includeToolFormat picks the matching capture', () => {
    registerV1ControlArms({ includeToolFormat: true });
    expect(
      buildPersonaUpdateStaticPrompt({ surface: 'CONFIG', mode: 'CLOUD', promptVariant: PERSONA_V1 }),
    ).toBe(PROMPT_ARCHIVE_V1.personaStaticConfigCloudWithToolFormat);
  });
});
