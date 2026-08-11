// useStoredFactCheck — the article-detail "no longer available" lookup.
//
// Two properties. The `enabled` gate is the important one: this exists only for
// the 48h-expired case, and a version that read on every article open would put
// a WatermelonDB query on the hot path of the app's most-opened screen for a
// state that is almost never showing.

const mockGetStored = jest.fn((..._a: any[]) => Promise.resolve(null as any));
jest.mock('@/lib/database/services/fact-check-record-service', () => ({
    getFactCheckForArticle: (...a: any[]) => mockGetStored(...(a as [string])),
}));

import { renderHook, waitFor } from '@testing-library/react-native';
import { useStoredFactCheck } from '../use-stored-fact-check';

const row = { id: 'r1', articleId: 'a1', status: 'complete' } as any;

describe('useStoredFactCheck', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockGetStored.mockResolvedValue(null as any);
    });

    it('does not touch the database while disabled — the normal article open', () => {
        renderHook(() => useStoredFactCheck('a1', false));
        expect(mockGetStored).not.toHaveBeenCalled();
    });

    it('reads once the article is known to be unavailable', async () => {
        mockGetStored.mockResolvedValue(row);
        const { result } = renderHook(() => useStoredFactCheck('a1', true));
        await waitFor(() => expect(result.current).toEqual(row));
        expect(mockGetStored).toHaveBeenCalledWith('a1');
    });

    it('starts reading when the gate flips, not before', async () => {
        mockGetStored.mockResolvedValue(row);
        const { rerender, result } = renderHook(
            ({ on }: { on: boolean }) => useStoredFactCheck('a1', on),
            { initialProps: { on: false } },
        );
        expect(mockGetStored).not.toHaveBeenCalled();

        rerender({ on: true });
        await waitFor(() => expect(result.current).toEqual(row));
    });

    it('returns null when this device holds no check for the article', async () => {
        const { result } = renderHook(() => useStoredFactCheck('a1', true));
        await waitFor(() => expect(mockGetStored).toHaveBeenCalled());
        expect(result.current).toBeNull();
    });

    it('does nothing without an article id', () => {
        renderHook(() => useStoredFactCheck(null, true));
        expect(mockGetStored).not.toHaveBeenCalled();
    });
});
