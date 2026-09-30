// publication-profile-service: the hook over injected ports (no Apollo, no DB,
// no NetInfo), plus the default fetch port's contract with Apollo.

const mockQuery = jest.fn();
jest.mock('@/lib/apollo-client', () => ({
  __esModule: true,
  default: { query: (...a: unknown[]) => mockQuery(...a) },
}));
jest.mock('@/lib/publication-display-service', () => ({
  serverLocaleFor: (l: string) => (l === 'pt' ? 'pt-BR' : l),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), addBreadcrumb: jest.fn(), captureException: jest.fn() },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'fr' } }) }));

import { renderHook, act, waitFor } from '@testing-library/react-native';
import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { print } from 'graphql';
import {
  __resetPublicationProfileSession,
  fetchPublicationProfile,
  makeUsePublicationProfile,
  profileVariables,
  PublicationProfileUnsupportedError,
  toPublicationProfile,
  type PublicationProfile,
  type PublicationProfileKey,
  type PublicationProfilePorts,
} from '../publication-profile-service';
import {
  __clearPublisherSourceNames,
  knownSourceNamesForPublisher,
} from '@/lib/database/services/publisher-source-names';

const PROFILE: PublicationProfile = {
  newsPublisherId: 'p1',
  name: 'Times of India',
  displayName: 'Times of India',
  homepageUrl: 'https://timesofindia.indiatimes.com',
  publicationType: 'newspaper',
  categories: ['general'],
  languages: ['en'],
  isOfficial: false,
  countryCode: 'IND',
  countryName: 'India',
  sourceNames: ['Times of India', 'TOI Business'],
  subscriptionUri: null,
};

function makePorts(overrides: Partial<PublicationProfilePorts> = {}) {
  let reconnect: (() => void) | null = null;
  const ports: PublicationProfilePorts = {
    fetch: jest.fn(async () => PROFILE),
    isOffline: jest.fn(() => false),
    onReconnect: jest.fn((l: () => void) => {
      reconnect = l;
      return () => {
        reconnect = null;
      };
    }),
    ...overrides,
  };
  return { ports, fireReconnect: () => reconnect?.() };
}

beforeEach(() => {
  __resetPublicationProfileSession();
  __clearPublisherSourceNames();
  mockQuery.mockReset();
});

describe('usePublicationProfile', () => {
  it('loads by publisher id, is ready, and records the source names', async () => {
    const { ports } = makePorts();
    const use = makeUsePublicationProfile(ports);
    const { result } = renderHook(() => use({ publisherId: 'p1' }));
    expect(result.current.state).toBe('loading');
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.profile).toEqual(PROFILE);
    expect(ports.fetch).toHaveBeenCalledWith({ publisherId: 'p1' }, 'fr');
    expect(knownSourceNamesForPublisher('p1')).toEqual(['Times of India', 'TOI Business']);
  });

  it('loads by trimmed name + country', async () => {
    const { ports } = makePorts();
    const use = makeUsePublicationProfile(ports);
    const { result } = renderHook(() => use({ rawName: ' Times of India ', countryCode: 'IND' }));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(ports.fetch).toHaveBeenCalledWith({ rawName: 'Times of India', countryCode: 'IND' }, 'fr');
  });

  it('a null answer is notFound; an empty key is notFound without a request', async () => {
    const { ports } = makePorts({ fetch: jest.fn(async () => null) });
    const use = makeUsePublicationProfile(ports);
    const a = renderHook(() => use({ rawName: 'Nobody', countryCode: 'XXX' }));
    await waitFor(() => expect(a.result.current.state).toBe('notFound'));
    const b = renderHook(() => use({ rawName: '  ', countryCode: null }));
    await waitFor(() => expect(b.result.current.state).toBe('notFound'));
    expect(ports.fetch).toHaveBeenCalledTimes(1);
  });

  it('offline is decided before asking, and is left when the link returns', async () => {
    let offline = true;
    const { ports, fireReconnect } = makePorts({ isOffline: jest.fn(() => offline) });
    const use = makeUsePublicationProfile(ports);
    const { result } = renderHook(() => use({ publisherId: 'p1' }));
    await waitFor(() => expect(result.current.state).toBe('offline'));
    expect(ports.fetch).not.toHaveBeenCalled();
    offline = false;
    act(() => fireReconnect());
    await waitFor(() => expect(result.current.state).toBe('ready'));
  });

  it('a failure is error (or offline when the link dropped meanwhile), and retry asks again', async () => {
    const fetch = jest.fn().mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(PROFILE);
    const { ports } = makePorts({ fetch });
    const use = makeUsePublicationProfile(ports);
    const { result } = renderHook(() => use({ publisherId: 'p1' }));
    await waitFor(() => expect(result.current.state).toBe('error'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state).toBe('ready'));

    let offline = false;
    const { ports: p2 } = makePorts({
      fetch: jest.fn(async () => {
        offline = true;
        throw new Error('network');
      }),
      isOffline: jest.fn(() => offline),
    });
    const r2 = renderHook(() => makeUsePublicationProfile(p2)({ publisherId: 'p1' }));
    await waitFor(() => expect(r2.result.current.state).toBe('offline'));
  });

  it('unsupported lasts for the session: later keys never ask', async () => {
    const { ports } = makePorts({ fetch: jest.fn(async () => Promise.reject(new PublicationProfileUnsupportedError())) });
    const use = makeUsePublicationProfile(ports);
    const a = renderHook(() => use({ publisherId: 'p1' }));
    await waitFor(() => expect(a.result.current.state).toBe('unsupported'));
    const b = renderHook(() => use({ rawName: 'Other', countryCode: 'FRA' }));
    await waitFor(() => expect(b.result.current.state).toBe('unsupported'));
    expect(ports.fetch).toHaveBeenCalledTimes(1);
  });

  it('a stale answer for a previous key never lands', async () => {
    let resolveFirst: (p: PublicationProfile) => void = () => {};
    const fetch = jest
      .fn()
      .mockImplementationOnce(() => new Promise<PublicationProfile>((r) => (resolveFirst = r)))
      .mockResolvedValueOnce({ ...PROFILE, newsPublisherId: 'p2', name: 'Second' });
    const { ports } = makePorts({ fetch });
    const use = makeUsePublicationProfile(ports);
    const { result, rerender } = renderHook((key: PublicationProfileKey) => use(key), {
      initialProps: { publisherId: 'p1' },
    });
    rerender({ publisherId: 'p2' });
    await waitFor(() => expect(result.current.profile?.name).toBe('Second'));
    await act(async () => resolveFirst(PROFILE));
    expect(result.current.profile?.name).toBe('Second');
  });
});

describe('profileVariables', () => {
  it('sends exactly one key mode', () => {
    expect(profileVariables({ publisherId: 'p1' }, 'fr')).toEqual({ newsPublisherId: 'p1', language: 'fr' });
    expect(profileVariables({ rawName: 'Le Monde', countryCode: 'FRA' }, 'fr')).toEqual({
      name: 'Le Monde',
      countryCode: 'FRA',
      language: 'fr',
    });
    expect(profileVariables({ rawName: 'Le Monde', countryCode: null }, 'fr')).toEqual({ name: 'Le Monde', language: 'fr' });
  });
});

describe('toPublicationProfile', () => {
  it('a row missing its id or name is not a profile', () => {
    expect(toPublicationProfile({ name: 'x' })).toBeNull();
    expect(toPublicationProfile(null)).toBeNull();
  });
  it('normalizes absent optional fields', () => {
    expect(toPublicationProfile({ newsPublisherId: 'p', name: 'N' })).toEqual({
      newsPublisherId: 'p',
      name: 'N',
      displayName: null,
      homepageUrl: null,
      publicationType: null,
      categories: [],
      languages: [],
      isOfficial: false,
      countryCode: '',
      countryName: null,
      sourceNames: [],
      subscriptionUri: null,
    });
  });
});

describe('fetchPublicationProfile (the default port)', () => {
  it('queries no-cache, off the sync banner, tolerating validation failures, with the server locale', async () => {
    mockQuery.mockResolvedValueOnce({ data: { publicationProfile: PROFILE } });
    await expect(fetchPublicationProfile({ publisherId: 'p1' }, 'pt')).resolves.toEqual(PROFILE);
    const opts = mockQuery.mock.calls[0][0];
    expect(print(opts.query)).toContain('subscriptionUri');
    expect(opts.fetchPolicy).toBe('no-cache');
    expect(opts.context).toEqual({ noSyncStatus: true, expectedErrorCodes: ['GRAPHQL_VALIDATION_FAILED'] });
    expect(opts.variables).toEqual({ newsPublisherId: 'p1', language: 'pt-BR' });
  });

  it('maps GRAPHQL_VALIDATION_FAILED to unsupported and rethrows anything else', async () => {
    mockQuery.mockRejectedValueOnce(
      new CombinedGraphQLErrors({ data: null, errors: [{ message: 'x', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }),
    );
    await expect(fetchPublicationProfile({ publisherId: 'p1' }, 'en')).rejects.toBeInstanceOf(
      PublicationProfileUnsupportedError,
    );
    mockQuery.mockRejectedValueOnce(new Error('boom'));
    await expect(fetchPublicationProfile({ publisherId: 'p1' }, 'en')).rejects.toThrow('boom');
  });
});
