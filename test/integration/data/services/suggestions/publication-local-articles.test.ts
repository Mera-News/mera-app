// getLocalArticlesForPublication: a publication's articles already on the device, for its page offline.
// The WHERE clause is the behaviour (source-name match, no excluded rows, newest first), and the old
// shared mock ignored every clause, so the old test could only assert the query arguments. Here the
// real query runs. Replaces lib/database/services/__tests__/publication-local-articles.test.ts.
import {
  PUBLICATION_LOCAL_ARTICLES_LIMIT,
  getLocalArticlesForPublication,
} from '@/lib/database/services/publication-local-articles';
import { DAY, HOUR, T0, article, bareRow, freezeClock, seed, toComplete, toExcluded, toReasonPending } from './support';

beforeEach(() => freezeClock());

const idsOf = async (names: string[], limit?: number) =>
  (await getLocalArticlesForPublication(names, limit)).map((a) => a._id);

describe('getLocalArticlesForPublication', () => {
  it('returns nothing for no usable name', async () => {
    await seed([article('a1', { publication_name: 'Times of India' })]);

    expect(await idsOf([])).toEqual([]);
    expect(await idsOf(['  ', ''])).toEqual([]);
  });

  it('matches the SOURCE name on the row, across every name the publication goes by', async () => {
    await seed([
      article('toi', { publication_name: 'Times of India' }),
      article('biz', { publication_name: 'TOI Business' }),
      article('other', { publication_name: 'The Hindu' }),
      article('nameless', { publication_name: null }),
    ]);

    expect((await idsOf(['Times of India', 'TOI Business'])).sort()).toEqual(['biz', 'toi']);
    expect(await idsOf(['Times of India'])).toEqual(['toi']);
  });

  it('counts two spellings of one name once', async () => {
    await seed([article('toi', { publication_name: 'Times of India' })]);

    expect(await idsOf(['Times of India', 'times of india', '  TIMES  OF  INDIA '])).toEqual(['toi']);
  });

  // The match is the stored spelling (an IN list), not a case-folded one.
  it('matches the stored spelling exactly', async () => {
    await seed([article('toi', { publication_name: 'times of india' })]);

    expect(await idsOf(['Times of India'])).toEqual([]);
    expect(await idsOf(['times of india'])).toEqual(['toi']);
  });

  it('leaves out excluded rows, whatever else the page asks for', async () => {
    await seed(['seen', 'pending', 'unscored', 'hidden'].map((id) => article(id, { publication_name: 'Times of India' })));
    await toComplete('seen');
    await toReasonPending('pending');
    await toExcluded('hidden');

    expect((await idsOf(['Times of India'])).sort()).toEqual(['pending', 'seen', 'unscored']);
  });

  it('lists the newest first-publication first', async () => {
    const pub = (id: string, ageHours: number) =>
      article(id, { publication_name: 'Times of India', pubDate: new Date(T0 - ageHours * HOUR).toISOString() });
    await seed([pub('mid', 5), pub('new', 1), pub('old', 30)]);

    expect(await idsOf(['Times of India'])).toEqual(['new', 'mid', 'old']);
  });

  it('returns one row per article id', async () => {
    // Persist keys a row by its article id, so a second row for one article is a bare row.
    await seed([article('a1', { publication_name: 'Times of India' })]);
    await bareRow('copy', { articleId: 'a1', publicationName: 'Times of India' });
    await bareRow('no-article', { articleId: '', publicationName: 'Times of India' });

    expect(await idsOf(['Times of India'])).toEqual(['a1']);
  });

  it('caps the list at the limit', async () => {
    await seed(['a', 'b', 'c'].map((id, i) => article(id, { publication_name: 'X', pubDate: new Date(T0 - i * HOUR).toISOString() })));

    expect(await idsOf(['X'], 2)).toEqual(['a', 'b']);
  });

  it(`caps at ${PUBLICATION_LOCAL_ARTICLES_LIMIT} by default`, async () => {
    await seed(
      Array.from({ length: PUBLICATION_LOCAL_ARTICLES_LIMIT + 2 }, (_, i) =>
        article(`a${String(i).padStart(3, '0')}`, { publication_name: 'X', pubDate: new Date(T0 - i * HOUR).toISOString() }),
      ),
    );

    const out = await idsOf(['X']);

    expect(out).toHaveLength(PUBLICATION_LOCAL_ARTICLES_LIMIT);
    expect(out[0]).toBe('a000');
  });

  it('returns the NewsArticle shape the online list uses', async () => {
    await seed([
      article('a1', {
        publication_name: 'Times of India',
        country_code: 'IND',
        language_code: 'hi',
        title: 'मूल शीर्षक',
        title_en: 'English title',
        description_en: 'English description',
        article_url: 'https://x/a1',
        image_url: 'https://x/a1.png',
        category: 'business',
        pubDate: new Date(T0 - DAY).toISOString(),
      }),
    ]);

    const [a] = await getLocalArticlesForPublication(['Times of India']);

    expect(a).toEqual({
      _id: 'a1',
      article_url: 'https://x/a1',
      source_uri: 'https://x/a1',
      title: 'मूल शीर्षक',
      title_en: 'English title',
      title_en_internal_only: 'English title',
      description: 'English description',
      description_en: 'English description',
      image_url: 'https://x/a1.png',
      original_language_code: 'hi',
      category: 'business',
      pubDate: new Date(T0 - DAY).toISOString(),
      publicationSource: { _id: 'a1', publication_name: 'Times of India', country_code: 'IND' },
    });
  });

  it('fills what the row lacks with empty text or nothing', async () => {
    await seed([
      article('a1', {
        publication_name: 'X',
        country_code: null,
        language_code: null,
        title: null,
        title_en: 'Only english',
        description_en: null,
        article_url: null,
        image_url: null,
        category: null,
      }),
    ]);

    const [a] = await getLocalArticlesForPublication(['X']);

    expect(a).toMatchObject({
      title: 'Only english',
      description: '',
      article_url: '',
      source_uri: '',
      image_url: undefined,
      original_language_code: undefined,
      category: undefined,
      publicationSource: { publication_name: 'X', country_code: '' },
    });
  });
});
