export interface TaskDefinition<TInput = void> {
  name: string;
  displayName: string;
  handler: (input: TInput, ctx: TaskContext) => Promise<void>;
  frequency: number;
  triggers?: Array<'app-foreground' | 'network-reconnect' | 'manual'>;
  conditions?: TaskCondition[];
  timeout?: number;
  maxAttempts?: number;
  retryDelay?: (attempt: number) => number;
  exclusive?: boolean;
}

export interface TaskContext {
  jobId: string;
  attempt: number;
  signal: AbortSignal;
  reportProgress: (progress: TaskProgress) => void;
  log: (message: string) => void;
  /** Declare that this run did no real work (an early return, an abort, a
   *  guard that skipped the whole cycle). The runner still marks the job
   *  completed, but does NOT stamp `lastRun` — so the task's frequency gate
   *  isn't armed off a run that accomplished nothing and the next tick /
   *  foreground can retry immediately. */
  markNoOp: () => void;
}

/**
 * What `AppScheduler.trigger()` did with the request.
 *
 * Returned rather than logged so a CALLER can react — pull-to-refresh needs to
 * know a debounced pull will never raise the scheduler's running flag, or it
 * leaves the refresh control waiting on a run that is not coming.
 */
export type TriggerOutcome =
  /** Enqueued and run. */
  | 'ran'
  /** The task is paused (auth-failure breaker). */
  | 'paused'
  /** Exclusive and already running; the in-flight run supersedes this. */
  | 'busy'
  /** Inside the per-task trigger debounce window. */
  | 'debounced';

export interface TaskProgress {
  step?: string;
  current?: number;
  total?: number;
}

export type TaskCondition =
  | { type: 'network' }
  | { type: 'authenticated' }
  | { type: 'db-ready' }
  | { type: 'custom'; check: () => boolean };

export type JobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'cancelled'
  | 'stale';

export interface Job {
  id: string;
  taskName: string;
  status: JobStatus;
  input?: unknown;
  attempt: number;
  maxAttempts: number;
  scheduledAt: number;
  startedAt?: number;
  completedAt?: number;
  retryAt?: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface JobSnapshot extends Job {
  progress?: TaskProgress;
}
