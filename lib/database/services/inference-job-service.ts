// Inference Job Service — CRUD for the persistent inference queue.

import { Q } from '@nozbe/watermelondb';
import database from '../index';
import type InferenceJobModel from '../models/InferenceJob';
import type { InferenceJobType } from '../models/InferenceJob';

const jobsCollection = database.get<InferenceJobModel>('inference_jobs');

/** Default priority: lower = higher priority. */
const DEFAULT_PRIORITY: Record<InferenceJobType, number> = {
  topic_gen: 10,
  // Lower priority than topic_gen (summary depends on topics existing, and it's
  // a background nicety — never block topic generation on it).
  persona_summary: 20,
  // Naming a followed story — a background nicety like persona_summary. Runs at
  // the same low priority so it never contends with topic generation.
  story_headline: 20,
  // Migrating a legacy follow to the topic model — a background nicety, same low
  // priority as story_headline so it never contends with topic generation.
  tracked_story_migrate: 20,
};

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Enqueue a new inference job. Returns the created record's ID.
 */
export async function enqueueJob(
  jobType: InferenceJobType,
  payload: Record<string, unknown>,
  opts?: { priority?: number; maxAttempts?: number },
): Promise<string> {
  let createdId = '';
  await database.write(async () => {
    const record = await jobsCollection.create((job) => {
      job.jobType = jobType;
      job.status = 'pending';
      job.priority = opts?.priority ?? DEFAULT_PRIORITY[jobType];
      job.payload = payload;
      job.attempts = 0;
      job.maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    });
    createdId = record.id;
  });
  return createdId;
}

/**
 * Dequeue the next pending job (lowest priority number = highest priority, then oldest).
 * Returns null if no pending jobs.
 */
export async function dequeueJob(): Promise<InferenceJobModel | null> {
  const pending = await jobsCollection
    .query(
      Q.where('status', 'pending'),
      Q.sortBy('priority', Q.asc),
      Q.sortBy('created_at', Q.asc),
      Q.take(1),
    )
    .fetch();

  return pending.length > 0 ? pending[0] : null;
}

/**
 * Recover crashed jobs — reset any 'running' jobs back to 'pending'.
 * Called on app startup to recover from crashes.
 */
export async function recoverCrashedJobs(): Promise<number> {
  const running = await jobsCollection
    .query(Q.where('status', 'running'))
    .fetch();

  if (running.length === 0) return 0;

  await database.write(async () => {
    const batch = running.map((job) =>
      job.prepareUpdate((j) => {
        // If max attempts reached, mark as failed instead of retrying
        if (j.attempts >= j.maxAttempts) {
          j.status = 'failed';
          j.errorMessage = 'Crashed during execution (max attempts reached)';
        } else {
          j.status = 'pending';
        }
      }),
    );
    await database.batch(batch);
  });

  return running.length;
}

/**
 * Get count of pending + running jobs, for progress tracking.
 */
export async function getQueueStats(): Promise<{
  pending: number;
  running: number;
  failed: number;
}> {
  const [pending, running, failed] = await Promise.all([
    jobsCollection.query(Q.where('status', 'pending')).fetchCount(),
    jobsCollection.query(Q.where('status', 'running')).fetchCount(),
    jobsCollection.query(Q.where('status', 'failed')).fetchCount(),
  ]);
  return { pending, running, failed };
}

/**
 * Fetch failed jobs for diagnostic logging.
 */
export async function getFailedJobs(): Promise<
  Array<{
    id: string;
    jobType: string;
    errorMessage: string | null;
    attempts: number;
    payload: Record<string, unknown>;
  }>
> {
  const records = await jobsCollection.query(Q.where('status', 'failed')).fetch();
  return records.map((r) => ({
    id: r.id,
    jobType: r.jobType,
    errorMessage: r.errorMessage ?? null,
    attempts: r.attempts,
    payload: r.payload,
  }));
}

/**
 * Prune completed and failed jobs older than the given date.
 */
export async function pruneCompletedJobs(olderThan: Date): Promise<number> {
  const old = await jobsCollection
    .query(
      Q.where('status', Q.oneOf(['done', 'failed'])),
      Q.where('updated_at', Q.lt(olderThan.getTime())),
    )
    .fetch();

  if (old.length === 0) return 0;

  await database.write(async () => {
    const batch = old.map((j) => j.prepareDestroyPermanently());
    await database.batch(batch);
  });

  return old.length;
}

/**
 * Delete all failed jobs immediately.
 */
export async function purgeFailedJobs(): Promise<number> {
  const failed = await jobsCollection
    .query(Q.where('status', 'failed'))
    .fetch();

  if (failed.length === 0) return 0;

  await database.write(async () => {
    const batch = failed.map((j) => j.prepareDestroyPermanently());
    await database.batch(batch);
  });

  return failed.length;
}

/**
 * Check if a duplicate job already exists (pending or running) with the same type and a matching payload key.
 * Used to avoid enqueueing duplicate topic_gen jobs for the same fact.
 */
export async function hasPendingJob(
  jobType: InferenceJobType,
  matchKey: string,
  matchValue: string,
): Promise<boolean> {
  const candidates = await jobsCollection
    .query(
      Q.where('job_type', jobType),
      Q.where('status', Q.oneOf(['pending', 'running'])),
    )
    .fetch();

  const exists = candidates.some((job) => {
    const payload = job.payload as Record<string, unknown>;
    return payload[matchKey] === matchValue;
  });

  return exists;
}

/**
 * Return the set of fact IDs that still have pending or running topic_gen jobs.
 * Used by the startup orphan-fact sweep to avoid prematurely marking facts
 * as failed while their generation is still queued/running.
 */
export async function getActiveTopicGenFactIds(): Promise<Set<string>> {
  const active = await jobsCollection
    .query(
      Q.where('job_type', 'topic_gen'),
      Q.where('status', Q.oneOf(['pending', 'running'])),
    )
    .fetch();

  const factIds = new Set<string>();
  for (const job of active) {
    const factId = (job.payload as Record<string, unknown>)?.factId;
    if (typeof factId === 'string') factIds.add(factId);
  }
  return factIds;
}
