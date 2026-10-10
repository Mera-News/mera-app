/* eslint-disable import/first, @typescript-eslint/no-require-imports -- the jest.mock factories sit above the imports and load the shared edge lazily */
// Where a notification opens and when: resolveNotificationRoute per type, the startup-gate and PIN
// gate a tap goes through, the warm listener, handleInitialNotification and its dedupe on the tap's
// own request identifier, and the stash that carries a tap across a JS reload. Real settings table,
// article_suggestions, user, pin and for-you stores, the real pin-service and app-restart marker.
// Edges faked: expo-notifications (taps are delivered through it), expo-router's `router`, the logger.
// A "reload" is a fresh module graph over the same database (support.ts).
// Replaces the routing, tap, gate, dedupe and refresh blocks of lib/__tests__/notification-service.test.ts
// (which mocked account-service, article-suggestion-service, setting-service, for-you-store,
// pin-store, user-store and network-store).
jest.mock('expo-notifications', () => require('./edge').edge.notifications);
jest.mock('expo-device', () => require('./edge').edge.deviceModule);
jest.mock('@/lib/logger', () => require('./edge').edge.loggerModule);

import { router } from 'expo-router';
import {
  RESTART_MARKER_KEY,
  __resetAppRestartForTests,
  initRestartContext,
  wasJsRestartSync,
} from '@/lib/app-restart';
import * as articleSuggestions from '@/lib/database/services/article-suggestion-reads';
import * as settingService from '@/lib/database/services/setting-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  HANDLED_NOTIFICATION_ID_KEY,
  cleanupNotificationListeners,
  handleInitialNotification,
  resolveNotificationRoute,
  setupNotifications,
} from '@/lib/notification-service';
import { setAppLockEnabled } from '@/lib/security/app-lock-service';
import { runPinForceResetOnce } from '@/lib/security/pin-force-reset';
import { setPin } from '@/lib/security/pin-service';
import { useForYouStore } from '@/lib/stores/for-you-store';
import {
  PENDING_NOTIFICATION_ROUTE_KEY,
  __resetPendingNotificationRouteForTests,
  consumePendingNotificationRoute,
  markStartupGatePassed,
} from '@/lib/stores/pending-notification-route';
import { usePinStore } from '@/lib/stores/pin-store';
import { useUserStore } from '@/lib/stores/user-store';
import { edge, deliverTap, resetEdge, setLastTap, tapResponse } from './edge';
import { freshGraph, seedSuggestion, settle, signIn, until } from './support';

const USER = 'user-1';
const FEED = '/logged-in/app_container/feed';
const FEEDBACK_ID = '0123456789abcdef01234567';
const ARTICLE = { pathname: '/logged-in/article-detail', params: { articleId: 'a1' } };
const SUGGESTION = { pathname: '/logged-in/suggestion-detail', params: { articleSuggestionId: 's1' } };
const FACT_CHECK = { type: 'fact_check_done', articleId: 'a1' };
const logger = edge.logger;

const spies: jest.SpyInstance[] = [];
const spy = (target: object, method: string): jest.SpyInstance<any, any[]> => {
  const s = jest.spyOn(target as any, method as any) as jest.SpyInstance<any, any[]>;
  spies.push(s);
  return s;
};
const pushes = () => (router.push as jest.Mock).mock.calls.map((c) => c[0]);
const capturedMethods = () => logger.captureException.mock.calls.map((c) => c[1]?.tags?.method);
const readStash = async () => {
  const raw = await getSetting(PENDING_NOTIFICATION_ROUTE_KEY);
  return raw ? JSON.parse(raw) : null;
};

/** The PIN lock up, for real: a PIN set through the real pin-service, the lock opted into, store initialised. */
async function lockWithPin() {
  await runPinForceResetOnce();
  await setPin('1234');
  await setAppLockEnabled(true);
  await usePinStore.getState().init();
  expect(usePinStore.getState().locked).toBe(true);
}
/** The app past the startup gate (in the main graph's context). The PIN is unlocked by default. */
const openGate = () => markStartupGatePassed();

beforeEach(() => {
  resetEdge();
  // The pin store's restart hold is module-level: unlock first so it releases, then clear the
  // restart module, then the store.
  usePinStore.setState({ locked: false });
  __resetAppRestartForTests();
  usePinStore.setState(usePinStore.getInitialState(), true);
  __resetPendingNotificationRouteForTests();
  useUserStore.setState(useUserStore.getInitialState(), true);
  useUserStore.setState({ userId: USER });
  useForYouStore.setState(useForYouStore.getInitialState(), true);
});
afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  cleanupNotificationListeners();
  usePinStore.setState({ locked: false });
  await settle();
});

describe('resolveNotificationRoute', () => {
  describe('fact_check_done (an on-device type)', () => {
    it('opens the suggestion while its row exists', async () => {
      await seedSuggestion('s1');
      await expect(resolveNotificationRoute({ type: 'fact_check_done', suggestionId: 's1', articleId: 'a1' })).resolves.toEqual(
        SUGGESTION,
      );
    });

    // Suggestions prune at 48h, notification rows live 90 days, and retention is keyed by ARTICLE id.
    it('falls back to the standalone article once the suggestion is pruned', async () => {
      await expect(resolveNotificationRoute({ type: 'fact_check_done', suggestionId: 's1', articleId: 'a1' })).resolves.toEqual(
        ARTICLE,
      );
    });

    it('with no suggestion id: the article', async () => {
      await expect(resolveNotificationRoute({ type: 'fact_check_done', articleId: 'a1' })).resolves.toEqual(ARTICLE);
    });

    it('ids are trimmed', async () => {
      await seedSuggestion('s1');
      await expect(resolveNotificationRoute({ type: 'fact_check_done', suggestionId: ' s1 ' })).resolves.toEqual(SUGGESTION);
      await expect(resolveNotificationRoute({ type: 'fact_check_done', articleId: ' a1 ' })).resolves.toEqual(ARTICLE);
    });

    it.each([
      ['blank article id', { articleId: '  ' }],
      ['no ids', {}],
      ['a pruned suggestion and no article id', { suggestionId: 's-gone' }],
      ['non-string ids', { suggestionId: 7, articleId: 8 }],
    ])('%s: the Feed tab', async (_label, ids) => {
      await expect(resolveNotificationRoute({ type: 'fact_check_done', ...ids })).resolves.toBe(FEED);
    });
  });

  describe('feedback_request (a server push carrying only the request id)', () => {
    it('opens the feedback-request modal for a 24-hex id', async () => {
      await expect(resolveNotificationRoute({ type: 'feedback_request', feedbackRequestId: FEEDBACK_ID })).resolves.toEqual({
        pathname: '/logged-in/feedback-request',
        params: { id: FEEDBACK_ID },
      });
    });

    it('trims the id, and accepts upper-case hex', async () => {
      const id = 'ABCDEF0123456789ABCDEF01';
      await expect(resolveNotificationRoute({ type: 'feedback_request', feedbackRequestId: `  ${id} ` })).resolves.toEqual({
        pathname: '/logged-in/feedback-request',
        params: { id },
      });
    });

    // The id reaches a route param and the stash; anything but an ObjectId drops to the Feed tab.
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['too short', 'abc'],
      ['25 characters', `${FEEDBACK_ID}a`],
      ['not hex', '0123456789abcdef0123456z'],
      ['a number', 42],
    ])('a %s id goes to the Feed tab', async (_label, feedbackRequestId) => {
      await expect(resolveNotificationRoute({ type: 'feedback_request', feedbackRequestId })).resolves.toBe(FEED);
    });
  });

  // A `type === 'fact-check'` branch once deep-linked to the Fact checks chip. It was removed with the
  // push itself: delivering it needed the server to store which user asked about which article, a
  // durable article-level record the privacy policy promises we do not keep. The name stays a
  // Feed-tab route forever; the on-device type is spelled differently on purpose.
  describe('everything else opens the Feed tab', () => {
    it.each([
      ['the server fact-check type, with every id it ever carried', { type: 'fact-check', factCheckId: 'fc1', articleId: 'a1', suggestionId: 's1' }],
      ['news-ready', { type: 'news-ready' }],
      ['calibration', { type: 'calibration' }],
      ['model-download-complete', { type: 'model-download-complete' }],
      ['an unknown type', { type: 'whatever' }],
      ['an untyped payload', {}],
      ['an untyped payload carrying an article id', { articleId: 'a1', suggestionId: 's1' }],
    ])('%s', async (_label, data) => {
      await seedSuggestion('s1');
      await expect(resolveNotificationRoute(data)).resolves.toBe(FEED);
    });

    it.each([[null], [undefined]])('a %p payload', async (data) => {
      await expect(resolveNotificationRoute(data)).resolves.toBe(FEED);
    });
  });

  it('never throws: a failing suggestion lookup is reported and the Feed tab opens', async () => {
    spy(articleSuggestions, 'getSuggestionByServerId').mockRejectedValueOnce(new Error('db gone'));
    await expect(resolveNotificationRoute({ type: 'fact_check_done', suggestionId: 's1', articleId: 'a1' })).resolves.toBe(FEED);
    expect(capturedMethods()).toEqual(['resolveNotificationRoute']);
  });
});

describe('a tap goes through the startup gate and the PIN lock', () => {
  const coldTap = (data: Record<string, unknown>, identifier = 'n-1') => {
    setLastTap(tapResponse(identifier, data));
    return handleInitialNotification();
  };

  it('with nothing delivered: no navigation, no stash', async () => {
    openGate();
    await handleInitialNotification();
    expect(pushes()).toEqual([]);
    expect(await readStash()).toBeNull();
  });

  describe('gate passed, PIN unlocked', () => {
    beforeEach(openGate);

    it.each([
      ['an article-detail', FACT_CHECK, ARTICLE],
      ['a feedback-request', { type: 'feedback_request', feedbackRequestId: FEEDBACK_ID }, { pathname: '/logged-in/feedback-request', params: { id: FEEDBACK_ID } }],
      ['the Feed tab (untyped)', { type: 'news-ready' }, FEED],
      ['the Feed tab (server fact-check, never a deep link)', { type: 'fact-check', articleId: 'a1', suggestionId: 's1' }, FEED],
    ])('navigates at once to %s', async (_label, data, route) => {
      await coldTap(data);
      expect(pushes()).toEqual([route]);
    });

    it('opens the suggestion when its row exists', async () => {
      await seedSuggestion('s1');
      await coldTap({ type: 'fact_check_done', suggestionId: 's1', articleId: 'a1' });
      expect(pushes()).toEqual([SUGGESTION]);
    });

    it('the same context never reopens it: the row is kept, stamped as already shown', async () => {
      await coldTap(FACT_CHECK);
      expect(await readStash()).toMatchObject({ href: ARTICLE, userId: USER, navigatedAt: expect.any(Number) });
      await expect(consumePendingNotificationRoute(USER)).resolves.toBeNull();
    });

    it('a navigation that throws is reported with the payload, and does not escape', async () => {
      (router.push as jest.Mock).mockImplementationOnce(() => {
        throw new Error('navigation error');
      });
      await expect(coldTap({ type: 'news-ready' })).resolves.toBeUndefined();
      expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { service: 'notification-service', method: 'handleNotificationTap' },
        extra: { data: { type: 'news-ready' } },
      });
    });
  });

  describe('before the startup gate has passed in this context', () => {
    it('stashes the route instead of navigating, and the gate consumes it once', async () => {
      await coldTap(FACT_CHECK);
      expect(pushes()).toEqual([]);
      expect(await readStash()).toMatchObject({ href: ARTICLE, userId: USER, navigatedAt: null });

      await expect(consumePendingNotificationRoute(USER)).resolves.toEqual(ARTICLE);
      await expect(consumePendingNotificationRoute(USER)).resolves.toBeNull();
    });

    it('a Feed-bound tap does not even refresh the For You cache yet', async () => {
      await seedSuggestion('s1', 0.8);
      await coldTap({ type: 'news-ready' });
      expect(useForYouStore.getState().suggestions).toEqual([]);
    });
  });

  describe('while the PIN lock is up', () => {
    it('stashes, never navigates over the lock screen, and a PIN unlock hands it to the gate', async () => {
      openGate();
      await lockWithPin();

      await coldTap(FACT_CHECK);

      expect(pushes()).toEqual([]);
      expect(await readStash()).toMatchObject({ href: ARTICLE, navigatedAt: null });
      usePinStore.getState().unlock();
      await expect(consumePendingNotificationRoute(USER)).resolves.toEqual(ARTICLE);
    });
  });

  it('with no signed-in user: nothing is stashed and nothing is opened', async () => {
    openGate();
    useUserStore.setState({ userId: null });
    await coldTap(FACT_CHECK);
    expect(pushes()).toEqual([]);
    expect(await readStash()).toBeNull();
  });

  it('a stash left for another account is not opened for this one', async () => {
    openGate();
    await coldTap(FACT_CHECK, 'n-a');
    __resetPendingNotificationRouteForTests(); // reload: only the row is left
    await expect(consumePendingNotificationRoute('someone-else')).resolves.toBeNull();
  });

  describe('a tap to the Feed route first refreshes the For You cache from the database', () => {
    beforeEach(openGate);

    it('swaps in the rows, best score first and unscored last, before navigating', async () => {
      await seedSuggestion('low', 0.3);
      await seedSuggestion('fresh');
      await seedSuggestion('high', 0.9);
      let seenAtPush: string[] = [];
      (router.push as jest.Mock).mockImplementationOnce(() => {
        seenAtPush = useForYouStore.getState().suggestions.map((s) => s._id);
      });

      await coldTap({ type: 'news-ready' });

      expect(seenAtPush).toEqual(['high', 'low', 'fresh']);
      expect(useForYouStore.getState().unscoredCount).toBe(1);
      expect(pushes()).toEqual([FEED]);
    });

    it('an empty database leaves the cache the reader is looking at untouched', async () => {
      const cached = [{ _id: 'cached-1' }] as never;
      useForYouStore.setState({ suggestions: cached, unscoredCount: 4 });
      await coldTap({ type: 'news-ready' });
      expect(useForYouStore.getState().suggestions).toBe(cached);
      expect(useForYouStore.getState().unscoredCount).toBe(4);
      expect(pushes()).toEqual([FEED]);
    });

    it('a failing read is reported, the cache is left alone, and the tap still navigates', async () => {
      await seedSuggestion('s1', 0.5);
      spy(articleSuggestions, 'loadSuggestions').mockRejectedValueOnce(new Error('read failed'));
      await coldTap({ type: 'news-ready' });
      expect(capturedMethods()).toEqual(['refreshForYouCacheFromDb']);
      expect(useForYouStore.getState().suggestions).toEqual([]);
      expect(pushes()).toEqual([FEED]);
    });

    it('a typed route leaves the cache alone', async () => {
      await seedSuggestion('s1', 0.5);
      await coldTap(FACT_CHECK);
      expect(pushes()).toEqual([ARTICLE]);
      expect(useForYouStore.getState().suggestions).toEqual([]);
    });
  });
});

describe('the warm listener (a tap while the app runs)', () => {
  const tap = async (response: unknown) => {
    await setupNotifications();
    expect(edge.responseListeners.size).toBe(1);
    deliverTap(response);
  };

  it('with the gate open: stashes first, records the identifier, then navigates', async () => {
    openGate();
    await tap(tapResponse('warm-1', FACT_CHECK));
    await until(() => pushes().length === 1, 'the warm tap to navigate');
    expect(pushes()).toEqual([ARTICLE]);
    expect(await getSetting(HANDLED_NOTIFICATION_ID_KEY)).toBe('warm-1');
    expect(await readStash()).toMatchObject({ href: ARTICLE });
  });

  it('before the gate: persists the stash, which a reload then hands to the new startup gate', async () => {
    await tap(tapResponse('warm-2', FACT_CHECK));
    await until(async () => (await getSetting(HANDLED_NOTIFICATION_ID_KEY)) === 'warm-2', 'the tap to be recorded');
    expect(pushes()).toEqual([]);

    __resetPendingNotificationRouteForTests(); // the reload that every return to the foreground is
    await expect(consumePendingNotificationRoute(USER)).resolves.toEqual(ARTICLE);
  });

  it('a navigation that throws is reported, not raised into the listener', async () => {
    openGate();
    (router.push as jest.Mock).mockImplementationOnce(() => {
      throw new Error('navigation error');
    });
    await tap(tapResponse('warm-3', { type: 'news-ready' }));
    await until(() => capturedMethods().includes('handleNotificationTap'), 'the failure to be reported');
  });
});

describe('across a JS reload (a fresh module graph over the same database)', () => {
  // The common background tap for a reader with no PIN: the gate is open in the pre-reload context,
  // so the listener navigates at once, and the foreground reload then wipes that navigation. The tap
  // is already recorded as handled, so the new boot skips it; the route must still be on disk for
  // the new context's startup gate.
  it('gate open, warm tap, reload: the boot skips the tap, the new startup gate still opens the route', async () => {
    const before = freshGraph();
    signIn(before);
    before.route.markStartupGatePassed();
    await before.service.setupNotifications();
    deliverTap(tapResponse('warm-open-1', FACT_CHECK));
    await until(() => pushes().length === 1, 'the warm tap to navigate');
    expect(pushes()).toEqual([ARTICLE]);

    const after = freshGraph();
    signIn(after);
    setLastTap(tapResponse('warm-open-1', FACT_CHECK)); // survives the reload, as on device
    await after.service.handleInitialNotification();
    expect(pushes()).toEqual([ARTICLE]); // still just the pre-reload navigation: this boot skipped the tap

    await expect(after.route.consumePendingNotificationRoute(USER)).resolves.toEqual(ARTICLE);
    await expect(after.route.consumePendingNotificationRoute(USER)).resolves.toBeNull();
  });

  it('a feedback_request tap before the gate is stashed and survives the reload', async () => {
    const before = freshGraph();
    signIn(before);
    setLastTap(tapResponse('fb-1', { type: 'feedback_request', feedbackRequestId: FEEDBACK_ID }));
    await before.service.handleInitialNotification();
    expect(pushes()).toEqual([]);

    const after = freshGraph();
    await expect(after.route.consumePendingNotificationRoute(USER)).resolves.toEqual({
      pathname: '/logged-in/feedback-request',
      params: { id: FEEDBACK_ID },
    });
  });

  it('a row stashed by a pre-navx bundle (the Dashboard href) opens the Feed route in the new bundle', async () => {
    await setSetting(
      PENDING_NOTIFICATION_ROUTE_KEY,
      JSON.stringify({ href: '/logged-in/app_container/for_you', userId: USER, at: Date.now(), navigatedAt: null }),
    );
    const after = freshGraph();
    await expect(after.route.consumePendingNotificationRoute(USER)).resolves.toBe(FEED);
  });
});

// getLastNotificationResponseAsync() survives a JS reload and every return to the foreground is one,
// so the boot path must tell a NEW tap from one it already handled. The persisted request identifier
// is the key. Not the delivery date, which says nothing about when the tap happened.
describe('handleInitialNotification dedupes on the persisted request identifier', () => {
  beforeEach(openGate);
  const boot = (response: unknown) => {
    setLastTap(response);
    return handleInitialNotification();
  };
  /** A restart boot: module memory gone, startup gate not yet passed again until the gate runs. */
  const reboot = () => {
    __resetPendingNotificationRouteForTests();
    openGate();
  };

  it('handles a tap once, records its identifier, and ignores the same tap on the next boot', async () => {
    await boot(tapResponse('n-7', { type: 'news-ready' }));
    expect(pushes()).toEqual([FEED]);
    expect(await getSetting(HANDLED_NOTIFICATION_ID_KEY)).toBe('n-7');

    reboot();
    await boot(tapResponse('n-7', { type: 'news-ready' }));
    expect(pushes()).toEqual([FEED]);
  });

  it('a new identifier is handled even when an older one is recorded', async () => {
    await setSetting(HANDLED_NOTIFICATION_ID_KEY, 'n-old');
    await boot(tapResponse('n-new', { type: 'news-ready' }));
    expect(pushes()).toEqual([FEED]);
    expect(await getSetting(HANDLED_NOTIFICATION_ID_KEY)).toBe('n-new');
  });

  it('two different taps delivered at the same time both route: the delivery date is not the key', async () => {
    const delivered = 1_700_000_123;
    await boot(tapResponse('tap-a', { type: 'news-ready' }, delivered));
    reboot();
    await boot(tapResponse('tap-b', FACT_CHECK, delivered));
    expect(pushes()).toEqual([FEED, ARTICLE]);
  });

  it('the same tap redelivered with a later date is still the same tap', async () => {
    await boot(tapResponse('tap-a', { type: 'news-ready' }, 1_700_000_000));
    reboot();
    await boot(tapResponse('tap-a', { type: 'news-ready' }, 1_800_000_000));
    expect(pushes()).toEqual([FEED]);
  });

  it('a tap the warm listener already handled is not opened again by the restart boot', async () => {
    await setupNotifications();
    deliverTap(tapResponse('n-8', { type: 'news-ready' }));
    await until(() => pushes().length === 1, 'the warm tap to navigate');

    reboot();
    await boot(tapResponse('n-8', { type: 'news-ready' }));
    expect(pushes()).toEqual([FEED]);
  });

  // The restart boot runs handleInitialNotification like any other. "Skip it on a restart boot" was
  // the obvious wrong fix: a tap made while the app is backgrounded produces a return, and that
  // return can itself be the restart, so skipping restart boots drops the very taps it serves.
  describe('a restart boot (the app-restart marker is on disk)', () => {
    beforeEach(async () => {
      await setSetting(
        RESTART_MARKER_KEY,
        JSON.stringify({ reason: 'ota', at: Date.now(), backgroundedAt: Date.now() - 60_000, lastForegroundAt: null }),
      );
      __resetAppRestartForTests();
      await initRestartContext();
      expect(wasJsRestartSync()).toBe(true);
    });

    it('still handles a tap it has not seen', async () => {
      await boot(tapResponse('after-restart', FACT_CHECK));
      expect(pushes()).toEqual([ARTICLE]);
    });

    it('still skips a tap it has seen', async () => {
      await setSetting(HANDLED_NOTIFICATION_ID_KEY, 'seen-before');
      await boot(tapResponse('seen-before', FACT_CHECK));
      expect(pushes()).toEqual([]);
    });
  });

  it('a response with no identifier cannot be deduped: handled on every boot, nothing recorded', async () => {
    await boot(tapResponse(undefined, { type: 'news-ready' }));
    reboot();
    await boot(tapResponse(undefined, { type: 'news-ready' }));
    expect(pushes()).toEqual([FEED, FEED]);
    expect(await getSetting(HANDLED_NOTIFICATION_ID_KEY)).toBeNull();
  });

  it('failing to record the identifier does not stop the tap from opening', async () => {
    const realSet = settingService.setSetting;
    spy(settingService, 'setSetting').mockImplementation((key: string, value: string) =>
      key === HANDLED_NOTIFICATION_ID_KEY ? Promise.reject(new Error('disk full')) : realSet(key, value),
    );
    await boot(tapResponse('n-9', { type: 'news-ready' }));
    expect(pushes()).toEqual([FEED]);
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('an unreadable notification response is reported and swallowed', async () => {
    edge.notifications.getLastNotificationResponseAsync.mockRejectedValueOnce(new Error('storage error'));
    await expect(handleInitialNotification()).resolves.toBeUndefined();
    expect(capturedMethods()).toEqual(['handleInitialNotification']);
    expect(pushes()).toEqual([]);
  });
});
