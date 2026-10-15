// Shared by the FeedSyncMachine seam tests (data-U6b). Not a test file. Builds on the steps
// support (imported, never copied): this adds the machine's own reset, run tracking, held server
// responses and recorders for the machine's published surface.
import { clearMachineSnapshot, loadMachineSnapshot } from '@/lib/scheduler/feed-sync/feed-sync-persistence';
import * as persistence from '@/lib/scheduler/feed-sync/feed-sync-persistence';
import * as steps from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { BG_MAX_BATCHES, shapeBackgroundDiff } from '@/lib/background/background-feed-sync';
import { submitScoringForBackground } from '@/lib/services/scoring-pipeline';
import { feedSyncMachine, INFLIGHT_STALE_MS } from '@/lib/scheduler/feed-sync/FeedSyncMachine';
import type { BackgroundSyncHooks, FeedSyncState } from '@/lib/scheduler/feed-sync/feed-sync-types';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { getPipeline } from '@/lib/database/services/scoring-pipeline-store';
import { countAllTopics } from '@/lib/database/services/topic-service';
import { useNetworkStore } from '@/lib/stores/network-store';
import { advanceUntilDone, defaultResponder, gatewayCalls, mockGateway, server } from '@/test/helpers';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { ids, makeCtx, seedInterest, tick, serveHydrate, servePersona, spyOnExport, type HydrateServe, type TestCtx } from '../steps/support';

export { feedSyncMachine, loadMachineSnapshot };

const runs: { promise: Promise<unknown>; t: TestCtx }[] = [];
const gates: (() => void)[] = [];

/** A promise the test settles by hand; every gate is released by `settleMachine`. */
export function gate(): { held: Promise<void>; release(): void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  gates.push(release);
  return { held, release };
}

/**
 * Steps the fake clock, with a real event-loop turn per step, until `cond` holds. `advanceUntilDone`
 * on an already-settled promise moves the clock ONE step, so it is no wait at all. The error says
 * where the machine was, since a hung wait is otherwise a bare timeout.
 */
export async function waitFor(cond: () => boolean | Promise<boolean>, what: string, maxMs = 20_000): Promise<void> {
  for (let elapsed = 0; elapsed < maxMs; elapsed += 50) {
    if (await cond()) return;
    await jest.advanceTimersByTimeAsync(50);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(
    `timed out waiting for ${what} (machine ${feedSyncMachine.state}, keep-awake ${keepAwake.taken()} taken / ${keepAwake.released()} released)`,
  );
}

/**
 * Holds calls into the machine's fetch step (race ordering, R23b): a held call waits on its promise,
 * then calls the real step through, or throws a network failure with `fail`. Holding at the step
 * rather than on the wire matters: Apollo dedups identical in-flight queries and aborts a request at
 * 30s, so a held request would be joined by, or retried under, a second run. One spy per test:
 * `hold(n, ...)` marks the n-th call (1-based, or every call without `n`).
 */
export function fetchStep() {
  const original = steps.stepFetchTopicIds;
  const holds = new Map<number | 'all', { held: Promise<void>; fail?: boolean; after?: boolean }>();
  let calls = 0;
  spyOnExport(steps, 'stepFetchTopicIds').mockImplementation(async (personaId, ctx) => {
    calls += 1;
    const hold = holds.get(calls) ?? holds.get('all');
    if (hold && !hold.after) {
      await hold.held;
      if (hold.fail) throw new Error('network request failed');
    }
    const result = await original(personaId, ctx);
    if (hold?.after) await hold.held; // the step has finished its work but has not yet returned it
    return result;
  });
  const api = {
    /** `after` holds the call once the real step is done, so the run is "inside the step, not yet resolved". */
    hold(held: Promise<void>, opts: { nth?: number; fail?: boolean; after?: boolean } = {}) {
      holds.set(opts.nth ?? 'all', { held, fail: opts.fail, after: opts.after });
      return api;
    },
    calls: () => calls,
    reached: (n: number) => waitFor(() => calls >= n, `fetch step call ${n}`),
  };
  return api;
}

/**
 * The only way out of a run parked with no one to wake it: abort it (the scheduler does at 3 min),
 * let the clock pass the stale window, and start again, which abandons the stuck run and releases
 * its waiters. Leaves the machine idle for the next test.
 */
export async function takeOverStuckRun(stuck: Promise<unknown>, stuckCtx: TestCtx): Promise<void> {
  stuckCtx.abort();
  jest.setSystemTime(Date.now() + INFLIGHT_STALE_MS + 60_000);
  await advanceUntilDone(startMachine());
  await advanceUntilDone(stuck.catch(() => undefined));
}

/** `feedSyncMachine.start`, remembered so `settleMachine` can abort and drain it. */
export function startMachine(
  t: TestCtx = makeCtx(),
  opts: { personaId?: string; background?: BackgroundSyncHooks } = {},
): Promise<void> {
  const promise = feedSyncMachine.start(opts.personaId ?? '', t.ctx, opts.background ? { background: opts.background } : undefined);
  // a run that rejects is asserted by its test; the tracker only needs it to settle
  runs.push({ promise: promise.catch(() => undefined), t });
  return promise;
}

/**
 * Back to a quiet machine through its own surface: release every held response, abort every ctx,
 * drive every run to its end (still under the test's fake clock, so a timer a run waits on fires),
 * and drop the snapshot row. Fails loudly when a run will not end: a leaked run would be joined by
 * the next test's start(). Call from an `afterEach` INSIDE the file's outer describe, so it runs
 * before the setup file's hooks restore real timers.
 */
export async function settleMachine(): Promise<void> {
  gates.splice(0).forEach((release) => release());
  const pending = runs.splice(0);
  pending.forEach((r) => r.t.abort());
  let ended = 0;
  pending.forEach((r) => void r.promise.then(() => (ended += 1)));
  try {
    await waitFor(() => ended === pending.length, 'every machine run to end', 120_000);
  } catch (err) {
    jest.useRealTimers();
    throw new Error(`${pending.length - ended} machine run(s) still pending after the test: ${String(err)}`);
  }
  await clearMachineSnapshot();
}

export interface Recorder {
  /** internal states, in the order the machine persisted them (`updateMachineState`) */
  internal: FeedSyncState[];
  /** published header states, in order (null = cleared) */
  published: (FeedSyncState | null)[];
  stop(): void;
}

/** Observes the persisted transitions (a call-through spy) and the published status (a store subscription). */
export function recordMachine(): Recorder {
  const internal: FeedSyncState[] = [];
  const published: (FeedSyncState | null)[] = [];
  const original = persistence.updateMachineState;
  spyOnExport(persistence, 'updateMachineState').mockImplementation(async (state: FeedSyncState) => {
    internal.push(state);
    return original(state);
  });
  const stop = useForYouStore.subscribe((next, prev) => {
    if (next.syncStatusMessage !== prev.syncStatusMessage) published.push(next.syncStatusMessage?.state ?? null);
  });
  return { internal, published, stop };
}

/** Each call the machine made into the scoring step: whether the wake lock was held at that moment. */
export const scoreEntries: { keepAwakeHeld: boolean; storeRows: number; pipelineRun: boolean }[] = [];

/**
 * Watches the machine's calls into the scoring step and calls the real step through (observation,
 * not a replacement): whether the wake lock was held, and how many rows the feed store showed, and
 * whether a scoring-pipeline run already existed, at that moment. Call from `beforeEach`.
 */
export function watchScoring(): void {
  scoreEntries.length = 0;
  const original = steps.stepScore;
  spyOnExport(steps, 'stepScore').mockImplementation(async (ctx) => {
    scoreEntries.push({
      keepAwakeHeld: keepAwake.taken() > keepAwake.released(),
      storeRows: useForYouStore.getState().suggestions.length,
      pipelineRun: (await getPipeline()) !== null,
    });
    return original(ctx);
  });
}

/** One interest (seeded once), and the server listing `articleIds` for it; `hydrate` shapes the hydrate answers. */
export async function serveNew(articleIds: string[], hydrate: HydrateServe = {}) {
  if ((await countAllTopics()) === 0) await seedInterest('I follow racing', ['formula 1']);
  const served = serveHydrate(hydrate);
  server.use(servePersona({ topics: { 'formula 1': articleIds } }), ...served.handlers);
  return served;
}

/** Keep-awake as the machine drove it. Both are the `expo-keep-awake` mock of the test file. */
export const keepAwake = {
  taken: () => (activateKeepAwakeAsync as jest.Mock).mock.calls.length,
  released: () => (deactivateKeepAwake as jest.Mock).mock.calls.length,
  tags: () => ({
    taken: (activateKeepAwakeAsync as jest.Mock).mock.calls.map((c) => c[0]),
    released: (deactivateKeepAwake as jest.Mock).mock.calls.map((c) => c[0]),
  }),
};

/** Counts the network-store subscriptions that are still live, calling through to the real store. */
export function watchNetworkSubscriptions() {
  let live = 0;
  const original = useNetworkStore.subscribe;
  const spy = spyOnExport(useNetworkStore as { subscribe: typeof original }, 'subscribe').mockImplementation(((listener: never) => {
    live += 1;
    const unsubscribe = original(listener);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        live -= 1;
      }
      unsubscribe();
    };
  }) as never);
  return { live: () => live, calls: () => spy.mock.calls.length };
}

/**
 * A scoring-pipeline run that is genuinely in flight, built the way the app builds one: a first
 * sync hydrates `count` articles with the foreground enqueue on, the pipeline submits them to the
 * gateway mock, and the mock leaves every job unfinished (`pendingPolls`). Returns the run id.
 * Leaves the mock pending; a later `server.use(...mockGateway(defaultResponder))` lets jobs finish.
 */
export async function buildRunningPipeline(count = 6): Promise<string> {
  server.use(...mockGateway(defaultResponder, { pendingPolls: 999 }));
  await serveNew(ids(count, 'p'));
  await advanceUntilDone(startMachine());
  for (let i = 0; i < 20 && gatewayCalls('job').length === 0; i++) await tick();
  const snap = await getPipeline();
  if (!snap || !snap.run.batches.some((b) => !['done', 'failed'].includes(b.phase))) {
    throw new Error('the pipeline run did not stay in flight');
  }
  scoreEntries.length = 0; // what the first sync scored is not what the test under way is about
  return snap.run.runId;
}

export const currentRunId = async (): Promise<string | null> => (await getPipeline())?.run.runId ?? null;

/** A 24-hex id whose first four bytes are `ms` as seconds: what the background fetch filters on. */
export const oid = (n: number, ms = Date.now()): string =>
  Math.floor(ms / 1000).toString(16).padStart(8, '0') + n.toString(16).padStart(16, '0');

/**
 * The hooks the OS task passes (`lib/background/background-feed-sync.ts`), assembled from the real
 * pieces it uses: the freshness shaping and the bounded scoring submit. Only the store refresh is recorded in place of the app-state-gated one.
 */
export function backgroundHooks(opts: { submit?: boolean; budget?: number; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const budget = opts.budget ?? 50;
  const calls = { refresh: 0, submitted: [] as string[][], postsAtSubmit: [] as number[] };
  const hooks: BackgroundSyncHooks = {
    shapeDiff: (diff) => shapeBackgroundDiff(diff, now, budget),
    submit:
      opts.submit === false
        ? null
        : async (articleIds) => {
            calls.submitted.push(articleIds);
            calls.postsAtSubmit.push(gatewayCalls('job').length);
            await submitScoringForBackground({ deadlineAt: now + 60_000, articleIds, maxBatches: BG_MAX_BATCHES });
          },
    refreshStore: async () => {
      calls.refresh += 1;
    },
  };
  return { hooks, calls, now };
}
