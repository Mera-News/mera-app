// hydrate-stores unit tests
// Mocks all store hydration methods and the pruneStaleVisits dependency.

const mockHydrateSuggestionsFromDb = jest.fn(() => Promise.resolve());
const mockHydrateMetadataFromDb = jest.fn(() => Promise.resolve());
const mockUserHydrateFromDb = jest.fn(() => Promise.resolve());
const mockMeraProtocolHydrateFromDb = jest.fn(() => Promise.resolve());
const mockOnboardingHydrateFromDb = jest.fn(() => Promise.resolve());
const mockAppLanguageHydrateFromDb = jest.fn(() => Promise.resolve());
const mockAppStateHydrateFromDb = jest.fn(() => Promise.resolve());
const mockForYouPrefsHydrate = jest.fn(() => Promise.resolve());
const mockBlurImagesHydrate = jest.fn(() => Promise.resolve());
const mockDisplayPrefsHydrate = jest.fn(() => Promise.resolve());
const mockImportanceFilterHydrate = jest.fn(() => Promise.resolve());
const mockRelatedSortHydrate = jest.fn(() => Promise.resolve());
const mockTextScaleHydrate = jest.fn(() => Promise.resolve());
const mockTutorialsHydrate = jest.fn(() => Promise.resolve());
const mockStartupTabHydrate = jest.fn(() => Promise.resolve());
const mockSetReady = jest.fn();

jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: {
    getState: jest.fn(() => ({
      hydrateSuggestionsFromDb: mockHydrateSuggestionsFromDb,
      hydrateMetadataFromDb: mockHydrateMetadataFromDb,
    })),
  },
}));

jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: {
    getState: jest.fn(() => ({
      hydrateFromDb: mockUserHydrateFromDb,
    })),
  },
}));

jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: jest.fn(() => ({
      hydrateFromDb: mockMeraProtocolHydrateFromDb,
    })),
  },
}));

jest.mock('@/lib/stores/onboarding-store', () => ({
  useOnboardingStore: {
    getState: jest.fn(() => ({
      hydrateFromDb: mockOnboardingHydrateFromDb,
    })),
  },
}));

jest.mock('@/lib/stores/app-language-store', () => ({
  useAppLanguageStore: {
    getState: jest.fn(() => ({
      hydrateFromDb: mockAppLanguageHydrateFromDb,
    })),
  },
}));

jest.mock('@/lib/stores/app-state-store', () => ({
  useAppStateStore: {
    getState: jest.fn(() => ({
      hydrateFromDb: mockAppStateHydrateFromDb,
    })),
  },
}));

jest.mock('@/lib/stores/for-you-prefs-store', () => ({
  useForYouPrefsStore: {
    getState: jest.fn(() => ({
      hydrate: mockForYouPrefsHydrate,
    })),
  },
}));

jest.mock('@/lib/stores/blur-images-store', () => ({
  useBlurImagesStore: {
    getState: jest.fn(() => ({
      hydrate: mockBlurImagesHydrate,
    })),
  },
}));

jest.mock('@/lib/stores/display-prefs-store', () => ({
  useDisplayPrefsStore: {
    getState: jest.fn(() => ({
      hydrate: mockDisplayPrefsHydrate,
    })),
  },
}));

jest.mock('@/lib/stores/importance-filter-store', () => ({
  useImportanceFilterStore: {
    getState: jest.fn(() => ({
      hydrate: mockImportanceFilterHydrate,
    })),
  },
}));

jest.mock('@/lib/stores/related-sort-store', () => ({
  useRelatedSortStore: {
    getState: jest.fn(() => ({
      hydrate: mockRelatedSortHydrate,
    })),
  },
}));

jest.mock('@/lib/stores/text-scale-store', () => ({
  useTextScaleStore: {
    getState: jest.fn(() => ({
      hydrate: mockTextScaleHydrate,
    })),
  },
}));

jest.mock('@/lib/stores/tutorials-store', () => ({
  useTutorialsStore: {
    getState: jest.fn(() => ({
      hydrate: mockTutorialsHydrate,
    })),
  },
}));

jest.mock('@/lib/stores/startup-tab-store', () => ({
  useStartupTabStore: {
    getState: jest.fn(() => ({
      hydrate: mockStartupTabHydrate,
    })),
  },
}));

jest.mock('@/lib/stores/database-store', () => ({
  useDatabaseStore: {
    getState: jest.fn(() => ({
      setReady: mockSetReady,
    })),
  },
}));

jest.mock('@/lib/database/services/publication-visit-service', () => ({
  pruneStaleVisits: jest.fn(() => Promise.resolve()),
}));

// Not a Zustand store, but it hydrates in the same Promise.all: a synchronous
// mirror of the backup preferences that the scheduler's custom condition reads.
// Unmocked it reaches the real setting-service, which opens SQLite at import
// and kills the worker rather than failing an assertion.
jest.mock('@/lib/backup/backup-settings', () => ({
  hydrateBackupSettings: jest.fn(() => Promise.resolve()),
}));

// The second non-store entry in that same Promise.all: the synchronous
// last-known-tier mirror that `feed-sync`'s scheduler condition reads. Mocked
// for the same reason as the one above — unmocked it reaches the real
// setting-service, which opens SQLite at import and kills the WORKER rather
// than failing an assertion, so the error names nothing useful.
const mockHydrateLastKnownTierMirror = jest.fn(() => Promise.resolve());
jest.mock('@/lib/subscription/free-tier-topic-access', () => ({
  hydrateLastKnownTierMirror: () => mockHydrateLastKnownTierMirror(),
}));

// Chained off the hydration above to reconcile the OS background task with the
// cadence. Unmocked it pulls in expo-background-task and sentry-init, which is
// a lot of graph for a suite about store hydration.
jest.mock('@/lib/background/backup-task', () => ({
  syncBackupTaskRegistration: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn() },
}));

import { hydrateAllStores } from '../hydrate-stores';
import { pruneStaleVisits } from '../services/publication-visit-service';
import logger from '@/lib/logger';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('hydrateAllStores', () => {
  it('fires paint-critical hydration without awaiting (fire-and-forget)', async () => {
    await hydrateAllStores();
    expect(mockHydrateSuggestionsFromDb).toHaveBeenCalledTimes(1);
  });

  it('hydrates all store state in parallel', async () => {
    await hydrateAllStores();
    expect(mockHydrateMetadataFromDb).toHaveBeenCalledTimes(1);
    expect(mockUserHydrateFromDb).toHaveBeenCalledTimes(1);
    expect(mockMeraProtocolHydrateFromDb).toHaveBeenCalledTimes(1);
    expect(mockOnboardingHydrateFromDb).toHaveBeenCalledTimes(1);
    expect(mockAppLanguageHydrateFromDb).toHaveBeenCalledTimes(1);
    expect(mockAppStateHydrateFromDb).toHaveBeenCalledTimes(1);
    expect(mockForYouPrefsHydrate).toHaveBeenCalledTimes(1);
    expect(mockBlurImagesHydrate).toHaveBeenCalledTimes(1);
    expect(mockDisplayPrefsHydrate).toHaveBeenCalledTimes(1);
    expect(mockImportanceFilterHydrate).toHaveBeenCalledTimes(1);
    expect(mockRelatedSortHydrate).toHaveBeenCalledTimes(1);
    expect(mockTextScaleHydrate).toHaveBeenCalledTimes(1);
    expect(mockTutorialsHydrate).toHaveBeenCalledTimes(1);
    expect(mockStartupTabHydrate).toHaveBeenCalledTimes(1);
  });

  it('calls pruneStaleVisits after hydration', async () => {
    await hydrateAllStores();
    expect(pruneStaleVisits).toHaveBeenCalledTimes(1);
  });

  it('calls setReady(true) even if pruneStaleVisits rejects', async () => {
    (pruneStaleVisits as jest.Mock).mockRejectedValueOnce(new Error('prune fail'));
    await hydrateAllStores();
    expect(mockSetReady).toHaveBeenCalledWith(true);
  });

  it('calls setReady(true) after successful hydration', async () => {
    await hydrateAllStores();
    expect(mockSetReady).toHaveBeenCalledWith(true);
  });

  it('calls setReady(true) via finally even when a store hydration fails', async () => {
    mockUserHydrateFromDb.mockRejectedValueOnce(new Error('user hydrate fail'));
    await expect(hydrateAllStores()).rejects.toThrow('user hydrate fail');
    expect(mockSetReady).toHaveBeenCalledWith(true);
  });

  // ── RD5: the last-known-tier mirror hydrates INSIDE the Promise.all ────────
  //
  // `feed-sync` reads that mirror from a SYNCHRONOUS scheduler condition, and
  // the only thing making that safe is this ordering: the mirror is populated
  // before `database-store.ready` flips, and `feed-sync` carries a `db-ready`
  // condition, so it cannot run against an empty mirror. Moving the hydrate
  // after the await would compile, pass every other test in this file, and
  // silently reopen the cold-start hole — which is exactly why it is pinned.

  it('hydrates the last-known-tier mirror', async () => {
    await hydrateAllStores();
    expect(mockHydrateLastKnownTierMirror).toHaveBeenCalledTimes(1);
  });

  it('does NOT flip ready until the tier mirror has resolved', async () => {
    let releaseMirror: () => void = () => undefined;
    mockHydrateLastKnownTierMirror.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseMirror = resolve;
      }),
    );

    const done = hydrateAllStores();
    // Let every other member of the Promise.all settle. If the mirror were
    // hydrated after the await (or not awaited at all), ready would be set by
    // now and this assertion would fail.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockSetReady).not.toHaveBeenCalled();

    releaseMirror();
    await done;
    expect(mockSetReady).toHaveBeenCalledWith(true);
  });

  it('returns a Promise resolving to undefined', async () => {
    const result = await hydrateAllStores();
    expect(result).toBeUndefined();
  });

  it('does not throw when paint-critical hydration fails', async () => {
    mockHydrateSuggestionsFromDb.mockRejectedValueOnce(new Error('paint fail'));
    await expect(hydrateAllStores()).resolves.toBeUndefined();
    expect(logger.captureException).toHaveBeenCalled();
  });

  it('captures exception when pruneStaleVisits throws', async () => {
    (pruneStaleVisits as jest.Mock).mockRejectedValueOnce(new Error('prune error'));
    await hydrateAllStores();
    expect(logger.captureException).toHaveBeenCalledTimes(1);
  });
});
