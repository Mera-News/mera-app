// ai-lock.test.ts — recordAiLocked(source) sets the shared locked flag and
// triggers a forced re-sync.

const mockMarkServerLocked = jest.fn();
let mockServerTier: string | null = null;

jest.mock('@/lib/stores/subscription-store', () => ({
    useSubscriptionStore: {
        getState: jest.fn(() => ({
            get serverTier() {
                return mockServerTier;
            },
            markServerLocked: mockMarkServerLocked,
        })),
    },
}));

const mockSyncEntitlement = jest.fn();
jest.mock('../entitlement-sync', () => ({
    syncEntitlement: (...a: any[]) => mockSyncEntitlement(...a),
}));

const mockAddBreadcrumb = jest.fn();
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        addBreadcrumb: (...a: any[]) => mockAddBreadcrumb(...a),
    },
}));

import { recordAiLocked } from '../ai-lock';

describe('recordAiLocked', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockServerTier = null;
    });

    it('marks the store locked', () => {
        recordAiLocked('topics');
        expect(mockMarkServerLocked).toHaveBeenCalledTimes(1);
    });

    it('forces a re-sync (bypassing the debounce) regardless of source', () => {
        recordAiLocked('persona');
        expect(mockSyncEntitlement).toHaveBeenCalledWith({ force: true });
    });

    it('records a breadcrumb with the source on the first 402 (serverTier not yet "none")', () => {
        mockServerTier = 'individual';
        recordAiLocked('hydrate');
        expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1);
        expect(mockAddBreadcrumb).toHaveBeenCalledWith(
            '[ai-lock] AI layer locked by a 402',
            'subscription',
            { source: 'hydrate' },
        );
    });

    it('does not add a second breadcrumb when the device is already locked', () => {
        mockServerTier = 'none';
        recordAiLocked('stories');
        expect(mockAddBreadcrumb).not.toHaveBeenCalled();
        // markServerLocked and the forced re-sync still happen every call —
        // only the breadcrumb is deduped.
        expect(mockMarkServerLocked).toHaveBeenCalledTimes(1);
        expect(mockSyncEntitlement).toHaveBeenCalledWith({ force: true });
    });

    it.each(['topics', 'persona', 'hydrate', 'stories'] as const)(
        'accepts every AiLockSource value: %s',
        (source) => {
            recordAiLocked(source);
            expect(mockMarkServerLocked).toHaveBeenCalledTimes(1);
        },
    );
});

export {};
