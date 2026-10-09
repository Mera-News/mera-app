// Mutable state shared by the Jest handlers and the Maestro control endpoint.
export interface Scenario {
    tier: 'starter' | 'individual' | 'professional' | 'none';
    dailyLimitReached: boolean;
    articles: 'default' | 'empty';
    discovery: boolean;
}

const DEFAULT_SCENARIO: Scenario = {
    tier: 'starter',
    dailyLimitReached: false,
    articles: 'default',
    discovery: false,
};

let current: Scenario = { ...DEFAULT_SCENARIO };

export const getScenario = (): Scenario => current;

export function setScenario(patch: Partial<Scenario>): void {
    current = { ...current, ...patch };
}

export function resetScenario(): void {
    current = { ...DEFAULT_SCENARIO };
}
