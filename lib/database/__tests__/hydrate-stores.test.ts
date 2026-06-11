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
