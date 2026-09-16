const mockSearchPublishers = jest.fn();

jest.mock('@/lib/source-service', () => ({
  SourceService: { searchPublishers: (...args: unknown[]) => mockSearchPublishers(...args) },
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

import {
  __clearPublisherLookupCache,
  resolvePublisherForSourceName,
} from '../publisher-lookup';

const hit = (over: Record<string, unknown> = {}) => ({
  _id: 'p1',
  name: 'Het Parool',
  country_code: 'NLD',
  country_name: 'Netherlands',
  website_url: 'https://parool.nl',
  subscription_uri: 'https://www.parool.nl/abonnementen',
  matchingSources: [],
  ...over,
});

const ok = (publishers: unknown[]) =>
  mockSearchPublishers.mockResolvedValue({
    publishers,
    pageInfo: { endCursor: null, hasNextPage: false, pageSize: 20 },
  });

beforeEach(() => {
  mockSearchPublishers.mockReset();
  __clearPublisherLookupCache();
});

describe('resolvePublisherForSourceName', () => {
  it('resolves through an exact matchingSources name, not the fuzzy hit', async () => {
    ok([
      // A fuzzy hit the regex found but which owns no source by this name.
      hit({ _id: 'wrong', name: 'Parool Sport', matchingSources: [] }),
      hit({
        _id: 'right',
        name: 'DPG Media',
        matchingSources: [{ _id: 's1', publication_name: 'Het Parool' }],
      }),
    ]);

    const res = await resolvePublisherForSourceName('Het Parool', 'NLD');

    expect(res?.publisherId).toBe('right');
    expect(res?.subscriptionUri).toBe('https://www.parool.nl/abonnementen');
  });

  it('falls back to the publisher OWN name when matchingSources is empty', async () => {
    // The documented case: a publisher that matched on its own name or
    // website_url comes back with matchingSources: []. Without this branch it
    // would resolve to nothing, which is most publishers.
    ok([hit({ _id: 'own', name: 'Het Parool', matchingSources: [] })]);

    const res = await resolvePublisherForSourceName('Het Parool', 'NLD');

    expect(res?.publisherId).toBe('own');
  });

  it('returns null when nothing matches the name exactly', async () => {
    ok([hit({ _id: 'near', name: 'Het Parool Weekend', matchingSources: [] })]);

    expect(await resolvePublisherForSourceName('Het Parool', 'NLD')).toBeNull();
  });

  it('normalises case and whitespace on both sides', async () => {
    ok([hit({ _id: 'norm', name: '  het   PAROOL ' })]);

    expect((await resolvePublisherForSourceName('Het Parool', null))?.publisherId).toBe('norm');
  });

  it('uses country as a TIE-BREAK between exact matches, never as a filter', async () => {
    ok([
      hit({ _id: 'us', name: 'The Post', country_code: 'USA' }),
      hit({ _id: 'gb', name: 'The Post', country_code: 'GBR' }),
    ]);

    expect((await resolvePublisherForSourceName('The Post', 'GBR'))?.publisherId).toBe('gb');
  });

  it('still resolves when the country does not match any exact hit', async () => {
    // The filter version of this rule would return null here. It must not:
    // a visit row's country is nullable and a publisher's own code can be
    // 'GLOBAL', so filtering on it drops correct answers.
    ok([hit({ _id: 'global', name: 'The Next Web', country_code: 'GLOBAL' })]);

    expect((await resolvePublisherForSourceName('The Next Web', 'NLD'))?.publisherId).toBe(
      'global',
    );
  });

  it('carries a null subscription_uri through as null rather than dropping the publisher', async () => {
    ok([hit({ _id: 'nouri', subscription_uri: null })]);

    const res = await resolvePublisherForSourceName('Het Parool', 'NLD');

    expect(res?.publisherId).toBe('nouri');
    expect(res?.subscriptionUri).toBeNull();
  });

  it('never queries for a name below the server floor', async () => {
    expect(await resolvePublisherForSourceName('A', null)).toBeNull();
    expect(await resolvePublisherForSourceName('   ', null)).toBeNull();
    expect(mockSearchPublishers).not.toHaveBeenCalled();
  });

  it('caches a hit AND a miss for the session', async () => {
    ok([hit({ _id: 'cached' })]);
    await resolvePublisherForSourceName('Het Parool', 'NLD');
    await resolvePublisherForSourceName('het parool', 'NLD');
    expect(mockSearchPublishers).toHaveBeenCalledTimes(1);

    ok([]);
    expect(await resolvePublisherForSourceName('Unknown Paper', null)).toBeNull();
    expect(await resolvePublisherForSourceName('Unknown Paper', null)).toBeNull();
    expect(mockSearchPublishers).toHaveBeenCalledTimes(2);
  });

  it('returns null WITHOUT caching when the search itself fails', async () => {
    mockSearchPublishers.mockRejectedValueOnce(new Error('offline'));
    expect(await resolvePublisherForSourceName('Het Parool', 'NLD')).toBeNull();

    ok([hit({ _id: 'retry' })]);
    expect((await resolvePublisherForSourceName('Het Parool', 'NLD'))?.publisherId).toBe('retry');
    expect(mockSearchPublishers).toHaveBeenCalledTimes(2);
  });
});
