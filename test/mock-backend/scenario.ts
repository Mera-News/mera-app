// Mutable state shared by the Jest handlers and the Maestro control endpoint.
export interface Scenario {
    tier: 'starter' | 'individual' | 'professional' | 'none';
    dailyLimitReached: boolean;
    articles: 'default' | 'empty';
    discovery: boolean;
    /** Origin for fixture image URLs; null = the request's own origin. The e2e lane's
     *  negative control points it at a non-mock host so step 7 must turn red. */
    imageOrigin: string | null;
}

const DEFAULT_SCENARIO: Scenario = {
    tier: 'starter',
    dailyLimitReached: false,
    articles: 'default',
    discovery: false,
    imageOrigin: null,
};

let current: Scenario = { ...DEFAULT_SCENARIO };

export const getScenario = (): Scenario => current;

export function setScenario(patch: Partial<Scenario>): void {
    current = { ...current, ...patch };
}

export function resetScenario(): void {
    current = { ...DEFAULT_SCENARIO };
}
