// useStoredFactCheck — the article-detail "no longer available" lookup.
//
// Two properties. The `enabled` gate is the important one: this exists only for
// the 48h-expired case, and a version that read on every article open would put
// a WatermelonDB query on the hot path of the app's most-opened screen for a
// state that is almost never showing.
//
// PLURAL post-v52: an article can carry a legacy whole-article row plus one row
// per claim the user picked, and the orphan card must show all of them — this
// is asserted here rather than assumed, because a version that silently kept
// the old array[0] shape would drop every claim after the first without any
// test noticing.

const mockListForArticle = jest.fn((..._a: any[]) => Promise.resolve([] as any[]));
jest.mock('@/lib/database/services/fact-check-record-service', () => ({
    listFactChecksForArticle: (...a: any[]) => mockListForArticle(...(a as [string])),
}));

import { renderHook, waitFor } from '@testing-library/react-native';
import { useStoredFactCheck } from '../use-stored-fact-check';

const rows = [
    { id: 'r1', articleId: 'a1', status: 'complete', claim: 'Claim one' },
    { id: 'r2', articleId: 'a1', status: 'complete', claim: 'Claim two' },
] as any[];

describe('useStoredFactCheck', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockListForArticle.mockResolvedValue([]);
    });

    it('does not touch the database while disabled — the normal article open', () => {
        renderHook(() => useStoredFactCheck('a1', false));
        expect(mockListForArticle).not.toHaveBeenCalled();
    });

    it('reads every row once the article is known to be unavailable', async () => {
        mockListForArticle.mockResolvedValue(rows);
        const { result } = renderHook(() => useStoredFactCheck('a1', true));
        await waitFor(() => expect(result.current).toEqual(rows));
        expect(mockListForArticle).toHaveBeenCalledWith('a1');
        // The regression this file exists to catch: not just the first row.
        expect(result.current).toHaveLength(2);
    });

    it('starts reading when the gate flips, not before', async () => {
        mockListForArticle.mockResolvedValue(rows);
        const { rerender, result } = renderHook(
            ({ on }: { on: boolean }) => useStoredFactCheck('a1', on),
            { initialProps: { on: false } },
        );
        expect(mockListForArticle).not.toHaveBeenCalled();

        rerender({ on: true });
        await waitFor(() => expect(result.current).toEqual(rows));
    });

    it('returns an empty array when this device holds no check for the article', async () => {
        const { result } = renderHook(() => useStoredFactCheck('a1', true));
        await waitFor(() => expect(mockListForArticle).toHaveBeenCalled());
        expect(result.current).toEqual([]);
    });

    it('does nothing without an article id', () => {
        renderHook(() => useStoredFactCheck(null, true));
        expect(mockListForArticle).not.toHaveBeenCalled();
    });
});
