// nav-state: the module-level pathname mirror non-React code reads, plus the app-wide
// "a screen just came into view" signal. Driven against the real time-tick and the real
// translation queue; nothing is mocked but Sentry (an edge) and the clock.
import * as Sentry from '@sentry/react-native';
import { getCurrentPathname, setCurrentPathname } from '@/lib/nav-state';
import { __resetTimeTickForTests, subscribeTimeTick } from '@/lib/time-tick';
import {
  __resetTranslationQueueForTests,
  enqueueTranslationTask,
  getTranslationEpoch,
  isDropped,
} from '@/lib/translation-queue';
import { useFakeClock } from '@/test/helpers';

const addBreadcrumb = Sentry.addBreadcrumb as jest.Mock;

const settled = (p: Promise<unknown>) =>
  Promise.race([p.then(() => 'settled'), new Promise((r) => setImmediate(() => r('pending')))]);

/** A translation call that has been dispatched and never finishes, so later items queue behind it. */
function occupyQueue() {
  void enqueueTranslationTask(() => new Promise<void>(() => {}), { label: 'blocker' });
}

/** Moves the clock on, then changes the route: the tick only publishes when the clock moved. */
function navigate(pathname: string) {
  jest.advanceTimersByTime(1_000);
  setCurrentPathname(pathname);
}

beforeEach(() => {
  useFakeClock(Date.UTC(2026, 9, 9, 12, 0, 0));
  setCurrentPathname(''); // reset module state between cases
  __resetTimeTickForTests();
  __resetTranslationQueueForTests();
  addBreadcrumb.mockClear();
});

afterEach(() => {
  __resetTimeTickForTests();
  __resetTranslationQueueForTests();
});

describe('setCurrentPathname', () => {
  it('mirrors the pathname for non-React readers', () => {
    setCurrentPathname('/logged-in/app_container/feed');
    expect(getCurrentPathname()).toBe('/logged-in/app_container/feed');
  });

  // The root layout calls this on every route change, so one call here refreshes every
  // on-screen age instead of each screen needing its own focus effect.
  it('notifies the time ticker when the route CHANGES', () => {
    const listener = jest.fn();
    subscribeTimeTick(listener);

    navigate('/a');
    expect(listener).toHaveBeenCalledTimes(1);
    navigate('/b');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // The same signal retires translation work queued for the screen the user just left:
  // the queue is serial, so those stale titles are what the new screen's title would wait behind.
  it('retires stale translation work on a route CHANGE', async () => {
    occupyQueue();
    const first = enqueueTranslationTask(async () => 'title-1');

    setCurrentPathname('/logged-in/app_container/feed');
    expect(getTranslationEpoch()).toBe(1);
    expect(isDropped(await first)).toBe(true);

    const second = enqueueTranslationTask(async () => 'title-2');
    setCurrentPathname('/logged-in/article/123');
    expect(getTranslationEpoch()).toBe(2);
    expect(isDropped(await second)).toBe(true);

    // The route is the reason the queue logs for the sweep.
    expect(addBreadcrumb).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: '[TranslationQueue] Dropped stale items on route change',
        data: expect.objectContaining({ reason: '/logged-in/article/123', dropped: 1 }),
      }),
    );
  });

  it('does NOT retire translation work when the pathname is unchanged', async () => {
    occupyQueue();
    setCurrentPathname('/a');
    expect(getTranslationEpoch()).toBe(1);

    const queued = enqueueTranslationTask(async () => 'title');
    setCurrentPathname('/a');
    expect(getTranslationEpoch()).toBe(1);
    expect(await settled(queued)).toBe('pending');
  });

  it('does NOT notify when the pathname is unchanged', () => {
    navigate('/a');
    const listener = jest.fn();
    subscribeTimeTick(listener);

    navigate('/a'); // the clock moves, the route does not
    navigate('/a');
    expect(listener).not.toHaveBeenCalled();
  });
});
