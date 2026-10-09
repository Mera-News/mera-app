// The combination pass's data side, on the in-memory database with the real job table, the real
// topic and fact services and the real AppScheduler (a stand-in `feed-sync` task is registered, as
// scheduler/core does for its synthetic tasks). The queue and the topic_combo handler are driven in
// combo-pass-queue.test.ts.
//
// Replaces combo-pass-service.test.ts (all 31 `it`): enqueue creates N jobs and clears the flag in
// ONE batch; supersede an earlier pass; mint a pass id; claim up to the limit of the same pass;
// explicit limit; release defer; release error + destroy at max attempts; resume after a kill; the
// combo diff (keep, destroy + prune + purge, retire a tracked topic, staged left alone, FULL
// declined list, every device text, metadata appended in one batch, non-combo untouched, suppressed
// or down-ranked left, job done in the same batch, deleted fact, job row gone); dropPendingComboJobs;
// precheck (drop from the SETTING, defer offline, defer without credential, run); runPendingComboPass
// (none, cloud enqueue, on-device refresh); finishComboPassIfDrained (once at the end, counts only
// combo jobs); the pending flag.
//
// Not carried over: "`db.batch` was called once" (replaced by a batch fault that leaves nothing
// behind), "`mockNotify` was called" (the queue is the real singleton, not started here; the chat
// area's queue tests own the wake), "`mockTrigger` was called with feed-sync" (the stand-in task is
// observed running), and "the claim query names job_type and status" (a mock-shaped assertion; the
// rows that are and are not claimed show it).
import { Q } from '@nozbe/watermelondb';

import { addFact, deleteFact } from '@/lib/database/services/fact-service';
import {
  COMBO_SIBLING_LIMIT,

  applyComboTopicsForFact,
  claimSiblings,
  countActiveComboJobs,
  dropPendingComboJobs,
  enqueueComboPass,
  finishComboPassIfDrained,
  isComboPending,
  markComboPending,
  observeActiveComboJobCount,
  precheckComboJob,
  readProcessingModeSetting,
  releaseComboJobs,
  runPendingComboPass,
} from '@/lib/database/services/combo-pass-service';
import { enqueueJob, recoverCrashedJobs } from '@/lib/database/services/inference-job-service';
import { setSetting } from '@/lib/database/services/setting-service';
import { deleteTopicWithDecline, recordDecline } from '@/lib/database/services/topic-decline-service';
import { createTopics, getByFact } from '@/lib/database/services/topic-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import { signInFixtureAccount, useFakeClock, useStrictClock } from '@/test/helpers';
import { DEFAULT_HARNESS_CONFIG } from '@/lib/news-harness/core/config';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useNetworkStore } from '@/lib/stores/network-store';

import {
  cleanupTopics,
  collect,
  countRows,
  drive,
  failBatchWhere,
  jobById,
  jobRows,
  metadataOf,
  persistedMetadataTopics,
  resetTopicsMemory,
  seedFact,
  seedSuggestion,
  seedTopics,
  suggestionIds,
  until,
} from './support';

// ---- the stand-in feed-sync task ------------------------------------------------------------

const feedSync = { started: 0, finished: 0, gate: null as Promise<void> | null };

beforeAll(() => {
  AppScheduler.register({
    name: 'feed-sync',
    displayName: 'feed-sync (stand-in)',
    frequency: 0,
    handler: async () => {
      feedSync.started += 1;
      await feedSync.gate;
      feedSync.finished += 1;
    },
  });
});

beforeEach(() => {
  resetTopicsMemory();
  AppScheduler.dispose(); // forgets the trigger debounce
  feedSync.started = 0;
  feedSync.finished = 0;
  feedSync.gate = null;
});
afterEach(cleanupTopics);

/** The stand-in ran `n` times AND the scheduler wrote each run's completed row, so nothing is left to land in the next test's database. */
async function settleFeedSync(n: number): Promise<void> {
  await until(
    async () => feedSync.finished === n && (await countRows('scheduler_jobs', Q.where('status', 'completed'))) === n,
    `${n} completed feed sync(s)`,
  );
}

const COMBO_WEIGHT = DEFAULT_HARNESS_CONFIG.topicGen.topupTopicWeight;
const factIds = async (n: number) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push((await addFact(`Fact number ${i}`)).id);
  return out;
};
const byStatus = async (status: string) => (await jobRows('topic_combo')).filter((j) => j.status === status);

// ---- enqueue ----------------------------------------------------------------------------------

describe('enqueueComboPass', () => {
  it('creates one pending job per distinct fact (payload { factId, passId } only) AND clears the pending flag', async () => {
    await markComboPending();
    expect(await isComboPending()).toBe(true);

    const { passId, jobIds } = await enqueueComboPass(['f1', 'f2', 'f1', ''], 'pass-x');

    expect(passId).toBe('pass-x');
    const rows = await jobRows('topic_combo');
    expect(rows.map((r) => r.id).sort()).toEqual([...jobIds].sort());
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ status: 'pending', priority: 15, attempts: 0, maxAttempts: 3 });
      expect(Object.keys(r.payload).sort()).toEqual(['factId', 'passId']);
      expect(r.payload.passId).toBe('pass-x');
    }
    expect(rows.map((r) => r.payload.factId).sort()).toEqual(['f1', 'f2']);
    expect(await isComboPending()).toBe(false);
  });

  it('is ONE batch: when the flag cannot be cleared, no job is created either', async () => {
    await markComboPending();
    failBatchWhere((op) => op.table === 'settings' && op.state === 'destroyPermanently');

    await expect(enqueueComboPass(['f1', 'f2'], 'p1')).rejects.toThrow('batch failed (injected)');

    expect(await countRows('inference_jobs')).toBe(0);
    expect(await isComboPending()).toBe(true);
  });

  it('supersedes an earlier pass: its PENDING jobs are destroyed, its running job and other job types are left', async () => {
    await enqueueComboPass(['a', 'b', 'c'], 'p0');
    const [running] = await claimSiblings('p0', 1);
    const other = await enqueueJob('topic_gen', { factId: 'g1' });

    const { jobIds } = await enqueueComboPass(['x'], 'p1');

    const combo = await jobRows('topic_combo');
    expect(combo.map((j) => [j.id, j.status]).sort()).toEqual(
      [
        [running.jobId, 'running'],
        [jobIds[0], 'pending'],
      ].sort(),
    );
    expect((await jobRows('topic_gen')).map((j) => j.id)).toEqual([other]);
  });

  it('supersedes in the SAME batch as the creates: a failing create leaves the old pass whole', async () => {
    await enqueueComboPass(['a', 'b'], 'p0');
    failBatchWhere((op) => op.table === 'inference_jobs' && op.state === 'create');

    await expect(enqueueComboPass(['x'], 'p1')).rejects.toThrow('batch failed (injected)');

    expect((await byStatus('pending')).map((j) => j.payload.passId)).toEqual(['p0', 'p0']);
  });

  it('mints a pass id when none is given, a new one each time', async () => {
    const a = await enqueueComboPass(['f1']);
    const b = await enqueueComboPass(['f1']);
    expect(a.passId).toMatch(/^combo-/);
    expect(a.passId).not.toBe(b.passId);
  });
});

// ---- siblings ---------------------------------------------------------------------------------

describe('claimSiblings / releaseComboJobs', () => {
  it(`claims up to ${COMBO_SIBLING_LIMIT} PENDING jobs of the pass, marking them running with an attempt counted`, async () => {
    await enqueueComboPass(Array.from({ length: 10 }, (_, i) => `f${i}`), 'p1');

    const claimed = await claimSiblings('p1');

    expect(COMBO_SIBLING_LIMIT).toBe(8);
    expect(claimed).toHaveLength(8);
    expect(new Set(claimed.map((c) => c.factId)).size).toBe(8);
    const running = await byStatus('running');
    expect(running.map((j) => j.id).sort()).toEqual(claimed.map((c) => c.jobId).sort());
    expect(running.every((j) => j.attempts === 1)).toBe(true);
    const pending = await byStatus('pending');
    expect(pending).toHaveLength(2);
    expect(pending.every((j) => j.attempts === 0)).toBe(true);
    // Each job is claimed once.
    expect(await claimSiblings('p1')).toHaveLength(2);
    expect(await claimSiblings('p1')).toEqual([]);
  });

  it('claims only the SAME pass, only combo jobs, and respects an explicit limit', async () => {
    await enqueueComboPass(['f1', 'f2', 'f3'], 'p1');
    const otherPass = await enqueueJob('topic_combo', { factId: 'fx', passId: 'p2' });
    const otherType = await enqueueJob('topic_gen', { factId: 'f1' });

    expect(await claimSiblings('p1', 0)).toEqual([]);
    const claimed = await claimSiblings('p1', 2);

    expect(claimed).toHaveLength(2);
    expect(claimed.every((c) => ['f1', 'f2', 'f3'].includes(c.factId))).toBe(true);
    expect((await jobRows()).find((j) => j.id === otherPass)).toMatchObject({ status: 'pending', attempts: 0 });
    expect((await jobRows()).find((j) => j.id === otherType)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it("release 'defer' re-pends the job WITHOUT the attempt the claim took", async () => {
    await enqueueComboPass(['f1'], 'p1');
    const [c] = await claimSiblings('p1');
    expect((await jobById(c.jobId))!.attempts).toBe(1);

    await releaseComboJobs([c.jobId], 'defer');

    expect(await jobById(c.jobId)).toMatchObject({ status: 'pending', attempts: 0, errorMessage: 'deferred' });
  });

  it('release with an error keeps the attempt and re-pends, and destroys the job once its attempts are spent', async () => {
    await enqueueComboPass(['f1'], 'p1');

    for (let attempt = 1; attempt <= 2; attempt++) {
      const [c] = await claimSiblings('p1');
      await releaseComboJobs([c.jobId], { error: 'bad output' });
      expect(await jobById(c.jobId)).toMatchObject({ status: 'pending', attempts: attempt, errorMessage: 'bad output' });
    }
    const [last] = await claimSiblings('p1'); // the third and final attempt
    await releaseComboJobs([last.jobId], { error: 'bad output' });

    expect(await jobById(last.jobId)).toBeUndefined();
  });

  it('release ignores a job that is not running, and an empty list', async () => {
    const { jobIds } = await enqueueComboPass(['f1'], 'p1');

    await releaseComboJobs([jobIds[0]], 'defer');
    await releaseComboJobs([], 'defer');

    expect(await jobById(jobIds[0])).toMatchObject({ status: 'pending', attempts: 0, errorMessage: null });
  });

  it('resumes after a kill: claimed (running) siblings come back as pending', async () => {
    await enqueueComboPass(['f1', 'f2'], 'p1');
    await claimSiblings('p1');

    expect(await recoverCrashedJobs()).toBe(2);

    expect((await byStatus('pending')).length).toBe(2);
    expect(await countActiveComboJobs()).toBe(2);
  });
});

describe('dropPendingComboJobs', () => {
  it('destroys every PENDING topic_combo job (any pass) and nothing else', async () => {
    await enqueueComboPass(['f1', 'f2'], 'p1');
    const [running] = await claimSiblings('p1', 1);
    await enqueueJob('topic_combo', { factId: 'f9', passId: 'p9' });
    const other = await enqueueJob('topic_gen', { factId: 'f1' });

    expect(await dropPendingComboJobs()).toBe(2);

    expect((await jobRows('topic_combo')).map((j) => j.id)).toEqual([running.jobId]);
    expect((await jobRows('topic_gen')).map((j) => j.id)).toEqual([other]);
    expect(await dropPendingComboJobs()).toBe(0);
  });
});

// ---- the pending flag and the mode setting ----------------------------------------------------

describe('the pending flag and the mode setting', () => {
  it('markComboPending sets the flag, isComboPending reads it', async () => {
    expect(await isComboPending()).toBe(false);
    await markComboPending();
    expect(await isComboPending()).toBe(true);
  });

  it('readProcessingModeSetting: absent or unrecognised means cloud', async () => {
    expect(await readProcessingModeSetting()).toBe(ProcessingMode.Cloud);
    await setSetting('mera_processing_mode', 'SOMETHING_ELSE');
    expect(await readProcessingModeSetting()).toBe(ProcessingMode.Cloud);
    await setSetting('mera_processing_mode', 'ON_DEVICE');
    expect(await readProcessingModeSetting()).toBe(ProcessingMode.OnDevice);
  });
});

// ---- precheck ---------------------------------------------------------------------------------

describe('precheckComboJob', () => {
  it('defers without a local session credential (signed out)', async () => {
    expect(await precheckComboJob()).toBe('defer');
  });

  describe('signed in', () => {
    beforeEach(async () => {
      await signInFixtureAccount();
    });

    it('runs in cloud mode (absent setting = cloud) when connected', async () => {
      expect(await precheckComboJob()).toBe('run');
    });

    it('a connection not yet known is not offline', async () => {
      useNetworkStore.setState({ isConnected: null as unknown as boolean });
      expect(await precheckComboJob()).toBe('run');
    });

    it('defers while the device is confirmed offline', async () => {
      useNetworkStore.setState({ isConnected: false });
      expect(await precheckComboJob()).toBe('defer');
    });

    it('drops the pass on ON_DEVICE, read from the SETTING and not the store (the store still holds its cloud default)', async () => {
      useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
      await setSetting('mera_processing_mode', 'ON_DEVICE');

      expect(await precheckComboJob()).toBe('drop');
    });

    it('does not drop on the store alone: an on-device store with no on-device setting still runs', async () => {
      useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });

      expect(await precheckComboJob()).toBe('run');
    });

    it('the mode is checked before the connection: on-device + offline drops, it does not defer', async () => {
      await setSetting('mera_processing_mode', 'ON_DEVICE');
      useNetworkStore.setState({ isConnected: false });

      expect(await precheckComboJob()).toBe('drop');
    });
  });
});

// ---- runPendingComboPass ----------------------------------------------------------------------

describe('runPendingComboPass', () => {
  it("does nothing ('none') when the flag is not set", async () => {
    await addFact('Follows chess');

    expect(await runPendingComboPass()).toBe('none');
    expect(await jobRows()).toEqual([]);
    expect(feedSync.started).toBe(0);
  });

  it("cloud: 'enqueued', one job per fact, and the flag is spent", async () => {
    const ids = await factIds(2);
    await markComboPending();

    expect(await runPendingComboPass()).toBe('enqueued');

    expect((await jobRows('topic_combo')).map((j) => j.payload.factId).sort()).toEqual([...ids].sort());
    expect(await isComboPending()).toBe(false);
    expect(feedSync.started).toBe(0); // the pass has not ended
  });

  it("on-device: 'refreshed' with no pass, the flag cleared, suggestions pruned and a feed sync fired", async () => {
    await factIds(1);
    await markComboPending();
    await setSetting('mera_processing_mode', 'ON_DEVICE');
    markStoreSuggestion();

    expect(await runPendingComboPass()).toBe('refreshed');

    expect(await jobRows()).toEqual([]);
    expect(await isComboPending()).toBe(false);
    await settleFeedSync(1);
    expect(useForYouStore.getState().suggestions).toEqual([]);
  });

  it("cloud with no facts left: 'refreshed' too", async () => {
    await markComboPending();

    expect(await runPendingComboPass()).toBe('refreshed');

    expect(await jobRows()).toEqual([]);
    expect(await isComboPending()).toBe(false);
    await settleFeedSync(1);
  });
});

/** A marker row in the feed store: `pruneOrphanedData` with no topics anywhere clears the store. */
function markStoreSuggestion() {
  useForYouStore.setState({ suggestions: [{ _id: 'marker' } as never], articleCount: 7 });
}

// ---- finishComboPassIfDrained -----------------------------------------------------------------

describe('finishComboPassIfDrained', () => {
  it('is false while a combo job is pending or running, and refreshes nothing', async () => {
    await enqueueComboPass(['f1', 'f2'], 'p1');
    await claimSiblings('p1', 1);
    markStoreSuggestion();

    expect(await finishComboPassIfDrained()).toBe(false);

    expect(useForYouStore.getState().suggestions).toHaveLength(1);
    expect(feedSync.started).toBe(0);
  });

  it('counts only pending and running topic_combo jobs', async () => {
    await enqueueComboPass(['f1'], 'p1');
    const [c] = await claimSiblings('p1');
    await applyComboTopicsForFact('f1', [], c.jobId); // the job is now done
    await enqueueJob('topic_gen', { factId: 'f1' });

    expect(await finishComboPassIfDrained()).toBe(true);
    await settleFeedSync(1);
  });

  it('at the end of the pass: prunes orphaned suggestions and FIRES a feed sync, once even for two concurrent callers', async () => {
    markStoreSuggestion();

    const [first, second] = await Promise.all([finishComboPassIfDrained(), finishComboPassIfDrained()]);

    expect([first, second]).toContain(true);
    // pruneOrphanedData found no topic anywhere and cleared the store
    expect(useForYouStore.getState().suggestions).toEqual([]);
    await settleFeedSync(1);
    expect(feedSync.started).toBe(1);
  });

  it('does not AWAIT the feed sync: it resolves while the sync is still running', async () => {
    let release!: () => void;
    feedSync.gate = new Promise<void>((resolve) => (release = resolve));

    await expect(finishComboPassIfDrained()).resolves.toBe(true);

    await until(() => feedSync.started === 1, 'the feed sync to start');
    expect(feedSync.finished).toBe(0);
    release();
    await settleFeedSync(1);
  });
});

// ---- observeActiveComboJobCount (the toast) -----------------------------------------------------

describe('observeActiveComboJobCount', () => {
  it('counts pending and running combo jobs live', async () => {
    const feed = collect(observeActiveComboJobCount());
    await until(() => feed.seen.length >= 1, 'first count');
    expect(feed.seen.at(-1)).toBe(0);

    await enqueueComboPass(['f1', 'f2'], 'p1');
    await until(() => feed.seen.at(-1) === 2, 'two active');
    feed.stop();
  });

  it('reaches 0 after back-to-back status updates inside 250 ms (the unthrottled count)', async () => {
    const ids = await factIds(3);
    await enqueueComboPass(ids, 'p1');
    const claimed = await claimSiblings('p1');
    useStrictClock(Date.now());
    const feed = collect(observeActiveComboJobCount());
    await drive(Promise.resolve());
    for (let i = 0; i < 20 && feed.seen.length === 0; i++) await drive(Promise.resolve());
    expect(feed.seen).toEqual([3]);
    const startedAt = Date.now();

    // A queue marking siblings done, one write after another.
    for (const c of claimed) await drive(applyComboTopicsForFact(c.factId, [], c.jobId));

    // The precondition that makes this test able to fail: every write landed inside the 250 ms
    // window a throttled count would have dropped them in.
    expect(Date.now() - startedAt).toBeLessThan(250);
    // No further time is needed for the count to settle; a throttled count stays stale for good.
    await jest.advanceTimersByTimeAsync(5_000);
    await drive(Promise.resolve());
    expect(feed.seen.at(-1)).toBe(0);
    feed.stop();
  });
});

// ---- the combo diff ---------------------------------------------------------------------------

describe('applyComboTopicsForFact', () => {
  /** A fact, its isolated topic(s) and the combo job a queue would have claimed for it. */
  async function world(opts: { metadata?: Record<string, string[]>; isolated?: string[] } = {}) {
    const fact = await addFact('Works as a nurse in Porto', opts.metadata);
    const isolated = await seedTopics(fact.id, opts.isolated ?? []);
    await enqueueComboPass([fact.id], 'p1');
    const [claimed] = await claimSiblings('p1');
    return { fact, isolated, jobId: claimed.jobId };
  }
  const combo = async (factId: string) => (await getByFact(factId)).filter((t) => t.provenance === 'combo');

  it('keeps a returned row in place: same id, weight and signals; the job is marked done with the result', async () => {
    const { fact, jobId } = await world();
    const [kept] = await createTopics([
      { factId: fact.id, text: 'Dutch politics', weight: 0.9, provenance: 'combo', lastSignalAt: 42 },
    ]);

    const res = await applyComboTopicsForFact(fact.id, ['  DUTCH  politics '], jobId);

    expect(res).toEqual({ kept: 1, inserted: 0, retired: 0, destroyed: 0 });
    const rows = await combo(fact.id);
    expect(rows.map((r) => r.id)).toEqual([kept.id]);
    expect(rows[0]).toMatchObject({ weight: 0.9, lastSignalAt: 42, status: 'active' });
    expect(await metadataOf(fact.id)).toEqual({ topics: ['Dutch politics'] });
    expect(await jobById(jobId)).toMatchObject({ status: 'done', result: { kept: 1, inserted: 0, retired: 0, destroyed: 0 } });
  });

  it('destroys a stale combo row, prunes it from the metadata list, and purges the suggestions only it retrieved', async () => {
    const { fact, isolated, jobId } = await world({
      metadata: { topics: [], topicGenError: ['x'] },
      isolated: ['Isolated one'],
    });
    const [stale] = await createTopics([{ factId: fact.id, text: 'Old combo', weight: 0.5, provenance: 'combo' }]);
    await seedSuggestion('s-stale', stale);
    await seedSuggestion('s-isolated', isolated[0]);

    const res = await applyComboTopicsForFact(fact.id, [], jobId);

    expect(res).toMatchObject({ destroyed: 1, kept: 0, inserted: 0 });
    // The table AND the metadata list, in one test: the two readers must move together.
    expect((await getByFact(fact.id)).map((t) => t.text)).toEqual(['Isolated one']);
    expect(await metadataOf(fact.id)).toEqual({ topics: ['Isolated one'], topicGenError: ['x'] });
    expect(await suggestionIds()).toEqual(['s-isolated']);
  });

  it('RETIRES, never destroys, a stale combo row a tracked story points at', async () => {
    const { fact, jobId } = await world();
    const [guarded] = await createTopics([{ factId: fact.id, text: 'Followed combo', weight: 0.5, provenance: 'combo' }]);
    await trackStory({ articleId: 'a1', title: 'Followed', originSurface: 'feed', topicId: guarded.id, topicText: 'Followed combo' });
    await seedSuggestion('s-guarded', guarded);

    const res = await applyComboTopicsForFact(fact.id, [], jobId);

    expect(res).toMatchObject({ retired: 1, destroyed: 0 });
    const rows = await getByFact(fact.id);
    expect(rows.map((r) => [r.id, r.status])).toEqual([[guarded.id, 'retired']]);
    expect((await metadataOf(fact.id)).topics).toEqual([]);
    expect(await suggestionIds()).toEqual(['s-guarded']); // nothing was destroyed, so nothing was purged
  });

  it('destroys one stale row and retires the tracked one in the same diff', async () => {
    const { fact, jobId } = await world();
    const [tracked, plain] = await createTopics([
      { factId: fact.id, text: 'Followed combo', weight: 0.5, provenance: 'combo' },
      { factId: fact.id, text: 'Plain combo', weight: 0.5, provenance: 'combo' },
    ]);
    await trackStory({ articleId: 'a1', title: 'Followed', originSurface: 'feed', topicId: tracked.id, topicText: 'Followed combo' });

    const res = await applyComboTopicsForFact(fact.id, [], jobId);

    expect(res).toMatchObject({ retired: 1, destroyed: 1 });
    expect((await getByFact(fact.id)).map((r) => [r.id, r.status])).toEqual([[tracked.id, 'retired']]);
    expect(plain.id).not.toBe(tracked.id);
  });

  it('leaves a row staged for deletion alone and never re-mints its text', async () => {
    const { fact, jobId } = await world();
    const [staged] = await createTopics([{ factId: fact.id, text: 'Staged', weight: 0.5, provenance: 'combo' }]);
    await deleteTopicWithDecline(staged.id);

    const res = await applyComboTopicsForFact(fact.id, ['Staged'], jobId);

    expect(res).toEqual({ kept: 0, inserted: 0, retired: 0, destroyed: 0 });
    const rows = await getByFact(fact.id);
    expect(rows.map((r) => r.id)).toEqual([staged.id]);
    expect(rows[0].pendingDeleteAt).not.toBeNull();
  });

  it('vetoes the FULL declined list, not the 50-row prompt page', async () => {
    const { fact, jobId } = await world();
    useFakeClock('2026-01-01T00:00:00Z');
    for (let i = 0; i < 60; i++) {
      jest.setSystemTime(Date.parse('2026-01-01T00:00:00Z') + i * 1_000);
      await recordDecline(`Declined ${i}`, null);
    }

    // "Declined 0" is the 60th newest: outside any 50-row page.
    const res = await applyComboTopicsForFact(fact.id, ['Declined 0', 'Declined 59', 'Fresh combo'], jobId);

    expect(res.inserted).toBe(1);
    expect((await combo(fact.id)).map((t) => t.text)).toEqual(['Fresh combo']);
  });

  it('vetoes every normalized text on the device (any fact, any provenance) and inserts the rest with the combo seed', async () => {
    const { fact, jobId } = await world();
    await seedFact('Lives in Amsterdam', [{ text: 'Taken', provenance: 'llm' }]);

    const res = await applyComboTopicsForFact(fact.id, ['taken', 'New   one', 'new ONE'], jobId);

    expect(res.inserted).toBe(1);
    const [created] = await combo(fact.id);
    expect(created).toMatchObject({
      factId: fact.id,
      text: 'New one',
      normalizedText: 'new one',
      provenance: 'combo',
      status: 'active',
      highPriority: false,
      locationId: null,
      lastSignalAt: null,
      weight: COMBO_WEIGHT,
    });
    // Never 0: a topic the retrieval profile silently never asks about.
    expect(created.weight).toBeGreaterThan(0);
  });

  it('moves fact.metadata.topics in the same batch: appended texts land beside the isolated ones', async () => {
    const { fact, jobId } = await world({ metadata: { topics: ['Isolated one'] }, isolated: ['Isolated one'] });

    await applyComboTopicsForFact(fact.id, ['Brand new'], jobId);

    expect((await combo(fact.id)).map((t) => t.text)).toEqual(['Brand new']);
    expect(await metadataOf(fact.id)).toEqual({ topics: ['Isolated one', 'Brand new'] });
  });

  it('is ONE write with the job marked done: a failing fact write leaves topics, metadata and job as they were', async () => {
    const { fact, jobId } = await world({ metadata: { topics: ['Isolated one'] } });
    const [stale] = await createTopics([{ factId: fact.id, text: 'Old combo', weight: 0.5, provenance: 'combo' }]);
    failBatchWhere((op) => op.table === 'facts');

    await expect(applyComboTopicsForFact(fact.id, ['Brand new'], jobId)).rejects.toThrow('batch failed (injected)');

    expect(await countRows('topics', Q.where('text', 'Brand new'))).toBe(0);
    expect(await countRows('topics', Q.where('id', stale.id))).toBe(1);
    expect(await countRows('inference_jobs', Q.where('status', 'done'))).toBe(0);
  });

  it('is ONE write with the job marked done: a failing job write leaves the topics and metadata as they were', async () => {
    const { fact, jobId } = await world({ metadata: { topics: ['Isolated one'] } });
    failBatchWhere((op) => op.table === 'inference_jobs' && op.raw.status === 'done');

    await expect(applyComboTopicsForFact(fact.id, ['Brand new'], jobId)).rejects.toThrow('batch failed (injected)');

    expect(await countRows('topics')).toBe(0);
    expect(await persistedMetadataTopics(fact.id)).toEqual(['Isolated one']);
  });

  it('never touches a non-combo row of the same fact, returned or not', async () => {
    const { fact, jobId } = await world({ metadata: { topics: ['Isolated', 'Mine'] } });
    const [llm, user] = await createTopics([
      { factId: fact.id, text: 'Isolated', weight: 0.75, provenance: 'llm' },
      { factId: fact.id, text: 'Mine', weight: 0.75, provenance: 'user' },
    ]);

    const res = await applyComboTopicsForFact(fact.id, ['Isolated'], jobId);

    expect(res).toEqual({ kept: 0, inserted: 0, retired: 0, destroyed: 0 });
    expect((await getByFact(fact.id)).map((r) => [r.id, r.status, r.weight]).sort()).toEqual(
      [
        [llm.id, 'active', 0.75],
        [user.id, 'active', 0.75],
      ].sort(),
    );
    expect((await metadataOf(fact.id)).topics).toEqual(['Isolated', 'Mine']);
  });

  it('leaves a stale combo row the user suppressed or down-ranked', async () => {
    const { fact, jobId } = await world();
    const [suppressed, negative] = await createTopics([
      { factId: fact.id, text: 'Hidden', weight: 0.5, provenance: 'combo', status: 'suppressed' },
      { factId: fact.id, text: 'Less', weight: -0.4, provenance: 'combo' },
    ]);

    const res = await applyComboTopicsForFact(fact.id, [], jobId);

    expect(res.destroyed).toBe(0);
    expect((await getByFact(fact.id)).map((r) => r.id).sort()).toEqual([suppressed.id, negative.id].sort());
  });

  it('reads the returned list once: blanks dropped, spacing folded, a repeat keeps the first spelling', async () => {
    const { fact, jobId } = await world();

    const res = await applyComboTopicsForFact(fact.id, ['', '  ', 'Dutch  politics', 'dutch POLITICS'], jobId);

    expect(res.inserted).toBe(1);
    expect((await combo(fact.id)).map((t) => t.text)).toEqual(['Dutch politics']);
  });

  it('a deleted fact is a no-op that still marks the job done', async () => {
    const { fact, jobId } = await world();
    await deleteFact(fact.id);

    const res = await applyComboTopicsForFact(fact.id, ['Anything'], jobId);

    expect(res).toEqual({ kept: 0, inserted: 0, retired: 0, destroyed: 0 });
    expect(await jobById(jobId)).toMatchObject({ status: 'done' });
    expect(await countRows('topics')).toBe(0);
  });

  it('still applies when the job row is already gone', async () => {
    const { fact } = await world();

    const res = await applyComboTopicsForFact(fact.id, ['Fresh'], 'missing-job');

    expect(res.inserted).toBe(1);
  });
});
