const mockRows = new Map<string, string>();
let mockHasFacts = false;
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => Promise.resolve(mockRows.get(k) ?? null),
    setSetting: (k: string, v: string) => {
        mockRows.set(k, v);
        return Promise.resolve();
    },
}));
jest.mock('@/lib/database/services/fact-service', () => ({
    hasAnyFacts: () => Promise.resolve(mockHasFacts),
}));

import { isOnboardingDone, markOnboardingDone, ONBOARDING_DONE_SETTING_KEY } from '../onboarding-done';

describe('onboarding_done gate', () => {
    beforeEach(() => {
        mockRows.clear();
        mockHasFacts = false;
    });

    it('a new device with no row and no facts is not done', async () => {
        await expect(isOnboardingDone()).resolves.toBe(false);
        expect(mockRows.has(ONBOARDING_DONE_SETTING_KEY)).toBe(false);
    });

    it('a finished wizard is done, even with zero facts', async () => {
        await markOnboardingDone();
        await expect(isOnboardingDone()).resolves.toBe(true);
    });

    it('migrates a device that already has facts and writes the row', async () => {
        mockHasFacts = true;
        await expect(isOnboardingDone()).resolves.toBe(true);
        expect(mockRows.get(ONBOARDING_DONE_SETTING_KEY)).toBe('true');
    });
});
