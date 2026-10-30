// Shared kit for the inference queue seam tests. Not a test file (Jest matches *.test.ts only).
//
// Jobs are enqueued through the app's own `enqueueJob` and read back as plain rows. The service has
// no list read (only a head read), so `jobRows` queries the collection read-only.
import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import * as jobService from '@/lib/database/services/inference-job-service';
import { enqueueJob as enqueueRaw } from '@/lib/database/services/inference-job-service';
import { setProcessingMode } from '@/test/integration/chat/_helpers';
import type InferenceJob from '@/lib/database/models/InferenceJob';
import type { InferenceJobStatus, InferenceJobType } from '@/lib/database/models/InferenceJob';
import { inferenceQueue, __setJobHandlerForTests } from '@/lib/inference/InferenceQueue';
import { useNetworkStore } from '@/lib/stores/network-store';
import { server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, useStrictClock as strictClock } from '@/test/integration/chat/_helpers';


// ---- driving the queue under the strict clock ------------------------------------------------
// Every file here runs under useStrictClock (fake time moves only when the test moves it). The
// queue's loop, the limiter and the gateway all wait on timers or macrotasks, so a wait is always
// "advance a little, give the event loop real turns, look again".

const realTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Lets pending promise chains and MSW plumbing run without moving fake time. */
export async function turns(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await realTurn();
}

/** Moves fake time by `ms`, then lets the work it released settle. */
export async function tick(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  await turns();
}

/** Steps fake time (`stepMs` at a time) until `cond` holds; throws after `maxMs` of fake time. */
export async function driveUntil(
  cond: () => boolean | Promise<boolean>,
  label: string,
  maxMs = 20_000,
  stepMs = 25,
): Promise<void> {
  for (let t = 0; t <= maxMs; t += stepMs) {
    await turns(2);
    if (await cond()) return;
    await jest.advanceTimersByTimeAsync(stepMs);
  }
  throw new Error(`driveUntil: ${label} not met within ${maxMs}ms of fake time`);
}

/** Drives fake time until `promise` settles (it may be a job's whole handler). */
export async function driveDone<T>(promise: Promise<T>, maxMs = 120_000): Promise<T> {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  await driveUntil(() => done, 'promise', maxMs, 50);
  return promise;
}

// WatermelonDB hands a write to the next queued writer through a timer, so under the strict clock
// a write that has to WAIT behind another (the store setter's fire-and-forget row write, or the
// queue loop's own) never starts until fake time moves. Every kit write therefore runs inside
// driveDone, which moves it.

/** `enqueueJob`, driven. */
export const enqueueJob: typeof enqueueRaw = (type, payload, opts) => driveDone(enqueueRaw(type, payload, opts));

/** Sets the processing mode the way the settings screen does, driven. */
export const setMode = (mode: 'cloud' | 'on-device'): Promise<void> => driveDone(setProcessingMode(mode));

const fakeClockOn = (): boolean => 'clock' in (setTimeout as unknown as object);

/**
 * Stops the queue. On the fake clock, time is jumped so a loop parked in a sleep, a limiter wait or
 * a gateway call can leave. In an `afterEach` the setup has already put real timers back (its hook
 * runs first), so a loop parked on a dead fake timer cannot leave: give up after 2 s rather than
 * hang the hook. A test that can leave the loop parked (a lost wake) calls this itself, in a
 * `finally`, while the clock is still fake.
 */
export async function stopQueue(): Promise<void> {
  releaseHeld();
  if (inferenceQueue.getState() === 'stopped') return;
  let stopped = false;
  const pending = inferenceQueue.stop().then(() => (stopped = true));
  if (!fakeClockOn()) {
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    return;
  }
  for (let i = 0; i < 40 && !stopped; i++) {
    await jest.advanceTimersByTimeAsync(5_000);
    await turns(3);
  }
  await pending;
}

/** Records the raw JSON body of every request to `path` (pathname) as it starts. */
export function watchBodies(path: string) {
  const seen: Promise<any>[] = [];
  server.events.on('request:start', ({ request }) => {
    if (new URL(request.url).pathname === path) seen.push(request.clone().json());
  });
  return { count: () => seen.length, bodies: () => Promise.all(seen) };
}

export interface JobRow {
  id: string;
  type: string;
  status: InferenceJobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | undefined;
}

const toRow = (r: InferenceJob): JobRow => ({
  id: r.id,
  type: r.jobType,
  status: r.status,
  priority: r.priority,
  attempts: r.attempts,
  maxAttempts: r.maxAttempts,
  errorMessage: r.errorMessage ?? null,
  payload: r.payload,
  result: r.result,
});

/** Rows of the persisted queue, oldest first. */
export async function jobRows(type?: InferenceJobType): Promise<JobRow[]> {
  const rows = await database
    .get<InferenceJob>('inference_jobs')
    .query(...(type ? [Q.where('job_type', type)] : []), Q.sortBy('created_at', Q.asc))
    .fetch();
  return rows.map(toRow);
}

/** One row by id, or null once the queue destroyed it. */
export async function jobRow(id: string): Promise<JobRow | null> {
  const rows = await database.get<InferenceJob>('inference_jobs').query(Q.where('id', id)).fetch();
  return rows[0] ? toRow(rows[0]) : null;
}

/** Puts a row in `running` the way a killed process leaves it (the queue's own writer). */
export async function leaveRunning(id: string): Promise<void> {
  await driveDone(database.get<InferenceJob>('inference_jobs').find(id).then((r) => r.markRunning()));
}

/** Drives the clock until the row reaches one of `statuses` ('gone' = destroyed). Returns the row. */
export async function untilJob(id: string, statuses: (InferenceJobStatus | 'gone')[], maxMs = 20_000): Promise<JobRow | null> {
  const ok = (row: JobRow | null) => (row ? statuses.includes(row.status) : statuses.includes('gone'));
  await driveUntil(async () => ok(await jobRow(id)), `job ${id} ${statuses.join('|')}`, maxMs);
  return jobRow(id);
}

/** Every per-test reset the queue needs: handlers back to the real ones, gates cleared, online. */
export async function resetQueue(): Promise<void> {
  await stopQueue();
  inferenceQueue.__resetTypeGatesForTests();
  for (const t of ['topic_gen', 'persona_summary', 'story_headline', 'story_names', 'tracked_story_migrate', 'topic_combo'] as const) {
    __setJobHandlerForTests(t, undefined);
  }
  useNetworkStore.getState().setIsConnected(true);
}

/** Start of every test's fake time. */
export const T0 = Date.parse('2026-03-01T12:00:00Z');

/** beforeEach for every file: module state reset, signed in (real timers), then the strict clock. */
export async function prepare(): Promise<void> {
  resetChatModules();
  await signInFixtureAccount();
  // Cloud is every test's starting mode (the store keeps its value across tests in a file). Set on
  // real timers, before the strict clock, so the row write cannot wait on fake time.
  await setProcessingMode('cloud');
  strictClock(T0);
  await resetQueue();
}

/** afterEach for every file. */
export async function cleanup(): Promise<void> {
  await resetQueue();
  server.events.removeAllListeners();
  jest.restoreAllMocks();
}

/** Starts the queue and lets its first pass reach the idle sleep. */
export async function startIdle(): Promise<void> {
  await inferenceQueue.start();
  await turns(10);
}

/** Marks a row done the way the queue does (the model's own writer). */
export async function completeJob(id: string, result: Record<string, unknown> = {}): Promise<void> {
  await driveDone(database.get<InferenceJob>('inference_jobs').find(id).then((r) => r.markDone(result)));
}

const held: (() => void)[] = [];
/** Lets every parked handler go (a failed test must not leave the queue wedged for the next one). */
function releaseHeld(): void {
  held.splice(0).forEach((release) => release());
}

/** A handler that parks until `release()`; `started` resolves once it has been entered. */
export function hold<T extends Record<string, unknown>>(result: T = {} as T) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  held.push(() => release());
  const started = new Promise<void>((r) => (entered = r));
  const calls: unknown[][] = [];
  const handler = jest.fn(async (...args: unknown[]) => {
    calls.push(args);
    entered();
    await gate;
    return result;
  });
  return { handler, release, started, calls };
}

/** Fake-time offsets (ms from this call) at which the queue's loop asked for its next job. Pass-through spy. */
export function watchPolls(): number[] {
  const at: number[] = [];
  const t0 = Date.now();
  const real = jobService.dequeueJob;
  jest.spyOn(jobService, 'dequeueJob').mockImplementation((...args) => {
    at.push(Date.now() - t0);
    return real(...args);
  });
  return at;
}

/** Gives a pending row `n` failed attempts, through the model's own writers (as `n` earlier runs would). */
export async function spendAttempts(id: string, n: number): Promise<void> {
  const row = await database.get<InferenceJob>('inference_jobs').find(id);
  for (let i = 0; i < n; i++) {
    await driveDone(row.markRunning());
    await driveDone(row.markFailed('earlier failure'));
  }
}
