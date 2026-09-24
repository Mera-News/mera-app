// use-feed-bootstrap.test.ts — renderHook tests for lib/hooks/use-feed-bootstrap.ts
//
// Covers the r6 P3 empty-state fix: a transient persona-fetch failure must NOT
// overwrite the persisted `hasGeneratedTopics` flag (that was the root cause of
// the "Mera cannot analyze news for you" false-empty state), while a genuinely
// successful persona fetch — regardless of what it returns — is authoritative,
// since `hasGeneratedTopics` is now derived from the on-device topics table
// (topic-decouple A1) rather than the retired server userTopics linkage.
//
// jest.mock() factories are hoisted above imports/consts, so every factory below
// only references either (a) values it creates inline, or (b) lazy wrappers
// (arrow functions) that resolve the real mock fn at call time — never a
// top-level const referenced directly inside the factory body.

const mockSetHasGeneratedTopics = jest.fn();
jest.mock('@/lib/stores/selectors', () => ({
  getForYouActions: () => ({
    setHasGeneratedTopics: (...args: unknown[]) => mockSetHasGeneratedTopics(...args),
  }),
}));

// Selector-shaped: the hook now reads the LOCAL identity via
// `useUserStore((s) => s.userId)` as well as destructuring the actions off a
// bare call, so the mock has to honour both call shapes. `mockLocalUserIdRef`
// is a lazy ref for the same hoisting reason as the others above.
const mockFetchUserPersonaOrThrow = jest.fn();
const mockLocalUserIdRef = { current: 'user-1' as string | null };
jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      userId: mockLocalUserIdRef.current,
      fetchUserPersonaOrThrow: (...args: unknown[]) => mockFetchUserPersonaOrThrow(...args),
    };
    return selector ? selector(state) : state;
  },
}));

const mockGetActive = jest.fn();
jest.mock('@/lib/database/services/topic-service', () => ({
  getActive: (...args: unknown[]) => mockGetActive(...args),
}));

const mockHydrate = jest.fn(() => Promise.resolve());
jest.mock('@/lib/stores/opened-stories-store', () => ({
  useOpenedStoriesStore: { getState: () => ({ hydrate: () => mockHydrate() }) },
}));

// Real zustand store so the hook's `useForYouStore((s) => s.hasGeneratedTopics)`
// selector subscription and `.getState()` reads behave exactly as in production,
// without pulling in the real for-you-store's WatermelonDB dependencies.
jest.mock('@/lib/stores/for-you-store', () => {
  const { create } = require('zustand');
  const useForYouStore = create(() => ({
    suggestions: [] as unknown[],
    hasGeneratedTopics: true,
  }));
  return { useForYouStore };
});

const mockSessionRef = { current: { user: { id: 'user-1' } } as { user: { id: string } } | null };
jest.mock('@/lib/auth-client', () => ({
  authClient: {
    useSession: () => ({ data: mockSessionRef.current }),
  },
}));

const mockIsFocusedRef = { current: true };
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockIsFocusedRef.current,
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

import { renderHook, waitFor } from '@testing-library/react-native';
import { useFeedBootstrap } from '../use-feed-bootstrap';
import { useForYouStore } from '@/lib/stores/for-you-store';

function setForYouState(partial: { suggestions?: unknown[]; hasGeneratedTopics?: boolean }) {
  useForYouStore.setState(partial as never);
}

describe('useFeedBootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSessionRef.current = { user: { id: 'user-1' } };
    mockLocalUserIdRef.current = 'user-1';
    mockIsFocusedRef.current = true;
    setForYouState({ suggestions: [], hasGeneratedTopics: true });
    mockFetchUserPersonaOrThrow.mockReset();
    mockGetActive.mockReset();
    mockGetActive.mockResolvedValue([]);
  });

  it('confirmed-empty: a successful fetch with zero local topics sets hasGeneratedTopics false', async () => {
    setForYouState({ suggestions: [], hasGeneratedTopics: true });
    mockFetchUserPersonaOrThrow.mockResolvedValueOnce({ _id: 'persona-1' });
    mockGetActive.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useFeedBootstrap());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockFetchUserPersonaOrThrow).toHaveBeenCalledWith('user-1');
    expect(mockGetActive).toHaveBeenCalled();
    expect(mockSetHasGeneratedTopics).toHaveBeenCalledWith(false);
    expect(result.current.errorMessage).toBeNull();
  });

  it('confirmed-non-empty: a successful fetch with local topics sets hasGeneratedTopics true', async () => {
    setForYouState({ suggestions: [], hasGeneratedTopics: false });
    mockFetchUserPersonaOrThrow.mockResolvedValueOnce({ _id: 'persona-1' });
    mockGetActive.mockResolvedValueOnce([{ id: 't1' }]);

    const { result } = renderHook(() => useFeedBootstrap());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockSetHasGeneratedTopics).toHaveBeenCalledWith(true);
  });

  it('local topics decide the flag even when the persona fetch resolves null', async () => {
    setForYouState({ suggestions: [], hasGeneratedTopics: false });
    mockFetchUserPersonaOrThrow.mockResolvedValueOnce(null);
    mockGetActive.mockResolvedValueOnce([{ id: 't1' }]);

    const { result } = renderHook(() => useFeedBootstrap());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockSetHasGeneratedTopics).toHaveBeenCalledWith(true);
  });

  it('error path: leaves hasGeneratedTopics untouched and sets errorMessage', async () => {
    setForYouState({ suggestions: [], hasGeneratedTopics: true });
    mockFetchUserPersonaOrThrow.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useFeedBootstrap());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockSetHasGeneratedTopics).not.toHaveBeenCalled();
    expect(result.current.errorMessage).toBe('errors.feedError');
  });

  it('error path: a network error sets the network-specific error message', async () => {
    setForYouState({ suggestions: [], hasGeneratedTopics: true });
    const networkError = Object.assign(new Error('Network request failed'), {
      networkError: true,
    });
    mockFetchUserPersonaOrThrow.mockRejectedValueOnce(networkError);

    const { result } = renderHook(() => useFeedBootstrap());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockSetHasGeneratedTopics).not.toHaveBeenCalled();
    expect(result.current.errorMessage).toBe('errors.networkError');
  });

  it('flag-false with non-empty suggestions does not fetch while unfocused, but refetches on focus', async () => {
    mockIsFocusedRef.current = false;
    setForYouState({ suggestions: [{ id: 'a' }], hasGeneratedTopics: false });
    mockFetchUserPersonaOrThrow.mockResolvedValue({ _id: 'persona-1' });
    mockGetActive.mockResolvedValue([{ id: 't1' }]);

    const { result, rerender } = renderHook(() => useFeedBootstrap());

    // Give any microtasks a chance to run — nothing should have fired yet.
    await Promise.resolve();
    expect(mockFetchUserPersonaOrThrow).not.toHaveBeenCalled();

    mockIsFocusedRef.current = true;
    rerender(undefined);

    await waitFor(() => expect(mockFetchUserPersonaOrThrow).toHaveBeenCalledWith('user-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockSetHasGeneratedTopics).toHaveBeenCalledWith(true);
  });

  it('does not fetch when suggestions are non-empty and hasGeneratedTopics is already true', async () => {
    setForYouState({ suggestions: [{ id: 'a' }], hasGeneratedTopics: true });

    renderHook(() => useFeedBootstrap());

    await Promise.resolve();
    expect(mockFetchUserPersonaOrThrow).not.toHaveBeenCalled();
  });

  it('does not fetch when there is no identity at all — neither local nor session', async () => {
    mockSessionRef.current = null;
    mockLocalUserIdRef.current = null;
    setForYouState({ suggestions: [], hasGeneratedTopics: true });

    renderHook(() => useFeedBootstrap());

    await Promise.resolve();
    expect(mockFetchUserPersonaOrThrow).not.toHaveBeenCalled();
  });

  // Offline / keychain-locked wake / 401 blip: the server session is gone but
  // the user never logged out. The bootstrap must still run off the persisted
  // id — otherwise hasGeneratedTopics is never derived and the feed sits on its
  // "Mera cannot analyze news for you" empty state for a signed-in user.
  it('bootstraps off the LOCAL id when the session cannot be fetched', async () => {
    mockSessionRef.current = null;
    mockLocalUserIdRef.current = 'user-1';
    setForYouState({ suggestions: [], hasGeneratedTopics: false });
    mockFetchUserPersonaOrThrow.mockResolvedValueOnce({ _id: 'persona-1' });
    mockGetActive.mockResolvedValueOnce([{ id: 't1' }]);

    const { result } = renderHook(() => useFeedBootstrap());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockFetchUserPersonaOrThrow).toHaveBeenCalledWith('user-1');
    expect(mockSetHasGeneratedTopics).toHaveBeenCalledWith(true);
  });

  it('hydrates the opened-stories store on mount and on refocus', async () => {
    setForYouState({ suggestions: [{ id: 'a' }], hasGeneratedTopics: true });
    mockIsFocusedRef.current = true;

    const { rerender } = renderHook(() => useFeedBootstrap());
    await Promise.resolve();
    expect(mockHydrate).toHaveBeenCalledTimes(2); // mount effect + focus effect (both true on mount)

    mockIsFocusedRef.current = false;
    rerender(undefined);
    mockIsFocusedRef.current = true;
    rerender(undefined);
    await Promise.resolve();
    expect(mockHydrate.mock.calls.length).toBeGreaterThan(2);
  });

  // S2: the effect re-runs on focus, so its cleanup fires on BLUR as well as on
  // unmount. A blur mid-fetch used to drop both the store write and
  // setIsLoading(false), leaving the tab on a spinner that the refocus early
  // return never cleared.
  describe('blur is not unmount', () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    it('a blur mid-fetch still clears isLoading and writes the flag', async () => {
      setForYouState({ suggestions: [], hasGeneratedTopics: false });
      const fetch = deferred<unknown>();
      mockFetchUserPersonaOrThrow.mockReturnValueOnce(fetch.promise);
      mockGetActive.mockResolvedValueOnce([{ id: 't1' }]);

      const { result, rerender } = renderHook(() => useFeedBootstrap());
      await waitFor(() => expect(result.current.isLoading).toBe(true));

      mockIsFocusedRef.current = false;
      rerender(undefined);
      fetch.resolve({ _id: 'persona-1' });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(mockSetHasGeneratedTopics).toHaveBeenCalledWith(true);
    });

    it('a blur mid-fetch still surfaces the error message', async () => {
      setForYouState({ suggestions: [], hasGeneratedTopics: false });
      const fetch = deferred<unknown>();
      mockFetchUserPersonaOrThrow.mockReturnValueOnce(
        fetch.promise.then(() => {
          throw new Error('boom');
        }),
      );

      const { result, rerender } = renderHook(() => useFeedBootstrap());
      await waitFor(() => expect(result.current.isLoading).toBe(true));

      mockIsFocusedRef.current = false;
      rerender(undefined);
      fetch.resolve(null);

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.errorMessage).toBe('errors.feedError');
    });

    it('a user switch mid-fetch does not write the previous user flag', async () => {
      setForYouState({ suggestions: [], hasGeneratedTopics: false });
      const fetch = deferred<unknown>();
      mockFetchUserPersonaOrThrow.mockReturnValueOnce(fetch.promise);
      mockFetchUserPersonaOrThrow.mockResolvedValue({ _id: 'persona-2' });
      mockGetActive.mockResolvedValue([{ id: 't1' }]);

      const { result, rerender } = renderHook(() => useFeedBootstrap());
      await waitFor(() => expect(result.current.isLoading).toBe(true));

      mockLocalUserIdRef.current = 'user-2';
      mockSessionRef.current = { user: { id: 'user-2' } };
      rerender(undefined);
      fetch.resolve({ _id: 'persona-1' });

      // The first run settles without writing; user-2 then bootstraps itself.
      await waitFor(() => expect(mockFetchUserPersonaOrThrow).toHaveBeenCalledWith('user-2'));
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(mockSetHasGeneratedTopics).toHaveBeenCalledTimes(1);
    });

    it('a session-only user (no local id) still gets the flag written', async () => {
      mockLocalUserIdRef.current = null;
      mockSessionRef.current = { user: { id: 'user-1' } };
      setForYouState({ suggestions: [], hasGeneratedTopics: false });
      mockFetchUserPersonaOrThrow.mockResolvedValueOnce({ _id: 'persona-1' });
      mockGetActive.mockResolvedValueOnce([{ id: 't1' }]);

      const { result } = renderHook(() => useFeedBootstrap());

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(mockSetHasGeneratedTopics).toHaveBeenCalledWith(true);
    });
  });
});
