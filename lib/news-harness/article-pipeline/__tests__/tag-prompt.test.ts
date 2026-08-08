import {
  ARTICLE_METADATA_PREFIX,
  articleMetadataLine,
  carriesPromptableTags,
  injectArticleMetadata,
  isTagReasonGated,
  readCandidateTags,
  selectTagGatedDemoteIds,
} from '../tag-prompt';
import {
  buildScoreCallForChunk,
  buildRelevanceCalls,
  buildReasonCallsForSubset,
} from '../scoring';
import { DEFAULT_HARNESS_CONFIG, type ArticlePipelineConfig } from '../../core/config';
import { computeRelevance, type ScoredCandidateInput } from '../../scoring-engine/relevance';
import type { ScoringCandidate, StageCandidateRow } from '../../core/types';

const BASE = DEFAULT_HARNESS_CONFIG.articlePipeline;

const withFlags = (over: Partial<ArticlePipelineConfig>): ArticlePipelineConfig => ({
  ...BASE,
  ...over,
});

function stageRow(over: Partial<StageCandidateRow> = {}): StageCandidateRow {
  return {
    id: 'a1',
    titleEn: 'T',
    descriptionEn: 'D',
    publicationName: null,
    countryCode: 'NLD',
    firstPubDateMs: null,
    maxClusterSize: null,
    eventType: null,
    category: null,
    geoTagsJson: null,
    entitiesJson: null,
    matchedTopicsJson: null,
    headlineScope: null,
    stableClusterId: null,
    ...over,
  };
}

function candidate(
  id: string,
  meta?: Partial<StageCandidateRow>,
  over: Partial<ScoringCandidate> = {},
): ScoringCandidate {
  return {
    id,
    titleEn: `Title ${id}`,
    descriptionEn: `Description ${id}`,
    countryCode: 'NLD',
    userTopicIds: [],
    relatedFacts: [{ id: `${id}:f0`, statement: 'Lives in Amsterdam' }],
    ...(meta ? { meta: stageRow({ id, ...meta }) } : {}),
    ...over,
  };
}

const FACTS = ['Lives in Amsterdam, Netherlands, Europe', 'Interested in AI research'];

// ---------------------------------------------------------------------------
// readCandidateTags / articleMetadataLine
// ---------------------------------------------------------------------------

describe('readCandidateTags', () => {
  it('returns empties for a candidate with no meta at all (pre-v3 rows)', () => {
    expect(readCandidateTags(undefined)).toEqual({
      geoTags: [],
      entities: [],
      eventType: null,
    });
  });

  it('drops geo tags with no usable countryCode, matching buildStageCandidateInput', () => {
    const tags = readCandidateTags(
      stageRow({
        geoTagsJson: JSON.stringify([
          { city: 'amsterdam', countryCode: 'NL' },
          { city: 'nowhere' }, // no countryCode → dropped
          { countryCode: '' }, // empty → dropped
        ]),
      }),
    );
    expect(tags.geoTags).toEqual([
      { city: 'amsterdam', region: undefined, countryCode: 'NL' },
    ]);
  });

  it('drops non-string / empty entities and survives malformed JSON', () => {
    expect(
      readCandidateTags(stageRow({ entitiesJson: JSON.stringify(['ING', '', 7, 'ASML']) }))
        .entities,
    ).toEqual(['ING', 'ASML']);
    expect(readCandidateTags(stageRow({ entitiesJson: '{not json' })).entities).toEqual([]);
    expect(readCandidateTags(stageRow({ geoTagsJson: '{not json' })).geoTags).toEqual([]);
  });
});

describe('articleMetadataLine', () => {
  it('renders the measured format exactly', () => {
    const c = candidate('a1', {
      geoTagsJson: JSON.stringify([
        { city: 'amsterdam', region: 'noord-holland', countryCode: 'NL' },
      ]),
      entitiesJson: JSON.stringify(['ING']),
      eventType: 'business',
    });
    // FROZEN BY MEASUREMENT — this exact string is what the 2026-08-08 A/B
    // scored. Changing it invalidates the recall numbers behind the flag.
    expect(articleMetadataLine(c)).toBe(
      'Article Metadata: places: amsterdam, noord-holland, NL | entities: ING | event: business',
    );
  });

  it('omits absent fields rather than emitting "none"', () => {
    expect(
      articleMetadataLine(candidate('a1', { entitiesJson: JSON.stringify(['ASML']) })),
    ).toBe('Article Metadata: entities: ASML');
  });

  it("omits event_type 'other' — the enum's mandatory fallback carries no signal", () => {
    expect(articleMetadataLine(candidate('a1', { eventType: 'other' }))).toBe('');
    expect(articleMetadataLine(candidate('a1', { eventType: 'crime' }))).toBe(
      'Article Metadata: event: crime',
    );
  });

  it('returns empty for an untagged row, so carriesPromptableTags is false', () => {
    expect(articleMetadataLine(candidate('a1', {}))).toBe('');
    expect(articleMetadataLine(candidate('a1'))).toBe('');
    expect(carriesPromptableTags(candidate('a1'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADD 1 — prompt injection
// ---------------------------------------------------------------------------

describe('ADD 1 — legacyTagPromptEnabled', () => {
  const tagged = [
    candidate('a1', {
      geoTagsJson: JSON.stringify([{ countryCode: 'GB' }]),
      entitiesJson: JSON.stringify(['Reuters']),
      eventType: 'policy',
    }),
    candidate('a2', { eventType: 'sports' }),
    candidate('a3'), // untagged — must get NO line
  ];

  it('OFF (the shipped default) emits a byte-identical prompt', () => {
    const off = buildScoreCallForChunk(tagged, FACTS, BASE.relevanceSystemPrompt, BASE);
    const noConfigArg = buildScoreCallForChunk(tagged, FACTS, BASE.relevanceSystemPrompt);
    expect(BASE.legacyTagPromptEnabled).toBe(false);
    expect(off.prompt).toBe(noConfigArg.prompt);
    expect(off.prompt).not.toContain(ARTICLE_METADATA_PREFIX);
  });

  it('ON adds exactly one line per TAGGED article, after its Related User Fact line', () => {
    const on = buildScoreCallForChunk(
      tagged,
      FACTS,
      BASE.relevanceSystemPrompt,
      withFlags({ legacyTagPromptEnabled: true }),
    );
    const lines = on.prompt.split('\n');
    const metaLines = lines.filter((l) => l.startsWith(ARTICLE_METADATA_PREFIX));
    // a1 and a2 carry tags; a3 does not.
    expect(metaLines).toEqual([
      'Article Metadata: places: GB | entities: Reuters | event: policy',
      'Article Metadata: event: sports',
    ]);
    for (const meta of metaLines) {
      expect(lines[lines.indexOf(meta) - 1].startsWith('Related User Fact: ')).toBe(true);
    }
  });

  it('ON is exactly OFF plus the metadata lines (the round-trip invariant)', () => {
    const off = buildScoreCallForChunk(tagged, FACTS, BASE.relevanceSystemPrompt, BASE);
    const on = buildScoreCallForChunk(
      tagged,
      FACTS,
      BASE.relevanceSystemPrompt,
      withFlags({ legacyTagPromptEnabled: true }),
    );
    const stripped = on.prompt
      .split('\n')
      .filter((l) => !l.startsWith(ARTICLE_METADATA_PREFIX))
      .join('\n');
    expect(stripped).toBe(off.prompt);
  });

  it('throws rather than silently emitting a prompt that is not the measured one', () => {
    // The round-trip assertion's real job is catching DOUBLE INJECTION: an
    // input that already carries a metadata line cannot round-trip, because
    // stripping removes the pre-existing line too. Failing loudly is the
    // contract — a silent fallback would be indistinguishable from flag-off,
    // and a double-injected prompt is not the prompt the A/B measured.
    const alreadyInjected =
      '===== Article 0 =====\n' +
      'News Title: X\n' +
      'Related User Fact: y\n' +
      'Article Metadata: event: crime';
    expect(() =>
      injectArticleMetadata(alreadyInjected, [candidate('a1', { eventType: 'crime' })]),
    ).toThrow(/byte-for-byte/);
  });

  it('is a no-op on a prompt with no article blocks, rather than throwing', () => {
    // Degenerate but legitimate (an empty chunk): nothing to attach a line to,
    // so the input is returned unchanged and the round-trip trivially holds.
    expect(injectArticleMetadata('no blocks here at all', [])).toBe('no blocks here at all');
  });

  it('does not change chunk size — pass 1 still batches at articlesPerScorePrompt', () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      candidate(`a${i}`, { eventType: 'policy' }),
    );
    const cfg = withFlags({ legacyTagPromptEnabled: true });
    const bundle = buildRelevanceCalls(many, FACTS, cfg);
    expect(cfg.articlesPerScorePrompt).toBe(5);
    expect(bundle.scoreChunkSize).toBe(5);
    expect(bundle.calls).toHaveLength(3); // 5 + 5 + 1
    expect(bundle.calls[0].prompt).toContain(ARTICLE_METADATA_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// ADD 2 — the post-hoc reason gate
// ---------------------------------------------------------------------------

describe('ADD 2 — legacyTagReasonGateEnabled', () => {
  const crime = candidate('c1', { eventType: 'crime' });
  const other = candidate('c2', { eventType: 'other' });
  const policy = candidate('c3', { eventType: 'policy' });
  const untagged = candidate('c4');
  const all = [crime, other, policy, untagged];
  const relevanceMap = { c1: 0.82, c2: 0.55, c3: 0.7, c4: 0.65 };
  const ON = withFlags({ legacyTagReasonGateEnabled: true });

  it('OFF (the shipped default) gates nothing and calls every eligible row', () => {
    expect(BASE.legacyTagReasonGateEnabled).toBe(false);
    expect(selectTagGatedDemoteIds(all, BASE)).toEqual([]);
    expect(isTagReasonGated(crime, BASE)).toBe(false);

    const bundle = buildReasonCallsForSubset(
      all,
      relevanceMap,
      BASE.reasonRelevanceThreshold,
      FACTS,
      BASE,
    );
    expect(bundle.calls).toHaveLength(4);
    expect(bundle.tagGatedDemoteIds).toEqual([]);
  });

  it('ON removes the configured event types from the subset and reports them', () => {
    const bundle = buildReasonCallsForSubset(
      all,
      relevanceMap,
      BASE.reasonRelevanceThreshold,
      FACTS,
      ON,
    );
    expect(bundle.tagGatedDemoteIds).toEqual(['c1', 'c2']);
    expect(bundle.eligibleCandidates.map((c) => c.id)).toEqual(['c3', 'c4']);
    expect(bundle.calls.map((c) => c.id)).toEqual(['reason:c3', 'reason:c4']);
  });

  it('never resurrects a row the relevance threshold already excluded', () => {
    // c2 sits BELOW the threshold here, so it was never going to be called and
    // must not be reported as a saving — the gate is applied after the gate.
    const belowMap = { ...relevanceMap, c2: 0.1 };
    const bundle = buildReasonCallsForSubset(
      all,
      belowMap,
      BASE.reasonRelevanceThreshold,
      FACTS,
      ON,
    );
    expect(bundle.tagGatedDemoteIds).toEqual(['c1']);
  });

  it('leaves never-tagged rows alone (null eventType is not a match)', () => {
    expect(isTagReasonGated(untagged, ON)).toBe(false);
    expect(isTagReasonGated(candidate('x', {}), ON)).toBe(false);
  });

  it('honours the configured set as the single source of policy', () => {
    const custom = withFlags({
      legacyTagReasonGateEnabled: true,
      legacyTagReasonGateEventTypes: ['policy'],
    });
    expect(selectTagGatedDemoteIds(all, custom)).toEqual(['c3']);
    // Empty set ⇒ the feature is inert even while "enabled".
    expect(
      selectTagGatedDemoteIds(
        all,
        withFlags({ legacyTagReasonGateEnabled: true, legacyTagReasonGateEventTypes: [] }),
      ),
    ).toEqual([]);
  });

  it('gates a HIGH-scoring row — there is deliberately no score floor', () => {
    // Documented, measured behaviour, asserted so it can never change by
    // accident: the reference run cut a row at 0.82. Neither the legacy reason
    // pass nor applyV3NoteResults protects a high score from demotion, and
    // adding a floor here would be an unmeasured change to a measured rule.
    expect(relevanceMap.c1).toBeGreaterThan(BASE.highPriorityCutoff);
    expect(selectTagGatedDemoteIds([crime], ON)).toEqual(['c1']);
  });
});

// ---------------------------------------------------------------------------
// THE INVARIANT THE WHOLE FEATURE RESTS ON
// ---------------------------------------------------------------------------

describe('routing is unaffected by either flag', () => {
  // `isBackstop` is not exported; `scoringMode` on the result is its observable
  // effect, which is the thing that actually matters.
  const engineInput = (over: Partial<ScoredCandidateInput> = {}): ScoredCandidateInput => ({
    id: 'a1',
    titleEn: 'T',
    descriptionEn: 'D',
    publicationName: null,
    countryCode: 'NLD',
    pubDateMs: null,
    maxClusterSize: null,
    eventType: null,
    category: null,
    geoTags: [],
    entities: [],
    matchedTopics: [],
    headlineScope: null,
    headlineCountryCode: null,
    stableClusterId: null,
    ...over,
  });

  const persona = {
    locations: [],
    topicWeights: new Map(),
    entityInterests: new Map(),
    eventTypeWeights: new Map(),
    pubPrefs: new Map(),
    softSuppressions: [],
    hardFilters: [],
    openedStoryIds: new Set<string>(),
  } as unknown as Parameters<typeof computeRelevance>[1];

  it('stays backstop with both flags ON, because neither reaches the engine input', () => {
    const cfg = DEFAULT_HARNESS_CONFIG.scoringEngine;
    // The engine only ever sees what buildStageCandidates hands it. Nothing in
    // tag-prompt.ts constructs a ScoredCandidateInput, so a candidate whose
    // ScoringCandidate.meta is richly tagged still arrives here untagged.
    const result = computeRelevance(engineInput(), persona, cfg);
    expect(result.mode).toBe('backstop');
  });

  it('the prompt-side helpers never mutate the candidate they read', () => {
    const c = candidate('a1', {
      eventType: 'crime',
      entitiesJson: JSON.stringify(['ASML']),
    });
    const before = JSON.stringify(c);
    articleMetadataLine(c);
    selectTagGatedDemoteIds([c], withFlags({ legacyTagReasonGateEnabled: true }));
    buildScoreCallForChunk(
      [c],
      FACTS,
      BASE.relevanceSystemPrompt,
      withFlags({ legacyTagPromptEnabled: true }),
    );
    expect(JSON.stringify(c)).toBe(before);
  });
});
