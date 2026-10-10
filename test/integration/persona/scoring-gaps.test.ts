// Arms of lib/mera-protocol and lib/news-harness/scoring-engine that only the deleted G22 legacy
// suites reached (scoring-service, stage-scoring, stage-subscription-read, relevance, suppression).
// The mera-protocol arms go through the real stack (in-memory DB, real services, gateway mock);
// relevance.ts and suppression.ts are pure algorithms, so their optional-field arms are reached by
// calling the exported functions directly, because buildStageCandidates always fills the arrays.
import { addFact } from '@/lib/database/services/fact-service';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-persist';
import { addSuppression } from '@/lib/database/services/suppression-service';
import * as subscriptionService from '@/lib/database/services/user-publication-subscription-service';
import { createTopics } from '@/lib/database/services/topic-service';
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { loadPersonaScoringContext } from '@/lib/mera-protocol/stage-scoring';
import { runSubscriptionReadStage } from '@/lib/mera-protocol/stage-subscription-read';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { computeRelevance } from '@/lib/news-harness/scoring-engine/relevance';
import {
  buildSuppressionHaystack,
  screenHardSuppressions,
  suppressionDisplayValue,
  suppressionMatchesCandidate,
} from '@/lib/news-harness/scoring-engine/suppression';
import {
  advanceUntilDone,
  gatewayCalls,
  mockGateway,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';

jest.setTimeout(30_000);

const ENG = DEFAULT_HARNESS_CONFIG.scoringEngine;

beforeEach(async () => {
  await signInFixtureAccount();
  useFakeClock(Date.now());
  for (const level of ['warn', 'error', 'captureException'] as const) {
    jest.spyOn(logger, level).mockImplementation(() => undefined as never);
  }
});

const run = <T>(p: Promise<T>, maxMs = 600_000): Promise<T> => advanceUntilDone(p, maxMs, 100);

// ===========================================================================
// stage-subscription-read
// ===========================================================================

describe('runSubscriptionReadStage - arms the legacy suite reached', () => {
  const subscribe = () =>
    subscriptionService.upsertSubscription({
      publisherId: 'p1',
      publisherName: 'Het Parool',
      countryCode: 'NLD',
      sourceNames: ['Het Parool'],
    });

  async function seedStory(siblingExtra: Record<string, unknown>) {
    const fact = await addFact('I follow Dutch politics');
    const [t] = await createTopics([{ factId: fact.id, text: 'dutch politics', weight: 1 }]);
    const article = (id: string, over: Record<string, unknown>) =>
      ({
        _id: id,
        title: `Story ${id}`,
        title_en: `Story ${id}`,
        description_en: `Details of story ${id}`,
        language_code: 'en',
        country_code: null,
        clusters: [],
        ...over,
      }) as unknown as ArticleWithClusters;
    const options = (ids: string[]) => ({
      matchedTopics: new Map(ids.map((id) => [id, [{ topicId: t.id, text: t.text }]])),
      headlineScope: new Map<string, string>(),
      stableClusterId: new Map(ids.map((id) => [id, 'cluster-1'] as [string, string])),
    });
    await persistAndLinkV2Suggestions(
      [article('sib', { publication_name: 'Het Parool', pubDate: '2026-10-09T07:00:00.000Z', ...siblingExtra })],
      new Map(),
      options(['sib']),
    );
    jest.setSystemTime(Date.now() + 1_000);
    await persistAndLinkV2Suggestions(
      [article('anchor', { pubDate: '2026-10-09T08:00:00.000Z' })],
      new Map(),
      options(['anchor']),
    );
  }

  it('returns 0 and asks no model when a publication is followed but there are no unread rows', async () => {
    server.use(...mockGateway(() => 'A read.'));
    await subscribe();

    expect(await run(runSubscriptionReadStage())).toBe(0);

    expect(gatewayCalls()).toHaveLength(0);
  });

  it("puts the sibling's category and event type in the prompt when it has them", async () => {
    server.use(...mockGateway(() => 'Focuses on the coalition talks.'));
    await subscribe();
    await seedStory({ category: 'politics', event_type: 'election' });

    expect(await run(runSubscriptionReadStage())).toBe(1);

    const [call] = gatewayCalls('chat');
    const user = call.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user).toContain('Category: politics');
    expect(user).toContain('Event type: election');
  });
});

// ===========================================================================
// stage-scoring: the persona snapshot's suppression partition
// ===========================================================================

describe('loadPersonaScoringContext - a filter whose stored pattern is blank', () => {
  it('keeps the pattern undefined for a blank pattern, and the keywords as stored', async () => {
    await addSuppression({ pattern: '   ', keywords: ['x'], strength: 0.5, source: 'feedback' });

    const { persona } = await loadPersonaScoringContext();

    expect(persona.softSuppressions).toHaveLength(1);
    expect(persona.softSuppressions[0].pattern).toBeUndefined();
    expect(persona.softSuppressions[0].keywords).toEqual(['x']);
  });

  it('does not invent keywords for a blank-pattern HARD keyword filter that has none', async () => {
    await addSuppression({ pattern: '', keywords: [], strength: 1, source: 'feedback' });

    const { persona } = await loadPersonaScoringContext();

    expect(persona.hardSuppressions).toHaveLength(1);
    expect(persona.hardSuppressions![0].keywords).toEqual([]);
  });
});

// ===========================================================================
// relevance.ts: a candidate that carries no geo tags and no entities
// ===========================================================================

describe('computeRelevance - optional candidate fields', () => {
  it('scores an actionable event type with no matched topic as no event lift, in math mode', async () => {
    const { persona } = await loadPersonaScoringContext();

    const r = computeRelevance({ id: 'x', eventType: 'crime', matchedTopics: [] }, persona, ENG);

    expect(r.components.eventComp).toBe(0);
    expect(r.mode).toBe('math');
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it('gives the same actionable event type its lift once a positive topic matched', async () => {
    const { persona } = await loadPersonaScoringContext();

    const r = computeRelevance(
      { id: 'x', eventType: 'crime', matchedTopics: [{ topicId: 't', text: 'crime', effectiveWeight: 0.6 }] },
      persona,
      ENG,
    );

    expect(r.components.eventComp).toBe(0.5);
  });

  it('reads a candidate with no geo tags, no entities and no event type as a backstop with no geo score', async () => {
    const { persona } = await loadPersonaScoringContext();

    const r = computeRelevance({ id: 'x', matchedTopics: [] }, persona, ENG);

    expect(r.mode).toBe('backstop');
    expect(r.components.geoComp).toBe(0);
    expect(r.components.entityComp).toBe(0);
  });

  it('is not a backstop once it has only entities, or only geo tags', async () => {
    const { persona } = await loadPersonaScoringContext();

    const onlyEntities = computeRelevance({ id: 'x', entities: ['nasa'], matchedTopics: [] }, persona, ENG);
    const onlyGeo = computeRelevance(
      { id: 'y', geoTags: [{ city: 'Hoorn', countryCode: 'NL' }], matchedTopics: [] },
      persona,
      ENG,
    );

    expect(onlyEntities.mode).toBe('math');
    expect(onlyGeo.mode).toBe('math');
  });
});

// ===========================================================================
// suppression.ts: candidates and filters with absent optional fields
// ===========================================================================

describe('suppression matcher - absent optional fields', () => {
  const bare = { id: 'a', matchedTopics: [] };

  it('builds the haystack from title and description alone when the candidate has no entities', () => {
    expect(buildSuppressionHaystack({ ...bare, titleEn: 'Crypto News', descriptionEn: 'Bitcoin slides' })).toBe(
      'crypto news  bitcoin slides',
    );
    expect(buildSuppressionHaystack(bare)).toBe('  ');
  });

  it('matches a keyword filter on a candidate with no entities', () => {
    expect(suppressionMatchesCandidate({ ...bare, titleEn: 'Crypto news' }, { keywords: ['crypto'], strength: 1 })).toBe(true);
    expect(suppressionMatchesCandidate(bare, { keywords: ['crypto'], strength: 1 })).toBe(false);
  });

  it('matches an entity filter against nothing when the candidate has no entities', () => {
    expect(suppressionMatchesCandidate(bare, { keywords: [], strength: 1, kind: 'entity', value: 'nasa' })).toBe(false);
    expect(suppressionMatchesCandidate({ ...bare, entities: ['NASA'] }, { keywords: [], strength: 1, kind: 'entity', value: 'nasa' })).toBe(true);
  });

  it('matches a place filter against nothing when the candidate has no geo tags', () => {
    expect(suppressionMatchesCandidate(bare, { keywords: [], strength: 1, kind: 'place', value: 'taipei' })).toBe(false);
    expect(
      suppressionMatchesCandidate(
        { ...bare, geoTags: [{ city: 'Taipei', countryCode: 'TW' }] },
        { keywords: [], strength: 1, kind: 'place', value: 'taipei' },
      ),
    ).toBe(true);
  });

  it('screenHardSuppressions returns only the rows to remove, with the matching filter display value', () => {
    const excluded = screenHardSuppressions(
      [
        { id: 'a', titleEn: 'Crypto news', matchedTopics: [] },
        { id: 'b', titleEn: 'Football news', matchedTopics: [] },
        { id: 'h', titleEn: 'Crypto crash', headlineScope: 'GLOBAL', matchedTopics: [] },
      ],
      [{ keywords: ['crypto'], strength: 1 }],
    );

    expect([...excluded]).toEqual([['a', 'crypto']]);
  });

  it('screenHardSuppressions removes nothing without hard filters', () => {
    expect(screenHardSuppressions([{ id: 'a', matchedTopics: [] }], undefined).size).toBe(0);
    expect(screenHardSuppressions([{ id: 'a', matchedTopics: [] }], []).size).toBe(0);
  });

  it('labels a filter by value, else pattern, else first non-blank keyword, else a placeholder', () => {
    expect(suppressionDisplayValue({ keywords: ['k'], strength: 1, value: ' nasa ', pattern: 'p' })).toBe('nasa');
    expect(suppressionDisplayValue({ keywords: ['k'], strength: 1, pattern: ' brexit ' })).toBe('brexit');
    expect(suppressionDisplayValue({ keywords: ['  ', ' taxes '], strength: 1 })).toBe('taxes');
    expect(suppressionDisplayValue({ keywords: ['  '], strength: 1 })).toBe('filter');
    expect(suppressionDisplayValue({ strength: 1 } as never)).toBe('filter');
  });
});
