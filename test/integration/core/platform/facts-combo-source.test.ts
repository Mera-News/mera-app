/**
 * The count seam delegates to the data area's query and passes only CHANGES on, since the
 * controller acts on edges. Driven through the real combo-pass service on the in-memory DB.
 */
import {
  claimSiblings,
  dropPendingComboJobs,
  enqueueComboPass,
  releaseComboJobs,
} from '@/lib/database/services/combo-pass-service';
import { observeActiveComboJobCount } from '@/components/custom/toast/facts-combo-source';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

describe('observeActiveComboJobCount (toast seam)', () => {
  it('emits the live count of active combo jobs, dropping repeats', async () => {
    const seen: number[] = [];
    const sub = observeActiveComboJobCount().subscribe((n) => seen.push(n));
    await settle();
    expect(seen).toEqual([0]);

    const { passId, jobIds } = await enqueueComboPass(['fact-1', 'fact-2']);
    await settle();
    expect(seen).toEqual([0, 2]);

    // Pending -> running keeps the count at 2: not a change, so not emitted.
    const claimed = await claimSiblings(passId);
    expect(claimed.map((c) => c.jobId).sort()).toEqual([...jobIds].sort());
    await settle();
    expect(seen).toEqual([0, 2]);

    // Back to pending (count still 2), then the pending jobs are dropped: the count reaches 0.
    await releaseComboJobs(jobIds, { error: 'boom' });
    await settle();
    expect(seen).toEqual([0, 2]);
    expect(await dropPendingComboJobs()).toBe(2);
    await settle();
    expect(seen).toEqual([0, 2, 0]);

    sub.unsubscribe();
  });

  it('survives a relaunch: jobs already queued show on the first emission', async () => {
    await enqueueComboPass(['fact-1']);
    const seen: number[] = [];
    const sub = observeActiveComboJobCount().subscribe((n) => seen.push(n));
    await settle();
    expect(seen).toEqual([1]);
    sub.unsubscribe();
  });
});
