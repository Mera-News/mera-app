// The prompt-variant seam.
//
// The whole seam rests on ONE property: with no arm named, nothing changes.
// It sits on the production scoring path, so if 'baseline' is not a perfect
// no-op then every user is running an experiment. That property is asserted
// first and on every builder, against BOTH "argument omitted" and "argument is
// 'baseline'", because those are different code paths through
// `resolvePromptVariant` and only one of them is what production does.
//
// Everything else here protects the seam from being useful in the wrong way:
// an unknown arm must throw rather than quietly score the control, and the
// control must not be replaceable at all.
import {
  buildBatchScoringUserMessage,
  buildFeedVerifierUserMessage,
  buildReasonUserMessage,
  buildLocalReasonUserMessage,
} from '../prompts/prompts';
import {
  BASELINE_VARIANT_ID,
  promptHash,
  normalizeForHash,
  promptVariantIds,
  registerPromptVariant,
  resetPromptVariantsForTest,
  resolvePromptVariant,
  systemPromptForSlot,
  type PromptVariantSpec,
} from '../prompts/prompt-variants';
import {
  relevanceSystemPromptFor,
  reasonSystemPromptFor,
  buildScoreCallForChunk,
} from '../article-pipeline/scoring';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import type { ScoringCandidate } from '../core/types';

const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;
const NONCE = 'abcdef012345';

const ARTICLES = [
  {
    title: 'Amsterdam transit strike enters second day',
    description: 'Services on four lines are suspended while talks continue.',
    country: 'Netherlands',
    relatedFacts: ['Lives in Amsterdam, Netherlands, Europe'],
  },
];

function candidate(over: Partial<ScoringCandidate> = {}): ScoringCandidate {
  return {
    id: 'a1',
    titleEn: 'Amsterdam transit strike enters second day',
    descriptionEn: 'Services on four lines are suspended while talks continue.',
    countryCode: 'NL',
    relatedFacts: [{ id: 'f1', statement: 'Lives in Amsterdam' }],
    ...over,
  } as ScoringCandidate;
}

afterEach(() => {
  resetPromptVariantsForTest();
});

describe("'baseline' is a perfect no-op", () => {
  it('batch scoring: omitted, explicit baseline and pre-seam output all agree', () => {
    const omitted = buildBatchScoringUserMessage({
      userContext: '[User facts] a.',
      articles: ARTICLES,
      nonce: NONCE,
    });
    const explicit = buildBatchScoringUserMessage({
      userContext: '[User facts] a.',
      articles: ARTICLES,
      nonce: NONCE,
      promptVariant: BASELINE_VARIANT_ID,
    });
    expect(explicit).toBe(omitted);
    // The pre-seam shape, spelled out rather than snapshotted so a reader can
    // see what "unchanged" means here.
    expect(omitted).toContain('===== Article 0 =====');
    expect(omitted).toContain(`<<ARTICLE ${NONCE}>>`);
    expect(omitted).toContain('Services on four lines are suspended');
  });

  it('feed verifier: omitted and explicit baseline agree', () => {
    const omitted = buildFeedVerifierUserMessage({
      userContext: '[User facts] a.',
      articles: ARTICLES,
      nonce: NONCE,
    });
    expect(
      buildFeedVerifierUserMessage({
        userContext: '[User facts] a.',
        articles: ARTICLES,
        nonce: NONCE,
        promptVariant: BASELINE_VARIANT_ID,
      }),
    ).toBe(omitted);
  });

  it('cloud reason: omitted and explicit baseline agree', () => {
    const base = {
      userContext: '[User facts] a.',
      articleTitle: ARTICLES[0].title,
      articleDescription: ARTICLES[0].description,
      articleCountry: 'Netherlands',
      relevance: 0.62,
      relatedFacts: ['Lives in Amsterdam'],
      nonce: NONCE,
    };
    expect(buildReasonUserMessage({ ...base, promptVariant: BASELINE_VARIANT_ID })).toBe(
      buildReasonUserMessage(base),
    );
  });

  it('system prompt selectors return the shipped prompts', () => {
    for (const v of ['standard', 'headline'] as const) {
      expect(relevanceSystemPromptFor(CFG, v, BASELINE_VARIANT_ID)).toBe(
        relevanceSystemPromptFor(CFG, v),
      );
      expect(reasonSystemPromptFor(CFG, v, BASELINE_VARIANT_ID)).toBe(
        reasonSystemPromptFor(CFG, v),
      );
    }
    expect(relevanceSystemPromptFor(CFG, 'standard')).toBe(CFG.relevanceSystemPrompt);
    expect(relevanceSystemPromptFor(CFG, 'headline')).toBe(
      CFG.headlineRelevanceSystemPrompt,
    );
    expect(reasonSystemPromptFor(CFG, 'headline')).toBe(CFG.headlineReasonSystemPrompt);
  });

  it('buildScoreCallForChunk agrees with itself across both spellings', () => {
    const a = buildScoreCallForChunk([candidate()], ['Lives in Amsterdam'], undefined, CFG);
    const b = buildScoreCallForChunk(
      [candidate()],
      ['Lives in Amsterdam'],
      undefined,
      CFG,
      BASELINE_VARIANT_ID,
    );
    expect(b.system).toBe(a.system);
    // The nonce differs per build by design, so compare with it normalised —
    // the same thing golden-prompts.test.ts does.
    expect(normalizeForHash(b.prompt)).toBe(normalizeForHash(a.prompt));
  });
});

describe('resolving an arm', () => {
  it('ships the baseline plus the committed truncation arms, and nothing else', () => {
    // NOT "only the baseline": the truncation arms are permanent registry
    // members. This assertion read `[BASELINE_VARIANT_ID]` when it was written
    // and kept passing after they landed, because `afterEach` had already run
    // a reset that deleted them — a green test measuring post-reset state
    // instead of the shipped registry. The reset restores them now.
    expect(promptVariantIds().sort()).toEqual(
      [BASELINE_VARIANT_ID, 'trunc-1200', 'trunc-800'].sort(),
    );
  });

  it('the truncation arms carry the caps their ids claim', () => {
    expect(resolvePromptVariant('trunc-800').articleTextMaxLength).toBe(800);
    expect(resolvePromptVariant('trunc-1200').articleTextMaxLength).toBe(1200);
    // And they change nothing else, so a truncation result stays attributable
    // to the cap rather than to a prompt edit riding along with it.
    expect(resolvePromptVariant('trunc-800').systemPrompts).toBeUndefined();
    expect(resolvePromptVariant('trunc-1200').systemPrompts).toBeUndefined();
  });

  it('undefined resolves to the baseline', () => {
    expect(resolvePromptVariant().id).toBe(BASELINE_VARIANT_ID);
    expect(resolvePromptVariant(BASELINE_VARIANT_ID).id).toBe(BASELINE_VARIANT_ID);
  });

  it('an unknown arm throws instead of silently scoring the control', () => {
    // The whole point: a typo'd arm name that ran the baseline would produce a
    // real-looking result for an experiment that never happened.
    expect(() => resolvePromptVariant('no-such-arm')).toThrow(/Unknown prompt variant/);
    expect(() => resolvePromptVariant('no-such-arm')).toThrow(/baseline/);
  });

  it('an unknown arm throws from the builders too, not just the resolver', () => {
    expect(() =>
      buildBatchScoringUserMessage({
        userContext: 'x',
        articles: ARTICLES,
        nonce: NONCE,
        promptVariant: 'typo',
      }),
    ).toThrow(/Unknown prompt variant/);
    expect(() => relevanceSystemPromptFor(CFG, 'standard', 'typo')).toThrow(
      /Unknown prompt variant/,
    );
  });
});

describe('registering an arm', () => {
  const ARM: PromptVariantSpec = {
    id: 'test-arm',
    description: 'a test arm',
    systemPrompts: { reason: 'REPLACED REASON PROMPT' },
  };

  it('refuses to replace the baseline', () => {
    expect(() =>
      registerPromptVariant({ id: BASELINE_VARIANT_ID, description: 'hijack' }),
    ).toThrow(/cannot be replaced/);
    expect(resolvePromptVariant(BASELINE_VARIANT_ID).description).toContain('shipped');
  });

  it('refuses to redefine an existing arm', () => {
    registerPromptVariant(ARM);
    expect(() => registerPromptVariant({ ...ARM, description: 'different' })).toThrow(
      /already registered/,
    );
  });

  it('overrides only the slot it names', () => {
    registerPromptVariant(ARM);
    // The named slot changes...
    expect(reasonSystemPromptFor(CFG, 'standard', 'test-arm')).toBe(
      'REPLACED REASON PROMPT',
    );
    // ...and nothing else does. An arm testing the reason pass must not perturb
    // scoring, or its retrieval numbers are not comparable to the control's.
    expect(relevanceSystemPromptFor(CFG, 'standard', 'test-arm')).toBe(
      CFG.relevanceSystemPrompt,
    );
    expect(relevanceSystemPromptFor(CFG, 'headline', 'test-arm')).toBe(
      CFG.headlineRelevanceSystemPrompt,
    );
    expect(reasonSystemPromptFor(CFG, 'headline', 'test-arm')).toBe(
      CFG.headlineReasonSystemPrompt,
    );
  });

  it('systemPromptForSlot falls through to the shipped prompt', () => {
    const spec = resolvePromptVariant(BASELINE_VARIANT_ID);
    expect(systemPromptForSlot('reason', 'SHIPPED', spec)).toBe('SHIPPED');
  });
});

describe('articleTextMaxLength', () => {
  const LONG = 'x'.repeat(900);

  beforeEach(() => {
    registerPromptVariant({
      id: 'wide',
      description: 'raise the publisher text cap to 800',
      articleTextMaxLength: 800,
    });
  });

  it('raises the cap on the batch scoring prompt', () => {
    const narrow = buildBatchScoringUserMessage({
      userContext: 'x',
      articles: [{ title: 't', description: LONG }],
      nonce: NONCE,
    });
    const wide = buildBatchScoringUserMessage({
      userContext: 'x',
      articles: [{ title: 't', description: LONG }],
      nonce: NONCE,
      promptVariant: 'wide',
    });
    // Default is asUntrusted's 500; the arm asks for 800.
    expect(narrow).toContain('x'.repeat(500));
    expect(narrow).not.toContain('x'.repeat(501));
    expect(wide).toContain('x'.repeat(800));
    expect(wide).not.toContain('x'.repeat(801));
  });

  it('raises the cap on the cloud reason prompt', () => {
    const base = {
      userContext: 'x',
      articleTitle: 't',
      articleDescription: LONG,
      relevance: 0.62,
      nonce: NONCE,
    };
    expect(buildReasonUserMessage(base)).not.toContain('x'.repeat(501));
    expect(buildReasonUserMessage({ ...base, promptVariant: 'wide' })).toContain(
      'x'.repeat(800),
    );
  });

  it('leaves the LOCAL reason builder on the default cap, with no way to change it', () => {
    // The on-device prompt family is out of scope for prompt experiments and
    // must stay byte-identical, so the seam deliberately stops at the cloud
    // builder. This asserts the absence is real rather than an oversight: there
    // is no promptVariant to pass, and the output is capped at the default even
    // while an arm asking for 800 is registered.
    const local = buildLocalReasonUserMessage({
      userContext: 'x',
      articleTitle: 't',
      articleDescription: LONG,
      relevance: 0.62,
      nonce: NONCE,
    });
    expect(local).toContain('x'.repeat(500));
    expect(local).not.toContain('x'.repeat(501));
  });
});

describe('promptHash', () => {
  it('is stable across two independent builds despite a fresh nonce each time', () => {
    // Without nonce normalisation this is the assertion that fails, and it
    // would make every call look like a prompt change.
    const build = () =>
      buildBatchScoringUserMessage({ userContext: '[User facts] a.', articles: ARTICLES });
    const a = build();
    const b = build();
    expect(a).not.toBe(b);
    expect(promptHash(a)).toBe(promptHash(b));
  });

  it('changes when the prompt content changes', () => {
    const a = buildBatchScoringUserMessage({
      userContext: '[User facts] a.',
      articles: ARTICLES,
      nonce: NONCE,
    });
    const b = buildBatchScoringUserMessage({
      userContext: '[User facts] b.',
      articles: ARTICLES,
      nonce: NONCE,
    });
    expect(promptHash(a)).not.toBe(promptHash(b));
  });

  it('distinguishes the system prompt from the user message', () => {
    // Hashing the concatenation would let a byte move across the boundary
    // unnoticed; the separator is what stops that.
    expect(promptHash('ab', 'c')).not.toBe(promptHash('a', 'bc'));
  });

  it('returns 8 hex characters', () => {
    expect(promptHash('anything')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('normalises both fence markers, open and close', () => {
    const withFence = `<<ARTICLE ${NONCE}>>\nbody\n<</ARTICLE ${NONCE}>>`;
    expect(normalizeForHash(withFence)).toBe('<<FENCE>>\nbody\n<<FENCE>>');
  });
});
