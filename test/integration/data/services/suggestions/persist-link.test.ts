// persistAndLinkV2Suggestions: what it writes for a new row, how it links facts (the persona path via
// topics.fact_id, the legacy path via fact.metadata.topics), what it does to a row already on the
// device, and the concurrent-caller race. The feed-sync step tests (data/feed-sync/steps/
// hydrate-persist.test.ts) already cover chunking, the duplicate id, "not rewritten" through a real
// sync and topic-vs-headline linking; this file covers the rest of the function at its own seam.
// Replaces the persistAndLinkV2Suggestions block of
// lib/database/services/__tests__/article-suggestion-service.test.ts.
import database from '@/lib/database';
import {
  getStageRowsByIds,
  loadSuggestions,
  persistAndLinkV2Suggestions,
} from '@/lib/database/services/article-suggestion-service';
import { createTopics } from '@/lib/database/services/topic-service';
import logger from '@/lib/logger';
import { advanceUntilDone } from '@/test/helpers';
import {
  T0,
  article,
  bareRow,
  factsOf,
  freezeClock,
  idsInDb,
  interest,
  matched,
  personaMeta,
  row,
  rowCount,
  seed,
  seedLegacy,
  toComplete,
} from './support';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

beforeEach(() => freezeClock());
afterEach(() => jest.restoreAllMocks());

const stageJson = async (id: string) => (await getStageRowsByIds([id]))[0].matchedTopicsJson;

describe('a new row', () => {
  it('returns zero counts for nothing to persist', async () => {
    expect(await persistAndLinkV2Suggestions([], new Map())).toEqual({ insertedCount: 0, linkedCount: 0 });
  });

  it('starts unscored with no score and no note, keyed by the article id', async () => {
    const res = await seed([article('a1')]);

    expect(res).toEqual({ insertedCount: 1, linkedCount: 0 });
    expect(await row('a1')).toMatchObject({
      articleId: 'a1',
      status: 'unscored',
      relevance: 0,
      reason: '',
      scoredAt: null,
      rawScore: null,
      computedScore: null,
      scoreComponentsJson: null,
    });
  });

  it('stores no memberships when the server sent none at all (null)', async () => {
    await seed([article('a1', { clusters: null as never })]);

    expect((await row('a1')).clusterMembershipsJson).toBe('[]');
    expect((await row('a1')).stableClusterId).toBeNull();
  });

  it('stores the first copy when an article id arrives twice', async () => {
    const res = await seed([article('a1', { title_en: 'First copy' }), article('a1', { title_en: 'Second copy' })]);

    expect(res.insertedCount).toBe(1);
    expect((await row('a1')).titleEn).toBe('First copy');
  });

  it('stores null for every optional field the server left out', async () => {
    await seed([
      article('a1', {
        country_code: null,
        language_code: null,
        publication_name: null,
        title: null,
        description_en: null,
        article_url: null,
        image_url: null,
        maxClusterSize: null,
        geo_tags: [],
        entities: [],
      }),
    ]);

    expect(await row('a1')).toMatchObject({
      countryCode: null,
      languageCode: null,
      publicationName: null,
      titleOriginal: null,
      descriptionEn: null,
      articleUrl: null,
      imageUrl: null,
      maxClusterSize: null,
      geoTagsJson: null,
      entitiesJson: null,
      eventType: null,
      category: null,
    });
  });

  it('warns when the english title is the original-language title (translation did not run)', async () => {
    await seed([
      article('de', { title: 'Same words', title_en: 'Same words', language_code: 'de' }),
      article('en', { title: 'Same words', title_en: 'Same words', language_code: 'en' }),
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[ArticleSuggestionService] title_en matches original-language title',
      { articleId: 'de', languageCode: 'de' },
    );
  });

  describe('publication date', () => {
    const firstPub = async (id: string) => (await row(id)).firstPubDate.getTime();

    it.each([
      ['an ISO string', '2026-10-01T08:30:00.000Z', Date.UTC(2026, 9, 1, 8, 30)],
      ['a Date', new Date(Date.UTC(2026, 9, 2, 9, 0)), Date.UTC(2026, 9, 2, 9, 0)],
      ['a numeric timestamp', Date.UTC(2026, 9, 3, 10, 0), Date.UTC(2026, 9, 3, 10, 0)],
    ])('reads %s', async (_name, pubDate, expected) => {
      await seed([article('a1', { pubDate: pubDate as never })]);
      expect(await firstPub('a1')).toBe(expected);
    });

    it.each([
      ['an invalid string', 'not-a-date'],
      ['a missing value', undefined],
    ])('falls back to the sync time for %s', async (_name, pubDate) => {
      await seed([article('a1', { pubDate: pubDate as never })]);
      expect(await firstPub('a1')).toBe(T0);
    });
  });
});

describe('matched topics on a new row (persona path)', () => {
  it('stores each entry, with a vector score only when there is one (zero counts)', async () => {
    await seed([article('a1')], {
      topics: {
        a1: [
          { topicId: 't1', text: 'ai', vectorScore: 0.9 },
          { topicId: 't2', text: 'zero', vectorScore: 0 },
          { topicId: 't3', text: 'none', vectorScore: null },
          { topicId: null, text: 'top headline · country' },
        ],
      },
    });

    expect(JSON.parse((await stageJson('a1'))!)).toEqual([
      { topicId: 't1', text: 'ai', vectorScore: 0.9 },
      { topicId: 't2', text: 'zero', vectorScore: 0 },
      { topicId: 't3', text: 'none' },
      { topicId: null, text: 'top headline · country' },
    ]);
  });

  it('derives the topic texts from the entries: distinct, and no empty one', async () => {
    await seed([article('a1')], {
      topics: {
        a1: [
          { topicId: 't1', text: 'ai' },
          { topicId: 't2', text: 'ai' },
          { topicId: 't3', text: '' },
          { topicId: 't4', text: 'chips' },
        ],
      },
    });

    expect((await loadSuggestions())[0].userTopicIds).toEqual(['ai', 'chips']);
  });

  it('stores [] for an article with no match, and null on the legacy path', async () => {
    await seed([article('persona')]);
    await seedLegacy([article('legacy')], { legacy: ['x'] });

    expect(await stageJson('persona')).toBe('[]');
    expect(await stageJson('legacy')).toBeNull();
    expect((await loadSuggestions()).find((s) => s._id === 'legacy')!.userTopicIds).toEqual(['x']);
  });

  describe('headline scope and country', () => {
    it('keeps the country only under a COUNTRY scope', async () => {
      await seed([article('c'), article('g'), article('plain')], {
        headline: { c: 'COUNTRY', g: 'GLOBAL' },
        // the map holds a country for both, but only the COUNTRY scope may carry it
        headlineCountry: { c: 'IN', g: 'IN', plain: 'IN' },
      });

      expect(await row('c')).toMatchObject({ headlineScope: 'COUNTRY', headlineCountryCode: 'IN' });
      expect(await row('g')).toMatchObject({ headlineScope: 'GLOBAL', headlineCountryCode: null });
      expect(await row('plain')).toMatchObject({ headlineScope: null, headlineCountryCode: null });
    });

    it('stores a COUNTRY row with no country as null, not a stale one', async () => {
      await seed([article('c')], { headline: { c: 'COUNTRY' } });

      expect(await row('c')).toMatchObject({ headlineScope: 'COUNTRY', headlineCountryCode: null });
    });
  });

  describe('stable cluster id precedence', () => {
    const clusters = (...stable: (string | null)[]) =>
      stable.map((s, i) => ({ clusterId: `c${i}`, confidence: 0.9, stableClusterId: s })) as never;

    it("takes the server's largest-cluster id over any membership's", async () => {
      await seed([article('a1', { clusters: clusters('member-1') })], { stable: { a1: 'meta-1' } });
      expect((await row('a1')).stableClusterId).toBe('meta-1');
    });

    it('otherwise takes the first membership that has a non-empty stable id', async () => {
      await seed([article('a1', { clusters: clusters(null, '', 'member-2', 'member-3') })]);
      expect((await row('a1')).stableClusterId).toBe('member-2');
    });

    it('is null when neither names one', async () => {
      await seed([article('a1', { clusters: clusters(null, '') })]);
      expect((await row('a1')).stableClusterId).toBeNull();
    });
  });
});

describe('fact links', () => {
  const tracked = (text: string) =>
    createTopics([{ text, weight: 0.85, status: 'active', provenance: 'tracked', highPriority: true }]);

  describe('persona path: through topics.fact_id', () => {
    it('links a fact once however many of its topics matched, and each fact a row matched', async () => {
      const A = await interest('fact A', ['x', 'y']);
      const B = await interest('fact B', ['z']);
      const [trackedTopic] = await tracked('followed story');

      const res = await seed(['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => article(id)), {
        topics: {
          a1: [matched(A.topics[0]), matched(A.topics[1])],
          a2: [matched(A.topics[0]), matched(B.topics[0])],
          a3: [{ topicId: null, text: 'top headline · global' }],
          a4: [matched(trackedTopic), matched(A.topics[0])],
          a5: [matched(trackedTopic)],
        },
      });

      expect(res).toEqual({ insertedCount: 5, linkedCount: 4 });
      expect(await factsOf('a1')).toEqual([A.fact.id]);
      expect(await factsOf('a2')).toEqual([A.fact.id, B.fact.id].sort());
      expect(await factsOf('a3')).toEqual([]);
      expect(await factsOf('a4')).toEqual([A.fact.id]);
      expect(await factsOf('a5')).toEqual([]);
    });

    it('links nothing for a topic id no row has', async () => {
      const res = await seed([article('a1')], { topics: { a1: [{ topicId: 'ghost', text: 'ghost' }] } });
      expect(res.linkedCount).toBe(0);
    });
  });

  describe('legacy path: through fact.metadata.topics', () => {
    it('links a fact once per row however many of its texts matched, and every fact that names a text', async () => {
      const A = await interest('fact A', ['x', 'y']);
      const B = await interest('fact B', ['z']);
      const C = await interest('fact C', ['x']);

      const res = await seedLegacy(['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => article(id)), {
        a1: ['x', 'y'],
        a2: ['z', 'nope'],
        a3: ['nope'],
        a4: [],
        a5: ['x'],
      });

      expect(res).toEqual({ insertedCount: 5, linkedCount: 5 });
      expect(await factsOf('a1')).toEqual([A.fact.id, C.fact.id].sort());
      expect(await factsOf('a2')).toEqual([B.fact.id]);
      expect(await factsOf('a3')).toEqual([]);
      expect(await factsOf('a4')).toEqual([]);
      expect(await factsOf('a5')).toEqual([A.fact.id, C.fact.id].sort());
    });

    it('stores the caller-supplied texts as the row\'s topic texts', async () => {
      await seedLegacy([article('a1')], { a1: ['berlin', 'germany'] });
      expect((await loadSuggestions())[0].userTopicIds).toEqual(['berlin', 'germany']);
    });
  });
});

describe('a row already on the device', () => {
  const writeCalls = () => jest.spyOn(database, 'write');

  it('is not rewritten: a scored row keeps its score and nothing is written', async () => {
    await seed([article('a1')]);
    await toComplete('a1', 0.8);
    const spy = writeCalls();

    const res = await seed([article('a1')]);

    expect(res).toEqual({ insertedCount: 0, linkedCount: 0 });
    expect(spy).not.toHaveBeenCalled();
    expect(await row('a1')).toMatchObject({ status: 'complete', relevance: 0.8 });
  });

  describe('cluster memberships', () => {
    const memberships = (...ids: string[]) =>
      ids.map((clusterId) => ({ clusterId, confidence: 0.9 })) as never;

    it('are refreshed when they changed, leaving the score alone', async () => {
      await seed([article('a1', { clusters: memberships('c-old') })]);
      await toComplete('a1', 0.8);

      const res = await seed([article('a1', { clusters: memberships('c-new') })]);

      expect(res).toEqual({ insertedCount: 0, linkedCount: 0 });
      const r = await row('a1');
      expect(JSON.parse(r.clusterMembershipsJson!)).toEqual([{ clusterId: 'c-new', confidence: 0.9 }]);
      expect(r).toMatchObject({ status: 'complete', relevance: 0.8 });
    });

    it('are refreshed to empty when the server now lists none', async () => {
      await seed([article('a1', { clusters: memberships('c1') })]);

      await seed([article('a1', { clusters: [] })]);

      expect((await row('a1')).clusterMembershipsJson).toBe('[]');
    });

    it('count as unchanged whatever order the server lists them in', async () => {
      await seed([article('a1', { clusters: memberships('c1', 'c2') })]);
      const spy = writeCalls();

      await seed([article('a1', { clusters: memberships('c2', 'c1') })]);

      expect(spy).not.toHaveBeenCalled();
    });

    it('count a newly named stable id as a change', async () => {
      await seed([article('a1', { clusters: memberships('c1') })]);

      await seed([article('a1', { clusters: [{ clusterId: 'c1', confidence: 0.9, stableClusterId: 's1' }] as never })]);

      expect(JSON.parse((await row('a1')).clusterMembershipsJson!)).toEqual([
        { clusterId: 'c1', confidence: 0.9, stableClusterId: 's1' },
      ]);
    });

    it('are refreshed in the same write that inserts a new row', async () => {
      await seed([article('old', { clusters: memberships('c-old') })]);

      const res = await seed([article('old', { clusters: memberships('c-new') }), article('fresh')]);

      expect(res.insertedCount).toBe(1);
      expect((await row('old')).clusterMembershipsJson).toContain('c-new');
      expect(await idsInDb()).toEqual(['fresh', 'old']);
    });
  });

  // P7e: the legacy topics-empty window persisted matched_topics_json = null, which orphaned every
  // article to "Also for you" for good. A later persona sync heals it, never overwriting real data.
  describe('matched topics are healed', () => {
    const topic = { topicId: 't1', text: 'ai', vectorScore: 0.9 };

    it('when the stored value is null (a row the legacy path wrote)', async () => {
      await seedLegacy([article('a1')], {});

      const res = await seed([article('a1')], { topics: { a1: [topic] } });

      expect(res).toEqual({ insertedCount: 0, linkedCount: 0 });
      expect(JSON.parse((await stageJson('a1'))!)).toEqual([topic]);
    });

    it('when the stored value is an empty list (a persona sync that matched nothing)', async () => {
      await seed([article('a1')]);
      expect(await stageJson('a1')).toBe('[]');

      await seed([article('a1')], { topics: { a1: [topic] } });

      expect(JSON.parse((await stageJson('a1'))!)).toEqual([topic]);
    });

    it('never over a value that already holds a topic, and writes nothing', async () => {
      await seed([article('a1')], { topics: { a1: [{ topicId: 't-existing', text: 'kept' }] } });
      const spy = writeCalls();

      await seed([article('a1')], { topics: { a1: [topic] } });

      expect(spy).not.toHaveBeenCalled();
      expect(JSON.parse((await stageJson('a1'))!)).toEqual([{ topicId: 't-existing', text: 'kept' }]);
    });

    it('not on the legacy path (no persona metadata): nothing to heal with', async () => {
      await seedLegacy([article('a1')], {});
      const spy = writeCalls();

      await seedLegacy([article('a1')], { a1: ['ai'] });

      expect(spy).not.toHaveBeenCalled();
      expect(await stageJson('a1')).toBeNull();
    });

    it('not when the persona sync has no match for the article either', async () => {
      await seed([article('a1')]);
      const spy = writeCalls();

      await persistAndLinkV2Suggestions([article('a1')], new Map(), personaMeta({ topics: { a1: [] } }));

      expect(spy).not.toHaveBeenCalled();
    });

    it('not over a value it cannot parse: unparseable counts as present data', async () => {
      // No service writes a corrupt blob, so this is a bare row.
      await bareRow('a1', { matchedTopicsJson: 'garbage' });
      const spy = writeCalls();

      await seed([article('a1')], { topics: { a1: [topic] } });

      expect(spy).not.toHaveBeenCalled();
      expect((await row('a1')).matchedTopicsJson).toBe('garbage');
    });

    it('and links no fact for a row that already existed: only its topics are healed', async () => {
      const A = await interest('fact A', ['ai']);
      await seed([article('a1')]);

      await seed([article('a1')], { topics: { a1: [matched(A.topics[0])] } });

      expect(await factsOf('a1')).toEqual([]);
    });
  });
});

// KNOWN, DOCUMENTED OPEN: the existing-row read happens OUTSIDE database.write, so two callers (a
// feed-sync racing a manual refresh) can both read "absent" and both insert. The overlap is the FIRST
// id in each list, so the losing batch fails on its first operation whichever caller loses, which is
// also what an atomic SQLite batch does (MERA-APP-6K: "UNIQUE constraint failed").
describe('two concurrent callers with an overlapping id', () => {
  async function race() {
    const real = database.write.bind(database);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // R23b: hold whichever caller reaches database.write first until the other has also done its
    // existing-row read and arrived, so both are certain to have read "absent". Nothing is replaced.
    jest
      .spyOn(database, 'write')
      .mockImplementationOnce((async (work: never) => {
        await gate;
        return real(work);
      }) as never)
      .mockImplementationOnce((async (work: never) => {
        release();
        return real(work);
      }) as never);

    // The losing write queues behind the winner, and WatermelonDB starts a queued write from a timer: on
    // the strict clock that timer never fires unless the test drives it.
    return advanceUntilDone(
      Promise.allSettled([
        seed([article('shared'), article('only-a')]),
        seed([article('shared'), article('only-b')]),
      ]),
    );
  }

  test.failing('persist each id once and reject neither caller', async () => {
    const results = await race();

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await idsInDb()).toEqual(['only-a', 'only-b', 'shared']);
  });

  // R14 sibling: today's outcome. No duplicate row can appear (the id is unique), but the loser rejects and
  // loses its non-overlapping insert too.
  test('today: no id is stored twice, but one caller rejects and its own new article is lost', async () => {
    const results = await race();

    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const stored = await idsInDb();
    expect(stored.filter((id) => id === 'shared')).toHaveLength(1);
    expect(stored.filter((id) => id.startsWith('only-'))).toHaveLength(1);
    expect(await rowCount()).toBe(2);
  });
});
