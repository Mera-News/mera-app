import {
    FREE_TIER_UNLOCKED_FACT_LIMIT,
    aiAccessForSchedulerCondition,
    deriveFreeTierAccess,
    resolveAiAccessForFetch,
    serverResolvedAiAccess,
    type FactAgeInput,
} from '@/lib/subscription/free-tier-topic-access';
import {
    __resetLastKnownTierMirrorForTests,
    clearLastKnownTier,
    hydrateLastKnownTierMirror,
    lastKnownTierMirror,
    rememberLastKnownTier,
} from '@/lib/subscription/last-known-tier';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';

// The settings row behind last-known-tier. `last-known-tier.ts` requires this
// LAZILY inside each function, so a module factory is enough — no database.
let mockSettingsRow: string | null = null;
let mockSettingThrows = false;
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: jest.fn(async () => {
        if (mockSettingThrows) throw new Error('unreadable');
        return mockSettingsRow;
    }),
    setSetting: jest.fn(async (_k: string, v: string) => {
        mockSettingsRow = v;
    }),
    deleteSetting: jest.fn(async () => {
        mockSettingsRow = null;
    }),
}));

const fact = (id: string, createdAtMs: number): FactAgeInput => ({ id, createdAtMs });

/** Drives `serverResolvedAiAccess` without reaching into RevenueCat. */
function setServerTier(tier: string | null) {
    useSubscriptionStore.setState({ serverTier: tier } as never);
}

beforeEach(() => {
    mockSettingsRow = null;
    mockSettingThrows = false;
    __resetLastKnownTierMirrorForTests();
    setServerTier(null);
});

describe('deriveFreeTierAccess', () => {
    const facts = [fact('c', 300), fact('a', 100), fact('b', 200), fact('d', 400)];

    it('is uncapped for an entitled user', () => {
        const access = deriveFreeTierAccess('entitled', facts);
        expect(access.capped).toBe(false);
        expect(access.isFactUnlocked('d')).toBe(true);
        expect(access.isTopicUnlocked([{ factId: 'd' }])).toBe(true);
    });

    // The cold-start case. Treating 'unknown' as locked would cap a paying
    // subscriber for the first second of every launch.
    it('is uncapped for an UNKNOWN verdict, failing open', () => {
        const access = deriveFreeTierAccess('unknown', facts);
        expect(access.capped).toBe(false);
        expect(access.isFactUnlocked('d')).toBe(true);
    });

    it('unlocks exactly the two oldest facts when locked', () => {
        const access = deriveFreeTierAccess('locked', facts);
        expect(access.capped).toBe(true);
        expect([...access.unlockedFactIds].sort()).toEqual(['a', 'b']);
        expect(access.isFactUnlocked('a')).toBe(true);
        expect(access.isFactUnlocked('c')).toBe(false);
        expect(access.unlockedFactIds.size).toBe(FREE_TIER_UNLOCKED_FACT_LIMIT);
    });

    it('breaks a same-millisecond tie deterministically by id', () => {
        // commitFactChoices writes facts in a loop of separate database.write()
        // calls, so two facts from one card can share a timestamp.
        const tied = [fact('zz', 100), fact('aa', 100), fact('mm', 100)];
        const first = deriveFreeTierAccess('locked', tied).unlockedFactIds;
        const reordered = deriveFreeTierAccess('locked', [...tied].reverse()).unlockedFactIds;
        expect([...first].sort()).toEqual(['aa', 'mm']);
        expect([...reordered].sort()).toEqual([...first].sort());
    });

    it('handles fewer than two facts, and zero, without error', () => {
        expect(deriveFreeTierAccess('locked', []).unlockedFactIds.size).toBe(0);
        expect(deriveFreeTierAccess('locked', []).isFactUnlocked('a')).toBe(false);
        const one = deriveFreeTierAccess('locked', [fact('solo', 1)]);
        expect([...one.unlockedFactIds]).toEqual(['solo']);
    });

    it('locks a topic whose source fact is null', () => {
        const access = deriveFreeTierAccess('locked', facts);
        expect(access.isTopicUnlocked([{ factId: null }])).toBe(false);
        expect(access.isTopicUnlocked([{ factId: undefined }])).toBe(false);
    });

    // D12: the same normalized text can be carried by several facts on purpose
    // (createTopics keys on (normalized_text, fact_id)).
    it('unlocks a topic text carried by an unlocked AND a locked fact', () => {
        const access = deriveFreeTierAccess('locked', facts);
        expect(access.isTopicUnlocked([{ factId: 'd' }, { factId: 'a' }])).toBe(true);
        // ...while the locked fact itself still reports locked. The badge is
        // fact-scoped; retrieval is text-scoped. Both are correct at once.
        expect(access.isFactUnlocked('d')).toBe(false);
    });

    // D26. These rows carry no fact_id, so the age rule alone would lock every
    // followed story AND narrow the quota-exempt partition computeFreeTopicTexts
    // derives from the same set.
    it('always unlocks a tracked topic, even with no fact and no unlocked facts', () => {
        const access = deriveFreeTierAccess('locked', []);
        expect(access.isTopicUnlocked([{ factId: null, provenance: 'tracked' }])).toBe(true);
        const withFacts = deriveFreeTierAccess('locked', facts);
        expect(withFacts.isTopicUnlocked([{ factId: null, provenance: 'tracked' }])).toBe(true);
        // A non-tracked provenance under a locked fact stays locked.
        expect(withFacts.isTopicUnlocked([{ factId: 'd', provenance: 'llm' }])).toBe(false);
    });
});

describe('resolveAiAccessForFetch', () => {
    it('prefers the server over this device memory when both are present', async () => {
        setServerTier('none');
        mockSettingsRow = 'starter';
        await expect(resolveAiAccessForFetch()).resolves.toBe('locked');
    });

    it('falls back to a remembered locked tier when the server is silent', async () => {
        mockSettingsRow = 'none';
        await expect(resolveAiAccessForFetch()).resolves.toBe('locked');
    });

    it('falls back to a remembered paid tier when the server is silent', async () => {
        mockSettingsRow = 'starter';
        await expect(resolveAiAccessForFetch()).resolves.toBe('entitled');
    });

    it('is unknown when neither the server nor the device has ever resolved', async () => {
        await expect(resolveAiAccessForFetch()).resolves.toBe('unknown');
    });

    it('is unknown, not locked, when the settings read throws', async () => {
        mockSettingThrows = true;
        await expect(resolveAiAccessForFetch()).resolves.toBe('unknown');
    });
});

describe('aiAccessForSchedulerCondition (the synchronous mirror)', () => {
    it('agrees with the async accessor across every input pairing', async () => {
        for (const server of [null, 'none', 'starter']) {
            for (const remembered of [null, 'none', 'professional']) {
                setServerTier(server);
                mockSettingsRow = remembered;
                await hydrateLastKnownTierMirror();
                expect(aiAccessForSchedulerCondition()).toBe(await resolveAiAccessForFetch());
            }
        }
    });

    it('is unknown before hydration even when the row is set', () => {
        mockSettingsRow = 'none';
        expect(aiAccessForSchedulerCondition()).toBe('unknown');
    });

    it('write-through keeps it fresh after an entitlement sync', async () => {
        await hydrateLastKnownTierMirror();
        expect(aiAccessForSchedulerCondition()).toBe('unknown');
        await rememberLastKnownTier('none');
        expect(lastKnownTierMirror()).toBe('none');
        expect(aiAccessForSchedulerCondition()).toBe('locked');
    });

    // The one with a security consequence: module state survives a logout, so
    // an unreset mirror hands the NEXT user on this device the previous user's
    // tier — a cross-user leak the settings row itself no longer has.
    it('resets on clear, so a new user cannot read the previous tier', async () => {
        await rememberLastKnownTier('professional');
        expect(aiAccessForSchedulerCondition()).toBe('entitled');
        await clearLastKnownTier();
        expect(lastKnownTierMirror()).toBeNull();
        expect(aiAccessForSchedulerCondition()).toBe('unknown');
    });

    it('still resets the mirror when the underlying delete fails', async () => {
        await rememberLastKnownTier('starter');
        mockSettingThrows = true;
        await clearLastKnownTier();
        expect(lastKnownTierMirror()).toBeNull();
    });
});

describe('serverResolvedAiAccess', () => {
    it('is unknown until our server has answered', () => {
        expect(serverResolvedAiAccess()).toBe('unknown');
        setServerTier('none');
        expect(serverResolvedAiAccess()).toBe('locked');
    });
});
