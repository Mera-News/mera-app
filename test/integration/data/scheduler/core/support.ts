// Shared by the scheduler-core seam tests: per-test reset of the AppScheduler singleton and the
// module memory around it, a synthetic task factory, and fake-clock polling. Not a test file.
//
// Only the clock and AppState are faked. The scheduler, runner, persistence layer, store, idle
// helpers and the stores the conditions read are all real.
import { AppState } from 'react-native';

import database from '@/lib/database';
import type SchedulerJobModel from '@/lib/database/models/SchedulerJob';
import { __resetAppRestartForTests } from '@/lib/app-restart';
import { invalidateJwtCache } from '@/lib/auth-client';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { __setJitterSeedForTests } from '@/lib/scheduler/jitter';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import type { TaskContext, TaskDefinition } from '@/lib/scheduler/scheduler-types';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { setAppState } from '@/test/helpers';

/** Fixed jitter seed: every task gets the same factor on every run of the suite. */
export const JITTER_SEED = 0.5;

const registered: string[] = [];
let seq = 0;

/**
 * Back to a quiet scheduler. `dispose()` drops the listeners and the tick, but the singleton keeps
 * its task map, so every task an earlier test registered is paused here: a later test's tick would
 * otherwise fire it. Call from `beforeEach`.
 */
export function resetScheduler(): void {
  AppScheduler.dispose();
  __resetAppRestartForTests();
  __setJitterSeedForTests(JITTER_SEED);
  for (const name of registered) AppScheduler.pauseTask(name);
  setAppState('active');
  const initial = <T,>(store: { setState(s: T, replace: true): void; getInitialState(): T }) =>
    store.setState(store.getInitialState(), true);
  initial(useSchedulerStore as never);
  initial(useNetworkStore as never);
  initial(useDatabaseStore as never);
  initial(useUserStore as never);
  // The store seeds `isConnected` from whether NetInfo loaded; a test wants a known online start.
  useNetworkStore.setState({ isConnected: true });
  invalidateJwtCache();
  // logger.info prints through console.info, which the integration setup leaves live.
  jest.spyOn(console, 'info').mockImplementation(() => {});
}

export interface RunRecord {
  input: unknown;
  ctx: TaskContext;
  at: number;
}

export interface Task {
  name: string;
  def: TaskDefinition<unknown>;
  runs: RunRecord[];
  /** Throw this from the next handler runs (set to null to succeed again). */
  failWith: unknown;
  /** Call `ctx.markNoOp()` before returning. */
  noOp: boolean;
  /** Hold every run open until `release()`. */
  hang: boolean;
  release(): void;
}

type TaskOptions = Partial<Omit<TaskDefinition<unknown>, 'handler' | 'name'>> & {
  failWith?: unknown;
  noOp?: boolean;
  hang?: boolean;
};

/** Registers a synthetic task under a name no earlier test used. */
export function addTask(options: TaskOptions = {}): Task {
  const { failWith = null, noOp = false, hang = false, ...definition } = options;
  const name = `synthetic-${++seq}`;
  const releases: Array<() => void> = [];
  const task: Task = {
    name,
    runs: [],
    failWith,
    noOp,
    hang,
    release: () => releases.splice(0).forEach((r) => r()),
    def: undefined as never,
  };
  task.def = {
    name,
    displayName: name,
    frequency: 0,
    ...definition,
    handler: async (input, ctx) => {
      task.runs.push({ input, ctx, at: Date.now() });
      if (task.noOp) ctx.markNoOp();
      if (task.hang) await new Promise<void>((resolve) => releases.push(resolve));
      if (task.failWith !== null) throw task.failWith;
    },
  };
  registered.push(name);
  AppScheduler.register(task.def);
  return task;
}

/** Lets already-runnable promise chains and DB callbacks run, burning `ms` of fake time. */
export async function settle(ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

/** Steps fake time until `condition()` holds; fails after `maxMs` of fake time. */
export async function advanceUntil(condition: () => boolean, what: string, maxMs = 20_000): Promise<void> {
  for (let elapsed = 0; !condition(); elapsed += 25) {
    if (elapsed >= maxMs) throw new Error(`timed out waiting for ${what}`);
    await jest.advanceTimersByTimeAsync(25);
  }
}

/** The persisted `scheduler_jobs` rows for a task, oldest first. */
export async function jobRows(taskName: string): Promise<SchedulerJobModel[]> {
  const rows = (await database.get<SchedulerJobModel>('scheduler_jobs').query().fetch()).filter(
    (r) => r.taskName === taskName,
  );
  return rows.sort((a, b) => a.scheduledAt - b.scheduledAt);
}

/** AppState as the scheduler reads it. */
export const appState = () => AppState.currentState;
