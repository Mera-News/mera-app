// CH15: the call ids of an async scoring job travel OUTSIDE the E2EE envelope (the gateway reads
// them), so an id that is an article's server _id tells the gateway, per signed-in user, which
// articles the device judged relevant. Relevance ids are already positional counters (score:N);
// the reasons job still sends reason:<article id>.
//
// The pipeline is driven through the real scoring cycle (support.ts: run-background-cycle setup) to a
// reasons submit; the wire is read with captureJobPosts (gzip body inflated) and gatewayCalls('job').
// A bug is a `test.failing` for the correct behaviour plus a passing "today" sibling (R14).
import { runBackgroundCycle } from '@/lib/background/run-inference-handler';
import { gatewayCalls, server } from '@/test/helpers';
import {
  captureJobPosts,
  drive,
  gatewayPolls,
  ids,
  reasonJobCalls,
  resetCycleWorld,
  settleUntil,
  submitJobs,
} from './support';

jest.setTimeout(90_000);

beforeEach(resetCycleWorld);
afterEach(() => server.events.removeAllListeners());

const SEEDED = ids(5, 'sentinelart');

/** Relevance goes out, finishes with every article impactful, and the reasons job is submitted. */
async function runToReasonsSubmit() {
  const wire = captureJobPosts();
  await submitJobs(SEEDED);
  gatewayPolls(0);
  await jest.advanceTimersByTimeAsync(2_000);
  await drive(runBackgroundCycle('app-resume'));
  await settleUntil(() => reasonJobCalls().length > 0);
  await wire.settled();
  expect(reasonJobCalls().length).toBeGreaterThan(0);
  return wire.posts;
}

const callIds = () => gatewayCalls('job').map((c) => c.callId ?? '');

describe('relevance call ids', () => {
  it('are positional score:N counters, never an article id', async () => {
    await runToReasonsSubmit();
    const relevance = callIds().filter((id) => id.startsWith('score:'));
    expect(relevance.length).toBeGreaterThan(0);
    for (const id of relevance) expect(id).toMatch(/^score:\d+$/);
    for (const id of relevance) expect(SEEDED.some((a) => id.includes(a))).toBe(false);
  });
});

describe('reasons call ids', () => {
  test.failing("CH15: no article id leaves the device in a job's call ids", async () => {
    const posts = await runToReasonsSubmit();

    for (const id of callIds()) {
      expect(id).toMatch(/^(score|reason):\d+$/);
      expect(SEEDED.some((a) => id.includes(a))).toBe(false);
    }
    // The request bodies as the wire carried them (inflated): no seeded article id anywhere.
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const post of posts) {
      expect(post.body).not.toBeNull();
      const text = JSON.stringify(post.body);
      for (const a of SEEDED) expect(text).not.toContain(a);
    }
  });

  it('CH15 today: reasons call ids are reason:<article id>', async () => {
    const posts = await runToReasonsSubmit();

    const reasons = reasonJobCalls().map((c) => c.callId);
    expect(reasons.length).toBeGreaterThan(0);
    for (const id of reasons) expect(SEEDED).toContain((id ?? '').slice('reason:'.length));
    // The same ids are in the request body the gateway received.
    const reasonPost = posts.find((p) => p.body?.requests.some((r) => r.id.startsWith('reason:')));
    expect(reasonPost?.body?.requests.map((r) => r.id).sort()).toEqual(reasons.sort());
  });
});
