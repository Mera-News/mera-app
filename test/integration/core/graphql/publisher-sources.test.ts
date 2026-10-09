// publisher-sources at its seam: the real Apollo client against MSW. The query had no test; this
// pins the variables, the name filtering, the failure floor (an empty list, never a throw) and
// the publisher-name fallback the subscription row stores.
import { fetchPublisherSourceNames, resolveSubscriptionSourceNames } from '@/lib/subscriptions/publisher-sources';
import { fixture, mockGqlError, server } from '@/test/helpers';
import { failTransport, resetNetworkMemory, serve, spyLogger, underClock } from './kit';

let log: ReturnType<typeof spyLogger>;
beforeEach(() => {
  resetNetworkMemory();
  log = spyLogger();
});
afterEach(() => log.restore());

const servePublisherSources = (...names: unknown[]) =>
  serve('PublicationSourcesForNewsPublisher', () => ({
    publicationSourcesForNewsPublisher: {
      publicationSources: names.map((publication_name, i) => ({ _id: `s${i}`, publication_name })),
    },
  }));

const serviceCaptures = () =>
  log.captureException.mock.calls.filter(
    ([, ctx]) => (ctx?.tags as { service?: string } | undefined)?.service === 'publisher-sources',
  );

describe('fetchPublisherSourceNames', () => {
  it('returns every source name of the publisher the mock backend knows', async () => {
    const { publications } = fixture('articles');
    const publisher = publications[0];
    const expected = publications.filter((p) => p.publisherId === publisher.publisherId).map((p) => p.name);

    expect(await fetchPublisherSourceNames(publisher.publisherId)).toEqual(expected);
  });

  it('sends the publisher id as the only variable', async () => {
    const seen = servePublisherSources('A');
    await fetchPublisherSourceNames('pub-1');
    expect(seen).toEqual([{ publisherId: 'pub-1' }]);
  });

  it('returns [] without a request for an empty publisher id', async () => {
    const seen = servePublisherSources('A');
    expect(await fetchPublisherSourceNames('')).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('uses no-cache: a second call asks the server again', async () => {
    const seen = servePublisherSources('A');
    await fetchPublisherSourceNames('pub-1');
    await fetchPublisherSourceNames('pub-1');
    expect(seen).toHaveLength(2);
  });

  it('drops blank and non-string names, keeping the raw spelling of the rest', async () => {
    servePublisherSources('Times of India', '', '   ', null, 42, ' TOI Business ');
    expect(await fetchPublisherSourceNames('pub-1')).toEqual(['Times of India', ' TOI Business ']);
  });

  it('returns [] when the server has no sources for the publisher', async () => {
    serve('PublicationSourcesForNewsPublisher', () => ({ publicationSourcesForNewsPublisher: null }));
    expect(await fetchPublisherSourceNames('pub-1')).toEqual([]);
    expect(serviceCaptures()).toEqual([]);
  });

  it('returns [] and logs on a GraphQL error instead of throwing', async () => {
    server.use(mockGqlError('PublicationSourcesForNewsPublisher', 'INTERNAL_SERVER_ERROR', { message: 'boom' }));
    expect(await fetchPublisherSourceNames('pub-1')).toEqual([]);
    expect(serviceCaptures()).toHaveLength(1);
    expect(serviceCaptures()[0][1]).toMatchObject({
      tags: { service: 'publisher-sources', method: 'fetchPublisherSourceNames' },
      extra: { publisherId: 'pub-1' },
    });
  });

  it('returns [] and logs on a transport failure instead of throwing', async () => {
    server.use(failTransport('PublicationSourcesForNewsPublisher'));
    expect(await underClock(() => fetchPublisherSourceNames('pub-1'))).toEqual([]);
    expect(serviceCaptures()).toHaveLength(1);
  });
});

describe('resolveSubscriptionSourceNames', () => {
  it('appends the publisher name to the fetched sources as a floor', async () => {
    servePublisherSources('Times of India', 'TOI Business');
    expect(await resolveSubscriptionSourceNames('pub-1', 'The Times Group')).toEqual([
      'Times of India',
      'TOI Business',
      'The Times Group',
    ]);
  });

  it('returns only the fetched sources when the publisher name is empty', async () => {
    servePublisherSources('Times of India');
    expect(await resolveSubscriptionSourceNames('pub-1', '')).toEqual(['Times of India']);
  });

  it('falls back to the publisher name alone when the sources fail to resolve', async () => {
    server.use(mockGqlError('PublicationSourcesForNewsPublisher', 'INTERNAL_SERVER_ERROR', { message: 'boom' }));
    expect(await resolveSubscriptionSourceNames('pub-1', 'The Times Group')).toEqual(['The Times Group']);
  });

  it('is empty when the publisher id and name are both empty', async () => {
    expect(await resolveSubscriptionSourceNames('', '')).toEqual([]);
  });
});
