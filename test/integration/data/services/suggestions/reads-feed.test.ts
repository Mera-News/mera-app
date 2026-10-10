// article-suggestion-service reads that feed the For You store and the scoring queue: every local
// id (the anti-double-charge guard), loadSuggestions and its projection, the unscored queue, and the
// scored-without-reason sweep. Real services on the in-memory DB. Replaces the matching blocks of
// lib/database/services/__tests__/article-suggestion-service.test.ts.
import { GLOBAL_HEADLINE_SECTION_ID } from '@/lib/news-harness/feed-select/ownership';
import { buildFactRows } from '@/lib/stores/fact-rows-selector';
import { deleteFact } from '@/lib/database/services/fact-service';
import {
  countUnscoredSuggestions,
  getLocalSuggestionServerIds,
  getOldestUnscoredCreatedAt,
  getScoredSuggestionsWithoutReasons,
  getUnscoredSuggestionsWithFacts,
  loadSuggestions,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import {
  GROUNDED,
  HOUR,
  T0,
  article,
  bareLink,
  bareRow,
  freezeClock,
  interest,
  matched,
  seed,
  seedLegacy,
  toAlreadyRead,
  toComplete,
  toExcluded,
  toReasonPending,
  toReasonSkipped,
  withVintage,
} from './support';

beforeEach(() => freezeClock());

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('getLocalSuggestionServerIds', () => {
  it('is empty on a fresh device', async () => {
    expect(await getLocalSuggestionServerIds()).toEqual([]);
  });

  // stepDiff filters server ids against this list, so a terminal row left out would be requested
  // again and charged a second time against the daily article limit.
  it('returns EVERY row, terminal statuses included', async () => {
    await seed(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id) => article(id)));
    await toReasonPending('a2');
    await toComplete('a3');
    await toExcluded('a4');
    await toAlreadyRead('a5');
    await toReasonPending('a6');
    await toReasonSkipped('a6');

    expect((await getLocalSuggestionServerIds()).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  });
});

describe('loadSuggestions', () => {
  it('is empty when no rows exist', async () => {
    expect(await loadSuggestions()).toEqual([]);
  });

  it('projects a scored row onto the ForYouSuggestion the store renders', async () => {
    const { fact, topics } = await interest('I follow the harbour', ['berlin']);
    await seed(
      [
        article('a1', {
          country_code: 'DEU',
          language_code: 'de',
          publication_name: 'Der Spiegel',
          title: 'Titel Original',
          title_en: 'Title EN',
          description_en: 'Beschreibung',
          article_url: 'https://spiegel.de/a',
          image_url: 'https://spiegel.de/img.jpg',
          pubDate: '2026-10-08T06:00:00.000Z',
          event_type: 'weather',
          entities: ['Angela', '', 'Bundestag'],
        }),
      ],
      { topics: { a1: [matched(topics[0], 0.9)] } },
    );
    await toComplete('a1', 0.75, 'Angela matters to you.');

    const [s] = await loadSuggestions();

    expect(s).toMatchObject({
      _id: 'a1',
      articleId: 'a1',
      country_code: 'DEU',
      language_code: 'de',
      publication_name: 'Der Spiegel',
      title_en: 'Title EN',
      title_original: 'Titel Original',
      description_en: 'Beschreibung',
      article_url: 'https://spiegel.de/a',
      image_url: 'https://spiegel.de/img.jpg',
      relevance: 0.75,
      reason: 'Angela matters to you.',
      status: 'complete',
      userTopicIds: ['berlin'],
      createdAt: new Date(T0).toISOString(),
      firstPubDate: '2026-10-08T06:00:00.000Z',
      eventType: 'weather',
      entities: ['Angela', 'Bundestag'],
      headlineScope: null,
      headlineCountryCode: null,
      matchedTopics: [{ topicId: topics[0].id, text: 'berlin' }],
      factIds: [fact.id],
      scoredAt: T0,
      scoredWithV3: false,
      rawScore: null,
    });
    expect(s.clusters).toEqual([]);
  });

  it('carries terminal rows too: the fact page counts the excluded and already read ones inside 48h', async () => {
    await seed([article('a1'), article('a2'), article('a3')]);
    await toExcluded('a1');
    await toAlreadyRead('a2');

    const byId = new Map((await loadSuggestions()).map((s) => [s._id, s.status]));

    expect(byId).toEqual(new Map([['a1', 'excluded'], ['a2', 'already_read'], ['a3', 'unscored']]));
  });

  it('maps cluster memberships, keeping a stable id only when one was set', async () => {
    await seed([
      article('a1', {
        clusters: [
          { clusterId: 'c1', confidence: 0.9, stableClusterId: 'stable-1' },
          { clusterId: 'c2', confidence: 0.4, stableClusterId: null },
        ],
      } as never),
    ]);

    const [s] = await loadSuggestions();

    expect(s.clusters).toEqual([
      { clusterId: 'c1', confidence: 0.9, stableClusterId: 'stable-1' },
      { clusterId: 'c2', confidence: 0.4 },
    ]);
  });

  describe('geo tags', () => {
    it("maps them with the scorer's parse shape", async () => {
      await seed([
        article('a1', {
          geo_tags: [
            { city: 'Taipei', region: 'Taipei City', countryCode: 'TWN' },
            { countryCode: 'DEU' },
          ] as never,
        }),
      ]);
      const [s] = await loadSuggestions();
      expect(s.geoTags).toEqual([
        { city: 'Taipei', region: 'Taipei City', countryCode: 'TWN' },
        { city: undefined, region: undefined, countryCode: 'DEU' },
      ]);
    });

    it('drops a tag with no usable countryCode, as buildStageCandidateInput does', async () => {
      await seed([
        article('a1', { geo_tags: [{ city: 'Nowhere' }, { countryCode: '' }, { countryCode: 'FRA' }] as never }),
      ]);
      const [s] = await loadSuggestions();
      expect(s.geoTags).toEqual([{ city: undefined, region: undefined, countryCode: 'FRA' }]);
    });

    it('is [] for no tags at all', async () => {
      await seed([article('a1')]);
      expect((await loadSuggestions())[0].geoTags).toEqual([]);
    });

    it('is [] for an unparseable column', async () => {
      // No service writes a corrupt blob (persist stringifies): a bare row is the only way to reach the catch.
      await bareRow('bad', { geoTagsJson: 'not json' });
      expect((await loadSuggestions())[0].geoTags).toEqual([]);
    });
  });

  describe('scorer vintage travels per row', () => {
    it('is a strict boolean: false by default, true only for a row that inherited a v3 score', async () => {
      await seed([article('own'), article('v3'), article('legacy')]);
      await toComplete('own');
      await withVintage('v3', 0.7, true);
      await withVintage('legacy', 0.7, null);

      const byId = new Map((await loadSuggestions()).map((s) => [s._id, s.scoredWithV3]));

      expect(byId).toEqual(new Map([['own', false], ['v3', true], ['legacy', false]]));
    });
  });

  it('maps the matched-topic refs, skipping a null entry and blanking a bad topic id or text', async () => {
    // persist always writes well-formed entries, so a null element or a bad field is a bare row.
    await bareRow('s1', {
      matchedTopicsJson: JSON.stringify([null, { topicId: 't1', text: 'x' }, { topicId: '', text: 7 }]),
    });

    expect((await loadSuggestions())[0].matchedTopics).toEqual([
      { topicId: 't1', text: 'x' },
      { topicId: null, text: '' },
    ]);
  });

  describe('parseClusterMemberships, through the stored column', () => {
    // No service writes a corrupt blob (persist always stringifies a list), so these use bare rows.
    it.each([
      ['null', null],
      ['not json', 'bad-json'],
      ['not an array', '{}'],
    ])('yields [] for %s', async (_name, json) => {
      await bareRow('s1', { clusterMembershipsJson: json });
      expect((await loadSuggestions())[0].clusters).toEqual([]);
    });

    it('drops entries missing a clusterId string or a confidence number', async () => {
      await bareRow('s1', {
        clusterMembershipsJson: JSON.stringify([
          { clusterId: 'c1', confidence: 0.9 },
          { clusterId: '', confidence: 0.5 },
          { clusterId: 'c2' },
          { confidence: 0.1 },
          null,
        ]),
      });
      expect((await loadSuggestions())[0].clusters).toEqual([{ clusterId: 'c1', confidence: 0.9 }]);
    });
  });
});

// The producer feeding the real consumer. The selector suite builds ForYouSuggestions by hand, which is
// how `toForYouSuggestion` once dropped headlineCountryCode and no per-country section ever rendered.
describe('headline provenance survives the real row -> suggestion -> section path', () => {
  const sectionIds = async () =>
    buildFactRows(
      await loadSuggestions(),
      { topics: new Map(), facts: new Map(), locations: new Map(), factStatements: new Map() },
      new Set(),
      T0,
    ).rows.map((r) => r.factId);

  const synthetic = (id: string) => ({ [id]: [{ topicId: null, text: 'top headline · country' }] });
  const score = (id: string) =>
    saveScoringResult(id, { relevance: 0.7, reason: GROUNDED, reasonSkipped: false, rawScore: 0.7 });

  it('carries the country end to end into a per-country section', async () => {
    await seed([article('h-in')], {
      topics: synthetic('h-in'),
      headline: { 'h-in': 'COUNTRY' },
      headlineCountry: { 'h-in': 'IN' },
    });
    await score('h-in');

    expect((await loadSuggestions())[0].headlineCountryCode).toBe('IN');
    expect(await sectionIds()).toEqual(['headline-country-in']);
  });

  it('puts a GLOBAL headline in the global section with no country', async () => {
    await seed([article('h-g')], { topics: synthetic('h-g'), headline: { 'h-g': 'GLOBAL' } });
    await score('h-g');

    expect((await loadSuggestions())[0].headlineCountryCode).toBeNull();
    expect(await sectionIds()).toEqual([GLOBAL_HEADLINE_SECTION_ID]);
  });

  it('does not carry a stale country on a GLOBAL row', async () => {
    // persist writes the country only under a COUNTRY scope, so a GLOBAL row holding one is a bare row.
    await bareRow('h-stale', {
      status: 'complete',
      relevance: 0.7,
      headlineScope: 'GLOBAL',
      headlineCountryCode: 'IN',
      matchedTopicsJson: JSON.stringify([{ topicId: null, text: 'top headline · country' }]),
    });

    expect((await loadSuggestions())[0].headlineCountryCode).toBeNull();
    expect(await sectionIds()).toEqual([GLOBAL_HEADLINE_SECTION_ID]);
  });

  it('puts a COUNTRY row with no country in no country section', async () => {
    await seed([article('h-null')], { topics: synthetic('h-null'), headline: { 'h-null': 'COUNTRY' } });
    await score('h-null');

    expect((await loadSuggestions())[0].headlineCountryCode).toBeNull();
    expect(await sectionIds()).toEqual([]);
  });
});

describe('the unscored queue', () => {
  it('countUnscoredSuggestions counts unscored rows only', async () => {
    expect(await countUnscoredSuggestions()).toBe(0);
    await seed(['a1', 'a2', 'a3', 'a4'].map((id) => article(id)));
    await toComplete('a1');
    await toExcluded('a2');

    expect(await countUnscoredSuggestions()).toBe(2);
  });

  describe('getOldestUnscoredCreatedAt', () => {
    it('is null when nothing is unscored', async () => {
      expect(await getOldestUnscoredCreatedAt()).toBeNull();
      await seed([article('a1')]);
      await toComplete('a1');
      expect(await getOldestUnscoredCreatedAt()).toBeNull();
    });

    it('is the creation time of the oldest UNSCORED row, ignoring older scored ones', async () => {
      jest.setSystemTime(T0 - 3 * HOUR);
      await seed([article('scored')]);
      await toComplete('scored');
      jest.setSystemTime(T0 - 2 * HOUR);
      await seed([article('oldest')]);
      jest.setSystemTime(T0 - HOUR);
      await seed([article('newer')]);

      expect(await getOldestUnscoredCreatedAt()).toBe(T0 - 2 * HOUR);
    });
  });

  describe('getUnscoredSuggestionsWithFacts', () => {
    it('is empty when nothing is unscored', async () => {
      expect(await getUnscoredSuggestionsWithFacts()).toEqual([]);
      await seed([article('a1')]);
      await toComplete('a1');
      expect(await getUnscoredSuggestionsWithFacts()).toEqual([]);
    });

    it('returns unscored rows only, with the scorer-input columns and the facts their topics belong to', async () => {
      const { fact, topics } = await interest('I live in Berlin', ['berlin', 'germany']);
      await seed(
        [
          article('a1', {
            country_code: 'DEU',
            publication_name: 'Der Spiegel',
            language_code: 'de',
            category: 'politics',
            maxClusterSize: 4,
            pubDate: '2026-10-08T06:00:00.000Z',
          }),
          article('a2'),
        ],
        {
          topics: { a1: [matched(topics[0], 0.9), matched(topics[1])], a2: [matched(topics[0])] },
          stable: { a1: 'stable-1' },
        },
      );
      await toComplete('a2');

      const out = await getUnscoredSuggestionsWithFacts();

      expect(out.map((c) => c.id)).toEqual(['a1']);
      expect(out[0]).toMatchObject({
        titleEn: 'Quarterly harbour report a1',
        descriptionEn: 'Harbour details a1',
        countryCode: 'DEU',
        publicationName: 'Der Spiegel',
        languageCode: 'de',
        userTopicIds: ['berlin', 'germany'],
        // one link per fact, however many of its topics matched
        relatedFacts: [{ id: fact.id, statement: 'I live in Berlin' }],
        meta: {
          id: 'a1',
          category: 'politics',
          maxClusterSize: 4,
          stableClusterId: 'stable-1',
          firstPubDateMs: Date.parse('2026-10-08T06:00:00.000Z'),
          headlineScope: null,
        },
      });
    });

    it('has no related facts for a headline row', async () => {
      await seed([article('h1')], { topics: { h1: [{ topicId: null, text: 'top headline · global' }] }, headline: { h1: 'GLOBAL' } });

      const [c] = await getUnscoredSuggestionsWithFacts();

      expect(c.relatedFacts).toEqual([]);
      expect(c.meta?.headlineScope).toBe('GLOBAL');
    });

    it('skips a link whose fact is gone', async () => {
      // Legacy path: the row carries no topic ids, so deleting the fact leaves the row (and its join) behind.
      const { fact } = await interest('I follow racing', ['formula 1']);
      await seedLegacy([article('a1')], { a1: ['formula 1'] });
      await deleteFact(fact.id);

      const out = await getUnscoredSuggestionsWithFacts();

      expect(out.map((c) => c.id)).toEqual(['a1']);
      expect(out[0].relatedFacts).toEqual([]);
    });

    it('lists a fact once per link row (no dedup in the reader)', async () => {
      // No service writes two links to one fact (persist dedupes), so the second link is a bare row.
      const { fact } = await interest('I follow racing', ['formula 1']);
      await seedLegacy([article('a1')], { a1: ['formula 1'] });
      await bareLink('a1', fact.id);

      expect((await getUnscoredSuggestionsWithFacts())[0].relatedFacts).toHaveLength(2);
    });

    it('honours the limit', async () => {
      await seed(['a1', 'a2', 'a3'].map((id) => article(id)));

      expect(await getUnscoredSuggestionsWithFacts(2)).toHaveLength(2);
      expect(await getUnscoredSuggestionsWithFacts()).toHaveLength(3);
    });
  });
});

describe('getScoredSuggestionsWithoutReasons (the orphaned-reason sweep)', () => {
  // Widening this to "any scored status without a reason" would re-spend an LLM call on every
  // reason_skipped and excluded row, every sweep, forever.
  it('selects reason_pending ONLY: no terminal or other status is ever re-elected', async () => {
    await seed(['pending', 'unscored', 'complete', 'excluded', 'read', 'skipped'].map((id) => article(id)));
    await toReasonPending('pending');
    await toComplete('complete');
    await toExcluded('excluded');
    await toAlreadyRead('read');
    await toReasonPending('skipped');
    await toReasonSkipped('skipped');

    expect(ids(await getScoredSuggestionsWithoutReasons())).toEqual(['pending']);
  });

  it('is empty when nothing is waiting for a note', async () => {
    expect(await getScoredSuggestionsWithoutReasons()).toEqual([]);
  });

  it('carries relevance, the linked facts and the topic texts of each candidate', async () => {
    const { fact, topics } = await interest('I follow racing', ['formula 1']);
    await seed([article('a1')], { topics: { a1: [matched(topics[0])] } });
    await toReasonPending('a1', 0.7);

    const [c] = await getScoredSuggestionsWithoutReasons();

    expect(c).toMatchObject({
      id: 'a1',
      relevance: 0.7,
      userTopicIds: ['formula 1'],
      relatedFacts: [{ id: fact.id, statement: 'I follow racing' }],
    });
    expect(c.meta?.id).toBe('a1');
  });

  it('skips a link whose fact is gone', async () => {
    // Legacy path: the row carries no topic ids, so deleting the fact leaves the row and its join behind.
    const { fact } = await interest('I follow racing', ['formula 1']);
    await seedLegacy([article('a1')], { a1: ['formula 1'] });
    await toReasonPending('a1');
    await deleteFact(fact.id);

    const out = await getScoredSuggestionsWithoutReasons();

    expect(out.map((c) => c.id)).toEqual(['a1']);
    expect(out[0].relatedFacts).toEqual([]);
  });

  it('honours the limit', async () => {
    await seed(['a1', 'a2', 'a3'].map((id) => article(id)));
    for (const id of ['a1', 'a2', 'a3']) await toReasonPending(id);

    expect(await getScoredSuggestionsWithoutReasons(2)).toHaveLength(2);
    expect(await getScoredSuggestionsWithoutReasons()).toHaveLength(3);
  });

  // THE claim the propagation fix rests on: a reason-less copy stays reason_pending, and this sweep keeps
  // it because an inherited above-gate relevance clears enqueueOrphanedReasons' 0.3 floor.
  it('finds a row a reason-less donor propagated into', async () => {
    await seed([article('a1')]);
    await withVintage('a1', 0.72, null, '');

    const found = (await getScoredSuggestionsWithoutReasons()).find((c) => c.id === 'a1');

    expect(found).toBeDefined();
    expect(found!.relevance).toBeGreaterThan(0.3);
  });
});
