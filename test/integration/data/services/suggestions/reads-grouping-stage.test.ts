// article-suggestion-reads reads for story grouping, score propagation donors, the hard-filter
// screen and the headline cull, on the real in-memory DB. The WHERE clauses are the behaviour here,
// and the old shared mock ignored them. Replaces the grouping, donor, stage and cull blocks of
// lib/database/services/__tests__/article-suggestion-service.test.ts.
import type { StageCandidateRow } from '@/lib/news-harness/core/types';
import { batchMarkAsScoredByIds } from '@/lib/database/services/article-suggestion-scoring-writes';
import {
  buildStageCandidateInput,
  type TopicWeightInfo,
} from '@/lib/database/services/article-suggestion-mappers';
import {
  getCullableLowHeadlineIds,
  getGroupingRowsByIds,
  getScoredDonorRows,
  getStageRowsByIds,
  getStageRowsForScreening,
  getUnscoredGroupingRows,
} from '@/lib/database/services/article-suggestion-reads';
import {
  DAY,
  GROUNDED,
  T0,
  article,
  freezeClock,
  interest,
  matched,
  seed,
  toAlreadyRead,
  toComplete,
  toExcluded,
  toReasonPending,
  toReasonSkipped,
  withVintage,
} from './support';

beforeEach(() => freezeClock());

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('getGroupingRowsByIds', () => {
  it('is [] for no ids', async () => {
    expect(await getGroupingRowsByIds([])).toEqual([]);
  });

  it('projects a scored row: english title, parsed memberships, score, note, status, date, geography', async () => {
    await seed([
      article('s1', {
        title: 'Original Title',
        title_en: 'English Title',
        country_code: 'DEU',
        language_code: 'de',
        pubDate: '2026-10-08T06:00:00.000Z',
        clusters: [{ clusterId: 'c1', confidence: 0.8, stableClusterId: 'stable-1' }] as never,
      }),
    ]);
    await toComplete('s1', 0.6);

    expect(await getGroupingRowsByIds(['s1'])).toEqual([
      {
        id: 's1',
        title: 'English Title',
        clusters: [{ clusterId: 'c1', confidence: 0.8, stableClusterId: 'stable-1' }],
        relevance: 0.6,
        reason: GROUNDED,
        status: 'complete',
        firstPubDateMs: Date.parse('2026-10-08T06:00:00.000Z'),
        hasDescription: true,
        countryCode: 'DEU',
        languageCode: 'de',
        scoredWithV3: false,
      },
    ]);
  });

  it('falls back to the original title when there is no english one', async () => {
    await seed([article('s1', { title: 'Original Only', title_en: null as never })]);

    expect((await getGroupingRowsByIds(['s1']))[0].title).toBe('Original Only');
  });

  it('sets hasDescription from the english description', async () => {
    await seed([article('s1', { description_en: null }), article('s2', { description_en: 'has one' })]);

    const byId = new Map((await getGroupingRowsByIds(['s1', 's2'])).map((r) => [r.id, r.hasDescription]));

    expect(byId).toEqual(new Map([['s1', false], ['s2', true]]));
  });

  it('returns only the requested ids', async () => {
    await seed([article('s1'), article('s2')]);

    expect(ids(await getGroupingRowsByIds(['s1']))).toEqual(['s1']);
  });

  it("carries a donor's scorer vintage as a strict boolean", async () => {
    await seed([article('v3'), article('legacy')]);
    await withVintage('v3', 0.7, true);
    await withVintage('legacy', 0.7, null);

    const byId = new Map((await getGroupingRowsByIds(['v3', 'legacy'])).map((r) => [r.id, r.scoredWithV3]));

    expect(byId).toEqual(new Map([['v3', true], ['legacy', false]]));
  });
});

describe('getUnscoredGroupingRows', () => {
  it('returns unscored rows only', async () => {
    await seed(['s1', 's2', 's3', 's4'].map((id) => article(id)));
    await toReasonPending('s2');
    await toComplete('s3');
    await toExcluded('s4');

    expect(ids(await getUnscoredGroupingRows())).toEqual(['s1']);
  });

  it('is [] when everything is scored', async () => {
    await seed([article('s1')]);
    await toComplete('s1');

    expect(await getUnscoredGroupingRows()).toEqual([]);
  });

  it('comes back newest published first, which is the order cloud scoring dispatches in', async () => {
    await seed([
      article('mid', { pubDate: '2026-10-08T06:00:00.000Z' }),
      article('old', { pubDate: '2026-10-07T06:00:00.000Z' }),
      article('new', { pubDate: '2026-10-08T09:00:00.000Z' }),
    ]);

    expect((await getUnscoredGroupingRows()).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });
});

describe('getScoredDonorRows(sinceMs)', () => {
  const since = T0 - DAY;
  const at = (ms: number) => jest.setSystemTime(ms);

  // One table of rows, each with the reason it is in or out. Times are exact (strict clock), so the
  // boundaries are real: `>=` on both scored_at and created_at.
  async function seedWindow() {
    at(T0 - 3 * DAY);
    await seed([article('viaScored'), article('scoredAtBoundary'), article('scoredJustBefore')]);
    at(since - 1);
    await toComplete('scoredJustBefore', 0.5);
    await seed([article('createdJustBefore')]);
    await withVintage('createdJustBefore', 0.5, null);
    at(since);
    await toComplete('scoredAtBoundary', 0.5);
    await seed([article('createdAtBoundary')]);
    await withVintage('createdAtBoundary', 0.5, null);
    at(T0);
    await toComplete('viaScored', 0.6);
    await seed(['viaCreated', 'unscored', 'skipped', 'zero', 'excluded', 'read'].map((id) => article(id)));
    await withVintage('viaCreated', 0.5, true, '');
    await toComplete('skipped', 0.8);
    await toReasonSkipped('skipped');
    await batchMarkAsScoredByIds(['zero']);
    await toExcluded('excluded');
    await toAlreadyRead('read');
  }

  it('is a donor when scored in the window (even if created long before) or created in it with no score time', async () => {
    await seedWindow();

    expect(ids(await getScoredDonorRows(since))).toEqual([
      'createdAtBoundary',
      'scoredAtBoundary',
      'viaCreated',
      'viaScored',
    ]);
  });

  // The ineligible tombstones carry relevance 0, the gated row carries a real score and NO note, and an
  // unscored row has no verdict at all: none may donate.
  it('never takes an unscored row, a reason_skipped row, a relevance-0 tombstone or a terminal row', async () => {
    await seedWindow();

    const donors = ids(await getScoredDonorRows(since));

    for (const out of ['unscored', 'skipped', 'zero', 'excluded', 'read', 'scoredJustBefore', 'createdJustBefore']) {
      expect(donors).not.toContain(out);
    }
  });

  it('keeps the donor\'s vintage and note on the projection', async () => {
    await seedWindow();

    const viaCreated = (await getScoredDonorRows(since)).find((r) => r.id === 'viaCreated');

    expect(viaCreated).toMatchObject({ relevance: 0.5, reason: '', status: 'reason_pending', scoredWithV3: true });
  });

  it('is [] when no row is in the window', async () => {
    await seedWindow();

    expect(await getScoredDonorRows(T0 + DAY)).toEqual([]);
  });
});

describe('stage rows (the hard-filter screen)', () => {
  it('getStageRowsForScreening() takes every row a filter could still newly kill, already_read included', async () => {
    await seed(['a1', 'a2', 'a3', 'a4'].map((id) => article(id)));
    await toComplete('a2');
    await toExcluded('a3');
    await toAlreadyRead('a4');

    expect(ids(await getStageRowsForScreening())).toEqual(['a1', 'a2', 'a4']);
  });

  it('getStageRowsForScreening({ excluded: true }) takes the excluded rows only', async () => {
    await seed(['a1', 'a2', 'a3'].map((id) => article(id)));
    await toExcluded('a2');
    await toAlreadyRead('a3');

    expect(ids(await getStageRowsForScreening({ excluded: true }))).toEqual(['a2']);
  });

  it('snapshots the scorer-input columns of a persisted row', async () => {
    const { topics } = await interest('I live in Berlin', ['berlin']);
    await seed(
      [
        article('a1', {
          country_code: 'DEU',
          publication_name: 'Der Spiegel',
          maxClusterSize: 12,
          event_type: 'weather',
          category: 'news',
          pubDate: '2026-10-08T06:00:00.000Z',
          geo_tags: [{ city: 'Berlin', region: 'BE', countryCode: 'DE' }] as never,
          entities: ['Angela', 'Bundestag'],
        }),
      ],
      { topics: { a1: [matched(topics[0], 0.9)] }, headline: { a1: 'COUNTRY' }, headlineCountry: { a1: 'DE' }, stable: { a1: 'sc-1' } },
    );

    const [r] = await getStageRowsForScreening();

    expect(r).toEqual({
      id: 'a1',
      titleEn: 'Quarterly harbour report a1',
      descriptionEn: 'Harbour details a1',
      publicationName: 'Der Spiegel',
      countryCode: 'DEU',
      firstPubDateMs: Date.parse('2026-10-08T06:00:00.000Z'),
      maxClusterSize: 12,
      eventType: 'weather',
      category: 'news',
      geoTagsJson: JSON.stringify([{ city: 'Berlin', region: 'BE', countryCode: 'DE' }]),
      entitiesJson: JSON.stringify(['Angela', 'Bundestag']),
      matchedTopicsJson: JSON.stringify([{ topicId: topics[0].id, text: 'berlin', vectorScore: 0.9 }]),
      headlineScope: 'COUNTRY',
      headlineCountryCode: 'DE',
      stableClusterId: 'sc-1',
    });
  });

  describe('getStageRowsByIds', () => {
    it('is [] for no ids', async () => {
      expect(await getStageRowsByIds([])).toEqual([]);
    });

    it('takes exactly the ids asked for, minus the excluded ones, and keeps already_read', async () => {
      await seed(['a1', 'a2', 'a3', 'a4'].map((id) => article(id)));
      await toExcluded('a2');
      await toAlreadyRead('a3');

      expect(ids(await getStageRowsByIds(['a1', 'a2', 'a3']))).toEqual(['a1', 'a3']);
    });
  });
});

describe('buildStageCandidateInput', () => {
  const baseRow: StageCandidateRow = {
    id: 'art-1',
    titleEn: 'A title',
    descriptionEn: 'A desc',
    publicationName: 'The Paper',
    countryCode: 'DE',
    firstPubDateMs: 1_700_000_000_000,
    maxClusterSize: 12,
    eventType: 'weather',
    category: 'news',
    geoTagsJson: JSON.stringify([{ city: 'Berlin', region: 'BE', countryCode: 'DE' }]),
    entitiesJson: JSON.stringify(['Angela', 'Bundestag']),
    matchedTopicsJson: JSON.stringify([
      { topicId: 't1', text: 'german politics', vectorScore: 0.9 },
      { topicId: null, text: 'top headline · country' },
    ]),
    headlineScope: 'COUNTRY',
    headlineCountryCode: 'DE',
    stableClusterId: 'sc-1',
  };
  const weights = new Map<string, TopicWeightInfo>([
    ['t1', { effectiveWeight: 0.72, highPriority: true, locationId: 'loc-9' }],
  ]);

  it('parses the JSON columns and enriches matched topics with the live weights', () => {
    const input = buildStageCandidateInput(baseRow, weights);

    expect(input).toMatchObject({
      id: 'art-1',
      pubDateMs: 1_700_000_000_000,
      maxClusterSize: 12,
      eventType: 'weather',
      geoTags: [{ city: 'Berlin', region: 'BE', countryCode: 'DE' }],
      entities: ['Angela', 'Bundestag'],
      headlineScope: 'COUNTRY',
      headlineCountryCode: 'DE',
      stableClusterId: 'sc-1',
    });
    expect(input.matchedTopics.find((m) => m.topicId === 't1')).toMatchObject({
      effectiveWeight: 0.72,
      highPriority: true,
      locationId: 'loc-9',
      vectorScore: 0.9,
    });
  });

  it('resolves a synthetic or unknown topic to weight 0', () => {
    const synthetic = buildStageCandidateInput(baseRow, weights).matchedTopics.find((m) => m.topicId === null)!;

    expect(synthetic.effectiveWeight).toBe(0);
    expect(synthetic.highPriority).toBe(false);
  });

  it('gives a backstop-shaped input when the metadata columns are null', () => {
    const input = buildStageCandidateInput(
      { ...baseRow, geoTagsJson: null, entitiesJson: null, eventType: null, matchedTopicsJson: null, headlineScope: null },
      new Map(),
    );

    expect(input.geoTags).toEqual([]);
    expect(input.entities).toEqual([]);
    expect(input.matchedTopics).toEqual([]);
    expect(input.headlineScope).toBeNull();
    expect(input.headlineCountryCode).toBeNull();
  });

  it('drops a geo tag with no country and survives malformed JSON', () => {
    const input = buildStageCandidateInput(
      { ...baseRow, geoTagsJson: JSON.stringify([{ city: 'Nowhere' }, { countryCode: 'FR' }]), entitiesJson: 'not json' },
      weights,
    );

    expect(input.geoTags).toEqual([{ city: undefined, region: undefined, countryCode: 'FR' }]);
    expect(input.entities).toEqual([]);
  });

  it('passes a supranational country code through: the engine resolves it, not this mapper', () => {
    const input = buildStageCandidateInput(
      { ...baseRow, geoTagsJson: JSON.stringify([{ countryCode: 'MIDDLE_EAST' }]) },
      weights,
    );

    expect(input.geoTags).toEqual([{ city: undefined, region: undefined, countryCode: 'MIDDLE_EAST' }]);
  });

  it('only carries the headline country when the scope is COUNTRY', () => {
    expect(buildStageCandidateInput({ ...baseRow, headlineScope: 'GLOBAL' }, weights).headlineCountryCode).toBeNull();
    expect(buildStageCandidateInput({ ...baseRow, headlineScope: 'COUNTRY' }, weights).headlineCountryCode).toBe('DE');
    expect(buildStageCandidateInput({ ...baseRow, headlineScope: 'SOMETHING' }, weights).headlineScope).toBeNull();
  });

  it('maps a row read back from the database', async () => {
    const { topics } = await interest('I live in Berlin', ['berlin']);
    await seed([article('a1')], { topics: { a1: [matched(topics[0], 0.5)] } });
    const [stageRow] = await getStageRowsByIds(['a1']);

    const input = buildStageCandidateInput(stageRow, new Map([[topics[0].id, { effectiveWeight: 0.4, highPriority: false }]]));

    expect(input.matchedTopics).toEqual([
      { topicId: topics[0].id, text: 'berlin', effectiveWeight: 0.4, highPriority: false, locationId: undefined, vectorScore: 0.5 },
    ]);
  });
});

describe('getCullableLowHeadlineIds', () => {
  // Bands: SUB_GATE < 0.4, LOW [0.4, 0.6), MEDIUM from 0.6. A headline below MEDIUM is culled.
  const headline = (id: string, scope = 'COUNTRY') => ({ id, scope });
  async function seedHeadlines(rows: { id: string; scope?: string }[]) {
    await seed(
      rows.map((r) => article(r.id)),
      { headline: Object.fromEntries(rows.filter((r) => r.scope !== undefined).map((r) => [r.id, r.scope as string])) },
    );
  }

  it('returns scored headline rows below the MEDIUM band', async () => {
    await seedHeadlines([headline('h1'), headline('h2', 'GLOBAL'), headline('h3'), headline('h4')]);
    await toComplete('h1', 0.4);
    await toReasonPending('h2', 0.4);
    await toComplete('h3', 0.59);
    await toComplete('h4', 0.39);

    expect(ids((await getCullableLowHeadlineIds()).map((id) => ({ id })))).toEqual(['h1', 'h2', 'h3', 'h4']);
  });

  it('ignores medium-and-above headlines', async () => {
    await seedHeadlines([headline('h1'), headline('h2', 'GLOBAL')]);
    await toComplete('h1', 0.6);
    await toComplete('h2', 0.9);

    expect(await getCullableLowHeadlineIds()).toEqual([]);
  });

  it('ignores a non-headline LOW row: topic matches keep their LOW band', async () => {
    await seedHeadlines([{ id: 'a1' }]);
    await toComplete('a1', 0.4);

    expect(await getCullableLowHeadlineIds()).toEqual([]);
  });

  it('ignores a headline already excluded, one still unscored, and one the gate skipped', async () => {
    await seedHeadlines([headline('h1'), headline('h2'), headline('h3')]);
    await toExcluded('h1');
    await toComplete('h3', 0.4);
    await toReasonSkipped('h3');

    expect(await getCullableLowHeadlineIds()).toEqual([]);
  });
});
