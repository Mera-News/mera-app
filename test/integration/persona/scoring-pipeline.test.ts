// scoring-pipeline lifecycle seams: enqueue, dispatch floor and ceiling, submit failures, polling,
// recovery, finalize. The pipeline runs for real against the in-memory DB, the real stores, the real
// gateway client and limiter, and the gateway mock (async jobs, E2EE both ways). Nothing between the
// pipeline and the network is mocked.
//
// The foreground poller is OFF unless a test asks for it (resetPipelineWorld({ poller: true })), so a
// test is the only driver of the run: `tick()` = one limiter spacing later + one pollTick. The real
// limiter spaces gateway actions 1s apart, and run creation takes the first slot (attestation), so a
// freshly created run's first batch is `queued` until the next tick.

import { invalidateJwtCache } from '@/lib/auth-client';
import { clearAttestationCache } from '@/lib/e2ee/e2ee-cache';
import { addSuppression } from '@/lib/database/services/suppression-service';
import { _resetForTests as resetLimiter } from '@/lib/llm/gateway-rate-limiter';
import * as limiter from '@/lib/llm/gateway-rate-limiter';
import * as articleStore from '@/lib/database/services/scoring-pipeline-store';
import * as scoringService from '@/lib/mera-protocol/scoring-service';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import {
  deleteSuggestionByServerId,
  getScoredDonorRows,
  saveScoringResult,
} from '@/lib/database/services/article-suggestion-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import * as articleService from '@/lib/database/services/article-suggestion-service';
import logger from '@/lib/logger';
import { derivePipelineBatchProgress } from '@/lib/algorithms/scoring-pipeline-policy';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { appStateModule } from '@/test/helpers/app-state';
import {
  attestationRequests,
  gatewayCalls,
  http,
  HttpResponse,
  server,
  setAppState,
} from '@/test/helpers';
import {
  ageRows,
  batches,
  burstUntil,
  captureSubmits,
  cleanupWorld,
  currentRun,
  drive,
  gateway,
  holdJobs,
  holdKick,
  ids,
  jobSubmits,
  later,
  letKickPlayOut,
  offCurveKeyHex,
  passTime,
  patchBatch,
  patchRun,
  phases,
  resetPipelineWorld,
  rows,
  seedAndEnqueue,
  seedArticles,
  serveAttestationKey,
  tick,
  tickUntil,
  warmAttestation,
  watchResultsPolls,
  watchTraffic,
  type Script,
} from './scoring-pipeline-kit';

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

const { MAX_BATCH_ARTICLES, MIN_DISPATCH } = pipeline;

beforeEach(() => resetPipelineWorld());
afterEach(cleanupWorld);

const JOBS = '*/v1/inference/jobs';
const waitingCount = async () => (await phases()).filter((p) => p === 'waiting-relevance').length;

describe('enqueueUnscoredEligible — headline admission (P8 site 1b)', () => {
  it('enqueues a factless TOP-HEADLINE row', async () => {
    await seedArticles(['h1'], { headline: 'GLOBAL' });

    const res = await drive(pipeline.enqueueUnscoredEligible());

    expect(res.enqueued).toBe(1);
  });

  it('still skips a factless row that is NOT headline-sourced', async () => {
    await seedArticles(['orphan'], { factless: true });

    const res = await drive(pipeline.enqueueUnscoredEligible());

    expect(res.enqueued).toBe(0);
  });

  it('still skips a headline row with no English text', async () => {
    await seedArticles(['h-empty'], { headline: 'GLOBAL', description: null });

    const res = await drive(pipeline.enqueueUnscoredEligible());

    expect(res.enqueued).toBe(0);
  });
});

describe('model-key validation fail-fast (MERA-APP-39)', () => {
  // The run keypair is minted on a valid ecdsa attestation; the batch stays `queued` because
  // minting took the limiter slot. The attestation then turns bad (an off-curve secp256k1 key),
  // which is what rebuildE2EEContext sees on the first submit.
  async function runThenBreakAttestation() {
    gateway({}, { curve: 'ecdsa' });
    await seedAndEnqueue(ids(25));
    expect(await phases()).toEqual(['queued', 'queued', 'queued']);
    serveAttestationKey(offCurveKeyHex());
    expect(gatewayCalls('job')).toHaveLength(0);
  }

  it('fails a relevance batch terminally when the E2EE rebuild rejects with ModelKeyValidationError — no submit, no loop', async () => {
    await runThenBreakAttestation();

    await tick();

    // The bad key is rejected BEFORE any gateway POST.
    expect(gatewayCalls('job')).toHaveLength(0);
    // The batch went terminal at once (no attempt cap, no requeue) while its siblings wait.
    const [b0, b1] = await batches();
    expect(b0).toMatchObject({ phase: 'failed', failureReason: 'submit-failed' });
    expect(b1.phase).toBe('queued');

    // The rest of the run goes the same way and the run finalizes instead of re-driving forever.
    await tickUntil(async () => (await pipeline.getPipelineStatus()) === 'idle');
    expect(useForYouStore.getState().lastProcessingRunFinishedAt).not.toBeNull();
    expect(gatewayCalls('job')).toHaveLength(0);
    // The failed rows are still unscored, so the post-finalize kick tries a new run. It meets the
    // same bad key and creates none.
    await letKickPlayOut();
    expect(await currentRun()).toBeNull();
  });

  it('does not re-drive a poll tick after a model-key failure (loop is dead)', async () => {
    await runThenBreakAttestation();
    await tickUntil(async () => (await pipeline.getPipelineStatus()) === 'idle');
    await letKickPlayOut();
    const attestations = attestationRequests();

    // A subsequent tick finds no run and does nothing — the ~7s re-drive is gone.
    await tick();

    expect(attestationRequests()).toBe(attestations);
    expect(gatewayCalls('job')).toHaveLength(0);
  });

  it('contains a generic rebuild throw instead of letting it escape the drain', async () => {
    // Previously this propagated out of doDrain → drain() → runPollerTick, leaving the batch
    // stranded in submitting-* while revertStuckSubmitters requeued it every 60s — the MERA-APP-39
    // wedge, which made every feed-sync cycle a no-op for as long as the run stayed non-terminal.
    // Now the throw is captured, the batch goes through failOrRetrySubmit, and the drain resolves.
    gateway();
    await seedAndEnqueue(ids(25));
    server.use(http.get('*/api/attestation/report', () => new HttpResponse('nope', { status: 400 })));
    clearAttestationCache();

    await expect(tick()).resolves.toBeUndefined();

    expect(gatewayCalls('job')).toHaveLength(0);
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ step: 'submit' }) }),
    );
    expect((await batches())[0]).toMatchObject({ phase: 'queued', attempt: 1 });
  });

  it('caps submit retries so a persistently-throwing batch cannot loop forever', async () => {
    // revertStuckSubmitters used to requeue without checking MAX_BATCH_ATTEMPTS, so a submit that
    // throws every time cycled indefinitely and only the FeedSyncMachine stale guard broke it.
    // The batch must reach a terminal phase and let the run finalize.
    gateway();
    await seedAndEnqueue(ids(25));
    let failedAttestations = 0;
    server.use(
      http.get('*/api/attestation/report', () => {
        failedAttestations += 1;
        return new HttpResponse('always fails', { status: 400 });
      }),
    );
    clearAttestationCache();

    await tickUntil(async () => (await pipeline.getPipelineStatus()) === 'idle', 30);

    expect(await pipeline.getPipelineStatus()).toBe('idle');
    // Exactly what MAX_BATCH_ATTEMPTS (2) submit attempts cost in failed attestation fetches. A cap of
    // 3 makes it 9; a missing cap never reaches idle.
    expect(failedAttestations).toBe(6);
    expect(useForYouStore.getState().lastProcessingRunFinishedAt).not.toBeNull();
    expect(gatewayCalls('job')).toHaveLength(0);
    await letKickPlayOut();
  });
});

describe('enqueueCandidates', () => {
  it('creates a run and submits up to MAX_IN_FLIGHT batches', async () => {
    gateway({}, { pendingPolls: 99 });
    const submits = captureSubmits();
    await warmAttestation();
    await seedAndEnqueue(ids(5 + 10 + 25 + 50)); // 4 ramped batches

    await tickUntil(async () => (await waitingCount()) === 3);
    await passTime(100);

    const bs = await batches();
    expect(bs).toHaveLength(4);
    const waiting = bs.filter((b) => b.phase === 'waiting-relevance');
    expect(waiting).toHaveLength(3);
    expect(bs.filter((b) => b.phase === 'queued')).toHaveLength(1);
    expect(submits).toHaveLength(3);
    // distinct requestIds
    expect(new Set(waiting.map((b) => b.requestId)).size).toBe(3);
    // one keypair minted for the run: every submit carries the same client key
    expect(new Set(gatewayCalls('job').map((c) => c.headers['x-client-pub-key'])).size).toBe(1);
    expect(attestationRequests()).toBe(1);
  });

  it('dedups ids already in a non-terminal batch on re-enqueue', async () => {
    gateway({}, { pendingPolls: 99 });
    const submits = captureSubmits();
    await warmAttestation();
    await seedAndEnqueue(ids(2 * MAX_BATCH_ARTICLES));
    const before = (await batches()).length;
    await passTime(100);
    const sent = submits.length;

    await drive(pipeline.enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES))); // identical ids

    expect((await batches()).length).toBe(before);
    await passTime(100);
    expect(submits).toHaveLength(sent);
  });

  it('attaches the push token to the first and the last relevance submit only', async () => {
    gateway({}, { pendingPolls: 99 });
    const submits = captureSubmits();
    await warmAttestation();
    // 3 ramped batches (5, 10, 25), all admitted (MAX_IN_FLIGHT >= 3).
    await seedAndEnqueue(ids(5 + 10 + 25));

    await tickUntil(async () => (await waitingCount()) === 3);
    await passTime(100);

    // batch 0 is the run's first → token (its push wakes the first cards).
    // batch 1 submitted while batch 2 still queued → no token.
    // batch 2 submitted last → token.
    expect(submits.map((s) => s.token)).toEqual(['ExponentPushToken[test]', null, 'ExponentPushToken[test]']);
  });

  it('requeues without burning an attempt when a submit is throttled', async () => {
    gateway({}, { pendingPolls: 99 });
    const submits = captureSubmits();
    server.use(http.post(JOBS, () => new HttpResponse(null, { status: 429 }), { once: true }));
    await warmAttestation();

    await seedAndEnqueue(ids(25));
    await passTime(100);

    const b = (await batches())[0];
    expect(b.phase).toBe('queued');
    expect(b.attempt).toBe(0);
    expect(submits).toHaveLength(1);
  });

  it('fails a batch after two failed submits without writing any scores; siblings unaffected', async () => {
    gateway({}, { pendingPolls: 99 });
    const submits = captureSubmits();
    server.use(
      http.post(JOBS, () => new HttpResponse('bad', { status: 400 }), { once: true }),
      http.post(JOBS, () => new HttpResponse('bad', { status: 400 }), { once: true }),
    );
    await warmAttestation();

    await seedAndEnqueue(ids(5 + 10)); // 2 ramped batches
    await tickUntil(async () => (await phases())[1] === 'waiting-relevance');
    await passTime(100);

    const [b0, b1] = await batches();
    expect(b0.phase).toBe('failed');
    expect(b0.failureReason).toBe('submit-failed');
    expect(b1.phase).toBe('waiting-relevance');
    expect(Object.values(await rows()).every((r) => r.status === 'unscored' && r.relevance === 0)).toBe(true);
    expect(submits).toHaveLength(3);
  });
});

// The gate elects ONE representative per duplicate story group and holds the
// siblings back to inherit its score, so `candidateIds` is a fraction of the
// articles a run analyses. Each batch records the articles it covers, which is
// what the "Analysing X of Y articles" header counts.
describe('on-device mode sends no new work to the cloud', () => {
  beforeEach(() => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
  });

  it('enqueueCandidates is a no-op in on-device mode', async () => {
    await seedArticles(ids(2 * MAX_BATCH_ARTICLES));
    const res = await drive(pipeline.enqueueCandidates(ids(2 * MAX_BATCH_ARTICLES)));
    expect(res).toEqual({ deferred: [] });
    expect(await currentRun()).toBeNull();
    expect(gatewayCalls('job')).toHaveLength(0);
    // no run keypair was minted either
    expect(attestationRequests()).toBe(0);
  });

  it('enqueueOrphanedReasons is a no-op in on-device mode', async () => {
    await seedArticles(['o0']);
    await saveScoringResult('o0', { relevance: 0.8, reason: '', reasonSkipped: false });
    await drive(pipeline.enqueueOrphanedReasons());
    expect(await currentRun()).toBeNull();
    // the sweep never even looked: the stranded row is still owed a note
    expect((await rows()).o0.status).toBe('reason_pending');
    expect(attestationRequests()).toBe(0);
  });

  it('the same enqueue still dispatches in cloud mode (the guard is mode-specific)', async () => {
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
    gateway({}, { pendingPolls: 99 });
    await warmAttestation();
    await seedArticles(ids(MAX_BATCH_ARTICLES));
    await drive(pipeline.enqueueCandidates(ids(MAX_BATCH_ARTICLES)));
    expect(await currentRun()).not.toBeNull();
    await passTime(100);
    expect(gatewayCalls('job').length).toBeGreaterThan(0);
  });
});

describe('enqueueCandidates — covered-id bookkeeping', () => {
  it('records the gate coverage on the batch and leaves dispatch untouched', async () => {
    gateway({}, { pendingPolls: 99 });
    await seedArticles(['rep', 'solo', 'x1', 'x2', 'x3']);

    await drive(
      pipeline.enqueueCandidates(['rep', 'solo', 'x1', 'x2', 'x3'], false, {
        rep: ['rep', 'sib1', 'sib2'],
        solo: ['solo'],
      }),
    );

    const run = (await currentRun())!;
    const batch = run.batches[0];
    expect(batch.candidateIds).toEqual(['rep', 'solo', 'x1', 'x2', 'x3']);
    // Ids without a gate entry cover themselves.
    expect(batch.coveredIds).toEqual(['rep', 'sib1', 'sib2', 'solo', 'x1', 'x2', 'x3']);
    expect(derivePipelineBatchProgress(run).total).toBe(7);
  });

  it('writes coveredIds even with no gate map, so the denominator survives the submit shrink', async () => {
    gateway({}, { pendingPolls: 99 });
    await seedArticles(ids(MIN_DISPATCH));
    await drive(pipeline.enqueueCandidates(ids(MIN_DISPATCH)));
    const batch = (await batches())[0];
    expect(batch.coveredIds).toEqual(batch.candidateIds);
  });
});

describe('enqueueCandidates: MIN_DISPATCH floor / MAX_BATCH_ARTICLES ceiling', () => {
  // Rows are seeded at the frozen clock, so they are fresh (no staleness escape) until ageRows().
  const enqueueFresh = async (articleIds: string[], flush = false) => {
    await seedArticles(articleIds);
    return drive(pipeline.enqueueCandidates(articleIds, flush));
  };

  it('dispatches at exactly MIN_DISPATCH — one LLM call, no waiting for a bigger batch', async () => {
    gateway({}, { pendingPolls: 99 });
    const res = await enqueueFresh(ids(MIN_DISPATCH));

    // The whole point of the floor: 5 ready articles go out NOW rather than
    // waiting out MAX_UNSCORED_WAIT_MS for a quantum that may never fill.
    expect(res.deferred).toHaveLength(0);
    const bs = await batches();
    expect(bs).toHaveLength(1);
    expect(bs[0].candidateIds).toHaveLength(MIN_DISPATCH);
  });

  it('defers a sub-MIN_DISPATCH remainder when the oldest unscored row is fresh', async () => {
    const res = await enqueueFresh(ids(MIN_DISPATCH - 1));

    expect(res.deferred).toHaveLength(MIN_DISPATCH - 1);
    expect(await currentRun()).toBeNull();
    expect(gatewayCalls('job')).toHaveLength(0);
  });

  it('flushPartial=true dispatches a sub-MIN_DISPATCH remainder and returns no deferred ids', async () => {
    gateway({}, { pendingPolls: 99 });
    const res = await enqueueFresh(ids(2), true);

    expect(res.deferred).toHaveLength(0);
    const bs = await batches();
    expect(bs).toHaveLength(1);
    expect(bs[0].candidateIds).toHaveLength(2);
  });

  it('ramps batch sizes 1, 2, 5, then 10 calls so the first cards wait on ONE call', async () => {
    gateway({}, { pendingPolls: 99 });
    await enqueueFresh(ids(5 + 10 + 25 + 50 + 50 + MIN_DISPATCH));

    const sizes = (await batches()).map((b) => b.candidateIds.length);
    expect(sizes).toEqual([5, 10, 25, 50, 50, MIN_DISPATCH]);
    expect(sizes[3]).toBe(MAX_BATCH_ARTICLES);
  });

  it('dispatches a sub-MIN_DISPATCH remainder once the oldest row exceeds MAX_UNSCORED_WAIT_MS (escape)', async () => {
    gateway({}, { pendingPolls: 99 });
    await seedArticles(ids(3));
    ageRows();

    await drive(pipeline.enqueueCandidates(ids(3)));

    const bs = await batches();
    expect(bs).toHaveLength(1);
    expect(bs[0].candidateIds).toHaveLength(3);
  });

  it('applies the SAME rule to appends: ceiling+remainder with an active run', async () => {
    gateway({}, { pendingPolls: 99 });
    // Establish an active run.
    await enqueueFresh(ids(MIN_DISPATCH, 'seed'));
    expect(await batches()).toHaveLength(1);

    // Fresh oldest → a sub-floor remainder must still defer on an append.
    // The append continues the run's ramp at position 1 (10), then 2 (25).
    const res = await enqueueFresh(ids(10 + 25 + MIN_DISPATCH - 1, 'more'));

    expect((await batches()).map((b) => b.candidateIds.length)).toEqual([MIN_DISPATCH, 10, 25]);
    expect(res.deferred).toHaveLength(MIN_DISPATCH - 1);
  });

  it('enqueueOrphanedReasons finalizes stranded sub-threshold rows before queueing reasons', async () => {
    gateway({}, { pendingPolls: 99 });
    await seedArticles(['s1', 'ok']);
    await saveScoringResult('s1', { relevance: 0.35, reason: '', reasonSkipped: false });
    await saveScoringResult('ok', { relevance: 0.8, reason: '', reasonSkipped: false });

    await drive(pipeline.enqueueOrphanedReasons());

    // The 0.35 row is stranded below the reason threshold: finalized with no note, never queued.
    expect((await rows()).s1).toMatchObject({ status: 'complete', reason: '', relevance: 0.35 });
    expect((await rows()).ok.status).toBe('reason_pending');
    // Only the 0.8 row is queued for a reason.
    const queued = (await batches()).flatMap((b) => b.candidateIds);
    expect(queued).toEqual(['ok']);
  });

  it('enqueueOrphanedReasons is ungated by the dispatch floor', async () => {
    gateway({}, { pendingPolls: 99 });
    await seedArticles(['o0']);
    await saveScoringResult('o0', { relevance: 0.8, reason: '', reasonSkipped: false });

    await drive(pipeline.enqueueOrphanedReasons());

    const bs = await batches();
    expect(bs).toHaveLength(1);
    expect(bs[0].reasonsOnly).toBe(true);
  });
});

describe('cold-start predicate (P7d isFeedCold)', () => {
  const scoreDonor = async (id = 'donor') => {
    await seedArticles([id]);
    await saveScoringResult(id, { relevance: 0.8, reason: '', reasonSkipped: false });
  };

  it('reports cold while no scored donor exists in the 48h window', async () => {
    expect(await pipeline.isFeedCold()).toBe(true);
  });

  it('reports warm as soon as a scored donor exists', async () => {
    await scoreDonor();
    expect(await pipeline.isFeedCold()).toBe(false);
  });

  it('caches the warm verdict per process and re-reads only after _resetForTests', async () => {
    // Warm: a donor exists → false, and the verdict is cached permanently.
    await scoreDonor();
    expect(await pipeline.isFeedCold()).toBe(false);

    // Donors vanish, but the cached warm verdict survives (warm is permanent per
    // process) — no re-query flips it back to cold.
    await deleteSuggestionByServerId('donor');
    expect(await getScoredDonorRows(0)).toEqual([]);
    expect(await pipeline.isFeedCold()).toBe(false);

    // _resetForTests clears the module cache → the next read reflects the DB.
    pipeline._resetForTests();
    expect(await pipeline.isFeedCold()).toBe(true);
  });

  it('fails WARM on a donor read error (never triggers the cold knobs off a failed read)', async () => {
    const spy = jest.spyOn(articleService, 'getScoredDonorRows').mockRejectedValueOnce(new Error('db read failed'));
    try {
      expect(await pipeline.isFeedCold()).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'db read failed' }),
      expect.objectContaining({ tags: expect.objectContaining({ step: 'is-feed-cold' }) }),
    );
  });
});

// The P7d "Knob 1" cold-start partial (dispatch a >=10-row partial only on a
// cold feed) is gone: MIN_DISPATCH is 5, so every chunk that knob would have
// caught now dispatches on the fast path regardless of feed warmth. These tests
// pin the replacement invariant — warmth no longer affects dispatch at all.
describe('dispatch floor is warmth-independent (replaces P7d Knob 1)', () => {
  it('dispatches a >= MIN_DISPATCH batch on a COLD feed with no staleness escape', async () => {
    gateway({}, { pendingPolls: 99 });
    expect(await pipeline.isFeedCold()).toBe(true); // cold: no scored donors
    await seedArticles(ids(MIN_DISPATCH));

    await drive(pipeline.enqueueCandidates(ids(MIN_DISPATCH)));

    expect((await batches())[0].candidateIds).toHaveLength(MIN_DISPATCH);
  });

  it('dispatches the SAME batch on a WARM feed — warmth is no longer consulted', async () => {
    gateway({}, { pendingPolls: 99 });
    await seedArticles(['donor']);
    await saveScoringResult('donor', { relevance: 0.8, reason: '', reasonSkipped: false });
    expect(await pipeline.isFeedCold()).toBe(false); // warm
    await seedArticles(ids(MIN_DISPATCH));

    await drive(pipeline.enqueueCandidates(ids(MIN_DISPATCH)));

    expect((await batches())[0].candidateIds).toHaveLength(MIN_DISPATCH);
  });

  it('defers below the floor on a cold feed too (fresh oldest, no escape)', async () => {
    expect(await pipeline.isFeedCold()).toBe(true);
    await seedArticles(ids(MIN_DISPATCH - 1));

    await drive(pipeline.enqueueCandidates(ids(MIN_DISPATCH - 1)));

    expect(await currentRun()).toBeNull();
    expect(gatewayCalls('job')).toHaveLength(0);
  });
});

describe('cold-start poll latency (P7d Knob 2)', () => {
  // Stale oldest → the single-id partial dispatches via the staleness escape, giving us one
  // waiting-relevance batch to poll.
  async function oneWaitingBatch() {
    gateway({}, { pendingPolls: 99 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    expect((await batches())[0].phase).toBe('waiting-relevance');
  }

  // MIN_POLL_AGE_MS is now 0 for every feed — the old 15s settling delay put a
  // hard floor under the first scored paint even when the job was already done,
  // and the gateway rate limiter (not this gate) is what stops us hammering. So
  // the cold/warm split these tests pinned no longer exists; both poll at once.
  it('polls a freshly-submitted batch immediately on a COLD feed (no settling delay)', async () => {
    const polls = watchResultsPolls();
    await oneWaitingBatch();

    await tick();

    expect(polls).toHaveLength(1);
  });

  it('polls a freshly-submitted batch immediately on a WARM feed too', async () => {
    const polls = watchResultsPolls();
    await oneWaitingBatch();
    await seedArticles(['donor']);
    await saveScoringResult('donor', { relevance: 0.8, reason: '', reasonSkipped: false });

    await tick();

    expect(polls).toHaveLength(1);
  });

  it('honours PER_BATCH_POLL_SPACING_MS between two polls of the SAME batch', async () => {
    const polls = watchResultsPolls();
    await oneWaitingBatch();

    // Step past the gateway slot the SUBMIT just consumed, so this first poll
    // is gated only by the per-batch spacing we're actually testing.
    await tick();
    expect(polls).toHaveLength(1);

    // Immediately again — inside the spacing window, so skipped.
    await drive(pipeline.pollTick('foreground'));
    expect(polls).toHaveLength(1);

    // Past the window (and past the limiter's own interval) — polled again.
    later(10_000);
    await drive(pipeline.pollTick('foreground'));
    expect(polls).toHaveLength(2);
  });
});

describe('stale pending', () => {
  it('requeues a waiting batch whose job has been pending past BATCH_STALE_MS', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    // The staleness clock starts at this process's first check.
    await tick();

    // Advance beyond BATCH_STALE_MS (15 min) so the pending job is stale.
    later(16 * 60_000);
    await tick();

    const b = (await batches())[0];
    // attempt 1 (< MAX) → requeued to queued then re-drained → back in flight
    expect(['queued', 'submitting-relevance', 'waiting-relevance']).toContain(b.phase);
    expect(b.attempt).toBe(1);
  });
});

describe('throwing /results fetch (catch-path staleness)', () => {
  // A THROWING /results fetch (5xx / network) — previously left the batch in waiting-* untouched
  // forever; the catch path now applies BATCH_STALE_MS.
  const fiveHundred = () => server.use(http.get('*/v1/inference/jobs/:id/results', () => new HttpResponse('boom', { status: 500 })));

  it('requeues/fails a waiting batch past BATCH_STALE_MS when the fetch throws', async () => {
    gateway();
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    fiveHundred();
    // The staleness clock starts at this process's first check.
    await tick();
    expect((await batches())[0]).toMatchObject({ phase: 'waiting-relevance', attempt: 0 });

    // Advance beyond BATCH_STALE_MS (15 min) so the waiting batch is over-age.
    later(16 * 60_000);
    await tick();

    const b = (await batches())[0];
    // attempt 1 (< MAX) → requeued to queued then re-drained → back in flight
    expect(['queued', 'submitting-relevance', 'waiting-relevance']).toContain(b.phase);
    expect(b.attempt).toBe(1);
  });

  it('leaves a waiting batch younger than BATCH_STALE_MS untouched when the fetch throws', async () => {
    gateway();
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    fiveHundred();

    // Past MIN_POLL_AGE so pollTick actually polls, but well under BATCH_STALE_MS — the throw is
    // logged and the batch is left alone.
    later(30_000);
    await drive(pipeline.pollTick('foreground'));

    const b = (await batches())[0];
    expect(b.phase).toBe('waiting-relevance');
    expect(b.attempt).toBe(0);
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ step: 'fetch' }) }),
    );
  });
});

describe('abortRun', () => {
  // Both runs end without a gateway call, so the post-finalize kick (which would re-enqueue the
  // still-unscored rows as a new run) is held off by on-device mode.
  it('force-fails non-terminal batches, finalizes + clears the run, and stamps markProcessingRunFinished', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(2 * MAX_BATCH_ARTICLES));
    await tickUntil(async () => (await waitingCount()) >= 2); // non-terminal batches in flight
    expect(await currentRun()).not.toBeNull();
    expect(useForYouStore.getState().lastProcessingRunFinishedAt).toBeNull();
    holdKick();

    await pipeline.abortRun('cache-clear');

    // run force-failed → finalized → cleared
    expect(await currentRun()).toBeNull();
    expect(useForYouStore.getState().lastProcessingRunFinishedAt).not.toBeNull();
    // the abort wrote no scores
    expect(Object.values(await rows()).every((r) => r.status === 'unscored')).toBe(true);
  });

  it('still stamps markProcessingRunFinished when no run exists', async () => {
    expect(await currentRun()).toBeNull();

    await pipeline.abortRun('cache-clear');

    expect(await currentRun()).toBeNull();
    expect(useForYouStore.getState().lastProcessingRunFinishedAt).not.toBeNull();
  });
});

describe('recover', () => {
  it('returns idle when there is no run', async () => {
    expect(await drive(pipeline.recover())).toBe('idle');
  });

  it('reverts stuck submitters and resumes a live run', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    // The process died mid-submit: the batch is left in submitting-relevance with no job.
    await patchBatch(0, (b) => {
      b.phase = 'submitting-relevance';
      b.submittedAt = Date.now() - 120_000; // > SUBMIT_STUCK_MS old
      b.requestId = undefined;
    });
    pipeline._resetForTests(); // a new process: no in-memory state survives
    later();

    const result = await drive(pipeline.recover());

    expect(result).toBe('running');
    // reverted then re-drained → back in flight (or at least not stuck-submitting)
    const b = (await batches())[0];
    expect(b.attempt).toBeGreaterThanOrEqual(1);
    expect(b.phase).not.toBe('submitting-relevance');
  });

  it('abandons a run idle for longer than RUN_ABANDON_MS and finalizes', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    later(25 * 3600_000); // nothing moved for over 24h (RUN_ABANDON_MS)
    holdKick(); // abandoned rows stay unscored; the kick would re-enqueue them

    const result = await drive(pipeline.recover());

    expect(result).toBe('idle');
    expect(await currentRun()).toBeNull(); // finalized + cleared
  });

  it('keeps a run that STARTED over 24h ago but submitted recently (measured from last activity)', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    // An older run with recent activity (an OS task kept submitting to it overnight): isolation
    // patch, the clock alone cannot age `startedAt` without ageing the submit too.
    await patchRun((run) => {
      run.startedAt = Date.now() - 25 * 3600_000;
    });

    const result = await drive(pipeline.recover());

    expect(result).toBe('running');
    expect(await currentRun()).not.toBeNull();
  });
});

describe('handlePush', () => {
  /** Two batches (5 + 10 ids), both submitted and both still pending on the gateway. */
  async function twoWaitingBatches() {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(5 + 10));
    await tickUntil(async () => (await waitingCount()) === 2);
    return batches();
  }

  it('checks only the batch matching the requestId', async () => {
    const [, target] = await twoWaitingBatches();
    const polls = watchResultsPolls();

    await drive(pipeline.handlePush(target.requestId, 'foreground'));

    expect(polls).toEqual([target.requestId]);
  });

  it('falls back to a full pollTick when the requestId is unknown', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(MIN_DISPATCH));
    const target = (await batches())[0];
    const polls = watchResultsPolls();
    later();

    await drive(pipeline.handlePush('nonexistent-req', 'foreground'));

    // The unknown id can't target a batch, so it degrades to a full pollTick —
    // which now polls the waiting batch straight away (MIN_POLL_AGE_MS is 0).
    expect(polls).toEqual([target.requestId]);
  });
});

describe('background auth (per-batch capability token)', () => {
  it('background handlePush chains the reasons submit with the batch capability token', async () => {
    gateway();
    await warmAttestation();
    // Set up (foreground) a single waiting-relevance batch with a stored token.
    await seedAndEnqueue(['a0'], { flush: true });
    const batch = (await batches())[0];
    expect(batch.capabilityToken).toBeTruthy();

    setAppState('background');
    later();
    await drive(pipeline.handlePush(batch.requestId, 'background'));

    // The results GET authenticated with the capability token alone (the mock refuses a token bound
    // to another job), and the chained reasons submit carried the completed relevance job's
    // capability token (jobs:submit-followup scope).
    const submits = jobSubmits();
    expect(submits).toHaveLength(2);
    expect(submits[1].auth).toBe(`Bearer ${batch.capabilityToken}`);
    expect((await batches())[0].phase).toBe('waiting-reasons');
  });

  it('background drain does not admit queued batches (deferred to foreground)', async () => {
    // Every score is sub-threshold (a job's answer is fixed when it is submitted).
    gateway({ defaultScore: 0.1 }, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(5 + 10 + 25 + 50)); // 4 batches: 3 waiting-relevance, 1 queued
    await tickUntil(async () => (await waitingCount()) === 3);
    const b0 = (await batches())[0];
    expect((await batches())[3].phase).toBe('queued');
    const submitted = jobSubmits().length;

    // Complete batch 0 from a background wake (all sub-threshold → done, no reasons job) —
    // afterTerminal drains with background context. Release the gateway, but hold every other job.
    gateway({ defaultScore: 0.1 });
    holdJobs((id) => id !== b0.requestId);
    later();
    await drive(pipeline.handlePush(b0.requestId, 'background'));

    const bs = await batches();
    expect(bs[0].phase).toBe('done');
    // The queued batch was NOT admitted — fresh submits have no capability
    // token in background; it waits for the next foreground tick.
    expect(bs[3].phase).toBe('queued');
    expect(jobSubmits()).toHaveLength(submitted);

    // Foreground tick picks it up.
    await tickUntil(async () => (await phases())[3] === 'waiting-relevance');
  });
});

describe('getPipelineStatus', () => {
  it('is idle with no run and running with a live batch', async () => {
    gateway({}, { pendingPolls: 999 });
    expect(await pipeline.getPipelineStatus()).toBe('idle');
    await seedAndEnqueue(['a0'], { flush: true });
    expect(await pipeline.getPipelineStatus()).toBe('running');
  });
});

describe('getPipelineUiState', () => {
  it('returns idle when there is no run', async () => {
    expect(await pipeline.getPipelineUiState()).toEqual({
      phase: 'idle',
      processedCount: 0,
      totalCount: 0,
    });
  });

  it('projects the persisted run', async () => {
    gateway({}, { pendingPolls: 999 });
    await seedAndEnqueue(ids(2 * MAX_BATCH_ARTICLES)); // 5 ramped batches, none past relevance
    const ui = await pipeline.getPipelineUiState();
    expect(ui.phase).toBe('relevance');
    expect(ui.processedCount).toBe(0);
    expect(ui.totalCount).toBe(2 * MAX_BATCH_ARTICLES);
  });
});

describe('live header progress push', () => {
  it('pushes relevance phase + totals into the store on enqueue', async () => {
    gateway({}, { pendingPolls: 999 });
    await seedAndEnqueue(ids(2 * MAX_BATCH_ARTICLES));
    const s = useForYouStore.getState();
    expect(s.asyncJobPhase).toBe('relevance');
    expect(s.asyncJobProcessedCount).toBe(0);
    expect(s.asyncJobTotalCount).toBe(2 * MAX_BATCH_ARTICLES);
  });

  it('resets the header to idle once the run finalizes', async () => {
    gateway({ defaultScore: 0.1 }); // sub-threshold → no reasons, finalize
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    expect(useForYouStore.getState().asyncJobPhase).toBe('relevance');
    const batch = (await batches())[0];

    await drive(pipeline.handlePush(batch.requestId, 'foreground'));

    expect(await currentRun()).toBeNull(); // finalized + cleared
    expect(useForYouStore.getState().asyncJobPhase).toBe('idle');
    expect(useForYouStore.getState().batchProgress).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Finalize side-effects (Round-4 B): stamp markProcessingRunFinished + the
// post-finalize kick that starts the next run when a full quantum still waits.
// ---------------------------------------------------------------------------

describe('finalize side-effects', () => {
  /** Finalizes the one-batch run; returns its run id. The kick fires on the next timer turn. */
  async function finalizeSingleBatchRun() {
    gateway({ defaultScore: 0.1 }); // sub-threshold → no reasons → finalize
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    const batch = (await batches())[0];
    const { runId } = (await currentRun())!;
    await drive(pipeline.handlePush(batch.requestId, 'foreground'));
    return runId;
  }

  it('stamps markProcessingRunFinished when a cloud run finalizes', async () => {
    await finalizeSingleBatchRun();
    expect(await currentRun()).toBeNull();
    expect(useForYouStore.getState().lastProcessingRunFinishedAt).not.toBeNull();
  });

  it('post-finalize kick starts the next run when ≥25 unscored still remain', async () => {
    // A full quantum of unscored rows is waiting behind the run.
    await seedArticles(ids(25, 'kick'));
    const finished = await finalizeSingleBatchRun();

    // The scheduled setTimeout(0) kick fires and its async body runs.
    await passTime(2_000);

    // A fresh run, so the ramp starts over: 5, 10, then the remaining 10.
    const run = await currentRun();
    expect(run).not.toBeNull();
    expect(run!.runId).not.toBe(finished);
    expect(run!.batches.map((b) => b.candidateIds.length)).toEqual([5, 10, 10]);
  });

  it('post-finalize kick does nothing when no unscored rows remain', async () => {
    await finalizeSingleBatchRun();
    expect(await currentRun()).toBeNull();
    await passTime(2_000);
    expect(await currentRun()).toBeNull();
  });
});

// A throw in the apply step (decode/save racing a row deleted underneath the batch) used to leave
// the batch in waiting-* with no attempt++ and no terminal transition, so the 7s poller re-fetched
// the SAME server-cached results and re-threw on every tick for up to RUN_ABANDON_MS (24h) — one
// production device looping. The apply catch now routes through requeueWaitingOrFail so the batch
// terminates after MAX_BATCH_ATTEMPTS.
describe('apply-step throw → attempt cap (MERA-APP-53/55)', () => {
  let decode: jest.SpyInstance;
  beforeEach(() => {
    // The decoder throws on both applies (attempt 1 and attempt 2): the exact loop the fix bounds.
    // Two one-call injections, not a standing mock (R23).
    const boom = () => {
      throw new Error('Record article_suggestions#a0 not found');
    };
    decode = jest.spyOn(scoringService, 'decodeResults').mockImplementationOnce(boom).mockImplementationOnce(boom);
  });
  afterEach(() => decode.mockRestore());

  async function poisonedBatch() {
    gateway();
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    return (await batches())[0];
  }

  it('terminates a poisoned waiting-relevance batch after MAX_BATCH_ATTEMPTS instead of re-throwing forever', async () => {
    const batch = await poisonedBatch();

    // Poll 1: apply throws → attempt 1 (< MAX=2) → requeued to queued, re-drained.
    await drive(pipeline.handlePush(batch.requestId, 'foreground'));
    const afterFirst = (await batches())[0];
    expect(afterFirst.attempt).toBe(1);
    expect(['queued', 'submitting-relevance', 'waiting-relevance']).toContain(afterFirst.phase);

    // Back in flight, then poll 2: apply throws again → attempt 2 (== MAX) → failed → single
    // batch → run finalized + cleared, so the poller stops re-driving it.
    await tickUntil(async () => (await phases())[0] === 'waiting-relevance');
    const b1 = (await batches())[0];
    holdKick(); // the failed row is still unscored; no gateway call follows
    await drive(pipeline.handlePush(b1.requestId, 'foreground'));

    expect(await currentRun()).toBeNull();
    // Nothing was persisted for the poisoned row.
    expect((await rows()).a0.status).toBe('unscored');
  });

  it('bounds the apply captureException to at most MAX_BATCH_ATTEMPTS per batch', async () => {
    const batch = await poisonedBatch();

    (logger.captureException as jest.Mock).mockClear();
    await drive(pipeline.handlePush(batch.requestId, 'foreground')); // attempt 1
    await tickUntil(async () => (await phases())[0] === 'waiting-relevance');
    const b1 = (await batches())[0];
    holdKick();
    await drive(pipeline.handlePush(b1.requestId, 'foreground')); // attempt 2 → failed

    const applyCaptures = (logger.captureException as jest.Mock).mock.calls.filter(
      (c: unknown[]) => (c[1] as { tags?: { step?: string } })?.tags?.step === 'apply',
    );
    // Fired for the poisoned applies but bounded (≤ MAX_BATCH_ATTEMPTS), not forever.
    expect(applyCaptures.length).toBeGreaterThanOrEqual(1);
    expect(applyCaptures.length).toBeLessThanOrEqual(2);
    // The run is terminal now → no further polling of this batch.
    expect(await currentRun()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Headlines share the ordinary queue + the persisted chunk size.
//
// A batch becomes ONE inference request whose `score:N` calls the decoder
// rebuilds by re-chunking `candidateIds` with the batch's persisted size. Every
// call is now 5 articles, headlines included (the PROMPT is still picked per
// call in buildRelevanceCalls), so headlines queue like any topic's articles.
// Batches persisted by an older build at the headline size of 3 must still
// decode with 3.
// ---------------------------------------------------------------------------

describe('headlines in the ordinary queue + chunk-size round trip', () => {
  it('queues headlines with topic articles, in delivery order', async () => {
    gateway({}, { pendingPolls: 999 });
    const arrival = ['s0', 'h0', 's1', 'h1', 's2', 'h2', 's3', 'h3', 's4', 's5', 'h4', 'h5', 'h6', 'h7', 'h8'];
    await seedArticles(arrival.filter((id) => id.startsWith('s')));
    await seedArticles(arrival.filter((id) => id.startsWith('h')), { headline: 'GLOBAL' });

    await drive(pipeline.enqueueCandidates(arrival));

    expect((await batches()).map((b) => b.candidateIds)).toEqual([arrival.slice(0, 5), arrival.slice(5, 15)]);
  });

  it('holds a few headlines back at the ordinary floor, like any articles', async () => {
    await seedArticles(['h0', 'h1', 'h2'], { headline: 'GLOBAL' });

    const res = await drive(pipeline.enqueueCandidates(['h0', 'h1', 'h2']));

    expect(res.deferred).toEqual(['h0', 'h1', 'h2']);
    expect(await currentRun()).toBeNull();
  });

  // Batch 1 holds 10 ids. Each id gets its own band, so a wrongly re-chunked decode attributes a
  // score to the NEIGHBOURING article and the row assertion below fails.
  const bands = [0.9, 0.7, 0.5]; // → 0.8 / 0.6 / 0.4 after bucketing
  const scoreOf = (i: number) => bands[i % bands.length];
  const expectedBand = (i: number) => ({ 0.9: 0.8, 0.7: 0.6, 0.5: 0.4 })[scoreOf(i) as 0.9 | 0.7 | 0.5];

  async function decodeSecondBatch(afterSubmit?: () => Promise<void>) {
    const batchIds = ids(15, 'h');
    gateway({ scores: Object.fromEntries(batchIds.map((id, i) => [id, scoreOf(i)])) });
    await warmAttestation();
    await seedArticles(batchIds);
    await drive(pipeline.enqueueCandidates(batchIds));
    const b0 = (await batches())[0];
    holdJobs((id) => id === b0.requestId); // only batch 1's job is collected
    await tickUntil(async () => (await phases())[1] === 'waiting-relevance');
    await afterSubmit?.();
    const b1 = (await batches())[1];
    later();
    await drive(pipeline.handlePush(b1.requestId, 'foreground'));
    return batchIds.slice(5);
  }

  it('decodes a batch persisted at the old headline size (3) with that size', async () => {
    // Pretend an older build submitted it at 3 per call: the calls ARE built at 3 and the size is
    // persisted on the batch; decode must re-chunk with it.
    const cfg = DEFAULT_HARNESS_CONFIG.articlePipeline;
    const saved = cfg.articlesPerScorePrompt;
    cfg.articlesPerScorePrompt = 3;
    try {
      const batchIds = await decodeSecondBatch(async () => {
        expect((await batches())[1].scoreChunkSize).toBe(3);
      });
      const r = await rows();
      batchIds.forEach((id, i) => expect(r[id].relevance).toBe(expectedBand(i + 5)));
      expect(gatewayCalls('job').filter((c) => c.callId?.startsWith('score:')).length).toBeGreaterThan(5);
    } finally {
      cfg.articlesPerScorePrompt = saved;
    }
  });

  it('decodes a pre-P4b batch (no persisted size) with the standard size', async () => {
    // Strip the field from the persisted record — exactly the shape a batch submitted by a
    // PRE-P4b build rehydrates with while still in flight.
    const batchIds = await decodeSecondBatch(async () => {
      expect((await batches())[1].scoreChunkSize).toBe(MIN_DISPATCH);
      await patchBatch(1, (b) => {
        delete b.scoreChunkSize;
      });
      expect((await batches())[1].scoreChunkSize).toBeUndefined();
    });
    const r = await rows();
    batchIds.forEach((id, i) => expect(r[id].relevance).toBe(expectedBand(i + 5)));
  });
});

// ---------------------------------------------------------------------------
// Gate-bypass fix — enqueueUnscoredEligible now routes through the SAME
// story-grouping gate feed-sync and the background scoring pass use.
// ---------------------------------------------------------------------------

describe('enqueueUnscoredEligible — story-grouping gate routing', () => {
  const sameStory = () => 'Dam breach floods the valley towns overnight';

  it('enqueues only the elected representatives, not every eligible row', async () => {
    gateway({}, { pendingPolls: 999 });
    await seedArticles(['rep', 'dup'], { title: sameStory, clusterId: 'c1' });
    ageRows();

    const res = await drive(pipeline.enqueueUnscoredEligible());

    expect(res.enqueued).toBe(1);
    const batch = (await batches())[0];
    expect(batch.candidateIds).toHaveLength(1);
    expect(['rep', 'dup']).toContain(batch.candidateIds[0]);
    // The held-back sibling is still COUNTED (the "Analysing X of Y" header).
    expect([...(batch.coveredIds ?? [])].sort()).toEqual(['dup', 'rep']);
  });

  it('drops gate ids that are not scorable here (headline-vs-fact predicate still applies)', async () => {
    gateway({}, { pendingPolls: 999 });
    await seedArticles(['ok']);
    await seedArticles(['factless'], { factless: true });
    ageRows();

    const res = await drive(pipeline.enqueueUnscoredEligible());

    expect(res.enqueued).toBe(1);
    expect((await batches())[0].candidateIds).toEqual(['ok']);
  });

  /** A scored donor and an unscored sibling of the same story. */
  async function donorAndSibling(siblingTitle: string) {
    await seedArticles(['donor'], { title: sameStory, clusterId: 'c1' });
    await saveScoringResult('donor', {
      relevance: 0.8,
      reason: 'The valley dam breach matters to you.',
      reasonSkipped: false,
    });
    await seedArticles(['sib'], { title: () => siblingTitle, clusterId: 'c1' });
  }

  it('reconciles hard filters + refreshes when the gate propagated scores', async () => {
    await donorAndSibling(`${sameStory()} quokka`);
    await addSuppression({ pattern: 'quokka', keywords: ['quokka'], strength: 1, source: 'chat' });

    await drive(pipeline.enqueueUnscoredEligible());

    // The sibling inherited the donor's score, and the propagated row — which never meets the
    // scoring stage's hard screen — was then purged by the reconcile.
    expect((await rows()).sib.status).toBe('excluded');
    // …and the store was refreshed to show it.
    expect(useForYouStore.getState().suggestions.find((s) => s._id === 'sib')?.status).toBe('excluded');
  });

  it('enqueues nothing when the gate elects nothing (everything propagated)', async () => {
    await donorAndSibling(sameStory());

    const res = await drive(pipeline.enqueueUnscoredEligible());

    expect(res.enqueued).toBe(0);
    expect(await currentRun()).toBeNull();
    expect((await rows()).sib).toMatchObject({ status: 'complete', relevance: 0.8 });
  });

  it('still honours the MIN_DISPATCH floor unless flushRemainder is set', async () => {
    gateway({}, { pendingPolls: 999 });
    // One row, fresh (no staleness escape) → deferred without a flush…
    await seedArticles(['a0']);

    await drive(pipeline.enqueueUnscoredEligible());
    expect(await currentRun()).toBeNull();

    // …and dispatched with one.
    await drive(pipeline.enqueueUnscoredEligible({ flushRemainder: true }));
    expect((await batches())[0].candidateIds).toEqual(['a0']);
  });
});

// ---------------------------------------------------------------------------
// bgsubmit: idempotency keys and staleness
// ---------------------------------------------------------------------------

describe('idempotency key', () => {
  it('sends a key minted at submit: runId, batchId, phase, generation 0', async () => {
    gateway({}, { pendingPolls: 999 });
    const submits = captureSubmits();
    await warmAttestation();

    await seedAndEnqueue(['a0'], { flush: true });
    await passTime(100);

    const run = (await currentRun())!;
    expect(submits[0].key).toBe(`${run.runId}:0:rel:0`);
    expect(run.batches[0].idemKey).toBe(`${run.runId}:0:rel:0`);
    expect(run.batches[0].sentIds).toEqual(['a0']);
  });

  it('resends the SAME key after a failed POST for the same ids', async () => {
    gateway({}, { pendingPolls: 999 });
    const submits = captureSubmits();
    server.use(http.post(JOBS, () => new HttpResponse('bad', { status: 400 }), { once: true }));
    await warmAttestation();

    await seedAndEnqueue(['a0'], { flush: true });
    await tickUntil(async () => (await batches())[0].phase === 'waiting-relevance');
    await passTime(100);

    expect(submits).toHaveLength(2);
    expect(submits[1].key).toBe(submits[0].key);
    expect((await batches())[0].attempt).toBe(1);
  });

  it('mints a new generation when the ids to send changed', async () => {
    gateway({}, { pendingPolls: 999 });
    const submits = captureSubmits();
    server.use(http.post(JOBS, () => new HttpResponse('bad', { status: 400 }), { once: true }));
    await warmAttestation();
    await seedAndEnqueue(['a0', 'a1'], { flush: true });
    // a1 got scored elsewhere after the first attempt: the rebuilt bundle for the retry carries
    // only a0.
    await saveScoringResult('a1', { relevance: 0.8, reason: '', reasonSkipped: false });

    await tickUntil(async () => (await batches())[0].phase === 'waiting-relevance');
    await passTime(100);

    expect(submits).toHaveLength(2);
    expect(submits[1].key).not.toBe(submits[0].key);
    expect(submits[1].key.endsWith(':rel:1')).toBe(true);
    expect((await batches())[0].sentIds).toEqual(['a0']);
  });

  it('forgets the key when a waiting batch is requeued off a 404', async () => {
    gateway({}, { pendingPolls: 999 });
    const submits = captureSubmits();
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    server.use(
      http.get('*/v1/inference/jobs/:id/results', () => new HttpResponse('Unknown requestId', { status: 404 }), {
        once: true,
      }),
    );

    await tickUntil(async () => submits.length === 2);

    expect(submits[1].key).not.toBe(submits[0].key);
    expect(submits[1].key.endsWith(':rel:1')).toBe(true);
  });

  it('treats 409 as in progress: requeued with attempt and key unchanged', async () => {
    gateway({}, { pendingPolls: 999 });
    const submits = captureSubmits();
    server.use(http.post(JOBS, () => new HttpResponse(null, { status: 409 }), { once: true }));
    await warmAttestation();

    await seedAndEnqueue(['a0'], { flush: true });
    expect((await batches())[0]).toMatchObject({ phase: 'queued', attempt: 0 });

    // The device backs off for IN_PROGRESS_PAUSE_MS; after it the same key is replayed.
    later(11_000);
    await drive(pipeline.recover());
    await passTime(100);

    expect(submits).toHaveLength(2);
    expect(submits[1].key).toBe(submits[0].key);
    const b = (await batches())[0];
    expect(b.attempt).toBe(0);
    expect(b.idemKey).toBe(submits[0].key);
  });
});

describe('staleness counts from the first check, not the submit', () => {
  it('a batch submitted 6h ago is not requeued on its first slow poll after open', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    later(6 * 3600_000); // the app is opened six hours after the submit
    const submitted = jobSubmits().length;

    await tick();

    const b = (await batches())[0];
    expect(b.phase).toBe('waiting-relevance');
    expect(b.attempt).toBe(0);
    expect(jobSubmits()).toHaveLength(submitted);
  });

  it('passes submittedAt so an expired capability token is not offered', async () => {
    // No JWT, so /results can only authenticate with the batch's capability token (2h TTL).
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    server.use(http.get('*/api/auth/token', () => new HttpResponse('nope', { status: 401 })));
    invalidateJwtCache();
    const polls = watchResultsPolls();

    // Fresh job: the token is offered and the GET goes out.
    await tick();
    expect(polls).toHaveLength(1);

    // Submitted 3h ago: the token is past its TTL, so no GET is sent at all (it would only 401).
    later(3 * 3600_000);
    await tick();
    expect(polls).toHaveLength(1);
    // (the check threw "no auth available" and, three hours on, the batch is stale: requeued)
    expect(logger.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ step: 'fetch' }) }),
    );
  });
});

describe('notes do not hold a relevance slot (end to end)', () => {
  it('a fourth relevance batch submits while batch 0 is writing its notes', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(5 + 10 + 25 + 50)); // 4 ramped batches
    await tickUntil(async () => (await waitingCount()) === 3);
    expect(await phases()).toEqual(['waiting-relevance', 'waiting-relevance', 'waiting-relevance', 'queued']);

    // Batch 0's relevance lands (every candidate impactful); every other job, including the notes
    // job it submits next, stays pending.
    const batch0 = (await batches())[0];
    gateway();
    holdJobs((id) => id !== batch0.requestId);

    await burstUntil(async () => {
      const p = await phases();
      return p[0] === 'waiting-reasons' && p[3] === 'waiting-relevance';
    });

    const p = await phases();
    expect(p[0]).toBe('waiting-reasons');
    expect(p[3]).toBe('waiting-relevance');
  });
});

describe('the drain yields to an earlier batch (measured regression)', () => {
  // Hydration enqueues every few hundred ms and each enqueue drains. A drain
  // that only looked at fresh submits spent every slot on batches 1-3 while
  // batch 0's finished one-call job went unpolled for 11s.
  it('an enqueue still submits the next batch right after batch 0 (a 0s-old job is not worth a poll)', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(5)); // batch 0
    expect(await phases()).toEqual(['waiting-relevance']);
    // A limiter slot free the instant after batch 0's submit: its job is 0s old.
    resetLimiter();
    await seedArticles(ids(10, 'b'));

    await drive(pipeline.enqueueCandidates(ids(10, 'b'))); // batch 1

    expect(await phases()).toEqual(['waiting-relevance', 'waiting-relevance']);
  });

  it('an enqueue does not submit a later batch while batch 0 is due a poll', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(5, 'a')); // batch 0
    const batch0 = (await batches())[0];
    expect(batch0.phase).toBe('waiting-relevance');
    const traffic = watchTraffic();

    later(3_000);
    await seedArticles(ids(10, 'b'));
    await drive(pipeline.enqueueCandidates(ids(10, 'b'))); // batch 1, enqueued once batch 0 is pollable

    expect((await batches())[1].phase).toBe('queued');
    expect(traffic).toEqual([]);

    // The next ticks hand the slot to batch 0's poll FIRST, then batch 1 goes.
    await tickUntil(async () => (await phases())[1] === 'waiting-relevance');
    expect(traffic[0]).toBe('poll');
    expect(traffic.indexOf('submit')).toBeGreaterThan(traffic.indexOf('poll'));
  });
});

// The foreground poller is the real driver of a run: every other test in this file turns it off
// (AppState inactive) and ticks by hand. These run with the app active, so the interval timer,
// `runPollerTick` and the drain's kick are the thing under test. Fake time is paid in wall time, so
// each one passes only a few seconds.
describe('foreground poller', () => {
  it('drives a run from queued to done on its own', async () => {
    setAppState('active');
    gateway({ scores: { a0: 0.9, a1: 0.2 } });
    await warmAttestation();

    await seedAndEnqueue(['a0', 'a1'], { flush: true });
    expect((await phases())[0]).toBe('waiting-relevance');
    await passTime(8_000);

    // relevance → reasons → done, with nobody calling pollTick: the interval did it all
    expect(await currentRun()).toBeNull();
    const r = await rows();
    expect(r.a0).toMatchObject({ relevance: 0.8, reason: 'Why story a0 matters here.', status: 'complete' });
    expect(r.a1).toMatchObject({ relevance: 0.2, status: 'complete' });
    expect(useForYouStore.getState().asyncJobPhase).toBe('idle');
  });

  it('stops ticking when the app leaves the foreground and resumes when it returns', async () => {
    setAppState('active');
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    const polls = watchResultsPolls();

    setAppState('inactive');
    await passTime(3_000);
    expect(polls).toHaveLength(0);

    setAppState('active');
    setAppState('active'); // a second change event finds the timer already running
    await passTime(3_000);
    expect(polls.length).toBeGreaterThan(0);
  });

  it('_resetForTests stops a poller whose first tick is still pending', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    const polls = watchResultsPolls();

    setAppState('active'); // arms the first tick
    pipeline._resetForTests();
    await passTime(2_000);

    expect(polls).toHaveLength(0);
  });

  // Hydration enqueues every few hundred ms and each enqueue drains. A drain that only looked at
  // fresh submits spent every slot on batches 1-3 while batch 0's finished one-call job went
  // unpolled for 11s. When the top-ranked action is a poll the drain cannot take, it kicks a poll
  // tick on the next turn instead of leaving the slot for the interval timer.
  it('a drain that yields to a due poll kicks a poll tick right away instead of waiting for the interval', async () => {
    const script: Script = { defaultScore: 0.1 };
    gateway(script, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(5 + 10));
    await tickUntil(async () => (await waitingCount()) === 2);
    const [b0, b1] = await batches();
    // Batch 0 finishes (collected by hand, the way a silent push would). The app counts as
    // foreground, set without the change event so NO interval timer exists: whatever polls batch 1
    // next was started by the drain's kick.
    gateway(script);
    holdJobs((id) => id !== b0.requestId);
    appStateModule.currentState = 'active';
    later();
    const polls = watchResultsPolls();

    await drive(pipeline.handlePush(b0.requestId, 'foreground')); // → done → afterTerminal → drain

    expect((await phases())[0]).toBe('done');
    expect(polls).toEqual([b0.requestId, b1.requestId]);
  });

  // The run can end between a drain's kick and the kicked tick: finalize stops the poller (and drops
  // its AppState subscription), then the kicked tick finds no run and stops a poller that is already
  // stopped. It must stay stopped: a later foreground return polls nothing.
  it('a poll tick kicked before the run ended finds it idle and leaves the poller stopped', async () => {
    const script: Script = { defaultScore: 0.1 };
    gateway(script, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(5 + 10));
    await tickUntil(async () => (await waitingCount()) === 2);
    const [b0] = await batches();
    gateway(script);
    holdJobs((id) => id !== b0.requestId);
    appStateModule.currentState = 'active';
    later(3_000);

    // The clock moves only when the test runs pending timers, so the kick stays pending.
    jest.useFakeTimers({ advanceTimers: false, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'], now: Date.now() });
    const settle = async <T,>(p: Promise<T>): Promise<T> => {
      let done = false;
      const q = p.finally(() => {
        done = true;
      });
      for (let i = 0; i < 400 && !done; i++) await new Promise((r) => setImmediate(r));
      return q;
    };
    await settle(pipeline.handlePush(b0.requestId, 'foreground')); // → done → drain yields → kick
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    holdKick(); // the post-finalize kick re-enqueues nothing
    await settle(pipeline.abortRun('test')); // finalize stops the poller
    expect(await currentRun()).toBeNull();

    await jest.runOnlyPendingTimersAsync(); // the kicked tick: no run → stopPoller() again
    expect(await pipeline.getPipelineStatus()).toBe('idle');

    const polls = watchResultsPolls();
    setAppState('active');
    for (let i = 0; i < 5; i++) await jest.runOnlyPendingTimersAsync();
    expect(polls).toEqual([]);
  });
});

// PE13: a drain that yields to a due poll kicks a poll tick at ZERO delay (kickPollTick). When the
// limiter slot is still busy, that tick cannot poll, its own drain yields again and kicks again, and
// the JS thread spins on getPipeline until the slot frees (~1s). The right behaviour waits for the
// slot, as the poller's first tick does (msUntilNextGrant() + 1). The test cannot just pass time: a
// zero-delay timer that re-arms itself never lets a fake clock move far, so advancing it would hang.
// It runs a FIXED number of timer generations instead (each runOnlyPendingTimersAsync runs only the
// timers already pending, moving the clock to the latest of them) and counts the pipeline reads
// made while the slot is busy, after the push that started it has settled.
describe('PE13 a drain that yields while the limiter slot is busy', () => {
  const GENERATIONS = 40;

  /** Batch 0 collected by push, batch 1 due for its poll, the slot just taken: the drain yields. */
  async function readsWhileSlotBusy(): Promise<number> {
    const script: Script = { defaultScore: 0.1 };
    gateway(script, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(ids(5 + 10));
    await tickUntil(async () => (await waitingCount()) === 2);
    const [b0] = await batches();
    gateway(script);
    holdJobs((id) => id !== b0.requestId);
    // Foreground without the change event, so no interval timer exists: only the drain's kick ticks.
    appStateModule.currentState = 'active';
    // Batch 1 is due for its poll, and a gateway action has just taken the slot (busy ~1s).
    later(3_000);
    expect(limiter.tryTakeImmediate()).toBe(true);

    let busyReads = 0;
    const realGet = articleStore.getPipeline;
    jest.spyOn(articleStore, 'getPipeline').mockImplementation(async () => {
      if (limiter.msUntilNextGrant() > 0) busyReads += 1;
      return realGet();
    });

    // From here the clock moves only when the test runs pending timers.
    jest.useFakeTimers({ advanceTimers: false, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'], now: Date.now() });
    let settled = false;
    const push = pipeline.handlePush(b0.requestId, 'foreground').finally(() => {
      settled = true;
    }); // → done → afterTerminal → drain → yields to batch 1's poll
    for (let i = 0; i < 200 && !settled; i++) await new Promise((r) => setImmediate(r));
    await push;
    expect((await phases())[0]).toBe('done');

    busyReads = 0;
    for (let i = 0; i < GENERATIONS; i++) {
      await new Promise((r) => setImmediate(r));
      await jest.runOnlyPendingTimersAsync();
    }
    return busyReads;
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('PE13 the yielded poll tick waits for the slot instead of re-reading the pipeline while it is busy', async () => {
    // Waiting for the slot, the kicked tick reads the pipeline once the slot is free: at most one
    // generation's worth of reads can land while it is still busy.
    expect(await readsWhileSlotBusy()).toBeLessThanOrEqual(6);
  });
});
