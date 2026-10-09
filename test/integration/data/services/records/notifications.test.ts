// notification-service (the DB service, not lib/notification-service.ts) at its seam: the
// notification-center rows, over the in-memory DB. Replaces
// lib/database/services/__tests__/notification-service.test.ts, which faked the whole database
// with a Subject standing in for observeCount: it could prove the rxjs dedupe, never that the
// count follows real writes. markActionedBySource was pinned there by inspecting the query
// arguments because the mock ignored Q.where; here a row of another source is a real row.
//
// Not carried over: the "database.write called N times" and "prepareUpdate called once" counts
// (they counted mock calls; the rows' resulting status is asserted instead).
// Hygiene notifications stamping getPendingCount() is hygiene-service's rule, not this file's.
import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import {
  clearAll,
  deleteNotification,
  deleteOlderThan,
  dismiss,
  getAll,
  markActioned,
  markActionedBySource,
  markAllRead,
  markRead,
  notify,
  observeAll,
  observeUnreadCount,
} from '@/lib/database/services/notification-service';
import { countRows, countWrites, DAY, freezeClock, restoreFaults, rowById, T0 } from './support';

beforeEach(() => freezeClock());
afterEach(restoreFaults);

const tick = (ms = 1000) => jest.advanceTimersByTime(ms);
const input = (over: Partial<Parameters<typeof notify>[0]> = {}) => ({
  type: 'feed_info',
  title: 'notificationCenter.dailyLimitTitle',
  body: 'notificationCenter.dailyLimitBody',
  source: 'feed-sync',
  ...over,
});
const statusOf = async (id: string) => (await rowById('notifications', id)).status;

/** Lets pending promise work (a count fetch) and any throttle timer run. */
const settle = (ms = 0) => jest.advanceTimersByTimeAsync(ms);

describe('notify', () => {
  it('writes an unread row with every field the caller gave', async () => {
    const row = await notify(
      input({
        type: 'hygiene',
        title: 'Review your facts',
        body: 'Three look stale',
        icon: 'sparkles',
        context: { factIds: ['f1', 'f2'], n: 3 },
        actions: [{ id: 'recalibrate', labelKey: 'hygiene.review' }],
        source: 'hygiene',
      }),
    );

    expect(row).not.toBeNull();
    const stored = await rowById('notifications', row!.id);
    expect(stored).toMatchObject({
      type: 'hygiene',
      title: 'Review your facts',
      body: 'Three look stale',
      icon: 'sparkles',
      status: 'unread',
      source: 'hygiene',
    });
    expect(JSON.parse(stored.contextJson)).toEqual({ factIds: ['f1', 'f2'], n: 3 });
    expect(JSON.parse(stored.actionsJson)).toEqual([{ id: 'recalibrate', labelKey: 'hygiene.review' }]);
    expect(stored.createdAt.getTime()).toBe(T0);
  });

  it('leaves icon, context and actions null when omitted', async () => {
    const row = await notify(input());
    expect(await rowById('notifications', row!.id)).toMatchObject({ icon: null, contextJson: null, actionsJson: null });
  });

  // `notifications.type` is a free string and rows live 90 days, so a bundle meets types it has
  // never heard of (a newer one wrote them). They must still list and take every status change.
  it('stores, lists and updates a row whose type this bundle does not know', async () => {
    const row = await notify(input({ type: 'future_type_v9', context: { anything: [1] }, source: 'future:1' }));

    const [listed] = await getAll();
    expect(listed.id).toBe(row!.id);
    expect(listed.type).toBe('future_type_v9');
    await markRead(row!.id);
    expect(await statusOf(row!.id)).toBe('read');
  });

  describe('dedupeDaily is opt-in, keyed on (type, source) and the UTC day', () => {
    const deduped = (over = {}) => input({ dedupeDaily: true, ...over });

    it('creates the first, and suppresses the second with the same tuple the same day', async () => {
      expect(await notify(deduped())).not.toBeNull();
      expect(await notify(deduped())).toBeNull();
      expect(await countRows('notifications')).toBe(1);
    });

    it('still notifies for another type from the same source, and for the same type from another source', async () => {
      await notify(deduped());
      expect(await notify(deduped({ type: 'sync_event' }))).not.toBeNull();
      expect(await notify(deduped({ source: 'calibration-service' }))).not.toBeNull();
      expect(await countRows('notifications')).toBe(3);
    });

    it('re-arms at the next UTC midnight, an hour later', async () => {
      jest.setSystemTime(Date.parse('2026-10-09T23:30:00.000Z'));
      await notify(deduped());
      jest.setSystemTime(Date.parse('2026-10-09T23:59:00.000Z'));
      expect(await notify(deduped())).toBeNull();

      jest.setSystemTime(Date.parse('2026-10-10T00:30:00.000Z'));
      expect(await notify(deduped())).not.toBeNull();
    });

    it('does not dedupe a caller that did not opt in, nor one that passes false', async () => {
      await notify(input());
      expect(await notify(input())).not.toBeNull();
      expect(await notify(input({ dedupeDaily: false }))).not.toBeNull();
      expect(await countRows('notifications')).toBe(3);
    });
  });
});

describe('status changes', () => {
  it('markRead, markActioned and dismiss set that one row and leave others', async () => {
    const a = (await notify(input({ source: 'a' })))!.id;
    const b = (await notify(input({ source: 'b' })))!.id;
    const c = (await notify(input({ source: 'c' })))!.id;
    const d = (await notify(input({ source: 'd' })))!.id;

    await markRead(a);
    await markActioned(b);
    await dismiss(c);

    expect([await statusOf(a), await statusOf(b), await statusOf(c), await statusOf(d)]).toEqual(['read', 'actioned', 'dismissed', 'unread']);
  });

  // Pins today: the inbox only ever passes ids it just listed, so no caller meets this.
  it('today: a status change on a row that is gone rejects', async () => {
    await expect(markRead('missing-id')).rejects.toThrow();
  });
});

describe('markActionedBySource', () => {
  const SOURCE = 'feedback_request:aaaaaaaaaaaaaaaaaaaaaaaa';

  it('touches only rows with exactly that source, skips ones already actioned, and counts what it changed', async () => {
    const unread = (await notify(input({ source: SOURCE })))!.id;
    const read = (await notify(input({ source: SOURCE })))!.id;
    await markRead(read);
    const done = (await notify(input({ source: SOURCE })))!.id;
    await markActioned(done);
    const other = (await notify(input({ source: 'feedback_request:bbbbbbbbbbbbbbbbbbbbbbbb' })))!.id;
    const prefix = (await notify(input({ source: `${SOURCE}x` })))!.id; // same prefix, not the source

    await expect(markActionedBySource(SOURCE)).resolves.toBe(2);

    expect(await statusOf(unread)).toBe('actioned');
    expect(await statusOf(read)).toBe('actioned');
    expect(await statusOf(done)).toBe('actioned');
    expect(await statusOf(other)).toBe('unread');
    expect(await statusOf(prefix)).toBe('unread');
  });

  it('returns 0 and writes nothing when there is nothing to mark', async () => {
    const id = (await notify(input({ source: SOURCE })))!.id;
    await markActioned(id);
    const writes = countWrites();

    await expect(markActionedBySource(SOURCE)).resolves.toBe(0);
    await expect(markActionedBySource('no-such-source')).resolves.toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('markAllRead', () => {
  it('turns every unread row read, leaves the others as they were, and returns the count', async () => {
    const u1 = (await notify(input({ source: 'u1' })))!.id;
    const u2 = (await notify(input({ source: 'u2' })))!.id;
    const dismissed = (await notify(input({ source: 'd' })))!.id;
    await dismiss(dismissed);
    const actioned = (await notify(input({ source: 'a' })))!.id;
    await markActioned(actioned);

    await expect(markAllRead()).resolves.toBe(2);

    expect([await statusOf(u1), await statusOf(u2), await statusOf(dismissed), await statusOf(actioned)]).toEqual(['read', 'read', 'dismissed', 'actioned']);
  });

  it('returns 0 and writes nothing when nothing is unread', async () => {
    const writes = countWrites();
    await expect(markAllRead()).resolves.toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('getAll and observeAll', () => {
  async function seed(n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push((await notify(input({ source: `s${i}` })))!.id);
      tick();
    }
    return ids;
  }

  it('lists newest first, capped by the limit', async () => {
    const ids = await seed(4);

    expect((await getAll()).map((r) => r.id)).toEqual([...ids].reverse());
    expect((await getAll(2)).map((r) => r.id)).toEqual([ids[3], ids[2]]);
  });

  it('caps both at 100 rows by default', async () => {
    for (let i = 0; i < 101; i++) {
      await notify(input({ source: `s${i}` }));
      tick(10);
    }
    expect(await getAll()).toHaveLength(100);

    const seen: number[] = [];
    const sub = observeAll().subscribe((rows) => seen.push(rows.length));
    await settle();
    sub.unsubscribe();
    expect(seen[0]).toBe(100);
  });

  it('observeAll emits the current list, then again on a new row, newest first and capped', async () => {
    const [a, b] = await seed(2);
    const seen: string[][] = [];
    const sub = observeAll(2).subscribe((rows) => seen.push(rows.map((r) => r.id)));
    await settle();

    const c = (await notify(input({ source: 'c' })))!.id;
    await settle();
    sub.unsubscribe();

    expect(seen[0]).toEqual([b, a]);
    expect(seen.at(-1)).toEqual([c, b]);
  });
});

describe('deleteNotification', () => {
  it('destroys that one row for good', async () => {
    const keep = (await notify(input({ source: 'keep' })))!.id;
    const gone = (await notify(input({ source: 'gone' })))!.id;

    await deleteNotification(gone);

    expect(await rowById('notifications', gone)).toBeNull();
    expect(await rowById('notifications', keep)).not.toBeNull();
  });

  it('a row already gone is not an error and writes nothing', async () => {
    const writes = countWrites();
    await expect(deleteNotification('missing-id')).resolves.toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('deleteOlderThan (the 90 day TTL)', () => {
  it('removes rows created before the cutoff and keeps the cutoff row and newer ones', async () => {
    const cutoff = T0 - 90 * DAY;
    jest.setSystemTime(cutoff - 10 * DAY);
    const old = (await notify(input({ source: 'old' })))!.id;
    jest.setSystemTime(cutoff - 1);
    const justOld = (await notify(input({ source: 'just-old' })))!.id;
    jest.setSystemTime(cutoff);
    const atCutoff = (await notify(input({ source: 'at-cutoff' })))!.id;
    jest.setSystemTime(T0);
    const fresh = (await notify(input({ source: 'fresh' })))!.id;

    await expect(deleteOlderThan(cutoff)).resolves.toBe(2);

    expect(await rowById('notifications', old)).toBeNull();
    expect(await rowById('notifications', justOld)).toBeNull();
    expect(await rowById('notifications', atCutoff)).not.toBeNull();
    expect(await rowById('notifications', fresh)).not.toBeNull();
  });

  it('removes a row whatever its status, unread included', async () => {
    jest.setSystemTime(T0 - 100 * DAY);
    await notify(input());
    jest.setSystemTime(T0);

    await expect(deleteOlderThan(T0 - 90 * DAY)).resolves.toBe(1);
    expect(await countRows('notifications')).toBe(0);
  });

  it('returns 0 and writes nothing when no row is old', async () => {
    await notify(input());
    const writes = countWrites();
    await expect(deleteOlderThan(T0 - 90 * DAY)).resolves.toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('observeUnreadCount (the badge)', () => {
  /** Subscribes and lets the first count arrive. */
  async function watch() {
    const counts: number[] = [];
    const sub = observeUnreadCount().subscribe((n) => counts.push(n));
    await settle(300);
    return { counts, stop: () => sub.unsubscribe() };
  }

  it('starts at the current unread count', async () => {
    await notify(input({ source: 'a' }));
    await notify(input({ source: 'b' }));
    const w = await watch();
    expect(w.counts).toEqual([2]);
    w.stop();
  });

  it('follows writes that are more than 250 ms apart, emitting only when the count changes', async () => {
    const w = await watch();

    const a = (await notify(input({ source: 'a' })))!.id;
    await settle(300);
    await notify(input({ source: 'b' }));
    await settle(300);
    await markRead(a);
    await settle(300);
    await dismiss(a); // read -> dismissed: unread count unchanged, nothing emitted
    await settle(300);
    w.stop();

    expect(w.counts).toEqual([0, 1, 2, 1]);
  });

  // DATA-U10c-1. The badge query is observeCount() with its default 250 ms throttle, which is
  // leading-only: a write that lands inside the window after the one that triggered a fetch is
  // dropped with no trailing fetch, so the count stays stale until some later write. The skill's
  // rule is that any count driving UI state must be observeCount(false).
  describe('back-to-back writes inside 250 ms', () => {
    async function twoQuickWrites() {
      const w = await watch();
      await notify(input({ source: 'a' }));
      await settle(100);
      await notify(input({ source: 'b' }));
      await settle(2000);
      w.stop();
      return w.counts;
    }

    test.failing('the badge reaches the true count (2), not the first write\'s', async () => {
      expect((await twoQuickWrites()).at(-1)).toBe(2);
    });

    it('today: the second write is dropped and the badge stays at 1', async () => {
      expect(await twoQuickWrites()).toEqual([0, 1]);
      expect(await database.get('notifications').query(Q.where('status', 'unread')).fetchCount()).toBe(2);
    });
  });
});

// [dead-candidate] clearAll has no caller outside tests.
describe('[dead-candidate] clearAll', () => {
  it('destroys every row whatever its status and returns the count', async () => {
    const a = (await notify(input({ source: 'a' })))!.id;
    await notify(input({ source: 'b' }));
    await markRead(a);

    await expect(clearAll()).resolves.toBe(2);
    expect(await countRows('notifications')).toBe(0);
  });

  it('returns 0 and writes nothing when there are no rows', async () => {
    const writes = countWrites();
    await expect(clearAll()).resolves.toBe(0);
    expect(writes).not.toHaveBeenCalled();
  });
});
