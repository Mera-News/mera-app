// notification-service — observeUnreadCount() dedup coverage (perf item A8).
// The badge subscription is piped through rxjs distinctUntilChanged() so a
// stream of unchanged counts (e.g. repeated observeCount() re-emits on
// unrelated collection writes) doesn't re-render the bell badge. WatermelonDB
// I/O is faked with a Subject standing in for `Query.observeCount()`.

import { Subject } from 'rxjs';

const mockCountSubject = new Subject<number>();

jest.mock('@/lib/database/index', () => ({
  __esModule: true,
  default: {
    get: jest.fn(() => ({
      query: jest.fn(() => ({
        observeCount: jest.fn(() => mockCountSubject.asObservable()),
      })),
    })),
  },
}));

import { observeUnreadCount } from '../notification-service';

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
