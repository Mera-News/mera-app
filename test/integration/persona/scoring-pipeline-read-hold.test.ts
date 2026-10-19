// The read hold in the scoring pipeline: a 429 daily-quota-exceeded pauses cloud scoring without
// burning an attempt, reporting, or retrying before the reset; the hold survives a reload; and
// dispatch resumes after the reset. Real pipeline, real limiter, gateway mock with setReadMeter.
import * as SecureStore from 'expo-secure-store';
import { getSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { noteBillingTier, resetPlanRiseForTests } from '@/lib/subscription/plan-rise';
import { getReadHold, isReadHeld, READ_HOLD_KEY, resetReadHold } from '@/lib/subscription/read-hold';
import { server, setAppState } from '@/test/helpers';
import { setReadMeter } from '@/test/mock-backend/gateway/state';
import {
  batches,
  cleanupWorld,
  drive,
  gateway,
  ids,
  letKickPlayOut,
  NOW,
  passTime,
  phases,
  resetPipelineWorld,
  seedAndEnqueue,
  seedArticles,
  tick,
  tickUntil,
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
const MAX_JITTER = 30 * 60_000;

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

describe('the read hold in the scoring pipeline', () => {
  it('a 429 holds: the batch goes back to queued with its attempt and key kept, nothing is reported', async () => {
    const posts = await holdMidRun();

    expect(posts()).toBe(1);
    expect(isReadHeld()).toBe(true);
    expect(getReadHold()).toEqual({ resetAt: RESET, used: 1 });
    const [b0] = await batches();
    expect(b0).toMatchObject({ phase: 'queued', attempt: 0 });
    expect(b0.idemKey).toBeTruthy();
    expect(logger.captureException).not.toHaveBeenCalled();
  });

  it('while held, ticks and fresh enqueues send nothing and make no new batches', async () => {
    const posts = await holdMidRun();
    const before = (await batches()).length;

    for (let i = 0; i < 5; i += 1) await tick();
    await seedArticles(ids(25, 'more'));
    const out = await drive(pipeline.enqueueCandidates(ids(25, 'more'), true));
    await passTime(60_000);

    expect(posts()).toBe(1);
    expect(out.deferred).toEqual([]);
    expect((await batches()).length).toBe(before);
    expect((await batches()).every((b) => b.attempt === 0)).toBe(true);
  });

  it('the hold survives a reload: a background wake reads it back and POSTs nothing', async () => {
    await holdMidRun();
    resetReadHold(); // a fresh JS context: memory empty, the settings row kept
    const posts = countJobPosts();

    const res = await drive(pipeline.submitScoringForBackground({ deadlineAt: Date.now() + 25_000, articleIds: [] }));

    expect(res.stoppedBy).toBe('read-hold');
    expect(isReadHeld()).toBe(true);
    expect(posts()).toBe(0);
  });

  it('a background step that meets the 429 stops at once instead of re-picking the batch', async () => {
    gateway();
    await seedAndEnqueue(ids(25));
    setReadMeter({ resetAt: RESET });
    const posts = countJobPosts();

    const res = await drive(pipeline.submitScoringForBackground({ deadlineAt: Date.now() + 25_000, articleIds: [] }));

    expect(res).toMatchObject({ submitted: 0, stoppedBy: 'read-hold' });
    expect(posts()).toBe(1);
    expect((await batches()).every((b) => b.phase === 'queued' && b.attempt === 0)).toBe(true);
  });

  it('on-device mode is never held: the background step stops for on-device, not for the hold', async () => {
    await holdMidRun();
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });

    const res = await drive(pipeline.submitScoringForBackground({ deadlineAt: Date.now() + 25_000, articleIds: [] }));

    expect(res.stoppedBy).toBe('on-device');
  });

  it('after the reset, dispatch resumes with the same batch and key', async () => {
    await holdMidRun();
    const keyBefore = (await batches())[0].idemKey;
    setReadMeter({ resetAt: null });

    // Jump the fake clock past the hold end. passTime would step through 2.5h of timers 50ms at
    // a time (~180k turns), which is what made this test load-sensitive.
    jest.setSystemTime(RESET + MAX_JITTER + 1_000);
    expect(isReadHeld()).toBe(false);
    await tickUntil(async () => (await phases())[0] === 'waiting-relevance');

    const [b0] = await batches();
    expect(b0).toMatchObject({ phase: 'waiting-relevance', attempt: 0, idemKey: keyBefore });
    await letKickPlayOut();
  });
});

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

  it('parks while held: no submits and almost no run reads over 30s', async () => {
    const posts = await heldInForeground();
    await waitFor(() => false, 2_000); // the first poller tick runs and parks
    const reads = jest.spyOn(SecureStore, 'getItemAsync');

    await waitFor(() => false, 30_000);

    expect(posts()).toBe(1);
    expect(reads.mock.calls.length).toBeLessThan(5);
    expect(isReadHeld()).toBe(true);
    reads.mockRestore();
    await wrapUp();
  });

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

  it('the hold end wakes the parked poller with nothing else happening', async () => {
    await heldInForeground();
    await waitFor(() => false, 2_000);
    const keyBefore = (await batches())[0].idemKey;
    setReadMeter({ resetAt: null });
    const { holdUntil } = JSON.parse((await getSetting(READ_HOLD_KEY)) ?? '{}') as { holdUntil: number };

    // One jump to just before the hold end: a parked poller has no interval to step through.
    await jest.advanceTimersByTimeAsync(holdUntil - Date.now() - 2_000);
    expect(isReadHeld()).toBe(true);
    expect((await phases())[0]).toBe('queued');

    expect(await waitFor(firstWaiting, 10_000)).toBe(true);
    expect((await batches())[0]).toMatchObject({ attempt: 0, idemKey: keyBefore });
    await wrapUp();
  });
});
