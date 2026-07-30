// Pins every DEFAULT_HARNESS_CONFIG literal to the historical production value.
// These are hardcoded expectations (NOT re-derived from the source) so an
// accidental drift in the harness config fails loudly.

import {
  DEFAULT_HARNESS_CONFIG,
  type HarnessConfig,
} from '../core/config';
import {
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_FEED_VERIFIER_SYSTEM_PROMPT,
  CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
  CLOUD_JUDGE_SYSTEM_PROMPT,
  buildJudgeSystemPrompt,
  CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
} from '../prompts/prompts';

describe('DEFAULT_HARNESS_CONFIG.articlePipeline', () => {
  const a = DEFAULT_HARNESS_CONFIG.articlePipeline;

  it('pins the scoring literals', () => {
    expect(a.articlesPerScorePrompt).toBe(5);
    // 80 → 320 with the tiered {"k","s"} relevance output (2026-07-16 prompt
    // rework, validated against the golden-labeled 1000-article prod run).
    expect(a.scoreBatchMaxTokens).toBe(320);
    expect(a.scoreTemperature).toBe(0.1);
    expect(a.reasonTemperature).toBe(0.2);
    expect(a.reasonMaxTokens).toBe(64);
  });

  it('pins the relevance floors', () => {
    expect(a.discardFloor).toBe(0.4);
    expect(a.fallbackRelevance).toBe(0.3);
    expect(a.ineligibleRelevance).toBe(0.2);
    expect(a.reasonRelevanceThreshold).toBe(0.3);
  });

  it('pins the bucket cutoffs and representative values', () => {
    expect(a.mediumPriorityCutoff).toBe(0.6);
    expect(a.highPriorityCutoff).toBe(0.8);
    expect(a.emergencyPriorityCutoff).toBe(1.0);
    expect(a.lowPriorityScore).toBe(0.4);
    expect(a.mediumPriorityScore).toBe(0.6);
    expect(a.highPriorityScore).toBe(0.8);
    expect(a.emergencyPriorityScore).toBe(1.1);
  });

  it('pins the feed-sync limits and model', () => {
    expect(a.limitPerTopic).toBe(20);
    expect(a.hydrateChunkSize).toBe(25);
    expect(a.model).toBe('Qwen/Qwen3.6-35B-A3B-FP8');
  });

  it('wires the cloud scoring prompts', () => {
    expect(a.relevanceSystemPrompt).toBe(CLOUD_RELEVANCE_SYSTEM_PROMPT);
    expect(a.reasonSystemPrompt).toBe(CLOUD_REASON_SYSTEM_PROMPT);
  });

  it('pins the second-pass FEED verifier config (Wave 7b: flag-off, absorbed into judge)', () => {
    // Wave 7b: verifier absorbed into CLOUD_JUDGE_SYSTEM_PROMPT; flag-off one
    // release then deleted. Code + constants stay for the fallback release.
    expect(a.feedVerifierEnabled).toBe(false);
    expect(a.feedVerifierBatchSize).toBe(15);
    expect(a.feedVerifierDemoteScore).toBe(0.28);
    expect(a.feedVerifierMaxTokens).toBe(260);
    expect(a.feedVerifierSystemPrompt).toBe(CLOUD_FEED_VERIFIER_SYSTEM_PROMPT);
  });

  it('pins the combined judge+reason config (Wave 7b)', () => {
    expect(a.judgeChunkSize).toBe(12);
    expect(a.judgeMaxTokens).toBe(560);
    expect(a.judgeReasonFloor).toBe(0.15);
    // Wave 14: the prompt is BUILT from judgeReasonFloor (single source) — the
    // wired prompt must equal the builder applied to the config's own floor,
    // and the default const must match.
    expect(a.judgeSystemPrompt).toBe(buildJudgeSystemPrompt(a.judgeReasonFloor));
    expect(a.judgeSystemPrompt).toBe(CLOUD_JUDGE_SYSTEM_PROMPT);
    // The floor is genuinely injected, not a coincidental literal:
    expect(buildJudgeSystemPrompt(0.22)).toContain('≥ 0.22');
    expect(buildJudgeSystemPrompt(0.22)).not.toContain('≥ 0.15,');
    // Wave 14: the demote-floor recall experiments were REVERTED (see the
    // buildJudgeSystemPrompt doc note) — the demote-when-in-doubt rule must
    // remain the unqualified wave-7b original.
    expect(a.judgeSystemPrompt).toContain(
      'over-inclusion is the failure mode you exist to fix.',
    );
    expect(a.judgeSystemPrompt).not.toContain('EXCEPTION');
  });

  it('pins the headline variant config (P4a — authored, not yet routed)', () => {
    // 3 = 5 × (4386 / 6600), the measured inverse-rubric-length scaling — see
    // the arithmetic comment in config.ts. Changing it is a product change.
    expect(a.headlineArticlesPerScorePrompt).toBe(3);
    expect(a.headlineRelevanceSystemPrompt).toBe(CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT);
    expect(a.headlineReasonSystemPrompt).toBe(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT);
    // The headline variants must stay VARIANTS: same base prompt, so tiers,
    // FEED gates, anchors and the {"k","s"} contract cannot drift from live.
    // (The base is module-private; these are load-bearing excerpts of it.)
    for (const p of [a.headlineRelevanceSystemPrompt, a.headlineReasonSystemPrompt]) {
      expect(p).toContain('## Product tiers (hard boundaries');
      expect(p).toContain('**FEED — 0.40 to 1.10.**');
      expect(p).toContain('## FEED gates (within 0.40–1.10; each band needs its named evidence)');
      expect(p).toContain('## Anchors (example user: software engineer in Amsterdam');
    }
    // Output contract: no new `k` value. A passed impact chain is tagged
    // "home", which STAKE_SCORE_BANDS (article-pipeline/scoring.ts) already
    // clamps to [0.40, 1.10]; an invented tag would skip clampToStakeBand and
    // silently lose the band discipline the magnitude test depends on.
    expect(a.headlineRelevanceSystemPrompt).toContain(
      'a passed impact chain is `"home"`, since the chain ends at their household',
    );
    expect(a.headlineRelevanceSystemPrompt).not.toContain('"k":"impact"');
  });

  it('pins the headline impact rubric (the four gates + the escape hatch)', () => {
    // Every assertion below is a rule the feature is INERT without. The base
    // prompt forbids exactly this reasoning ("global implications … forbidden",
    // "No holdings ⇒ no market relevance"), so the carve-out must name both
    // rules explicitly — later-instruction-wins ordering is not enough.
    for (const p of [a.headlineRelevanceSystemPrompt, a.headlineReasonSystemPrompt]) {
      expect(p).toContain('## Headline override — indirect impact (this batch only)');
      expect(p).toContain(
        'It SUSPENDS exactly two of the Hard rules above — "Do NOT bridge via … \'global implications\' … these produce phantom relevance and are forbidden" and "No holdings ⇒ no market relevance"',
      );
      expect(p).toContain('If any one of the four fails, both suspended rules apply again in full and unchanged.');
      // Closed vocabulary — nothing is stored server-side, so the list IS the
      // schema. Losing it turns the feature into free-form hedging.
      expect(p).toContain('### Impact channels (CLOSED LIST)');
      expect(p).toContain(
        'fuel_prices · food_prices · power_tariffs · electricity_supply · currency · interest_rates · job_market · export_demand · supply_chain · shipping_costs · travel_disruption · visa_immigration · insurance_costs · medicine_supply · internet_connectivity · housing_costs · taxes_and_subsidies · equity_markets · gold',
      );
      // Exposure gate — this is what keeps "no holdings ⇒ no market relevance"
      // CARVED rather than repealed.
      expect(p).toContain(
        '**equity_markets, gold** — require investments listed in [User facts]. With no investments they are UNAVAILABLE',
      );
      // Magnitude / shock-absorption + the hop-count evidence rule.
      expect(p).toContain('### Magnitude test (shock size RELATIVE to the absorbing economy)');
      expect(p).toContain(
        'A SMALL shock landing on a LARGE, diversified, buffered economy does NOT propagate.',
      );
      expect(p).toContain('**Hop count is evidence.**');
      // Grounding: mechanism from the article's own text, never from memory.
      expect(p).toContain('### Grounding (the mechanism comes from the article, not from memory)');
      // The escape hatch, stated as a rule, plus the anti-hedging line that
      // makes it the DEFAULT rather than a permitted option.
      expect(p).toContain('### The escape hatch — this is the NORMAL answer');
      // An indirect chain must never outrank a direct stake: 0.80+ stays
      // reserved for a change to their own work/home/family, 0.95+ for danger
      // where they are. Without this cap a fuel-price chain could outscore a
      // flood in the family's city.
      expect(p).toContain('**An indirect chain never exceeds 0.79.**');
      expect(p).toContain(
        'A hedged "may indirectly influence" is a WRONG answer, not a safe one — hedging IS the failure mode here.',
      );
      // BOTH worked examples. The negative one is load-bearing: without a
      // worked EXCLUDE the rubric reads as an invitation to find a chain.
      expect(p).toContain('**POSITIVE — chain holds.**');
      expect(p).toContain('`{"k":"home","s":0.72}`');
      expect(p).toContain('**NEGATIVE — chain does NOT hold, and this is the more common verdict.**');
      expect(p).toContain('`{"k":"none","s":0.13}`');
      expect(p).toContain('it does not affect your costs in Amsterdam.');
    }
  });

  it('pins the headline reason contract (word cap, channels, no hedging, shared voice)', () => {
    const r = a.headlineReasonSystemPrompt;
    expect(r).toContain('write ONE plain sentence (≤35 words)');
    expect(r).toContain('name at most 2–3 channels from the closed list');
    expect(r).toContain(
      'Do NOT hedge. "May", "could", "might", "potentially", "possibly" are banned unless the article itself states the event is conditional or threatened rather than happening',
    );
    expect(r).toContain('never "global implications" or "economic impact"');
    // Three reason bands, not two. The headline SCORE prompt can still emit
    // "interest" (0.25–0.39) for a genuine interest-category match that was
    // never judged on the chain — explaining that with magnitude/absorption
    // language would report a rejection that never happened.
    expect(r).toContain(
      'When the score is 0.25–0.39 the article is a TANGENTIAL interest match, NOT a failed chain — it was never judged on impact.',
    );
    expect(r).toContain(
      'Do NOT use chain language here: no channels, no "absorbed", no magnitude talk, no mechanism — there was no chain to reject.',
    );
    expect(r).toContain('When the score is below 0.25, say plainly that the story does not affect them');
    // Second-person voice: the SAME const the live reason prompt uses, not a
    // retyped copy (nothing else pins this paragraph's content).
    const VOICE =
      'Voice. The reason is read BY the user, so write it TO them — "you"/"your", never "the user", "User …", or any third person. This holds in EVERY band, low scores included.';
    expect(r).toContain(VOICE);
    expect(CLOUD_REASON_SYSTEM_PROMPT).toContain(VOICE);
  });

  it('pins the second-person voice rule on the judge reason ("r")', () => {
    // QA 2026-07-28: the judge leaked third-person framing into a user-facing
    // reason ("User follows Formula 1; …"). The low-band exemplars carried no
    // pronoun at all, so nothing anchored the voice on demotes. The rule + the
    // wrong/right pair below is the ONLY fix (no output post-processing) —
    // removing either re-opens the leak.
    expect(a.judgeSystemPrompt).toContain(
      '"r"` is read BY the user, so write it TO them — "you"/"your", never "the user", "User …", or any third person.',
    );
    expect(a.judgeSystemPrompt).toContain('This holds in EVERY band, demotes included.');
    expect(a.judgeSystemPrompt).toContain(
      'Wrong: "User follows Formula 1; the race matches this interest, no personal stake."',
    );
    expect(a.judgeSystemPrompt).toContain(
      'Right: "The race matches your Formula 1 interest, but carries no personal stake."',
    );
    // Every exemplar reason in the prompt addresses the reader — including the
    // demote-band one, which previously had no pronoun.
    expect(a.judgeSystemPrompt).toContain(
      '"r":"Amsterdam restaurant roundup is lifestyle filler in your city, no real stake."',
    );
  });
});

describe('DEFAULT_HARNESS_CONFIG.topicGen', () => {
  const t = DEFAULT_HARNESS_CONFIG.topicGen;

  it('pins the topic-gen literals', () => {
    // 2026-07-16: reduced 16→10 / 14→10 (deliberate product change — see
    // config.ts comment; golden-labeled baseline showed worst 25% of topics
    // cuttable with 0% true-FEED loss).
    expect(t.totalCloud).toBe(10);
    expect(t.totalLocal).toBe(10);
    expect(t.temperature).toBe(0.3);
    expect(t.maxFactLength).toBe(200);
    // Wave 11: seed weight for LLM-minted `topics` rows.
    expect(t.llmTopicWeight).toBe(0.75);
  });

  it('wires the cloud topic-gen prompts', () => {
    expect(t.factOnlySystemPrompt).toBe(CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT);
    expect(t.comboSystemPrompt).toBe(CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT);
  });
});

describe('DEFAULT_HARNESS_CONFIG.scoringEngine', () => {
  const e = DEFAULT_HARNESS_CONFIG.scoringEngine;

  it('pins the article-tagging policy to OFF', () => {
    // Added with the EXPO_PUBLIC_USE_ARTICLE_TAGS switch. NOT a tunable weight —
    // a routing switch: false means every article is presented to the engine as
    // untagged, so it takes the legacy two-pass LLM path, which is exactly what
    // production does today (the server-side enrichment stage has never run).
    // Flipping this literal changes how EVERY article is scored the moment the
    // server starts emitting tags, so it is pinned here deliberately.
    expect(e.USE_ARTICLE_TAGS).toBe(false);
  });

  it('pins the affinity component weights (positives sum ≈ 1.0)', () => {
    // Round-3 A2: freshness (W_FRESH 0.08) removed; the seven remaining positive
    // weights renormalized ÷0.92 so full-saturation affinity stays ≈1.0.
    expect(e.W_TOPIC).toBe(0.348);
    expect(e.W_BREADTH).toBe(0.109);
    expect(e.W_GEO).toBe(0.217);
    expect(e.W_ENTITY).toBe(0.087);
    expect(e.W_EVENT).toBe(0.054);
    expect(e.W_PUB).toBe(0.076);
    expect(e.W_POP).toBe(0.109);
    const sum =
      e.W_TOPIC + e.W_BREADTH + e.W_GEO + e.W_ENTITY + e.W_EVENT + e.W_PUB + e.W_POP;
    expect(Number(sum.toFixed(6))).toBe(1.0);
  });

  it('pins breadth saturation + vectorScore modulation knees', () => {
    expect(e.BREADTH_SAT).toBe(2);
    expect(e.VS_LO).toBe(0.78);
    expect(e.VS_HI).toBe(0.9);
  });

  it('pins the affinity → raw band mapping', () => {
    expect(e.BASE_OFFSET).toBe(0.05);
    expect(e.BASE_SLOPE).toBe(1.05);
    expect(e.BASE_MIN).toBe(0.05);
    expect(e.BASE_MAX).toBe(1.1);
  });

  it('pins the penalties', () => {
    expect(e.P_NEG).toBe(0.45);
    expect(e.P_SUP).toBe(0.3);
    expect(e.P_SUP_CAP).toBe(0.6);
    expect(e.P_WRONG).toBe(0.55);
    expect(e.P_SEEN).toBe(0.08);
  });

  it('pins topic weighting + popularity saturation', () => {
    // Round-3 A2 removed the freshness knees (FRESH_FULL/DECAY/MID/OLD).
    expect(e.HP_MULT).toBe(1.25);
    expect(e.POP_SAT).toBe(32);
  });

  it('pins geo alignment multipliers + headline floor', () => {
    expect(e.GEO_CITY).toBe(1.0);
    expect(e.GEO_REGION).toBe(0.6);
    expect(e.GEO_COUNTRY).toBe(0.3);
    expect(e.HEADLINE_BASE_FLOOR).toBe(0.35);
    expect(e.HEADLINE_POP_LIFT).toBe(0.15);
  });

  it('pins the headline section pseudo-weights (feed-select M-P5b)', () => {
    // Added Wave 7b-core M-P5b for the fact-sectioned feed selector
    // (feed-select/sections.ts). Synthetic headline sections order against real
    // fact sections on one weight axis: CITY/COUNTRY = 0.55 × location.weight,
    // GLOBAL = fixed 0.35. Deliberate literal additions — see config.ts.
    expect(e.HEADLINE_SECTION_BASE).toBe(0.55);
    expect(e.GLOBAL_SECTION_WEIGHT).toBe(0.35);
  });
});

describe('DEFAULT_HARNESS_CONFIG.mutationRails', () => {
  const m = DEFAULT_HARNESS_CONFIG.mutationRails;

  it('pins the bounded-mutation rail literals (Wave 8 M-P6)', () => {
    expect(m.NUDGE_DAY_BUDGET).toBe(0.3);
    expect(m.SHOW_LESS).toBe(-0.15);
    expect(m.THUMBS_DOWN).toBe(-0.1);
    expect(m.WRONG_LOCATION_NEG_TOPIC).toBe(-0.6);
  });
});

describe('HarnessConfig shape', () => {
  it('exposes all sub-configs', () => {
    const cfg: HarnessConfig = DEFAULT_HARNESS_CONFIG;
    expect(cfg.articlePipeline).toBeDefined();
    expect(cfg.topicGen).toBeDefined();
    expect(cfg.scoringEngine).toBeDefined();
    expect(cfg.mutationRails).toBeDefined();
  });
});
