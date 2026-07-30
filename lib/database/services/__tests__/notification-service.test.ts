// notification-service unit tests.
//   observeUnreadCount() — badge dedup coverage (perf item A8). The badge
//   subscription is piped through rxjs distinctUntilChanged() so a stream of
//   unchanged counts (e.g. repeated observeCount() re-emits on unrelated
//   collection writes) doesn't re-render the bell badge.
//   markAllRead()/clearAll() — the bulk helpers behind the notification center
//   "clear all" button and the badge-clear-on-leave effect.
// WatermelonDB I/O is faked: a Subject stands in for `Query.observeCount()`,
// `query().fetch()` returns settable rows, and write/batch run synchronously.

import { Subject } from 'rxjs';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';

const mockCountSubject = new Subject<number>();
let mockRows: any[] = [];
const mockWrite = jest.fn(async (fn: () => any) => fn());
const mockBatch = jest.fn(async (...ops: any[]) => ops.flat());
const mockCreate = jest.fn((builder: (n: any) => void) => {
  const rec: any = {};
  builder(rec);
  return rec;
});

jest.mock('@/lib/database/index', () => ({
  __esModule: true,
  default: {
    get: jest.fn(() => ({
      query: jest.fn(() => ({
        observeCount: jest.fn(() => mockCountSubject.asObservable()),
        fetch: jest.fn(async () => mockRows),
      })),
      create: (builder: (n: any) => void) => mockCreate(builder),
    })),
    write: (fn: () => any) => mockWrite(fn),
    batch: (...ops: any[]) => mockBatch(...ops),
  },
}));

import { clearAll, markAllRead, notify, observeUnreadCount } from '../notification-service';

beforeEach(() => {
  mockRows = [];
  mockWrite.mockClear();
  mockBatch.mockClear();
  mockCreate.mockClear();
});

describe('observeUnreadCount', () => {
  it('dedupes consecutive equal counts', () => {
    const received: number[] = [];
    const sub = observeUnreadCount().subscribe((n) => received.push(n));

    mockCountSubject.next(3);
    mockCountSubject.next(3); // duplicate — should be swallowed
    mockCountSubject.next(3); // duplicate — should be swallowed
    mockCountSubject.next(5);
    mockCountSubject.next(5); // duplicate — should be swallowed
    mockCountSubject.next(2);

    expect(received).toEqual([3, 5, 2]);
    sub.unsubscribe();
  });
});

describe('markAllRead', () => {
  it('batch-updates every unread row to read and returns the count', async () => {
    const rows = [
      makeRecord({ id: 'n1', status: 'unread' }),
      makeRecord({ id: 'n2', status: 'unread' }),
      makeRecord({ id: 'n3', status: 'unread' }),
    ];
    mockRows = rows;

    const updated = await markAllRead();

    expect(updated).toBe(3);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockBatch).toHaveBeenCalledTimes(1);
    for (const r of rows) {
      expect(r.prepareUpdate).toHaveBeenCalledTimes(1);
      expect(r.status).toBe('read');
    }
  });

  it('returns 0 and skips the write when nothing is unread', async () => {
    mockRows = [];

    const updated = await markAllRead();

    expect(updated).toBe(0);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockBatch).not.toHaveBeenCalled();
  });
});

describe('notify — dedupe is opt-in via dedupeDaily', () => {
  const baseInput = {
    type: 'feed_info',
    title: 'notificationCenter.dailyLimitTitle',
    body: 'notificationCenter.dailyLimitBody',
    source: 'feed-sync',
  };
  const dedupedInput = { ...baseInput, dedupeDaily: true };

  it('creates a row when no matching (type, source) notification exists yet', async () => {
    mockRows = [];

    const result = await notify(dedupedInput);

    expect(result).not.toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('suppresses a second same-day notification with the same (type, source) when dedupeDaily is true', async () => {
    mockRows = [
      makeRecord({ type: baseInput.type, source: baseInput.source, createdAt: new Date() }),
    ];

    const result = await notify(dedupedInput);

    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('still notifies for a different type from the same source (distinct tuple)', async () => {
    mockRows = [
      makeRecord({ type: 'sync_event', source: baseInput.source, createdAt: new Date() }),
    ];

    const result = await notify(dedupedInput);

    expect(result).not.toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('still notifies for the same type from a different source (distinct tuple)', async () => {
    mockRows = [
      makeRecord({ type: baseInput.type, source: 'calibration-service', createdAt: new Date() }),
    ];

    const result = await notify(dedupedInput);

    expect(result).not.toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('re-arms and notifies again once the existing row is from a previous UTC day', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    mockRows = [
      makeRecord({ type: baseInput.type, source: baseInput.source, createdAt: yesterday }),
    ];

    const result = await notify(dedupedInput);

    expect(result).not.toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('the created row carries the input fields (type/title/body/source/status)', async () => {
    mockRows = [];

    const result = await notify(dedupedInput);

    expect(result).toMatchObject({
      type: baseInput.type,
      title: baseInput.title,
      body: baseInput.body,
      source: baseInput.source,
      status: 'unread',
    });
  });

  // Regression coverage for the "dedupe capped unrelated notifications"
  // correction: a caller that does NOT pass dedupeDaily (calibration,
  // hygiene, optimisation-plan, persona-migration) must keep the pre-existing
  // unconditional-notify behaviour — two genuinely distinct same-day events
  // (e.g. two separate hygiene reviews) must both create a row.
  it('a non-opted-in caller (e.g. hygiene) can still create two rows in the same UTC day', async () => {
    const hygieneInput = {
      type: 'hygiene',
      title: 'hygiene.notificationTitle',
      body: 'hygiene.notificationBody',
      source: 'hygiene',
      // dedupeDaily intentionally omitted — matches the real hygiene-service caller.
    };

    // An earlier hygiene notification already exists today...
    mockRows = [
      makeRecord({ type: 'hygiene', source: 'hygiene', createdAt: new Date() }),
    ];

    // ...but a second, genuinely distinct hygiene review must still notify.
    const result = await notify(hygieneInput);

    expect(result).not.toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('a non-opted-in caller ignores dedupeDaily entirely when explicitly false', async () => {
    mockRows = [
      makeRecord({ type: baseInput.type, source: baseInput.source, createdAt: new Date() }),
    ];

    const result = await notify({ ...baseInput, dedupeDaily: false });

    expect(result).not.toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe('clearAll', () => {
  it('batch-destroys every row and returns the count', async () => {
    const rows = [
      makeRecord({ id: 'n1', status: 'read' }),
      makeRecord({ id: 'n2', status: 'unread' }),
    ];
    mockRows = rows;

    const removed = await clearAll();

    expect(removed).toBe(2);
    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockBatch).toHaveBeenCalledTimes(1);
    for (const r of rows) {
      expect(r.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    }
  });

  it('returns 0 and skips the write when there are no rows', async () => {
    mockRows = [];

    const removed = await clearAll();

    expect(removed).toBe(0);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockBatch).not.toHaveBeenCalled();
  });
});
