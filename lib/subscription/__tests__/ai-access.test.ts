// ai-access.test.ts — tests for the pure derive functions in ai-access.ts.
//
// `feature-gates.ts` exports plain module-level consts, so exercising both
// sides of FREE_TIER_MODE_ENABLED (currently `false` in ship state — see the
// module's own comment) requires jest.resetModules() + jest.doMock() per test,
// the same pattern lib/config/__tests__/branding.test.ts uses for env-driven
// modules. `require` (not `import`) after the mock so we get a fresh module
// graph reading the mocked constants.

function loadAiAccess(gates: {
    FREE_TIER_MODE_ENABLED?: boolean;
    DEV_FORCE_AI_ACCESS?: 'entitled' | 'locked' | null;
    DEV_FORCE_LAPSED?: boolean;
} = {}) {
    jest.resetModules();
    jest.doMock('@/lib/config/feature-gates', () => ({
        __esModule: true,
        FREE_TIER_MODE_ENABLED: gates.FREE_TIER_MODE_ENABLED ?? false,
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
    describe('ship gate OFF (FREE_TIER_MODE_ENABLED = false, current ship state)', () => {
        it('returns entitled for every input, regardless of server/RevenueCat signals', () => {
            const { deriveAiAccess } = loadAiAccess({ FREE_TIER_MODE_ENABLED: false });

            expect(
                deriveAiAccess({ serverTier: 'none', hasCustomerInfo: false, isPremium: false }),
            ).toBe('entitled');
            expect(
                deriveAiAccess({ serverTier: null, hasCustomerInfo: false, isPremium: false }),
            ).toBe('entitled');
            expect(
                deriveAiAccess({ serverTier: 'professional', hasCustomerInfo: true, isPremium: true }),
            ).toBe('entitled');
            expect(
                deriveAiAccess({ serverTier: null, hasCustomerInfo: true, isPremium: false }),
            ).toBe('entitled');
        });

        it('the dev override still wins over the ship gate (it sits above it)', () => {
            const { deriveAiAccess } = loadAiAccess({
                FREE_TIER_MODE_ENABLED: false,
                DEV_FORCE_AI_ACCESS: 'locked',
            });
            expect(
                deriveAiAccess({ serverTier: null, hasCustomerInfo: false, isPremium: false }),
            ).toBe('locked');
        });
    });

    describe('ship gate ON (FREE_TIER_MODE_ENABLED = true — simulates post-cutover)', () => {
        it('__DEV__ override takes precedence over everything else', () => {
            const { deriveAiAccess } = loadAiAccess({
                FREE_TIER_MODE_ENABLED: true,
                DEV_FORCE_AI_ACCESS: 'locked',
            });
            // Server says entitled, RevenueCat says entitled — override still wins.
            expect(
                deriveAiAccess({ serverTier: 'professional', hasCustomerInfo: true, isPremium: true }),
            ).toBe('locked');
        });

        it('__DEV__ override is only consulted in dev builds', () => {
            const { deriveAiAccess } = loadAiAccess({
                FREE_TIER_MODE_ENABLED: true,
                DEV_FORCE_AI_ACCESS: 'locked',
            });
            (global as any).__DEV__ = false;
            // With __DEV__ false, falls through to serverTier.
            expect(
                deriveAiAccess({ serverTier: 'professional', hasCustomerInfo: false, isPremium: false }),
            ).toBe('entitled');
        });

        it('serverTier wins over RevenueCat when the server has answered', () => {
            const { deriveAiAccess } = loadAiAccess({ FREE_TIER_MODE_ENABLED: true });
            expect(
                deriveAiAccess({ serverTier: 'none', hasCustomerInfo: true, isPremium: true }),
            ).toBe('locked');
            expect(
                deriveAiAccess({ serverTier: 'individual', hasCustomerInfo: true, isPremium: false }),
            ).toBe('entitled');
        });

        it('falls back to RevenueCat when the server has not answered yet', () => {
            const { deriveAiAccess } = loadAiAccess({ FREE_TIER_MODE_ENABLED: true });
            expect(
                deriveAiAccess({ serverTier: null, hasCustomerInfo: true, isPremium: true }),
            ).toBe('entitled');
            expect(
                deriveAiAccess({ serverTier: null, hasCustomerInfo: true, isPremium: false }),
            ).toBe('locked');
        });

        it('returns unknown — never locked — when neither the server nor RevenueCat has answered', () => {
            const { deriveAiAccess } = loadAiAccess({ FREE_TIER_MODE_ENABLED: true });
            const result = deriveAiAccess({
                serverTier: null,
                hasCustomerInfo: false,
                isPremium: false,
            });
            expect(result).toBe('unknown');
            expect(result).not.toBe('locked');
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
