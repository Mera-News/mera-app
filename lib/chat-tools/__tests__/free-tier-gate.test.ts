// free-tier-gate — the single entitlement read for the chat area.
//
// The behaviour worth pinning is the FAIL-OPEN direction. A bare
// `getAiAccess() === 'locked'` is true on every cold start, before the server
// has answered, so a gate built on it alone tells paying subscribers that chat
// needs a plan for the first second of every launch. Every test below that
// sets `serverTier: null` exists to keep that from coming back.

let mockAiAccess = 'entitled';
let mockServerTier: string | null = 'starter';
let mockThrows = false;

jest.mock('@/lib/stores/subscription-store', () => ({
    getAiAccess: () => mockAiAccess,
    useSubscriptionStore: {
        getState: () => {
            if (mockThrows) throw new Error('store exploded');
            return { serverTier: mockServerTier };
        },
    },
}));

import {
    isChatLocked,
    openerKeyForContext,
    FREE_TIER_OPENER_KEYS,
} from '../free-tier-gate';
import type { ChatContext } from '@/lib/stores/floating-chat-store';

beforeEach(() => {
    mockAiAccess = 'entitled';
    mockServerTier = 'starter';
    mockThrows = false;
});

describe('isChatLocked', () => {
    it('locks only when the SERVER has confirmed no plan', () => {
        mockAiAccess = 'locked';
        mockServerTier = 'none';

        expect(isChatLocked()).toBe(true);
    });

    it('does not lock a paying subscriber', () => {
        expect(isChatLocked()).toBe(false);
    });

    it('does NOT lock while the server is still silent, even if the verdict says locked', () => {
        // The cold-start trap: RevenueCat answers 'locked' from an empty cache
        // seconds before our userBilling round trip lands.
        mockAiAccess = 'locked';
        mockServerTier = null;

        expect(isChatLocked()).toBe(false);
    });

    it('does not lock on an unknown verdict', () => {
        mockAiAccess = 'unknown';
        mockServerTier = null;

        expect(isChatLocked()).toBe(false);
    });

    it('fails OPEN when the store throws', () => {
        mockThrows = true;

        expect(isChatLocked()).toBe(false);
    });
});

describe('openerKeyForContext', () => {
    it('answers a track tap with the follow-story line, not the feedback one', () => {
        // Same context kind as the five tuning surfaces, different intent: the
        // user asked to FOLLOW, so the feed-tuning copy would not answer them.
        const ctx = {
            kind: 'article-suggestion',
            articleId: 'a1',
            trackSubject: { articleId: 'a1' },
        } as unknown as ChatContext;

        expect(openerKeyForContext(ctx)).toBe(FREE_TIER_OPENER_KEYS.followStory);
    });

    it('collapses the tuning surfaces onto one line', () => {
        const ctx = { kind: 'article-suggestion', articleId: 'a1' } as ChatContext;

        expect(openerKeyForContext(ctx)).toBe(FREE_TIER_OPENER_KEYS.articleFeedback);
    });

    it.each([
        ['follow-story', FREE_TIER_OPENER_KEYS.followStory],
        ['persona', FREE_TIER_OPENER_KEYS.persona],
        ['optimisation-plan', FREE_TIER_OPENER_KEYS.optimisationPlan],
    ])('maps %s to its own opener', (kind, expected) => {
        expect(openerKeyForContext({ kind } as ChatContext)).toBe(expected);
    });

    it('maps the fact-check tick to the fact-check opener', () => {
        const ctx = { kind: 'fact-check', articleId: 'a1' } as ChatContext;

        expect(openerKeyForContext(ctx)).toBe(FREE_TIER_OPENER_KEYS.factCheck);
    });

    it('maps the tutorial Ask Mera button to the help opener', () => {
        const ctx = { kind: 'generic', route: '/tutorials/x' } as ChatContext;

        expect(openerKeyForContext(ctx)).toBe(FREE_TIER_OPENER_KEYS.tutorialHelp);
    });

    it('every surface resolves to a key that exists in the opener map', () => {
        // Guards the swap-in of a new ChatContext kind: a `default` fallthrough
        // is fine, a key nothing defines is a raw dot-path rendered at a user.
        const keys = Object.values(FREE_TIER_OPENER_KEYS);
        for (const kind of [
            'persona',
            'article-suggestion',
            'optimisation-plan',
            'follow-story',
            'fact-check',
            'generic',
        ]) {
            expect(keys).toContain(openerKeyForContext({ kind } as ChatContext));
        }
    });
});
