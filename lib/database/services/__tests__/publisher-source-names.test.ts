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

const mockSettings = new Map<string, string>();
const mockGetSetting = jest.fn(async (k: string) => mockSettings.get(k) ?? null);
const mockSetSetting = jest.fn(async (k: string, v: string) => {
  mockSettings.set(k, v);
});
jest.mock('../setting-service', () => ({
  getSetting: (k: string) => mockGetSetting(k),
  setSetting: (k: string, v: string) => mockSetSetting(k, v),
}));

import {
  groupPrefRowsByPublication,
  hydratePublisherSourceNames,
  persistPublisherSourceNames,
  PUBLISHER_SOURCE_NAMES_MAX,
  PUBLISHER_SOURCE_NAMES_SETTING,
  resetPublisherSourceNames,
  __clearPublisherSourceNames,
  knownSourceNamesForName,
  knownSourceNamesForPublisher,
  rememberPublisherSourceNames,
  resolvePublicationPrefNames,
} from '../publisher-source-names';

beforeEach(() => {
  __clearPublisherSourceNames();
  mockSettings.clear();
  mockGetSetting.mockClear();
  mockSetSetting.mockClear();
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

describe('persistence (cold start)', () => {
  it('saves nothing before hydration, so a test or an early record never touches the DB', async () => {
    jest.useFakeTimers();
    try {
      rememberPublisherSourceNames('p1', ['A']);
      jest.advanceTimersByTime(5000);
      await persistPublisherSourceNames();
      expect(mockSetSetting).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('hydrates the row, keeps newer memory entries, then saves both', async () => {
    mockSettings.set(
      PUBLISHER_SOURCE_NAMES_SETTING,
      JSON.stringify({ v: 1, publishers: [['p1', ['Old Name']], ['p2', ['Le Monde', 'Le Monde Afrique']]] }),
    );
    rememberPublisherSourceNames('p1', ['New Name']);
    await hydratePublisherSourceNames();
    expect(knownSourceNamesForPublisher('p1')).toEqual(['New Name']);
    expect(knownSourceNamesForName('le monde afrique')).toEqual(['Le Monde', 'Le Monde Afrique']);
    await persistPublisherSourceNames();
    const saved = JSON.parse(mockSettings.get(PUBLISHER_SOURCE_NAMES_SETTING) ?? '{}');
    expect(saved).toEqual({ v: 1, publishers: [['p2', ['Le Monde', 'Le Monde Afrique']], ['p1', ['New Name']]] });
  });

  it('a record after hydration is saved once, debounced; an unchanged record is not', async () => {
    jest.useFakeTimers();
    try {
      await hydratePublisherSourceNames();
      rememberPublisherSourceNames('p1', ['A']);
      rememberPublisherSourceNames('p2', ['B']);
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      rememberPublisherSourceNames('p2', ['B']);
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      expect(mockSetSetting).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a reset (account switch) forgets the previous account and saves nothing until the next hydrate', async () => {
    await hydratePublisherSourceNames();
    rememberPublisherSourceNames('p1', ['Previous Reader Paper']);
    await persistPublisherSourceNames();
    mockSettings.clear(); // the database reset takes the row
    mockSetSetting.mockClear();

    resetPublisherSourceNames();
    rememberPublisherSourceNames('p2', ['Next Reader Paper']);
    await persistPublisherSourceNames();
    expect(mockSetSetting).not.toHaveBeenCalled();
    expect(knownSourceNamesForPublisher('p1')).toBeNull();

    await hydratePublisherSourceNames();
    await persistPublisherSourceNames();
    const saved = JSON.parse(mockSettings.get(PUBLISHER_SOURCE_NAMES_SETTING) ?? '{}');
    expect(saved.publishers).toEqual([['p2', ['Next Reader Paper']]]);
  });

  it('a corrupt row loads as empty and never throws', async () => {
    mockSettings.set(PUBLISHER_SOURCE_NAMES_SETTING, '{nope');
    await expect(hydratePublisherSourceNames()).resolves.toBeUndefined();
    mockGetSetting.mockRejectedValueOnce(new Error('db'));
    await expect(hydratePublisherSourceNames()).resolves.toBeUndefined();
  });

  it('caps the map, dropping the least recently recorded publisher', async () => {
    for (let i = 0; i < PUBLISHER_SOURCE_NAMES_MAX + 2; i++) rememberPublisherSourceNames(`p${i}`, [`N${i}`]);
    expect(knownSourceNamesForPublisher('p0')).toBeNull();
    expect(knownSourceNamesForName('N1')).toBeNull();
    expect(knownSourceNamesForPublisher(`p${PUBLISHER_SOURCE_NAMES_MAX + 1}`)).toEqual([`N${PUBLISHER_SOURCE_NAMES_MAX + 1}`]);
  });
});

describe('groupPrefRowsByPublication', () => {
  const row = (publicationName: string, weight = -0.5, scopeKind: string | null = null) => ({
    publicationName,
    weight,
    scopeKind,
    status: 'active',
  });

  it('one publication written under several names is one group carrying every known name', () => {
    rememberPublisherSourceNames('p1', ['Times of India', 'TOI Business', 'TOI Sports']);
    const rows = [row('Times of India'), row('Le Monde'), row('toi business')];
    const groups = groupPrefRowsByPublication(rows);
    expect(groups.map((g) => g.key)).toEqual(['publisher:p1', 'name:le monde']);
    expect(groups[0].publisherId).toBe('p1');
    expect(groups[0].rows).toEqual([rows[0], rows[2]]);
    expect(groups[0].names).toEqual(['Times of India', 'TOI Business', 'TOI Sports']);
    expect(groups[1]).toEqual({ key: 'name:le monde', publisherId: null, names: ['Le Monde'], rows: [rows[1]] });
  });

  it('works on a cold start from the hydrated row alone', async () => {
    mockSettings.set(PUBLISHER_SOURCE_NAMES_SETTING, JSON.stringify({ v: 1, publishers: [['p1', ['A', 'A Business']]] }));
    await hydratePublisherSourceNames();
    const groups = groupPrefRowsByPublication([row('A Business'), row('A')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].names).toEqual(['A Business', 'A']);
  });

  it('an ambiguous name never joins a publisher group', () => {
    rememberPublisherSourceNames('p1', ['The Times', 'Times Sport']);
    rememberPublisherSourceNames('p2', ['The Times', 'Times Malta']);
    const groups = groupPrefRowsByPublication([row('The Times'), row('Times Sport')]);
    expect(groups.map((g) => g.key)).toEqual(['name:the times', 'publisher:p1']);
  });

  it('country-scope rows are always their own group with no names', () => {
    rememberPublisherSourceNames('p1', ['India']);
    const groups = groupPrefRowsByPublication([row('India', 0.5, 'country'), row('India', 0.5, 'country')]);
    expect(groups.map((g) => [g.key, g.names])).toEqual([
      ['scope:0', []],
      ['scope:1', []],
    ]);
  });
});
