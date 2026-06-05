import { AppState } from 'react-native';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';
import { useDatabaseStore } from '@/lib/stores/database-store';
import type { Job, TaskCondition, TaskDefinition } from './scheduler-types';
import { useSchedulerStore } from './scheduler-store';
import * as persistence from './scheduler-persistence';
import * as runner from './scheduler-runner';

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
    await this._enqueueAndRun(task, input);
  }

  dispose(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.appStateSubscription?.remove();
    this.networkUnsubscribe?.();
    useSchedulerStore.getState().setStatus('paused');
  }

  private async _tick(): Promise<void> {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (task.exclusive && useSchedulerStore.getState().isRunning(task.name)) continue;

      const lastRun = useSchedulerStore.getState().getLastRun(task.name) ?? 0;
      const isDue = task.frequency === 0 || (now - lastRun) >= task.frequency;
      if (!isDue) continue;

      const hasTrigger = !task.triggers || task.triggers.length === 0;
      if (!hasTrigger) continue;

      if (!this._conditionsMet(task)) continue;

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
      if (!this._checkCondition(cond)) return false;
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
    const job: Job = await persistence.createJob(task, input);
    useSchedulerStore.getState().addJob(job);
    await runner.run(job, task);
  }
}

export const AppScheduler = new _AppScheduler();
