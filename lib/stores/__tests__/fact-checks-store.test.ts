// fact-checks-store — the shared table mirror. The load/refresh reads are
// trivial; what earns a suite is `remove`, which since the retention wave also
// releases the article snapshot kept for the deleted check.

const mockDeleteFactCheck = jest.fn();
const mockListFactChecks = jest.fn();
jest.mock('../../database/services/fact-check-record-service', () => ({
    deleteFactCheck: (...a: unknown[]) => mockDeleteFactCheck(...a),
    listFactChecks: (...a: unknown[]) => mockListFactChecks(...a),
}));

const mockReleaseRetention = jest.fn();
jest.mock('../../database/services/saved-article-suggestion-service', () => ({
    releaseFactCheckRetention: (...a: unknown[]) => mockReleaseRetention(...a),
}));

const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();
jest.mock('../../database/services/setting-service', () => ({
    getSetting: (...a: unknown[]) => mockGetSetting(...a),
    setSetting: (...a: unknown[]) => mockSetSetting(...a),
}));

import { CHECKS_SEEN_AT_SETTING_KEY, isUnseenDone, useFactChecksStore } from '../fact-checks-store';

const ITEM = {
    id: 'row-1',
    articleId: 'art-1',
    factCheckId: 'fc-1',
    articleTitle: 'A headline',
    status: 'complete',
    verdict: 'supported',
    payload: null,
    requestedAt: 1,
    resolvedAt: 2,
    claim: null,
    claimKey: null,
};

beforeEach(() => {
    jest.clearAllMocks();
    mockListFactChecks.mockResolvedValue([ITEM]);
    mockDeleteFactCheck.mockResolvedValue(true);
    mockReleaseRetention.mockResolvedValue(false);
    mockGetSetting.mockResolvedValue('1000');
    mockSetSetting.mockResolvedValue(undefined);
    useFactChecksStore.setState({ items: [], hydrated: false, refreshing: false, seenAt: null });
});

describe('load', () => {
    it('reads the local table and marks the store hydrated', async () => {
        await useFactChecksStore.getState().load();
        expect(useFactChecksStore.getState().items).toEqual([ITEM]);
        expect(useFactChecksStore.getState().hydrated).toBe(true);
    });
});

describe('remove', () => {
    it('optimistically drops the row, deletes it, then releases the retention snapshot', async () => {
        useFactChecksStore.setState({ items: [ITEM], hydrated: true });

        await useFactChecksStore.getState().remove('row-1');

        expect(useFactChecksStore.getState().items).toEqual([]);
        expect(mockDeleteFactCheck).toHaveBeenCalledWith('row-1');
        // The release runs AFTER the delete — it decides "last check gone?" by
        // reading what the delete left behind.
        expect(mockReleaseRetention).toHaveBeenCalledWith('art-1');
        const deleteOrder = mockDeleteFactCheck.mock.invocationCallOrder[0];
        const releaseOrder = mockReleaseRetention.mock.invocationCallOrder[0];
        expect(releaseOrder).toBeGreaterThan(deleteOrder);
    });

    it('does not attempt a release when the row is not in the store', async () => {
        useFactChecksStore.setState({ items: [ITEM], hydrated: true });

        await useFactChecksStore.getState().remove('unknown-row');

        expect(mockDeleteFactCheck).toHaveBeenCalledWith('unknown-row');
        expect(mockReleaseRetention).not.toHaveBeenCalled();
    });
});

describe('the Fact checks dot', () => {
    it('counts a finished check only when it finished after the page was seen', () => {
        expect(isUnseenDone({ status: 'complete', resolvedAt: 1001 }, 1000)).toBe(true);
        expect(isUnseenDone({ status: 'complete', resolvedAt: 1000 }, 1000)).toBe(false);
        expect(isUnseenDone({ status: 'pending', resolvedAt: 5000 }, 1000)).toBe(false);
        expect(isUnseenDone({ status: 'blocked', resolvedAt: 5000 }, null)).toBe(false);
    });

    it('load reads the seen time with the items', async () => {
        await useFactChecksStore.getState().load();
        expect(useFactChecksStore.getState().seenAt).toBe(1000);
        expect(mockSetSetting).not.toHaveBeenCalled();
    });

    it('a first load on this phone sets today as the baseline, so old checks never light the dot', async () => {
        mockGetSetting.mockResolvedValue(null);
        const before = Date.now();
        await useFactChecksStore.getState().load();
        const seenAt = useFactChecksStore.getState().seenAt ?? 0;
        expect(seenAt).toBeGreaterThanOrEqual(before);
        expect(mockSetSetting).toHaveBeenCalledWith(CHECKS_SEEN_AT_SETTING_KEY, String(seenAt));
    });
});
