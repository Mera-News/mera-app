// pending-notification-route: the stash a notification tap writes and the
// startup gate consumes. The settings row is a fake in-memory map so the test
// can simulate a JS reload (memory lost, row kept).

const mockRows = new Map<string, string>();
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockRows.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => {
    mockRows.set(k, v);
  }),
  deleteSetting: jest.fn(async (k: string) => {
    mockRows.delete(k);
  }),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), warn: jest.fn() },
}));

import {
  stashPendingNotificationRoute,
  consumePendingNotificationRoute,
  takePendingNotificationRouteForNavigation,
  NAVIGATED_ROUTE_REOPEN_MS,
  markStartupGatePassed,
  isStartupGatePassed,
  __resetPendingNotificationRouteForTests,
  PENDING_NOTIFICATION_ROUTE_KEY,
  PENDING_ROUTE_MAX_AGE_MS,
  type NotificationHref,
} from '../pending-notification-route';

const DETAIL: NotificationHref = {
  pathname: '/logged-in/article-detail',
  params: { articleId: 'a1' },
};

beforeEach(() => {
  mockRows.clear();
  __resetPendingNotificationRouteForTests();
});

describe('pending-notification-route', () => {
  it('returns the stashed route once, then nothing', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toEqual(DETAIL);
    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toBeNull();
    expect(mockRows.has(PENDING_NOTIFICATION_ROUTE_KEY)).toBe(false);
  });

  // THE reason it is persisted: the warm listener stashes in the JS context a
  // foreground reload is about to replace.
  it('survives a reload (memory lost, row kept)', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    __resetPendingNotificationRouteForTests();
    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toEqual(DETAIL);
  });

  it('never opens a route for another user, and drops it', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await expect(consumePendingNotificationRoute('u2', 2000)).resolves.toBeNull();
    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toBeNull();
  });

  it('never opens a route with no user', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await expect(consumePendingNotificationRoute(null, 2000)).resolves.toBeNull();
  });

  it('drops a stash older than the max age', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await expect(
      consumePendingNotificationRoute('u1', 1000 + PENDING_ROUTE_MAX_AGE_MS + 1),
    ).resolves.toBeNull();
  });

  it('ignores a corrupt or foreign-shaped row', async () => {
    mockRows.set(PENDING_NOTIFICATION_ROUTE_KEY, '{"href":"/logged-in/facts","userId":"u1","at":1}');
    await expect(consumePendingNotificationRoute('u1', 2)).resolves.toBeNull();
    mockRows.set(PENDING_NOTIFICATION_ROUTE_KEY, 'not json');
    await expect(consumePendingNotificationRoute('u1', 2)).resolves.toBeNull();
  });

  // The immediate path (gate open) navigates in a context a reload may be
  // about to replace, so it keeps the row, stamped, for the NEXT context.
  describe('navigated now, possibly wiped by a reload', () => {
    it('returns the route and the same context never reopens it', async () => {
      await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
      await expect(takePendingNotificationRouteForNavigation('u1', 1000)).resolves.toEqual(DETAIL);
      await expect(consumePendingNotificationRoute('u1', 1500)).resolves.toBeNull();
    });

    it('a new context (after the reload) reopens it once, within the window', async () => {
      await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
      await takePendingNotificationRouteForNavigation('u1', 1000);
      __resetPendingNotificationRouteForTests();
      await expect(consumePendingNotificationRoute('u1', 3000)).resolves.toEqual(DETAIL);
      await expect(consumePendingNotificationRoute('u1', 3000)).resolves.toBeNull();
    });

    it('a new context long after the navigation does not reopen it', async () => {
      await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
      await takePendingNotificationRouteForNavigation('u1', 1000);
      __resetPendingNotificationRouteForTests();
      await expect(
        consumePendingNotificationRoute('u1', 1000 + NAVIGATED_ROUTE_REOPEN_MS + 1),
      ).resolves.toBeNull();
    });

    it('returns nothing for another user', async () => {
      await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
      await expect(takePendingNotificationRouteForNavigation('u2', 1000)).resolves.toBeNull();
    });
  });

  it('startup gate flag is per JS context', () => {
    expect(isStartupGatePassed()).toBe(false);
    markStartupGatePassed();
    expect(isStartupGatePassed()).toBe(true);
    __resetPendingNotificationRouteForTests();
    expect(isStartupGatePassed()).toBe(false);
  });
});
