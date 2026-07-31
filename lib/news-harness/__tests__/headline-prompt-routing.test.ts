// P4b — TOP-HEADLINE prompt routing.
//
// P4a authored CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT / _REASON_ and the three
// config fields; nothing routed to them. These tests pin the routing itself:
// which system prompt a call carries, which chunk size the relevance bundle was
// built with, and that a single relevance bundle can never mix the two — the
// last one because the async decoder rebuilds the `score:N` → candidate join by
// re-chunking a flat id list with ONE size, so a mixed bundle would attribute
// scores to the wrong articles with no error anywhere.

import {
  buildRelevanceCalls,
  buildReasonCallsForSubset,
  isHeadlineCandidate,
  isHeadlineScope,
  resolveScoringVariant,
  relevanceSystemPromptFor,
  reasonSystemPromptFor,
  scoreChunkSizeFor,
  CLOUD_SCORE_CHUNK_SIZE,
  CLOUD_HEADLINE_SCORE_CHUNK_SIZE,
} from '../article-pipeline/scoring';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import {
  CLOUD_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
} from '../prompts/prompts';
import type { ScoringCandidate, StageCandidateRow } from '../core/types';

const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;
const FACTS = ['Lives in Amsterdam, Netherlands', 'No investments'];

function meta(
  id: string,
  headlineScope: string | null,
): StageCandidateRow {
  return {
    id,
    titleEn: `Title ${id}`,
    descriptionEn: `Description ${id}`,
    publicationName: null,
    countryCode: null,
    firstPubDateMs: null,
    maxClusterSize: null,
    eventType: null,
    category: null,
    geoTagsJson: null,
    entitiesJson: null,
    matchedTopicsJson: null,
    headlineScope,
    stableClusterId: null,
  };
}

/** A normal (topic-matched) candidate: no stage metadata at all, which is what
 *  a pre-persona-v3 row looks like. */
function standardCandidate(id: string): ScoringCandidate {
  return {
    id,
    titleEn: `Title ${id}`,
    descriptionEn: `Description for ${id}`,
    countryCode: 'NLD',
    userTopicIds: [],
    relatedFacts: [{ id: `f-${id}`, statement: `related fact ${id}` }],
  };
}

function headlineCandidate(
  id: string,
  scope: 'CITY' | 'COUNTRY' | 'GLOBAL' = 'GLOBAL',
): ScoringCandidate {
  return { ...standardCandidate(id), meta: meta(id, scope) };
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

describe('isHeadlineScope / isHeadlineCandidate', () => {
  it('accepts exactly the three scope labels the retrieval profile emits', () => {
    expect(isHeadlineScope('CITY')).toBe(true);
    expect(isHeadlineScope('COUNTRY')).toBe(true);
    expect(isHeadlineScope('GLOBAL')).toBe(true);
  });

  it('rejects null, undefined, and anything else', () => {
    expect(isHeadlineScope(null)).toBe(false);
    expect(isHeadlineScope(undefined)).toBe(false);
    expect(isHeadlineScope('')).toBe(false);
    expect(isHeadlineScope('REGION')).toBe(false);
    expect(isHeadlineScope('global')).toBe(false); // case-sensitive by design
  });

  it('reads the scope off candidate.meta, defaulting to standard with no meta', () => {
    expect(isHeadlineCandidate(headlineCandidate('h'))).toBe(true);
    expect(isHeadlineCandidate(standardCandidate('s'))).toBe(false);
    expect(
      isHeadlineCandidate({ ...standardCandidate('s'), meta: meta('s', null) }),
    ).toBe(false);
  });
});

describe('resolveScoringVariant', () => {
  it('is headline only when EVERY candidate is headline-sourced', () => {
    expect(
      resolveScoringVariant([headlineCandidate('a'), headlineCandidate('b')]),
    ).toBe('headline');
  });

  it('is standard for an all-standard set', () => {
    expect(
      resolveScoringVariant([standardCandidate('a'), standardCandidate('b')]),
    ).toBe('standard');
  });

  it('is standard for a MIXED set — a bundle may never mix the two', () => {
    expect(
      resolveScoringVariant([headlineCandidate('a'), standardCandidate('b')]),
    ).toBe('standard');
    expect(
      resolveScoringVariant([standardCandidate('a'), headlineCandidate('b')]),
    ).toBe('standard');
  });

  it('is standard for an empty set', () => {
    expect(resolveScoringVariant([])).toBe('standard');
  });
});

describe('prompt/chunk selection helpers', () => {
  it('maps the variant onto the P4a config fields', () => {
    expect(relevanceSystemPromptFor(CFG, 'headline')).toBe(
      CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
    );
    expect(relevanceSystemPromptFor(CFG, 'standard')).toBe(
      CLOUD_RELEVANCE_SYSTEM_PROMPT,
    );
    expect(reasonSystemPromptFor(CFG, 'headline')).toBe(
      CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
    );
    expect(reasonSystemPromptFor(CFG, 'standard')).toBe(
      CLOUD_REASON_SYSTEM_PROMPT,
    );
    expect(scoreChunkSizeFor(CFG, 'headline')).toBe(3);
    expect(scoreChunkSizeFor(CFG, 'standard')).toBe(5);
  });

  it('exports the two chunk sizes off the same config fields', () => {
    expect(CLOUD_SCORE_CHUNK_SIZE).toBe(5);
    expect(CLOUD_HEADLINE_SCORE_CHUNK_SIZE).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Relevance pass — prompt AND chunk size
// ---------------------------------------------------------------------------

describe('buildRelevanceCalls — headline routing', () => {
  it('carries the HEADLINE system prompt and chunks at 3 for headline candidates', () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      headlineCandidate(id),
    );
    const bundle = buildRelevanceCalls(candidates, FACTS);

    expect(bundle.scoreChunkSize).toBe(3);
    // 6 candidates at 3 per call = 2 calls, each holding exactly 3.
    expect(bundle.calls.map((c) => c.id)).toEqual(['score:0', 'score:1']);
    expect(bundle.chunkIdToCandidates.get('score:0')?.map((c) => c.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(bundle.chunkIdToCandidates.get('score:1')?.map((c) => c.id)).toEqual([
      'd',
      'e',
      'f',
    ]);
    for (const call of bundle.calls) {
      expect(call.system).toBe(CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT);
    }
  });

  it('carries the STANDARD system prompt and chunks at 5 for normal candidates', () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map(standardCandidate);
    const bundle = buildRelevanceCalls(candidates, FACTS);

    expect(bundle.scoreChunkSize).toBe(5);
    expect(bundle.calls.map((c) => c.id)).toEqual(['score:0', 'score:1']);
    expect(bundle.chunkIdToCandidates.get('score:0')).toHaveLength(5);
    expect(bundle.chunkIdToCandidates.get('score:1')).toHaveLength(1);
    for (const call of bundle.calls) {
      expect(call.system).toBe(CLOUD_RELEVANCE_SYSTEM_PROMPT);
    }
  });

  it('CITY and COUNTRY scopes route to the headline prompt too', () => {
    for (const scope of ['CITY', 'COUNTRY', 'GLOBAL'] as const) {
      const bundle = buildRelevanceCalls(
        [headlineCandidate('a', scope)],
        FACTS,
      );
      expect(bundle.calls[0].system).toBe(
        CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
      );
      expect(bundle.scoreChunkSize).toBe(3);
    }
  });

  it('a bundle NEVER mixes the two: a mixed set falls back wholly to standard', () => {
    const candidates = [
      headlineCandidate('h0'),
      standardCandidate('s0'),
      headlineCandidate('h1'),
      standardCandidate('s1'),
      headlineCandidate('h2'),
      standardCandidate('s2'),
    ];
    const bundle = buildRelevanceCalls(candidates, FACTS);

    // ONE chunk size for the whole bundle — the decoder can only apply one.
    expect(bundle.scoreChunkSize).toBe(5);
    const systems = new Set(bundle.calls.map((c) => c.system));
    expect(systems.size).toBe(1);
    expect([...systems][0]).toBe(CLOUD_RELEVANCE_SYSTEM_PROMPT);
  });

  it('the reported scoreChunkSize always equals the size the chunks were built with', () => {
    for (const candidates of [
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => headlineCandidate(id)),
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(standardCandidate),
    ]) {
      const bundle = buildRelevanceCalls(candidates, FACTS);
      const size = bundle.scoreChunkSize!;
      bundle.calls.forEach((call, i) => {
        const expected = bundle.eligibleCandidates
          .slice(i * size, i * size + size)
          .map((c) => c.id);
        expect(bundle.chunkIdToCandidates.get(call.id)?.map((c) => c.id)).toEqual(
          expected,
        );
      });
    }
  });

  it('an explicit variant overrides the derivation (the mutation-test seam)', () => {
    const candidates = [headlineCandidate('a'), headlineCandidate('b')];
    const forced = buildRelevanceCalls(
      candidates,
      FACTS,
      CFG,
      undefined,
      'standard',
    );
    expect(forced.scoreChunkSize).toBe(5);
    expect(forced.calls[0].system).toBe(CLOUD_RELEVANCE_SYSTEM_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// Reason pass — one call per candidate, so selection is PER candidate
// ---------------------------------------------------------------------------

describe('buildReasonCallsForSubset — headline routing', () => {
  it('selects the headline reason prompt for the headline candidate ONLY', () => {
    const candidates = [
      headlineCandidate('h0'),
      standardCandidate('s0'),
      headlineCandidate('h1'),
    ];
    const relevanceMap = { h0: 0.72, s0: 0.65, h1: 0.44 };

    const bundle = buildReasonCallsForSubset(
      candidates,
      relevanceMap,
      0.3,
      FACTS,
    );

    const systemById = new Map(
      bundle.calls.map((c) => [c.id, c.system] as const),
    );
    expect(systemById.get('reason:h0')).toBe(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT);
    expect(systemById.get('reason:h1')).toBe(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT);
    expect(systemById.get('reason:s0')).toBe(CLOUD_REASON_SYSTEM_PROMPT);
  });

  it('an all-standard subset is untouched by the routing', () => {
    const bundle = buildReasonCallsForSubset(
      [standardCandidate('a'), standardCandidate('b')],
      { a: 0.8, b: 0.9 },
      0.3,
      FACTS,
    );
    for (const call of bundle.calls) {
      expect(call.system).toBe(CLOUD_REASON_SYSTEM_PROMPT);
    }
  });

  it('keeps temperature and maxTokens on the shared config for both variants', () => {
    const bundle = buildReasonCallsForSubset(
      [headlineCandidate('h'), standardCandidate('s')],
      { h: 0.8, s: 0.8 },
      0.3,
      FACTS,
    );
    for (const call of bundle.calls) {
      expect(call.temperature).toBe(CFG.reasonTemperature);
      expect(call.maxTokens).toBe(CFG.reasonMaxTokens);
    }
  });
});

// ---------------------------------------------------------------------------
// P8 — a PURE headline (factless by design) must reach both bundles
// ---------------------------------------------------------------------------
//
// The headline injection writes a SYNTHETIC matched topic with topicId null, so
// persistAndLinkV2Suggestions links no fact to a headline that matched no real
// persona topic. `isEligible` demands relatedFacts.length > 0, so before P8
// these rows were filtered straight out of both bundles: silently absent from
// the relevance bundle (leaving them Unscored and re-elected forever), and
// absent from the reason bundle (leaving them `reason_pending` and invisible).

/** A headline that matched NO real topic — the production shape, factless. */
function pureHeadlineCandidate(
  id: string,
  scope: 'CITY' | 'COUNTRY' | 'GLOBAL' = 'GLOBAL',
): ScoringCandidate {
  return { ...standardCandidate(id), relatedFacts: [], meta: meta(id, scope) };
}

describe('P8 — factless top-headline admission to the bundles', () => {
  it('buildRelevanceCalls includes a factless headline (site 2)', () => {
    const bundle = buildRelevanceCalls([pureHeadlineCandidate('h1')], FACTS);

    expect(bundle.eligibleCandidates.map((c) => c.id)).toEqual(['h1']);
    expect(bundle.calls.length).toBe(1);
  });

  it('a factless headline bundle still routes to the HEADLINE prompt + chunk size', () => {
    const bundle = buildRelevanceCalls(
      [pureHeadlineCandidate('h1'), pureHeadlineCandidate('h2')],
      FACTS,
    );

    expect(bundle.scoreChunkSize).toBe(CLOUD_HEADLINE_SCORE_CHUNK_SIZE);
    expect(bundle.calls[0].system).toBe(CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT);
  });

  it('buildReasonCallsForSubset includes a factless headline that scored (site 3)', () => {
    const bundle = buildReasonCallsForSubset(
      [pureHeadlineCandidate('h1')],
      { h1: 0.65 },
      0.3,
      FACTS,
    );

    expect(bundle.calls.map((c) => c.id)).toEqual(['reason:h1']);
    expect(bundle.calls[0].system).toBe(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT);
  });

  it('a factless row that is NOT headline-sourced is still excluded from both bundles', () => {
    const orphan: ScoringCandidate = { ...standardCandidate('o'), relatedFacts: [] };

    expect(buildRelevanceCalls([orphan], FACTS).eligibleCandidates).toEqual([]);
    expect(buildReasonCallsForSubset([orphan], { o: 0.9 }, 0.3, FACTS).calls).toEqual([]);
  });

  it('a headline row with no English text is still excluded from both bundles', () => {
    const noText: ScoringCandidate = {
      ...pureHeadlineCandidate('h-empty'),
      descriptionEn: null,
    };

    expect(buildRelevanceCalls([noText], FACTS).eligibleCandidates).toEqual([]);
    expect(
      buildReasonCallsForSubset([noText], { 'h-empty': 0.9 }, 0.3, FACTS).calls,
    ).toEqual([]);
  });
});
