// ──────────────────────────────────────────────────────────────────────────────
// Mock all seams BEFORE importing the module under test
// ──────────────────────────────────────────────────────────────────────────────

const mockUpdateUserConfig = jest.fn((..._args: any[]) => Promise.resolve({}));
jest.mock('@/lib/account-service', () => ({
    AccountService: {
        updateUserConfig: (...args: any[]) => mockUpdateUserConfig(...args),
    },
}));

// Mutable fake user-store state; getState() returns this object.
const mockUserState: any = {
    userId: null as string | null,
    userPersona: null as any,
    fetchUserPersona: jest.fn((..._args: any[]) => Promise.resolve(null)),
    setUserPersona: jest.fn((p: any) => {
        mockUserState.userPersona = p;
    }),
};
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: { getState: () => mockUserState },
}));

// app-language-store is lazily require()d inside reconcile.
let mockAppLanguage = 'en';
jest.mock('@/lib/stores/app-language-store', () => ({
    useAppLanguageStore: { getState: () => ({ appLanguage: mockAppLanguage }) },
}));

const mockWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { warn: (...a: any[]) => mockWarn(...a) },
}));

import {
    mergePrimaryLanguage,
    syncAppLanguageToPersona,
    reconcileAppLanguageWithPersona,
} from '../language-sync';

function resetUserState() {
    mockUserState.userId = null;
    mockUserState.userPersona = null;
    mockUserState.fetchUserPersona.mockReset().mockResolvedValue(null);
    mockUserState.setUserPersona.mockClear();
}

describe('mergePrimaryLanguage', () => {
    it('prepends the language as primary, preserving the rest', () => {
        expect(mergePrimaryLanguage('fr', ['en', 'de'])).toEqual(['fr', 'en', 'de']);
    });

    it('is a no-op ordering when already primary', () => {
        expect(mergePrimaryLanguage('en', ['en', 'de'])).toEqual(['en', 'de']);
    });

    it('moves an existing non-primary code to the front without duplicating', () => {
        expect(mergePrimaryLanguage('de', ['en', 'de'])).toEqual(['de', 'en']);
    });

    it('handles an empty existing array', () => {
        expect(mergePrimaryLanguage('fr', [])).toEqual(['fr']);
    });
});

describe('syncAppLanguageToPersona', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resetUserState();
        mockAppLanguage = 'en';
    });

    it('sets the picked language as primary and preserves existing codes', async () => {
        mockUserState.userId = 'u1';
        mockUserState.userPersona = { _id: 'p1', language_codes: ['en', 'de'] };

        await syncAppLanguageToPersona('fr');

        expect(mockUpdateUserConfig).toHaveBeenCalledWith('u1', {
            language_codes: ['fr', 'en', 'de'],
        });
        // local persona reflects the merge, keeping other fields
        expect(mockUserState.setUserPersona).toHaveBeenCalledWith({
            _id: 'p1',
            language_codes: ['fr', 'en', 'de'],
        });
    });

    it('does nothing when the language is already primary', async () => {
        mockUserState.userId = 'u1';
        mockUserState.userPersona = { _id: 'p1', language_codes: ['fr', 'en'] };

        await syncAppLanguageToPersona('fr');

        expect(mockUpdateUserConfig).not.toHaveBeenCalled();
        expect(mockUserState.setUserPersona).not.toHaveBeenCalled();
    });

    it('skips entirely when there is no logged-in user', async () => {
        mockUserState.userId = null;

        await syncAppLanguageToPersona('fr');

        expect(mockUpdateUserConfig).not.toHaveBeenCalled();
        expect(mockUserState.fetchUserPersona).not.toHaveBeenCalled();
    });

    it('uses an explicit userId and fetches the persona when not cached', async () => {
        mockUserState.userId = null; // store not settled yet
        mockUserState.fetchUserPersona.mockResolvedValue({
            _id: 'p9',
            language_codes: ['en'],
        });

        await syncAppLanguageToPersona('de', { userId: 'u9' });

        expect(mockUserState.fetchUserPersona).toHaveBeenCalledWith('u9');
        expect(mockUpdateUserConfig).toHaveBeenCalledWith('u9', {
            language_codes: ['de', 'en'],
        });
    });

    it('treats a user with no language_codes as an empty array', async () => {
        mockUserState.userId = 'u1';
        mockUserState.userPersona = { _id: 'p1' }; // no language_codes

        await syncAppLanguageToPersona('es');

        expect(mockUpdateUserConfig).toHaveBeenCalledWith('u1', {
            language_codes: ['es'],
        });
    });

    it('never throws and logs when the server update fails', async () => {
        mockUserState.userId = 'u1';
        mockUserState.userPersona = { _id: 'p1', language_codes: ['en'] };
        mockUpdateUserConfig.mockRejectedValueOnce(new Error('network'));

        await expect(syncAppLanguageToPersona('fr')).resolves.toBeUndefined();
        expect(mockWarn).toHaveBeenCalled();
    });
});

describe('reconcileAppLanguageWithPersona', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resetUserState();
        mockAppLanguage = 'en';
    });

    it('syncs when the persona primary differs from the app language', async () => {
        mockAppLanguage = 'fr';
        mockUserState.userId = 'u1';
        mockUserState.userPersona = { _id: 'p1', language_codes: ['en'] };

        await reconcileAppLanguageWithPersona();

        expect(mockUpdateUserConfig).toHaveBeenCalledWith('u1', {
            language_codes: ['fr', 'en'],
        });
    });

    it('does nothing when the persona primary already matches', async () => {
        mockAppLanguage = 'en';
        mockUserState.userId = 'u1';
        mockUserState.userPersona = { _id: 'p1', language_codes: ['en', 'de'] };

        await reconcileAppLanguageWithPersona();

        expect(mockUpdateUserConfig).not.toHaveBeenCalled();
    });

    it('skips when there is no logged-in user', async () => {
        mockAppLanguage = 'fr';
        mockUserState.userId = null;

        await reconcileAppLanguageWithPersona();

        expect(mockUpdateUserConfig).not.toHaveBeenCalled();
    });

    it('accepts an explicit userId (onboarding) and syncs on mismatch', async () => {
        mockAppLanguage = 'de';
        mockUserState.userId = null;
        mockUserState.fetchUserPersona.mockResolvedValue({
            _id: 'p2',
            language_codes: ['en'],
        });

        await reconcileAppLanguageWithPersona({ userId: 'u2' });

        expect(mockUpdateUserConfig).toHaveBeenCalledWith('u2', {
            language_codes: ['de', 'en'],
        });
    });
});
