// translation-cache-service at its seam: the real service over the in-memory DB, the clock faked.
// Replaces lib/database/services/__tests__/translation-cache-service.test.ts. That suite ran on a
// database mock that ignored Q.take, Q.sortBy and every Q.where, so the hydrate limit, the MRU order
// and the TTL cutoff were never exercised. Here they are real.
//
// THE GOLDEN VALUES BELOW ARE STORED. `hashSourceText` is the FNV-1a key written into the persisted
// `translation_cache.id` and `source_hash`; a change to it orphans every row on every device. They
// were computed by the code as it stood before the P4 hash merge. Do not regenerate them to make a
// refactor pass.
import database from '@/lib/database';
import type TranslationCache from '@/lib/database/models/TranslationCache';
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
  TRANSLATION_CACHE_HYDRATE_LIMIT,
  TRANSLATION_CACHE_TTL_DAYS,
} from '@/lib/database/services/translation-cache-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { useStrictClock } from '@/test/helpers';
import { countRows, countWrites, DAY_MS, failNextQuery, quietLogger, resetLocalRecordsMemory, restoreFaults, T0 } from './support';

let log: ReturnType<typeof quietLogger>;
beforeEach(() => {
  resetLocalRecordsMemory();
  log = quietLogger();
});
afterEach(() => {
  restoreFaults();
  resetLocalRecordsMemory();
});

const TABLE = 'translation_cache';
const at = (ms: number) => jest.setSystemTime(ms);
const rowOf = (id: string) => database.get<TranslationCache>(TABLE).find(id);

/** Buffers the pairs at clock time `ms` and writes them. */
async function store(lang: string, pairs: readonly (readonly [string, string])[], ms: number = Date.now()): Promise<void> {
  at(ms);
  for (const [source, translated] of pairs) rememberTranslation(source, lang, translated);
  await flushTranslationCacheWrites();
}

// ---------------------------------------------------------------------------
// Golden values (the P4 byte-identity guard)
// ---------------------------------------------------------------------------

const LONG_HEADLINE =
  'Prime Minister announces sweeping reforms to national health service funding after months of negotiation with unions and regional authorities';

describe('hashSourceText: golden values', () => {
  it.each<[string, string, string]>([
    ['empty', '', '811c9dc50'],
    ['one ASCII letter, hash above 2^31', 'a', 'e40c292c1'],
    ['ASCII headline, hash above 2^31', 'Breaking news', 'c60a7987d'],
    ['long ASCII headline (length 3x in base 36)', LONG_HEADLINE, 'd2af502e3x'],
    ['CJK', '突发新闻：市场大涨', 'ae168b039'],
    ['emoji, one surrogate pair (two UTF-16 units)', '🔥', 'b02ce1372'],
    ['accents and a flag emoji', 'Éclair déjà vu 🇫🇷', 'ce8a02a1j'],
    ['accented ASCII-lookalike', 'Ünïcödé', 'f9ce4f367'],
    ['repeated character, 40 long', 'x'.repeat(40), '84ae4e6514'],
    ['trailing character a', 'Headline a', 'f1c2b53ea'],
    ['trailing character b', 'Headline b', 'f0c2b3aba'],
    ['no trailing space', 'Headline', 'd25276698'],
    ['one trailing space', 'Headline ', '60d034eb9'],
    ['hash under 0x10000000 is NOT zero-padded', 'h100', '71c7f024'],
  ])('%s', (_label, text, expected) => {
    expect(hashSourceText(text)).toBe(expected);
  });

  it('is the 32-bit hash in hex followed by the length in base 36', () => {
    expect(hashSourceText('x'.repeat(35))).toMatch(/^[0-9a-f]+z$/);
    expect(hashSourceText('x'.repeat(36))).toMatch(/^[0-9a-f]+10$/);
  });

  it('separates texts that differ only in a trailing character, and only in length', () => {
    expect(hashSourceText('Headline a')).not.toBe(hashSourceText('Headline b'));
    expect(hashSourceText('Headline')).not.toBe(hashSourceText('Headline '));
  });
});

describe('translationCacheId: golden values', () => {
  it.each<[string, string, string]>([
    ['Breaking news', 'de', 'c60a7987d:de'],
    ['Breaking news', 'fr', 'c60a7987d:fr'],
    ['Breaking news', 'zh-Hans', 'c60a7987d:zh-Hans'],
    ['', 'de', '811c9dc50:de'],
    ['🔥', 'ja', 'b02ce1372:ja'],
    ['突发新闻：市场大涨', 'zh-Hant', 'ae168b039:zh-Hant'],
  ])('%j into %s', (text, lang, expected) => {
    expect(translationCacheId(text, lang)).toBe(expected);
  });

  it('is stable, and keyed by both the text and the language', () => {
    expect(translationCacheId('Hello', 'de')).toBe(translationCacheId('Hello', 'de'));
    expect(translationCacheId('Hello', 'de')).not.toBe(translationCacheId('Hello', 'fr'));
    expect(translationCacheId('Hello', 'de')).toBe(`${hashSourceText('Hello')}:de`);
  });
});

describe('the persisted row carries the golden key', () => {
  it('writes id = hash:lang and source_hash = hash', async () => {
    useStrictClock(T0);
    await store('de', [['Breaking news', 'Eilmeldung']]);

    const row = await rowOf('c60a7987d:de');
    expect(row).toMatchObject({
      sourceHash: 'c60a7987d',
      targetLang: 'de',
      sourceText: 'Breaking news',
      translatedText: 'Eilmeldung',
    });
    expect(row.createdAt.getTime()).toBe(T0);
    expect(row.lastUsedAt.getTime()).toBe(T0);
  });
});

// ---------------------------------------------------------------------------
// Buffering and flush
// ---------------------------------------------------------------------------

describe('rememberTranslation: buffer and flush timing (strict clock)', () => {
  beforeEach(() => useStrictClock(T0));

  it('writes nothing until the debounce: still buffered 1 ms before it, drained at it', async () => {
    rememberTranslation('Breaking news', 'de', 'Eilmeldung');
    expect(__translationCacheBufferSizeForTests()).toBe(1);

    await jest.advanceTimersByTimeAsync(TRANSLATION_CACHE_FLUSH_DEBOUNCE_MS - 1);
    expect(__translationCacheBufferSizeForTests()).toBe(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(__translationCacheBufferSizeForTests()).toBe(0);

    await flushTranslationCacheWrites();
    const loaded = await loadTranslationCache('de');
    expect(loaded.get('Breaking news')).toBe('Eilmeldung');
  });

  it('the debounce does not re-arm: a late arrival rides the flush the first one scheduled', async () => {
    const writes = countWrites();
    rememberTranslation('first', 'de', 'erste');
    await jest.advanceTimersByTimeAsync(1000);
    rememberTranslation('second', 'de', 'zweite');
    await jest.advanceTimersByTimeAsync(TRANSLATION_CACHE_FLUSH_DEBOUNCE_MS - 1000 - 1);
    expect(__translationCacheBufferSizeForTests()).toBe(2);

    await jest.advanceTimersByTimeAsync(1);
    expect(__translationCacheBufferSizeForTests()).toBe(0);
    await flushTranslationCacheWrites();

    expect(writes).toHaveBeenCalledTimes(1);
    const loaded = await loadTranslationCache('de');
    expect([...loaded.keys()].sort()).toEqual(['first', 'second']);
  });

  it('a whole scroll of translations lands as ONE write', async () => {
    const writes = countWrites();
    for (let i = 0; i < 20; i++) rememberTranslation(`Headline ${i}`, 'de', `Schlagzeile ${i}`);
    expect(writes).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(TRANSLATION_CACHE_FLUSH_DEBOUNCE_MS);
    await flushTranslationCacheWrites();

    expect(writes).toHaveBeenCalledTimes(1);
    expect((await loadTranslationCache('de')).size).toBe(20);
  });

  it('flushes at once when the buffer reaches the cap, with no timer advance', async () => {
    for (let i = 0; i < TRANSLATION_CACHE_FLUSH_MAX_BUFFER - 1; i++) rememberTranslation(`Headline ${i}`, 'de', `Schlagzeile ${i}`);
    expect(__translationCacheBufferSizeForTests()).toBe(TRANSLATION_CACHE_FLUSH_MAX_BUFFER - 1);

    rememberTranslation('Headline last', 'de', 'Schlagzeile last');
    expect(__translationCacheBufferSizeForTests()).toBe(0);

    await flushTranslationCacheWrites();
    expect((await loadTranslationCache('de')).size).toBe(TRANSLATION_CACHE_FLUSH_MAX_BUFFER);
  });
});

describe('rememberTranslation: what is kept', () => {
  beforeEach(() => useStrictClock(T0));

  it('ignores empty inputs rather than persisting junk', async () => {
    rememberTranslation('', 'de', 'x');
    rememberTranslation('x', '', 'y');
    rememberTranslation('x', 'de', '');
    expect(__translationCacheBufferSizeForTests()).toBe(0);
    await flushTranslationCacheWrites();
    expect(await countRows(TABLE)).toBe(0);
  });

  it('stores a whitespace-only text or translation as an empty string (the column trims), and loading skips such a row', async () => {
    await store('de', [
      [' ', 'x'],
      ['Breaking news', ' '],
      ['kept', 'behalten'],
    ]);

    expect(await countRows(TABLE)).toBe(3);
    expect(await loadTranslationCache('de')).toEqual(new Map([['kept', 'behalten']]));
  });

  it('the test reset drops what is buffered and cancels the pending flush', async () => {
    rememberTranslation('a', 'de', 'b');
    expect(__translationCacheBufferSizeForTests()).toBe(1);

    __resetTranslationCacheBufferForTests();
    expect(__translationCacheBufferSizeForTests()).toBe(0);
    await jest.advanceTimersByTimeAsync(TRANSLATION_CACHE_FLUSH_DEBOUNCE_MS);

    expect(await countRows(TABLE)).toBe(0);
  });

  it('coalesces repeats of the same (text, language) into one row, the last translation winning', async () => {
    rememberTranslation('Breaking news', 'de', 'Eilmeldung');
    rememberTranslation('Breaking news', 'de', 'Eilmeldung (v2)');
    expect(__translationCacheBufferSizeForTests()).toBe(1);

    await flushTranslationCacheWrites();

    expect(await countRows(TABLE)).toBe(1);
    expect((await loadTranslationCache('de')).get('Breaking news')).toBe('Eilmeldung (v2)');
  });

  it('keeps the same text in two languages as two rows', async () => {
    await store('de', [['Breaking news', 'Eilmeldung']]);
    await store('fr', [['Breaking news', 'Derniere minute']]);

    expect(await countRows(TABLE)).toBe(2);
    expect((await loadTranslationCache('de')).get('Breaking news')).toBe('Eilmeldung');
    expect((await loadTranslationCache('fr')).get('Breaking news')).toBe('Derniere minute');
  });

  it('a translation of a stored pair updates that row instead of inserting a duplicate: translation and last-used move, created stays', async () => {
    await store('de', [['Breaking news', 'stale']], T0);
    await store('de', [['Breaking news', 'Eilmeldung']], T0 + 3_600_000);

    expect(await countRows(TABLE)).toBe(1);
    const row = await rowOf(translationCacheId('Breaking news', 'de'));
    expect(row.translatedText).toBe('Eilmeldung');
    expect(row.createdAt.getTime()).toBe(T0);
    expect(row.lastUsedAt.getTime()).toBe(T0 + 3_600_000);
  });
});

describe('flushTranslationCacheWrites', () => {
  beforeEach(() => useStrictClock(T0));

  it('is a no-op with nothing buffered', async () => {
    const writes = countWrites();
    await flushTranslationCacheWrites();
    expect(writes).not.toHaveBeenCalled();
  });

  it('serialises a second flush behind one in flight, losing nothing', async () => {
    rememberTranslation('first', 'de', 'erste');
    const one = flushTranslationCacheWrites();
    rememberTranslation('second', 'de', 'zweite');
    const two = flushTranslationCacheWrites();
    await Promise.all([one, two]);

    expect(__translationCacheBufferSizeForTests()).toBe(0);
    expect([...(await loadTranslationCache('de')).keys()].sort()).toEqual(['first', 'second']);
  });

  it('swallows a failing write, drops what it held, and works again afterwards', async () => {
    rememberTranslation('lost', 'de', 'verloren');
    failNextQuery(TABLE, new Error('disk full'));

    await expect(flushTranslationCacheWrites()).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist'),
      expect.objectContaining({ count: 1, error: 'disk full' }),
    );
    expect(await countRows(TABLE)).toBe(0);

    await store('de', [['kept', 'behalten']]);
    expect([...(await loadTranslationCache('de')).keys()]).toEqual(['kept']);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('loadTranslationCache', () => {
  beforeEach(() => useStrictClock(T0));

  it('returns the sourceText to translatedText Map of one language only', async () => {
    await store('de', [
      ['Breaking news', 'Eilmeldung'],
      ['Markets rally', 'Märkte erholen sich'],
    ]);
    await store('fr', [['Elections', 'Elections (fr)']]);

    const loaded = await loadTranslationCache('de');
    expect(loaded).toEqual(
      new Map([
        ['Breaking news', 'Eilmeldung'],
        ['Markets rally', 'Märkte erholen sich'],
      ]),
    );
  });

  it('returns nothing for English or an empty language, even when such rows exist', async () => {
    await store('en', [['Breaking news', 'Breaking news (en)']]);
    expect(await countRows(TABLE)).toBe(1);

    expect((await loadTranslationCache('en')).size).toBe(0);
    expect((await loadTranslationCache('')).size).toBe(0);
  });

  it('orders by last use, most recent first', async () => {
    await store('de', [['oldest', 'a']], T0 - 3000);
    await store('de', [['newest', 'c']], T0 - 1000);
    await store('de', [['middle', 'b']], T0 - 2000);

    expect([...(await loadTranslationCache('de')).keys()]).toEqual(['newest', 'middle', 'oldest']);
  });

  it('keeps only the `limit` most recently used rows', async () => {
    for (let i = 0; i < 5; i++) await store('de', [[`row${i}`, `t${i}`]], T0 - (5 - i) * 1000);

    expect([...(await loadTranslationCache('de', 3)).keys()]).toEqual(['row4', 'row3', 'row2']);
  });

  it('loads at most TRANSLATION_CACHE_HYDRATE_LIMIT rows by default, dropping the least recently used', async () => {
    // 15 batches of 100 at one second apart, then 10 newer: 1510 rows, 10 over the limit.
    const batch = (prefix: string, n: number): [string, string][] => Array.from({ length: n }, (_, i) => [`${prefix}-${i}`, `t-${prefix}-${i}`]);
    for (let b = 0; b < 15; b++) await store('de', batch(`b${b}`, 100), T0 + b * 1000);
    await store('de', batch('b15', 10), T0 + 15 * 1000);
    expect(await countRows(TABLE)).toBe(1510);

    const loaded = await loadTranslationCache('de');

    expect(loaded.size).toBe(TRANSLATION_CACHE_HYDRATE_LIMIT);
    // Everything newer than the oldest batch survives; exactly the 10 over the limit went from it.
    for (let b = 1; b <= 15; b++) {
      const n = b === 15 ? 10 : 100;
      for (let i = 0; i < n; i++) expect(loaded.has(`b${b}-${i}`)).toBe(true);
    }
    expect(Array.from({ length: 100 }, (_, i) => loaded.has(`b0-${i}`)).filter(Boolean)).toHaveLength(90);
  });

  it('returns an empty Map and warns when the query fails', async () => {
    await store('de', [['Breaking news', 'Eilmeldung']]);
    failNextQuery(TABLE, new Error('db closed'));

    expect(await loadTranslationCache('de')).toEqual(new Map());
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to hydrate'),
      expect.objectContaining({ targetLang: 'de', error: 'db closed' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

describe('sweepTranslationCache', () => {
  beforeEach(() => useStrictClock(T0));

  it('drops rows untouched for the TTL and keeps the rest, returning the count', async () => {
    await store('de', [['stale-1', 'a'], ['stale-2', 'b']], T0 - (TRANSLATION_CACHE_TTL_DAYS + 1) * DAY_MS);
    await store('de', [['fresh', 'c']], T0 - 5 * DAY_MS);
    at(T0);

    expect(await sweepTranslationCache()).toBe(2);

    expect([...(await loadTranslationCache('de')).keys()]).toEqual(['fresh']);
  });

  it('keeps a row exactly at the TTL and drops it one millisecond later (now is a parameter)', async () => {
    await store('de', [['edge', 'a']], T0);

    expect(await sweepTranslationCache(TRANSLATION_CACHE_TTL_DAYS, T0 + TRANSLATION_CACHE_TTL_DAYS * DAY_MS)).toBe(0);
    expect(await sweepTranslationCache(TRANSLATION_CACHE_TTL_DAYS, T0 + TRANSLATION_CACHE_TTL_DAYS * DAY_MS + 1)).toBe(1);
    expect(await countRows(TABLE)).toBe(0);
  });

  it('takes a custom TTL in days', async () => {
    await store('de', [['ten-days', 'a']], T0 - 10 * DAY_MS);
    at(T0);

    expect(await sweepTranslationCache(30)).toBe(0);
    expect(await sweepTranslationCache(7)).toBe(1);
  });

  it('a translation seen again inside the TTL is kept: the use refreshes the clock', async () => {
    await store('de', [['seen-again', 'a']], T0 - 40 * DAY_MS);
    await store('de', [['seen-again', 'a']], T0 - 5 * DAY_MS);
    at(T0);

    expect(await sweepTranslationCache()).toBe(0);
    expect((await loadTranslationCache('de')).has('seen-again')).toBe(true);
  });

  it('opens no write when nothing is stale', async () => {
    await store('de', [['fresh', 'a']], T0);
    const writes = countWrites();

    expect(await sweepTranslationCache()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });

  it('returns 0 and warns, never throwing, when the sweep fails', async () => {
    failNextQuery(TABLE, new Error('db closed'));

    expect(await sweepTranslationCache()).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Sweep failed'), expect.objectContaining({ error: 'db closed' }));
  });
});

// ---------------------------------------------------------------------------
// Collisions and trimming: the documented guarantee is "a collision is a miss, never a wrong translation"
// ---------------------------------------------------------------------------

// Two different 8-character texts with the same FNV-1a hash (found by search): same id in every language.
const COLLIDING_A = 'k0009tzx';
const COLLIDING_B = 'k000g1cd';

describe('hash collisions', () => {
  beforeEach(() => useStrictClock(T0));

  it('the pair really does collide (guards the two tests below)', () => {
    expect(COLLIDING_A).not.toBe(COLLIDING_B);
    expect(translationCacheId(COLLIDING_A, 'de')).toBe('9297e198:de');
    expect(translationCacheId(COLLIDING_B, 'de')).toBe('9297e198:de');
  });

  it('two colliding texts buffered together keep the last one, whole: one row, no mix', async () => {
    rememberTranslation(COLLIDING_A, 'de', 'Uebersetzung A');
    rememberTranslation(COLLIDING_B, 'de', 'Uebersetzung B');
    await flushTranslationCacheWrites();

    expect(await loadTranslationCache('de')).toEqual(new Map([[COLLIDING_B, 'Uebersetzung B']]));
  });

  it('a colliding text stored after another never gives the first text the wrong translation', async () => {
    await store('de', [[COLLIDING_A, 'Uebersetzung A']]);
    await store('de', [[COLLIDING_B, 'Uebersetzung B']]);

    const loaded = await loadTranslationCache('de');
    expect(loaded.get(COLLIDING_A) ?? 'Uebersetzung A').toBe('Uebersetzung A');
    expect(loaded.get(COLLIDING_B) ?? 'Uebersetzung B').toBe('Uebersetzung B');
  });
});

describe('surrounding whitespace', () => {
  beforeEach(() => useStrictClock(T0));
  afterEach(() => useAppLanguageStore.setState(useAppLanguageStore.getInitialState(), true));

  it('a padded text is stored and loaded trimmed (the @text column trims on write)', async () => {
    await store('de', [[' Breaking news ', ' Eilmeldung ']]);

    expect(await loadTranslationCache('de')).toEqual(new Map([['Breaking news', 'Eilmeldung']]));
  });

  // The component asks the store's cache for the text as the server sent it. The row comes back
  // from disk keyed by the trimmed text, so after a restart a padded text no longer finds it.
  async function translateThenRestart(): Promise<Map<string, string>> {
    useAppLanguageStore.setState({ appLanguage: 'de' });
    useAppLanguageStore.getState().cacheTranslation(' Breaking news ', ' Eilmeldung ');
    await flushTranslationCacheWrites();
    useAppLanguageStore.getState().clearCache();
    await useAppLanguageStore.getState().hydrateTranslationCache('de');
    return useAppLanguageStore.getState().cache;
  }

  test.failing('DA22: a padded text finds its translation after a restart', async () => {
    const cache = await translateThenRestart();

    expect(cache.get(' Breaking news ')).toBe('Eilmeldung');
  });

  it('DA22 today: after a restart the padded text misses; only its trimmed form is in the cache', async () => {
    const cache = await translateThenRestart();

    expect(cache.get(' Breaking news ')).toBeUndefined();
    expect(cache.get('Breaking news')).toBe('Eilmeldung');
  });
});
