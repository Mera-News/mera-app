// Skip notes (D42) on the cloud scoring pipeline. On: a relevance batch is the whole pass, its rows
// end `complete` with no note and no reasons job is ever built; the orphaned-reasons sweep finalises
// owed rows instead of sending them. Off: the reasons job goes out exactly as before. Turned off
// again: rows finalised without a note are re-pended and the orphaned-reasons sweep picks them up.
// Same seam and world as scoring-pipeline-results.test.ts: real pipeline, DB, stores, gateway client
// and the gateway mock.

import { saveScoringResult } from '@/lib/database/services/article-suggestion-scoring-writes';
import { rependSkippedNotes } from '@/lib/mera-protocol/scoring-service';
import * as pipeline from '@/lib/services/scoring-pipeline';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import {
  batches,
  cleanupWorld,
  currentRun,
  drive,
  gateway,
  holdJobs,
  jobSubmits,
  later,
  resetPipelineWorld,
  rows,
  seedAndEnqueue,
  seedArticles,
  warmAttestation,
  type Script,
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

beforeEach(() => resetPipelineWorld());
afterEach(() => {
  useMeraProtocolStore.setState({ skipNotes: false });
  cleanupWorld();
});

const skipNotes = (on: boolean) => useMeraProtocolStore.setState({ skipNotes: on });
/** Every job's call ids, in submit order: `score:<n>` for relevance, `reason:<n>` for notes. */
const submittedCalls = () => jobSubmits().map((s) => s.calls);
const anyReasonCall = () => submittedCalls().some((calls) => calls.some((c) => c.startsWith('reason:')));

/** One relevance batch submitted, then collected. */
async function scoreOneBatch(articleIds: string[], script: Script) {
  gateway(script, { pendingPolls: 999 });
  await warmAttestation();
  await seedAndEnqueue(articleIds, { flush: true });
  const batch = (await batches())[0];
  expect(batch.phase).toBe('waiting-relevance');
  gateway(script);
  holdJobs((id) => id !== batch.requestId);
  later();
  await drive(pipeline.handlePush(batch.requestId, 'foreground'));
}

describe('Skip notes on: one pass', () => {
  it('a relevance batch ends the run: rows complete with no note, and no reasons job is built', async () => {
    skipNotes(true);

    await scoreOneBatch(['a0', 'a1'], { scores: { a0: 0.9, a1: 0.2 } });

    const r = await rows();
    expect(r.a0).toMatchObject({ relevance: 0.8, reason: '', status: 'complete' });
    expect(r.a1).toMatchObject({ relevance: 0.2, status: 'complete' });
    expect(submittedCalls()).toEqual([['score:0']]);
    expect(anyReasonCall()).toBe(false);
    expect(await currentRun()).toBeNull();
  });

  it('the orphaned-reasons sweep finalises rows still owed a note and sends nothing', async () => {
    gateway({}, { pendingPolls: 999 });
    await warmAttestation();
    await seedArticles(['o0']);
    // Owed a note from before the switch (or a propagated sibling): `reason_pending`.
    await saveScoringResult('o0', { relevance: 0.8, reason: '', reasonSkipped: false });
    expect((await rows()).o0.status).toBe('reason_pending');
    skipNotes(true);

    await drive(pipeline.enqueueOrphanedReasons());

    expect((await rows()).o0).toMatchObject({ status: 'complete', reason: '', relevance: 0.8 });
    expect(await currentRun()).toBeNull();
    expect(jobSubmits()).toEqual([]);
  });
});

describe('Skip notes off (the default): unchanged', () => {
  it('the same batch saves the row pending and submits the reasons job for the impactful row in the same cycle', async () => {
    expect(useMeraProtocolStore.getState().skipNotes).toBe(false);

    await scoreOneBatch(['a0', 'a1'], { scores: { a0: 0.9, a1: 0.2 } });

    expect((await rows()).a0).toMatchObject({ relevance: 0.8, reason: '', status: 'reason_pending' });
    expect(submittedCalls()).toEqual([['score:0'], ['reason:0']]);
    expect((await batches())[0].phase).toBe('waiting-reasons');
  });
});

describe('Skip notes turned off again', () => {
  it('re-pends the note-less rows at or above the gate, and the orphaned-reasons sweep sends exactly those', async () => {
    skipNotes(true);
    await scoreOneBatch(['a0', 'a1', 'a2'], { scores: { a0: 0.9, a1: 0.65, a2: 0.2 } });
    expect(anyReasonCall()).toBe(false);

    skipNotes(false);
    expect(await rependSkippedNotes()).toBe(2);
    const r = await rows();
    expect([r.a0.status, r.a1.status, r.a2.status]).toEqual(['reason_pending', 'reason_pending', 'complete']);

    gateway({}, { pendingPolls: 999 });
    later();
    await drive(pipeline.enqueueOrphanedReasons());

    const bs = await batches();
    expect(bs).toHaveLength(1);
    expect(bs[0].reasonsOnly).toBe(true);
    expect([...bs[0].candidateIds].sort()).toEqual(['a0', 'a1']);
    expect(submittedCalls().at(-1)?.every((c) => c.startsWith('reason:'))).toBe(true);
  });
});
