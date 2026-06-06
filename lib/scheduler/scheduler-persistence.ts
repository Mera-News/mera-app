import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import type SchedulerJobModel from '@/lib/database/models/SchedulerJob';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import type { Job, JobStatus, TaskDefinition } from './scheduler-types';

const LAST_RUN_PREFIX = 'scheduler_last_run_';
const STALE_JOB_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

function jobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function modelToJob(m: SchedulerJobModel): Job {
  return {
    id: m.id,
    taskName: m.taskName,
    status: m.status as JobStatus,
    input: m.inputJson ? JSON.parse(m.inputJson) : undefined,
    attempt: m.attempt,
    maxAttempts: m.maxAttempts,
    scheduledAt: m.scheduledAt,
    startedAt: m.startedAt ?? undefined,
    completedAt: m.completedAt ?? undefined,
    retryAt: m.retryAt ?? undefined,
    errorCode: m.errorCode ?? undefined,
    errorMessage: m.errorMessage ?? undefined,
  };
}

export async function createJob(task: TaskDefinition, input?: unknown): Promise<Job> {
  const id = jobId();
  const now = Date.now();
  await database.write(async () => {
    await database.get<SchedulerJobModel>('scheduler_jobs').create((record) => {
      (record as any)._raw.id = id;
      record.taskName = task.name;
      record.status = 'pending';
      record.inputJson = input !== undefined ? JSON.stringify(input) : null;
      record.errorCode = null;
      record.errorMessage = null;
      record.attempt = 1;
      record.maxAttempts = task.maxAttempts ?? 3;
      record.scheduledAt = now;
      record.startedAt = null;
      record.completedAt = null;
      record.retryAt = null;
    });
  });
  return {
    id,
    taskName: task.name,
    status: 'pending',
    input,
    attempt: 1,
    maxAttempts: task.maxAttempts ?? 3,
    scheduledAt: now,
  };
}

export async function markRunning(jobId: string): Promise<void> {
  const rows = await database.get<SchedulerJobModel>('scheduler_jobs')
    .query(Q.where('id', jobId))
    .fetch();
  if (rows.length === 0) return;
  await database.write(async () => {
    await rows[0].update((r) => {
      r.status = 'running';
      r.startedAt = Date.now();
    });
  });
}

export async function markCompleted(jobId: string, completedAt: number): Promise<void> {
  const rows = await database.get<SchedulerJobModel>('scheduler_jobs')
    .query(Q.where('id', jobId))
    .fetch();
  if (rows.length === 0) return;
  await database.write(async () => {
    await rows[0].update((r) => {
      r.status = 'completed';
      r.completedAt = completedAt;
    });
  });
}

export async function markFailed(
  jobId: string,
  err: unknown,
  exhausted: boolean,
  retryAt?: number,
): Promise<void> {
  const rows = await database.get<SchedulerJobModel>('scheduler_jobs')
    .query(Q.where('id', jobId))
    .fetch();
  if (rows.length === 0) return;
  const msg = err instanceof Error ? err.message : String(err);
  await database.write(async () => {
    await rows[0].update((r) => {
      r.status = exhausted ? 'failed' : 'retrying';
      r.errorMessage = msg;
      r.retryAt = retryAt ?? null;
    });
  });
}

export async function saveLastRun(taskName: string, ts: number): Promise<void> {
  await setSetting(`${LAST_RUN_PREFIX}${taskName}`, String(ts));
}

export async function loadLastRunTimes(
  taskNames: IterableIterator<string>,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const name of taskNames) {
    const raw = await getSetting(`${LAST_RUN_PREFIX}${name}`);
    if (raw) result[name] = Number(raw);
  }
  return result;
}

export async function markStaleCrashedJobs(): Promise<void> {
  const cutoff = Date.now() - STALE_JOB_AGE_MS;
  const rows = await database.get<SchedulerJobModel>('scheduler_jobs')
    .query(Q.where('status', 'running'))
    .fetch();
  const stale = rows.filter((r) => (r.startedAt ?? 0) < cutoff);
  if (stale.length === 0) return;
  await database.write(async () => {
    await Promise.all(stale.map((r) => r.update((rec) => { rec.status = 'stale'; })));
  });
}

export async function pruneOldJobs(olderThanMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const cutoff = Date.now() - olderThanMs;
  // Retrying jobs whose retry_at is more than STALE_JOB_AGE_MS in the past
  // are effectively dead — their setTimeout was lost when the app was killed.
  // pruneOldJobs is the only cleanup path for these since markStaleCrashedJobs
  // only targets 'running' status.
  const deadRetryCutoff = Date.now() - STALE_JOB_AGE_MS;
  const rows = await database.get<SchedulerJobModel>('scheduler_jobs')
    .query(
      Q.or(
        Q.and(
          Q.where('status', Q.oneOf(['completed', 'failed', 'stale', 'cancelled'])),
          Q.where('scheduled_at', Q.lt(cutoff)),
        ),
        Q.and(
          Q.where('status', 'retrying'),
          Q.where('retry_at', Q.lt(deadRetryCutoff)),
        ),
      ),
    )
    .fetch();
  if (rows.length === 0) return;
  await database.write(async () => {
    await Promise.all(rows.map((r) => r.destroyPermanently()));
  });
}

export { modelToJob };
