// setting-service at its seam: the key/value table every other service stands on, over the
// in-memory DB. Replaces lib/database/services/__tests__/setting-service.test.ts, whose database
// mock ignored `Q.where('key', key)`: "returns the first row when several are present" could only
// pass because the fake returned every row. Here a read goes to the key it asks for, and
// getSettingsByPrefix runs on Loki, which is the Q.like smoke test for the whole app.
//
// Loki vs SQLite for Q.like: Loki turns a pattern into a case-insensitive regexp (`%` to `.*`,
// `_` to `.`), which is how SQLite LIKE reads ASCII too. No divergence shows on the paths below.
import { Q } from '@nozbe/watermelondb';

import database from '@/lib/database';
import { deleteSetting, getSetting, getSettingsByPrefix, setSetting } from '@/lib/database/services/setting-service';
import { countRows, restoreFaults, track } from './support';

afterEach(restoreFaults);

const recordFor = async (key: string) => {
  const [record] = await database.get('settings').query(Q.where('key', key)).fetch();
  return record as unknown as { value: string; update: (fn: (r: unknown) => void) => Promise<unknown>; destroyPermanently: () => Promise<void> };
};

describe('getSetting', () => {
  it('is null when no row has the key', async () => {
    await setSetting('other', 'x');
    expect(await getSetting('missing_key')).toBeNull();
  });

  it('returns the value of exactly that key', async () => {
    await setSetting('theme', 'dark');
    await setSetting('lang', 'en');
    expect(await getSetting('theme')).toBe('dark');
    expect(await getSetting('lang')).toBe('en');
  });

  it('is an exact match: a longer key and a prefix are different keys', async () => {
    await setSetting('theme_mode', 'dark');
    expect(await getSetting('theme')).toBeNull();
    expect(await getSetting('theme_mode_x')).toBeNull();
  });
});

describe('setSetting', () => {
  it('creates a row for a new key', async () => {
    await setSetting('foo', 'bar');
    expect(await getSetting('foo')).toBe('bar');
    expect(await countRows('settings')).toBe(1);
  });

  it('upserts: one row per key, the last value winning', async () => {
    await setSetting('lang', 'en');
    await setSetting('lang', 'fr');
    await setSetting('other', 'x');

    expect(await getSetting('lang')).toBe('fr');
    expect(await countRows('settings')).toBe(2);
  });

  it('stores an empty string as a value, distinct from a missing key', async () => {
    await setSetting('blank', '');
    expect(await getSetting('blank')).toBe('');
  });

  it('concurrent writes to one key leave one row', async () => {
    await Promise.all([setSetting('k', 'a'), setSetting('k', 'b'), setSetting('k', 'c')]);
    expect(await countRows('settings')).toBe(1);
    expect(['a', 'b', 'c']).toContain(await getSetting('k'));
  });

  // The fetched record was tombstoned between the read and the update (a concurrent delete, or a
  // migration's direct DELETE). Reproduced for real: the row is destroyed inside the writer, after
  // the fetch returns it and before the update runs.
  it('self-heals by writing a fresh row when the fetched record turns out to be deleted', async () => {
    await setSetting('feed_sync_machine_state', 'old');
    const collection = database.get('settings') as unknown as { query: (...c: unknown[]) => any };
    const realQuery = collection.query.bind(collection);
    track(
      jest.spyOn(collection, 'query').mockImplementationOnce(((...conditions: unknown[]) => {
        const query = realQuery(...conditions);
        const realFetch = query.fetch.bind(query);
        query.fetch = async () => {
          const rows = await realFetch();
          await rows[0].destroyPermanently();
          return rows;
        };
        return query;
      }) as never),
    );

    await expect(setSetting('feed_sync_machine_state', 'new')).resolves.toBeUndefined();

    expect(await getSetting('feed_sync_machine_state')).toBe('new');
    expect(await countRows('settings')).toBe(1);
  });

  it('rethrows an update failure that is not a deleted record, leaving the value', async () => {
    await setSetting('k', 'v');
    const record = await recordFor('k');
    track(jest.spyOn(record, 'update').mockRejectedValueOnce(new Error('disk full')));

    await expect(setSetting('k', 'v2')).rejects.toThrow('disk full');

    expect(await getSetting('k')).toBe('v');
    expect(await countRows('settings')).toBe(1);
  });
});

describe('deleteSetting', () => {
  it('removes the row of that key and no other', async () => {
    await setSetting('session', 'abc');
    await setSetting('keep', 'me');

    await deleteSetting('session');

    expect(await getSetting('session')).toBeNull();
    expect(await getSetting('keep')).toBe('me');
    expect(await countRows('settings')).toBe(1);
  });

  it('is a no-op for a key that is not there', async () => {
    await setSetting('other', 'x');
    await expect(deleteSetting('ghost')).resolves.toBeUndefined();
    expect(await getSetting('other')).toBe('x');
  });

  it('a deleted key can be written again', async () => {
    await setSetting('k', 'a');
    await deleteSetting('k');
    await setSetting('k', 'b');
    expect(await getSetting('k')).toBe('b');
    expect(await countRows('settings')).toBe(1);
  });

  it('swallows a "deleted record" error (a concurrent delete already did the job)', async () => {
    await setSetting('race', 'x');
    const record = await recordFor('race');
    track(jest.spyOn(record, 'destroyPermanently').mockRejectedValueOnce(new Error('deleted record conflict')));

    await expect(deleteSetting('race')).resolves.toBeUndefined();
  });

  it('rethrows any other failure', async () => {
    await setSetting('race', 'x');
    const record = await recordFor('race');
    track(jest.spyOn(record, 'destroyPermanently').mockRejectedValueOnce(new Error('unexpected disk error')));

    await expect(deleteSetting('race')).rejects.toThrow('unexpected disk error');
    expect(await getSetting('race')).toBe('x');
  });
});

describe('getSettingsByPrefix (Q.like on Loki)', () => {
  it('returns a key to value map of every row whose key starts with the prefix, and nothing else', async () => {
    await setSetting('tutorial_feed', '1');
    await setSetting('tutorial_world', '2');
    await setSetting('app_language', 'en');
    await setSetting('my_tutorial_feed', 'not a prefix match');

    expect(await getSettingsByPrefix('tutorial_')).toEqual({ tutorial_feed: '1', tutorial_world: '2' });
  });

  it('is an empty object when no key matches', async () => {
    await setSetting('app_language', 'en');
    expect(await getSettingsByPrefix('tutorial_')).toEqual({});
  });

  it('matches the prefix key itself and sees a later delete', async () => {
    await setSetting('headline_depth:world', 'deep');
    await setSetting('headline_depth:', 'bare');
    expect(Object.keys(await getSettingsByPrefix('headline_depth:')).sort()).toEqual(['headline_depth:', 'headline_depth:world']);

    await deleteSetting('headline_depth:world');
    expect(await getSettingsByPrefix('headline_depth:')).toEqual({ 'headline_depth:': 'bare' });
  });

  // sanitizeLikeString turns the characters LIKE treats as wildcards into a single-character
  // wildcard, so a percent sign in the prefix cannot swallow a whole stretch of the key.
  it('a percent sign in the prefix is not a match-anything wildcard', async () => {
    await setSetting('a%b:1', 'literal');
    await setSetting('aXXb:2', 'two characters in place of the percent sign');

    expect(await getSettingsByPrefix('a%b:')).toEqual({ 'a%b:1': 'literal' });
  });

  // DATA-U10b-2. Q.sanitizeLikeString does not escape: it replaces every non-alphanumeric character
  // with `_`, the one-character LIKE wildcard. The prefix therefore matches the literal character and
  // any other single character in its place. (For the app's own prefixes, `tutorial_`,
  // `headline_depth:` and `bg_articles_charged:`, this over-matches only a sibling key that differs
  // in that one position.)
  test.failing('an underscore, colon or percent in the prefix matches only itself', async () => {
    await setSetting('a_b:1', 'literal');
    await setSetting('axb:2', 'x in place of the underscore');
    await setSetting('a%b:3', 'percent in place of the underscore');
    await setSetting('aXb:4', 'X in place of the underscore');

    expect(Object.keys(await getSettingsByPrefix('a_b:'))).toEqual(['a_b:1']);
  });

  it('today: a non-alphanumeric character in the prefix also matches any one other character', async () => {
    await setSetting('a_b:1', 'literal');
    await setSetting('axb:2', 'x in place of the underscore');
    await setSetting('a%b:3', 'percent in place of the underscore');
    await setSetting('aXXb:5', 'two characters, still no match');

    expect(Object.keys(await getSettingsByPrefix('a_b:')).sort()).toEqual(['a%b:3', 'a_b:1', 'axb:2']);
  });
});
