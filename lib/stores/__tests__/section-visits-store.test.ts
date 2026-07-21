// section-visits-store — hydrate (parse + prune + merge), markVisited
// (synchronous update + fire-and-forget persist). setting-service is mocked so
// importing the store never touches a real WatermelonDB.

const mockGetSetting = jest.fn((_key: string): Promise<string | null> => Promise.resolve(null));
const mockSetSetting = jest.fn((_key: string, _value: string) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (key: string) => mockGetSetting(key),
    setSetting: (key: string, value: string) => mockSetSetting(key, value),
    deleteSetting: jest.fn(() => Promise.resolve()),
}));

const mockCaptureException = jest.fn();

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: (...args: unknown[]) => mockCaptureException(...args),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

import { useSectionVisitsStore, SECTION_VISIT_RETENTION_MS } from '../section-visits-store';

describe('useSectionVisitsStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useSectionVisitsStore.setState({ visits: {}, hydrated: false });
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts with visits: {} and hydrated: false', () => {
        const state = useSectionVisitsStore.getState();
        expect(state.visits).toEqual({});
        expect(state.hydrated).toBe(false);
    });

    // ── hydrate — happy path ───────────────────────────────────────────────
    it('hydrate parses stored JSON into visits and flips hydrated', async () => {
        const now = Date.now();
        mockGetSetting.mockResolvedValueOnce(JSON.stringify({ 'fact-1': now, 'fact-2': now - 1000 }));
        await useSectionVisitsStore.getState().hydrate();
        const state = useSectionVisitsStore.getState();
        expect(state.visits).toEqual({ 'fact-1': now, 'fact-2': now - 1000 });
        expect(state.hydrated).toBe(true);
    });

    it('hydrate reads the correct setting key', async () => {
        mockGetSetting.mockResolvedValueOnce(null);
        await useSectionVisitsStore.getState().hydrate();
        expect(mockGetSetting).toHaveBeenCalledWith('section_last_visited_v1');
    });

    // ── hydrate — null / corrupt JSON ─────────────────────────────────────
    it('hydrate with null DB value falls back to {} and hydrated=true, no throw', async () => {
        mockGetSetting.mockResolvedValueOnce(null);
        await expect(useSectionVisitsStore.getState().hydrate()).resolves.toBeUndefined();
        const state = useSectionVisitsStore.getState();
        expect(state.visits).toEqual({});
        expect(state.hydrated).toBe(true);
    });

    it('hydrate with corrupt JSON falls back to {} and hydrated=true, no throw', async () => {
        mockGetSetting.mockResolvedValueOnce('{not valid json');
        await expect(useSectionVisitsStore.getState().hydrate()).resolves.toBeUndefined();
        const state = useSectionVisitsStore.getState();
        expect(state.visits).toEqual({});
        expect(state.hydrated).toBe(true);
    });

    // ── hydrate — pruning ──────────────────────────────────────────────────
    it('hydrate prunes entries older than the 7d retention window', async () => {
        const now = Date.now();
        const fresh = now - 1000;
        const stale = now - (SECTION_VISIT_RETENTION_MS + 1000);
        mockGetSetting.mockResolvedValueOnce(
            JSON.stringify({ 'fact-fresh': fresh, 'fact-stale': stale }),
        );
        await useSectionVisitsStore.getState().hydrate();
        const state = useSectionVisitsStore.getState();
        expect(state.visits).toEqual({ 'fact-fresh': fresh });
    });

    it('hydrate keeps an entry exactly at the retention boundary', async () => {
        const now = Date.now();
        const boundary = now - SECTION_VISIT_RETENTION_MS;
        mockGetSetting.mockResolvedValueOnce(JSON.stringify({ 'fact-boundary': boundary }));
        await useSectionVisitsStore.getState().hydrate();
        expect(useSectionVisitsStore.getState().visits).toEqual({ 'fact-boundary': boundary });
    });

    // ── hydrate — error path ──────────────────────────────────────────────
    it('hydrate sets hydrated: true even when getSetting throws', async () => {
        mockGetSetting.mockRejectedValueOnce(new Error('db crash'));
        await useSectionVisitsStore.getState().hydrate();
        expect(useSectionVisitsStore.getState().hydrated).toBe(true);
    });

    it('hydrate calls captureException on error', async () => {
        const err = new Error('db crash');
        mockGetSetting.mockRejectedValueOnce(err);
        await useSectionVisitsStore.getState().hydrate();
        expect(mockCaptureException).toHaveBeenCalledWith(
            err,
            expect.objectContaining({ tags: { store: 'section-visits-store' } }),
        );
    });

    // ── hydrate/markVisited race — optimistic merge ───────────────────────
    it('hydrate MERGES an optimistic markVisited that raced ahead of the DB read (optimistic newer wins)', async () => {
        const now = Date.now();
        useSectionVisitsStore.getState().markVisited('fact-optimistic', now);
        mockGetSetting.mockResolvedValueOnce(JSON.stringify({ 'fact-from-db': now - 500 }));
        await useSectionVisitsStore.getState().hydrate();
        const state = useSectionVisitsStore.getState();
        expect(state.visits['fact-optimistic']).toBe(now);
        expect(state.visits['fact-from-db']).toBe(now - 500);
    });

    it('hydrate MERGE keeps the hydrated value when it is newer than the in-memory optimistic value', async () => {
        const now = Date.now();
        useSectionVisitsStore.getState().markVisited('fact-1', now - 10_000);
        mockGetSetting.mockResolvedValueOnce(JSON.stringify({ 'fact-1': now }));
        await useSectionVisitsStore.getState().hydrate();
        expect(useSectionVisitsStore.getState().visits['fact-1']).toBe(now);
    });

    it('hydrate MERGE keeps the optimistic value when it is newer than the hydrated value', async () => {
        const now = Date.now();
        useSectionVisitsStore.getState().markVisited('fact-1', now);
        mockGetSetting.mockResolvedValueOnce(JSON.stringify({ 'fact-1': now - 10_000 }));
        await useSectionVisitsStore.getState().hydrate();
        expect(useSectionVisitsStore.getState().visits['fact-1']).toBe(now);
    });

    // ── markVisited ─────────────────────────────────────────────────────────
    it('markVisited sets visits[factId] to now by default', () => {
        const before = Date.now();
        useSectionVisitsStore.getState().markVisited('fact-a');
        const after = Date.now();
        const value = useSectionVisitsStore.getState().visits['fact-a'];
        expect(value).toBeGreaterThanOrEqual(before);
        expect(value).toBeLessThanOrEqual(after);
    });

    it('markVisited sets visits[factId] to the provided atMs', () => {
        useSectionVisitsStore.getState().markVisited('fact-b', 12345);
        expect(useSectionVisitsStore.getState().visits['fact-b']).toBe(12345);
    });

    it('markVisited works before hydrate completes', () => {
        // No hydrate() called at all — store still unhydrated.
        useSectionVisitsStore.getState().markVisited('fact-early', 999);
        expect(useSectionVisitsStore.getState().visits['fact-early']).toBe(999);
        expect(useSectionVisitsStore.getState().hydrated).toBe(false);
    });

    it('markVisited persists the serialized map via setSetting under SETTING_KEY', async () => {
        useSectionVisitsStore.getState().markVisited('fact-c', 42);
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenCalledWith(
            'section_last_visited_v1',
            JSON.stringify({ 'fact-c': 42 }),
        );
    });

    it('markVisited persists the full accumulated map, not just the latest entry', async () => {
        useSectionVisitsStore.getState().markVisited('fact-1', 1);
        useSectionVisitsStore.getState().markVisited('fact-2', 2);
        await Promise.resolve();
        expect(mockSetSetting).toHaveBeenLastCalledWith(
            'section_last_visited_v1',
            JSON.stringify({ 'fact-1': 1, 'fact-2': 2 }),
        );
    });

    it('markVisited calls captureException when setSetting rejects', async () => {
        const err = new Error('persist fail');
        mockSetSetting.mockRejectedValueOnce(err);
        useSectionVisitsStore.getState().markVisited('fact-d', 1);
        // Drain the microtask queue for the catch handler.
        await new Promise((r) => setTimeout(r, 0));
        expect(mockCaptureException).toHaveBeenCalledWith(
            err,
            expect.objectContaining({ tags: { store: 'section-visits-store' } }),
        );
    });
});
