// identity-gate tests.
//
// resolveIdentity is pure and import-free, so it needs no mocks. The
// ownership-fault backstop lazy-requires the settings service, the user store
// and the logger — mock all three at the module seam.

const mockSetSetting = jest.fn(async (_k: string, _v: string) => {});
const mockDeleteSetting = jest.fn(async (_k: string) => {});
const mockGetSetting = jest.fn(async (_k: string): Promise<string | null> => null);
jest.mock('@/lib/database/services/setting-service', () => ({
    setSetting: (k: string, v: string) => mockSetSetting(k, v),
    deleteSetting: (k: string) => mockDeleteSetting(k),
    getSetting: (k: string) => mockGetSetting(k),
}));

const mockSetNeedsReauth = jest.fn();
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: { getState: () => ({ setNeedsReauth: mockSetNeedsReauth }) },
}));

const mockCaptureMessage = jest.fn();
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureMessage: (...a: any[]) => mockCaptureMessage(...a) },
}));

import {
    IDENTITY_FAULT_KEY,
    __resetIdentityFaultForTests,
    clearIdentityFault,
    hasIdentityFault,
    isOwnershipFault,
    recordOwnershipFault,
    resolveIdentity,
} from '../identity-gate';

beforeEach(() => {
    jest.clearAllMocks();
    __resetIdentityFaultForTests();
    mockGetSetting.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// resolveIdentity
// ---------------------------------------------------------------------------

describe('resolveIdentity', () => {
    it('coherent: session and cached owner are the same user', () => {
        expect(resolveIdentity({ sessionUserId: 'A', cachedUserId: 'A' })).toBe('coherent');
    });

    it('wipeAndProceed: session belongs to a different user than the on-device data', () => {
        expect(resolveIdentity({ sessionUserId: 'B', cachedUserId: 'A' })).toBe('wipeAndProceed');
    });

    it('wipeAndProceed: signed in with nothing stamped yet (fresh login)', () => {
        expect(resolveIdentity({ sessionUserId: 'B', cachedUserId: null })).toBe('wipeAndProceed');
    });

    it('reauth: an observed ownership fault, ids agreeing', () => {
        expect(
            resolveIdentity({ sessionUserId: 'A', cachedUserId: 'A', ownershipFault: true }),
        ).toBe('reauth');
    });

    // Ordering guard: the fault check MUST precede the id comparison. If a
    // future edit inverts them, a fault with mismatched ids would be silently
    // "fixed" by a local wipe the server has already contradicted.
    it('reauth wins over wipeAndProceed when a fault coincides with mismatched ids', () => {
        expect(
            resolveIdentity({ sessionUserId: 'B', cachedUserId: 'A', ownershipFault: true }),
        ).toBe('reauth');
    });

    it('never ejects a confirmed-offline device, even with a fault', () => {
        expect(
            resolveIdentity({
                sessionUserId: 'A',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: false,
            }),
        ).toBe('coherent');
    });

    it('treats unknown connectivity as online (acts on the fault)', () => {
        expect(
            resolveIdentity({
                sessionUserId: 'A',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: undefined,
            }),
        ).toBe('reauth');
    });

    it('coherent: no live session is the OFFLINE path, not a fault', () => {
        expect(resolveIdentity({ sessionUserId: null, cachedUserId: 'A' })).toBe('coherent');
        expect(resolveIdentity({ sessionUserId: undefined, cachedUserId: 'A' })).toBe('coherent');
    });

    it('coherent: no identity at all', () => {
        expect(resolveIdentity({})).toBe('coherent');
    });
});

// ---------------------------------------------------------------------------
// isOwnershipFault — the exact server error match
// ---------------------------------------------------------------------------

describe('isOwnershipFault', () => {
    const OWNERSHIP = {
        message: 'Access denied: resource belongs to another user',
        extensions: { code: 'FORBIDDEN', statusCode: 403 },
    };

    it('matches the server ownership rejection', () => {
        expect(isOwnershipFault(OWNERSHIP)).toBe(true);
    });

    it('matches on statusCode 403 even if the code is missing', () => {
        expect(
            isOwnershipFault({ message: OWNERSHIP.message, extensions: { statusCode: 403 } }),
        ).toBe(true);
    });

    it('does NOT match a different FORBIDDEN error (code alone is too broad)', () => {
        expect(
            isOwnershipFault({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } }),
        ).toBe(false);
    });

    it('does not match other error codes carrying a similar message', () => {
        expect(
            isOwnershipFault({
                message: OWNERSHIP.message,
                extensions: { code: 'INTERNAL_SERVER_ERROR' },
            }),
        ).toBe(false);
    });

    it('does not match UNAUTHENTICATED / PAYMENT_REQUIRED', () => {
        expect(isOwnershipFault({ message: 'x', extensions: { code: 'UNAUTHENTICATED' } })).toBe(false);
        expect(isOwnershipFault({ message: 'x', extensions: { code: 'PAYMENT_REQUIRED' } })).toBe(false);
    });

    it('tolerates missing/empty input', () => {
        expect(isOwnershipFault(null)).toBe(false);
        expect(isOwnershipFault(undefined)).toBe(false);
        expect(isOwnershipFault({})).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// recordOwnershipFault — loop guard + recovery flow
// ---------------------------------------------------------------------------

describe('recordOwnershipFault', () => {
    it('flips needsReauth, persists the marker and logs ONE Sentry message', () => {
        recordOwnershipFault({ operationName: 'ArticleIdsForPersona' });

        expect(mockSetNeedsReauth).toHaveBeenCalledTimes(1);
        expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
        expect(mockSetSetting).toHaveBeenCalledWith(IDENTITY_FAULT_KEY, '1');
        expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
        expect(mockCaptureMessage.mock.calls[0][1]).toMatchObject({
            tags: { source: 'identity-gate' },
        });
    });

    it('is idempotent per app session — a second fault does not re-trigger', () => {
        recordOwnershipFault({ operationName: 'A' });
        recordOwnershipFault({ operationName: 'B' });
        recordOwnershipFault({ operationName: 'C' });

        expect(mockSetNeedsReauth).toHaveBeenCalledTimes(1);
        expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
        expect(mockSetSetting).toHaveBeenCalledTimes(1);
    });

    it('re-arms after the fault is cleared', async () => {
        recordOwnershipFault();
        await clearIdentityFault();
        recordOwnershipFault();

        expect(mockSetNeedsReauth).toHaveBeenCalledTimes(2);
    });
});

describe('hasIdentityFault / clearIdentityFault', () => {
    it('reports a persisted fault', async () => {
        mockGetSetting.mockResolvedValue('1');
        await expect(hasIdentityFault()).resolves.toBe(true);
        expect(mockGetSetting).toHaveBeenCalledWith(IDENTITY_FAULT_KEY);
    });

    it('reports no fault when the marker is absent or not "1"', async () => {
        mockGetSetting.mockResolvedValue(null);
        await expect(hasIdentityFault()).resolves.toBe(false);
        mockGetSetting.mockResolvedValue('0');
        await expect(hasIdentityFault()).resolves.toBe(false);
    });

    it('returns false rather than throwing when the DB is unavailable', async () => {
        mockGetSetting.mockRejectedValue(new Error('db gone'));
        await expect(hasIdentityFault()).resolves.toBe(false);
    });

    it('deletes the persisted marker', async () => {
        await clearIdentityFault();
        expect(mockDeleteSetting).toHaveBeenCalledWith(IDENTITY_FAULT_KEY);
    });
});
