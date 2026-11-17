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

import {
  __clearPublisherSourceNames,
  knownSourceNamesForName,
  knownSourceNamesForPublisher,
} from '@/lib/database/services/publisher-source-names';
import { __resetPublicationProfileSession, usePublicationProfile } from '@/lib/publication-profile-service';
import SourceService from '@/lib/source-service';
import { articleFixtures } from '@/test/mock-backend/fixtures/articles';
import { publicationProfile } from '@/test/mock-backend/fixtures/graphql/publications';
import { initI18nEn, mockGql, server } from '@/test/helpers';
import { quietLogger, resetLocalRecordsMemory, restoreFaults } from './support';

beforeEach(() => {
  resetLocalRecordsMemory();
  __resetPublicationProfileSession();
  quietLogger();
});
afterEach(() => {
  restoreFaults();
  resetLocalRecordsMemory();
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

    const { result } = await renderHook(() => usePublicationProfile({ publisherId: 'pub-toi' }));
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
