// ──────────────────────────────────────────────────────────────────────────────
// Mock all DB-service seams BEFORE any imports
// ──────────────────────────────────────────────────────────────────────────────

const mockGetSetting = jest.fn((_k: string) => Promise.resolve(null as string | null));
const mockSetSetting = jest.fn(() => Promise.resolve());
const mockDeleteSetting = jest.fn(() => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => mockGetSetting(k),
    setSetting: (k: string, v: string) => mockSetSetting(k, v),
    deleteSetting: (k: string) => mockDeleteSetting(k),
}));

const mockPersistUserPersona = jest.fn(() => Promise.resolve());
const mockLoadUserPersona = jest.fn(() => Promise.resolve(null));
const mockClearUserPersona = jest.fn(() => Promise.resolve());

jest.mock('@/lib/database/services/user-persona-service', () => ({
    persistUserPersona: (userId: string, persona: unknown) => mockPersistUserPersona(userId, persona),
    loadUserPersona: (userId: string) => mockLoadUserPersona(userId),
    clearUserPersona: () => mockClearUserPersona(),
}));

const mockGetUserPersona = jest.fn();
jest.mock('@/lib/account-service', () => ({
    AccountService: {
        getUserPersona: (userId: string) => mockGetUserPersona(userId),
    },
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

import { useUserStore } from '../user-store';
import logger from '@/lib/logger';
import type { UserPersona } from '@/lib/account-service';
import { OnboardingStage, ProcessingMode } from '@/lib/generated/graphql-types';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makePersona(overrides: Partial<UserPersona> = {}): UserPersona {
    return {
        _id: 'persona-1',
        userId: 'user-1',
        userTopics: [],
        preferredNotificationWindow: [9, 18],
        notificationsEnabled: true,
        expoPushToken: null,
        onboardingStage: OnboardingStage.Finished,
        blockedByLlm: false,
        blockedByLlmReason: null,
        language_codes: null,
        processingMode: ProcessingMode.Cloud,
        llmWarningCount: 0,
        lastSuccessfulCompletedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

const resetState = {
    userId: null as string | null,
    userPersona: null as UserPersona | null,
    isLoading: false,
    lastFetchedAt: null as number | null,
};

describe('useUserStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Use partial setState (no replace flag) to preserve action functions
        useUserStore.setState({ ...resetState });
    });

    // ── initial state ────────────────────────────────────────────────────────

    it('starts with null userId and persona', () => {
        const state = useUserStore.getState();
        expect(state.userId).toBeNull();
        expect(state.userPersona).toBeNull();
        expect(state.isLoading).toBe(false);
        expect(state.lastFetchedAt).toBeNull();
    });

    // ── setUserId ────────────────────────────────────────────────────────────

    it('setUserId with non-null value updates state and persists to DB', async () => {
        useUserStore.getState().setUserId('user-abc');

        expect(useUserStore.getState().userId).toBe('user-abc');
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenCalledWith('cached_user_id', 'user-abc');
    });

    it('setUserId with null deletes from DB', async () => {
        useUserStore.getState().setUserId(null);

        expect(useUserStore.getState().userId).toBeNull();
        await Promise.resolve();
        expect(mockDeleteSetting).toHaveBeenCalledWith('cached_user_id');
    });

    it('setUserId swallows DB errors silently', async () => {
        mockSetSetting.mockRejectedValueOnce(new Error('db'));
        useUserStore.getState().setUserId('user-xyz');
        await new Promise((r) => setImmediate(r));
        expect(useUserStore.getState().userId).toBe('user-xyz');
    });

    // ── setUserPersona ────────────────────────────────────────────────────────

    it('setUserPersona updates state and sets lastFetchedAt', async () => {
        const before = Date.now();
        const persona = makePersona();
        useUserStore.setState({ userId: 'user-1' });
        useUserStore.getState().setUserPersona(persona);

        const state = useUserStore.getState();
        expect(state.userPersona).toEqual(persona);
        expect(state.lastFetchedAt).toBeGreaterThanOrEqual(before);
    });

    it('setUserPersona persists persona to DB when userId is set', async () => {
        useUserStore.setState({ userId: 'user-1' });
        const persona = makePersona();
        useUserStore.getState().setUserPersona(persona);

        await Promise.resolve();
        expect(mockPersistUserPersona).toHaveBeenCalledWith('user-1', persona);
    });

    it('setUserPersona does NOT persist when userId is null', async () => {
        useUserStore.setState({ userId: null });
        useUserStore.getState().setUserPersona(makePersona());
        await Promise.resolve();
        expect(mockPersistUserPersona).not.toHaveBeenCalled();
    });

    it('setUserPersona does NOT persist when persona is null', async () => {
        useUserStore.setState({ userId: 'user-1' });
        useUserStore.getState().setUserPersona(null);
        await Promise.resolve();
        expect(mockPersistUserPersona).not.toHaveBeenCalled();
    });

    it('setUserPersona swallows persist errors silently', async () => {
        mockPersistUserPersona.mockRejectedValueOnce(new Error('db'));
        useUserStore.setState({ userId: 'user-1' });
        useUserStore.getState().setUserPersona(makePersona());
        await new Promise((r) => setImmediate(r));
        // No throw
        expect(useUserStore.getState().userPersona).not.toBeNull();
    });

    // ── fetchUserPersona ──────────────────────────────────────────────────────

    it('fetchUserPersona returns null for empty userId', async () => {
        const result = await useUserStore.getState().fetchUserPersona('');
        expect(result).toBeNull();
        expect(mockGetUserPersona).not.toHaveBeenCalled();
    });

    it('fetchUserPersona fetches persona and updates state', async () => {
        const persona = makePersona();
        mockGetUserPersona.mockResolvedValueOnce(persona);

        const result = await useUserStore.getState().fetchUserPersona('user-1');

        expect(result).toEqual(persona);
        const state = useUserStore.getState();
        expect(state.userPersona).toEqual(persona);
        expect(state.isLoading).toBe(false);
        expect(state.lastFetchedAt).not.toBeNull();
    });

    it('fetchUserPersona persists persona after fetch', async () => {
        const persona = makePersona();
        mockGetUserPersona.mockResolvedValueOnce(persona);

        await useUserStore.getState().fetchUserPersona('user-1');

        await Promise.resolve();
        expect(mockPersistUserPersona).toHaveBeenCalledWith('user-1', persona);
    });

    it('fetchUserPersona returns cached persona within 5 minutes (cache hit)', async () => {
        const persona = makePersona();
        const recentFetch = Date.now() - 1000; // 1 second ago — within 5-min window
        useUserStore.setState({
            userId: 'user-1',
            userPersona: persona,
            lastFetchedAt: recentFetch,
        });

        const result = await useUserStore.getState().fetchUserPersona('user-1');

        expect(result).toEqual(persona);
        expect(mockGetUserPersona).not.toHaveBeenCalled();
    });

    it('fetchUserPersona bypasses cache when force=true', async () => {
        const oldPersona = makePersona({ _id: 'old' });
        const newPersona = makePersona({ _id: 'new' });
        useUserStore.setState({
            userId: 'user-1',
            userPersona: oldPersona,
            lastFetchedAt: Date.now() - 1000,
        });
        mockGetUserPersona.mockResolvedValueOnce(newPersona);

        const result = await useUserStore.getState().fetchUserPersona('user-1', true);

        expect(result).toEqual(newPersona);
        expect(mockGetUserPersona).toHaveBeenCalledWith('user-1');
    });

    it('fetchUserPersona re-fetches when cache is older than 5 minutes', async () => {
        const oldPersona = makePersona({ _id: 'old' });
        const newPersona = makePersona({ _id: 'new' });
        const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
        useUserStore.setState({
            userId: 'user-1',
            userPersona: oldPersona,
            lastFetchedAt: sixMinutesAgo,
        });
        mockGetUserPersona.mockResolvedValueOnce(newPersona);

        const result = await useUserStore.getState().fetchUserPersona('user-1');

        expect(result).toEqual(newPersona);
        expect(mockGetUserPersona).toHaveBeenCalled();
    });

    it('fetchUserPersona returns current persona when already loading same userId', async () => {
        const persona = makePersona();
        useUserStore.setState({
            userId: 'user-1',
            userPersona: persona,
            isLoading: true,
        });

        const result = await useUserStore.getState().fetchUserPersona('user-1');

        expect(result).toEqual(persona);
        expect(mockGetUserPersona).not.toHaveBeenCalled();
    });

    it('fetchUserPersona returns null for different userId when already loading', async () => {
        const persona = makePersona({ userId: 'user-1' });
        useUserStore.setState({
            userId: 'user-1',
            userPersona: persona,
            isLoading: true,
        });

        // Called with different userId — not deduplicated
        mockGetUserPersona.mockResolvedValueOnce(null);
        const result = await useUserStore.getState().fetchUserPersona('user-2');

        expect(mockGetUserPersona).toHaveBeenCalledWith('user-2');
        expect(result).toBeNull();
    });

    it('fetchUserPersona handles null persona from server gracefully', async () => {
        mockGetUserPersona.mockResolvedValueOnce(null);

        const result = await useUserStore.getState().fetchUserPersona('user-1');

        expect(result).toBeNull();
        const state = useUserStore.getState();
        expect(state.userPersona).toBeNull();
        expect(state.isLoading).toBe(false);
        expect(mockPersistUserPersona).not.toHaveBeenCalled();
    });

    it('fetchUserPersona logs and returns null on AccountService error', async () => {
        mockGetUserPersona.mockRejectedValueOnce(new Error('network error'));

        const result = await useUserStore.getState().fetchUserPersona('user-1');

        expect(result).toBeNull();
        expect(useUserStore.getState().isLoading).toBe(false);
        expect(logger.captureException).toHaveBeenCalled();
    });

    it('fetchUserPersona logs info when persona has notificationsEnabled', async () => {
        const persona = makePersona({ notificationsEnabled: true });
        mockGetUserPersona.mockResolvedValueOnce(persona);

        await useUserStore.getState().fetchUserPersona('user-1');

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('notificationsEnabled=true'),
        );
    });

    it('fetchUserPersona does not bypass cache when userId changed but lastFetchedAt is fresh', async () => {
        // Cache valid for user-1; fetching for user-2 should NOT use cache (different userId)
        const persona = makePersona({ userId: 'user-1' });
        useUserStore.setState({
            userId: 'user-1',
            userPersona: persona,
            lastFetchedAt: Date.now() - 1000, // fresh
        });

        const newPersona = makePersona({ _id: 'new', userId: 'user-2' });
        mockGetUserPersona.mockResolvedValueOnce(newPersona);

        const result = await useUserStore.getState().fetchUserPersona('user-2');

        expect(result).toEqual(newPersona);
        expect(mockGetUserPersona).toHaveBeenCalledWith('user-2');
    });

    // ── clearUser ─────────────────────────────────────────────────────────────

    it('clearUser resets all fields to null/false and clears DB', async () => {
        useUserStore.setState({
            userId: 'user-1',
            userPersona: makePersona(),
            isLoading: true,
            lastFetchedAt: Date.now(),
        });

        useUserStore.getState().clearUser();

        const state = useUserStore.getState();
        expect(state.userId).toBeNull();
        expect(state.userPersona).toBeNull();
        expect(state.isLoading).toBe(false);
        expect(state.lastFetchedAt).toBeNull();

        await new Promise((r) => setImmediate(r));
        expect(mockClearUserPersona).toHaveBeenCalledTimes(1);
        expect(mockDeleteSetting).toHaveBeenCalledWith('cached_user_id');
        expect(mockDeleteSetting).toHaveBeenCalledWith('cached_user_email');
    });

    it('clearUser swallows DB errors silently', async () => {
        mockClearUserPersona.mockRejectedValueOnce(new Error('db'));
        mockDeleteSetting.mockRejectedValueOnce(new Error('db'));
        useUserStore.getState().clearUser();
        await new Promise((r) => setImmediate(r));
        // No throw
        expect(useUserStore.getState().userId).toBeNull();
    });

    // ── hydrateFromDb ─────────────────────────────────────────────────────────

    it('hydrateFromDb does nothing when no cached_user_id', async () => {
        mockGetSetting.mockResolvedValueOnce(null);
        await useUserStore.getState().hydrateFromDb();
        expect(useUserStore.getState().userId).toBeNull();
        expect(mockLoadUserPersona).not.toHaveBeenCalled();
    });

    it('hydrateFromDb sets userId and persona from DB', async () => {
        mockGetSetting.mockResolvedValueOnce('user-42');
        const persona = makePersona({ userId: 'user-42' });
        mockLoadUserPersona.mockResolvedValueOnce(persona);

        await useUserStore.getState().hydrateFromDb();

        const state = useUserStore.getState();
        expect(state.userId).toBe('user-42');
        expect(state.userPersona).toEqual(persona);
        expect(state.lastFetchedAt).toBeNull(); // DB cache forces re-fetch on next access
    });

    it('hydrateFromDb sets only userId when persona is not in DB', async () => {
        mockGetSetting.mockResolvedValueOnce('user-99');
        mockLoadUserPersona.mockResolvedValueOnce(null);

        await useUserStore.getState().hydrateFromDb();

        const state = useUserStore.getState();
        expect(state.userId).toBe('user-99');
        expect(state.userPersona).toBeNull();
    });

    it('hydrateFromDb logs info when persona is hydrated', async () => {
        mockGetSetting.mockResolvedValueOnce('user-1');
        const persona = makePersona({ notificationsEnabled: false });
        mockLoadUserPersona.mockResolvedValueOnce(persona);

        await useUserStore.getState().hydrateFromDb();

        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining('persona hydrated'),
        );
    });

    it('hydrateFromDb logs warning and leaves state unchanged on failure', async () => {
        mockGetSetting.mockRejectedValueOnce(new Error('db crash'));

        await useUserStore.getState().hydrateFromDb();

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('hydrateFromDb failed'),
            expect.anything(),
        );
        expect(useUserStore.getState().userId).toBeNull();
    });

    it('hydrateFromDb sets lastFetchedAt to null (forces re-fetch)', async () => {
        mockGetSetting.mockResolvedValueOnce('user-1');
        mockLoadUserPersona.mockResolvedValueOnce(makePersona());

        await useUserStore.getState().hydrateFromDb();

        expect(useUserStore.getState().lastFetchedAt).toBeNull();
    });

    // ── catch callback coverage ───────────────────────────────────────────────
    // These cover the fire-and-forget .catch(() => {}) lambdas counted by Istanbul.

    it('setUserId swallows deleteSetting errors silently', async () => {
        mockDeleteSetting.mockRejectedValueOnce(new Error('storage'));
        useUserStore.getState().setUserId(null);
        await new Promise((r) => setImmediate(r));
        // No throw
        expect(useUserStore.getState().userId).toBeNull();
    });

    it('setUserPersona swallows persistUserPersona catch silently', async () => {
        mockPersistUserPersona.mockRejectedValueOnce(new Error('persist fail'));
        useUserStore.setState({ userId: 'user-1' });
        useUserStore.getState().setUserPersona(makePersona());
        await new Promise((r) => setImmediate(r));
        // No throw — .catch(() => {}) fires
        expect(useUserStore.getState().userPersona).not.toBeNull();
    });

    it('clearUser swallows all cleanup errors silently (multiple .catch lambdas)', async () => {
        mockClearUserPersona.mockRejectedValueOnce(new Error('db1'));
        mockDeleteSetting
            .mockRejectedValueOnce(new Error('db2'))
            .mockRejectedValueOnce(new Error('db3'));
        useUserStore.setState({
            userId: 'user-1',
            userPersona: makePersona(),
        });
        useUserStore.getState().clearUser();
        await new Promise((r) => setImmediate(r));
        // All .catch(() => {}) callbacks executed; no throw
        expect(useUserStore.getState().userId).toBeNull();
    });
});
