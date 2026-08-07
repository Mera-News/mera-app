// Mocked wholesale (not `requireActual` + spread) — the real module imports
// `@/lib/apollo-client`, which pulls in the full app dependency graph
// (WatermelonDB, native SQLite adapter) that this hook-only suite has no
// business loading. `SEARCH_NEWS_MIN_QUERY_LENGTH` is hardcoded here to match
// the real constant — search-news-service.test.ts is what guards the real
// value (it asserts `SEARCH_NEWS_MIN_QUERY_LENGTH === 2` directly).
const mockSearchNews = jest.fn();
jest.mock('../search-news-service', () => ({
    SEARCH_NEWS_MIN_QUERY_LENGTH: 2,
    searchNews: (...a: any[]) => mockSearchNews(...a),
}));

const mockCaptureException = jest.fn();
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: (...a: any[]) => mockCaptureException(...a) },
}));

import { act, renderHook } from '@testing-library/react-native';
import { NEWS_SEARCH_DEBOUNCE_MS, useNewsSearch } from '../use-news-search';

const makeHit = (id: string) => ({
    _id: id,
    title_en: `Headline ${id}`,
    image_url: null,
    publication_name: 'Example Times',
    country_code: 'US',
    pubDate: '2026-08-07T00:00:00.000Z',
    score: 0.9,
});

// Advances the debounce timer, then flushes the microtask queue the resulting
// promise resolves on — fake timers only control setTimeout, not Promise
// microtasks (mirrors SourcesL1CountryList.test.tsx's flushDebounceAndSearch).
const flush = async (ms: number = NEWS_SEARCH_DEBOUNCE_MS + 50) => {
    await act(async () => {
        jest.advanceTimersByTime(ms);
        await Promise.resolve();
        await Promise.resolve();
    });
};

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
});

afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
});

describe('useNewsSearch', () => {
    it('starts idle, inactive, with no hits', () => {
        const { result } = renderHook(() => useNewsSearch());
        expect(result.current.status).toBe('idle');
        expect(result.current.isActive).toBe(false);
        expect(result.current.hits).toEqual([]);
        expect(result.current.errorKind).toBeNull();
    });

    it('is active as soon as any text is typed, even below the 2-char floor', () => {
        const { result } = renderHook(() => useNewsSearch());
        act(() => result.current.setQuery('a'));
        expect(result.current.isActive).toBe(true);
        expect(result.current.status).toBe('idle');
        expect(mockSearchNews).not.toHaveBeenCalled();
    });

    it('does not fetch below the minimum length even after the debounce window', async () => {
        const { result } = renderHook(() => useNewsSearch());
        act(() => result.current.setQuery('a'));
        await flush();
        expect(mockSearchNews).not.toHaveBeenCalled();
        expect(result.current.status).toBe('idle');
    });

    it('sets loading immediately at 2+ chars, then fetches after the debounce settles', async () => {
        mockSearchNews.mockResolvedValue({ ok: true, hits: [] });
        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('ab'));
        expect(result.current.status).toBe('loading');
        expect(mockSearchNews).not.toHaveBeenCalled(); // not yet — still debouncing

        await flush();
        expect(mockSearchNews).toHaveBeenCalledTimes(1);
        expect(mockSearchNews).toHaveBeenCalledWith('ab');
    });

    it('coalesces rapid typing — only the final query is fetched', async () => {
        mockSearchNews.mockResolvedValue({ ok: true, hits: [] });
        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('ab'));
        await act(async () => jest.advanceTimersByTime(100));
        act(() => result.current.setQuery('abc'));
        await act(async () => jest.advanceTimersByTime(100));
        act(() => result.current.setQuery('abcd'));

        await flush();
        expect(mockSearchNews).toHaveBeenCalledTimes(1);
        expect(mockSearchNews).toHaveBeenCalledWith('abcd');
    });

    it('populates hits and flips to success on a successful response', async () => {
        const hits = [makeHit('1'), makeHit('2')];
        mockSearchNews.mockResolvedValue({ ok: true, hits });
        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('modi india'));
        await flush();

        expect(result.current.status).toBe('success');
        expect(result.current.hits).toEqual(hits);
        expect(result.current.errorKind).toBeNull();
    });

    it('surfaces a not-subscribed error without hits', async () => {
        mockSearchNews.mockResolvedValue({ ok: false, kind: 'not-subscribed' });
        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('modi india'));
        await flush();

        expect(result.current.status).toBe('error');
        expect(result.current.errorKind).toBe('not-subscribed');
        expect(result.current.hits).toEqual([]);
    });

    it('surfaces an unknown error', async () => {
        mockSearchNews.mockResolvedValue({ ok: false, kind: 'unknown' });
        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('modi india'));
        await flush();

        expect(result.current.status).toBe('error');
        expect(result.current.errorKind).toBe('unknown');
    });

    it('defends against a rejected promise (searchNews itself never rejects, but the hook does not trust that blindly)', async () => {
        mockSearchNews.mockRejectedValue(new Error('boom'));
        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('modi india'));
        await flush();

        expect(result.current.status).toBe('error');
        expect(result.current.errorKind).toBe('unknown');
        expect(mockCaptureException).toHaveBeenCalledTimes(1);
    });

    it('clearing below the floor immediately resets state without waiting for the debounce', async () => {
        mockSearchNews.mockResolvedValue({ ok: true, hits: [makeHit('1')] });
        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('modi india'));
        await flush();
        expect(result.current.status).toBe('success');

        act(() => result.current.setQuery(''));
        // No flush — the reset is synchronous with the effect, not debounced.
        expect(result.current.status).toBe('idle');
        expect(result.current.hits).toEqual([]);
        expect(result.current.isActive).toBe(false);
    });

    it('clear() resets the query and returns to idle', async () => {
        mockSearchNews.mockResolvedValue({ ok: true, hits: [makeHit('1')] });
        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('modi india'));
        await flush();
        act(() => result.current.clear());

        expect(result.current.query).toBe('');
        expect(result.current.status).toBe('idle');
        expect(result.current.hits).toEqual([]);
    });

    it('a stale response cannot clobber a newer one (out-of-order resolution)', async () => {
        let resolveFirst: (v: any) => void = () => {};
        const first = new Promise((resolve) => {
            resolveFirst = resolve;
        });
        mockSearchNews.mockImplementationOnce(() => first);
        mockSearchNews.mockResolvedValueOnce({ ok: true, hits: [makeHit('second')] });

        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('ab'));
        await flush();
        expect(mockSearchNews).toHaveBeenCalledTimes(1);

        // Second keystroke fires a second (faster) request that resolves first.
        act(() => result.current.setQuery('abc'));
        await flush();
        expect(result.current.hits).toEqual([makeHit('second')]);

        // The slow first request now resolves — it must be ignored.
        await act(async () => {
            resolveFirst({ ok: true, hits: [makeHit('first-stale')] });
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(result.current.hits).toEqual([makeHit('second')]);
    });

    it('retry() re-fetches immediately, bypassing the debounce', async () => {
        mockSearchNews.mockResolvedValueOnce({ ok: false, kind: 'unknown' });
        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('modi india'));
        await flush();
        expect(result.current.status).toBe('error');
        expect(mockSearchNews).toHaveBeenCalledTimes(1);

        mockSearchNews.mockResolvedValueOnce({ ok: true, hits: [makeHit('1')] });
        act(() => result.current.retry());
        expect(result.current.status).toBe('loading');

        // No debounce wait needed — flush only the microtask queue.
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mockSearchNews).toHaveBeenCalledTimes(2);
        expect(result.current.status).toBe('success');
        expect(result.current.hits).toEqual([makeHit('1')]);
    });

    it('retry() is a no-op below the minimum length', () => {
        const { result } = renderHook(() => useNewsSearch());
        act(() => result.current.setQuery('a'));
        act(() => result.current.retry());
        expect(mockSearchNews).not.toHaveBeenCalled();
        expect(result.current.status).toBe('idle');
    });

    it('retry() cancels a still-pending debounced fetch rather than firing it twice', async () => {
        mockSearchNews.mockResolvedValueOnce({ ok: true, hits: [makeHit('retried')] });
        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('modi india'));
        // Retry before the debounce timer has fired — must cancel it, not
        // race it.
        act(() => result.current.retry());

        await act(async () => {
            jest.advanceTimersByTime(NEWS_SEARCH_DEBOUNCE_MS + 50);
            await Promise.resolve();
            await Promise.resolve();
        });
        // Exactly one fetch: the retry's own, immediate call. The original
        // debounced timer must not also have fired.
        expect(mockSearchNews).toHaveBeenCalledTimes(1);
        expect(result.current.hits).toEqual([makeHit('retried')]);
    });

    it('a stale REJECTED response is also ignored, not just a stale resolution', async () => {
        let rejectFirst: (e: unknown) => void = () => {};
        const first = new Promise((_resolve, reject) => {
            rejectFirst = reject;
        });
        mockSearchNews.mockImplementationOnce(() => first);
        mockSearchNews.mockResolvedValueOnce({ ok: true, hits: [makeHit('second')] });

        const { result } = renderHook(() => useNewsSearch());

        act(() => result.current.setQuery('ab'));
        await flush();
        act(() => result.current.setQuery('abc'));
        await flush();
        expect(result.current.hits).toEqual([makeHit('second')]);

        // The slow first request now rejects — must not clobber the newer
        // success, and must not report a superseded failure to Sentry either.
        await act(async () => {
            rejectFirst(new Error('stale network error'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(result.current.status).toBe('success');
        expect(result.current.hits).toEqual([makeHit('second')]);
        expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it('respects a custom debounce window', async () => {
        mockSearchNews.mockResolvedValue({ ok: true, hits: [] });
        const { result } = renderHook(() => useNewsSearch(1000));

        act(() => result.current.setQuery('ab'));
        await act(async () => jest.advanceTimersByTime(500));
        expect(mockSearchNews).not.toHaveBeenCalled();

        await act(async () => {
            jest.advanceTimersByTime(600);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(mockSearchNews).toHaveBeenCalledTimes(1);
    });
});
