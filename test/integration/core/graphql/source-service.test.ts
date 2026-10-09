// SourceService at its seam: the real Apollo client against MSW. Asserts the variables sent, the
// mapped return value, the documents' shape (source names, never a feed URL) and the one side
// effect: publisher source names are remembered by getNewsPublishers and not by searchPublishers.
// Replaces lib/__tests__/source-service.test.ts.
import { SourceService } from '@/lib/source-service';
import {
  __clearPublisherSourceNames,
  knownSourceNamesForPublisher,
} from '@/lib/database/services/publisher-source-names';
import { mockGqlError, server } from '@/test/helpers';
import { failTransport, rejectionOf, resetNetworkMemory, serve, serveWithDocument, spyLogger } from './kit';

let log: ReturnType<typeof spyLogger>;
beforeEach(() => {
  resetNetworkMemory();
  __clearPublisherSourceNames();
  log = spyLogger();
});
afterEach(() => log.restore());

const expectServiceCapture = (method: string, extra: Record<string, unknown>) =>
  expect(log.captureException).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ tags: { service: 'source-service', method }, extra }),
  );

const source = (overrides: Record<string, unknown> = {}) => ({
  _id: 's1',
  publication_name: 'Test Publisher',
  category: 'general',
  publication_type: 'newspaper',
  categories: ['general'],
  detected_language_code: 'en',
  ...overrides,
});

/** A publisher with exactly the fields GetNewsPublishers selects. */
const newsPublisher = (overrides: Record<string, unknown> = {}) => ({
  _id: 'pub-1',
  name: 'Test Publisher',
  website_url: 'https://example.com',
  country_code: 'USA',
  subscription_uri: null,
  publicationSources: [],
  ...overrides,
});

/** A hit with exactly the fields SearchPublishers selects. */
const searchHit = (overrides: Record<string, unknown> = {}) => ({
  _id: 'pub-1',
  name: 'Times of India',
  website_url: 'https://timesofindia.indiatimes.com',
  country_code: 'IND',
  country_name: 'India',
  subscription_uri: null,
  matchingSources: [],
  ...overrides,
});

const pageInfo = (overrides: Record<string, unknown> = {}) => ({
  endCursor: null,
  hasNextPage: false,
  pageSize: 20,
  ...overrides,
});

describe('SourceService.getNewsPublishers', () => {
  it('returns the publishers and page info the server answered', async () => {
    const serverResp = {
      newsPublishers: [newsPublisher(), newsPublisher({ _id: 'pub-2' })],
      pageInfo: pageInfo({ endCursor: 'cursor-2' }),
    };
    serve('GetNewsPublishers', () => ({ newsPublishers: serverResp }));

    expect(await SourceService.getNewsPublishers()).toEqual(serverResp);
  });

  it('returns the empty structure when the server answers null', async () => {
    serve('GetNewsPublishers', () => ({ newsPublishers: null }));
    const result = await SourceService.getNewsPublishers();
    expect(result.newsPublishers).toEqual([]);
    expect(result.pageInfo.hasNextPage).toBe(false);
    expect(result.pageInfo.pageSize).toBe(20);
    expect(result.pageInfo.endCursor).toBeNull();
  });

  it('uses no-cache: the same request is asked twice', async () => {
    const seen = serve('GetNewsPublishers', () => ({ newsPublishers: null }));
    await SourceService.getNewsPublishers();
    await SourceService.getNewsPublishers();
    expect(seen).toHaveLength(2);
  });

  it('sends first=20 and no country filter or cursor by default', async () => {
    const seen = serve('GetNewsPublishers', () => ({ newsPublishers: null }));
    await SourceService.getNewsPublishers();
    expect(seen).toEqual([{ first: 20 }]);
    expect(seen[0].countryCode).toBeUndefined();
  });

  it('passes the countryCode filter', async () => {
    const seen = serve('GetNewsPublishers', () => ({ newsPublishers: null }));
    await SourceService.getNewsPublishers({ countryCode: 'GBR' });
    expect(seen).toEqual([{ countryCode: 'GBR', first: 20 }]);
  });

  it('passes custom first and after', async () => {
    const seen = serve('GetNewsPublishers', () => ({ newsPublishers: null }));
    await SourceService.getNewsPublishers({ first: 5, after: 'page-2' });
    expect(seen).toEqual([{ first: 5, after: 'page-2' }]);
  });

  it('sizes the fallback page to options.first', async () => {
    serve('GetNewsPublishers', () => ({ newsPublishers: null }));
    const result = await SourceService.getNewsPublishers({ first: 7 });
    expect(result.pageInfo.pageSize).toBe(7);
  });

  it('re-throws a GraphQL error and logs it with the options', async () => {
    server.use(mockGqlError('GetNewsPublishers', 'INTERNAL_SERVER_ERROR', { message: 'publishers query failed' }));
    await expect(SourceService.getNewsPublishers({ countryCode: 'GBR' })).rejects.toThrow('publishers query failed');
    expectServiceCapture('getNewsPublishers', { options: { countryCode: 'GBR' } });
  });

  it('re-throws a transport failure and logs it', async () => {
    server.use(failTransport('GetNewsPublishers'));
    expect(await rejectionOf(() => SourceService.getNewsPublishers())).toBeInstanceOf(Error);
    expectServiceCapture('getNewsPublishers', { options: undefined });
  });
});

describe('SourceService.searchPublishers', () => {
  it('returns the hits and page info the server answered', async () => {
    const serverResp = {
      publishers: [searchHit(), searchHit({ _id: 'pub-2' })],
      pageInfo: pageInfo({ endCursor: 'cursor-1', hasNextPage: true }),
    };
    serve('SearchPublishers', () => ({ searchPublishers: serverResp }));

    expect(await SourceService.searchPublishers({ query: 'Times of India' })).toEqual(serverResp);
  });

  it('returns the empty structure when the server answers null', async () => {
    serve('SearchPublishers', () => ({ searchPublishers: null }));
    const result = await SourceService.searchPublishers({ query: 'xx' });
    expect(result.publishers).toEqual([]);
    expect(result.pageInfo.hasNextPage).toBe(false);
    expect(result.pageInfo.pageSize).toBe(20);
  });

  it('uses no-cache: the same search is asked twice', async () => {
    const seen = serve('SearchPublishers', () => ({ searchPublishers: null }));
    await SourceService.searchPublishers({ query: 'xx' });
    await SourceService.searchPublishers({ query: 'xx' });
    expect(seen).toHaveLength(2);
  });

  it('sends the query and default first=20', async () => {
    const seen = serve('SearchPublishers', () => ({ searchPublishers: null }));
    await SourceService.searchPublishers({ query: 'bbc' });
    expect(seen).toEqual([{ query: 'bbc', first: 20 }]);
  });

  it('passes custom first and after', async () => {
    const seen = serve('SearchPublishers', () => ({ searchPublishers: null }));
    await SourceService.searchPublishers({ query: 'bbc', first: 5, after: 'cursor-x' });
    expect(seen).toEqual([{ query: 'bbc', first: 5, after: 'cursor-x' }]);
  });

  it('sizes the fallback page to options.first', async () => {
    serve('SearchPublishers', () => ({ searchPublishers: null }));
    const result = await SourceService.searchPublishers({ query: 'bbc', first: 7 });
    expect(result.pageInfo.pageSize).toBe(7);
  });

  it('re-throws a GraphQL error and logs it with the options', async () => {
    server.use(mockGqlError('SearchPublishers', 'INTERNAL_SERVER_ERROR', { message: 'search query failed' }));
    await expect(SourceService.searchPublishers({ query: 'bbc' })).rejects.toThrow('search query failed');
    expectServiceCapture('searchPublishers', { options: { query: 'bbc' } });
  });

  it('re-throws a transport failure and logs it', async () => {
    server.use(failTransport('SearchPublishers'));
    expect(await rejectionOf(() => SourceService.searchPublishers({ query: 'bbc' }))).toBeInstanceOf(Error);
    expectServiceCapture('searchPublishers', { options: { query: 'bbc' } });
  });
});

// No feeds in the app: the publisher list carries source NAMES (they key more/fewer) and no feed
// URL; search results carry no feed URL either.
describe('SourceService: publication shape, no feeds', () => {
  it('getNewsPublishers selects source names, never feed_url, and records the names', async () => {
    const sent = serveWithDocument('GetNewsPublishers', () => ({
      newsPublishers: {
        newsPublishers: [
          newsPublisher({
            _id: 'p1',
            publicationSources: [
              source({ _id: 's1', publication_name: 'Times of India' }),
              source({ _id: 's2', publication_name: 'TOI Business' }),
            ],
          }),
        ],
        pageInfo: pageInfo(),
      },
    }));

    await SourceService.getNewsPublishers({ countryCode: 'IND' });

    expect(sent.documents[0]).toMatch(/publicationSources\s*\{[^}]*publication_name/);
    expect(sent.documents[0]).not.toContain('feed_url');
    expect(knownSourceNamesForPublisher('p1')).toEqual(['Times of India', 'TOI Business']);
  });

  it('getNewsPublishers forgets the names of a publisher that now lists no sources', async () => {
    serve('GetNewsPublishers', () => ({
      newsPublishers: {
        newsPublishers: [newsPublisher({ _id: 'p3', publicationSources: [source({ publication_name: 'Old Name' })] })],
        pageInfo: pageInfo(),
      },
    }));
    await SourceService.getNewsPublishers();
    expect(knownSourceNamesForPublisher('p3')).toEqual(['Old Name']);

    serve('GetNewsPublishers', () => ({
      newsPublishers: { newsPublishers: [newsPublisher({ _id: 'p3' })], pageInfo: pageInfo() },
    }));
    await SourceService.getNewsPublishers();
    expect(knownSourceNamesForPublisher('p3')).toBeNull();
  });

  it('searchPublishers selects no feed_url and records nothing (matchingSources is a filtered subset)', async () => {
    const sent = serveWithDocument('SearchPublishers', () => ({
      searchPublishers: {
        publishers: [searchHit({ _id: 'p2', name: 'X', matchingSources: [source({ _id: 's', publication_name: 'X' })] })],
        pageInfo: pageInfo(),
      },
    }));

    await SourceService.searchPublishers({ query: 'xx' });

    expect(sent.documents[0]).not.toContain('feed_url');
    expect(knownSourceNamesForPublisher('p2')).toBeNull();
  });

  it('has no feed-list method any more', () => {
    expect((SourceService as unknown as Record<string, unknown>).getPublicationSources).toBeUndefined();
  });
});
