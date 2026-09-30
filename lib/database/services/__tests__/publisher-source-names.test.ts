// publisher-source-names: memory first, subscriptions second, never the
// network; an ambiguous name never expands to another publisher's names.

const mockGetActive = jest.fn(async () => [] as unknown[]);
jest.mock('../user-publication-subscription-service', () => ({
  getActive: () => mockGetActive(),
  parseSourceNames: (json: string | null | undefined) => {
    try {
      const v = JSON.parse(json ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  },
}));

import {
  __clearPublisherSourceNames,
  knownSourceNamesForName,
  knownSourceNamesForPublisher,
  rememberPublisherSourceNames,
  resolvePublicationPrefNames,
} from '../publisher-source-names';

beforeEach(() => {
  __clearPublisherSourceNames();
  mockGetActive.mockReset();
  mockGetActive.mockResolvedValue([]);
});

describe('memory', () => {
  it('records a publisher and finds it by any of its names', () => {
    rememberPublisherSourceNames('p1', ['Times of India', 'TOI Business', null]);
    expect(knownSourceNamesForPublisher('p1')).toEqual(['Times of India', 'TOI Business']);
    expect(knownSourceNamesForName('toi  business')).toEqual(['Times of India', 'TOI Business']);
  });

  it('a later record replaces the set, and dropped names stop resolving', () => {
    rememberPublisherSourceNames('p1', ['A', 'B']);
    rememberPublisherSourceNames('p1', ['A']);
    expect(knownSourceNamesForName('B')).toBeNull();
    rememberPublisherSourceNames('p1', []);
    expect(knownSourceNamesForPublisher('p1')).toBeNull();
  });

  it('a name owned by two publishers is ambiguous and resolves to nothing', () => {
    rememberPublisherSourceNames('p1', ['The Times', 'Times Sport']);
    rememberPublisherSourceNames('p2', ['The Times', 'Times Malta']);
    expect(knownSourceNamesForName('The Times')).toBeNull();
    expect(knownSourceNamesForName('Times Malta')).toEqual(['The Times', 'Times Malta']);
  });
});

describe('resolvePublicationPrefNames', () => {
  it('uses the caller sourceNames plus its hints, without reading subscriptions', async () => {
    const names = await resolvePublicationPrefNames({
      rawName: 'TOI',
      publisherName: 'Times of India',
      sourceNames: ['Times of India', 'TOI Business'],
    });
    expect(names).toEqual(['Times of India', 'TOI Business', 'TOI']);
    expect(mockGetActive).not.toHaveBeenCalled();
  });

  it('expands a card name from memory by publisher id or by name', async () => {
    rememberPublisherSourceNames('p1', ['Times of India', 'TOI Business']);
    await expect(resolvePublicationPrefNames({ publisherId: 'p1' })).resolves.toEqual(['Times of India', 'TOI Business']);
    await expect(resolvePublicationPrefNames({ rawName: 'TOI Business' })).resolves.toEqual([
      'Times of India',
      'TOI Business',
    ]);
  });

  it('falls back to a single matching subscription', async () => {
    mockGetActive.mockResolvedValue([
      { publisherId: 'p9', publisherName: 'Le Monde', sourceNamesJson: JSON.stringify(['le monde', 'le monde international']) },
    ]);
    await expect(resolvePublicationPrefNames({ rawName: 'Le Monde International' })).resolves.toEqual([
      'Le Monde International',
      'Le Monde',
    ]);
  });

  it('keeps only the hints when the subscriptions are ambiguous or unreadable', async () => {
    mockGetActive.mockResolvedValue([
      { publisherId: 'a', publisherName: 'X', sourceNamesJson: '["shared"]' },
      { publisherId: 'b', publisherName: 'Y', sourceNamesJson: '["shared"]' },
    ]);
    await expect(resolvePublicationPrefNames({ rawName: 'Shared' })).resolves.toEqual(['Shared']);
    mockGetActive.mockRejectedValue(new Error('db'));
    await expect(resolvePublicationPrefNames({ rawName: 'Solo' })).resolves.toEqual(['Solo']);
  });
});
