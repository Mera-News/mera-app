// ai-access.test.ts — tests for the pure derive functions in ai-access.ts.
//
// `feature-gates.ts` exports plain module-level consts, so driving the dev
// overrides requires jest.resetModules() + jest.doMock() per test, the same
// pattern lib/config/__tests__/branding.test.ts uses for env-driven modules.
// `require` (not `import`) after the mock so we get a fresh module graph
// reading the mocked constants.

function loadAiAccess(gates: {
    DEV_FORCE_AI_ACCESS?: 'entitled' | 'locked' | null;
    DEV_FORCE_LAPSED?: boolean;
} = {}) {
    jest.resetModules();
    jest.doMock('@/lib/config/feature-gates', () => ({
        __esModule: true,
        DEV_FORCE_AI_ACCESS: gates.DEV_FORCE_AI_ACCESS ?? null,
        DEV_FORCE_LAPSED: gates.DEV_FORCE_LAPSED ?? false,
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/lib/subscription/ai-access');
}

const originalDev = (global as any).__DEV__;

afterEach(() => {
    (global as any).__DEV__ = originalDev;
    jest.dontMock('@/lib/config/feature-gates');
});

describe('deriveAiAccess', () => {
    describe('verdict precedence', () => {
        it('__DEV__ override takes precedence over everything else', () => {
            const { deriveAiAccess } = loadAiAccess({ DEV_FORCE_AI_ACCESS: 'locked' });
            // Server says entitled, RevenueCat says entitled — override still wins.
            expect(
                deriveAiAccess({ serverTier: 'professional', hasCustomerInfo: true, isPremium: true }),
            ).toBe('locked');
        });

        it('__DEV__ override is only consulted in dev builds', () => {
            const { deriveAiAccess } = loadAiAccess({ DEV_FORCE_AI_ACCESS: 'locked' });
            (global as any).__DEV__ = false;
            // With __DEV__ false, falls through to serverTier.
            expect(
                deriveAiAccess({ serverTier: 'professional', hasCustomerInfo: false, isPremium: false }),
            ).toBe('entitled');
        });

        it('serverTier wins over RevenueCat when the server has answered', () => {
            const { deriveAiAccess } = loadAiAccess();
            expect(
                deriveAiAccess({ serverTier: 'none', hasCustomerInfo: true, isPremium: true }),
            ).toBe('locked');
            expect(
                deriveAiAccess({ serverTier: 'individual', hasCustomerInfo: true, isPremium: false }),
            ).toBe('entitled');
        });

        // RevenueCat may GRANT, and may NEVER deny. An identified-but-empty
        // CustomerInfo used to mean 'locked'; under Starter-for-everyone it
        // describes a fully ENTITLED user, because the grant is server-side and
        // RevenueCat has no knowledge of it. Since RevenueCat answers from
        // local cache long before our GraphQL round trip, denying on it put a
        // 'locked' window on EVERY cold start for every user who had not paid.
        it('grants from RevenueCat, but never denies, while the server is silent', () => {
            const { deriveAiAccess } = loadAiAccess();
            expect(
                deriveAiAccess({ serverTier: null, hasCustomerInfo: true, isPremium: true }),
            ).toBe('entitled');
            const empty = deriveAiAccess({
                serverTier: null,
                hasCustomerInfo: true,
                isPremium: false,
            });
            expect(empty).toBe('unknown');
            expect(empty).not.toBe('locked');
        });

        it('returns unknown — never locked — when neither the server nor RevenueCat has answered', () => {
            const { deriveAiAccess } = loadAiAccess();
            const result = deriveAiAccess({
                serverTier: null,
                hasCustomerInfo: false,
                isPremium: false,
            });
            expect(result).toBe('unknown');
            expect(result).not.toBe('locked');
        });

        // RevenueCat may GRANT on any evidence but may only DENY on evidence
        // about an identified customer. The SDK configures anonymously at app
        // start and its empty CustomerInfo reaches the store seconds before
        // logIn — reading that as "not subscribed" is what flashed Mera News
        // Free at a paying subscriber on every cold start.
        it('an entitlement grants even while RevenueCat is still anonymous', () => {
            const { deriveAiAccess } = loadAiAccess();
            expect(
                deriveAiAccess({ serverTier: null, hasCustomerInfo: false, isPremium: true }),
            ).toBe('entitled');
        });

        it('an ANONYMOUS empty answer is unknown, not locked', () => {
            const { deriveAiAccess } = loadAiAccess();
            const result = deriveAiAccess({
                // hasCustomerInfo: false is how the store reports "we hold a
                // CustomerInfo, but it is the anonymous one".
                serverTier: null,
                hasCustomerInfo: false,
                isPremium: false,
            });
            expect(result).toBe('unknown');
        });
    });
});

describe('deriveShowLapseInterstitial', () => {
    it('returns the server flag verbatim when true', () => {
        const { deriveShowLapseInterstitial } = loadAiAccess();
        expect(deriveShowLapseInterstitial(true, false)).toBe(true);
    });

    it('returns false when the server flag is false', () => {
        const { deriveShowLapseInterstitial } = loadAiAccess();
        expect(deriveShowLapseInterstitial(false, false)).toBe(false);
    });

    it('returns false when the server flag is null (unknown)', () => {
        const { deriveShowLapseInterstitial } = loadAiAccess();
        expect(deriveShowLapseInterstitial(null, false)).toBe(false);
    });

    it('DEV_FORCE_LAPSED seeds true when not yet acked', () => {
        const { deriveShowLapseInterstitial } = loadAiAccess({ DEV_FORCE_LAPSED: true });
        expect(deriveShowLapseInterstitial(null, false)).toBe(true);
        expect(deriveShowLapseInterstitial(false, false)).toBe(true);
    });

    it('DEV_FORCE_LAPSED stops applying once acked (a seed, not a clamp)', () => {
        const { deriveShowLapseInterstitial } = loadAiAccess({ DEV_FORCE_LAPSED: true });
        expect(deriveShowLapseInterstitial(false, true)).toBe(false);
    });

    it('DEV_FORCE_LAPSED is only consulted in dev builds', () => {
        const { deriveShowLapseInterstitial } = loadAiAccess({ DEV_FORCE_LAPSED: true });
        (global as any).__DEV__ = false;
        expect(deriveShowLapseInterstitial(null, false)).toBe(false);
    });
});

describe('deriveHasEverSubscribed', () => {
    it('returns the server value verbatim outside the dev override', () => {
        const { deriveHasEverSubscribed } = loadAiAccess();
        expect(deriveHasEverSubscribed(true)).toBe(true);
        expect(deriveHasEverSubscribed(false)).toBe(false);
        expect(deriveHasEverSubscribed(null)).toBeNull();
    });

    it('resolves null to false only when DEV_FORCE_AI_ACCESS is forcing locked', () => {
        const { deriveHasEverSubscribed } = loadAiAccess({ DEV_FORCE_AI_ACCESS: 'locked' });
        expect(deriveHasEverSubscribed(null)).toBe(false);
    });

    it('does not touch a known server value even when forcing locked', () => {
        const { deriveHasEverSubscribed } = loadAiAccess({ DEV_FORCE_AI_ACCESS: 'locked' });
        expect(deriveHasEverSubscribed(true)).toBe(true);
    });

    it('does not resolve null when the override forces entitled instead of locked', () => {
        const { deriveHasEverSubscribed } = loadAiAccess({ DEV_FORCE_AI_ACCESS: 'entitled' });
        expect(deriveHasEverSubscribed(null)).toBeNull();
    });

    it('the locked-resolves-null-to-false override is only consulted in dev builds', () => {
        const { deriveHasEverSubscribed } = loadAiAccess({ DEV_FORCE_AI_ACCESS: 'locked' });
        (global as any).__DEV__ = false;
        expect(deriveHasEverSubscribed(null)).toBeNull();
    });
});

export {};
