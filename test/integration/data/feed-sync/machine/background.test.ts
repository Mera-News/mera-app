// FeedSyncMachine in BACKGROUND mode (`start('', ctx, { background: hooks })`, the `mera-background`
// OS task): nobody is watching, so no wake lock, no status, no toast, no offline pause, no
// foreground enqueue or flush, and the bounded background submit stands in for the scoring step.
// The hooks are assembled from the real freshness shaping and scoring submit.
// Replaces the background-mode block of lib/scheduler/feed-sync/__tests__/FeedSyncMachine.test.ts.
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
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import { advanceUntilDone, assertNoGatewayViolations, server } from '@/test/helpers';
import {
  cleanupFeedSync,
  makeCtx,
  resetFeedSyncMemory,
  resetScoringWorld,
  seedInterest,
  serveHydrate,
  servePersona,
} from '../steps/support';
import {
  backgroundHooks,
  oid,
  watchScoring,
  settleMachine,
  startMachine,
} from './support';

jest.setTimeout(60_000);

describe('FeedSyncMachine in background mode', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    await resetScoringWorld();
    watchScoring();
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
    assertNoGatewayViolations();
  });

  const HOUR = 3_600_000;

  /** Fresh server ids (inserted a moment ago) the topic matches, with the interest seeded. */
  async function serveFresh(count: number, over: { stale?: number } = {}) {
    const fresh = Array.from({ length: count }, (_, i) => oid(i + 1));
    const old = Array.from({ length: over.stale ?? 0 }, (_, i) => oid(1000 + i, Date.now() - 7 * HOUR));
    await seedInterest('I follow racing', ['formula 1']);
    const served = serveHydrate();
    server.use(servePersona({ topics: { 'formula 1': [...fresh, ...old] } }), ...served.handlers);
    return { fresh, old, served };
  }

  const run = (hooks: ReturnType<typeof backgroundHooks>, t = makeCtx()) =>
    advanceUntilDone(startMachine(t, { background: hooks.hooks }));

  describe('a background run with new articles', () => {

    it('shapes the diff first: an id inserted more than 6h ago is never hydrated', async () => {
      const { fresh, old, served } = await serveFresh(3, { stale: 2 });
      const hooks = backgroundHooks();

      await run(hooks);

      const asked = served.stats.requests.flatMap((r) => r.ids);
      expect(asked.sort()).toEqual([...fresh].sort());
      expect(asked.some((id) => old.includes(id))).toBe(false);
    });
  });
});
