import { AppState } from 'react-native';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import type { Job, TaskCondition, TaskDefinition } from './scheduler-types';
import { useSchedulerStore } from './scheduler-store';
import * as persistence from './scheduler-persistence';
import * as runner from './scheduler-runner';
import logger from '@/lib/logger';

class _AppScheduler {
  private tasks = new Map<string, TaskDefinition>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private appStateSubscription: { remove: () => void } | null = null;
  private networkUnsubscribe: (() => void) | null = null;

  register<T>(definition: TaskDefinition<T>): void {
    this.tasks.set(definition.name, definition as TaskDefinition);
  }

  async init(): Promise<void> {
    const times = await persistence.loadLastRunTimes(this.tasks.keys());
    useSchedulerStore.getState().loadLastRunTimes(times);

    await persistence.markStaleCrashedJobs();

    this.appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') this._onForeground();
    });

    this.networkUnsubscribe = useNetworkStore.subscribe((state, prev) => {
      if (state.isConnected && !prev.isConnected) this._onNetworkReconnect();
    });

    this.tickInterval = setInterval(() => { void this._tick(); }, 5_000);
    useSchedulerStore.getState().setStatus('running');
    void this._tick();
  }

  async trigger(taskName: string, input?: unknown): Promise<void> {
    const task = this.tasks.get(taskName);
    if (!task) throw new Error(`Unknown task: ${taskName}`);
    // Honor exclusivity for triggered runs too (e.g. the scheduler-runner retry
    // path). A run already in progress supersedes the trigger — without this an
    // exclusive task could run concurrently with its own retry.
    if (task.exclusive && useSchedulerStore.getState().isRunning(task.name)) {
      logger.info(`[AppScheduler] trigger skipped — task=${task.name} already running`);
      return;
    }
    await this._enqueueAndRun(task, input);
  }

  dispose(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.appStateSubscription?.remove();
    this.networkUnsubscribe?.();
    useSchedulerStore.getState().setStatus('paused');
  }

  /** Called once after all Zustand stores have been hydrated from the DB.
   *  Treats startup as an app-foreground event so tasks that declare the
   *  'app-foreground' trigger (e.g. feed-sync, inference-recover) run
   *  immediately on cold start without waiting for the user to background
   *  and re-foreground the app. */
  onStoresHydrated(): void {
    void this._onForeground();
  }

  private async _tick(): Promise<void> {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.exclusive && useSchedulerStore.getState().isRunning(task.name)) continue;

      const lastRun = useSchedulerStore.getState().getLastRun(task.name) ?? 0;
      const isDue = task.frequency === 0 || (now - lastRun) >= task.frequency;
      if (!isDue) continue;

      // Skip purely event-driven tasks (frequency === 0 with triggers) — those
      // are only meant to fire on the declared events, not on a timer.
      const isTimerDriven = task.frequency > 0;
      if (!isTimerDriven) continue;

      if (!this._conditionsMet(task)) continue;

      logger.info(`[AppScheduler] tick-firing task=${task.name} lastRun=${lastRun ? Math.round((now - lastRun) / 1000) + 's ago' : 'never'}`);
      await this._enqueueAndRun(task);
    }
  }

  private _onForeground(): void {
    for (const task of this.tasks.values()) {
      if (!task.triggers?.includes('app-foreground')) continue;
      if (task.exclusive && useSchedulerStore.getState().isRunning(task.name)) continue;

      const lastRun = useSchedulerStore.getState().getLastRun(task.name) ?? 0;
      const isDue = task.frequency === 0 || (Date.now() - lastRun) >= task.frequency;
      if (!isDue) continue;

      if (!this._conditionsMet(task)) continue;
      void this._enqueueAndRun(task);
    }
  }

  private _onNetworkReconnect(): void {
    for (const task of this.tasks.values()) {
      if (!task.triggers?.includes('network-reconnect')) continue;
      if (task.exclusive && useSchedulerStore.getState().isRunning(task.name)) continue;
      if (!this._conditionsMet(task)) continue;
      void this._enqueueAndRun(task);
    }
  }

  private _conditionsMet(task: TaskDefinition): boolean {
    for (const cond of task.conditions ?? []) {
      if (!this._checkCondition(cond)) {
        logger.info(`[AppScheduler] task=${task.name} blocked by condition type=${cond.type}`);
        return false;
      }
    }
    return true;
  }

  private _checkCondition(cond: TaskCondition): boolean {
    if (cond.type === 'network') return useNetworkStore.getState().isConnected;
    if (cond.type === 'authenticated') return useUserStore.getState().userPersona !== null;
    if (cond.type === 'db-ready') return useDatabaseStore.getState().ready;
    if (cond.type === 'custom') return cond.check();
    return true;
  }

  private async _enqueueAndRun(task: TaskDefinition, input?: unknown): Promise<void> {
    // Reserve the exclusive task synchronously, before the async createJob
    // below, so two near-simultaneous triggers (e.g. the startup _tick() and
    // onStoresHydrated→_onForeground()) can't both pass the isRunning() guard
    // during the await window. setJobRunning() inside runner.run is idempotent.
    if (task.exclusive) useSchedulerStore.getState().reserveTask(task.name);
    let job: Job;
    try {
      job = await persistence.createJob(task, input);
    } catch (err) {
      // createJob failed — release the reservation so the task isn't stuck
      // permanently 'running' and blocking all future runs.
      if (task.exclusive) useSchedulerStore.getState().clearTaskReservation(task.name);
      throw err;
    }
    useSchedulerStore.getState().addJob(job);
    await runner.run(job, task);
  }
}

export const AppScheduler = new _AppScheduler();
