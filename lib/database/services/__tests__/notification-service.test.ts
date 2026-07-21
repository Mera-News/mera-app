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

jest.mock('@/lib/database/index', () => ({
  __esModule: true,
  default: {
    get: jest.fn(() => ({
      query: jest.fn(() => ({
        observeCount: jest.fn(() => mockCountSubject.asObservable()),
        fetch: jest.fn(async () => mockRows),
      })),
    })),
    write: (fn: () => any) => mockWrite(fn),
    batch: (...ops: any[]) => mockBatch(...ops),
  },
}));

import { clearAll, markAllRead, observeUnreadCount } from '../notification-service';

beforeEach(() => {
  mockRows = [];
  mockWrite.mockClear();
  mockBatch.mockClear();
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
