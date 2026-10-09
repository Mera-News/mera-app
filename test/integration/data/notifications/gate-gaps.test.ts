/* eslint-disable import/first, @typescript-eslint/no-require-imports -- the jest.mock factories sit above the imports and load the shared edge lazily */
// Branch arms the legacy notification-service suite reached and the seam tests did not (gate G46): a
// warm tap whose response carries no request identifier, and a token rotation that finds no cached
// token on the persona. Each test starts a FRESH module graph (a JS reload, see support.ts). Edges
// faked: expo-notifications, expo-device, the logger, the Intercom wrapper's token hand-off.
jest.mock('expo-notifications', () => require('./edge').edge.notifications);
jest.mock('expo-device', () => require('./edge').edge.deviceModule);
jest.mock('@/lib/logger', () => require('./edge').edge.loggerModule);
jest.mock('@/lib/intercom', () => ({
  ...jest.requireActual('@/lib/intercom'),
  sendIntercomPushToken: require('./edge').edge.sendIntercomPushToken,
}));

import { HANDLED_NOTIFICATION_ID_KEY } from '@/lib/notification-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { advanceUntil, useStrictClock } from '@/test/helpers';
import { personaFor } from '@/test/mock-backend/fixtures/graphql/persona';
import { deliverTap, edge, resetEdge, rotateDeviceToken, tapResponse } from './edge';
import { freshGraph, recordOperation, settle, signIn, until, type Graph } from './support';

const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const TOKEN = 'ExponentPushToken[test-token]';
const FEED = '/logged-in/app_container/feed';
const n = edge.notifications;

let g: Graph;
const pushes = () => g.router.push.mock.calls.map((c) => c[0]);

beforeEach(() => {
  resetEdge();
  g = freshGraph();
  signIn(g);
});
afterEach(async () => {
  g.service.cleanupNotificationListeners();
  jest.useRealTimers();
  await settle();
});

describe('a tap delivered to the warm listener with no request identifier', () => {
  it('still opens: navigates, and records no identifier because it has none to record', async () => {
    g.route.markStartupGatePassed();
    await g.service.setupNotifications();
    const before = pushes().length;

    deliverTap(tapResponse(undefined, { type: 'news-ready' }));
    await until(() => pushes().length === before + 1, 'the tap to navigate');

    expect(pushes().slice(before)).toEqual([FEED]);
    expect(await getSetting(HANDLED_NOTIFICATION_ID_KEY)).toBeNull();
  });
});

describe('the token-rotation listener with nothing cached on the persona', () => {
  beforeEach(() => useStrictClock(NOW));

  /** A registered device (rotation listener attached) whose persona has not loaded: the user id is set, the persona is null. */
  async function bootWithoutPersona() {
    g.user.useUserStore.setState({ userPersona: personaFor(NOW, { userId: 'user-1', expoPushToken: TOKEN }) });
    await g.service.ensurePushTokenRegistered('user-1');
    expect(edge.tokenListeners.size).toBe(1);
    g.user.useUserStore.setState({ userPersona: null });
    n.getExpoPushTokenAsync.mockClear();
  }

  it('sends the registered token, since there is nothing to compare it with', async () => {
    await bootWithoutPersona();
    const seen = recordOperation('UpdateExpoPushToken');

    rotateDeviceToken('raw-rotated');
    await advanceUntil(() => seen.length === 1);

    expect(seen).toEqual([{ input: { userId: 'user-1', expoPushToken: TOKEN } }]);
  });
});
