/**
 * The deferred, resumable combination pass: the atomic enqueue, sibling
 * claims, the per-fact combo diff, the mode drop and the end-of-pass refresh.
 *
 * The shared database mock IGNORES `Q.where`, so where the predicate IS the
 * behaviour these tests assert on `collection.query.mock.calls`; the service
 * also re-checks type/status/passId in JS, which is what the row-shaped
 * assertions below exercise.
 */
jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), captureException: jest.fn(), error: jest.fn() },
}));
const mockPurge = jest.fn(async (..._a: unknown[]) => 0);
jest.mock('../article-suggestion-service', () => ({
  purgeSuggestionsForDeadTopics: (...a: unknown[]) => mockPurge(...a),
}));
const mockGetFacts = jest.fn(async (..._a: unknown[]) => [] as { id: string }[]);
jest.mock('../fact-service', () => ({
  getFacts: (...a: unknown[]) => mockGetFacts(...a),
}));
const mockPrune = jest.fn(async () => {});
jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: { getState: () => ({ pruneOrphanedData: mockPrune }) },
}));
const mockTrigger = jest.fn(async (..._a: unknown[]) => 'ran');
jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: { trigger: (...a: unknown[]) => mockTrigger(...a) },
}));
const mockNotify = jest.fn();
jest.mock('@/lib/inference/InferenceQueue', () => ({
  inferenceQueue: { notify: () => mockNotify() },
}));
let mockIsConnected: boolean | null = true;
jest.mock('@/lib/stores/network-store', () => ({
  useNetworkStore: { getState: () => ({ isConnected: mockIsConnected }) },
}));
let mockCookie: string | null = 'session=abc';
jest.mock('@/lib/auth-client', () => ({
  authClient: { getCookie: () => mockCookie },
}));

import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database/index';
import { makeRecord, type MockDatabase } from '@/lib/__test-helpers__/mockDatabase';
import * as svc from '../combo-pass-service';
import { recoverCrashedJobs } from '../inference-job-service';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';

const db = database as unknown as MockDatabase;

function job(over: Record<string, unknown> = {}) {
  return makeRecord({
    id: 'j1',
    jobType: 'topic_combo',
    status: 'pending',
    priority: 15,
    payload: { factId: 'f1', passId: 'p1' },
    attempts: 0,
    maxAttempts: 3,
    ...over,
  });
}

function topic(over: Record<string, unknown> = {}) {
  return makeRecord({
    id: 't1',
    factId: 'f1',
    text: 'Dutch politics',
    normalizedText: 'dutch politics',
    weight: 0.5,
    status: 'active',
    provenance: 'combo',
    pendingDeleteAt: null,
    ...over,
  });
}

function setting(key: string, value: string) {
  return makeRecord({ id: `s-${key}`, key, value });
}

/** Every op passed to database.batch across the test, flattened. */
function batchedOps(): unknown[] {
  return db.batch.mock.calls.flatMap((c: unknown[]) => (c as unknown[]).flat());
}

beforeEach(() => {
  jest.clearAllMocks();
  svc.__resetComboPassForTests();
  mockIsConnected = true;
  mockCookie = 'session=abc';
  for (const t of ['inference_jobs', 'topics', 'facts', 'settings', 'declined_topics', 'tracked_stories']) {
    db._setRows(t, []);
  }
  // Restore any per-test query override.
  for (const col of Object.values(db._collections)) {
    col.query.mockClear();
  }
});

// ── Atomic enqueue ─────────────────────────────────────────────────────────

describe('enqueueComboPass', () => {
  it('creates N topic_combo jobs AND clears the pending flag in ONE batch', async () => {
    const flag = setting(svc.FACTS_COMBO_PENDING_KEY, '123');
    db._setRows('settings', [flag]);

    const { passId } = await svc.enqueueComboPass(['f1', 'f2', 'f1'], 'pass-x');

    expect(passId).toBe('pass-x');
    expect(db.write).toHaveBeenCalledTimes(1);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const creates = db._collections.inference_jobs.prepareCreate.mock.results.map((r) => r.value);
    expect(creates).toHaveLength(2); // f1 deduped
    for (const c of creates) {
      expect(c.jobType).toBe('topic_combo');
      expect(c.status).toBe('pending');
      expect(c.priority).toBe(15);
      expect(c.attempts).toBe(0);
      expect(Object.keys(c.payload).sort()).toEqual(['factId', 'passId']);
      expect(c.payload.passId).toBe('pass-x');
    }
    expect(creates.map((c) => c.payload.factId)).toEqual(['f1', 'f2']);
    const ops = batchedOps();
    expect(ops).toEqual(expect.arrayContaining([...creates, flag]));
    expect(flag.prepareDestroyPermanently).toHaveBeenCalled();
  });

  it('supersedes an earlier pass: its PENDING jobs go in the same batch, running ones are left', async () => {
    const oldPending = job({ id: 'old1', payload: { factId: 'f1', passId: 'p0' } });
    const oldRunning = job({ id: 'old2', status: 'running', payload: { factId: 'f2', passId: 'p0' } });
    const otherType = job({ id: 'tg', jobType: 'topic_gen', payload: { factId: 'f1' } });
    db._setRows('inference_jobs', [oldPending, oldRunning, otherType]);

    await svc.enqueueComboPass(['f1'], 'p1');

    expect(oldPending.prepareDestroyPermanently).toHaveBeenCalled();
    expect(oldRunning.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(otherType.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it('mints a pass id when none is given', async () => {
    const a = await svc.enqueueComboPass(['f1']);
    const b = await svc.enqueueComboPass(['f1']);
    expect(a.passId).toMatch(/^combo-/);
    expect(a.passId).not.toBe(b.passId);
  });
});

// ── Siblings ───────────────────────────────────────────────────────────────

describe('claimSiblings / releaseComboJobs', () => {
  it('claims up to `limit` pending jobs of the SAME pass, marking them running with an attempt', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      job({ id: `j${i}`, payload: { factId: `f${i}`, passId: 'p1' } }),
    );
    const otherPass = job({ id: 'x', payload: { factId: 'fx', passId: 'p2' } });
    const running = job({ id: 'r', status: 'running', payload: { factId: 'fr', passId: 'p1' } });
    db._setRows('inference_jobs', [...rows, otherPass, running]);

    const claimed = await svc.claimSiblings('p1');

    expect(claimed).toHaveLength(8);
    expect(claimed[0]).toEqual({ jobId: 'j0', factId: 'f0' });
    for (const r of rows.slice(0, 8)) {
      expect(r.status).toBe('running');
      expect(r.attempts).toBe(1);
    }
    expect(rows[8].status).toBe('pending');
    expect(otherPass.status).toBe('pending');
    expect(running.attempts).toBe(0);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const where = JSON.stringify(db._collections.inference_jobs.query.mock.calls[0]);
    expect(where).toContain(JSON.stringify(Q.where('job_type', 'topic_combo')));
    expect(where).toContain(JSON.stringify(Q.where('status', 'pending')));
  });

  it('respects an explicit limit', async () => {
    db._setRows('inference_jobs', [job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]);
    expect(await svc.claimSiblings('p1', 2)).toHaveLength(2);
  });

  it("release 'defer' re-pends WITHOUT the claim's attempt", async () => {
    const a = job({ id: 'a', status: 'running', attempts: 1 });
    db._setRows('inference_jobs', [a]);
    await svc.releaseComboJobs(['a'], 'defer');
    expect(a.status).toBe('pending');
    expect(a.attempts).toBe(0);
  });

  it('release with an error keeps the attempt, and destroys a job at max attempts', async () => {
    const a = job({ id: 'a', status: 'running', attempts: 1 });
    const b = job({ id: 'b', status: 'running', attempts: 3 });
    db._setRows('inference_jobs', [a, b]);
    await svc.releaseComboJobs(['a', 'b'], { error: 'bad output' });
    expect(a.status).toBe('pending');
    expect(a.attempts).toBe(1);
    expect(a.errorMessage).toBe('bad output');
    expect(b.prepareDestroyPermanently).toHaveBeenCalled();
  });

  it('resumes after a kill: claimed (running) siblings come back as pending', async () => {
    const a = job({ id: 'a', status: 'running', attempts: 1 });
    const b = job({ id: 'b', status: 'running', attempts: 1 });
    db._setRows('inference_jobs', [a, b]);
    expect(await recoverCrashedJobs()).toBe(2);
    expect(a.status).toBe('pending');
    expect(b.status).toBe('pending');
  });
});

// ── The combo diff ─────────────────────────────────────────────────────────

describe('applyComboTopicsForFact', () => {
  function seed(opts: { topics: unknown[]; metadataTopics?: string[]; declined?: string[]; tracked?: string[] }) {
    const fact = makeRecord({ id: 'f1', metadata: { topics: opts.metadataTopics ?? [], topicGenError: ['x'] } });
    db._setRows('facts', [fact]);
    db._setRows('topics', opts.topics);
    db._setRows(
      'declined_topics',
      (opts.declined ?? []).map((d, i) => makeRecord({ id: `d${i}`, normalizedText: d })),
    );
    db._setRows(
      'tracked_stories',
      (opts.tracked ?? []).map((tid, i) => makeRecord({ id: `ts${i}`, topicId: tid })),
    );
    const j = job({ id: 'j1', status: 'running', attempts: 1 });
    db._setRows('inference_jobs', [j]);
    return { fact, j };
  }

  it('keeps a returned row in place (id, weight and signals survive)', async () => {
    const kept = topic({ id: 'keep', text: 'Dutch politics', normalizedText: 'dutch politics', weight: 0.9, lastSignalAt: 42 });
    seed({ topics: [kept], metadataTopics: ['Dutch politics'] });

    const res = await svc.applyComboTopicsForFact('f1', ['  DUTCH  politics '], 'j1');

    expect(res).toEqual({ kept: 1, inserted: 0, retired: 0, destroyed: 0 });
    expect(kept.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(kept.prepareUpdate).not.toHaveBeenCalled();
    expect(kept.weight).toBe(0.9);
    expect(db._collections.topics.prepareCreate).not.toHaveBeenCalled();
  });

  it('destroys a stale combo row, prunes it from metadata, and purges suggestions after', async () => {
    const stale = topic({ id: 'old', text: 'Old combo', normalizedText: 'old combo' });
    const { fact } = seed({ topics: [stale], metadataTopics: ['Old combo', 'Isolated one'] });

    const res = await svc.applyComboTopicsForFact('f1', [], 'j1');

    expect(res.destroyed).toBe(1);
    expect(stale.prepareDestroyPermanently).toHaveBeenCalled();
    // Table AND metadata in the same test: the two lists must move together.
    expect(fact.metadata.topics).toEqual(['Isolated one']);
    expect(fact.metadata.topicGenError).toEqual(['x']); // spread, not replaced
    expect(mockPurge).toHaveBeenCalledTimes(1);
  });

  it('RETIRES, never destroys, a stale combo row a tracked story points at', async () => {
    const guarded = topic({ id: 'tr', text: 'Followed combo', normalizedText: 'followed combo' });
    const { fact } = seed({ topics: [guarded], metadataTopics: ['Followed combo'], tracked: ['tr'] });

    const res = await svc.applyComboTopicsForFact('f1', [], 'j1');

    expect(res).toMatchObject({ retired: 1, destroyed: 0 });
    expect(guarded.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(guarded.status).toBe('retired');
    expect(fact.metadata.topics).toEqual([]);
    expect(mockPurge).not.toHaveBeenCalled(); // nothing destroyed
    const trackedQuery = JSON.stringify(db._collections.tracked_stories.query.mock.calls[0]);
    expect(trackedQuery).toContain('topic_id');
  });

  it('leaves a row staged for deletion alone, and never re-mints its text', async () => {
    const staged = topic({ id: 'st', text: 'Staged', normalizedText: 'staged', pendingDeleteAt: 1000 });
    seed({ topics: [staged] });

    const res = await svc.applyComboTopicsForFact('f1', ['Staged'], 'j1');

    expect(res).toEqual({ kept: 0, inserted: 0, retired: 0, destroyed: 0 });
    expect(staged.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(staged.prepareUpdate).not.toHaveBeenCalled();
    expect(db._collections.topics.prepareCreate).not.toHaveBeenCalled();
  });

  it('vetoes the FULL declined list, not the 50-row page', async () => {
    const declined = Array.from({ length: 60 }, (_, i) => `declined ${i}`);
    seed({ topics: [], declined });

    const res = await svc.applyComboTopicsForFact('f1', ['Declined 59', 'Fresh combo'], 'j1');

    expect(res.inserted).toBe(1);
    const created = db._collections.topics.prepareCreate.mock.results.map((r) => r.value);
    expect(created.map((c) => c.normalizedText)).toEqual(['fresh combo']);
  });

  it('vetoes every existing normalized text on the device, any fact, any provenance', async () => {
    const elsewhere = topic({ id: 'o', factId: 'f2', provenance: 'llm', text: 'Taken', normalizedText: 'taken' });
    seed({ topics: [elsewhere] });

    const res = await svc.applyComboTopicsForFact('f1', ['taken', 'New one', 'new ONE'], 'j1');

    expect(res.inserted).toBe(1);
    const [created] = db._collections.topics.prepareCreate.mock.results.map((r) => r.value);
    expect(created).toMatchObject({
      factId: 'f1',
      text: 'New one',
      normalizedText: 'new one',
      provenance: 'combo',
      status: 'active',
      highPriority: false,
      weight: DEFAULT_HARNESS_CONFIG.topicGen.topupTopicWeight,
    });
    expect(created.weight).toBeGreaterThan(0);
  });

  it('appends inserted texts to fact.metadata.topics in the same batch', async () => {
    const { fact } = seed({ topics: [], metadataTopics: ['Isolated one'] });
    await svc.applyComboTopicsForFact('f1', ['Brand new'], 'j1');
    expect(fact.metadata.topics).toEqual(['Isolated one', 'Brand new']);
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(batchedOps()).toContain(fact);
  });

  it('never touches a non-combo row of the same fact, returned or not', async () => {
    const llm = topic({ id: 'l', provenance: 'llm', text: 'Isolated', normalizedText: 'isolated' });
    const user = topic({ id: 'u', provenance: 'user', text: 'Mine', normalizedText: 'mine' });
    const { fact } = seed({ topics: [llm, user], metadataTopics: ['Isolated', 'Mine'] });

    const res = await svc.applyComboTopicsForFact('f1', ['Isolated'], 'j1');

    expect(res).toEqual({ kept: 0, inserted: 0, retired: 0, destroyed: 0 });
    for (const r of [llm, user]) {
      expect(r.prepareDestroyPermanently).not.toHaveBeenCalled();
      expect(r.prepareUpdate).not.toHaveBeenCalled();
    }
    expect(fact.metadata.topics).toEqual(['Isolated', 'Mine']);
  });

  it('leaves a stale combo row the user suppressed or down-ranked', async () => {
    const suppressed = topic({ id: 's', status: 'suppressed', text: 'Hidden', normalizedText: 'hidden' });
    const negative = topic({ id: 'n', weight: -0.4, text: 'Less', normalizedText: 'less' });
    seed({ topics: [suppressed, negative] });

    const res = await svc.applyComboTopicsForFact('f1', [], 'j1');

    expect(res.destroyed).toBe(0);
    expect(suppressed.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(negative.prepareDestroyPermanently).not.toHaveBeenCalled();
  });

  it('marks the job done in the SAME batch as the topic writes', async () => {
    const stale = topic({ id: 'old', normalizedText: 'old combo', text: 'Old combo' });
    const { j } = seed({ topics: [stale] });

    await svc.applyComboTopicsForFact('f1', ['Fresh'], 'j1');

    expect(db.write).toHaveBeenCalledTimes(1);
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(j.status).toBe('done');
    expect(batchedOps()).toEqual(expect.arrayContaining([j, stale]));
  });

  it('a deleted fact is a no-op that still marks the job done', async () => {
    const j = job({ id: 'j1', status: 'running', attempts: 1 });
    db._setRows('inference_jobs', [j]);
    db._setRows('facts', []);
    const orphan = topic({ id: 'o' });
    db._setRows('topics', [orphan]);

    const res = await svc.applyComboTopicsForFact('f1', ['Anything'], 'j1');

    expect(res).toEqual({ kept: 0, inserted: 0, retired: 0, destroyed: 0 });
    expect(j.status).toBe('done');
    expect(orphan.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(db._collections.topics.prepareCreate).not.toHaveBeenCalled();
  });

  it('still applies when the job row is already gone', async () => {
    seed({ topics: [] });
    db._setRows('inference_jobs', []);
    const res = await svc.applyComboTopicsForFact('f1', ['Fresh'], 'missing');
    expect(res.inserted).toBe(1);
  });
});

// ── Mode switch, flag, end of pass ────────────────────────────────────────

describe('dropPendingComboJobs', () => {
  it('destroys every pending topic_combo job and nothing else', async () => {
    const a = job({ id: 'a' });
    const b = job({ id: 'b', payload: { factId: 'f2', passId: 'p9' } });
    const running = job({ id: 'r', status: 'running' });
    const other = job({ id: 'o', jobType: 'topic_gen' });
    db._setRows('inference_jobs', [a, b, running, other]);

    expect(await svc.dropPendingComboJobs()).toBe(2);
    expect(a.prepareDestroyPermanently).toHaveBeenCalled();
    expect(b.prepareDestroyPermanently).toHaveBeenCalled();
    expect(running.prepareDestroyPermanently).not.toHaveBeenCalled();
    expect(other.prepareDestroyPermanently).not.toHaveBeenCalled();
  });
});

describe('precheckComboJob', () => {
  it('drops in on-device mode, read from the SETTING not the store', async () => {
    db._setRows('settings', [setting('mera_processing_mode', 'ON_DEVICE')]);
    expect(await svc.precheckComboJob()).toBe('drop');
  });

  it('defers while confirmed offline', async () => {
    mockIsConnected = false;
    expect(await svc.precheckComboJob()).toBe('defer');
  });

  it('defers without a local session credential', async () => {
    mockCookie = null;
    expect(await svc.precheckComboJob()).toBe('defer');
  });

  it('runs in cloud mode (absent setting = cloud) with network and credential', async () => {
    mockIsConnected = null; // not yet known is not offline
    expect(await svc.precheckComboJob()).toBe('run');
  });
});

describe('runPendingComboPass', () => {
  it('does nothing when the flag is not set', async () => {
    expect(await svc.runPendingComboPass()).toBe('none');
    expect(db.batch).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('cloud: enqueues one job per fact and wakes the queue', async () => {
    db._setRows('settings', [setting(svc.FACTS_COMBO_PENDING_KEY, '1')]);
    mockGetFacts.mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }]);

    expect(await svc.runPendingComboPass()).toBe('enqueued');
    expect(db._collections.inference_jobs.prepareCreate).toHaveBeenCalledTimes(2);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it('on-device: no pass, clears the flag and runs the end-of-pass refresh', async () => {
    const flag = setting(svc.FACTS_COMBO_PENDING_KEY, '1');
    db._setRows('settings', [flag, setting('mera_processing_mode', 'ON_DEVICE')]);
    mockGetFacts.mockResolvedValueOnce([{ id: 'f1' }]);

    expect(await svc.runPendingComboPass()).toBe('refreshed');
    expect(db._collections.inference_jobs.prepareCreate).not.toHaveBeenCalled();
    expect(flag.destroyPermanently).toHaveBeenCalled();
    expect(mockPrune).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('feed-sync');
  });
});

describe('finishComboPassIfDrained', () => {
  it('fires the end-of-pass refresh exactly once, when the last job settles', async () => {
    const a = job({ id: 'a', status: 'running' });
    db._setRows('inference_jobs', [a]);
    expect(await svc.finishComboPassIfDrained()).toBe(false);

    db._setRows('inference_jobs', []);
    const [first, second] = await Promise.all([
      svc.finishComboPassIfDrained(),
      svc.finishComboPassIfDrained(),
    ]);
    expect([first, second]).toContain(true);
    expect(mockPrune).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith('feed-sync');
  });

  it('counts only pending and running topic_combo jobs', async () => {
    db._setRows('inference_jobs', [job({ id: 'd', status: 'done' }), job({ id: 'g', jobType: 'topic_gen' })]);
    expect(await svc.finishComboPassIfDrained()).toBe(true);
  });
});

describe('pending flag', () => {
  it('markComboPending sets it, isComboPending reads it', async () => {
    expect(await svc.isComboPending()).toBe(false);
    await svc.markComboPending();
    expect(await svc.isComboPending()).toBe(true);
  });
});
