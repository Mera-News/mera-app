// On-device fact checks: fact-check-record-service (one row per article AND claim) and the
// fact-checks-store that mirrors the table, on the in-memory DB with the real saved-suggestion,
// setting and tracked-story services behind the store's retention coupling.
//
// Replaces lib/database/services/__tests__/fact-check-record-service.test.ts (21 `it`) and
// lib/stores/__tests__/fact-checks-store.test.ts (6 `it`).
//
// Not carried over, because no service (and no restore: fact_checks is not backed up) can produce the
// state, so the lines are R30 candidates:
//  - "collapses accidental duplicates of the SAME claim only": a pre-index race left two rows with one
//    key; upsertFactCheck reads and writes inside one writer, so it can no longer make that state.
//    fact-check-record-service.ts: the `for (const dupe of existing.slice(1))` loop.
//  - "a corrupt payload degrades to null", "does NOT delete a row with unparseable payload_json",
//    "DELETES an unreadable payload past 90 days" and the empty-string payload row: upsertFactCheck always
//    writes valid JSON. fact-check-record-service.ts: the `catch` in toStored, the `catch { return false }`
//    in deleteExpiredFactChecks and the `''` arm of `row.payloadJson ?`.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import { act, renderHook } from '@testing-library/react-native';

import database from '@/lib/database';
import * as factService from '@/lib/database/services/fact-check-record-service';
import {
  claimKeyClauses,
  deleteExpiredFactChecks,
  deleteFactCheck,
  getFactCheckForArticle,
  getFactCheckForClaim,
  listFactChecks,
  listFactChecksByStatus,
  listFactChecksForArticle,
  upsertFactCheck,
  type UpsertFactCheckInput,
} from '@/lib/database/services/fact-check-record-service';
import * as savedService from '@/lib/database/services/saved-article-suggestion-service';
import { keepArticleForFactCheck, saveStandaloneArticle } from '@/lib/database/services/saved-article-suggestion-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  CHECKS_SEEN_AT_SETTING_KEY,
  isFactCheckDone,
  isUnseenDone,
  useChecksUnseen,
  useFactCheckItems,
  useFactChecksHydrated,
  useFactChecksRefreshing,
  useFactChecksStore,
  watchFactChecks,
} from '@/lib/stores/fact-checks-store';
import logger from '@/lib/logger';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { useFakeClock } from '@/test/helpers';
import { failTableQuery, freshId, originsById, resetRetentionMemory, restoreFaults, savedRows, spyOn, waitFor } from './support';

beforeEach(resetRetentionMemory);
afterEach(restoreFaults);

const captureException = logger.captureException as jest.Mock;

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const MIN = 60_000;

const check = (over: Partial<UpsertFactCheckInput> = {}): UpsertFactCheckInput => ({
  articleId: 'a1',
  factCheckId: 'fc',
  status: 'complete',
  verdict: 'supported',
  payload: { checkedBy: [{ organisation: 'Alt News', verdict: 'False' }] },
  claimKey: 'k1',
  claim: 'a claim',
  ...over,
});

/** Records a check as if it was requested `ageMs` before NOW; leaves the clock at NOW. */
async function requestedAgo(ageMs: number, input: UpsertFactCheckInput): Promise<void> {
  jest.setSystemTime(NOW - ageMs);
  await upsertFactCheck(input);
  jest.setSystemTime(NOW);
}

describe('the composite upsert key', () => {
  it('two claims on one article make TWO rows, and neither destroys the other', async () => {
    await upsertFactCheck(check({ factCheckId: 'fc1', claimKey: 'k1', claim: 'claim one', verdict: 'supported', payload: { n: 1 } }));
    await upsertFactCheck(check({ factCheckId: 'fc2', claimKey: 'k2', claim: 'claim two', verdict: 'disputed', payload: { n: 2 } }));

    const rows = await listFactChecksForArticle('a1');
    expect(rows.map((r) => r.claimKey).sort()).toEqual(['k1', 'k2']);
    // the first claim's ANSWER survives: this goes red if the collapse is scoped to article_id alone
    expect(rows.find((r) => r.claimKey === 'k1')).toMatchObject({ verdict: 'supported', claim: 'claim one', payload: { n: 1 } });
    expect(rows.find((r) => r.claimKey === 'k2')).toMatchObject({ verdict: 'disputed', payload: { n: 2 } });
  });

  it('re-checking the SAME claim updates in place and keeps the original request time', async () => {
    useFakeClock(NOW);
    await upsertFactCheck(check({ status: 'processing', verdict: null, payload: { n: 1 } }));
    const [first] = await listFactChecksForArticle('a1');
    jest.setSystemTime(NOW + 60 * MIN);

    await upsertFactCheck(check({ status: 'complete', verdict: 'mixed', payload: { n: 2 } }));

    const rows = await listFactChecksForArticle('a1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, status: 'complete', verdict: 'mixed', payload: { n: 2 }, resolvedAt: expect.any(Number) });
    // an answer landing later must not jump the row to the top as if it were a fresh request
    expect(rows[0].requestedAt).toBe(first.requestedAt);
    expect(rows[0].resolvedAt).toBeGreaterThanOrEqual(NOW + 60 * MIN);
  });

  it('a different ARTICLE with the same claim key is a different row', async () => {
    await upsertFactCheck(check({ articleId: 'a1', verdict: 'one' }));
    await upsertFactCheck(check({ articleId: 'a2', verdict: 'two' }));
    expect((await listFactChecksForArticle('a1')).map((r) => r.verdict)).toEqual(['one']);
    expect((await listFactChecksForArticle('a2')).map((r) => r.verdict)).toEqual(['two']);
  });

  it('claimKeyClauses scopes by article id and compiles a missing key to IS NULL, a key to equality', () => {
    const wheres = (clauses: unknown[]) =>
      clauses.map((c) => {
        const w = c as { type: string; left: string; comparison: { operator: string; right: { value: unknown } } };
        return [w.type, w.left, w.comparison.operator, w.comparison.right.value];
      });
    expect(wheres(claimKeyClauses('a1'))).toEqual([
      ['where', 'article_id', 'eq', 'a1'],
      ['where', 'claim_key', 'eq', null],
    ]);
    expect(wheres(claimKeyClauses('a1', null))).toEqual(wheres(claimKeyClauses('a1')));
    expect(wheres(claimKeyClauses('a1', 'k1'))).toEqual([
      ['where', 'article_id', 'eq', 'a1'],
      ['where', 'claim_key', 'eq', 'k1'],
    ]);
  });
});

describe('a legacy (v51) whole-article row keeps its own slot', () => {
  const legacy = (over: Partial<UpsertFactCheckInput> = {}) =>
    check({ claimKey: undefined, claim: undefined, verdict: 'legacy-verdict', ...over });

  it('a keyed upsert does NOT overwrite it', async () => {
    useFakeClock(NOW);
    await upsertFactCheck(legacy());

    await upsertFactCheck(check({ claimKey: 'k1', claim: 'a new claim', verdict: 'supported' }));

    const rows = await listFactChecksForArticle('a1');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.claimKey === null)).toMatchObject({ verdict: 'legacy-verdict', claim: null });
    expect(rows.find((r) => r.claimKey === 'k1')).toMatchObject({ verdict: 'supported', claim: 'a new claim' });
  });

  it('a second whole-article check updates that slot instead of adding a row', async () => {
    await upsertFactCheck(legacy({ verdict: 'first' }));
    await upsertFactCheck(legacy({ verdict: 'second' }));
    const rows = await listFactChecksForArticle('a1');
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('second');
  });

  it('a keyed lookup never resolves to it, while an unkeyed one finds it', async () => {
    await upsertFactCheck(legacy());
    expect(await getFactCheckForClaim('a1', 'k1')).toBeNull();
    expect((await getFactCheckForClaim('a1'))?.verdict).toBe('legacy-verdict');
    expect((await getFactCheckForClaim('a1', null))?.verdict).toBe('legacy-verdict');
  });

  it('is still reachable by article, for the orphan card', async () => {
    await upsertFactCheck(legacy());
    expect((await getFactCheckForArticle('a1'))?.verdict).toBe('legacy-verdict');
  });
});

describe('reading checks back', () => {
  it('getFactCheckForClaim finds one claim, and getFactCheckForArticle returns the newest request', async () => {
    useFakeClock(NOW);
    await requestedAgo(2 * MIN, check({ claimKey: 'old', verdict: 'older' }));
    await requestedAgo(1 * MIN, check({ claimKey: 'new', verdict: 'newer' }));

    expect((await getFactCheckForClaim('a1', 'old'))?.verdict).toBe('older');
    expect(await getFactCheckForClaim('a1', 'missing')).toBeNull();
    expect((await getFactCheckForArticle('a1'))?.verdict).toBe('newer');
    expect((await listFactChecksForArticle('a1')).map((r) => r.verdict)).toEqual(['newer', 'older']);
    expect(await getFactCheckForArticle('other')).toBeNull();
  });

  it('answer for a blank article id: nothing is read and nothing is written', async () => {
    await upsertFactCheck(check({ articleId: '' }));
    expect(await listFactChecks()).toEqual([]);
    expect(await listFactChecksForArticle('')).toEqual([]);
    expect(await getFactCheckForClaim('', 'k1')).toBeNull();
  });

  it('listFactChecks returns every check newest request first, and honours a positive limit only', async () => {
    useFakeClock(NOW);
    for (const [i, key] of ['a', 'b', 'c'].entries()) {
      await requestedAgo((3 - i) * MIN, check({ articleId: `art-${key}`, claimKey: key }));
    }

    expect((await listFactChecks()).map((r) => r.articleId)).toEqual(['art-c', 'art-b', 'art-a']);
    expect((await listFactChecks(2)).map((r) => r.articleId)).toEqual(['art-c', 'art-b']);
    expect(await listFactChecks(0)).toHaveLength(3);
    expect(await listFactChecks(-1)).toHaveLength(3);
  });

  it('listFactChecksByStatus returns only that status, newest first, bounded to 20 unless asked for fewer', async () => {
    useFakeClock(NOW);
    await upsertFactCheck(check({ articleId: 'done', status: 'complete', claimKey: 'd' }));
    for (let i = 0; i < 25; i++) {
      await requestedAgo((30 - i) * MIN, check({ articleId: `p${i}`, status: 'processing', verdict: null, payload: null, claimKey: `p${i}` }));
    }

    const all = await listFactChecksByStatus('processing');
    expect(all).toHaveLength(20);
    expect(all.every((r) => r.status === 'processing')).toBe(true);
    // newest request first: p24 was requested last
    expect(all[0].articleId).toBe('p24');
    expect(await listFactChecksByStatus('processing', 5)).toHaveLength(5);
    expect((await listFactChecksByStatus('complete')).map((r) => r.articleId)).toEqual(['done']);
    expect(await listFactChecksByStatus('blocked')).toEqual([]);
  });

  it('every read answers empty rather than throwing when the table cannot be read', async () => {
    await upsertFactCheck(check());
    failTableQuery('fact_checks');

    expect(await listFactChecksForArticle('a1')).toEqual([]);
    expect(await getFactCheckForClaim('a1', 'k1')).toBeNull();
    expect(await getFactCheckForArticle('a1')).toBeNull();
    expect(await listFactChecksByStatus('complete')).toEqual([]);
    expect(await listFactChecks()).toEqual([]);
    expect(captureException).toHaveBeenCalledTimes(5);
  });
});

describe('what upsertFactCheck stores', () => {
  it.each([['complete'], ['blocked'], ['  COMPLETE ']])('stamps resolved_at = now for the terminal status %p', async (status) => {
    useFakeClock(NOW);
    await upsertFactCheck(check({ status }));
    const [row] = await listFactChecksForArticle('a1');
    expect(row.resolvedAt).toBeGreaterThanOrEqual(NOW);
    expect(row.resolvedAt).toBeLessThan(NOW + MIN);
  });

  it.each([['pending'], ['processing'], ['']])('leaves resolved_at empty for the non-terminal status %p', async (status) => {
    await upsertFactCheck(check({ status }));
    expect((await listFactChecksForArticle('a1'))[0].resolvedAt).toBeNull();
  });

  it('an explicit resolvedAt wins over the default', async () => {
    useFakeClock(NOW);
    await upsertFactCheck(check({ resolvedAt: NOW - DAY }));
    expect((await listFactChecksForArticle('a1'))[0].resolvedAt).toBe(NOW - DAY);
  });

  it('round-trips the whole payload, and stores nothing for a missing or unserialisable one', async () => {
    const payload = { claims: [{ text: 'x' }], checkedBy: [{ organisation: 'BOOM' }] };
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await upsertFactCheck(check({ claimKey: 'k1', payload }));
    await upsertFactCheck(check({ claimKey: 'k2', payload: undefined }));
    await upsertFactCheck(check({ claimKey: 'k3', payload: circular }));

    const by = async (k: string) => (await getFactCheckForClaim('a1', k))!;
    expect((await by('k1')).payload).toEqual(payload);
    expect((await by('k2')).payload).toBeNull();
    expect((await by('k3')).payload).toBeNull();
  });

  it('defaults the optional columns, and carries the title, claim and id through', async () => {
    await upsertFactCheck({
      articleId: 'a1',
      factCheckId: undefined as never,
      status: 'pending',
      payload: null,
      claimKey: 'k',
      articleTitle: 'A headline',
      claim: 'the assertion',
    });
    expect(await getFactCheckForClaim('a1', 'k')).toMatchObject({
      factCheckId: '',
      articleTitle: 'A headline',
      claim: 'the assertion',
      verdict: null,
      payload: null,
    });
  });

  it('never throws, and reports it, when the write fails', async () => {
    const write = spyOn(database, 'write').mockRejectedValueOnce(new Error('disk full'));
    await expect(upsertFactCheck(check())).resolves.toBeUndefined();
    write.mockRestore();
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'upsertFactCheck' }) }),
    );
    expect(await listFactChecks()).toEqual([]);
  });

  it('deleteFactCheck removes that one row, and never throws on an unknown id', async () => {
    await upsertFactCheck(check({ claimKey: 'k1' }));
    await upsertFactCheck(check({ claimKey: 'k2' }));
    const [first, second] = await listFactChecksForArticle('a1');

    await deleteFactCheck(first.id);
    expect((await listFactChecksForArticle('a1')).map((r) => r.id)).toEqual([second.id]);

    await expect(deleteFactCheck('nope')).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'deleteFactCheck' }) }),
    );
  });
});

describe('deleteExpiredFactChecks (the retention sweep)', () => {
  const sweep = () => deleteExpiredFactChecks(NOW - 7 * DAY, NOW - 90 * DAY);
  const left = async () => (await listFactChecks()).map((r) => r.articleId).sort();
  const attributed = { checkedBy: [{ organisation: 'BOOM' }] };
  const row = (articleId: string, payload: unknown) => check({ articleId, claimKey: articleId, payload });

  beforeEach(() => useFakeClock(NOW));

  it('KEEPS an attributed check past 7 days while it is inside 90', async () => {
    await requestedAgo(60 * DAY, row('attributed', attributed));
    expect(await sweep()).toBe(0);
    expect(await left()).toEqual(['attributed']);
  });

  it('DELETES an attributed check once it is past 90 days: the hard cap applies to every row', async () => {
    await requestedAgo(400 * DAY, row('stale-attributed', attributed));
    expect(await sweep()).toBe(1);
    expect(await left()).toEqual([]);
  });

  it('applies the hard cap to each row on its own, not to the batch', async () => {
    await requestedAgo(30 * DAY, row('keep-recent-attributed', attributed));
    await requestedAgo(200 * DAY, row('drop-old-attributed', attributed));
    expect(await sweep()).toBe(1);
    expect(await left()).toEqual(['keep-recent-attributed']);
  });

  it('DELETES an unattributed check (empty checkedBy) once it is past 7 days, and keeps one only 6 days old', async () => {
    await requestedAgo(8 * DAY, row('old-unattributed', { checkedBy: [] }));
    await requestedAgo(6 * DAY, row('young-unattributed', { checkedBy: [] }));
    expect(await sweep()).toBe(1);
    expect(await left()).toEqual(['young-unattributed']);
  });

  it('decays a readable payload with no checkedBy array exactly like an empty one', async () => {
    // the `pending` stub row requestFactCheck writes with payload: null, and two other shapes
    await requestedAgo(8 * DAY, row('no-field', { status: 'blocked' }));
    await requestedAgo(8 * DAY, row('null-payload', null));
    await requestedAgo(8 * DAY, row('not-an-array', { checkedBy: 'BOOM' }));

    expect(await sweep()).toBe(3);
    expect(await left()).toEqual([]);
  });

  it('mixes kept and deleted rows correctly in one sweep, and reports the count', async () => {
    await requestedAgo(8 * DAY, row('keep-attributed', attributed));
    await requestedAgo(8 * DAY, row('delete-empty', { checkedBy: [] }));
    await requestedAgo(1 * DAY, row('keep-young', { checkedBy: [] }));
    await requestedAgo(100 * DAY, row('delete-ancient', attributed));

    expect(await sweep()).toBe(2);
    expect(await left()).toEqual(['keep-attributed', 'keep-young']);
  });

  it('sweeps nothing from an empty table, and returns 0 rather than throwing when the table cannot be read', async () => {
    expect(await sweep()).toBe(0);
    await requestedAgo(8 * DAY, row('old', { checkedBy: [] }));
    failTableQuery('fact_checks');
    expect(await sweep()).toBe(0);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'deleteExpiredFactChecks' }) }),
    );
  });
});

describe('fact-checks-store', () => {
  const store = () => useFactChecksStore.getState();
  const art = (id: string) => ({ _id: id, title: 't', title_en_internal_only: 'Headline', article_url: `https://example.com/${id}` }) as unknown as NewsArticle;

  it('load reads the local table newest first and marks the store hydrated', async () => {
    useFakeClock(NOW);
    expect(store()).toMatchObject({ items: [], hydrated: false, refreshing: false, seenAt: null });
    await requestedAgo(2 * MIN, check({ articleId: 'old', claimKey: 'o' }));
    await requestedAgo(1 * MIN, check({ articleId: 'new', claimKey: 'n' }));

    await store().load();

    expect(store().items.map((i) => i.articleId)).toEqual(['new', 'old']);
    expect(store().hydrated).toBe(true);
  });

  it('load reads the seen time beside the items, and writes nothing when it was stored', async () => {
    await setSetting(CHECKS_SEEN_AT_SETTING_KEY, '1000');
    await store().load();
    expect(store().seenAt).toBe(1000);
    expect(await getSetting(CHECKS_SEEN_AT_SETTING_KEY)).toBe('1000');
  });

  it.each([['absent', null], ['not a number', 'soon']])(
    'a first load on this phone (seen time %s) takes today as the baseline, so old checks never light the dot',
    async (_label, stored) => {
      useFakeClock(NOW);
      if (stored !== null) await setSetting(CHECKS_SEEN_AT_SETTING_KEY, stored);
      await requestedAgo(60 * DAY, check({ articleId: 'ancient', claimKey: 'a' }));

      await store().load();

      const seenAt = store().seenAt!;
      expect(seenAt).toBeGreaterThanOrEqual(NOW);
      await waitFor(async () => (await getSetting(CHECKS_SEEN_AT_SETTING_KEY)) === String(seenAt));
      expect(await getSetting(CHECKS_SEEN_AT_SETTING_KEY)).toBe(String(seenAt));
      const { result } = renderHook(() => useChecksUnseen());
      expect(result.current).toBe(false);
    },
  );

  it('an unreadable settings table still loads, with today as the baseline', async () => {
    useFakeClock(NOW);
    failTableQuery('settings');
    await store().load();
    expect(store().hydrated).toBe(true);
    expect(store().seenAt).toBeGreaterThanOrEqual(NOW);
  });

  it('markSeen stamps now in the store and in the settings row', async () => {
    useFakeClock(NOW);
    store().markSeen();
    expect(store().seenAt).toBeGreaterThanOrEqual(NOW);
    const seenAt = store().seenAt!;
    await waitFor(async () => (await getSetting(CHECKS_SEEN_AT_SETTING_KEY)) === String(seenAt));
    expect(await getSetting(CHECKS_SEEN_AT_SETTING_KEY)).toBe(String(seenAt));
  });

  it('refresh re-reads the table behind its own flag, and a refresh already in flight is not doubled', async () => {
    await upsertFactCheck(check());
    const list = spyOn(factService, 'listFactChecks');

    const first = store().refresh();
    expect(store().refreshing).toBe(true);
    const second = store().refresh();
    await Promise.all([first, second]);

    expect(list).toHaveBeenCalledTimes(1);
    expect(store()).toMatchObject({ refreshing: false, hydrated: true });
    expect(store().items).toHaveLength(1);
  });

  it('refresh clears its flag even when the read comes back empty', async () => {
    await store().refresh();
    expect(store()).toMatchObject({ refreshing: false, hydrated: true, items: [] });
  });

  describe('remove', () => {
    async function checkedArticle(id: string, ...keys: string[]) {
      await keepArticleForFactCheck({ articleId: id, title: 'Checked' });
      for (const key of keys) await upsertFactCheck(check({ articleId: id, claimKey: key }));
      await store().load();
    }

    it('drops the row at once, deletes it, then releases the retention snapshot of the LAST check', async () => {
      const id = freshId();
      await checkedArticle(id, 'k1');
      const [item] = store().items;

      const removing = store().remove(item.id);
      expect(store().items).toEqual([]); // optimistic: before the delete has landed
      await removing;

      expect(await listFactChecksForArticle(id)).toEqual([]);
      // released AFTER the delete: it decides "was that the last check?" from what the delete left
      expect(await savedRows()).toEqual([]);
    });

    it('keeps the snapshot while another claim on the article still has a check', async () => {
      const id = freshId();
      await checkedArticle(id, 'k1', 'k2');
      const target = store().items.find((i) => i.claimKey === 'k1')!;

      await store().remove(target.id);

      expect((await listFactChecksForArticle(id)).map((r) => r.claimKey)).toEqual(['k2']);
      expect(await originsById()).toEqual({ [id]: 'fact_check' });
    });

    it('never touches a snapshot the user saved', async () => {
      const id = freshId();
      await saveStandaloneArticle(art(id));
      await upsertFactCheck(check({ articleId: id, claimKey: 'k1' }));
      await store().load();

      await store().remove(store().items[0].id);

      expect(await originsById()).toEqual({ [id]: 'article' });
    });

    it('deletes an unknown row without attempting a release', async () => {
      const id = freshId();
      await checkedArticle(id, 'k1');
      const release = spyOn(savedService, 'releaseFactCheckRetention');

      await store().remove('unknown-row');

      expect(release).not.toHaveBeenCalled();
      expect(store().items).toHaveLength(1);
    });
  });

  describe('the Fact checks dot', () => {
    it('isUnseenDone counts a finished check only when it finished after the page was seen', () => {
      expect(isUnseenDone({ status: 'complete', resolvedAt: 1001 }, 1000)).toBe(true);
      expect(isUnseenDone({ status: 'complete', resolvedAt: 1000 }, 1000)).toBe(false);
      expect(isUnseenDone({ status: 'pending', resolvedAt: 5000 }, 1000)).toBe(false);
      expect(isUnseenDone({ status: 'blocked', resolvedAt: 5000 }, null)).toBe(false);
      expect(isUnseenDone({ status: 'blocked', resolvedAt: 5000 }, 1000)).toBe(true);
      expect(isFactCheckDone({ status: ' Complete ' })).toBe(true);
      expect(isFactCheckDone({ status: 'processing' })).toBe(false);
    });

    it('lights when a check finishes after the page was last seen, and clears on markSeen', async () => {
      useFakeClock(NOW);
      await setSetting(CHECKS_SEEN_AT_SETTING_KEY, String(NOW - MIN));
      await store().load();
      const { result } = renderHook(() => ({ unseen: useChecksUnseen(), items: useFactCheckItems(), hydrated: useFactChecksHydrated(), refreshing: useFactChecksRefreshing() }));
      expect(result.current).toMatchObject({ unseen: false, items: [], hydrated: true, refreshing: false });

      await upsertFactCheck(check({ articleId: 'a-new', claimKey: 'n' }));
      await act(async () => store().load());
      expect(result.current.unseen).toBe(true);
      expect(result.current.items).toHaveLength(1);

      act(() => store().markSeen());
      expect(result.current.unseen).toBe(false);
    });

    it('a check that is still running does not light it', async () => {
      await setSetting(CHECKS_SEEN_AT_SETTING_KEY, '1');
      await upsertFactCheck(check({ status: 'processing', payload: null }));
      await store().load();
      const { result } = renderHook(() => useChecksUnseen());
      expect(result.current).toBe(false);
    });
  });

  describe('watchFactChecks', () => {
    it('loads at once, re-reads on every change to the table, and stops when asked', async () => {
      await setSetting(CHECKS_SEEN_AT_SETTING_KEY, '1');
      const stop = watchFactChecks();
      await waitFor(() => store().hydrated);
      expect(store().items).toEqual([]);

      await upsertFactCheck(check({ articleId: 'a-1', claimKey: 'k1' }));
      await waitFor(() => store().items.length === 1);
      expect(store().items.map((i) => i.articleId)).toEqual(['a-1']);

      stop();
      await upsertFactCheck(check({ articleId: 'a-2', claimKey: 'k2' }));
      await waitFor(() => store().items.length === 2, 200);
      expect(store().items).toHaveLength(1);
    });
  });
});
