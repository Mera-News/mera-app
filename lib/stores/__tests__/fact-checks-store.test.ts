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

import { useFactChecksStore } from '../fact-checks-store';

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
    useFactChecksStore.setState({ items: [], hydrated: false, refreshing: false });
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
