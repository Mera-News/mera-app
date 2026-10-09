// scoring-pipeline results seams: what lands in the rows when a relevance or a reasons job is
// collected. Real DB rows, real stores, real decoder and bucketing; the gateway mock answers each job
// from a script keyed on the article ("Story <id>"). A job's answer is fixed when it is SUBMITTED, so
// each test installs its script before the run is created.
//
// The foreground poller is off (see scoring-pipeline.test.ts): `handlePush(requestId)` collects
// exactly one batch, `later()` makes a limiter slot free for the notes submit it may chain.

import { saveScoringResult } from '@/lib/database/services/article-suggestion-service';
import { addSuppression } from '@/lib/database/services/suppression-service';
import * as scoringService from '@/lib/mera-protocol/scoring-service';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { gatewayCalls, http, HttpResponse, server } from '@/test/helpers';
import { appStateModule } from '@/test/helpers/app-state';
import {
  batches,
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
  passTime,
  patchBatch,
  phases,
  resetPipelineWorld,
  rows,
  seedAndEnqueue,
  seedArticles,
  tickUntil,
  warmAttestation,
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

beforeEach(() => resetPipelineWorld());
afterEach(cleanupWorld);

const JOBS = '*/v1/inference/jobs';
/** A job's calls, as the model saw them: the reason calls of the latest job. */
const lastJobCalls = () => jobSubmits().at(-1)?.calls ?? [];
const systemOf = (callId: string) =>
  gatewayCalls('job').find((c) => c.callId === callId)?.messages.find((m) => m.role === 'system')?.content;

/** One relevance batch submitted and still pending on the gateway. */
async function toWaitingRelevance(articleIds: string[], script: Script, seedOpts: Parameters<typeof seedArticles>[1] = {}) {
  gateway(script, { pendingPolls: 999 });
  await warmAttestation();
  await seedAndEnqueue(articleIds, { flush: true, ...seedOpts });
  const batch = (await batches())[0];
  expect(batch.phase).toBe('waiting-relevance');
  return batch;
}

/** Collect `batch` (and only `batch`): every other job stays pending. */
async function collect(batch: { requestId?: string }, script: Script, ctx: 'foreground' | 'background' = 'foreground') {
  gateway(script);
  holdJobs((id) => id !== batch.requestId);
  later();
  await drive(pipeline.handlePush(batch.requestId, ctx));
}

describe('relevance completion', () => {
  it('saves scores, refreshes UI, and submits reasons in the same cycle when impactful rows exist', async () => {
    const script: Script = { scores: { a0: 0.9, a1: 0.2 } };
    const batch = await toWaitingRelevance(['a0', 'a1'], script);

    await collect(batch, script);

    const r = await rows();
    expect(r.a0).toMatchObject({ relevance: 0.8, reason: '', status: 'reason_pending' });
    expect(r.a1).toMatchObject({ relevance: 0.2, reason: '' });
    // the store was refreshed with the new scores
    const shown = Object.fromEntries(useForYouStore.getState().suggestions.map((s) => [s._id, s.relevance]));
    expect(shown).toMatchObject({ a0: 0.8, a1: 0.2 });
    // reasons job submitted this cycle, for the impactful subset only
    const submits = jobSubmits();
    expect(submits).toHaveLength(2);
    expect(submits[1].calls).toEqual(['reason:a0']);
    const b = (await batches())[0];
    expect(b.phase).toBe('waiting-reasons');
    expect(b.requestId).not.toBe(batch.requestId);
  });

  it('completes without a reasons job when nothing is impactful', async () => {
    const script: Script = { scores: { a0: 0.2, a1: 0.1 } };
    const batch = await toWaitingRelevance(['a0', 'a1'], script);

    await collect(batch, script);

    expect(jobSubmits()).toHaveLength(1);
    // the sub-threshold rows were discarded: terminal, no reason owed
    const r = await rows();
    expect(r.a0).toMatchObject({ status: 'complete', relevance: 0.2 });
    expect(r.a1).toMatchObject({ status: 'complete', relevance: 0.1 });
    // single batch → run finalized + cleared
    expect(await currentRun()).toBeNull();
  });

  it('admits the next queued batch after a batch completes', async () => {
    const script: Script = { defaultScore: 0.1 };
    gateway(script, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(Array.from({ length: 90 }, (_, i) => `id${i}`)); // 4 ramped batches
    await tickUntil(async () => (await phases()).filter((p) => p === 'waiting-relevance').length === 3);
    const b0 = (await batches())[0];
    expect((await phases())[3]).toBe('queued');

    await collect(b0, script);

    expect((await phases())[0]).toBe('done');
    // the previously-queued 4th batch is admitted (by the next poll tick: the drain that follows a
    // completion yields to the earlier batches' polls first)
    await tickUntil(async () => (await phases())[3] === 'waiting-relevance');
  });

  it('never writes scores for a relevance batch whose fetch 404s (persists nothing)', async () => {
    // MAX_BATCH_ATTEMPTS reached on a waiting-relevance batch → failed, no scores.
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    const batch = (await batches())[0];
    server.use(http.get('*/v1/inference/jobs/:id/results', () => new HttpResponse('Unknown requestId', { status: 404 })));

    // attempt 1 → requeued to queued, re-drained → waiting again on a NEW job
    later();
    await drive(pipeline.handlePush(batch.requestId, 'foreground'));
    const b1 = (await batches())[0];
    expect(b1.attempt).toBe(1);
    await tickUntil(async () => (await batches())[0].phase === 'waiting-relevance');
    const resubmitted = (await batches())[0];
    expect(resubmitted.requestId).not.toBe(batch.requestId);

    // attempt 2 → failed → single failed batch finalizes + clears the run
    holdKick(); // the row is still unscored; nothing else goes to the gateway
    later(20_000);
    await drive(pipeline.handlePush(resubmitted.requestId, 'foreground'));

    expect(await currentRun()).toBeNull();
    expect((await rows()).a0).toMatchObject({ status: 'unscored', relevance: 0 });
  });

  it('finishes the batch clean, keeping the score, when the v4 tag gate skips every impactful reason', async () => {
    // legacyTagReasonGateEnabled (v4, off by default) skips the reason call of a row tagged with a
    // gated event type and parks it `reason_skipped` at its real score. Every impactful row gated
    // means an EMPTY reasons bundle: the batch must finish, not wait for a job that was never sent.
    const cfg = DEFAULT_HARNESS_CONFIG.articlePipeline;
    const saved = cfg.legacyTagReasonGateEnabled;
    const script: Script = { scores: { a0: 0.9 } };
    const batch = await toWaitingRelevance(['a0'], script, { extra: { event_type: 'crime' } });
    cfg.legacyTagReasonGateEnabled = true;
    try {
      await collect(batch, script);
    } finally {
      cfg.legacyTagReasonGateEnabled = saved;
    }

    expect(jobSubmits()).toHaveLength(1); // no reasons job
    expect((await rows()).a0).toMatchObject({ relevance: 0.8, reason: '', status: 'reason_skipped' });
    expect(await currentRun()).toBeNull(); // done → finalized
  });

  it('a failed score call leaves its rows unscored and finishes the batch without a reasons job', async () => {
    const script: Script = { failScores: true };
    const batch = await toWaitingRelevance(['a0', 'a1'], script);

    await collect(batch, script);

    // The decoder reports the fallback score for a failed call but marks the ids failed: nothing is
    // persisted for them, so they re-enter the next run.
    expect(Object.values(await rows()).every((r) => r.status === 'unscored' && r.relevance === 0)).toBe(true);
    // no reasons job was ever built (the post-finalize kick may re-submit the rows as a new run)
    expect(jobSubmits().flatMap((j) => j.calls).every((c) => c.startsWith('score:'))).toBe(true);
  });

  it.each([
    ['inactive', 'ExponentPushToken[test]'],
    ['active', null],
  ] as const)('the chained reasons job carries the push token only when the app is not on screen (%s)', async (state, token) => {
    const submits = captureSubmits();
    const script: Script = { scores: { a0: 0.9 } };
    const batch = await toWaitingRelevance(['a0'], script);
    appStateModule.currentState = state; // silent: no poller starts

    await collect(batch, script);
    await passTime(100);

    expect(submits).toHaveLength(2);
    expect(submits[1].token).toBe(token);
  });

  it('skips ids the results do not cover, leaving them out of the maps', async () => {
    // Older-build shape (isolation patch): the batch lists five more ids than the job had calls for.
    const script: Script = {};
    const batch = await toWaitingRelevance(ids(5), script);
    await patchBatch(0, (b) => {
      b.candidateIds = [...b.candidateIds, ...ids(5, 'ghost')];
    });

    await collect(batch, script);

    const b = (await batches())[0];
    expect(Object.keys(b.relevanceMap ?? {}).sort()).toEqual(ids(5));
    expect(Object.values(await rows()).every((r) => r.relevance === 0.8)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// STALE v3 BATCH — the upgrade window.
//
// The v3 scorer is deleted, but a device that had the beta ON when this build
// landed can still hold a persisted batch submitted under it, sitting in
// `waiting-relevance`. Its results are a DIFFERENT output contract (one merged
// call returning {"i","rel","impact","why"?} per article) from the legacy
// `score:N` chunks. Handing them to the legacy decoder would NOT fail loudly —
// it would write garbage scores onto real rows.
//
// This is the only new behaviour in the v3→v4 change that executes solely on a
// real device during an upgrade, so nothing else would catch a regression here.
// ---------------------------------------------------------------------------

describe('batch from a retired scorer (still in flight across the upgrade)', () => {
  async function waitingBatchMarked(marker: 'v3Mode' | 'judgeMode') {
    const script: Script = { defaultScore: 0.9 };
    const batch = await toWaitingRelevance(['a0', 'a1'], script);
    // Nothing in this build writes either marker — only a pre-upgrade run could carry one — so
    // it is written into the persisted run through the store.
    await patchBatch(0, (b) => {
      b[marker] = true;
    });
    return { batch, script };
  }

  it('never decodes it — requeues instead of writing garbage scores', async () => {
    const { batch, script } = await waitingBatchMarked('v3Mode');

    await collect(batch, script);

    // The decoder was never reached: no score was persisted.
    expect(Object.values(await rows()).every((r) => r.status === 'unscored' && r.relevance === 0)).toBe(true);
  });

  it('requeues rather than failing, so the rows are RE-SCORED not merely dropped', async () => {
    const { batch, script } = await waitingBatchMarked('v3Mode');

    await collect(batch, script);

    // attempt 1 of MAX_BATCH_ATTEMPTS ⇒ requeued (not failed). A waiting-relevance failure persists
    // nothing, so the rows stay `unscored` either way — but requeueing re-submits them down the
    // legacy path in THIS run instead of leaving them for the next one.
    const b = (await batches())[0];
    expect(b.attempt).toBe(1);
    expect(['queued', 'submitting-relevance', 'waiting-relevance']).toContain(b.phase);
    expect(b.candidateIds).toEqual(['a0', 'a1']);
  });

  // The JUDGE is the second retired scorer. Its marker is a first-class persisted field
  // (`PipelineBatch.judgeMode`), not an ad-hoc annotation, and its results were a {"j","s"?,"r"?}
  // array rather than `score:N` chunks — a different contract from the legacy decoder, exactly like
  // v3's. Unlike v3 no SHIPPED build could have produced one, so this covers dev/staging devices.
  it('also catches a judge-mode batch, and never decodes it', async () => {
    const { batch, script } = await waitingBatchMarked('judgeMode');

    await collect(batch, script);

    expect(Object.values(await rows()).every((r) => r.status === 'unscored' && r.relevance === 0)).toBe(true);
    expect((await batches())[0].attempt).toBe(1);
  });

  it('clears the judge marker on resubmit — the detector cannot loop', async () => {
    const { batch, script } = await waitingBatchMarked('judgeMode');

    await collect(batch, script);

    expect((await batches())[0].judgeMode).toBeUndefined();
  });

  it('clears the v3 marker on resubmit — the detector cannot loop', async () => {
    const { batch, script } = await waitingBatchMarked('v3Mode');

    await collect(batch, script);

    // `transitionToWaitingRelevance` clears `v3Mode` UNCONDITIONALLY. Without that, the requeued
    // batch would carry the marker straight back into waiting-relevance and trip the detector again
    // every cycle until its attempts ran out — turning a one-off upgrade hiccup into a dead batch.
    const b = (await batches())[0] as unknown as { v3Mode?: boolean; phase: string };
    expect(b.phase).toBe('waiting-relevance'); // resubmitted, so the clear really ran
    expect(b.v3Mode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// P8 — SOFT suppression ("Shown less") on the BACKSTOP/legacy path.
//
// The cloud LLM knows nothing about the user's filters and its score REPLACES
// the math score that carried the penalty, so a soft filter used to be computed
// and then discarded on this path. Submit carries the already-computed penalty
// on the batch; decode subtracts it before bucketing, the reason gate and
// discardLowRelevance.
//
// A soft filter is a keyword suppression with strength < 0.8; one match costs
// P_SUP (0.3) x strength = 0.15 at strength 0.5. Rows are matched by "quokka" in the title.
// ---------------------------------------------------------------------------

describe('soft suppression on the legacy path', () => {
  const PENALTY = 0.15;
  const quokka = (id: string) => `Story ${id} quokka`;
  const soft = () => addSuppression({ pattern: 'quokka', keywords: ['quokka'], strength: 0.5, source: 'chat' });

  /** a0 matches the filter, a1 does not. */
  async function submitted(script: Script, articleIds = ['a0', 'a1']) {
    gateway(script, { pendingPolls: 999 });
    await soft();
    await warmAttestation();
    await seedArticles(['a0'], { title: quokka });
    await seedArticles(articleIds.filter((id) => id !== 'a0'));
    await drive(pipeline.enqueueCandidates(articleIds, true));
    return (await batches())[0];
  }

  it('carries only the NON-ZERO penalties on the batch at submit', async () => {
    const batch = await submitted({});

    expect(batch.phase).toBe('waiting-relevance');
    expect(Object.keys(batch.suppressPenaltyMap ?? {})).toEqual(['a0']);
    expect(batch.suppressPenaltyMap?.a0).toBeCloseTo(PENALTY, 10);
  });

  it('omits the field entirely when nothing matched (pre-change code path)', async () => {
    gateway({}, { pendingPolls: 999 });
    await soft(); // a filter exists, but no row matches it
    await warmAttestation();
    await seedAndEnqueue(['a0', 'a1'], { flush: true });

    expect((await batches())[0].suppressPenaltyMap).toBeUndefined();
  });

  it('subtracts the penalty from the persisted LLM score, leaving unmatched rows byte-identical', async () => {
    const script: Script = { scores: { a0: 0.5, a1: 0.5 } };
    const batch = await submitted(script);

    await collect(batch, script);

    const r = await rows();
    // 0.5 - 0.15 = 0.35: under the discard floor, so it is stored unbucketed
    expect(r.a0.relevance).toBeCloseTo(0.35, 10);
    expect(r.a1.relevance).toBe(0.4); // strict: matched nothing ⇒ the plain bucketed 0.5
  });

  it('never drives the persisted score below 0', async () => {
    const script: Script = { scores: { a0: 0.1, a1: 0.9 } };
    const batch = await submitted(script);

    await collect(batch, script);

    expect((await rows()).a0.relevance).toBe(0);
  });

  it('demotes below the reason gate — a penalised row earns no reasons job', async () => {
    // 0.5 buckets to 0.4 and clears the reason gate; 0.5 - 0.15 = 0.35 does not.
    const script: Script = { scores: { a0: 0.5, a1: 0.5 } };
    const batch = await submitted(script);

    await collect(batch, script);

    expect(lastJobCalls()).toEqual(['reason:a1']);
    expect((await rows()).a0.relevance).toBeCloseTo(0.35, 10);
  });

  it('penalises the MATH-mode rows of a MIXED batch too (they ride the legacy prompt)', async () => {
    // One tagged row and one untagged row: the penalty map is keyed over the WHOLE stage, so
    // neither silently loses its penalty.
    const script: Script = { scores: { a0: 0.5, a1: 0.5 } };
    gateway(script, { pendingPolls: 999 });
    await soft();
    await warmAttestation();
    await seedArticles(['a0'], {
      title: quokka,
      extra: { entities: ['Quokka Inc'], event_type: 'policy', geo_tags: [{ countryCode: 'NL' }], category: 'politics' },
    });
    await seedArticles(['a1'], { title: quokka });
    await drive(pipeline.enqueueCandidates(['a0', 'a1'], true));
    const batch = (await batches())[0];

    expect(batch.judgeMode).toBeFalsy(); // the legacy path
    expect(batch.suppressPenaltyMap?.a0).toBeCloseTo(PENALTY, 10);
    expect(batch.suppressPenaltyMap?.a1).toBeCloseTo(PENALTY, 10);

    await collect(batch, script);

    const r = await rows();
    expect(r.a0.relevance).toBeCloseTo(0.35, 10);
    expect(r.a1.relevance).toBeCloseTo(0.35, 10);
  });
});

describe('reasons completion', () => {
  /** Drive one batch to `waiting-reasons` with `a0` scored 0.8 (its notes job held pending). */
  async function toWaitingReasons(script: Script, articleIds = ['a0']) {
    const b0 = await toWaitingRelevance(articleIds, { scores: { a0: 0.9 }, ...script });
    await collect(b0, { scores: { a0: 0.9 }, ...script });
    const reasonsBatch = (await batches())[0];
    expect(reasonsBatch.phase).toBe('waiting-reasons');
    return reasonsBatch;
  }

  /** Release every job and collect the reasons batch. */
  async function completeReasons(reasonsBatch: { requestId?: string }) {
    holdJobs(null);
    later();
    await drive(pipeline.handlePush(reasonsBatch.requestId, 'foreground'));
  }

  it('saves reasons, discards low-relevance, marks done', async () => {
    // a0 is impactful and gets a note; a1 is not and is discarded when the batch completes
    const reasonsBatch = await toWaitingReasons({ scores: { a0: 0.9, a1: 0.2 } }, ['a0', 'a1']);
    expect((await rows()).a1.status).toBe('reason_pending');

    await completeReasons(reasonsBatch);

    const r = await rows();
    expect(r.a0).toMatchObject({ reason: 'Why story a0 matters here.', status: 'complete', relevance: 0.8 });
    expect(r.a1.status).toBe('complete');
    // single batch → finalized + cleared
    expect(await currentRun()).toBeNull();
  });

  // --- pass-2 rescore -------------------------------------------------------
  //
  // When pass 2 returns a score as well as a sentence, the two are written in ONE update through
  // `saveScoringResult` rather than a reason write landing beside a score the reason contradicts.

  it('writes the reason AND the bucketed rescore in one saveScoringResult', async () => {
    const reasonsBatch = await toWaitingReasons({ rescores: { a0: { k: 'none', s: 0.16 } } });

    await completeReasons(reasonsBatch);

    // 0.16 is `none` band: below the 0.4 discard floor, so it buckets to itself and the card
    // leaves the feed. The reason and the score arrived together.
    expect((await rows()).a0).toMatchObject({
      relevance: 0.16,
      reason: 'Why story a0 matters here.',
      status: 'complete',
    });
  });

  it('buckets an ABOVE-gate rescore instead of persisting the raw value', async () => {
    const reasonsBatch = await toWaitingReasons({ rescores: { a0: { k: 'home', s: 0.93 } } });

    await completeReasons(reasonsBatch);

    // The feed renders four representative values, not a continuum, so a raw 0.93 has to arrive
    // as the HIGH band's score like every other score does.
    expect((await rows()).a0).toMatchObject({ relevance: 0.8, status: 'complete' });
  });

  it('hands the NEW score to discardLowRelevance, not the stored one', async () => {
    // The pass-2 note is not about this article, so the row's reason is dropped as ungrounded and
    // the rescore leaves it `reason_pending` at 0.16. Only a discard at the NEW score finishes it;
    // at the stored 0.8 it would stay pending forever.
    const reasonsBatch = await toWaitingReasons({
      notes: { a0: JSON.stringify({ k: 'none', s: 0.16, reason: 'Elephants migrate south for winter.' }) },
    });

    await completeReasons(reasonsBatch);

    expect((await rows()).a0).toMatchObject({ relevance: 0.16, reason: '', status: 'complete' });
  });

  it('falls back to saveReason when the response carried no score', async () => {
    const reasonsBatch = await toWaitingReasons({ notes: { a0: 'Why story a0 matters here.' } });

    await completeReasons(reasonsBatch);

    // saveReason leaves the relevance alone
    expect((await rows()).a0).toMatchObject({ relevance: 0.8, reason: 'Why story a0 matters here.', status: 'complete' });
  });

  it('survives a decode that predates rescoreMap entirely', async () => {
    // A missing field must not become `undefined.get(id)` inside the per-row try/catch, where it
    // would be swallowed and reported as a save failure. The real decoder always returns the map,
    // so ONE call is made to return the older shape (the relevance decode is left alone).
    const reasonsBatch = await toWaitingReasons({});
    const real = scoringService.decodeResults;
    const spy = jest.spyOn(scoringService, 'decodeResults').mockImplementationOnce((params) => {
      const { rescoreMap: _rescoreMap, ...older } = real(params);
      return older as ReturnType<typeof real>;
    });
    try {
      await completeReasons(reasonsBatch);
    } finally {
      spy.mockRestore();
    }

    expect((await rows()).a0).toMatchObject({ reason: 'Why story a0 matters here.', status: 'complete' });
  });

  it('marks the batch done (scores kept) when the reasons submit fails', async () => {
    const script: Script = { scores: { a0: 0.9 } };
    const batch = await toWaitingRelevance(['a0'], script);
    gateway(script);
    holdJobs((id) => id !== batch.requestId);
    // the reasons submit fails
    server.use(http.post(JOBS, () => new HttpResponse('bad', { status: 400 }), { once: true }));
    later();
    await drive(pipeline.handlePush(batch.requestId, 'foreground'));

    // scores were saved before the reasons submit
    expect((await rows()).a0).toMatchObject({ relevance: 0.8, status: 'reason_pending' });
    // batch ends done (not failed); single batch → finalized + cleared
    expect(await currentRun()).toBeNull();
  });
});

describe('enqueueOrphanedReasons', () => {
  it('appends reasonsOnly batches for qualified scored-without-reason rows', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedArticles(['o0', 'o1']);
    await saveScoringResult('o0', { relevance: 0.8, reason: '', reasonSkipped: false });
    await saveScoringResult('o1', { relevance: 0.1, reason: '', reasonSkipped: false }); // below threshold → excluded

    await drive(pipeline.enqueueOrphanedReasons());

    const bs = await batches();
    expect(bs).toHaveLength(1);
    expect(bs[0].reasonsOnly).toBe(true);
    expect(bs[0].candidateIds).toEqual(['o0']);
    // submitted as a reasons job
    expect(lastJobCalls()).toEqual(['reason:o0']);
    expect(bs[0].phase).toBe('waiting-reasons');
  });

  it.each([
    ['inactive', 'ExponentPushToken[test]'],
    ['active', null],
  ] as const)('the reasons-only job carries the push token only when the app is not on screen (%s)', async (state, token) => {
    const submits = captureSubmits();
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedArticles(['o0']);
    await saveScoringResult('o0', { relevance: 0.8, reason: '', reasonSkipped: false });
    appStateModule.currentState = state; // silent: no poller starts

    await drive(pipeline.enqueueOrphanedReasons());
    await passTime(100);

    expect(submits).toHaveLength(1);
    expect(submits[0].token).toBe(token);
  });
});

describe('top-headline cull — legacy path', () => {
  /** A headline row ('h0') and a topic-matched row ('t0'), one batch. */
  async function waitingBatchWithHeadlines(script: Script, withTopic = true) {
    gateway(script, { pendingPolls: 999 });
    await warmAttestation();
    if (withTopic) await seedArticles(['t0']);
    await seedArticles(['h0'], { headline: 'GLOBAL' });
    await drive(pipeline.enqueueCandidates(withTopic ? ['h0', 't0'] : ['h0'], true));
    return (await batches())[0];
  }

  it('excludes a LOW headline instead of saving it, and keeps it out of the reason + discard maps', async () => {
    const script: Script = { scores: { h0: 0.5, t0: 0.9 } }; // 0.5 buckets to LOW (0.4)
    const batch = await waitingBatchWithHeadlines(script);

    await collect(batch, script);

    const r = await rows();
    // terminally excluded, never saved
    expect(r.h0).toMatchObject({ status: 'excluded', relevance: 0, reason: '' });
    expect(r.t0).toMatchObject({ relevance: 0.8, status: 'reason_pending' });
    const b = (await batches())[0];
    expect(b.relevanceMap).toEqual({ t0: 0.8 });
    expect(b.rawRelevanceMap).toEqual({ t0: 0.9 });
    expect(b.reasonCandidateIds).toEqual(['t0']);
    expect(lastJobCalls()).toEqual(['reason:t0']);
  });

  it('leaves a MEDIUM headline alone (saved + reason-eligible as normal)', async () => {
    const script: Script = { scores: { h0: 0.7 } }; // MEDIUM (0.6)
    const batch = await waitingBatchWithHeadlines(script, false);

    await collect(batch, script);

    expect((await rows()).h0).toMatchObject({ relevance: 0.6, reason: '', status: 'reason_pending' });
    expect((await batches())[0].reasonCandidateIds).toEqual(['h0']);
  });

  it('never culls a topic-matched row at the same LOW score', async () => {
    const script: Script = { scores: { t0: 0.5 } };
    const batch = await toWaitingRelevance(['t0'], script);

    await collect(batch, script);

    expect((await rows()).t0).toMatchObject({ relevance: 0.4, status: 'reason_pending' });
    // Same BOUNDARY as the judge path: the reason gate is INCLUSIVE at 0.4, so a row exactly on
    // the LOW cutoff DOES get a reason round trip (renders ⇒ reason-eligible) — the batch advances
    // to the reasons phase instead of finalizing at relevance.
    const b = (await batches())[0];
    expect(b.phase).toBe('waiting-reasons');
    expect(b.reasonCandidateIds).toEqual(['t0']);
  });
});

// ---------------------------------------------------------------------------
// legacyNoteDemote — the v3 keep/demote note pass, transplanted onto the LEGACY path.
//
// What these pin, in order of what would hurt most if it broke:
//   1. FLAG OFF is byte-identical to before. This is the default.
//   2. The decision is captured at SUBMIT and survives the persist round trip. The two prompts have
//      different OUTPUT CONTRACTS, so a batch that sent one and decoded with the other would persist
//      raw JSON as a user-facing note.
//   3. An in-flight batch keeps its own contract even if the live config flips underneath it.
//
// The flag lives on DEFAULT_HARNESS_CONFIG.articlePipeline (nothing stored on the device can turn it
// on); a test flips it on the real object and restores it.
// ---------------------------------------------------------------------------

describe("legacyNoteDemote — the legacy path's keep/demote note pass", () => {
  const cfg = DEFAULT_HARNESS_CONFIG.articlePipeline;
  let savedFlag: boolean;
  beforeEach(() => {
    savedFlag = cfg.legacyNoteDemote;
  });
  afterEach(() => {
    cfg.legacyNoteDemote = savedFlag;
  });

  /** Drive one legacy candidate through relevance into the reasons phase, which is where the note
   *  prompt is chosen. */
  async function legacyToReasonPhase(script: Script, on: boolean) {
    cfg.legacyNoteDemote = on;
    const relevanceBatch = await toWaitingRelevance(['a0'], { scores: { a0: 0.9 }, ...script });
    await collect(relevanceBatch, { scores: { a0: 0.9 }, ...script });
    return { relevanceBatch, reasonsBatch: (await batches())[0] };
  }
  const completeReasons = async (b: { requestId?: string }) => {
    holdJobs(null);
    later();
    await drive(pipeline.handlePush(b.requestId, 'foreground'));
  };

  it('DEFAULT (off): no marker on the batch, legacy reason prompt, prose decoder', async () => {
    const { reasonsBatch } = await legacyToReasonPhase({ notes: { a0: 'Why story a0 matters here.' } }, false);

    // Absent, not `false` — a legacy run written before this field existed must parse and resume
    // identically, which is what makes the default inert.
    expect((reasonsBatch as { noteMode?: boolean }).noteMode).toBeUndefined();
    expect(systemOf('reason:a0')).not.toBe(cfg.v3NoteSystemPrompt);

    // Prose decoder: the plain reason is saved verbatim, and nothing is demoted.
    await completeReasons(reasonsBatch);
    expect((await rows()).a0).toMatchObject({ reason: 'Why story a0 matters here.', relevance: 0.8, status: 'complete' });
  });

  it('ON: the marker is persisted at submit and the note prompt is requested', async () => {
    const { reasonsBatch } = await legacyToReasonPhase({ verdicts: { a0: { keep: true, why: 'Why story a0 matters here.' } } }, true);

    const b = reasonsBatch as unknown as { noteMode?: boolean; v3Mode?: boolean };
    expect(b.noteMode).toBe(true);
    // No v3 marker — this is the LEGACY path wearing the note pass. Nothing writes `v3Mode` any
    // more; it exists only to be detected and cleared.
    expect(b.v3Mode).toBeUndefined();
    expect(systemOf('reason:a0')).toBe(cfg.v3NoteSystemPrompt);
  });

  it('ON: a kept row gets its sentence; the prose decoder is never consulted', async () => {
    const { reasonsBatch } = await legacyToReasonPhase({ verdicts: { a0: { keep: true, why: 'Why story a0 matters here.' } } }, true);

    await completeReasons(reasonsBatch);

    // The prose reader would have persisted the raw `{"keep":…}` JSON as the user-facing note.
    expect((await rows()).a0).toMatchObject({ reason: 'Why story a0 matters here.', status: 'complete' });
  });

  it('ON: a rejected row is demoted below the gate, terminal and noteless', async () => {
    const { reasonsBatch } = await legacyToReasonPhase({ verdicts: { a0: { keep: false } } }, true);

    await completeReasons(reasonsBatch);

    expect((await rows()).a0).toMatchObject({
      relevance: DEFAULT_HARNESS_CONFIG.articlePipeline.feedVerifierDemoteScore,
      reason: '',
      status: 'complete',
    });
  });

  it('ON: fails OPEN on an unusable verdict — score stands, note still owed', async () => {
    const { reasonsBatch } = await legacyToReasonPhase({ verdicts: { a0: 'junk' } }, true);

    await completeReasons(reasonsBatch);

    // Neither a note nor a demotion: the pass-1 score stands and the orphan sweep owes the note.
    expect((await rows()).a0).toMatchObject({ relevance: 0.8, reason: '', status: 'reason_pending' });
  });

  // The whole reason the marker is persisted rather than re-read at decode.
  it('an in-flight batch keeps its own contract when the live flag flips', async () => {
    const { reasonsBatch } = await legacyToReasonPhase({ verdicts: { a0: { keep: true, why: 'Why story a0 matters here.' } } }, true);
    expect((reasonsBatch as { noteMode?: boolean }).noteMode).toBe(true);

    // OTA lands mid-flight and turns the flag back off.
    cfg.legacyNoteDemote = false;
    await completeReasons(reasonsBatch);

    expect((await rows()).a0).toMatchObject({ reason: 'Why story a0 matters here.', status: 'complete' });
  });
});

// The orphaned-reason sweep is a SECOND submit path, and it reads the flag from its own call site.
// An earlier cut of this wiring read the raw DEFAULT_HARNESS_CONFIG literal there while the relevance
// path read the calibrated `effectiveHarnessConfig` — invisible today (both resolve to the same
// literal), and a silent split the moment the flag is layered at runtime. This pins that both paths
// ask the same question of the same object.
describe('legacyNoteDemote — the orphaned-reason sweep reads the same config', () => {
  const cfg = DEFAULT_HARNESS_CONFIG.articlePipeline;
  let savedFlag: boolean;
  beforeEach(() => {
    savedFlag = cfg.legacyNoteDemote;
  });
  afterEach(() => {
    cfg.legacyNoteDemote = savedFlag;
  });

  async function sweep(on: boolean) {
    cfg.legacyNoteDemote = on;
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedArticles(['o0']);
    await saveScoringResult('o0', { relevance: 0.8, reason: '', reasonSkipped: false });
    await drive(pipeline.enqueueOrphanedReasons());
    return (await batches())[0] as unknown as { noteMode?: boolean };
  }

  it('OFF: reasonsOnly batches carry no marker and request the legacy prompt', async () => {
    const b = await sweep(false);

    expect(systemOf('reason:o0')).not.toBe(cfg.v3NoteSystemPrompt);
    expect(b.noteMode).toBeUndefined();
  });

  it('ON: reasonsOnly batches request the note prompt AND persist the marker', async () => {
    const b = await sweep(true);

    expect(systemOf('reason:o0')).toBe(cfg.v3NoteSystemPrompt);
    // Persisted, not re-derived: this batch's results must decode as verdicts even if an OTA turns
    // the flag off while it is in flight.
    expect(b.noteMode).toBe(true);
  });
});

describe('reasons in flight', () => {
  it('publishes a NEW Set on every UI push', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedAndEnqueue(['a0'], { flush: true });
    const first = useForYouStore.getState().reasonsInFlightIds;
    expect(first).toBeInstanceOf(Set);
    expect(await pipeline.getReasonsInFlightIds()).toBeInstanceOf(Set);

    await seedArticles(['a1']);
    await drive(pipeline.enqueueCandidates(['a1'], true));

    const second = useForYouStore.getState().reasonsInFlightIds;
    expect(second).toBeInstanceOf(Set);
    expect(second).not.toBe(first);
  });

  it('copies a rep note onto its reason_pending covered sibling when reasons apply', async () => {
    // Two rows of one story: the gate elects ONE, holds the other back behind it.
    const script: Script = { defaultScore: 0.9 };
    gateway(script, { pendingPolls: 999 });
    await warmAttestation();
    const title = () => 'Dam breach floods the valley towns overnight';
    await seedArticles(['a0', 'a0-dup'], { title, clusterId: 'c1' });
    await drive(pipeline.enqueueUnscoredEligible({ flushRemainder: true }));
    const batch = (await batches())[0];
    const rep = batch.candidateIds[0];
    const dup = rep === 'a0' ? 'a0-dup' : 'a0';
    expect(batch.coveredByRep).toEqual({ [rep]: [dup] });

    // relevance lands → reasons submitted; the sibling inherits the rep's score without a note
    await collect(batch, { defaultScore: 0.9 });
    expect((await batches())[0].phase).toBe('waiting-reasons');
    expect(await pipeline.getReasonsInFlightIds()).toEqual(new Set([rep, dup]));
    expect((await rows())[dup].status).toBe('reason_pending');

    // reasons land → the sibling gets the note
    holdJobs(null);
    later();
    await drive(pipeline.handlePush((await batches())[0].requestId, 'foreground'));

    const r = await rows();
    expect(r[rep].reason).toBe(`Why story ${rep} matters here.`);
    expect(r[dup]).toMatchObject({ status: 'complete', relevance: 0.8 });
    expect(r[dup].reason).not.toBe('');
  });
});
