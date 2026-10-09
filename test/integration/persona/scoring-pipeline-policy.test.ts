// scoring-pipeline policy: the PURE half of the pipeline (slot scheduling, header and chunk
// projections, ramp, stale-run verdict, reasons-in-flight set). The cases are copied from
// lib/services/__tests__/scoring-pipeline.test.ts UNCHANGED. They live in `integration` only because
// importing scoring-pipeline needs the integration setup; R11 moves them to lib/algorithms in P4.
import type { PipelineRun } from '@/lib/database/services/scoring-pipeline-store';
import {
  COLLECT_WINDOW_MS,
  MAX_BATCH_ARTICLES,
  MAX_IN_FLIGHT,
  MAX_IN_FLIGHT_TOTAL,
  deriveReasonsInFlightIds,
  derivePipelineBatchProgress,
  derivePipelineChunkStates,
  derivePipelineUiState,
  deriveStaleRunVerdict,
  pendingPollKey,
  pickNextGatewayAction,
  rampedBatchCap,
} from '@/lib/services/scoring-pipeline';

const NOW = 1_700_000_000_000;

describe('enqueueCandidates: MIN_DISPATCH floor / MAX_BATCH_ARTICLES ceiling', () => {
  it('rampedBatchCap repeats the last step and never exceeds the ceiling', () => {
    expect([0, 1, 2, 3, 4, 9].map((r) => rampedBatchCap(r, 5, MAX_BATCH_ARTICLES))).toEqual([
      5, 10, 25, 50, 50, 50,
    ]);
  });
});

// ---- helpers ----
function makeRun(batches: any[]): PipelineRun {
  return {
    schema: 1,
    runId: 'run-test',
    startedAt: NOW,
    algo: 'ed25519',
    expoPushToken: null,
    batches: batches.map((b, i) => ({ batchId: i, attempt: 0, ...b })),
    version: 1,
  };
}

describe('derivePipelineUiState', () => {
  it('is relevance while any batch still owes a relevance round', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'waiting-relevance', candidateIds: ['a', 'b'] },
        { phase: 'done', candidateIds: ['c'] },
      ]),
    );
    expect(ui.phase).toBe('relevance');
    expect(ui.processedCount).toBe(1); // done batch only — relevance still pending on the other
    expect(ui.totalCount).toBe(3);
  });

  it('counts relevance-known batches (needs-reasons-submit/submitting-reasons/waiting-reasons) as processed even before terminal', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'waiting-reasons', candidateIds: ['a', 'b'] },
        { phase: 'needs-reasons-submit', candidateIds: ['c'] },
        { phase: 'submitting-reasons', candidateIds: ['e'] },
        { phase: 'done', candidateIds: ['d'] },
      ]),
    );
    expect(ui.phase).toBe('reasons');
    // Every batch here has relevance known (past the pre-relevance phases) —
    // the numerator should equal the denominator even though 3 of 4 batches
    // are still non-terminal.
    expect(ui.processedCount).toBe(5);
    expect(ui.totalCount).toBe(5);
  });

  it('does NOT count queued/submitting-relevance/waiting-relevance batches as processed', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'queued', candidateIds: ['a'] },
        { phase: 'submitting-relevance', candidateIds: ['b'] },
        { phase: 'waiting-relevance', candidateIds: ['c'] },
      ]),
    );
    expect(ui.phase).toBe('relevance');
    expect(ui.processedCount).toBe(0);
    expect(ui.totalCount).toBe(3);
  });

  it('counts a failed (terminal) batch as processed so progress cannot stall below total', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'failed', candidateIds: ['a', 'b'] },
        { phase: 'waiting-relevance', candidateIds: ['c'] },
      ]),
    );
    expect(ui.processedCount).toBe(2);
    expect(ui.totalCount).toBe(3);
  });

  it('treats a queued reasonsOnly batch as reasons work (not relevance) and counts it immediately', () => {
    const ui = derivePipelineUiState(
      makeRun([{ phase: 'queued', reasonsOnly: true, candidateIds: ['a'] }]),
    );
    expect(ui.phase).toBe('reasons');
    expect(ui.processedCount).toBe(1);
    expect(ui.totalCount).toBe(1);
  });

  it('counts a submitting-relevance reasonsOnly batch as processed immediately (reasonsOnly never owes a relevance round)', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'submitting-reasons', reasonsOnly: true, candidateIds: ['a', 'b'] },
      ]),
    );
    expect(ui.processedCount).toBe(2);
    expect(ui.totalCount).toBe(2);
  });

  it('is idle when every batch is terminal', () => {
    const ui = derivePipelineUiState(
      makeRun([
        { phase: 'done', candidateIds: ['a'] },
        { phase: 'failed', candidateIds: ['b', 'c'] },
      ]),
    );
    expect(ui).toEqual({ phase: 'idle', processedCount: 0, totalCount: 0 });
  });
});

describe('derivePipelineBatchProgress', () => {
  it('projects {done, total} article counts (done = relevance-known articles)', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([
          { phase: 'done', candidateIds: ['a', 'b'] },
          { phase: 'waiting-relevance', candidateIds: ['c'] },
        ]),
      ),
    ).toEqual({ done: 2, total: 3 });
  });

  it('counts relevance-known non-terminal batches toward done', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([
          { phase: 'waiting-reasons', candidateIds: ['a', 'b'] },
          { phase: 'waiting-relevance', candidateIds: ['c'] },
        ]),
      ),
    ).toEqual({ done: 2, total: 3 });
  });

  it('is {done:0,total:0} when every batch is terminal (idle)', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([{ phase: 'done', candidateIds: ['a'] }]),
      ),
    ).toEqual({ done: 0, total: 0 });
  });

  it('projects a legacy per-fact run identically (batches just counted)', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([
          { phase: 'done', factId: 'f1', factStatement: 'Fact one', candidateIds: ['a'] },
          { phase: 'waiting-relevance', factId: 'f2', factStatement: 'Fact two', candidateIds: ['b', 'c'] },
        ]),
      ),
    ).toEqual({ done: 1, total: 3 });
  });

  // --- coverage: the articles a run REALLY analyses -----------------------
  // The gate enqueues one elected representative per duplicate story group, so
  // the candidate count is a fraction of the articles being analysed. Batches
  // carry the covered ids so the header can count articles, not representatives.

  it('counts the held-back siblings a representative covers, not just the candidates', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([
          // 1 candidate standing in for a group of 3, plus a singleton.
          {
            phase: 'done',
            candidateIds: ['rep'],
            coveredIds: ['rep', 'sib1', 'sib2'],
          },
          { phase: 'waiting-relevance', candidateIds: ['solo'], coveredIds: ['solo'] },
        ]),
      ),
    ).toEqual({ done: 3, total: 4 });
  });

  it('unions overlapping covered sets so a re-elected sibling is not double-counted', () => {
    // A held-back sibling is not in-flight, so the next gate pass elects IT and
    // enqueues it in a batch of its own — its id legitimately appears twice.
    // Summing would report 5 articles for 3.
    expect(
      derivePipelineBatchProgress(
        makeRun([
          { phase: 'waiting-relevance', candidateIds: ['rep'], coveredIds: ['rep', 'sib1', 'sib2'] },
          { phase: 'queued', candidateIds: ['sib1'], coveredIds: ['sib1', 'sib2'] },
        ]),
      ),
    ).toEqual({ done: 0, total: 3 });
  });

  it('falls back to candidateIds for batches persisted before coveredIds shipped', () => {
    expect(
      derivePipelineBatchProgress(
        makeRun([
          { phase: 'done', candidateIds: ['a', 'b'] }, // legacy: no coveredIds
          { phase: 'waiting-relevance', candidateIds: ['c'], coveredIds: ['c', 'c-sib'] },
        ]),
      ),
    ).toEqual({ done: 2, total: 4 });
  });

  it('is immune to the submit-time candidateIds shrink (coveredIds is never rewritten)', () => {
    // The backstop path replaces candidateIds with the eligible subset at
    // submit; the denominator must not shrink underneath the user.
    const before = derivePipelineBatchProgress(
      makeRun([
        { phase: 'queued', candidateIds: ['a', 'b', 'c'], coveredIds: ['a', 'b', 'c'] },
        { phase: 'waiting-relevance', candidateIds: ['z'], coveredIds: ['z'] },
      ]),
    );
    const afterShrink = derivePipelineBatchProgress(
      makeRun([
        { phase: 'queued', candidateIds: ['a'], coveredIds: ['a', 'b', 'c'] },
        { phase: 'waiting-relevance', candidateIds: ['z'], coveredIds: ['z'] },
      ]),
    );
    expect(afterShrink).toEqual(before);
    expect(afterShrink.total).toBe(4);
  });
});

describe('derivePipelineChunkStates', () => {
  // The bucketing table, all eight BatchPhase values, so a phase added later
  // fails here rather than silently rendering as `in-flight`.
  it('buckets every phase', () => {
    const run = makeRun([
      { phase: 'queued', candidateIds: ['a'] },
      { phase: 'submitting-relevance', candidateIds: ['b'] },
      { phase: 'waiting-relevance', candidateIds: ['c'] },
      { phase: 'needs-reasons-submit', candidateIds: ['d'] },
      { phase: 'submitting-reasons', candidateIds: ['e'] },
      { phase: 'waiting-reasons', candidateIds: ['f'] },
      { phase: 'done', candidateIds: ['g'] },
      { phase: 'failed', candidateIds: ['h'] },
    ]);
    expect(derivePipelineChunkStates(run).chunks).toEqual([
      'queued',
      'in-flight',
      'in-flight',
      'in-flight',
      'in-flight',
      'in-flight',
      'ready',
      'failed',
    ]);
  });

  it('keeps run.batches order, so a failed chunk sits behind ready ones', () => {
    const states = derivePipelineChunkStates(
      makeRun([
        { phase: 'done', candidateIds: ['a'] },
        { phase: 'failed', candidateIds: ['b'] },
        { phase: 'done', candidateIds: ['c'] },
        { phase: 'waiting-relevance', candidateIds: ['d'] },
      ]),
    );
    expect(states.chunks).toEqual(['ready', 'failed', 'ready', 'in-flight']);
    expect(states.ready).toBe(2);
    expect(states.total).toBe(4);
  });

  it('reports nothing once every batch is terminal, so no stale strip survives', () => {
    // Same idle rule as derivePipelineBatchProgress: one definition of idle
    // across the three projections, not three kept in lockstep by hand.
    expect(
      derivePipelineChunkStates(
        makeRun([
          { phase: 'done', candidateIds: ['a'] },
          { phase: 'failed', candidateIds: ['b'] },
        ]),
      ),
    ).toEqual({ chunks: [], ready: 0, total: 0 });
  });

  it('counts BATCHES, which is not derivePipelineBatchProgress\'s article count', () => {
    // Both are true at the same instant and neither is the other\'s percentage.
    // Presenting one as the other is the trap this pins.
    const run = makeRun([
      { phase: 'done', candidateIds: ['a', 'b', 'c'] },
      { phase: 'waiting-relevance', candidateIds: ['d', 'e'] },
    ]);
    expect(derivePipelineChunkStates(run)).toEqual({
      chunks: ['ready', 'in-flight'],
      ready: 1,
      total: 2,
    });
    expect(derivePipelineBatchProgress(run)).toEqual({ done: 3, total: 5 });
  });

  it('grows rather than resets when the gate elects more batches mid-run', () => {
    // The gate re-elects held-back duplicate siblings into new batches, so
    // `total` is not fixed when the strip first renders.
    expect(
      derivePipelineChunkStates(makeRun([{ phase: 'waiting-relevance', candidateIds: ['a'] }]))
        .total,
    ).toBe(1);
    expect(
      derivePipelineChunkStates(
        makeRun([
          { phase: 'waiting-relevance', candidateIds: ['a'] },
          { phase: 'queued', candidateIds: ['b'] },
          { phase: 'queued', candidateIds: ['c'] },
        ]),
      ).total,
    ).toBe(3);
  });

  it('reports an empty run as idle rather than as a zero-length strip', () => {
    expect(derivePipelineChunkStates(makeRun([]))).toEqual({
      chunks: [],
      ready: 0,
      total: 0,
    });
  });
});

describe('staleRunVerdict', () => {
  const run = (over: Partial<PipelineRun>, batches: any[]): PipelineRun =>
    ({ schema: 3, runId: 'r', startedAt: NOW, algo: 'ed25519', expoPushToken: null, version: 1, batches, ...over }) as PipelineRun;

  it('is fresh while the run moved within the guard window', () => {
    const r = run({ startedAt: NOW - 3600_000 }, [
      { batchId: 0, phase: 'waiting-relevance', candidateIds: ['a'], attempt: 0, submittedAt: NOW - 60_000 },
    ]);
    expect(deriveStaleRunVerdict(r, NOW)).toBe('fresh');
  });

  it('is collectable when quiet but a batch was submitted within the collect window', () => {
    const r = run({ startedAt: NOW - 8 * 3600_000 }, [
      { batchId: 0, phase: 'waiting-relevance', candidateIds: ['a'], attempt: 0, submittedAt: NOW - 6 * 3600_000 },
    ]);
    expect(deriveStaleRunVerdict(r, NOW)).toBe('collectable');
  });

  it('counts a needs-reasons-submit batch as collectable too', () => {
    const r = run({ startedAt: NOW - 8 * 3600_000 }, [
      { batchId: 0, phase: 'needs-reasons-submit', candidateIds: ['a'], attempt: 0, submittedAt: NOW - 6 * 3600_000 },
    ]);
    expect(deriveStaleRunVerdict(r, NOW)).toBe('collectable');
  });

  it('is wedged past the collect window, or with nothing waiting', () => {
    const old = run({ startedAt: NOW - COLLECT_WINDOW_MS - 7200_000 }, [
      { batchId: 0, phase: 'waiting-relevance', candidateIds: ['a'], attempt: 0, submittedAt: NOW - COLLECT_WINDOW_MS - 3600_000 },
    ]);
    expect(deriveStaleRunVerdict(old, NOW)).toBe('wedged');
    const stuck = run({ startedAt: NOW - 3600_000 }, [
      { batchId: 0, phase: 'queued', candidateIds: ['a'], attempt: 0 },
    ]);
    expect(deriveStaleRunVerdict(stuck, NOW)).toBe('wedged');
  });
});

describe('reasons in flight', () => {
  it('covers reason candidates, their covered siblings and reasons-only batches; nothing terminal', () => {
    const r = {
      schema: 3, runId: 'r', startedAt: NOW, algo: 'ed25519', expoPushToken: null, version: 1,
      batches: [
        { batchId: 0, phase: 'waiting-reasons', candidateIds: ['a', 'b'], reasonCandidateIds: ['a'], coveredByRep: { a: ['a2'] }, attempt: 0 },
        { batchId: 1, phase: 'waiting-relevance', candidateIds: ['c'], attempt: 0 },
        { batchId: 2, phase: 'queued', reasonsOnly: true, candidateIds: ['d'], attempt: 0 },
        { batchId: 3, phase: 'done', candidateIds: ['e'], reasonCandidateIds: ['e'], attempt: 0 },
      ],
    } as unknown as PipelineRun;
    expect([...deriveReasonsInFlightIds(r)].sort()).toEqual(['a', 'a2', 'd']);
  });
});

describe('pickNextGatewayAction', () => {
  const b = (batchId: number, phase: string, extra: Record<string, unknown> = {}): any => ({
    batchId,
    phase,
    candidateIds: [],
    attempt: 0,
    requestId: `req-${batchId}`,
    submittedAt: NOW - 60_000,
    ...extra,
  });
  const pick = (batches: any[], opts: Record<string, unknown> = {}) =>
    pickNextGatewayAction(batches, {
      now: NOW,
      lastPolledAt: new Map(),
      allowFreshSubmit: true,
      ...opts,
    });

  it('an earlier batch\'s notes submit beats a later batch\'s relevance submit', () => {
    expect(pick([b(4, 'queued'), b(1, 'needs-reasons-submit')])).toEqual({
      kind: 'submit-reasons',
      batchId: 1,
    });
  });

  it('polls by rank, not by submit time: batch 1 before batch 3 even when submitted later', () => {
    const batches = [
      b(3, 'waiting-relevance', { submittedAt: NOW - 30_000 }),
      b(1, 'waiting-reasons', { submittedAt: NOW - 5_000 }),
    ];
    expect(pick(batches)).toEqual({ kind: 'poll', batchId: 1 });
  });

  it('notes jobs do not hold a relevance slot; the total cap still binds', () => {
    const relevanceFull = [
      b(0, 'waiting-reasons'),
      b(1, 'waiting-relevance'),
      b(2, 'waiting-relevance'),
      b(3, 'queued'),
    ];
    // Three outstanding jobs, but only two are relevance: batch 3 may submit
    // once the polls are out of the way.
    const spaced = new Map([0, 1, 2].map((id) => [id, NOW]));
    expect(pick(relevanceFull, { lastPolledAt: spaced })).toEqual({ kind: 'submit', batchId: 3 });

    const threeRelevance = [...relevanceFull.slice(1), b(4, 'waiting-relevance'), b(5, 'queued')];
    const spaced2 = new Map([1, 2, 4].map((id) => [id, NOW]));
    expect(pick(threeRelevance, { lastPolledAt: spaced2 })).toBeNull();
    expect(MAX_IN_FLIGHT).toBe(3);

    const totalFull = Array.from({ length: MAX_IN_FLIGHT_TOTAL }, (_, i) => b(i, 'waiting-reasons'));
    const spaced3 = new Map(totalFull.map((x: any) => [x.batchId, NOW]));
    expect(pick([...totalFull, b(9, 'queued', { reasonsOnly: true })], { lastPolledAt: spaced3 })).toBeNull();
  });

  it('caps never hold back a notes submit or a poll', () => {
    const full = Array.from({ length: MAX_IN_FLIGHT_TOTAL }, (_, i) => b(i + 1, 'waiting-relevance'));
    expect(pick([...full, b(0, 'needs-reasons-submit')])).toEqual({ kind: 'submit-reasons', batchId: 0 });
    expect(pick(full)).toEqual({ kind: 'poll', batchId: 1 });
  });

  it('returns nothing while every poll is inside its spacing', () => {
    const batches = [b(0, 'waiting-relevance'), b(1, 'waiting-reasons')];
    expect(pick(batches, { lastPolledAt: new Map([[0, NOW], [1, NOW]]) })).toBeNull();
  });

  it('backs a pending job off (x2, x4) so later batches still get submitted', () => {
    const batches = [b(0, 'waiting-relevance'), b(1, 'queued')];
    // Poll spacing is the mocked 1000ms limiter interval less the 250ms lead.
    const polled = new Map([[0, NOW - 1_000]]); // past one spacing (750), inside two (1500)
    const once = new Map([[pendingPollKey(batches[0]), 1]]);
    expect(pick(batches, { lastPolledAt: polled })).toEqual({ kind: 'poll', batchId: 0 });
    expect(pick(batches, { lastPolledAt: polled, pendingPolls: once })).toEqual({
      kind: 'submit',
      batchId: 1,
    });
  });

  it('backoff never leaves a slot idle: with nothing else to do, the backed-off job is polled', () => {
    const only = [b(0, 'waiting-relevance')];
    const polled = new Map([[0, NOW - 1_000]]); // past plain spacing, inside x4
    const twice = new Map([[pendingPollKey(only[0]), 2]]);
    expect(pick(only, { lastPolledAt: polled, pendingPolls: twice })).toEqual({ kind: 'poll', batchId: 0 });
  });

  it('a background wake never admits a fresh submit', () => {
    expect(pick([b(0, 'queued')], { allowFreshSubmit: false })).toBeNull();
  });

});
