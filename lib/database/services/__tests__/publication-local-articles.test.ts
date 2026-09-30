// publication-local-articles: the WHERE clause is the behaviour, and the shared
// DB mock ignores Q.where, so the query arguments are asserted directly.

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

import database from '@/lib/database/index';
import { Q } from '@nozbe/watermelondb';
import { getLocalArticlesForPublication } from '../publication-local-articles';

const db = database as unknown as {
  get: (t: string) => { query: jest.Mock; _rows?: unknown[] };
  _collections?: Record<string, { query: jest.Mock }>;
};

function row(articleId: string, publicationName: string, ms: number) {
  return {
    articleId,
    publicationName,
    countryCode: 'IND',
    titleEn: `t-${articleId}`,
    titleOriginal: null,
    descriptionEn: null,
    articleUrl: `https://x/${articleId}`,
    imageUrl: null,
    languageCode: 'en',
    category: null,
    firstPubDate: new Date(ms),
  };
}

describe('getLocalArticlesForPublication', () => {
  it('returns nothing for no names, without a query', async () => {
    const collection = db.get('article_suggestions');
    const spy = jest.spyOn(collection, 'query');
    await expect(getLocalArticlesForPublication(['  '])).resolves.toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('matches the names, drops excluded rows, newest first, one per article, as NewsArticle', async () => {
    const collection = db.get('article_suggestions');
    const original = collection.query;
    const fetch = jest.fn(async () => [row('a2', 'TOI Business', 2), row('a1', 'Times of India', 1), row('a2', 'TOI Business', 2)]);
    collection.query = jest.fn(() => ({ fetch })) as unknown as jest.Mock;
    try {
      const out = await getLocalArticlesForPublication(['Times of India', 'times of india', 'TOI Business']);
      expect(collection.query).toHaveBeenCalledWith(
        Q.where('publication_name', Q.oneOf(['Times of India', 'TOI Business'])),
        Q.where('status', Q.notEq('excluded')),
        Q.sortBy('first_pub_date', Q.desc),
      );
      expect(out.map((a) => a._id)).toEqual(['a2', 'a1']);
      expect(out[0]).toEqual(
        expect.objectContaining({
          _id: 'a2',
          title: 't-a2',
          article_url: 'https://x/a2',
          pubDate: new Date(2).toISOString(),
          publicationSource: expect.objectContaining({ publication_name: 'TOI Business', country_code: 'IND' }),
        }),
      );
    } finally {
      collection.query = original;
    }
  });

  it('caps the list', async () => {
    const collection = db.get('article_suggestions');
    const original = collection.query;
    collection.query = jest.fn(() => ({
      fetch: async () => [row('a', 'X', 3), row('b', 'X', 2), row('c', 'X', 1)],
    })) as unknown as jest.Mock;
    try {
      await expect(getLocalArticlesForPublication(['X'], 2)).resolves.toHaveLength(2);
    } finally {
      collection.query = original;
    }
  });
});
