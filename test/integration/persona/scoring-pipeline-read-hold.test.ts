
import * as pipeline from '@/lib/services/scoring-pipeline';
import { noteBillingTier, resetPlanRiseForTests } from '@/lib/subscription/plan-rise';
import { resetReadHold } from '@/lib/subscription/read-hold';
import { server, setAppState } from '@/test/helpers';
import { setReadMeter } from '@/test/mock-backend/gateway/state';
import {
  batches,
  cleanupWorld,
  drive,
  gateway,
  ids,
  NOW,
  phases,
  resetPipelineWorld,
  seedAndEnqueue,
  tick,
} from './scoring-pipeline-kit';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

const RESET = NOW + 2 * 3_600_000;

/** Every POST to /v1/inference/jobs from now on, refused or not. */
function countJobPosts(): () => number {
  let n = 0;
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && request.url.endsWith('/v1/inference/jobs')) n += 1;
  });
  return () => n;
}

beforeEach(async () => {
  await resetPipelineWorld();
  resetReadHold();
  resetPlanRiseForTests();
});
afterEach(cleanupWorld);

/** A run of three queued batches, then the meter refuses the first submit. */
async function holdMidRun() {
  gateway();
  await seedAndEnqueue(ids(25));
  expect(await phases()).toEqual(['queued', 'queued', 'queued']);
  setReadMeter({ resetAt: RESET });
  const posts = countJobPosts();
  await tick();
  return posts;
}

// The foreground poller under the hold. A held run with nothing in flight has nothing to poll or
// submit, so the poller parks instead of re-reading the run (SQLite + keychain) every 750ms, and
// wakes when the hold ends: early on a plan rise, or at the hold end (expiry emits nothing).
describe('the foreground poller under the read hold', () => {
  /** Let fake time pass with a real turn per step, so MSW answers. True once `cond` holds. */
  async function waitFor(cond: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
    for (let t = 0; t < ms; t += 50) {
      if (await cond()) return true;
      await jest.advanceTimersByTimeAsync(50);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return cond();
  }
  const firstWaiting = async () => (await phases())[0] === 'waiting-relevance';

  /** Held mid-run, then the app comes to the foreground and the poller starts. */
  async function heldInForeground() {
    const posts = await holdMidRun();
    setAppState('active');
    await drive(pipeline.recover());
    return posts;
  }

  /** Background the app and let the post-finalize kick play out, so no fetch outlives the test. */
  async function wrapUp() {
    setAppState('inactive');
    await waitFor(() => false, 3_000);
  }

  it('a plan rise clears the hold and the parked poller resubmits batch 0 with the same key', async () => {
    await heldInForeground();
    await waitFor(() => false, 2_000);
    const keyBefore = (await batches())[0].idemKey;
    setReadMeter({ resetAt: null });

    noteBillingTier('starter');
    noteBillingTier('individual');

    expect(Date.now()).toBeLessThan(RESET);
    expect(await waitFor(firstWaiting, 10_000)).toBe(true);
    expect((await batches())[0]).toMatchObject({ phase: 'waiting-relevance', attempt: 0, idemKey: keyBefore });
    await wrapUp();
  });
});
