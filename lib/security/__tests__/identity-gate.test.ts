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
    __resetIdentityStateForTests,
    clearIdentityFault,
    clearPendingAuthUserId,
    effectiveSessionUserId,
    hasIdentityFault,
    isIdentitySwitchBlocked,
    isOwnershipFault,
    readPendingAuthUserId,
    recordAuthenticatedUser,
    recordOwnershipFault,
    resolveIdentity,
    setIdentitySwitchBlocked,
} from '../identity-gate';

beforeEach(() => {
    jest.clearAllMocks();
    // EVERY piece of module state, not just the fault latch. The
    // authenticated-user recorder is process-lived by design, so one test's
    // recording would otherwise leak into the offline cases below and quietly
    // stop them from being offline at all.
    __resetIdentityStateForTests();
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

    // ── server reachability ──────────────────────────────────────────────
    // `isConnected` only ever answered half the question. A device with a live
    // connection to a DEAD auth server satisfies it, and ejecting there drops
    // the user on an OTP screen that cannot send an OTP — the same trap the
    // isConnected gate exists to prevent, reached by a different road.
    it('never ejects when the auth server is confirmed unreachable, even with a fault', () => {
        expect(
            resolveIdentity({
                sessionUserId: 'A',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: true,
                serverReachable: false,
            }),
        ).toBe('coherent');
    });

    it('treats unknown server reachability as reachable (acts on the fault)', () => {
        // Unprobed must fall on the ACT side, same optimistic-unknown rule as
        // isConnected — the gate must not be disarmed by simply not asking.
        expect(
            resolveIdentity({
                sessionUserId: 'A',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: true,
                serverReachable: undefined,
            }),
        ).toBe('reauth');
    });

    it('ejects as before once the server IS reachable — deferral, not cancellation', () => {
        expect(
            resolveIdentity({
                sessionUserId: 'A',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: true,
                serverReachable: true,
            }),
        ).toBe('reauth');
    });

    // The deferral must NOT swallow the cross-user wipe. This is why the
    // unreachable branch falls through to the id comparison instead of
    // returning some third verdict early.
    it('still wipes on a deferred fault whose ids genuinely disagree', () => {
        expect(
            resolveIdentity({
                sessionUserId: 'B',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: true,
                serverReachable: false,
            }),
        ).toBe('wipeAndProceed');
    });

    it('existing callers that omit serverReachable are unaffected', () => {
        expect(
            resolveIdentity({ sessionUserId: 'A', cachedUserId: 'A', ownershipFault: true }),
        ).toBe('reauth');
    });

    it('coherent: no live session is the OFFLINE path, not a fault', () => {
        expect(resolveIdentity({ sessionUserId: null, cachedUserId: 'A' })).toBe('coherent');
        expect(resolveIdentity({ sessionUserId: undefined, cachedUserId: 'A' })).toBe('coherent');
    });

    it('coherent: no identity at all', () => {
        expect(resolveIdentity({})).toBe('coherent');
    });

    // ── the recorded authenticated user ──────────────────────────────────
    // The two cases above are the OFFLINE contract and must keep passing
    // VERBATIM — they are the regression guard for everything below, not a
    // formality. An offline device never has a recorded id (the recording
    // requires a resolved network sign-in), so for it nothing here is reachable.

    // THE BUG, in one line. User A's data on the device, user B signs in via
    // the reauth banner, and the gate runs before better-auth's session atom
    // settles. This used to return 'coherent' — B entered the shell holding A's
    // facts, reading history, saved items, chat and topics, skipped onboarding,
    // and then sent A's topic texts to the server under B's session.
    it('wipeAndProceed: an UNRESOLVED session with a recorded sign-in as a different user', () => {
        expect(
            resolveIdentity({
                sessionUserId: undefined,
                pendingAuthUserId: 'B',
                cachedUserId: 'A',
            }),
        ).toBe('wipeAndProceed');
    });

    // The other half of the same window: re-authenticating as YOURSELF must not
    // wipe. This is the common case of the reauth banner by a wide margin.
    it('coherent: an unresolved session with a recorded sign-in as the SAME user', () => {
        expect(
            resolveIdentity({
                sessionUserId: undefined,
                pendingAuthUserId: 'A',
                cachedUserId: 'A',
            }),
        ).toBe('coherent');
    });

    it('wipeAndProceed: recorded sign-in with nothing stamped on disk yet', () => {
        expect(
            resolveIdentity({ sessionUserId: null, pendingAuthUserId: 'B', cachedUserId: null }),
        ).toBe('wipeAndProceed');
    });

    it('a recorded id cannot override a resolved session that agrees with disk', () => {
        // Atom wins. A stale recording must never manufacture a wipe.
        expect(
            resolveIdentity({ sessionUserId: 'A', pendingAuthUserId: 'B', cachedUserId: 'A' }),
        ).toBe('coherent');
    });

    // ── ORDERING GUARD ───────────────────────────────────────────────────
    // The coalesce goes AFTER the ownership-fault check. Inserted above it, a
    // fault carrying a recorded id would resolve to 'wipeAndProceed' and
    // silently destroy data the SERVER has already told us we are wrong about —
    // the precise outcome the fault check exists to prevent. If this test goes
    // red, the coalesce moved; move it back rather than editing this.
    it('reauth still wins over a recorded id when a fault is present', () => {
        expect(
            resolveIdentity({
                sessionUserId: undefined,
                pendingAuthUserId: 'B',
                cachedUserId: 'A',
                ownershipFault: true,
            }),
        ).toBe('reauth');
    });

    // ...and the deferral still falls through to the comparison, now including
    // the recorded id. Same property the pre-existing deferral test pins for a
    // resolved session.
    it('still wipes on a DEFERRED fault whose recorded id disagrees with disk', () => {
        expect(
            resolveIdentity({
                sessionUserId: undefined,
                pendingAuthUserId: 'B',
                cachedUserId: 'A',
                ownershipFault: true,
                isConnected: true,
                serverReachable: false,
            }),
        ).toBe('wipeAndProceed');
    });

    it('an explicit null recorded id changes nothing (the offline shape)', () => {
        expect(
            resolveIdentity({ sessionUserId: null, pendingAuthUserId: null, cachedUserId: 'A' }),
        ).toBe('coherent');
    });
});

// ---------------------------------------------------------------------------
// effectiveSessionUserId — asserted DIRECTLY
// ---------------------------------------------------------------------------
// Not folded into the verdict tests: inverted precedence produces the same
// verdict in most pairings, so only the function itself can catch it.

describe('effectiveSessionUserId', () => {
    it('THE ATOM WINS on conflict — the recorder only ever fills a hole', () => {
        expect(effectiveSessionUserId('B', 'C')).toBe('B');
    });

    it('falls back to the recorder when the session has not resolved', () => {
        expect(effectiveSessionUserId(undefined, 'C')).toBe('C');
        expect(effectiveSessionUserId(null, 'C')).toBe('C');
    });

    it('returns null, not undefined, when neither is present', () => {
        expect(effectiveSessionUserId(undefined, undefined)).toBeNull();
        expect(effectiveSessionUserId(null, null)).toBeNull();
    });

    it('treats an empty-string session id as absent, not as an identity', () => {
        expect(effectiveSessionUserId('', 'C')).toBe('C');
        expect(effectiveSessionUserId('', '')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// the authenticated-user recorder
// ---------------------------------------------------------------------------

describe('recordAuthenticatedUser', () => {
    it('round-trips the id and clears on consumption', () => {
        expect(readPendingAuthUserId()).toBeNull();
        recordAuthenticatedUser('B');
        expect(readPendingAuthUserId()).toBe('B');
        clearPendingAuthUserId();
        expect(readPendingAuthUserId()).toBeNull();
    });

    it('normalises an absent id to null rather than storing undefined', () => {
        recordAuthenticatedUser(undefined);
        expect(readPendingAuthUserId()).toBeNull();
        recordAuthenticatedUser('');
        expect(readPendingAuthUserId()).toBeNull();
    });

    it('the last sign-in wins — a second account overwrites the first', () => {
        recordAuthenticatedUser('B');
        recordAuthenticatedUser('C');
        expect(readPendingAuthUserId()).toBe('C');
    });
});

describe('the blocking-screen latch', () => {
    it('is off by default and round-trips', () => {
        expect(isIdentitySwitchBlocked()).toBe(false);
        setIdentitySwitchBlocked(true);
        expect(isIdentitySwitchBlocked()).toBe(true);
        setIdentitySwitchBlocked(false);
        expect(isIdentitySwitchBlocked()).toBe(false);
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
