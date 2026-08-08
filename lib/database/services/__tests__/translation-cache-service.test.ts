// The persisted translation cache — the second-launch win.
//
// What matters here: writes are BATCHED (a fast scroll must not become dozens
// of SQLite transactions), reads come back as the store's plain Map, the key is
// (source text, target language) so two languages never collide, and a hash
// collision degrades to a miss rather than a wrong translation.

jest.mock('@/lib/database/index', () => {
    const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
    return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';
import {
    __resetTranslationCacheBufferForTests,
    __translationCacheBufferSizeForTests,
    flushTranslationCacheWrites,
    hashSourceText,
    loadTranslationCache,
    rememberTranslation,
    sweepTranslationCache,
    translationCacheId,
    TRANSLATION_CACHE_FLUSH_DEBOUNCE_MS,
    TRANSLATION_CACHE_FLUSH_MAX_BUFFER,
    TRANSLATION_CACHE_TTL_DAYS,
} from '../translation-cache-service';

const db = database as unknown as MockDatabase;

function cacheCollection() {
    return db._collections['translation_cache'];
}

function row(overrides: Record<string, unknown>) {
    return makeRecord({ _raw: {}, ...overrides });
}

beforeEach(() => {
    jest.clearAllMocks();
    __resetTranslationCacheBufferForTests();
    db._setRows('translation_cache', []);
    // The shared collection mock's prepareCreate builds a record with no `_raw`;
    // give it one so the id-seeding the service does is observable.
    const collection = cacheCollection();
    collection.prepareCreate = jest.fn((fn?: (r: any) => void) => {
        const rec = row({});
        fn?.(rec);
        return rec;
    });
    // The collection object is stable across tests, so a test that swaps in a
    // throwing `query` would poison every later one. Rebuild it here.
    collection.query = jest.fn(() => ({
        fetch: jest.fn(async () => collection._rows),
        fetchCount: jest.fn(async () => collection._rows.length),
    })) as any;
});

describe('hashSourceText / translationCacheId', () => {
    it('is stable for the same input', () => {
        expect(hashSourceText('Breaking news')).toBe(hashSourceText('Breaking news'));
    });

    it('separates texts that differ only in a trailing character', () => {
        expect(hashSourceText('Headline a')).not.toBe(hashSourceText('Headline b'));
    });

    it('separates texts that differ only in length', () => {
        expect(hashSourceText('Headline')).not.toBe(hashSourceText('Headline '));
    });

    it('keys the row by BOTH text and target language', () => {
        expect(translationCacheId('Hello', 'de')).not.toBe(translationCacheId('Hello', 'fr'));
        expect(translationCacheId('Hello', 'de')).toBe(translationCacheId('Hello', 'de'));
    });

    it('produces an id of the documented `${hash}:${lang}` shape', () => {
        expect(translationCacheId('Hello', 'de')).toBe(`${hashSourceText('Hello')}:de`);
    });
});

describe('rememberTranslation buffering', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('does not write immediately', () => {
        rememberTranslation('Breaking news', 'de', 'Eilmeldung');
        expect(db.write).not.toHaveBeenCalled();
        expect(__translationCacheBufferSizeForTests()).toBe(1);
    });

    it('coalesces a whole scroll into ONE write after the debounce', async () => {
        for (let i = 0; i < 20; i++) {
            rememberTranslation(`Headline ${i}`, 'de', `Schlagzeile ${i}`);
        }
        expect(db.write).not.toHaveBeenCalled();

        jest.advanceTimersByTime(TRANSLATION_CACHE_FLUSH_DEBOUNCE_MS);
        await flushTranslationCacheWrites();

        expect(db.write).toHaveBeenCalledTimes(1);
        expect(db.batch).toHaveBeenCalledTimes(1);
        expect((db.batch.mock.calls[0] as unknown[]).length).toBe(20);
    });

    it('coalesces repeats of the same (text, language) into one row', async () => {
        rememberTranslation('Breaking news', 'de', 'Eilmeldung');
        rememberTranslation('Breaking news', 'de', 'Eilmeldung (v2)');
        expect(__translationCacheBufferSizeForTests()).toBe(1);

        await flushTranslationCacheWrites();
        const created = db.batch.mock.calls[0][0] as any;
        expect(created.translatedText).toBe('Eilmeldung (v2)');
    });

    it('flushes without waiting once the buffer cap is reached', async () => {
        for (let i = 0; i < TRANSLATION_CACHE_FLUSH_MAX_BUFFER; i++) {
            rememberTranslation(`Headline ${i}`, 'de', `Schlagzeile ${i}`);
        }
        // No timer advance — the cap alone triggers the flush.
        await Promise.resolve();
        await Promise.resolve();
        expect(db.write).toHaveBeenCalled();
    });

    it('ignores empty inputs rather than persisting junk', () => {
        rememberTranslation('', 'de', 'x');
        rememberTranslation('x', '', 'y');
        rememberTranslation('x', 'de', '');
        expect(__translationCacheBufferSizeForTests()).toBe(0);
    });
});

describe('flushTranslationCacheWrites', () => {
    it('is a no-op with nothing buffered', async () => {
        await flushTranslationCacheWrites();
        expect(db.write).not.toHaveBeenCalled();
    });

    it('seeds the row id with `${hash}:${lang}` so reads are primary-key hits', async () => {
        rememberTranslation('Breaking news', 'de', 'Eilmeldung');
        await flushTranslationCacheWrites();
        const created = db.batch.mock.calls[0][0] as any;
        expect(created._raw.id).toBe(translationCacheId('Breaking news', 'de'));
        expect(created.sourceText).toBe('Breaking news');
        expect(created.targetLang).toBe('de');
        expect(created.translatedText).toBe('Eilmeldung');
    });

    it('updates an existing row instead of inserting a duplicate', async () => {
        const existing = row({
            id: translationCacheId('Breaking news', 'de'),
            sourceText: 'Breaking news',
            targetLang: 'de',
            translatedText: 'stale',
        });
        db._setRows('translation_cache', [existing]);

        rememberTranslation('Breaking news', 'de', 'Eilmeldung');
        await flushTranslationCacheWrites();

        expect(existing.prepareUpdate).toHaveBeenCalled();
        expect(existing.translatedText).toBe('Eilmeldung');
        expect(cacheCollection().prepareCreate).not.toHaveBeenCalled();
    });

    it('swallows a write failure — a cache miss must never break the app', async () => {
        db.write.mockImplementationOnce(async () => {
            throw new Error('disk full');
        });
        rememberTranslation('Breaking news', 'de', 'Eilmeldung');
        await expect(flushTranslationCacheWrites()).resolves.toBeUndefined();
    });
});

describe('loadTranslationCache', () => {
    it('returns the sourceText → translatedText Map the store holds', async () => {
        db._setRows('translation_cache', [
            row({ sourceText: 'Breaking news', translatedText: 'Eilmeldung' }),
            row({ sourceText: 'Markets rally', translatedText: 'Märkte erholen sich' }),
        ]);

        const loaded = await loadTranslationCache('de');
        expect(loaded.get('Breaking news')).toBe('Eilmeldung');
        expect(loaded.get('Markets rally')).toBe('Märkte erholen sich');
    });

    it('never queries for English — nothing is ever translated INTO it', async () => {
        const loaded = await loadTranslationCache('en');
        expect(loaded.size).toBe(0);
        expect(cacheCollection().query).not.toHaveBeenCalled();
    });

    it('skips rows missing either side of the pair', async () => {
        db._setRows('translation_cache', [
            row({ sourceText: 'Breaking news', translatedText: '' }),
            row({ sourceText: '', translatedText: 'Eilmeldung' }),
        ]);
        const loaded = await loadTranslationCache('de');
        expect(loaded.size).toBe(0);
    });

    it('returns an empty Map when the query throws', async () => {
        cacheCollection().query = jest.fn(() => {
            throw new Error('db closed');
        });
        await expect(loadTranslationCache('de')).resolves.toEqual(new Map());
    });
});

describe('sweepTranslationCache', () => {
    it('destroys the rows the query returns and reports the count', async () => {
        const stale = [row({ id: 'a' }), row({ id: 'b' })];
        db._setRows('translation_cache', stale);

        const removed = await sweepTranslationCache(TRANSLATION_CACHE_TTL_DAYS);

        expect(removed).toBe(2);
        expect(stale[0].prepareDestroyPermanently).toHaveBeenCalled();
        expect(db.write).toHaveBeenCalledTimes(1);
    });

    it('does not open a write transaction when nothing is stale', async () => {
        db._setRows('translation_cache', []);
        await expect(sweepTranslationCache()).resolves.toBe(0);
        expect(db.write).not.toHaveBeenCalled();
    });

    it('returns 0 rather than throwing when the sweep fails', async () => {
        cacheCollection().query = jest.fn(() => {
            throw new Error('db closed');
        });
        await expect(sweepTranslationCache()).resolves.toBe(0);
    });
});
