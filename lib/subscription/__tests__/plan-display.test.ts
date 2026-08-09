// One screen, two answers — the bug this pins shut.
//
// Profile showed "Individual Plan" in its usage card directly above a notice
// saying the user had no plan and Mera could not build a feed. Both were correct
// by their own rule: the LABEL fell back to RevenueCat's client tier when the
// server said `none`, while the access gate (`deriveAiAccess`) deliberately has
// no such fallback, because the device must never grant itself entitlement.
//
// Normally they disagree for the seconds between a purchase and the webhook. When
// the webhook can never land — a sandbox receipt on a production build, which
// RevenueCat routes to staging — they disagree forever.

import { isPaidTier, resolvePlanDisplay } from '../plan-display';

describe('resolvePlanDisplay', () => {
    // A wrong label is worse than no label: this is what stopped a "Free plan"
    // flash on every cold mount before the first billing fetch resolves.
    it('renders nothing at all until the server has answered', () => {
        expect(
            resolvePlanDisplay({ serverTier: null, rcTier: 'individual', serverLoaded: false }),
        ).toEqual({ tier: null, pending: false, known: false });
    });

    it('states a server-confirmed tier flatly, with no qualifier', () => {
        expect(
            resolvePlanDisplay({ serverTier: 'individual', rcTier: 'individual', serverLoaded: true }),
        ).toEqual({ tier: 'individual', pending: false, known: true });
    });

    // The reported screenshot, exactly: the store says Individual, our server
    // says nothing. The plan name still shows — a just-completed purchase should
    // be visible — but it is marked pending so no caller can present it as
    // access the gate is actually honouring.
    it('marks a store-only tier as PENDING rather than asserting it', () => {
        expect(
            resolvePlanDisplay({ serverTier: 'none', rcTier: 'individual', serverLoaded: true }),
        ).toEqual({ tier: 'individual', pending: true, known: true });
    });

    it('treats a null server tier the same as none once loaded', () => {
        expect(
            resolvePlanDisplay({ serverTier: null, rcTier: 'professional', serverLoaded: true }),
        ).toEqual({ tier: 'professional', pending: true, known: true });
    });

    it('reports no plan when neither side claims one', () => {
        expect(
            resolvePlanDisplay({ serverTier: 'none', rcTier: null, serverLoaded: true }),
        ).toEqual({ tier: null, pending: false, known: true });
    });

    // The server is the authority in BOTH directions. A stale local entitlement
    // must never downgrade a tier the server has confirmed...
    it('never lets the store contradict a confirmed server tier', () => {
        expect(
            resolvePlanDisplay({ serverTier: 'professional', rcTier: 'starter', serverLoaded: true }),
        ).toEqual({ tier: 'professional', pending: false, known: true });
    });

    // ...nor may a junk tier string from either side be shown as a plan.
    it('ignores tier values outside the known set', () => {
        expect(
            resolvePlanDisplay({ serverTier: 'promo', rcTier: 'lifetime', serverLoaded: true }),
        ).toEqual({ tier: null, pending: false, known: true });
    });

    // `pending` must NEVER be true alongside a server-confirmed tier — that
    // combination would make a paying customer's plan read "activating" forever.
    it.each(['starter', 'individual', 'professional'] as const)(
        'never marks a confirmed %s tier as pending',
        (tier) => {
            const d = resolvePlanDisplay({ serverTier: tier, rcTier: null, serverLoaded: true });
            expect(d).toEqual({ tier, pending: false, known: true });
        },
    );
});

describe('isPaidTier', () => {
    it.each(['starter', 'individual', 'professional'])('accepts %s', (t) => {
        expect(isPaidTier(t)).toBe(true);
    });

    it.each(['none', 'promo', '', null, undefined])('rejects %s', (t) => {
        expect(isPaidTier(t as string | null | undefined)).toBe(false);
    });
});
