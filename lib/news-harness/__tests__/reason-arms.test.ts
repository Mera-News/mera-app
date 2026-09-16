// The reason-v2 experiment arm.
//
// An arm is only worth running if a difference in its result is attributable to
// the thing it changed. That is what this file protects: the arm must be the
// shipped prompt plus a named block, must move both reason slots and neither
// scoring slot, and must not reach the on-device path at all.
import {
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
  LOCAL_REASON_SYSTEM_PROMPT,
  resolvePromptVariant,
  promptVariantIds,
  REASON_V2_ID,
} from '../index';
import { relevanceSystemPromptFor, reasonSystemPromptFor } from '../article-pipeline/scoring';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import { estimateTokens } from '@/lib/llm/tokens';

const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;
const spec = () => resolvePromptVariant(REASON_V2_ID);

describe('reason-v2 is the shipped prompt plus a named block', () => {
  it('is registered by importing the barrel, with no explicit setup', () => {
    // The registration is a side-effect import. If that ever gets tidied away
    // as "unused", a runner selecting the arm by id starts throwing instead.
    expect(promptVariantIds()).toContain(REASON_V2_ID);
  });

  it('starts with the shipped reason prompt, byte for byte', () => {
    expect(spec().systemPrompts!.reason!.startsWith(CLOUD_REASON_SYSTEM_PROMPT)).toBe(true);
    expect(
      spec().systemPrompts!.headlineReason!.startsWith(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT),
    ).toBe(true);
  });

  it('adds the same block to both reason slots', () => {
    const a = spec().systemPrompts!.reason!.slice(CLOUD_REASON_SYSTEM_PROMPT.length);
    const b = spec().systemPrompts!.headlineReason!.slice(
      CLOUD_HEADLINE_REASON_SYSTEM_PROMPT.length,
    );
    expect(a).toBe(b);
    // Pinned so a later edit to the rules restates the cost on purpose. The
    // reason pass sends one article per call, so this rides on every scored
    // article that clears the gate.
    expect(estimateTokens(a)).toBe(433);
  });

  it('ends on the output contract, not on the new rules', () => {
    // The base prompt ends with its own Output line, so the appended block
    // restates it. This family is order-sensitive and the contract has to be
    // the last thing the model reads.
    for (const slot of ['reason', 'headlineReason'] as const) {
      expect(spec().systemPrompts![slot]!.trimEnd()).toMatch(
        /Output: single plain string, no prefixes, no markdown\.$/,
      );
    }
  });

  it('writes its own rules without the punctuation the product bans', () => {
    // The model imitates the prompt it is given, and this block is arguing
    // about prose style, so it cannot itself contain an em or en dash.
    const added = spec().systemPrompts!.reason!.slice(CLOUD_REASON_SYSTEM_PROMPT.length);
    expect(added).not.toMatch(/[—–―]/);
  });
});

describe('reason-v2 changes nothing it is not testing', () => {
  it('leaves both scoring slots on the shipped prompts', () => {
    // A reason arm that perturbed scoring would make its own retrieval numbers
    // incomparable to the baseline's.
    expect(relevanceSystemPromptFor(CFG, 'standard', REASON_V2_ID)).toBe(
      CFG.relevanceSystemPrompt,
    );
    expect(relevanceSystemPromptFor(CFG, 'headline', REASON_V2_ID)).toBe(
      CFG.headlineRelevanceSystemPrompt,
    );
  });

  it('routes both reason slots to the arm', () => {
    expect(reasonSystemPromptFor(CFG, 'standard', REASON_V2_ID)).toBe(
      spec().systemPrompts!.reason,
    );
    expect(reasonSystemPromptFor(CFG, 'headline', REASON_V2_ID)).toBe(
      spec().systemPrompts!.headlineReason,
    );
  });

  it('cannot reach the on-device prompt', () => {
    // LOCAL_REASON_SYSTEM_PROMPT is built on a different base and states its
    // voice rule inline rather than sharing the cloud constant, so there is no
    // path from this arm to it. Asserted because the absence is deliberate.
    expect(LOCAL_REASON_SYSTEM_PROMPT).not.toContain('Three additional rules');
    expect(spec().systemPrompts).not.toHaveProperty('local');
  });

  it('sets no article text cap, so it is not secretly a truncation arm', () => {
    expect(spec().articleTextMaxLength).toBeUndefined();
  });
});

describe('the rules name the patterns they were written for', () => {
  // Cheap, but it is the difference between an arm that encodes the rater's
  // three findings and an arm someone rewrote into something else while keeping
  // the id. Each assertion is one finding.
  const added = () => spec().systemPrompts!.reason!;

  it('covers the middle-band register, with a worked example', () => {
    expect(added()).toMatch(/0\.6 and 0\.8/);
    expect(added()).toMatch(/Worked example/);
  });

  it('bans narrating the feed or its scoring', () => {
    expect(added()).toMatch(/Never describe the feed/);
    expect(added()).toMatch(/warranting a high-relevance feed score/);
  });

  it('requires an honest weak link instead of invented context', () => {
    expect(added()).toMatch(/the connection is loose/);
    expect(added()).toMatch(/Only name a city or country when THIS\s+article is about it/);
  });
});
