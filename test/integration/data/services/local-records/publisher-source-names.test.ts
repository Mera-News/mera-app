// publisher-source-names at its seam: the map is a memory mirror of ONE settings row
// (publisher_source_names_cache). Real settings service, real subscriptions service, real
// clearAllStores, real profile hook against MSW. Replaces
// lib/database/services/__tests__/publisher-source-names.test.ts, which mocked both services.
//
// Traps this file is the spec for: a publication has SEVERAL names; the map is never filled from
// searchPublishers (its matchingSources is the query-filtered subset); nothing is saved before
// hydratePublisherSourceNames() has run; clearAllStores must reset the memory so the next account's
// row never receives the previous account's publishers.
import { renderHook, waitFor } from '@testing-library/react-native';

import { clearAllStores } from '@/lib/stores';
import {
  __clearPublisherSourceNames,
  groupPrefRowsByPublication,
  hydratePublisherSourceNames,
  knownSourceNamesForName,
  knownSourceNamesForPublisher,
  persistPublisherSourceNames,
  PUBLISHER_SOURCE_NAMES_MAX,
  PUBLISHER_SOURCE_NAMES_SETTING,
  rememberPublisherSourceNames,
  resetPublisherSourceNames,
  resolvePublicationPrefNames,
} from '@/lib/database/services/publisher-source-names';
import * as settingService from '@/lib/database/services/setting-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { cancelSubscription, upsertSubscription } from '@/lib/database/services/user-publication-subscription-service';
import { usePublicationProfile } from '@/lib/publication-profile-service';
import SourceService from '@/lib/source-service';
import { articleFixtures } from '@/test/mock-backend/fixtures/articles';
import { publicationProfile } from '@/test/mock-backend/fixtures/graphql/publications';
import { initI18nEn, mockGql, server, useStrictClock } from '@/test/helpers';
import { failNextQuery, quietLogger, resetLocalRecordsMemory, restoreFaults, T0, track } from './support';

beforeEach(() => {
  resetLocalRecordsMemory();
  quietLogger();
});
afterEach(() => {
  restoreFaults();
  resetLocalRecordsMemory();
});

const KEY = PUBLISHER_SOURCE_NAMES_SETTING;
const savedRow = async () => {
  const raw = await getSetting(KEY);
  return raw ? (JSON.parse(raw) as { v: number; publishers: [string, string[]][] }) : null;
};
const seedRow = (publishers: unknown) => setSetting(KEY, JSON.stringify({ v: 1, publishers }));

describe('memory', () => {
  it('records a publisher and finds it by the publisher id or by any of its names, normalised', () => {
    rememberPublisherSourceNames('p1', ['Times of India', 'TOI Business', null]);
    expect(knownSourceNamesForPublisher('p1')).toEqual(['Times of India', 'TOI Business']);
    expect(knownSourceNamesForName('toi  business')).toEqual(['Times of India', 'TOI Business']);
    expect(knownSourceNamesForPublisher('nope')).toBeNull();
    expect(knownSourceNamesForName('nope')).toBeNull();
  });

  it('a later record replaces the set, dropped names stop resolving, and an empty set forgets the publisher', () => {
    rememberPublisherSourceNames('p1', ['A', 'B']);
    rememberPublisherSourceNames('p1', ['A']);
    expect(knownSourceNamesForName('B')).toBeNull();
    rememberPublisherSourceNames('p1', []);
    expect(knownSourceNamesForPublisher('p1')).toBeNull();
    expect(knownSourceNamesForName('A')).toBeNull();
  });

  it('a name owned by two publishers is ambiguous and resolves to nothing, while its siblings still resolve', () => {
    rememberPublisherSourceNames('p1', ['The Times', 'Times Sport']);
    rememberPublisherSourceNames('p2', ['The Times', 'Times Malta']);
    expect(knownSourceNamesForName('The Times')).toBeNull();
    expect(knownSourceNamesForName('Times Malta')).toEqual(['The Times', 'Times Malta']);
  });

  it('ignores a record without a publisher id', () => {
    rememberPublisherSourceNames('', ['A']);
    expect(knownSourceNamesForName('A')).toBeNull();
  });

  it('caps the map, dropping the least recently recorded publisher and its names first', () => {
    for (let i = 0; i < PUBLISHER_SOURCE_NAMES_MAX + 2; i++) rememberPublisherSourceNames(`p${i}`, [`N${i}`]);
    expect(knownSourceNamesForPublisher('p0')).toBeNull();
    expect(knownSourceNamesForName('N1')).toBeNull();
    expect(knownSourceNamesForPublisher('p2')).toEqual(['N2']);
    expect(knownSourceNamesForPublisher(`p${PUBLISHER_SOURCE_NAMES_MAX + 1}`)).toEqual([`N${PUBLISHER_SOURCE_NAMES_MAX + 1}`]);
  });

  it('re-recording a publisher makes it the most recent, so the cap drops another one', () => {
    for (let i = 0; i < PUBLISHER_SOURCE_NAMES_MAX; i++) rememberPublisherSourceNames(`p${i}`, [`N${i}`]);
    rememberPublisherSourceNames('p0', ['N0 renamed']);
    rememberPublisherSourceNames('extra', ['Extra']);
    expect(knownSourceNamesForPublisher('p0')).toEqual(['N0 renamed']);
    expect(knownSourceNamesForPublisher('p1')).toBeNull();
  });
});

describe('recording from the app', () => {
  it('the publication profile records the publisher full source set when it loads', async () => {
    await initI18nEn();
    server.use(
      mockGql('PublicationProfile', {
        publicationProfile: {
          ...publicationProfile,
          newsPublisherId: 'pub-toi',
          name: 'Times of India',
          displayName: 'Times of India',
          sourceNames: ['Times of India', 'TOI Business', 'TOI Sports'],
        },
      }),
    );

    const { result } = renderHook(() => usePublicationProfile({ publisherId: 'pub-toi' }));
    await waitFor(() => expect(result.current.state).toBe('ready'));

    expect(knownSourceNamesForPublisher('pub-toi')).toEqual(['Times of India', 'TOI Business', 'TOI Sports']);
    expect(knownSourceNamesForName('toi sports')).toEqual(['Times of India', 'TOI Business', 'TOI Sports']);
  });

  it('a publisher search never fills the map: its matchingSources is the subset that matched the query', async () => {
    const outlet = articleFixtures.publications[0];

    const result = await SourceService.searchPublishers({ query: outlet.name });

    expect(result.publishers.length).toBeGreaterThan(0);
    expect(knownSourceNamesForPublisher(outlet.publisherId)).toBeNull();
    expect(knownSourceNamesForName(outlet.name)).toBeNull();
  });
});

describe('resolvePublicationPrefNames', () => {
  it('orders the names: the caller source names, then the map, then the publisher name, then the raw name', async () => {
    rememberPublisherSourceNames('p1', ['M1', 'S1']);
    await expect(
      resolvePublicationPrefNames({ publisherId: 'p1', rawName: 'RN', publisherName: 'PN', sourceNames: ['S1'] }),
    ).resolves.toEqual(['S1', 'M1', 'PN', 'RN']);
  });

  it('uses the caller source names plus its hints, and never reads the subscriptions', async () => {
    await upsertSubscription({ publisherId: 'p9', publisherName: 'Times of India', countryCode: 'IND', sourceNames: ['Times of India', 'TOI Finance'] });

    const names = await resolvePublicationPrefNames({
      rawName: 'TOI',
      publisherName: 'Times of India',
      sourceNames: ['Times of India', 'TOI Business'],
    });

    expect(names).toEqual(['Times of India', 'TOI Business', 'TOI']);
  });

  it('expands a card name from the map, by publisher id or by any name', async () => {
    rememberPublisherSourceNames('p1', ['Times of India', 'TOI Business']);
    await expect(resolvePublicationPrefNames({ publisherId: 'p1' })).resolves.toEqual(['Times of India', 'TOI Business']);
    await expect(resolvePublicationPrefNames({ rawName: 'TOI Business' })).resolves.toEqual(['Times of India', 'TOI Business']);
    await expect(resolvePublicationPrefNames({ publisherName: 'times of india' })).resolves.toEqual(['Times of India', 'TOI Business']);
  });

  it('expands from the persisted map after a cold-start hydrate', async () => {
    await seedRow([['p9', ['Row Name', 'Row Alias']]]);
    await hydratePublisherSourceNames();

    await expect(resolvePublicationPrefNames({ rawName: 'row alias' })).resolves.toEqual(['Row Name', 'Row Alias']);
  });

  it('falls back to the one subscription that matches, using its stored source names', async () => {
    await upsertSubscription({
      publisherId: 'p9',
      publisherName: 'Le Monde',
      countryCode: 'FRA',
      sourceNames: ['le monde', 'le monde international'],
    });

    await expect(resolvePublicationPrefNames({ rawName: 'Le Monde International' })).resolves.toEqual([
      'Le Monde International',
      'Le Monde',
    ]);
  });

  it('matches the subscription by publisher id when no name matches', async () => {
    await upsertSubscription({ publisherId: 'p9', publisherName: 'Le Monde', countryCode: 'FRA', sourceNames: ['le monde afrique'] });

    await expect(resolvePublicationPrefNames({ publisherId: 'p9', rawName: 'Something Else' })).resolves.toEqual([
      'Something Else',
      'Le Monde',
      'le monde afrique',
    ]);
  });

  it('keeps only the hints when the matching subscriptions belong to more than one publisher', async () => {
    await upsertSubscription({ publisherId: 'a', publisherName: 'X', countryCode: 'GBR', sourceNames: ['shared'] });
    await upsertSubscription({ publisherId: 'b', publisherName: 'Y', countryCode: 'GBR', sourceNames: ['shared'] });

    await expect(resolvePublicationPrefNames({ rawName: 'Shared' })).resolves.toEqual(['Shared']);
  });

  it('keeps only the hints when the matching subscription is cancelled', async () => {
    const sub = await upsertSubscription({ publisherId: 'p9', publisherName: 'Le Monde', countryCode: 'FRA', sourceNames: ['le monde international'] });
    await cancelSubscription(sub.id);

    await expect(resolvePublicationPrefNames({ rawName: 'Le Monde International' })).resolves.toEqual(['Le Monde International']);
  });

  it('keeps only the hints when the subscriptions cannot be read', async () => {
    await upsertSubscription({ publisherId: 'p9', publisherName: 'Le Monde', countryCode: 'FRA', sourceNames: ['solo'] });
    failNextQuery('user_publication_subscriptions');

    await expect(resolvePublicationPrefNames({ rawName: 'Solo' })).resolves.toEqual(['Solo']);
  });

  it('always includes the hints themselves for a publication nothing knows', async () => {
    await expect(resolvePublicationPrefNames({ rawName: '  Unknown Gazette ', publisherName: null })).resolves.toEqual(['Unknown Gazette']);
    await expect(resolvePublicationPrefNames({})).resolves.toEqual([]);
  });
});

describe('persistence (cold start)', () => {
  it('saves nothing before hydration, however long it waits and however it is asked', async () => {
    useStrictClock(T0);
    rememberPublisherSourceNames('p1', ['A']);
    await jest.advanceTimersByTimeAsync(5000);
    await persistPublisherSourceNames();

    expect(await getSetting(KEY)).toBeNull();
  });

  it('hydrates the row, lets a newer in-memory entry win, then saves both (older rows first)', async () => {
    await seedRow([
      ['p1', ['Old Name']],
      ['p2', ['Le Monde', 'Le Monde Afrique']],
    ]);
    rememberPublisherSourceNames('p1', ['New Name']);

    await hydratePublisherSourceNames();

    expect(knownSourceNamesForPublisher('p1')).toEqual(['New Name']);
    expect(knownSourceNamesForName('le monde afrique')).toEqual(['Le Monde', 'Le Monde Afrique']);
    expect(knownSourceNamesForName('Old Name')).toBeNull();
    await persistPublisherSourceNames();
    expect(await savedRow()).toEqual({
      v: 1,
      publishers: [
        ['p2', ['Le Monde', 'Le Monde Afrique']],
        ['p1', ['New Name']],
      ],
    });
  });

  it('a record after hydration is saved once, one second after the first change; an unchanged record is not saved', async () => {
    useStrictClock(T0);
    const save = track(jest.spyOn(settingService, 'setSetting'));
    await hydratePublisherSourceNames();

    rememberPublisherSourceNames('p1', ['A']);
    await jest.advanceTimersByTimeAsync(500);
    rememberPublisherSourceNames('p2', ['B']);
    await jest.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    await save.mock.results[0].value;
    expect(await savedRow()).toEqual({ v: 1, publishers: [['p1', ['A']], ['p2', ['B']]] });

    rememberPublisherSourceNames('p2', ['B']);
    await jest.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a changed record after a save is saved again', async () => {
    useStrictClock(T0);
    const save = track(jest.spyOn(settingService, 'setSetting'));
    await hydratePublisherSourceNames();
    rememberPublisherSourceNames('p1', ['A']);
    await jest.advanceTimersByTimeAsync(1000);
    await save.mock.results[0].value;

    rememberPublisherSourceNames('p1', ['A', 'A2']);
    await jest.advanceTimersByTimeAsync(1000);
    await save.mock.results[1].value;

    expect(save).toHaveBeenCalledTimes(2);
    expect((await savedRow())?.publishers).toEqual([['p1', ['A', 'A2']]]);
  });

  it('saves at most PUBLISHER_SOURCE_NAMES_MAX publishers, the most recently recorded', async () => {
    useStrictClock(T0);
    const save = track(jest.spyOn(settingService, 'setSetting'));
    await hydratePublisherSourceNames();
    for (let i = 0; i < PUBLISHER_SOURCE_NAMES_MAX + 2; i++) rememberPublisherSourceNames(`p${i}`, [`N${i}`]);

    await jest.advanceTimersByTimeAsync(1000);
    await save.mock.results[0].value;

    const row = await savedRow();
    expect(row?.publishers).toHaveLength(PUBLISHER_SOURCE_NAMES_MAX);
    expect(row?.publishers[0][0]).toBe('p2');
    expect(row?.publishers[PUBLISHER_SOURCE_NAMES_MAX - 1][0]).toBe(`p${PUBLISHER_SOURCE_NAMES_MAX + 1}`);
  });

  it('hydrating a row that holds more than the cap keeps the most recent entries', async () => {
    await seedRow(Array.from({ length: PUBLISHER_SOURCE_NAMES_MAX + 2 }, (_, i) => [`p${i}`, [`N${i}`]]));

    await hydratePublisherSourceNames();

    expect(knownSourceNamesForPublisher('p0')).toBeNull();
    expect(knownSourceNamesForPublisher('p1')).toBeNull();
    expect(knownSourceNamesForPublisher('p2')).toEqual(['N2']);
  });

  it('a corrupt, mis-versioned or partly malformed row loads what it can and never throws', async () => {
    await setSetting(KEY, '{nope');
    await expect(hydratePublisherSourceNames()).resolves.toBeUndefined();
    expect(knownSourceNamesForPublisher('p1')).toBeNull();

    await setSetting(KEY, JSON.stringify({ v: 2, publishers: [['p1', ['A']]] }));
    await expect(hydratePublisherSourceNames()).resolves.toBeUndefined();
    expect(knownSourceNamesForPublisher('p1')).toBeNull();

    await seedRow([['p1', ['A']], 'junk', ['', ['x']], ['p2', []], ['p3', 'not-an-array'], [5, ['y']], ['p4', ['  ', null]]]);
    await hydratePublisherSourceNames();
    expect(knownSourceNamesForPublisher('p1')).toEqual(['A']);
    for (const id of ['p2', 'p3', 'p4']) expect(knownSourceNamesForPublisher(id)).toBeNull();
  });

  it('a failing read loads nothing, never throws, and still starts saving', async () => {
    await seedRow([['p1', ['A']]]);
    failNextQuery('settings');

    await expect(hydratePublisherSourceNames()).resolves.toBeUndefined();
    expect(knownSourceNamesForPublisher('p1')).toBeNull();

    rememberPublisherSourceNames('p2', ['B']);
    await persistPublisherSourceNames();
    expect((await savedRow())?.publishers).toEqual([['p2', ['B']]]);
  });

  it('a failing save is retried on the next persist', async () => {
    await hydratePublisherSourceNames();
    rememberPublisherSourceNames('p1', ['A']);
    track(jest.spyOn(settingService, 'setSetting').mockRejectedValueOnce(new Error('disk full')));

    await persistPublisherSourceNames();
    expect(await getSetting(KEY)).toBeNull();

    await persistPublisherSourceNames();
    expect((await savedRow())?.publishers).toEqual([['p1', ['A']]]);
  });

  it('clearAllStores forgets the previous account: its publishers never reach the next account row', async () => {
    await hydratePublisherSourceNames();
    rememberPublisherSourceNames('p1', ['Previous Reader Paper']);
    await persistPublisherSourceNames();
    expect((await savedRow())?.publishers).toEqual([['p1', ['Previous Reader Paper']]]);

    await clearAllStores();

    expect(await getSetting(KEY)).toBeNull();
    expect(knownSourceNamesForPublisher('p1')).toBeNull();
    expect(knownSourceNamesForName('Previous Reader Paper')).toBeNull();

    rememberPublisherSourceNames('p2', ['Next Reader Paper']);
    await persistPublisherSourceNames();
    expect(await getSetting(KEY)).toBeNull();

    await hydratePublisherSourceNames();
    await persistPublisherSourceNames();
    expect((await savedRow())?.publishers).toEqual([['p2', ['Next Reader Paper']]]);
  });

  it('a reset stops a pending debounced save', async () => {
    useStrictClock(T0);
    await hydratePublisherSourceNames();
    rememberPublisherSourceNames('p1', ['A']);

    resetPublisherSourceNames();
    await jest.advanceTimersByTimeAsync(5000);

    expect(await getSetting(KEY)).toBeNull();
  });

  it('__clearPublisherSourceNames is the same reset', () => {
    expect(__clearPublisherSourceNames).toBe(resetPublisherSourceNames);
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
    await seedRow([['p1', ['A', 'A Business']]]);
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

  it('groups rows of an unknown publisher by normalised name only, keeping the first spelling', () => {
    const groups = groupPrefRowsByPublication([row('Le  Monde'), row('le monde')]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'name:le monde', publisherId: null, names: ['Le  Monde'] });
    expect(groups[0].rows).toHaveLength(2);
  });

  it('country-scope rows are always their own group with no names', () => {
    rememberPublisherSourceNames('p1', ['India']);

    const groups = groupPrefRowsByPublication([row('India', 0.5, 'country'), row('India', 0.5, 'country')]);

    expect(groups.map((g) => [g.key, g.names])).toEqual([
      ['scope:0', []],
      ['scope:1', []],
    ]);
  });

  it('keeps groups in the order their first row appears, and is empty for no rows', () => {
    expect(groupPrefRowsByPublication([])).toEqual([]);
    expect(groupPrefRowsByPublication([row('B'), row('A'), row('B')]).map((g) => g.key)).toEqual(['name:b', 'name:a']);
  });
});
