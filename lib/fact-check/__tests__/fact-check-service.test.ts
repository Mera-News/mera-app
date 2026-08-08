// fact-check-service — the two GraphQL calls behind the fact-check panel.
// Both must run `no-cache`: a poll that reads its own previous answer out of
// the Apollo cache never terminates.

const mockQuery = jest.fn();
const mockMutate = jest.fn();

jest.mock('@/lib/apollo-client', () => ({
    __esModule: true,
    default: {
        query: (...a: any[]) => mockQuery(...a),
        mutate: (...a: any[]) => mockMutate(...a),
    },
}));

import { FactCheckService } from '../fact-check-service';

const ROW = { _id: 'fc1', status: 'pending', verdict: null, claims: [], citations: [] };

describe('FactCheckService.requestFactCheck', () => {
    beforeEach(() => jest.clearAllMocks());

    it('sends the article id and returns the row', async () => {
        mockMutate.mockResolvedValue({ data: { requestFactCheck: ROW } });
        await expect(FactCheckService.requestFactCheck('a1')).resolves.toEqual(ROW);
        expect(mockMutate).toHaveBeenCalledTimes(1);
        const args = mockMutate.mock.calls[0][0];
        expect(args.variables).toEqual({ articleId: 'a1' });
        expect(args.fetchPolicy).toBe('no-cache');
    });

    it('returns null when the mutation comes back empty', async () => {
        mockMutate.mockResolvedValue({ data: null });
        await expect(FactCheckService.requestFactCheck('a1')).resolves.toBeNull();
    });

    it('propagates a transport/NotFound failure to the caller', async () => {
        mockMutate.mockRejectedValue(new Error('boom'));
        await expect(FactCheckService.requestFactCheck('a1')).rejects.toThrow('boom');
    });
});

describe('FactCheckService.getFactCheck', () => {
    beforeEach(() => jest.clearAllMocks());

    it('sends the article id and returns the row', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: { ...ROW, status: 'complete' } } });
        const row = await FactCheckService.getFactCheck('a1');
        expect(row?.status).toBe('complete');
        const args = mockQuery.mock.calls[0][0];
        expect(args.variables).toEqual({ articleId: 'a1' });
        expect(args.fetchPolicy).toBe('no-cache');
    });

    it('treats a null row as "nobody has asked yet", not an error', async () => {
        mockQuery.mockResolvedValue({ data: { factCheck: null } });
        await expect(FactCheckService.getFactCheck('a1')).resolves.toBeNull();
    });

    it('returns null when data itself is absent', async () => {
        mockQuery.mockResolvedValue({ data: undefined });
        await expect(FactCheckService.getFactCheck('a1')).resolves.toBeNull();
    });
});
