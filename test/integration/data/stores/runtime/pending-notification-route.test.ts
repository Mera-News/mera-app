// pending-notification-route: the stash a notification tap writes and the startup gate consumes,
// against the real settings table. A JS reload is a fresh module instance (jest.isolateModules)
// on the SAME database: memory lost, the row kept. That is what the row exists for.
// Replaces lib/stores/__tests__/pending-notification-route.test.ts (which faked setting-service).
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

import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  consumePendingNotificationRoute,
  isFeedbackRequestId,
  isFeedbackRequestRoutePending,
  isStartupGatePassed,
  markStartupGatePassed,
  NAVIGATED_ROUTE_REOPEN_MS,
  PENDING_NOTIFICATION_ROUTE_KEY,
  PENDING_ROUTE_MAX_AGE_MS,
  stashPendingNotificationRoute,
  takePendingNotificationRouteForNavigation,
  __resetPendingNotificationRouteForTests,
  type NotificationHref,
} from '@/lib/stores/pending-notification-route';
import { useStrictClock } from '@/test/helpers';
import { failNextWrite, failSettingRead, restoreFaults } from './support';

type Route = typeof import('@/lib/stores/pending-notification-route');

/** A new JS context: fresh module memory (stash, gate flag, where this context navigated), same disk. */
function newContext(): Route {
  let fresh!: Route;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fresh = require('@/lib/stores/pending-notification-route');
  });
  return fresh;
}

const DETAIL: NotificationHref = { pathname: '/logged-in/article-detail', params: { articleId: 'a1' } };
const SUGGESTION: NotificationHref = {
  pathname: '/logged-in/suggestion-detail',
  params: { articleSuggestionId: 's1' },
};
const FEED = '/logged-in/app_container/feed' as const;
const ID = '0123456789abcdef01234567';
const FEEDBACK: NotificationHref = { pathname: '/logged-in/feedback-request', params: { id: ID } };

const readRow = async () => JSON.parse((await getSetting(PENDING_NOTIFICATION_ROUTE_KEY)) as string);
const writeRow = (row: unknown) => setSetting(PENDING_NOTIFICATION_ROUTE_KEY, typeof row === 'string' ? row : JSON.stringify(row));

beforeEach(() => __resetPendingNotificationRouteForTests());
afterEach(restoreFaults);

describe('stash and consume', () => {
  it('returns the stashed route once, then nothing, and the row is gone', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);

    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toEqual(DETAIL);
    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toBeNull();
    expect(await getSetting(PENDING_NOTIFICATION_ROUTE_KEY)).toBeNull();
  });

  it('writes the route, the user and the tap time to the row before it resolves', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1234);
    expect(await readRow()).toEqual({ href: DETAIL, userId: 'u1', at: 1234, navigatedAt: null });
  });

  // THE reason it is persisted: the warm listener stashes in the JS context a foreground reload is
  // about to replace.
  it('survives a reload (memory lost, row kept)', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await expect(newContext().consumePendingNotificationRoute('u1', 2000)).resolves.toEqual(DETAIL);
  });

  it.each([
    ['the Feed route', FEED],
    ['a suggestion detail', SUGGESTION],
    ['an article detail', DETAIL],
    ['a feedback request', FEEDBACK],
  ])('%s survives a reload', async (_label, href) => {
    await stashPendingNotificationRoute(href, 'u1', 1000);
    await expect(newContext().consumePendingNotificationRoute('u1', 2000)).resolves.toEqual(href);
  });

  it('a newer stash replaces the older one', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await stashPendingNotificationRoute(SUGGESTION, 'u1', 1500);
    await expect(newContext().consumePendingNotificationRoute('u1', 2000)).resolves.toEqual(SUGGESTION);
  });

  it('never opens a route for another user, and drops it', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await expect(consumePendingNotificationRoute('u2', 2000)).resolves.toBeNull();
    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toBeNull();
    expect(await getSetting(PENDING_NOTIFICATION_ROUTE_KEY)).toBeNull();
  });

  it.each([[null], [undefined], ['']])('never opens a route for user %p', async (user) => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await expect(consumePendingNotificationRoute(user, 2000)).resolves.toBeNull();
  });

  it('drops a stash older than the max age and opens one exactly at it', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await expect(consumePendingNotificationRoute('u1', 1000 + PENDING_ROUTE_MAX_AGE_MS + 1)).resolves.toBeNull();

    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await expect(consumePendingNotificationRoute('u1', 1000 + PENDING_ROUTE_MAX_AGE_MS)).resolves.toEqual(DETAIL);
  });

  describe('on the clock (no explicit time)', () => {
    beforeEach(() => useStrictClock('2026-10-09T10:00:00.000Z'));

    it('expires ten minutes after the tap, not before', async () => {
      await stashPendingNotificationRoute(DETAIL, 'u1');
      jest.setSystemTime(Date.now() + 10 * 60_000 - 1);
      await expect(newContext().consumePendingNotificationRoute('u1')).resolves.toEqual(DETAIL);
    });

    it('is dropped once ten minutes have passed', async () => {
      await stashPendingNotificationRoute(DETAIL, 'u1');
      jest.setSystemTime(Date.now() + 10 * 60_000 + 1);
      await expect(newContext().consumePendingNotificationRoute('u1')).resolves.toBeNull();
      expect(await getSetting(PENDING_NOTIFICATION_ROUTE_KEY)).toBeNull();
    });

    it('is dropped by the navigation taker too', async () => {
      await stashPendingNotificationRoute(DETAIL, 'u1');
      jest.setSystemTime(Date.now() + 10 * 60_000 + 1);
      await expect(takePendingNotificationRouteForNavigation('u1')).resolves.toBeNull();
      expect(await getSetting(PENDING_NOTIFICATION_ROUTE_KEY)).toBeNull();
    });
  });
});

describe('what parse() accepts from the persisted row', () => {
  it('ignores a corrupt row', async () => {
    await writeRow('not json');
    await expect(consumePendingNotificationRoute('u1', 2)).resolves.toBeNull();
  });

  it.each([
    ['a route outside the closed union', { href: '/logged-in/facts', userId: 'u1', at: 1 }],
    ['an unknown tab route', { href: '/logged-in/app_container/around', userId: 'u1', at: 1000 }],
    ['no href', { userId: 'u1', at: 1000 }],
    ['a null href', { href: null, userId: 'u1', at: 1000 }],
    ['no user', { href: FEED, at: 1000 }],
    ['a non-numeric tap time', { href: FEED, userId: 'u1', at: '1000' }],
    ['an empty suggestion id', { href: { pathname: '/logged-in/suggestion-detail', params: { articleSuggestionId: '' } }, userId: 'u1', at: 1000 }],
    ['a suggestion route with no params', { href: { pathname: '/logged-in/suggestion-detail' }, userId: 'u1', at: 1000 }],
    ['an empty article id', { href: { pathname: '/logged-in/article-detail', params: { articleId: '' } }, userId: 'u1', at: 1000 }],
    ['a numeric article id', { href: { pathname: '/logged-in/article-detail', params: { articleId: 7 } }, userId: 'u1', at: 1000 }],
    ['a feedback id that is not 24 hex', { href: { pathname: '/logged-in/feedback-request', params: { id: 'nope' } }, userId: 'u1', at: 1000 }],
    ['an unknown pathname', { href: { pathname: '/logged-in/settings', params: {} }, userId: 'u1', at: 1000 }],
  ])('drops a row with %s', async (_label, row) => {
    await writeRow(row);
    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toBeNull();
    expect(await getSetting(PENDING_NOTIFICATION_ROUTE_KEY)).toBeNull();
  });

  it('a row whose navigatedAt is not a number reads as not yet navigated', async () => {
    await writeRow({ href: DETAIL, userId: 'u1', at: 1000, navigatedAt: 'x' });
    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toEqual(DETAIL);
  });

  // A tap stashed by the old bundle, consumed by the new one after the OTA reload.
  it('reads a Dashboard row stashed by a pre-navx bundle as the Feed route', async () => {
    await writeRow({ href: '/logged-in/app_container/for_you', userId: 'u1', at: 1000, navigatedAt: null });
    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toBe(FEED);
  });

  it('and still honours its user and age', async () => {
    await writeRow({ href: '/logged-in/app_container/for_you', userId: 'u1', at: 1000, navigatedAt: null });
    await expect(consumePendingNotificationRoute('u2', 2000)).resolves.toBeNull();
    await writeRow({ href: '/logged-in/app_container/for_you', userId: 'u1', at: 1000, navigatedAt: null });
    await expect(consumePendingNotificationRoute('u1', 1000 + PENDING_ROUTE_MAX_AGE_MS + 1)).resolves.toBeNull();
  });
});

// The immediate path (gate open) navigates in a context a reload may be about to replace, so it
// keeps the row, stamped, for the NEXT context.
describe('navigated now, possibly wiped by a reload', () => {
  it('returns the route, stamps the row, and the same context never reopens it', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);

    await expect(takePendingNotificationRouteForNavigation('u1', 1200)).resolves.toEqual(DETAIL);

    expect(await readRow()).toEqual({ href: DETAIL, userId: 'u1', at: 1000, navigatedAt: 1200 });
    await expect(consumePendingNotificationRoute('u1', 1500)).resolves.toBeNull();
  });

  it('a new context (after the reload) reopens it once, within the window', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await takePendingNotificationRouteForNavigation('u1', 1000);

    const reloaded = newContext();
    await expect(reloaded.consumePendingNotificationRoute('u1', 3000)).resolves.toEqual(DETAIL);
    await expect(reloaded.consumePendingNotificationRoute('u1', 3000)).resolves.toBeNull();
  });

  it('a new context reopens it at exactly the window and not a millisecond later', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await takePendingNotificationRouteForNavigation('u1', 1000);
    await expect(newContext().consumePendingNotificationRoute('u1', 1000 + NAVIGATED_ROUTE_REOPEN_MS)).resolves.toEqual(DETAIL);

    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await takePendingNotificationRouteForNavigation('u1', 1000);
    await expect(newContext().consumePendingNotificationRoute('u1', 1000 + NAVIGATED_ROUTE_REOPEN_MS + 1)).resolves.toBeNull();
  });

  it('the new context\'s navigation taker never reopens a stamped row: the startup gate does', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await takePendingNotificationRouteForNavigation('u1', 1000);
    await expect(newContext().takePendingNotificationRouteForNavigation('u1', 2000)).resolves.toBeNull();
  });

  it('returns nothing for another user, and drops the row', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    await expect(takePendingNotificationRouteForNavigation('u2', 1000)).resolves.toBeNull();
    expect(await getSetting(PENDING_NOTIFICATION_ROUTE_KEY)).toBeNull();
  });

  it('returns nothing when there is no stash', async () => {
    await expect(takePendingNotificationRouteForNavigation('u1', 1000)).resolves.toBeNull();
  });
});

describe('the startup gate flag', () => {
  it('is per JS context and memory only', () => {
    expect(isStartupGatePassed()).toBe(false);
    markStartupGatePassed();
    expect(isStartupGatePassed()).toBe(true);
    expect(newContext().isStartupGatePassed()).toBe(false);
    __resetPendingNotificationRouteForTests();
    expect(isStartupGatePassed()).toBe(false);
  });
});

describe('feedback-request route', () => {
  it('isFeedbackRequestId accepts 24 hex characters only', () => {
    expect(isFeedbackRequestId(ID)).toBe(true);
    expect(isFeedbackRequestId(ID.toUpperCase())).toBe(true);
    for (const bad of ['', 'abc', `${ID}0`, '0123456789abcdef0123456g', null, 7, undefined]) {
      expect(isFeedbackRequestId(bad)).toBe(false);
    }
  });

  describe('isFeedbackRequestRoutePending (read without consuming)', () => {
    it('false with nothing stashed, or with another route stashed', async () => {
      await expect(isFeedbackRequestRoutePending(1000)).resolves.toBe(false);
      await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
      await expect(isFeedbackRequestRoutePending(1000)).resolves.toBe(false);
    });

    it('true while waiting for the startup gate, and the read consumes nothing', async () => {
      await stashPendingNotificationRoute(FEEDBACK, 'u1', 1000);

      await expect(isFeedbackRequestRoutePending(2000)).resolves.toBe(true);
      await expect(isFeedbackRequestRoutePending(2000)).resolves.toBe(true);
      expect(await readRow()).toEqual({ href: FEEDBACK, userId: 'u1', at: 1000, navigatedAt: null });

      await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toEqual(FEEDBACK);
      await expect(isFeedbackRequestRoutePending(2000)).resolves.toBe(false);
    });

    it('reads the row after a reload', async () => {
      await stashPendingNotificationRoute(FEEDBACK, 'u1', 1000);
      await expect(newContext().isFeedbackRequestRoutePending(2000)).resolves.toBe(true);
    });

    it('false once too old to open, true exactly at the limit', async () => {
      await stashPendingNotificationRoute(FEEDBACK, 'u1', 1000);
      await expect(isFeedbackRequestRoutePending(1000 + PENDING_ROUTE_MAX_AGE_MS)).resolves.toBe(true);
      await expect(isFeedbackRequestRoutePending(1000 + PENDING_ROUTE_MAX_AGE_MS + 1)).resolves.toBe(false);
    });

    it('navigated here: false; in a new context, true only inside the reopen window', async () => {
      await stashPendingNotificationRoute(FEEDBACK, 'u1', 1000);
      await takePendingNotificationRouteForNavigation('u1', 1000);

      await expect(isFeedbackRequestRoutePending(1001)).resolves.toBe(false);
      const reloaded = newContext();
      await expect(reloaded.isFeedbackRequestRoutePending(1001)).resolves.toBe(true);
      await expect(reloaded.isFeedbackRequestRoutePending(1000 + NAVIGATED_ROUTE_REOPEN_MS)).resolves.toBe(true);
      await expect(reloaded.isFeedbackRequestRoutePending(1000 + NAVIGATED_ROUTE_REOPEN_MS + 1)).resolves.toBe(false);
    });

    it('answers for the stash whoever stashed it (it takes no user)', async () => {
      await stashPendingNotificationRoute(FEEDBACK, 'someone-else', 1000);
      await expect(isFeedbackRequestRoutePending(2000)).resolves.toBe(true);
    });
  });
});

describe('failures never throw', () => {
  it('a failed stash write is reported, resolves, and leaves the memory copy to consume', async () => {
    const err = new Error('disk full');
    failNextWrite(err);

    await expect(stashPendingNotificationRoute(DETAIL, 'u1', 1000)).resolves.toBeUndefined();

    expect(logger.captureException).toHaveBeenCalledWith(err, {
      tags: { module: 'pending-notification-route', method: 'stash' },
    });
    expect(await getSetting(PENDING_NOTIFICATION_ROUTE_KEY)).toBeNull();
    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toEqual(DETAIL);
  });

  it('an unreadable row is no row, and is reported', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    const err = new Error('read failed');
    failSettingRead(PENDING_NOTIFICATION_ROUTE_KEY, err);

    await expect(newContext().consumePendingNotificationRoute('u1', 2000)).resolves.toBeNull();
    await expect(newContext().isFeedbackRequestRoutePending(2000)).resolves.toBe(false);

    expect(logger.captureException).toHaveBeenCalledWith(err, {
      tags: { module: 'pending-notification-route', method: 'read' },
    });
  });

  it('a failed delete is reported and the route is still returned', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    const err = new Error('delete failed');
    failNextWrite(err);

    await expect(consumePendingNotificationRoute('u1', 2000)).resolves.toEqual(DETAIL);

    expect(logger.captureException).toHaveBeenCalledWith(err, {
      tags: { module: 'pending-notification-route', method: 'delete' },
    });
  });

  it('a failed re-stamp is reported and the route is still returned', async () => {
    await stashPendingNotificationRoute(DETAIL, 'u1', 1000);
    const err = new Error('write failed');
    failNextWrite(err);

    await expect(takePendingNotificationRouteForNavigation('u1', 1100)).resolves.toEqual(DETAIL);

    expect(logger.captureException).toHaveBeenCalledWith(err, {
      tags: { module: 'pending-notification-route', method: 'take' },
    });
    // the row stays un-stamped, so a reload would open it through the startup gate instead
    expect(await readRow()).toEqual({ href: DETAIL, userId: 'u1', at: 1000, navigatedAt: null });
  });
});
