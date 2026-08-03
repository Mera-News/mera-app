import { AppState } from 'react-native';
import { resetSlowRequests, useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { getJwtToken } from '@/lib/auth-client';
import type { Job, TaskCondition, TaskDefinition } from './scheduler-types';
import { useSchedulerStore } from './scheduler-store';
import * as persistence from './scheduler-persistence';
import * as runner from './scheduler-runner';
import { yieldToInteractionsWithTimeout } from './idle';
import logger from '@/lib/logger';

/** Ceiling on the "let the foreground transition's animations finish first"
 *  deferral. A leaked InteractionManager handle would otherwise swallow the
 *  kick entirely; 200ms is below the threshold where a user perceives the sync
 *  as not having started. */
export const FOREGROUND_YIELD_TIMEOUT_MS = 200;

/** Cooldown applied to an EXPLICIT foreground event, in place of the task's own
 *  frequency. A deliberate app-open should sync, not be swallowed by a 60s
 *  timer the previous (possibly no-op) run armed. Not zero: rapid app-switching
 *  would otherwise let a user storm the server. */
export const FOREGROUND_MIN_GAP_MS = 5_000;

/** Budget for the `getJwtToken()` credential pre-flight. Exceeding it passes
 *  the check optimistically rather than skipping the task — see
 *  `_checkAuthenticated`. */
export const AUTH_PREFLIGHT_TIMEOUT_MS = 1_500;

/** Post-hydration settle before the cold-start foreground kick. Long enough for
 *  the first paint to land, short enough that a cold start still syncs
 *  promptly. */
export const COLD_START_SETTLE_MS = 250;

/** Returned by the auth pre-flight race when `getJwtToken()` outlasts its
 *  budget. A distinct sentinel, not `null` — a timeout and an explicitly-absent
 *  token mean opposite things here. */
const AUTH_TIMED_OUT = Symbol('auth-preflight-timeout');

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
  // A foreground event that arrives while init() is still awaiting persistence
  // has no task state to act on yet, so it is recorded here and replayed once
  // init finishes. Previously such an event was simply dropped — and on a cold
  // resume that is exactly when it arrives.
  private pendingForegroundKick = false;

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
    // A kick left over from a previous init/dispose cycle is stale — this init
    // is the new baseline.
    this.pendingForegroundKick = false;

    // Register the triggers BEFORE the persistence awaits. Those awaits are a
    // real window on a cold resume (two DB round-trips), and a foreground event
    // landing inside it used to be lost outright — the app came back to the
    // user with no sync until the next 5s tick happened to find the task due.
    this.appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      // Last-run times aren't loaded yet, so _onForeground can't judge dueness
      // correctly. Remember the event and replay it below.
      if (useSchedulerStore.getState().status === 'initializing') {
        this.pendingForegroundKick = true;
        return;
      }
      this._onForeground();
    });

    this.networkUnsubscribe = useNetworkStore.subscribe((state, prev) => {
      if (state.isConnected && !prev.isConnected) this._onNetworkReconnect();
    });

    const times = await persistence.loadLastRunTimes(this.tasks.keys());
    useSchedulerStore.getState().loadLastRunTimes(times);

    await persistence.markStaleCrashedJobs();

    // The mandatory-update gate can fire during the awaits above (suspend()
    // already tore the listeners down) — don't re-arm the tick behind its back.
    if (this.suspended) return;

    this.tickInterval = setInterval(() => { void this._tick(); }, 5_000);
    useSchedulerStore.getState().setStatus('running');
    void this._tick();

    if (this.pendingForegroundKick) {
      this.pendingForegroundKick = false;
      this._onForeground();
    }
  }

  async trigger(taskName: string, input?: unknown): Promise<void> {
    const task = this.tasks.get(taskName);
    if (!task) throw new Error(`Unknown task: ${taskName}`);
    // A paused task never fires — including via the scheduler-runner retry path
    // that re-triggers by name.
    if (this.pausedTasks.has(taskName)) {
      logger.debug(`[AppScheduler] trigger skipped — task=${taskName} paused`);
      return;
    }
    // Honor exclusivity for triggered runs too (e.g. the scheduler-runner retry
    // path). A run already in progress supersedes the trigger — without this an
    // exclusive task could run concurrently with its own retry.
    if (task.exclusive && useSchedulerStore.getState().isRunning(task.name)) {
      logger.debug(`[AppScheduler] trigger skipped — task=${task.name} already running`);
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
    // initial foreground task kick past pending interactions AND a short settle
    // so the first render is smooth before feed-sync/inference-recover fire.
    // Both waits are bounded — the whole point of a cold start is that the user
    // is looking at an empty feed right now.
    void yieldToInteractionsWithTimeout(FOREGROUND_YIELD_TIMEOUT_MS).then(() => {
      setTimeout(() => {
        this._onForeground();
      }, COLD_START_SETTLE_MS);
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

      logger.debug(`[AppScheduler] tick-firing task=${task.name} lastRun=${lastRun ? Math.round((now - lastRun) / 1000) + 's ago' : 'never'}`);
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

    // Drop any slow-request bookkeeping stranded by the background freeze.
    // iOS freezes timers while backgrounded, so a request interrupted mid-flight
    // can arm the offline band from a timer that fires on resume and then never
    // settle — the `finally` that would decrement never runs, and the band stays
    // pinned for the rest of the app session. Exactly the same class of problem
    // as the stale 'running' flags swept just below, so it is swept in the same
    // place. Self-correcting: a genuinely still-slow request re-arms in 8s.
    resetSlowRequests();

    // Recover any task whose in-memory 'running' flag outlived its run. The
    // runner aborts at `task.timeout`, but that setTimeout is frozen while the
    // app is backgrounded on iOS — so a run interrupted mid-flight never
    // completes, never fails, and blocks the exclusivity guard forever. A
    // foreground is the natural place to notice: the freeze is over. The +30s
    // margin keeps us clear of a run that legitimately finished right at the
    // timeout. Done BEFORE the yield so the isRunning() checks below see it.
    for (const task of this.tasks.values()) {
      const maxAgeMs = (task.timeout ?? 120_000) + 30_000;
      if (useSchedulerStore.getState().clearStaleRunning(task.name, maxAgeMs)) {
        logger.warn(
          `[AppScheduler] cleared a stale 'running' flag on foreground — task=${task.name} (older than ${Math.round(maxAgeMs / 1000)}s)`,
        );
      }
    }

    // A6: defer the task-enqueue kick past in-flight interactions so a
    // foreground transition's animations/gestures aren't janked by the sync
    // work — but only briefly. The auth-breaker reset above stays synchronous.
    void yieldToInteractionsWithTimeout(FOREGROUND_YIELD_TIMEOUT_MS).then(async () => {
      for (const task of this.tasks.values()) {
        if (this.pausedTasks.has(task.name)) continue;
        if (!task.triggers?.includes('app-foreground')) continue;
        if (task.exclusive && useSchedulerStore.getState().isRunning(task.name)) continue;

        const lastRun = useSchedulerStore.getState().getLastRun(task.name) ?? 0;
        // An explicit foreground is a user intent, not a timer tick, so the
        // task's own frequency (60s for feed-sync) is the wrong gate — it gets
        // armed by runs the user never saw. Fall back to a short floor that
        // still stops rapid app-switching from storming the server. Tasks with
        // frequency 0 stay always-due, as everywhere else.
        const minGap = Math.min(task.frequency, FOREGROUND_MIN_GAP_MS);
        const isDue = task.frequency === 0 || (Date.now() - lastRun) >= minGap;
        if (!isDue) continue;

        if (!(await this._conditionsMet(task))) continue;
        void this._enqueueAndRun(task);
      }
    });
  }

  private _onNetworkReconnect(): void {
    // Give the auth-failure breaker a chance to recover BEFORE the loop below.
    // The loop's first check skips paused tasks, so a breaker-paused feed-sync
    // can never be revived by the reconnect trigger itself — it needs the
    // breaker to re-check the session and call resumeTask. Lazy require to avoid
    // an import cycle (same as _onForeground).
    //
    // The resume lands a round-trip later, so feed-sync is still paused when the
    // loop runs and will instead fire on the next 5s tick. That is the right
    // order: syncing BEFORE we know the session is alive just buys more 401s.
    try {
      const { onNetworkReconnect } =
        require('@/lib/auth-failure-breaker') as typeof import('@/lib/auth-failure-breaker');
      onNetworkReconnect();
    } catch {
      // best-effort
    }

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
        logger.debug(`[AppScheduler] task=${task.name} blocked by condition type=${cond.type}`);
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
   *     Time-boxed: `getJwtToken()` is a network round-trip that can hang on a
   *     flaky connection, and blocking a foreground sync behind it is worse
   *     than letting a doomed request through. A TIMEOUT therefore passes
   *     optimistically — a session that really is dead gets caught by the
   *     request's own 401 → auth breaker → `needsReauth`, which gate 2 above
   *     then enforces. An explicit null (or a throw) is a real answer and
   *     still fails.
   * A failed pre-flight is a quiet skip — no Sentry event, no attempt
   * consumed — mirroring how every other unmet condition behaves in
   * `_conditionsMet` above.
   */
  private async _checkAuthenticated(): Promise<boolean> {
    if (useUserStore.getState().userPersona === null) return false;
    if (useUserStore.getState().needsReauth) return false;
    if (!useNetworkStore.getState().isConnected) return true;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const jwt = await Promise.race([
        getJwtToken(),
        new Promise<typeof AUTH_TIMED_OUT>((resolve) => {
          timeoutId = setTimeout(() => resolve(AUTH_TIMED_OUT), AUTH_PREFLIGHT_TIMEOUT_MS);
        }),
      ]);
      if (jwt === AUTH_TIMED_OUT) {
        logger.info('[AppScheduler] auth pre-flight timed out — proceeding optimistically');
        return true;
      }
      return jwt !== null;
    } catch {
      return false;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
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
