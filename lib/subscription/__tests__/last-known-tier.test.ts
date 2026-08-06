// The device-local last-known-tier memory (lib/subscription/last-known-tier.ts).
//
// Behavioural contract this pins, in the order it matters:
//  1. "never resolved" and "resolved to no plan" are DIFFERENT states — only the
//     first one may take the never-resolved branch of the onboarding gate;
//  2. nothing that isn't a real resolution is ever recorded as history;
//  3. an unreadable row fails CLOSED (no history), never as a subscriber;
//  4. it can be wiped, because a user switch depends on that.

let mockSettings: Record<string, string> = {};
let mockGetThrows = false;
let mockSetThrows = false;
let mockDeleteThrows = false;

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: jest.fn(async (k: string) => {
        if (mockGetThrows) throw new Error('db unavailable');
        return mockSettings[k] ?? null;
    }),
    setSetting: jest.fn(async (k: string, v: string) => {
        if (mockSetThrows) throw new Error('db unavailable');
        mockSettings[k] = v;
    }),
    deleteSetting: jest.fn(async (k: string) => {
        if (mockDeleteThrows) throw new Error('db unavailable');
        delete mockSettings[k];
    }),
}));

import {
    LAST_KNOWN_TIER_SETTING_KEY,
    aiAccessFromLastKnownTier,
    clearLastKnownTier,
    readLastKnownTier,
    rememberLastKnownTier,
} from '@/lib/subscription/last-known-tier';

beforeEach(() => {
    jest.clearAllMocks();
    mockSettings = {};
    mockGetThrows = false;
    mockSetThrows = false;
    mockDeleteThrows = false;
});

describe('rememberLastKnownTier', () => {
    it('records a paid tier verbatim', async () => {
        await rememberLastKnownTier('professional');
        expect(mockSettings[LAST_KNOWN_TIER_SETTING_KEY]).toBe('professional');
    });

    it("records 'none' — a server that says the user has no plan HAS resolved", async () => {
        await rememberLastKnownTier('none');
        expect(mockSettings[LAST_KNOWN_TIER_SETTING_KEY]).toBe('none');
    });

    it('records nothing for null / undefined / empty', async () => {
        await rememberLastKnownTier(null);
        await rememberLastKnownTier(undefined);
        await rememberLastKnownTier('');
        // "We did not learn a tier" must not masquerade as history — a device
        // that has never resolved anything has to keep taking the
        // never-resolved branch.
        expect(mockSettings[LAST_KNOWN_TIER_SETTING_KEY]).toBeUndefined();
        const { setSetting } = require('@/lib/database/services/setting-service');
        expect(setSetting).not.toHaveBeenCalled();
    });

    it('swallows a write failure — callers fire it alongside work that matters more', async () => {
        mockSetThrows = true;
        await expect(rememberLastKnownTier('starter')).resolves.toBeUndefined();
    });
});

describe('readLastKnownTier', () => {
    it('returns null when nothing was ever recorded', async () => {
        await expect(readLastKnownTier()).resolves.toBeNull();
    });

    it('round-trips what was written', async () => {
        await rememberLastKnownTier('individual');
        await expect(readLastKnownTier()).resolves.toBe('individual');
    });

    it('FAILS CLOSED on an unreadable row', async () => {
        await rememberLastKnownTier('professional');
        mockGetThrows = true;
        // Deliberately the opposite direction from readFirstOpenDismissed. An
        // unreadable row must never be read as "this user is a subscriber": that
        // would walk them into a wizard whose step 2 cannot work without an
        // entitlement.
        await expect(readLastKnownTier()).resolves.toBeNull();
    });
});

describe('clearLastKnownTier', () => {
    it('removes the row', async () => {
        await rememberLastKnownTier('professional');
        await clearLastKnownTier();
        await expect(readLastKnownTier()).resolves.toBeNull();
    });

    it('swallows a delete failure', async () => {
        mockDeleteThrows = true;
        await expect(clearLastKnownTier()).resolves.toBeUndefined();
    });
});

describe('aiAccessFromLastKnownTier', () => {
    it('null ⇒ unknown — the never-resolved state the gate keys the paywall off', () => {
        expect(aiAccessFromLastKnownTier(null)).toBe('unknown');
        expect(aiAccessFromLastKnownTier('')).toBe('unknown');
    });

    it("'none' ⇒ locked", () => {
        expect(aiAccessFromLastKnownTier('none')).toBe('locked');
    });

    it('any other tier ⇒ entitled', () => {
        expect(aiAccessFromLastKnownTier('starter')).toBe('entitled');
        expect(aiAccessFromLastKnownTier('individual')).toBe('entitled');
        expect(aiAccessFromLastKnownTier('professional')).toBe('entitled');
        // Forward-compatible on purpose: a tier name this build has never heard
        // of is still a tier, and must not be misread as "no plan".
        expect(aiAccessFromLastKnownTier('enterprise')).toBe('entitled');
    });
});
