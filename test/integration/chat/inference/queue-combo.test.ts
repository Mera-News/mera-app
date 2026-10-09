// topic_combo through the queue: the pre-check (defer / drop), a deferral that gives the attempt
// back and gates the TYPE, the end-of-pass check, and onDrain ignoring combo work. Real
// `combo-pass-service` over real rows; the handler is the queue's seam except in the last test,
// which runs the real handler against the gateway mock.
//
// Replaces the "topic_combo: pre-check, defer, drop, end of pass" describe of
// lib/inference/__tests__/InferenceQueue.test.ts (all 12 `it`): pre-check defer; post-run 503;
// offline defer; ordinary failure; the gate lifts after the backoff / at a foreground; the gate
// expires on its own; mode switched to on-device drops the pass; a completed job gets its own id;
// wired to the real handler; a non-combo job never runs the combo checks; onDrain ignores combo
// jobs; onDrain waits while non-combo work remains.
import * as comboPass from '@/lib/database/services/combo-pass-service';
import { enqueueComboPass } from '@/lib/database/services/combo-pass-service';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { COMBO_PASS_TOPIC_SYSTEM_PROMPT } from '@/lib/news-harness/prompts/persona-prompts';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useNetworkStore } from '@/lib/stores/network-store';
import { gatewayCalls, mockGateway, server, setAppState } from '@/test/helpers';
import { seedFacts } from '@/test/integration/chat/_helpers';
import {
  cleanup,
  driveUntil,
  enqueueJob,
  hold,
  jobRow,
  jobRows,
  prepare,
  tick,
  turns,
  untilJob,
  watchBodies,
  setMode,
} from './kit';

beforeEach(async () => {
  comboPass.__resetComboPassForTests();
  await prepare();
});
afterEach(async () => {
  setAppState('active');
  await cleanup();
});

/** Spies the end-of-pass refresh: `runEndOfPassRefresh` ends by firing a feed sync. */
function watchRefresh() {
  return jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('ran' as never);
}

/** One combo job per fact id, as the Profile chat's close does. Handler-seam tests need no real facts. */
async function pass(...factIds: string[]): Promise<string[]> {
  return (await enqueueComboPass(factIds)).jobIds;
}

const OFFLINE = () => useNetworkStore.getState().setIsConnected(false);
const ONLINE = () => useNetworkStore.getState().setIsConnected(true);
const deferrable = () => new Error('E2EE batch failed: 503 Service Unavailable');

describe('the pre-check defers without spending an attempt', () => {
  it('offline: no handler, no attempt, and the TYPE is gated so lower-priority work still runs', async () => {
    OFFLINE();
    const combo = jest.fn(async () => ({}));
    __setJobHandlerForTests('topic_combo', combo);
    const summary = jest.fn(async () => ({}));
    __setJobHandlerForTests('persona_summary', summary);
    const [a, b] = await pass('f1', 'f2');
    const behind = await enqueueJob('persona_summary', {});

    await inferenceQueue.start();
    await untilJob(behind, ['done']);

    // Priority 15 sits ahead of 20: only the type gate lets the summary job through.
    expect(summary).toHaveBeenCalledTimes(1);
    expect(combo).not.toHaveBeenCalled();
    expect(await jobRow(a)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await jobRow(b)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('the gate holds after the network is back, lifts at a foreground, and the pass then runs', async () => {
    OFFLINE();
    const combo = jest.fn(async () => ({}));
    __setJobHandlerForTests('topic_combo', combo);
    const [a] = await pass('f1');
    await inferenceQueue.start();
    await tick(500);
    expect(await jobRow(a)).toMatchObject({ status: 'pending', attempts: 0 });

    ONLINE();
    await tick(10_000);
    expect(combo).not.toHaveBeenCalled();

    setAppState('active');
    await untilJob(a, ['done'], 500);
    expect(combo).toHaveBeenCalledTimes(1);
  });

  it('the gate expires on its own after the 30 s backoff', async () => {
    OFFLINE();
    const combo = jest.fn(async () => ({}));
    __setJobHandlerForTests('topic_combo', combo);
    const [a] = await pass('f1');
    await inferenceQueue.start();
    await tick(500);
    ONLINE();

    await tick(28_000);
    expect(combo).not.toHaveBeenCalled();

    await untilJob(a, ['done'], 35_000);
    expect(combo).toHaveBeenCalledTimes(1);
  });
});

describe('a combo job that fails while running', () => {
  it('a deferrable error re-pends it with the attempt given back, and the next try waits 30 s, then 60 s', async () => {
    const combo = jest.fn(async () => {
      throw deferrable();
    });
    __setJobHandlerForTests('topic_combo', combo);
    const refresh = watchRefresh();
    const [a] = await pass('f1');

    await inferenceQueue.start();
    await driveUntil(() => combo.mock.calls.length === 1, 'first run');
    await tick(100);

    expect(await jobRow(a)).toMatchObject({ status: 'pending', attempts: 0, errorMessage: expect.stringContaining('503') });
    // A deferral is not the end of the pass.
    expect(refresh).not.toHaveBeenCalled();

    await tick(20_000);
    expect(combo).toHaveBeenCalledTimes(1);
    await driveUntil(() => combo.mock.calls.length === 2, 'second run', 20_000);

    // The second deferral gates for 60 s, measured from the second failure.
    const secondRunAt = Date.now();
    await tick(55_000);
    expect(combo).toHaveBeenCalledTimes(2);
    await driveUntil(() => combo.mock.calls.length === 3, 'third run', 40_000);
    expect(Date.now() - secondRunAt).toBeGreaterThanOrEqual(60_000);
    expect((await jobRow(a))?.attempts).toBe(0);
  });

  it('a transport failure while the device is confirmed offline defers too', async () => {
    const combo = jest.fn(async () => {
      OFFLINE();
      throw new Error('Network request failed');
    });
    __setJobHandlerForTests('topic_combo', combo);
    const [a] = await pass('f1');

    await inferenceQueue.start();
    await driveUntil(() => combo.mock.calls.length === 1, 'run');
    await tick(100);

    expect(await jobRow(a)).toMatchObject({ status: 'pending', attempts: 0, errorMessage: 'Network request failed' });
    await tick(10_000);
    expect(combo).toHaveBeenCalledTimes(1);
  });

  it('an ordinary failure spends the attempt, is retried at once, and the pass ends only when the job is gone', async () => {
    const refresh = watchRefresh();
    const parked = hold();
    let calls = 0;
    const combo = jest.fn(async (..._args: unknown[]) => {
      if (++calls === 1) throw new Error('parse error');
      return parked.handler();
    });
    __setJobHandlerForTests('topic_combo', combo);
    const [a] = await pass('f1');

    await inferenceQueue.start();
    await parked.started;

    expect(await jobRow(a)).toMatchObject({ status: 'running', attempts: 2, errorMessage: 'parse error' });
    expect(refresh).not.toHaveBeenCalled();

    parked.release();
    await untilJob(a, ['done']);
    await tick(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('feed-sync');
  });

  it('a job that fails until its attempts run out is destroyed and ends the pass', async () => {
    const refresh = watchRefresh();
    const combo = jest.fn(async () => {
      throw new Error('parse error');
    });
    __setJobHandlerForTests('topic_combo', combo);
    const [a] = await pass('f1');

    await inferenceQueue.start();
    await untilJob(a, ['gone']);
    await tick(0);

    expect(combo).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('a combo job that completes', () => {
  it('gets its own job id, and the end-of-pass refresh runs once, after the LAST job', async () => {
    const refresh = watchRefresh();
    const seen: unknown[][] = [];
    const parked = hold();
    const combo = jest.fn(async (...args: unknown[]) => {
      seen.push(args);
      return seen.length === 2 ? parked.handler() : { applied: 1 };
    });
    __setJobHandlerForTests('topic_combo', combo);
    const [x, y] = await pass('f1', 'f2');

    await inferenceQueue.start();
    await parked.started;

    // Both jobs share one created_at, so which runs first is not fixed: read the ids off the calls.
    const a = (seen[0][1] as { jobId: string }).jobId;
    const b = (seen[1][1] as { jobId: string }).jobId;
    expect(new Set([a, b])).toEqual(new Set([x, y]));
    expect(seen[0]).toEqual([(await jobRow(a))!.payload, { jobId: a }]);
    expect(seen[1]).toEqual([(await jobRow(b))!.payload, { jobId: b }]);
    expect((await jobRow(a))?.result).toEqual({ applied: 1 });
    // One job done, one still running: the pass is not over.
    expect(refresh).not.toHaveBeenCalled();

    parked.release();
    await untilJob(b, ['done']);
    await tick(0);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('mode switched to on-device while a pass is queued', () => {
  it('drops every pending combo job without running any, then runs the end-of-pass refresh', async () => {
    await setMode('on-device');
    const refresh = watchRefresh();
    const combo = jest.fn(async () => ({}));
    __setJobHandlerForTests('topic_combo', combo);
    await pass('f1', 'f2', 'f3');

    await inferenceQueue.start();
    await driveUntil(async () => (await jobRows('topic_combo')).length === 0, 'combo rows gone');
    await tick(0);

    expect(combo).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('a job that is not a combo job', () => {
  it('never runs the combo pre-check or the end-of-pass check', async () => {
    const precheck = jest.spyOn(comboPass, 'precheckComboJob');
    const finish = jest.spyOn(comboPass, 'finishComboPassIfDrained');
    __setJobHandlerForTests('persona_summary', async () => ({}));
    const id = await enqueueJob('persona_summary', {});

    await inferenceQueue.start();
    await untilJob(id, ['done']);
    await tick(0);

    expect(precheck).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
});

describe('onDrain', () => {
  it('does not wait for a deferred combo job', async () => {
    OFFLINE();
    const drained = jest.fn();
    inferenceQueue.onDrain(drained);
    const [a] = await pass('f1');

    await inferenceQueue.start();
    await turns(10);

    expect(drained).toHaveBeenCalledTimes(1);
    expect((await jobRow(a))?.status).toBe('pending');
  });

  it('waits while non-combo work remains', async () => {
    const parked = hold();
    __setJobHandlerForTests('persona_summary', parked.handler);
    const id = await enqueueJob('persona_summary', {});
    const drained = jest.fn();
    inferenceQueue.onDrain(drained);

    await inferenceQueue.start();
    await parked.started;
    await tick(5_000);
    expect(drained).not.toHaveBeenCalled();

    parked.release();
    await untilJob(id, ['done']);
    await driveUntil(() => drained.mock.calls.length === 1, 'drain');
  });
});

describe('wired to the real handler', () => {
  it('claims the pass in ONE batched gateway call with the combo prompt and settles every job', async () => {
    const facts = await seedFacts(['Works as a nurse', 'Lives in Porto, Portugal, EU', 'From India']);
    server.use(...mockGateway(() => '[]'));
    const batches = watchBodies('/v1/chat/completions/batch');
    const jobIds = await pass(...facts.map((f) => f.id));

    await inferenceQueue.start();
    for (const id of jobIds) await untilJob(id, ['done'], 60_000);

    const [body] = await batches.bodies();
    expect(batches.count()).toBe(1);
    expect(body.requests).toHaveLength(3);
    expect(gatewayCalls('batch')).toHaveLength(3);
    expect(gatewayCalls('batch')[0].messages[0].content).toBe(COMBO_PASS_TOPIC_SYSTEM_PROMPT);
    expect((await jobRows('topic_combo')).every((r) => r.status === 'done')).toBe(true);
  });
});
