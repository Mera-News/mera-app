// Mutable state shared by the Jest handlers and the Maestro control endpoint.
export interface Scenario {
    tier: 'starter' | 'individual' | 'professional' | 'none';
    /** What billing reports as `readingUsed` (0..1; null = the server cannot see the meter). */
    readingUsed: number | null;
    articles: 'default' | 'empty';
    discovery: boolean;
    /** Origin for fixture image URLs; null = the request's own origin. The e2e lane's
     *  negative control points it at a non-mock host so step 7 must turn red. */
    imageOrigin: string | null;
    /** What the E2E build's stubbed paywall (lib/e2e/purchases-ui.ts) resolves to. On PURCHASED with
     *  `upgradeTo`, billing reports that paid tier from `confirmAfterMs` after the purchase (the
     *  confirming window); with `upgradeTo: null` it stays on `tier` (the timeout card). */
    paywall: {
        result: 'PURCHASED' | 'CANCELLED' | 'RESTORED' | 'NOT_PRESENTED' | 'ERROR';
        upgradeTo: 'individual' | 'professional' | null;
        confirmAfterMs: number;
    };
    /** Set by the paywall route on PURCHASED; reset with the scenario. */
    purchasedAt: number | null;
    /** One GraphQL operation name that answers with a GraphQL error instead of data (a failed
     *  sync step on device, e.g. GetArticleIdsForPersona or GetArticlesForTopicsByIds). */
    failOperation: string | null;
}

const DEFAULT_SCENARIO: Scenario = {
    tier: 'starter',
    readingUsed: 0,
    articles: 'default',
    discovery: false,
    imageOrigin: null,
    paywall: { result: 'CANCELLED', upgradeTo: null, confirmAfterMs: 0 },
    purchasedAt: null,
    failOperation: null,
};

let current: Scenario = { ...DEFAULT_SCENARIO };

export const getScenario = (): Scenario => current;

export function setScenario(patch: Partial<Scenario>): void {
    current = { ...current, ...patch };
}

/** The tier billing reports at `now`: the paid tier once a scripted purchase has confirmed. */
export function billingTier(s: Scenario, now: number): Scenario['tier'] {
    const { upgradeTo, confirmAfterMs } = s.paywall;
    return upgradeTo && s.purchasedAt !== null && now >= s.purchasedAt + confirmAfterMs ? upgradeTo : s.tier;
}

export function resetScenario(): void {
    current = { ...DEFAULT_SCENARIO };
}
