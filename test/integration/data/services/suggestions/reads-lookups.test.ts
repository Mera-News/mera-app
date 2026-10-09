// article-suggestion-service point lookups: by article id, by server id, the reason gate behind the
// tap-time routing, the article-feedback context, topic-text and publication-name reads, fact
// weights, and the pure helpers the module exports. Real services on the in-memory DB. Replaces
// lib/database/services/__tests__/article-suggestion-reason-lookup.test.ts and the matching blocks
// of article-suggestion-service.test.ts.
import { nudgeFactWeight } from '@/lib/database/services/mutation-rails-service';
import {
  geoTextFromTags,
  getArticleSuggestionsByTopicTexts,
  getDistinctSuggestionPublicationNames,
  getFactWeightById,
  getReasonedSuggestionIdForArticle,
  getSuggestionByArticleId,
  getSuggestionByServerId,
  getSuggestionFeedbackContext,
  parseClusterMemberships,
  placeValueFromTags,
  saveReason,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import { addFact } from '@/lib/database/services/fact-service';
import logger from '@/lib/logger';
import {
  HOUR,
  T0,
  article,
  bareRow,
  failNextQuery,
  freezeClock,
  interest,
  matched,
  seed,
  toComplete,
  toExcluded,
  toReasonPending,
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

const GROUNDED_TEXT = 'Matches your interest in EU energy policy.';

describe('getReasonedSuggestionIdForArticle', () => {
  // The tap-time gate: land on suggestion-detail only when it has a note a reader can READ.
  it('returns the suggestion id of a complete row with a note', async () => {
    await seed([article('art-1')]);
    await toComplete('art-1');

    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBe('art-1');
  });

  it('returns the SERVER id (the row id), not the article id', async () => {
    // Persist makes the two equal, so a row whose id differs from its article id is a bare row.
    await bareRow('sugg-1', { articleId: 'art-1', status: 'complete', relevance: 0.8, reason: GROUNDED_TEXT });

    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBe('sugg-1');
  });

  it('returns null when no row exists for the article, or the row belongs to another article', async () => {
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
    await seed([article('other')]);
    await toComplete('other');
    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
  });

  it('returns null for an empty article id', async () => {
    await seed([article('art-1')]);
    await toComplete('art-1');

    await expect(getReasonedSuggestionIdForArticle('')).resolves.toBeNull();
  });

  describe('rows that exist but have nothing readable to show', () => {
    it('is null for an excluded row (relevance 0, never scored)', async () => {
      await seed([article('art-1')]);
      await toExcluded('art-1');
      await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
    });

    it('is null for an excluded row even if it carries note text', async () => {
      // batchMarkExcluded clears the note, so a note on an excluded row is a bare row.
      await bareRow('art-1', { status: 'excluded', reason: 'stale reason' });
      await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
    });

    it('is null for reason_pending (the card would show a spinner)', async () => {
      await seed([article('art-1')]);
      await toReasonPending('art-1');
      await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
    });

    it('is null for unscored', async () => {
      await seed([article('art-1')]);
      await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
    });

    it('is null for complete with no note (the reason was skipped on purpose)', async () => {
      await seed([article('art-1')]);
      await saveScoringResult('art-1', { relevance: 0.1, reason: '', reasonSkipped: true });
      await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
    });

    it('is null for a blank note', async () => {
      await seed([article('art-1')]);
      // A whitespace note shares no token with the article, so the grounding check lets it through.
      await saveReason('art-1', '   ');
      await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBeNull();
    });
  });

  it('still routes a relevance-0 row that HAS note text', async () => {
    await seed([article('art-1')]);
    await toComplete('art-1', 0);

    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBe('art-1');
  });

  it('skips a note-less duplicate in favour of the newest row that has a note', async () => {
    // Two rows for one article: no service writes that (the row id IS the article id), so bare rows.
    jest.setSystemTime(T0 - 2 * HOUR);
    await bareRow('sugg-old', { articleId: 'art-1', status: 'complete', relevance: 0.8, reason: GROUNDED_TEXT });
    jest.setSystemTime(T0 - HOUR);
    await bareRow('sugg-new', { articleId: 'art-1', status: 'reason_pending', relevance: 0.8, reason: '' });

    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBe('sugg-old');
  });

  it('takes the newer of two rows that both have a note', async () => {
    jest.setSystemTime(T0 - 2 * HOUR);
    await bareRow('sugg-old', { articleId: 'art-1', status: 'complete', relevance: 0.8, reason: GROUNDED_TEXT });
    jest.setSystemTime(T0 - HOUR);
    await bareRow('sugg-new', { articleId: 'art-1', status: 'complete', relevance: 0.8, reason: GROUNDED_TEXT });

    await expect(getReasonedSuggestionIdForArticle('art-1')).resolves.toBe('sugg-new');
  });
});
describe('getSuggestionByArticleId', () => {
  it('returns the row as a ForYouSuggestion with its linked facts, note or no note', async () => {
    const { fact, topics } = await interest('I follow racing', ['formula 1']);
    await seed([article('a1')], { topics: { a1: [matched(topics[0])] } });

    const s = await getSuggestionByArticleId('a1');

    expect(s).toMatchObject({ _id: 'a1', articleId: 'a1', status: 'unscored', reason: '', factIds: [fact.id] });
  });

  it('is null for an empty id and for an unknown article', async () => {
    expect(await getSuggestionByArticleId('')).toBeNull();
    expect(await getSuggestionByArticleId('nope')).toBeNull();
  });

  it('takes the newest row when an article has several', async () => {
    jest.setSystemTime(T0 - 2 * HOUR);
    await bareRow('old', { articleId: 'art-1' });
    jest.setSystemTime(T0 - HOUR);
    await bareRow('new', { articleId: 'art-1' });

    expect((await getSuggestionByArticleId('art-1'))?._id).toBe('new');
  });

  it('is null when the read fails', async () => {
    await seed([article('a1')]);
    failNextQuery('article_suggestions');

    expect(await getSuggestionByArticleId('a1')).toBeNull();
  });
});

describe('getSuggestionByServerId', () => {
  it('returns the ForYouSuggestion when the row exists', async () => {
    await seed([article('sug-1')]);

    expect((await getSuggestionByServerId('sug-1'))?._id).toBe('sug-1');
  });

  it('is null when the row does not exist', async () => {
    expect(await getSuggestionByServerId('nonexistent')).toBeNull();
  });
});

describe('getSuggestionFeedbackContext', () => {
  async function seedContext() {
    const { fact, topics } = await interest('I live in Berlin', ['berlin']);
    await seed(
      [
        article('a1', {
          category: 'politics',
          maxClusterSize: 12,
          entities: ['Angela', ' ', 'Bundestag', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10'],
          geo_tags: [{ city: 'Berlin', region: 'BE', countryCode: 'DEU' }] as never,
        }),
      ],
      { topics: { a1: [matched(topics[0])] } },
    );
    return { fact, topics };
  }

  it('assembles the suggestion, topic texts, linked facts, entities, category, cluster size and place', async () => {
    const { fact } = await seedContext();

    const ctx = await getSuggestionFeedbackContext({ suggestionId: 'a1' });

    expect(ctx).toMatchObject({
      suggestion: { _id: 'a1' },
      matchedTopicTexts: ['berlin'],
      linkedFacts: [{ id: fact.id, statement: 'I live in Berlin' }],
      // blank entries are dropped, then at most eight are kept
      entities: ['Angela', 'Bundestag', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9'],
      category: 'politics',
      clusterSize: 12,
      geoText: 'Berlin',
      placeValue: 'Berlin',
    });
  });

  it('falls back to the article id when the suggestion id is unknown', async () => {
    await seedContext();

    expect((await getSuggestionFeedbackContext({ suggestionId: 'missing', articleId: 'a1' }))?.suggestion._id).toBe('a1');
    expect((await getSuggestionFeedbackContext({ articleId: 'a1' }))?.suggestion._id).toBe('a1');
  });

  it('is null when no row exists on the device', async () => {
    await seedContext();

    expect(await getSuggestionFeedbackContext({ suggestionId: 'missing' })).toBeNull();
    expect(await getSuggestionFeedbackContext({ articleId: 'missing' })).toBeNull();
    expect(await getSuggestionFeedbackContext({})).toBeNull();
  });

  it('has no cluster size, place or facts for a bare headline-style row', async () => {
    await seed([article('a1', { maxClusterSize: null })]);

    expect(await getSuggestionFeedbackContext({ suggestionId: 'a1' })).toMatchObject({
      matchedTopicTexts: [],
      linkedFacts: [],
      entities: [],
      category: null,
      clusterSize: null,
      geoText: null,
      placeValue: null,
    });
  });

  it('names a supranational place as prose but keeps the raw token for the structured filter', async () => {
    await seed([article('a1', { geo_tags: [{ countryCode: 'MIDDLE_EAST' }] as never })]);

    const ctx = await getSuggestionFeedbackContext({ suggestionId: 'a1' });

    expect(ctx?.geoText).toBe('Middle East');
    expect(ctx?.placeValue).toBe('MIDDLE_EAST');
  });
});

describe('getArticleSuggestionsByTopicTexts', () => {
  it('is [] for no texts', async () => {
    await seed([article('a1')]);
    expect(await getArticleSuggestionsByTopicTexts([])).toEqual([]);
  });

  it('returns the rows matching any of the texts, newest publication first', async () => {
    const { topics } = await interest('Places', ['berlin', 'paris', 'tokyo']);
    await seed(
      [
        article('s1', { pubDate: '2026-10-07T00:00:00.000Z' }),
        article('s2', { pubDate: '2026-10-09T00:00:00.000Z' }),
        article('s3', { pubDate: '2026-10-08T00:00:00.000Z' }),
      ],
      { topics: { s1: [matched(topics[0])], s2: [matched(topics[1])], s3: [matched(topics[2])] } },
    );

    const rows = await getArticleSuggestionsByTopicTexts(['berlin', 'paris']);

    expect(rows.map((r) => r.id)).toEqual(['s2', 's1']);
  });

  it('is [] when nothing matches', async () => {
    const { topics } = await interest('Places', ['london']);
    await seed([article('s1')], { topics: { s1: [matched(topics[0])] } });

    expect(await getArticleSuggestionsByTopicTexts(['berlin'])).toEqual([]);
  });

  // parseTopicIds, through the stored column. No service writes a corrupt blob, so these are bare rows.
  it.each([
    ['null', null],
    ['not json', 'not-json'],
    ['a non-array', '"just-a-string"'],
  ])('matches nothing for a %s column', async (_name, json) => {
    await bareRow('s1', { matchedTopicTextsJson: json });

    expect(await getArticleSuggestionsByTopicTexts(['not-json', 'just-a-string', 'valid'])).toEqual([]);
  });

  it('keeps the valid strings and drops empty strings and non-strings', async () => {
    await bareRow('s1', { matchedTopicTextsJson: '["valid", "", 42, null]' });

    expect((await getArticleSuggestionsByTopicTexts(['valid'])).map((r) => r.id)).toEqual(['s1']);
    expect(await getArticleSuggestionsByTopicTexts([''])).toEqual([]);
  });
});

describe('getDistinctSuggestionPublicationNames', () => {
  it('returns each name once, lower-cased and whitespace-collapsed, skipping blanks', async () => {
    await seed([
      article('a1', { publication_name: 'Times  of India' }),
      article('a2', { publication_name: ' times of INDIA ' }),
      article('a3', { publication_name: 'Der Spiegel' }),
      article('a4', { publication_name: null }),
      article('a5', { publication_name: '   ' }),
    ]);

    expect(await getDistinctSuggestionPublicationNames()).toEqual(new Set(['times of india', 'der spiegel']));
  });

  it('is empty on a fresh device', async () => {
    expect(await getDistinctSuggestionPublicationNames()).toEqual(new Set());
  });

  it('never throws: a read failure yields an empty set and is reported', async () => {
    await seed([article('a1')]);
    failNextQuery('article_suggestions');

    expect(await getDistinctSuggestionPublicationNames()).toEqual(new Set());
    expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: 'article-suggestion', method: 'getDistinctSuggestionPublicationNames' },
    });
  });
});

describe('getFactWeightById', () => {
  it('is empty with no facts', async () => {
    expect(await getFactWeightById()).toEqual(new Map());
  });

  it('maps each fact to its weight multiplier, 1 when it has none', async () => {
    const plain = await addFact('plain');
    const nudged = await addFact('nudged');
    await nudgeFactWeight(nudged.id, -0.5, 'nudge');

    const weights = await getFactWeightById();

    expect(weights.get(plain.id)).toBe(1);
    expect(weights.get(nudged.id)).toBe(0.5);
    expect(weights.size).toBe(2);
  });
});

describe('geoTextFromTags / placeValueFromTags', () => {
  it('prefers city, then region, then country code', () => {
    expect(geoTextFromTags([{ city: 'Berlin', region: 'BE', countryCode: 'DE' }])).toBe('Berlin');
    expect(geoTextFromTags([{ region: 'Bavaria', countryCode: 'DE' }])).toBe('Bavaria');
    expect(geoTextFromTags([{ countryCode: 'DE' }])).toBe('DE');
    expect(placeValueFromTags([{ city: 'Berlin', region: 'BE', countryCode: 'DE' }])).toBe('Berlin');
    expect(placeValueFromTags([{ region: 'Bavaria', countryCode: 'DE' }])).toBe('Bavaria');
    expect(placeValueFromTags([{ countryCode: 'DE' }])).toBe('DE');
  });

  it('humanizes a supranational code in the label but not in the filter value', () => {
    expect(geoTextFromTags([{ countryCode: 'MIDDLE_EAST' }])).toBe('Middle East');
    expect(placeValueFromTags([{ countryCode: 'MIDDLE_EAST' }])).toBe('MIDDLE_EAST');
  });

  it('EU, two letters like a real country code, is decided by lookup and humanized too', () => {
    expect(geoTextFromTags([{ countryCode: 'EU' }])).toBe('European Union');
    expect(placeValueFromTags([{ countryCode: 'EU' }])).toBe('EU');
  });

  it('is null when nothing is nameable, and skips empty entries', () => {
    expect(geoTextFromTags([])).toBeNull();
    expect(placeValueFromTags([])).toBeNull();
    expect(geoTextFromTags([{ city: null, region: null, countryCode: null }])).toBeNull();
    expect(geoTextFromTags([{ city: '  ', region: ' ', countryCode: ' ' }])).toBeNull();
    expect(geoTextFromTags([{ city: null, region: null, countryCode: null }, { countryCode: 'GULF' }])).toBe('Gulf');
    expect(placeValueFromTags([{ city: null, region: null, countryCode: null }, { countryCode: 'GULF' }])).toBe('GULF');
    expect(geoTextFromTags([null as never, { city: 'Oslo' }])).toBe('Oslo');
  });
});

describe('parseClusterMemberships', () => {
  it('keeps a stable id only when it is a non-empty string', () => {
    expect(
      parseClusterMemberships(
        JSON.stringify([
          { clusterId: 'c1', confidence: 0.9, stableClusterId: 's1' },
          { clusterId: 'c2', confidence: 0.4, stableClusterId: '' },
          { clusterId: 'c3', confidence: 0.2, stableClusterId: 7 },
          { clusterId: 'c4', confidence: 0.1 },
        ]),
      ),
    ).toEqual([
      { clusterId: 'c1', confidence: 0.9, stableClusterId: 's1' },
      { clusterId: 'c2', confidence: 0.4 },
      { clusterId: 'c3', confidence: 0.2 },
      { clusterId: 'c4', confidence: 0.1 },
    ]);
  });

  it('yields [] for null, empty, unparseable and non-array input', () => {
    expect(parseClusterMemberships(null)).toEqual([]);
    expect(parseClusterMemberships(undefined)).toEqual([]);
    expect(parseClusterMemberships('')).toEqual([]);
    expect(parseClusterMemberships('{broken')).toEqual([]);
    expect(parseClusterMemberships('{}')).toEqual([]);
  });
});
