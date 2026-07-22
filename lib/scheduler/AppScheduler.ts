import { AppState } from 'react-native';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { getJwtToken } from '@/lib/auth-client';
import type { Job, TaskCondition, TaskDefinition } from './scheduler-types';
import { useSchedulerStore } from './scheduler-store';
import * as persistence from './scheduler-persistence';
import * as runner from './scheduler-runner';
import { yieldToInteractions } from './idle';
import logger from '@/lib/logger';

class _AppScheduler {
  private tasks = new Map<string, TaskDefinition>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private appStateSubscription: { remove: () => void } | null = null;
  private networkUnsubscribe: (() => void) | null = null;
  private suspended = false;
  // Tasks temporarily paused (skipped by every trigger path) without tearing
  // down the scheduler. Used by the auth-failure breaker to stop the feed-sync
  // poll loop once a session looks dead, and resumed once auth recovers.
  private pausedTasks = new Set<string>();

  register<T>(definition: TaskDefinition<T>): void {
    this.tasks.set(definition.name, definition as TaskDefinition);
  }

  /** Temporarily stop a task from firing (tick, foreground, network, trigger)
   *  without disposing the scheduler. Idempotent. */
  pauseTask(name: string): void {
    if (this.pausedTasks.has(name)) return;
    this.pausedTasks.add(name);
    logger.info(`[AppScheduler] task paused — ${name}`);
  }

  /** Re-enable a paused task. Idempotent. */
  resumeTask(name: string): void {
    if (this.pausedTasks.delete(name)) {
      logger.info(`[AppScheduler] task resumed — ${name}`);
    }
  }

  isPaused(name: string): boolean {
    return this.pausedTasks.has(name);
  }

  async init(): Promise<void> {
    // The mandatory-update gate may suspend us mid-boot (the version check and
    // store hydration race). Don't re-arm the tick/listeners if that happened.
    if (this.suspended) return;
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
    // A paused task never fires — including via the scheduler-runner retry path
    // that re-triggers by name.
    if (this.pausedTasks.has(taskName)) {
      logger.info(`[AppScheduler] trigger skipped — task=${taskName} paused`);
      return;
    }
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

  /**
   * Permanently halt all background work for this app session. Used by the
   * mandatory-update gate: once the installed version is below the supported
   * floor, no task may run again — not via the tick, a foreground event, a
   * network reconnect, or an in-flight hydration callback. `dispose()` tears
   * down the triggers; the `suspended` flag is the chokepoint that stops any
   * already-queued enqueue from slipping through.
   */
  suspend(): void {
    this.suspended = true;
    this.dispose();
  }

  /** Called once after all Zustand stores have been hydrated from the DB.
   *  Treats startup as an app-foreground event so tasks that declare the
   *  'app-foreground' trigger (e.g. feed-sync, inference-recover) run
   *  immediately on cold start without waiting for the user to background
   *  and re-foreground the app. */
  onStoresHydrated(): void {
    // A6: let hydration + first paint win the JS thread on cold start. Defer the
    // initial foreground task kick past pending interactions AND a ~1s settle so
    // the first render is smooth before feed-sync/inference-recover fire.
    void yieldToInteractions().then(() => {
      setTimeout(() => {
        this._onForeground();
      }, 1_000);
    });
  }

  private async _tick(): Promise<void> {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (this.pausedTasks.has(task.name)) continue;
      if (task.exclusive && useSchedulerStore.getState().isRunning(task.name)) continue;

      const lastRun = useSchedulerStore.getState().getLastRun(task.name) ?? 0;
      const isDue = task.frequency === 0 || (now - lastRun) >= task.frequency;
      if (!isDue) continue;

      // Skip purely event-driven tasks (frequency === 0 with triggers) — those
      // are only meant to fire on the declared events, not on a timer.
      const isTimerDriven = task.frequency > 0;
      if (!isTimerDriven) continue;

      if (!(await this._conditionsMet(task))) continue;

      logger.info(`[AppScheduler] tick-firing task=${task.name} lastRun=${lastRun ? Math.round((now - lastRun) / 1000) + 's ago' : 'never'}`);
      await this._enqueueAndRun(task);
    }
  }

  private _onForeground(): void {
    // Give the auth-failure breaker a chance to reset on foreground: a user who
    // re-authenticated (or whose keychain is now unlocked) shouldn't stay stuck
    // behind a paused feed-sync. If the session is still dead, the next run's
    // 401s re-trip the breaker. Lazy require to avoid an import cycle.
    try {
      const { onAppForeground } =
        require('@/lib/auth-failure-breaker') as typeof import('@/lib/auth-failure-breaker');
      onAppForeground();
    } catch {
      // best-effort
    }

    // A6: defer the task-enqueue kick past in-flight interactions so a
    // foreground transition's animations/gestures aren't janked by the sync
    // work. The auth-breaker reset above stays synchronous.
    void yieldToInteractions().then(async () => {
      for (const task of this.tasks.values()) {
        if (this.pausedTasks.has(task.name)) continue;
        if (!task.triggers?.includes('app-foreground')) continue;
        if (task.exclusive && useSchedulerStore.getState().isRunning(task.name)) continue;

        const lastRun = useSchedulerStore.getState().getLastRun(task.name) ?? 0;
        const isDue = task.frequency === 0 || (Date.now() - lastRun) >= task.frequency;
        if (!isDue) continue;

        if (!(await this._conditionsMet(task))) continue;
        void this._enqueueAndRun(task);
      }
    });
  }

  private _onNetworkReconnect(): void {
    void (async () => {
      for (const task of this.tasks.values()) {
        if (this.pausedTasks.has(task.name)) continue;
        if (!task.triggers?.includes('network-reconnect')) continue;
        if (task.exclusive && useSchedulerStore.getState().isRunning(task.name)) continue;
        if (!(await this._conditionsMet(task))) continue;
        void this._enqueueAndRun(task);
      }
    })();
  }

  private async _conditionsMet(task: TaskDefinition): Promise<boolean> {
    for (const cond of task.conditions ?? []) {
      if (!(await this._checkCondition(cond))) {
        logger.info(`[AppScheduler] task=${task.name} blocked by condition type=${cond.type}`);
        return false;
      }
    }
    return true;
  }

  private async _checkCondition(cond: TaskCondition): Promise<boolean> {
    if (cond.type === 'network') return useNetworkStore.getState().isConnected;
    if (cond.type === 'authenticated') return this._checkAuthenticated();
    if (cond.type === 'db-ready') return useDatabaseStore.getState().ready;
    if (cond.type === 'custom') return cond.check();
    return true;
  }

  /**
   * Real auth pre-flight, not just "did we ever log in". Order matters:
   *  1. Fast local check — no persona means there is nothing to authenticate
   *     with, online or off.
   *  2. needsReauth — set by the auth-failure breaker once a server-truth
   *     re-check confirms the session is dead (lib/auth-failure-breaker.ts).
   *     Unconditional: a confirmed-dead session shouldn't fire tasks even
   *     while offline, since it'll still be dead once connectivity returns.
   *  3. Credential freshness — only checked when the network is up. A task
   *     that merely needs local auth identity (e.g. one that queues work for
   *     later) must still be allowed to run offline; `getJwtToken()` would
   *     just fail on the network call anyway. Tasks that truly need
   *     connectivity are also gated by a `{ type: 'network' }` condition.
   * A failed pre-flight is a quiet skip — no Sentry event, no attempt
   * consumed — mirroring how every other unmet condition behaves in
   * `_conditionsMet` above.
   */
  private async _checkAuthenticated(): Promise<boolean> {
    if (useUserStore.getState().userPersona === null) return false;
    if (useUserStore.getState().needsReauth) return false;
    if (!useNetworkStore.getState().isConnected) return true;

    try {
      const jwt = await getJwtToken();
      return jwt !== null;
    } catch {
      return false;
    }
  }

  private async _enqueueAndRun(task: TaskDefinition, input?: unknown): Promise<void> {
    // Hard stop when the app is gated behind a mandatory update — no background
    // task should execute, regardless of which trigger path (tick, foreground,
    // network, scheduled retry) reached here.
    if (this.suspended) return;
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
