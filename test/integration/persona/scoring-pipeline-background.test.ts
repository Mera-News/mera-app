// scoring-pipeline background entry points (the OS task): advanceWaitingForBackground (step a),
// submitScoringForBackground (step b), the stale-run verdict's run lookup, and the rule that a task
// step skips UI work while the app is not on screen. Real pipeline, DB, stores, limiter and gateway
// mock; the task's window is the real `deadlineAt` arithmetic on the fake clock.
//
// The limiter spaces every gateway action 1s apart in fake time, which the fake clock pays 1:1 in
// wall time, so a step that touches three batches takes seconds: the file raises the test timeout.
// A slow download is a results GET that moves the clock (`slowResults`), the way a real one eats the
// window.
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { http, HttpResponse, server, setAppState } from '@/test/helpers';
import {
  NOW,
  batches,
  cleanupWorld,
  currentRun,
  drive,
  gateway,
  holdKick,
  ids,
  jobSubmits,
  later,
  passTime,
  patchBatch,
  phases,
  resetPipelineWorld,
  rows,
  seedAndEnqueue,
  seedArticles,
  slowResults,
  tickUntil,
  warmAttestation,
  watchResultsAuth,
  watchTraffic,
  type Script,
} from './scoring-pipeline-kit';

jest.setTimeout(60_000);
// Hoisted above the imports by babel-jest; written here so the imports stay first.
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

const { advanceWaitingForBackground, submitScoringForBackground } = pipeline;
const DEADLINE_MS = 60_000;
const deadline = (ms = DEADLINE_MS) => Date.now() + ms;
const JOBS = '*/v1/inference/jobs';
const RESULTS = '*/v1/inference/jobs/:id/results';

beforeEach(() => resetPipelineWorld());
afterEach(cleanupWorld);

describe('advanceWaitingForBackground (step a)', () => {
  it('reports no-run when there is nothing to collect', async () => {
    const out = await drive(advanceWaitingForBackground({ deadlineAt: deadline() }));
    expect(out.stoppedBy).toBe('no-run');
  });

  /** Three waiting-relevance batches, every one ready on the gateway, every candidate impactful. */
  async function threeReadyBatches(script: Script = {}) {
    gateway(script, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(5 + 10 + 25)); // three ramped batches
    await tickUntil(async () => (await phases()).filter((p) => p === 'waiting-relevance').length === 3);
    const before = await batches();
    expect(before.map((b) => b.phase)).toEqual(['waiting-relevance', 'waiting-relevance', 'waiting-relevance']);
    gateway(script); // every job now finishes when it is polled
    return before;
  }

  it("collects every ready relevance batch and submits each one's reasons, in task context", async () => {
    await threeReadyBatches();
    const auth = watchResultsAuth();
    const { runId } = (await currentRun())!;

    const out = await drive(advanceWaitingForBackground({ deadlineAt: deadline() }));

    expect(out).toEqual(expect.objectContaining({ appliedRelevance: 3, reasonsSubmitted: 3, stoppedBy: 'done' }));
    // Task context authenticates with the JWT alone (never a capability token): three GETs, three JWTs.
    expect(auth).toHaveLength(3);
    expect(auth.every((a) => a.startsWith('Bearer ') && !a.startsWith('Bearer cap.'))).toBe(true);
    expect(await phases()).toEqual(['waiting-reasons', 'waiting-reasons', 'waiting-reasons']);
    // Each reasons job carries its own batch's reasons idempotency key.
    const reasonsJobs = jobSubmits().slice(3);
    reasonsJobs.forEach((j, i) => expect(j.key).toMatch(new RegExp(`^${runId}:${i}:r:\\d+$`)));
  });

  it('stops cleanly once the collect floor is reached; later batches stay exactly as they were', async () => {
    const before = await threeReadyBatches();
    // The first download eats 35s of a 60s window: 25s left is under the 30s floor.
    slowResults(35_000);
    const auth = watchResultsAuth();

    const out = await drive(advanceWaitingForBackground({ deadlineAt: deadline() }));

    expect(out).toEqual(expect.objectContaining({ appliedRelevance: 1, reasonsSubmitted: 1, stoppedBy: 'deadline' }));
    expect(auth).toHaveLength(1);
    const run = await batches();
    expect(run[0].phase).toBe('waiting-reasons');
    for (const i of [1, 2]) {
      expect(run[i]).toEqual(before[i]);
    }
  });

  it('respects the 30s floor when decryption is slow', async () => {
    await threeReadyBatches();
    // 18s per download (the real limiter's 1s grants also eat into the window): 60s left → apply
    // (~40s left) → apply (~20s left) → stop.
    slowResults(18_000);

    const out = await drive(advanceWaitingForBackground({ deadlineAt: deadline() }));

    expect(out.appliedRelevance).toBe(2);
    expect(out.reasonsSubmitted).toBe(2);
    expect(out.stoppedBy).toBe('deadline');
    expect(await phases()).toEqual(['waiting-reasons', 'waiting-reasons', 'waiting-relevance']);
  });

  it('never requeues on pending, even hours after submit', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    await patchBatch(0, (b) => {
      b.submittedAt = Date.now() - 6 * 3600_000;
    });
    const submitted = jobSubmits().length;

    await drive(advanceWaitingForBackground({ deadlineAt: deadline() }));

    const b = (await batches())[0];
    expect(b.phase).toBe('waiting-relevance');
    expect(b.attempt).toBe(0);
    expect(jobSubmits()).toHaveLength(submitted);
  });

  it('requeues on a definite 404 but does not resubmit or drain from the task', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    server.use(http.get(RESULTS, () => new HttpResponse('Unknown requestId', { status: 404 })));
    const submitted = jobSubmits().length;

    await drive(advanceWaitingForBackground({ deadlineAt: deadline() }));

    expect((await batches())[0].phase).toBe('queued');
    expect(jobSubmits()).toHaveLength(submitted);
  });

  it('stops quietly on no-auth and leaves the batch waiting', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    server.use(http.get(RESULTS, () => new HttpResponse('Unauthorized', { status: 401 })));

    const out = await drive(advanceWaitingForBackground({ deadlineAt: deadline() }));

    expect(out.stoppedBy).toBe('no-auth');
    expect((await batches())[0].phase).toBe('waiting-relevance');
  });

  it('starts nothing when the deadline is inside the POST reserve', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    const traffic = watchTraffic();

    const out = await drive(advanceWaitingForBackground({ deadlineAt: deadline(5_000) }));

    expect(out.stoppedBy).toBe('deadline');
    expect(traffic).toEqual([]);
  });

  it('task context does not leak into a concurrent foreground recover()', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    const traffic = watchTraffic();
    // The task's results GET hangs until released.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    server.use(
      http.get(
        RESULTS,
        async () => {
          await gate;
          return undefined;
        },
        { once: true },
      ),
    );

    const task = advanceWaitingForBackground({ deadlineAt: deadline() });
    await passTime(1_500); // the task has its slot and is waiting on the download
    expect(traffic).toEqual(['poll']);
    const fg = pipeline.recover();
    await passTime(500);
    // The foreground recover() waits for the task step already running instead of polling beside it.
    expect(traffic).toEqual(['poll']);
    release();
    await drive(Promise.all([task, fg]));

    expect(await fg).toBe('running');
  });
});

describe('submitScoringForBackground (step b)', () => {
  it('does nothing in on-device mode', async () => {
    holdKick(); // on-device
    const out = await drive(submitScoringForBackground({ deadlineAt: deadline(), articleIds: ['a0'] }));
    expect(out).toEqual({ submitted: 0, stoppedBy: 'on-device' });
  });

  it('batches the new rows and submits in task context, single attempt, keyed', async () => {
    gateway({}, { pendingPolls: 999 });
    await seedArticles(['n0', 'n1']);

    const out = await drive(submitScoringForBackground({ deadlineAt: deadline(), articleIds: ['n0', 'n1'] }));

    expect(out).toEqual({ submitted: 1, stoppedBy: 'done' });
    const [job] = jobSubmits();
    // JWT only (never a capability token: there is none for a fresh job), first generation key
    expect(job.auth.startsWith('Bearer ') && !job.auth.startsWith('Bearer cap.')).toBe(true);
    expect(job.key).toMatch(/:0:rel:0$/);
    expect((await batches())[0].phase).toBe('waiting-relevance');
  });

  it('respects maxBatches and leaves the rest queued for the foreground', async () => {
    gateway({}, { pendingPolls: 999 });
    const many = ids(5 + 10 + 25, 'm'); // three ramped batches
    await seedArticles(many);

    const out = await drive(submitScoringForBackground({ deadlineAt: deadline(), articleIds: many, maxBatches: 1 }));

    expect(out.submitted).toBe(1);
    const ph = await phases();
    expect(ph.filter((p) => p === 'queued')).toHaveLength(2);
  });

  it('stops at the first no-auth and hands the batch back untouched', async () => {
    gateway({}, { pendingPolls: 999 });
    await seedArticles(['n0']);
    server.use(http.post(JOBS, () => new HttpResponse(null, { status: 401 }), { once: true }));

    const out = await drive(submitScoringForBackground({ deadlineAt: deadline(), articleIds: ['n0'] }));

    expect(out.stoppedBy).toBe('no-auth');
    const b = (await batches())[0];
    expect(b.phase).toBe('queued');
    expect(b.attempt).toBe(0);
  });

  it('submits nothing inside the POST reserve', async () => {
    gateway({}, { pendingPolls: 999 });
    await seedArticles(['n0']);

    const out = await drive(submitScoringForBackground({ deadlineAt: deadline(10_000), articleIds: ['n0'] }));

    expect(out.stoppedBy).toBe('deadline');
    expect(jobSubmits()).toHaveLength(0);
  });
});

describe('staleRunVerdict', () => {
  it('is none with no run', async () => {
    expect(await pipeline.staleRunVerdict(NOW)).toBe('none');
  });
});

describe('task context skips UI work while the app is not active', () => {
  it('step (a) in background applies results without refreshing the store or pushing progress', async () => {
    const script: Script = { scores: { a0: 0.9 } };
    gateway(script, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    gateway(script);
    setAppState('background');
    const ui = useForYouStore.getState();
    const inFlightBefore = ui.reasonsInFlightIds;
    expect(ui.asyncJobPhase).toBe('relevance');

    const out = await drive(advanceWaitingForBackground({ deadlineAt: deadline() }));

    expect(out.appliedRelevance).toBe(1);
    // the score is persisted…
    expect((await rows()).a0.relevance).toBe(0.8);
    // …but the store was neither refreshed nor handed a progress push
    const after = useForYouStore.getState();
    expect(after.suggestions).toEqual([]);
    expect(after.reasonsInFlightIds).toBe(inFlightBefore);
    expect(after.asyncJobPhase).toBe('relevance');
  });

  it('step (b) in background submits without refreshing the store or pushing progress', async () => {
    gateway({}, { pendingPolls: 999 });
    setAppState('background');
    await seedArticles(['n0']);

    const out = await drive(submitScoringForBackground({ deadlineAt: deadline(), articleIds: ['n0'] }));

    expect(out.submitted).toBe(1);
    const after = useForYouStore.getState();
    expect(after.suggestions).toEqual([]);
    expect(after.asyncJobPhase).toBe('idle');
    expect(after.reasonsInFlightIds.size).toBe(0);
  });

  it('the silent-push wake (background context) still refreshes as before', async () => {
    const script: Script = { scores: { a0: 0.9 } };
    gateway(script, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    const b0 = (await batches())[0];
    gateway(script);
    setAppState('background');
    later();

    await drive(pipeline.handlePush(b0.requestId, 'background'));

    expect(useForYouStore.getState().suggestions.find((s) => s._id === 'a0')?.relevance).toBe(0.8);
  });
});
