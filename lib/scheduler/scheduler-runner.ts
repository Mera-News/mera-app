import * as Sentry from '@sentry/react-native';
import type { Job, TaskDefinition } from './scheduler-types';
import { useSchedulerStore } from './scheduler-store';
import * as persistence from './scheduler-persistence';

function defaultBackoff(attempt: number): number {
  return ([30_000, 60_000, 120_000][attempt - 1] ?? 120_000);
}

export async function run(job: Job, definition: TaskDefinition): Promise<void> {
  const abortController = new AbortController();
  const timeoutMs = definition.timeout ?? 120_000;
  const timeoutId = setTimeout(() => abortController.abort('timeout'), timeoutMs);

  await persistence.markRunning(job.id);
  useSchedulerStore.getState().setJobRunning(job.id);

  let transactionFinished = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let transaction: any;
  try {
    transaction = Sentry.startInactiveSpan({
      name: `task.${definition.name}`,
      op: 'app.task',
      attributes: { jobId: job.id, attempt: job.attempt },
    });
  } catch {
    transaction = null;
  }

  try {
    await definition.handler(job.input as never, {
      jobId: job.id,
      attempt: job.attempt,
      signal: abortController.signal,
      reportProgress: (p) => useSchedulerStore.getState().updateProgress(job.id, p),
      log: (msg) => {
        try { transaction?.setAttribute?.('last_log', msg); } catch { /* best-effort */ }
      },
    });

    const now = Date.now();
    await persistence.markCompleted(job.id, now);
    await persistence.saveLastRun(definition.name, now);
    useSchedulerStore.getState().setJobCompleted(job.id, now);
    try { transaction?.setStatus?.('ok'); } catch { /* best-effort */ }

  } catch (err) {
    const exhausted = job.attempt >= (definition.maxAttempts ?? 3);
    const retryDelay = definition.retryDelay?.(job.attempt) ?? defaultBackoff(job.attempt);
    const retryAt = exhausted ? undefined : Date.now() + retryDelay;

    await persistence.markFailed(job.id, err, exhausted, retryAt);
    useSchedulerStore.getState().setJobFailed(job.id, exhausted, retryAt);
    try { transaction?.setStatus?.('internal_error'); } catch { /* best-effort */ }

    Sentry.withScope((scope) => {
      scope.setTag('scheduler.task', definition.name);
      scope.setTag('scheduler.jobId', job.id);
      scope.setTag('scheduler.attempt', String(job.attempt));
      scope.setLevel(exhausted ? 'error' : 'warning');
      Sentry.captureException(err);
    });

    if (retryAt) {
      const { AppScheduler } = require('./AppScheduler') as typeof import('./AppScheduler');
      setTimeout(() => AppScheduler.trigger(definition.name), retryDelay);
    }

  } finally {
    clearTimeout(timeoutId);
    if (!transactionFinished) {
      try { transaction?.end?.(); } catch { /* best-effort */ }
      transactionFinished = true;
    }
  }
}
